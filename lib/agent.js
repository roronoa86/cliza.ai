'use strict';
const axios = require('axios');
// Shared utilities — single source of truth di utils.js
const { stripThinkTags, parseList } = require('./utils');

const {
  getCryptoPrice, getTrendingCrypto, getFearGreedIndex, getDefiLlamaTVL,
  getGasPrice, getDexScreenerInfo, getBtcMempoolFees, getBinanceTicker,
  sanitizeHistoryForGemini, SYSTEM_PROMPT, SYSTEM_PROMPT_DM, TEXT_MODELS,
  COINGECKO_API_KEY, CRYPTORANK_API_KEY, ALCHEMY_BASE_RPC,
  setProviderOrder, commitGitHubFile, getGitHubFileContent, getDefaultBranch, validateSyntax,
  // Keys/models — single source of truth di ai.js, tidak duplikasi di sini
  GEMINI_KEYS, GROQ_KEYS, OPENAI_KEYS, GROQ_MODELS, OPENAI_MODELS,
  CONDUIT_KEYS, CONDUIT_MODELS, IAMHC_KEYS, IAMHC_MODELS,
} = require('./ai');
const { runScamAnalysis } = require('./tokenScamAnalysis');
const { fetchZerionPortfolio } = require('./zerion');
const { detectGmgnQuery, handleGmgnCommand } = require('./gmgn');
const e2b = require('./e2b');

// ATOMESUS: agent-specific provider (tidak ada di ai.js), tetap di sini
const ATOMESUS_KEYS   = parseList(process.env.ATOMESUS_API_KEY || process.env.ATOMESUS_API_KEYS);
const ATOMESUS_MODELS = ['cipher'];

    // ─── Runtime provider order (via Discord !setkey / !provider) ──────────────
    let _runtimeOrder = null; // null = pakai urutan default

    function _getKeys(p) {
      if (p === 'groq')     return GROQ_KEYS;
      if (p === 'gemini')   return GEMINI_KEYS;
      if (p === 'openai')   return OPENAI_KEYS;
      if (p === 'atomesus') return ATOMESUS_KEYS;
      if (p === 'conduit')  return CONDUIT_KEYS;
      if (p === 'iamhc')    return IAMHC_KEYS;
      return [];
    }
    function setAgentOrder(order) {
      _runtimeOrder = Array.isArray(order) && order.length ? [...order] : null;
      // [FIX #9] Sync ke ai.js — satu source of truth untuk provider order
      if (typeof setProviderOrder === 'function') {
        setProviderOrder(_runtimeOrder);
      } else {
        console.warn('[agent] setProviderOrder tidak tersedia — ai.js mungkin belum terinisialisasi');
      }
      console.log('[agent] provider order →', (_runtimeOrder || ['conduit','groq','gemini','openai','iamhc']).join(' → '));
    }
    function getAgentStatus() {
      const order = _runtimeOrder || ['conduit', 'groq', 'gemini', 'openai', 'iamhc'];
      return {
        order,
        keyCount: Object.fromEntries(
          ['groq','gemini','openai','atomesus','conduit','iamhc'].map(p => [p, _getKeys(p).length])
        ),
      };
    }

    const MAX_ITER    = 12; // task coding kompleks butuh lebih banyak iterasi
    const TOOL_TIMEOUT = 15000; // ditingkatkan dari 12s ke 15s untuk on-chain queries

    // ─── Token limits per provider (karakter ÷ 4 ≈ token) ──────────────────────
    // Groq free tier ≈ 6 000 token; sisakan ruang untuk output & definisi tool.
    const AGENT_TOKEN_LIMITS = { groq: 4000, gemini: 24000, openai: 12000, atomesus: 2500, conduit: 12000, iamhc: 12000 }; // atomesus: pendek agar tidak kena 60s upstream timeout
    function _estimateTok(text) { return Math.ceil((text || '').length / 4); }
    // [FIX] Kondensasi ekstraktif — sama seperti di ai.js: pasangan lama yang dibuang
    // tidak langsung hilang total, tapi disisipkan sebagai satu baris cuplikan ringkas.
    function _condenseDroppedPairsAgent(pairs) {
      if (!pairs.length) return null;
      const lines = pairs.map((h) => {
        const role = h.role === 'assistant' ? 'AI' : 'User';
        const raw = h.content || '';
        const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 150);
        return `${role}: ${snippet}${raw.length > 150 ? '…' : ''}`;
      });
      return {
        role: 'user',
        content: `[Ringkasan ${pairs.length} pasang percakapan lama yang dipangkas agar muat batas token]\n${lines.join('\n')}`,
      };
    }
    // Potong history dari yang paling lama agar payload HTTP tidak 413.
    // Selalu buang sepasang (user+assistant) agar urutan pesan tetap valid.
    // Pasangan yang dibuang dikondensasi jadi satu baris ringkas (bukan hilang total).
    function _trimHistoryForAgent(history, systemPrompt, question, maxTokens) {
      // Estimasi overhead: system prompt + question + tool defs + JSON framing.
      // Tool defs bisa 500-2000 chars; pakai 800 sebagai estimasi konservatif.
      const overhead = _estimateTok(systemPrompt) + _estimateTok(question) + 800;
      // Jika overhead sendiri sudah melebihi limit, kembalikan history kosong —
      // system prompt + question adalah minimum yang tidak bisa dipotong lebih jauh.
      if (overhead >= maxTokens) return [];
      let trimmed = [...history];
      const droppedPairs = [];
      // Potong dari depan sepasang (user + assistant) agar urutan selalu valid.
      // Pastikan entry paling depan setelah trim adalah 'user' agar tidak mulai dengan 'assistant'.
      while (trimmed.length > 0) {
        const histTok = trimmed.reduce((s, h) => s + _estimateTok(h.content), 0);
        if (overhead + histTok <= maxTokens) break;
        // Buang pasang pertama; jika hanya 1 entry tersisa, buang juga.
        const cut = trimmed.length <= 2 ? trimmed : trimmed.slice(0, 2);
        droppedPairs.push(...cut);
        trimmed = trimmed.length <= 2 ? [] : trimmed.slice(2);
      }
      // Pastikan history tidak dimulai dengan pesan 'assistant' (dapat terjadi jika history ganjil).
      while (trimmed.length > 0 && trimmed[0].role === 'assistant') trimmed = trimmed.slice(1);
      if (droppedPairs.length) {
        const recap = _condenseDroppedPairsAgent(droppedPairs);
        const recapTok = _estimateTok(recap.content);
        if (overhead + recapTok + trimmed.reduce((s, h) => s + _estimateTok(h.content), 0) <= maxTokens) {
          trimmed = [recap, ...trimmed];
        }
      }
      return trimmed;
    }

    // ─── Persistent cursor + 429 cooldown per provider (agent loop) ────────────
    // Slot = ki * nModels + mi — key-first: habiskan semua model key0 sebelum key1.
    // Setelah 429: cursor maju → request berikutnya skip slot ini.
    // Setelah sukses: cursor di posisi ini → request berikutnya mulai dari sini.
    const AGENT_RL_MS = 65_000;     // 65s cooldown setelah 429
    const AGENT_RL_504_MS = 3_000;   // 3s cooldown setelah 504 (upstream timeout — cepat fallback ke provider lain)
    const AGENT_RETRYABLE = new Set([429, 500, 503, 504]);
    const _agentCursor = { gemini: 0, groq: 0, openai: 0, atomesus: 0, conduit: 0, iamhc: 0 };
    // Circuit breaker — skip Atomesus sementara kalau sudah gagal 3x dalam 3 menit
    const _atomesusConsecFails = { count: 0, lastFail: 0 };
    const ATOMESUS_SKIP_AFTER  = 3;         // gagal N kali
    const ATOMESUS_SKIP_WINDOW = 3 * 60_000; // dalam 3 menit → skip selama window ini
    const _agentRL = new Map(); // "${p}::${ki}::${model}" → expiry ms

    function _aIsRL(p, ki, m) {
      const k = `${p}::${ki}::${m}`;
      const u = _agentRL.get(k);
      if (!u) return false;
      if (Date.now() >= u) { _agentRL.delete(k); return false; }
      return true;
    }
    function _aMarkRL(p, ki, m) {
      _agentRL.set(`${p}::${ki}::${m}`, Date.now() + AGENT_RL_MS);
      console.log(`[agent/${p}] ⏳ key#${ki} model=${m} rate-limit ${Math.round(AGENT_RL_MS/1000)}s`);
    }
    // Hitung slot awal yang tidak di-rate-limit untuk provider ini
    function _agentPickStart(p, nK, nM) {
      const total = nK * nM;
      const start = (_agentCursor[p] || 0) % total;
      return start; // kita tetap mulai dari sini dan skip yang RL di dalam loop
    }

    // ─── Tool Registry ───────────────────────────────────────────────────────────


    // createGitHubRepo — dipindahkan dari ai.js ke sini (tool agent, bukan utility AI)
    async function createGitHubRepo(repoName, options) {
    options = options || {};
    const WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN;
    if (!WRITE_TOKEN) {
      const e = new Error('GITHUB_WRITE_TOKEN belum di-set di Railway env — wajib untuk buat repo GitHub.');
      e.response = { status: 401, data: { message: e.message } };
      throw e;
    }
    const name = String(repoName || '').trim().replace(/[^a-zA-Z0-9._-]/g, '-');
    if (!name) throw new Error('Nama repository tidak valid.');
    const body = {
      name,
      description: options.description || '',
      private: options.private !== undefined ? !!options.private : false,
      auto_init: true,
    };
    const { data } = await axios.post(
      'https://api.github.com/user/repos',
      body,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${WRITE_TOKEN}`,
          'User-Agent': 'BP-AI-Bot/1.0',
        },
        timeout: 15000,
      },
    );
    return { name: data.full_name, url: data.html_url, private: data.private, defaultBranch: data.default_branch };
    }

        const TOOLS = {
    getCryptoPrice: {
      desc: 'Ambil harga kripto terkini, market cap, dan perubahan 24h dari CoinGecko. Gunakan untuk BTC, ETH, SOL, dan coin besar.',
      params: {
        type: 'OBJECT',
        properties: {
          coin_ids: { type: 'STRING', description: 'ID coin CoinGecko dipisah koma. Contoh: "bitcoin,ethereum,solana"' },
        },
        required: ['coin_ids'],
      },
      async fn({ coin_ids }) {
        const ids = coin_ids.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const data = await getCryptoPrice(ids);
        if (!data) return 'Coin tidak ditemukan di CoinGecko.';
        const lines = Object.entries(data).map(([id, v]) => {
          const usd = v.usd ?? '?';
          const chg = v.usd_24h_change !== undefined ? ' (' + (v.usd_24h_change >= 0 ? '+' : '') + v.usd_24h_change.toFixed(2) + '% 24h)' : '';
          const mc  = v.usd_market_cap ? ' MC: $' + (v.usd_market_cap / 1e9).toFixed(2) + 'B' : '';
          return id + ': $' + usd + chg + mc;
        });
        return lines.join('\n') || 'Data tidak tersedia.';
      },
    },

    getDexPrice: {
      desc: 'Cari data token dari DEX — harga, volume, liquidity, market cap, contract address. Cocok untuk altcoin/memecoin/token DeFi yang tidak ada di CoinGecko.',
      params: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Simbol token atau contract address. Contoh: "PEPE", "0x532f27101...", "So11111111111111111111111111111111111111112"' },
        },
        required: ['query'],
      },
      async fn({ query }) {
        const data = await getDexScreenerInfo(query);
        if (!data) return 'Token "' + query + '" tidak ditemukan di DexScreener.';
        return JSON.stringify(data, null, 2).slice(0, 3000);
      },
    },

    getBinancePrice: {
      desc: 'Ambil harga spot Binance real-time. Untuk major crypto (BTC, ETH, BNB, SOL, XRP dll). Simbol harus format XYZUSDT.',
      params: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Pasangan Binance. Contoh: "BTCUSDT", "ETHUSDT", "SOLUSDT"' },
        },
        required: ['symbol'],
      },
      async fn({ symbol }) {
        const sym = symbol.toUpperCase().endsWith('USDT') ? symbol.toUpperCase() : symbol.toUpperCase() + 'USDT';
        const data = await getBinanceTicker(sym);
        if (!data) return 'Symbol "' + symbol + '" tidak ditemukan di Binance.';
        return JSON.stringify(data, null, 2);
      },
    },

    getTrendingTokens: {
      desc: 'Ambil daftar token kripto yang sedang trending hari ini berdasarkan pencarian CoinGecko.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getTrendingCrypto();
        if (!data || !data.length) return 'Gagal ambil data trending atau tidak ada data.';
        return 'Trending hari ini (CoinGecko):\n' +
          data.map((c, i) => `${i + 1}. ${c.name} (${(c.symbol || '').toUpperCase()}) — rank #${c.rank || '?'}`).join('\n');
      },
    },

    getFearGreed: {
      desc: 'Ambil Bitcoin Fear & Greed Index saat ini (0=Extreme Fear, 100=Extreme Greed). Menunjukkan sentimen pasar crypto secara keseluruhan.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getFearGreedIndex();
        if (!data) return 'Gagal ambil Fear & Greed Index.';
        return `Fear & Greed Index: ${data.value}/100 (${data.classification})`;
      },
    },

    getEthGasPrice: {
      desc: 'Ambil harga gas Ethereum (ETH) terkini dalam Gwei — slow, standard, fast.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getGasPrice('eth');
        if (!data) return 'Gagal ambil gas price Ethereum.';
        return `Gas price ${data.chain}: Slow ${data.SafeGasPrice} / Standard ${data.ProposeGasPrice} / Fast ${data.FastGasPrice} Gwei`;
      },
    },

    getDefiTVL: {
      desc: 'Ambil Total Value Locked (TVL) protocol DeFi dari DefiLlama. Harus isi nama protocol.',
      params: {
        type: 'OBJECT',
        properties: {
          protocol: { type: 'STRING', description: 'Slug protocol DeFi. Contoh: "uniswap", "aave", "lido", "curve", "makerdao".' },
        },
        required: ['protocol'],
      },
      async fn({ protocol } = {}) {
        if (!protocol) return 'Tolong sebutkan nama protocol DeFi-nya. Contoh: uniswap, aave, lido.';
        const data = await getDefiLlamaTVL(protocol);
        if (!data) return `Protocol "${protocol}" tidak ditemukan di DefiLlama. Coba pakai slug resminya.`;
        return `TVL ${data.protocol}: $${Math.round(data.tvlUsd).toLocaleString('en-US')}`;
      },
    },

    getBtcFees: {
      desc: 'Ambil estimasi fee transaksi Bitcoin dari mempool — fastest, half-hour, hour.',
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn() {
        const data = await getBtcMempoolFees();
        if (!data) return 'Gagal ambil BTC fees dari mempool.';
        return `BTC fee (sat/vB): Fastest ${data.fastestFee} / 30min ${data.halfHourFee} / 1hr ${data.hourFee} / Economy ${data.economyFee}`;
      },
    },

    analyzeTokenSecurity: {
      desc: 'Analisis keamanan token EVM — cek rug pull, honeypot, top holder, liquidity, LP lock. Butuh contract address (0x...). Chain default: base.',
      params: {
        type: 'OBJECT',
        properties: {
          contract_address: { type: 'STRING', description: 'Contract address token EVM. Contoh: "0x532f27101965dd16442E59d40670FaF5eBB142E4"' },
          chain: { type: 'STRING', description: 'Blockchain. Contoh: "base", "ethereum", "bsc". Default: "base"' },
        },
        required: ['contract_address'],
      },
      async fn({ contract_address, chain = 'base' }) {
        // runScamAnalysis menerima string pertanyaan, bukan address langsung
        const result = await runScamAnalysis(`${contract_address} ${chain}`);
        if (!result || !result.fullPrompt) return 'Gagal analisis token — data on-chain tidak tersedia.';
        // Kembalikan fullPrompt (data on-chain yang dikumpulkan) agar agent bisa format jawabannya
        return result.fullPrompt.slice(0, 5000);
      },
    },

    getWalletPortfolio: {
      desc: 'Ambil portofolio lengkap wallet EVM — semua token dan total nilai USD dari Zerion.',
      params: {
        type: 'OBJECT',
        properties: {
          address: { type: 'STRING', description: 'Wallet address (0x...) atau ENS. Contoh: "0x742d35Cc..." atau "vitalik.eth"' },
        },
        required: ['address'],
      },
      async fn({ address }) {
        const data = await fetchZerionPortfolio(address);
        return data ? String(data).slice(0, 4000) : 'Gagal ambil portfolio wallet.';
      },
    },

    getOnchainData: {
      desc: 'WAJIB panggil untuk: (1) contract address Solana (base58 32-44 karakter), (2) token Solana/memecoin apapun, (3) token EVM dari DEX kecil. Mengembalikan data LENGKAP dari GMGN: harga, MC, liquidity, holders, smart money, developer info, security, pergerakan 5m/1h/6h/24h, volume, ATH, LP burn/lock, risk metrics. Untuk address Solana: gunakan address langsung sebagai query. Jangan pernah jawab token Solana dari memori.',
      params: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description: 'Sub-perintah GMGN. Format: "<CA>" untuk info token spesifik, "trending sol" untuk trending Solana, "trending eth/base/bsc" untuk chain lain, "smart sol" untuk top smart traders Solana, "smart eth" untuk ETH, "wallet <address>" untuk aktivitas wallet tertentu.',
          },
        },
        required: ['query'],
      },
      async fn({ query }) {
        const q = String(query).trim();
        const parsed = detectGmgnQuery('gmgn ' + q);
        if (!parsed) {
          return 'Format query tidak valid. Contoh: "trending sol", "smart eth", atau contract address token.';
        }
        const data = await handleGmgnCommand(parsed);
        return data ? String(data).slice(0, 5000) : 'Data GMGN tidak tersedia.';
      },
    },
    
    getCryptoRankData: {
      desc: 'Ambil data fundamental token dari CryptoRank: harga, ATH, ATL, volume 24h, market cap, supply, kategori. Lebih detail dari CoinGecko untuk mid/small cap. Gunakan untuk pertanyaan ATH/ATL/ROI/supply/peringkat token.',
      params: {
        type: 'OBJECT',
        properties: {
          symbol: { type: 'STRING', description: 'Simbol token. Contoh: "BTC", "ETH", "SOL", "ARB", "PEPE"' },
        },
        required: ['symbol'],
      },
      async fn({ symbol }) {
        if (!CRYPTORANK_API_KEY) return 'CRYPTORANK_API_KEY belum di-set di Railway environment variables.';
        const sym = String(symbol).toUpperCase().trim();
        try {
          const axios = require('axios');
          const { data } = await axios.get('https://api.cryptorank.io/v1/currencies', {
            params: { api_key: CRYPTORANK_API_KEY, symbols: sym, limit: 5 },
            timeout: 12000,
          });
          if (data?.error) return 'CryptoRank error: ' + data.error;
          const coins = data?.data || [];
          if (!coins.length) return 'Token "' + sym + '" tidak ditemukan di CryptoRank.';
          const c = coins[0];
          const p = c.values?.USD || {};
          const ath = c.athPrice?.USD;
          const atl = c.atlPrice?.USD;
          const fmtP = (n) => {
            if (n == null) return '?';
            if (n < 0.000001) return n.toExponential(4);
            if (n < 0.001) return n.toFixed(8);
            if (n < 1) return n.toFixed(6);
            return n.toFixed(4);
          };
          const fmtPct = (n) => n != null ? (n >= 0 ? '+' : '') + n.toFixed(2) + '%' : '?';
          const fmtB = (n) => n != null ? (n / 1e9).toFixed(3) + 'B' : '?';
          const fmtM = (n) => n != null ? (n / 1e6).toFixed(2) + 'M' : '?';
          const lines = [
            '**' + c.name + ' (' + c.symbol + ')** — Rank #' + (c.rank || '?'),
            'Harga     : ' + (p.price != null ? fmtP(p.price) + ' USD' : '?'),
            '24h       : ' + fmtPct(p.percentChange24h),
            '7d        : ' + fmtPct(p.percentChange7d),
            '30d       : ' + fmtPct(p.percentChange30d),
            'Market Cap: ' + fmtB(p.marketCap) + ' USD',
            'Vol 24h   : ' + fmtM(p.volume24h) + ' USD',
            'ATH       : ' + (ath != null ? fmtP(ath) + ' USD' : '?'),
            'ATL       : ' + (atl != null ? fmtP(atl) + ' USD' : '?'),
            'Supply    : ' + fmtM(c.circulatingSupply) + ' / ' + (c.maxSupply != null ? fmtM(c.maxSupply) : 'infinite'),
            c.category ? 'Kategori  : ' + c.category : '',
            c.type     ? 'Type      : ' + c.type     : '',
          ].filter(Boolean);
          return lines.join('\n') + '\n_(sumber: CryptoRank)_';
        } catch (e) {
          const apiErr = e.response?.data?.message || e.response?.data?.error || e.message;
          return 'Gagal ambil data CryptoRank: ' + apiErr;
        }
      },
    },

    getAlchemyOnchain: {
      desc: 'Ambil data on-chain Base Network via Alchemy RPC: saldo ETH wallet, token ERC-20 holdings, atau info blok terbaru. Gunakan untuk cek aset/holdings wallet di Base chain.',
      params: {
        type: 'OBJECT',
        properties: {
          action:  { type: 'STRING',  description: 'Pilihan: "eth_balance" (saldo ETH), "token_balances" (semua ERC-20 di wallet), "latest_block" (info blok terbaru Base)' },
          address: { type: 'STRING',  description: 'Wallet address (0x...). Wajib untuk eth_balance dan token_balances.' },
        },
        required: ['action'],
      },
      async fn({ action, address }) {
        if (!ALCHEMY_BASE_RPC) return 'ALCHEMY_BASE_RPC belum di-set di Railway environment variables.';
        const axios = require('axios');
        const rpc = (method, params) =>
          axios.post(ALCHEMY_BASE_RPC, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 12000 })
               .then(r => {
                 if (r.data.error) throw new Error(r.data.error.message || JSON.stringify(r.data.error));
                 return r.data.result;
               });
        try {
          if (action === 'eth_balance') {
            if (!address) return 'Butuh address wallet untuk cek saldo ETH.';
            const hexBal = await rpc('eth_getBalance', [address, 'latest']);
            const weiStr = BigInt(hexBal).toString();
            // safe division: avoid float precision loss
            const whole = weiStr.length > 18 ? weiStr.slice(0, weiStr.length - 18) : '0';
            const frac  = weiStr.padStart(19, '0').slice(-18, -12); // 6 decimal places
            return 'Saldo ETH di Base Network\n' +
                   '• Address: ' + address + '\n' +
                   '• Balance: ' + whole + '.' + frac + ' ETH';
          }
          if (action === 'token_balances') {
            if (!address) return 'Butuh address wallet untuk cek token holdings.';
            const result = await rpc('alchemy_getTokenBalances', [address]);
            const ZERO32 = '0x' + '0'.repeat(64);
            const nonZero = (result?.tokenBalances || []).filter(t => {
              const b = (t.tokenBalance || '').toLowerCase();
              return b !== '0x0' && b !== ZERO32 && b !== '0x' + '0'.repeat(64);
            });
            if (!nonZero.length) return 'Tidak ada token ERC-20 ditemukan di wallet ' + address + ' (Base Network).';
            const top = nonZero.slice(0, 12);
            const lines = ['Token Holdings (Base Network) — ' + address + ':'];
            for (const t of top) {
              try {
                const meta = await rpc('alchemy_getTokenMetadata', [t.contractAddress]);
                const dec = (meta && meta.decimals != null) ? meta.decimals : 18;
                let amount = '?';
                if (dec > 0) {
                  const raw = BigInt(t.tokenBalance);
                  const divisor = BigInt(10 ** Math.min(dec, 18));
                  const whole2 = (raw / divisor).toString();
                  const frac2  = (raw % divisor).toString().padStart(dec, '0').slice(0, 4);
                  amount = whole2 + '.' + frac2;
                } else {
                  amount = BigInt(t.tokenBalance).toString();
                }
                const sym  = (meta?.symbol || '?').slice(0, 10);
                const name = (meta?.name   || t.contractAddress.slice(0, 10)).slice(0, 24);
                lines.push('• ' + sym + ': ' + amount + '  (' + name + ')');
              } catch (_) {
                lines.push('• ' + t.contractAddress.slice(0, 12) + '...');
              }
            }
            if (nonZero.length > 12) lines.push('... dan ' + (nonZero.length - 12) + ' token lainnya');
            return lines.join('\n');
          }
          if (action === 'latest_block') {
            const b = await rpc('eth_getBlockByNumber', ['latest', false]);
            const num  = parseInt(b.number, 16);
            const ts   = parseInt(b.timestamp, 16);
            const gas  = parseInt(b.gasUsed || '0x0', 16);
            return 'Base Network — Blok Terbaru\n' +
                   '• Nomor   : #' + num + '\n' +
                   '• Hash    : ' + (b.hash || '?').slice(0, 24) + '...\n' +
                   '• Waktu   : ' + new Date(ts * 1000).toISOString() + '\n' +
                   '• Gas Used: ' + gas.toLocaleString() + '\n' +
                   '• TX Count: ' + (b.transactions || []).length;
          }
          return 'Action tidak dikenal. Gunakan: eth_balance, token_balances, atau latest_block.';
        } catch (e) {
          return 'Gagal ambil on-chain Alchemy: ' + e.message;
        }
      },
    },

    executeCode: {
      desc: 'Jalankan kode dalam sandbox aman (Python, JS, Bash, TS, Java, R). WAJIB dipanggil untuk verifikasi — jangan pernah tebak output. Sandbox persist selama sesi: file, variabel, package tetap ada. Jika error: baca traceback → perbaiki kode → panggil executeCode lagi.',
      timeout: 35000,
      params: {
        type: 'OBJECT',
        properties: {
          language: { type: 'STRING', description: 'Bahasa pemrograman: python, javascript, bash, typescript, java, r. Default: python' },
          code: { type: 'STRING', description: 'Kode lengkap yang akan dijalankan di sandbox' },
        },
        required: ['language', 'code'],
      },
      async fn({ language, code }, ctx) {
        return await e2b.runCode(ctx && ctx.userId ? ctx.userId : 'default', language || 'python', code);
      },
    },

    writeFile: {
      desc: 'Tulis/simpan file ke sandbox. Gunakan untuk file baru atau overwrite total. UNTUK EDIT PARSIAL gunakan editFile — lebih aman dan hemat token. Setelah writeFile WAJIB verifikasi: executeCode({ language: \'bash\', code: \'node --check nama.js\' }) untuk JS/TS atau executeCode({ language: \'bash\', code: \'python3 -m py_compile nama.py\' }) untuk Python. File persist selama sesi.',
      timeout: 12000,
      params: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Path file relatif. Contoh: "app.py", "src/main.js", "data/input.csv"' },
          content: { type: 'STRING', description: 'Isi lengkap file yang akan ditulis' },
        },
        required: ['path', 'content'],
      },
      async fn({ path, content }, ctx) {
        const _res = await e2b.writeFile(ctx && ctx.userId ? ctx.userId : 'default', path, content);
        // [FIX] Verifikasi sintaks setelah menulis — sama seperti Replit Agent yang
        // selalu memverifikasi hasil edit (typecheck/build) sebelum menganggap tugas selesai.
        // Ini pengecekan lokal ringan (tanpa eksekusi), bukan pengganti executeCode.
        try {
          const _chk = validateSyntax(path, content);
          if (_chk && _chk.valid === false) {
            return _res + '\n⚠️ PERINGATAN: sintaks file berpotensi rusak — ' + _chk.error + '. Perbaiki dan writeFile lagi sebelum lanjut.';
          }
        } catch (_) { /* validasi opsional, jangan gagalkan writeFile kalau validator error */ }
        return _res;
      },
    },

    readFile: {
      desc: 'Baca isi file dari sandbox. Gunakan untuk: verifikasi file setelah writeFile, debug kode (cek apakah benar), baca output yang disimpan ke file. Selalu baca file jika ada keraguan isi.',
      timeout: 10000,
      params: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Path file yang ingin dibaca. Contoh: "output.txt", "result.json", "app.py"' },
        },
        required: ['path'],
      },
      async fn({ path }, ctx) {
        return await e2b.readFile(ctx && ctx.userId ? ctx.userId : 'default', path);
      },
    },

    listFiles: {
      desc: 'Lihat daftar file dan folder di sandbox (termasuk ukuran). Gunakan di awal jika tidak yakin ada apa saja, setelah writeFile untuk konfirmasi, atau saat debugging cek file terbuat.',
      timeout: 10000,
      params: {
        type: 'OBJECT',
        properties: {
          path: { type: 'STRING', description: 'Direktori yang ingin dilihat. Default: /home/user' },
        },
        required: [],
      },
      async fn({ path }, ctx) {
        return await e2b.listFiles(ctx && ctx.userId ? ctx.userId : 'default', path || '/home/user');
      },
    },

    installPackage: {
      desc: 'Install library/package ke sandbox. Gunakan pip untuk Python, npm untuk Node.js, apt untuk sistem. Jalankan sebelum executeCode jika butuh library eksternal.',
      timeout: 60000,
      params: {
        type: 'OBJECT',
        properties: {
          manager: { type: 'STRING', description: 'Package manager: pip, npm, apt' },
          packages: { type: 'STRING', description: 'Nama package dipisah spasi. Contoh: "pandas numpy matplotlib" atau "axios express"' },
        },
        required: ['manager', 'packages'],
      },
      async fn({ manager, packages }, ctx) {
        return await e2b.installPackage(ctx && ctx.userId ? ctx.userId : 'default', manager, packages);
      },
    },

    appendFile: {
      desc: 'Tambah konten ke file yang sudah ada di sandbox TANPA menghapus isi sebelumnya. Berguna untuk: menambah fungsi ke file yang ada, append log/output, menulis hasil iterasi ke file sama. Gunakan writeFile jika ingin overwrite penuh.',
      timeout: 10000,
      params: {
        type: 'OBJECT',
        properties: {
          path:    { type: 'STRING', description: 'Path file yang akan ditambahkan kontennya. Contoh: "app.py", "output.log"' },
          content: { type: 'STRING', description: 'Konten yang ditambahkan ke akhir file' },
        },
        required: ['path', 'content'],
      },
      async fn({ path, content }, ctx) {
        return await e2b.appendFile(ctx && ctx.userId ? ctx.userId : 'default', path, content);
      },
    },


    editFile: {
      desc: 'Edit sebagian kode dalam file sandbox dengan mengganti teks lama ke teks baru. LEBIH AMAN dari writeFile untuk file besar — hanya mengubah bagian yang perlu diubah. WAJIB panggil readFile dulu untuk mendapatkan teks yang tepat. Sertakan 5-10 baris konteks di old_string agar unik. Setelah editFile panggil readFile untuk verifikasi.',
      timeout: 12000,
      params: {
        type: 'OBJECT',
        properties: {
          path:       { type: 'STRING', description: 'Path file di sandbox. Contoh: "app.py", "src/main.js"' },
          old_string: { type: 'STRING', description: 'Teks yang akan diganti — harus PERSIS sama dengan isi file (whitespace, indentasi, baris baru). Sertakan konteks sekitar agar unik.' },
          new_string: { type: 'STRING', description: 'Teks pengganti. Bisa string kosong untuk menghapus old_string.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
      async fn({ path, old_string, new_string }, ctx) {
        const uid = ctx && ctx.userId ? ctx.userId : 'default';
        // [FIX] Sebelumnya memakai e2b.readFile() yang mengembalikan teks BERBUNGKUS
        // markdown (header "📄 **path**...", code fence, dan dipotong smartTrunc di 4000
        // karakter) — bungkus itu ikut kena replace() lalu ditulis BALIK sebagai isi file,
        // mencemari/merusak file (dan memotong permanen isi file >4000 karakter). Sekarang
        // pakai e2b.readFileRaw() yang mengembalikan isi file APA ADANYA.
        let current;
        try {
          current = await e2b.readFileRaw(uid, path);
        } catch (e) {
          return 'Gagal baca file ' + path + ' untuk editFile: ' + e.message;
        }
        if (!current.includes(old_string)) {
          return '⚠️ old_string tidak ditemukan di ' + path + ' — teks harus PERSIS sama (spasi, indentasi, baris baru). Gunakan readFile dulu untuk melihat isi file yang aktual, lalu salin teks yang akan diganti secara verbatim.';
        }
        const count = current.split(old_string).length - 1;
        if (count > 1) {
          return '⚠️ old_string ditemukan ' + count + ' kali di ' + path + ' — tambahkan lebih banyak konteks (baris sebelum/sesudah) di old_string agar unik, lalu coba lagi.';
        }
        const updated = current.replace(old_string, new_string);
        const result = await e2b.writeFile(uid, path, updated);
        try {
          const _chk = validateSyntax(path, updated);
          if (_chk && _chk.valid === false) {
            return result + '\n⚠️ PERINGATAN: sintaks file berpotensi rusak setelah edit — ' + _chk.error + '. Periksa dengan readFile dan perbaiki.';
          }
        } catch (_) {}
        return result;
      },
    },

    searchFiles: {
      desc: 'Cari teks/pattern di dalam file-file sandbox (seperti grep -rn). Berguna untuk: menemukan definisi fungsi, cari variabel, lacak baris error, cek apakah import ada. Kembalikan baris dengan nomor baris.',
      timeout: 12000,
      params: {
        type: 'OBJECT',
        properties: {
          pattern: { type: 'STRING', description: 'Teks atau regex yang dicari. Contoh: "def calculate", "import pandas", "TypeError"' },
          path:    { type: 'STRING', description: 'Direktori pencarian (opsional). Default: /home/user' },
        },
        required: ['pattern'],
      },
      async fn({ pattern, path }, ctx) {
        return await e2b.searchFiles(ctx && ctx.userId ? ctx.userId : 'default', pattern, path || '/home/user');
      },
    },

    // ─── GitHub Repository Reader ─────────────────────────────────────────────
    // Baca repo GitHub publik via API tanpa auth (60 req/hr) atau dengan PAT.
    // Dipakai untuk: cek bug/error kode, review file, analisis struktur repo.
    resetSandbox: {
      desc: 'Reset sandbox E2B milik user — hapus semua file, variabel, dan state. Gunakan jika sandbox bermasalah, kode error aneh, atau ingin mulai fresh.',
      timeout: 15000,
      params: { type: 'OBJECT', properties: {}, required: [] },
      async fn(_args, ctx) {
        const e2b = require('./e2b');
        return e2b.resetSession(ctx && ctx.userId ? ctx.userId : 'default');
      },
    },

    webSearch: {
      desc: 'Cari informasi di internet. Kembalikan list URL + snippet relevan. Setelah dapat URL relevan, gunakan fetchUrl untuk baca isinya. Gunakan untuk: dokumentasi API, tutorial, referensi teknis, cara penggunaan platform/library.',
      timeout: 20000,
      params: {
        type: 'OBJECT',
        properties: {
          query: { type: 'STRING', description: 'Query pencarian. Contoh: "IAMHC API documentation", "cara pakai Groq API", "Zerion API reference"' },
          num_results: { type: 'STRING', description: 'Jumlah hasil (1-10). Default: 5' },
        },
        required: ['query'],
      },
      async fn({ query, num_results }) {
        const n = Math.min(parseInt(num_results || '5'), 10);
        const BRAVE_KEY = process.env.BRAVE_SEARCH_API_KEY;
        if (BRAVE_KEY) {
          try {
            const { data } = await axios.get('https://api.search.brave.com/res/v1/web/search', {
              params: { q: query, count: n, search_lang: 'en' },
              headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': BRAVE_KEY },
              timeout: 15000,
            });
            const results = (data?.web?.results || []).slice(0, n);
            if (!results.length) return 'Tidak ada hasil untuk: "' + query + '"';
            return results.map((r, i) => (i + 1) + '. **' + r.title + '**\n   URL: ' + r.url + '\n   ' + (r.description || '')).join('\n\n');
          } catch (_) {}
        }
        // Fallback: DuckDuckGo (tanpa API key)
        try {
          const { data } = await axios.get('https://api.duckduckgo.com/', {
            params: { q: query, format: 'json', no_redirect: 1, no_html: 1 },
            timeout: 10000,
          });
          const results = [];
          if (data.AbstractText) results.push('**' + (data.Heading || query) + '**\n' + data.AbstractText + (data.AbstractURL ? '\nURL: ' + data.AbstractURL : ''));
          (data.RelatedTopics || []).slice(0, n).forEach((t, i) => {
            if (t.Text && t.FirstURL) results.push((i + 1) + '. ' + t.Text + '\nURL: ' + t.FirstURL);
          });
          if (!results.length) return 'Tidak ada hasil untuk: "' + query + '". Coba fetchUrl ke situs dokumentasi langsung, atau set BRAVE_SEARCH_API_KEY di Railway untuk hasil lebih baik.';
          return results.join('\n\n');
        } catch (e) {
          return '❌ Gagal search: ' + e.message;
        }
      },
    },

    fetchUrl: {
      desc: 'Buka dan baca isi halaman web sebagai teks bersih/markdown — otomatis ekstrak konten utama, buang menu/sidebar/iklan. Gunakan untuk: baca dokumentasi API, tutorial, artikel teknis. Dukung range baris untuk navigasi halaman panjang.',
      timeout: 30000,
      maxOutput: 15000,
      params: {
        type: 'OBJECT',
        properties: {
          url: { type: 'STRING', description: 'URL halaman yang dibaca. Contoh: "https://docs.groq.com", "https://platform.openai.com/docs/api-reference"' },
          start_line: { type: 'STRING', description: 'Baris mulai (opsional, 1-based). Untuk baca bagian tertentu halaman panjang.' },
          end_line: { type: 'STRING', description: 'Baris akhir inklusif (opsional). Kosong = sampai akhir.' },
        },
        required: ['url'],
      },
      async fn({ url, start_line, end_line }) {
        const cleanUrl = String(url || '').trim();
        if (!/^https?:\/\//.test(cleanUrl)) return '⚠️ URL harus dimulai dengan http:// atau https://';
        try {
          // Jina AI Reader: konversi web ke markdown bersih, gratis tanpa API key
          const { data } = await axios.get('https://r.jina.ai/' + cleanUrl, {
            timeout: 25000,
            headers: { Accept: 'text/plain', 'User-Agent': 'BP-AI-Bot/1.0', 'X-No-Cache': 'true' },
            responseType: 'text',
          });
          const text = String(data || '').trim();
          if (!text || text.length < 50) return '⚠️ Halaman kosong atau tidak bisa dibaca: ' + cleanUrl;
          const lines = text.split('\n');
          const total = lines.length;
          let s = start_line ? Math.max(1, parseInt(start_line)) : 1;
          let e = end_line ? Math.min(parseInt(end_line), total) : total;
          if (isNaN(s)) s = 1;
          if (isNaN(e)) e = total;
          const selected = lines.slice(s - 1, e).join('\n');
          const nav = (s > 1 || e < total)
            ? '\n\n_(Baris ' + s + '–' + e + ' dari ' + total + ' total. Gunakan start_line/end_line untuk navigasi)_'
            : (total > 300 ? '\n\n_(' + total + ' baris total. Gunakan start_line/end_line untuk baca bagian tertentu)_' : '');
          return selected + nav;
        } catch (e) {
          if (e.response?.status === 422) return '⚠️ Tidak bisa membaca URL ini (mungkin butuh JavaScript atau di-block). Coba URL alternatif.';
          return '⚠️ Gagal fetch ' + cleanUrl + ': ' + e.message;
        }
      },
    },

    readGitHubRepo: {
      desc: 'Baca isi file dan struktur repositori GitHub. Gunakan untuk: review kode, debug error, baca file sebelum edit. Untuk file spesifik gunakan file_path (lebih cepat). Bisa pilih branch spesifik via param branch.',
      timeout: 45000,
      maxOutput: 30000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_url: { type: 'STRING', description: 'URL repositori GitHub. Contoh: "https://github.com/user/repo" atau "https://github.com/user/repo/blob/main/file.js"' },
          file_path: { type: 'STRING', description: 'Path file spesifik yang ingin dibaca (opsional). Contoh: "src/index.js", "package.json". Kosongkan untuk lihat semua file.' },
          max_files: { type: 'STRING', description: 'Jumlah file maksimum yang dibaca isinya. Default: "10". Max: "20".' },
          branch:    { type: 'STRING', description: 'Branch yang dibaca (opsional). Default: branch utama repo. Contoh: "dev", "feat/login"' },
        },
        required: ['repo_url'],
      },
      async fn({ repo_url, file_path, max_files, branch }) {
        // axios sudah di-require di top agent.js — tidak perlu inline require
        // Parse GitHub URL
        const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
        if (!ghMatch) return 'URL GitHub tidak valid. Format: https://github.com/owner/repo';
        const owner = ghMatch[1];
        const repo  = ghMatch[2].replace(/\.git$/, '');

        // Cek apakah URL menunjuk ke file spesifik
        const fileMatch = repo_url.match(/github\.com\/[^\/]+\/[^\/]+\/(?:blob|raw)\/[^\/]+\/(.+)/);
        const targetFile = file_path || (fileMatch ? fileMatch[1] : null);

        const headers = { 'User-Agent': 'BP-AI-Bot/1.0', 'Accept': 'application/vnd.github+json' };
        const ghPat = process.env.GITHUB_WRITE_TOKEN;
        const _usingAuth = !!ghPat;
        if (ghPat) headers['Authorization'] = 'Bearer ' + ghPat;
        // Jika GITHUB_WRITE_TOKEN tidak di-set, tetap lanjut tanpa auth (unauthenticated).
        // GitHub API tanpa token: limit 60 req/jam, hanya bisa baca repo PUBLIK.
        // Repo PRIVATE akan kembalikan 404. Set GITHUB_WRITE_TOKEN di Railway untuk akses penuh.

        const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo;

        try {
          // Info repo dasar
          const { data: repoInfo } = await axios.get(apiBase, { headers, timeout: 8000 });
          const lines = [
            '**Repo:** ' + owner + '/' + repo,
            '**Deskripsi:** ' + (repoInfo.description || '(tidak ada)'),
            '**Bahasa utama:** ' + (repoInfo.language || 'N/A'),
            '**Stars:** ' + repoInfo.stargazers_count + ' | **Forks:** ' + repoInfo.forks_count,
            '**Default branch:** ' + repoInfo.default_branch,
            ...(_usingAuth ? [] : ['⚠️ _Mode unauthenticated (GITHUB_WRITE_TOKEN tidak di-set) — hanya repo publik, limit 60 req/jam_']),
            '',
          ];

          if (targetFile) {
            // Baca file spesifik
            try {
              const { data: fileData } = await axios.get(
                apiBase + '/contents/' + targetFile,
                { headers, timeout: 8000 }
              );
              if (fileData.encoding === 'base64') {
                const content = Buffer.from(fileData.content, 'base64').toString('utf8');
                lines.push('**File:** ' + targetFile + ' (' + fileData.size + ' bytes)');
                const sfLines = content.split('\n');
                const sfImports = sfLines.filter(l => /^(import |require\(|from )/.test(l.trim())).slice(0, 10);
                lines.push('**Panjang:** ' + sfLines.length + ' baris');
                if (sfImports.length) lines.push('**Imports:** ' + sfImports.join(' | '));
                lines.push('```' + (targetFile.split('.').pop() || ''));
                sfLines.slice(0, 400).forEach((l, i) => lines.push((i + 1) + ' | ' + l));
                if (sfLines.length > 400) lines.push('// ... terpotong (' + sfLines.length + ' baris total, gunakan readGitHubFileLines untuk baca lebih)');
                lines.push('```');
              } else {
                lines.push('File tidak bisa dibaca (terlalu besar atau binary).');
              }
            } catch (fe) {
              lines.push('File "' + targetFile + '" tidak ditemukan: ' + fe.message);
            }
          } else {
            // Ambil tree rekursif semua file
            const activeBranch = branch || repoInfo.default_branch;
          const { data: treeData } = await axios.get(
              apiBase + '/git/trees/' + activeBranch + '?recursive=1',
              { headers, timeout: 10000 }
            );
            const files = (treeData.tree || []).filter(f => f.type === 'blob');
            lines.push('**Total file:** ' + files.length + (treeData.truncated ? ' (truncated)' : ''));
            lines.push('');
            lines.push('**Struktur file:**');
            files.slice(0, 50).forEach(f => lines.push('  ' + f.path + ' (' + (f.size || 0) + ' bytes)'));
            if (files.length > 50) lines.push('  ... dan ' + (files.length - 50) + ' file lainnya');
            lines.push('');

            // Baca isi file-file terpenting (JS/TS/PY/JSON/MD dst, skip node_modules/dist)
            const SKIP = /node_modules|dist\/|build\/|\.min\.js|\.map$|package-lock|\.lock$|yarn\.lock/i;
            const CODE_EXT = /\.(js|ts|jsx|tsx|py|sol|go|rs|java|rb|php|json|yaml|yml|toml|env\.example|md|txt|sh|dockerfile)$/i;
            const readCandidates = files
              .filter(f => CODE_EXT.test(f.path) && !SKIP.test(f.path) && f.size < 100000)
              .sort((a, b) => {
                // Prioritaskan file penting: package.json, index, main, bot, app, README
                const score = p => /package\.json$|index\.|main\.|bot\.|app\.|README/i.test(p) ? 1 : 0;
                return score(b.path) - score(a.path);
              })
              .slice(0, Math.min(parseInt(max_files || '25'), 50));

            if (readCandidates.length) {
              lines.push('**Isi file utama:**');
              // [FIX] Baca file PARALEL — bukan sequential! Sequential 10 file × 8s = 80s > timeout 20s.
              const fileResults = await Promise.all(readCandidates.map(async f => {
                try {
                  const { data: fd } = await axios.get(
                    apiBase + '/contents/' + f.path,
                    { headers, timeout: 8000 }
                  );
                  if (fd.encoding === 'base64') {
                    const fileContent = Buffer.from(fd.content, 'base64').toString('utf8');
                    const fcLines = fileContent.split('\n');
                    const imports = fcLines.filter(l => /^(import |require\(|from )/.test(l.trim())).slice(0, 10);
                    return [
                      '',
                      '--- **' + f.path + '** (' + fcLines.length + ' baris) ---',
                      ...(imports.length ? ['// Imports: ' + imports.join(' | ')] : []),
                      '```' + (f.path.split('.').pop() || ''),
                      ...fcLines.slice(0, 200).map((l, i) => (i + 1) + ' | ' + l),
                      ...(fcLines.length > 200 ? ['// ... terpotong (' + fcLines.length + ' baris total, gunakan readGitHubFileLines untuk baca lebih)'] : []),
                      '```',
                    ];
                  }
                  return null;
                } catch (_) { return null; }
              }));
              fileResults.forEach(r => { if (r) r.forEach(l => lines.push(l)); });
            }
          }

          return lines.join('\n').slice(0, 30000);
        } catch (e) {
          const st = e.response?.status;
          if (st === 404) {
            if (!_usingAuth) return 'Repo ' + owner + '/' + repo + ' tidak ditemukan atau bersifat private. (GITHUB_WRITE_TOKEN tidak di-set — repo private tidak bisa diakses tanpa token)';
            return 'Repo ' + owner + '/' + repo + ' tidak ditemukan atau GITHUB_WRITE_TOKEN tidak punya akses ke repo ini.';
          }
          if (st === 401) return 'GITHUB_WRITE_TOKEN tidak valid atau sudah expired. Periksa token di Railway.';
          if (st === 403) {
            const rateLimitRemaining = e.response?.headers?.['x-ratelimit-remaining'];
            if (rateLimitRemaining === '0') return 'Rate limit GitHub API habis (60 req/jam tanpa token atau 5000/jam dengan token). Coba lagi nanti.';
            return 'Akses ditolak ke repo ' + owner + '/' + repo + '. Pastikan GITHUB_WRITE_TOKEN punya scope "repo" dan akses ke repo ini.';
          }
          return 'Gagal ambil data GitHub: ' + e.message;
        }
      },
    },


    // ─── GitHub Repository Creator ────────────────────────────────────────────
    // [FIX] Buat repo baru via GITHUB_WRITE_TOKEN (token terpisah, khusus uji coba —
    // TIDAK memakai GITHUB_TOKEN yang dipakai data_store.js untuk Gist).
    createGitHubRepo: {
      desc: 'Buat repository GitHub baru di akun pemilik GITHUB_WRITE_TOKEN. Gunakan HANYA jika user secara eksplisit minta membuat/create repository baru.',
      timeout: 15000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_name: { type: 'STRING', description: 'Nama repository baru. Contoh: userbotdiscord' },
          description: { type: 'STRING', description: 'Deskripsi repository (opsional)' },
          private: { type: 'STRING', description: 'true untuk private repo, false untuk publik. Default: false' },
        },
        required: ['repo_name'],
      },
      async fn({ repo_name, description, private: isPrivate }) {
        try {
          const repo = await createGitHubRepo(repo_name, {
            description: description || '',
            private: String(isPrivate).toLowerCase() === 'true',
          });
          return '✅ Repository berhasil dibuat: ' + repo.url + ' (private: ' + repo.private + ')';
        } catch (e) {
          const status = e.response?.status;
          if (status === 401 || status === 403) return '⚠️ GITHUB_WRITE_TOKEN tidak valid atau tidak punya izin membuat repo (scope harus punya akses "repo" / "Administration: Read and write").';
          if (status === 422) return '⚠️ Gagal membuat repo: nama sudah dipakai atau tidak valid. (' + (e.response?.data?.message || e.message) + ')';
          return '⚠️ Gagal membuat repository: ' + e.message;
        }
      },
    },


    // ─── GitHub File Writer ───────────────────────────────────────────────────
    writeGitHubFile: {
      desc: 'Tulis atau update file di repository GitHub. Pakai GITHUB_WRITE_TOKEN (bukan GITHUB_TOKEN). Buat file baru atau overwrite yang sudah ada. Gunakan jika user minta edit/commit/push file ke GitHub.',
      timeout: 25000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_url:       { type: 'STRING', description: 'URL repo GitHub. Contoh: https://github.com/owner/repo' },
          file_path:      { type: 'STRING', description: 'Path file di repo. Contoh: src/index.js, README.md' },
          content:        { type: 'STRING', description: 'Isi LENGKAP file baru (full content, bukan diff)' },
          commit_message: { type: 'STRING', description: 'Pesan commit. Contoh: "fix: update error handler"' },
          branch:         { type: 'STRING', description: 'Branch target (opsional). Default: branch utama repo' },
        },
        required: ['repo_url', 'file_path', 'content', 'commit_message'],
      },
      async fn({ repo_url, file_path, content, commit_message, branch }) {
        const WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN;
        if (!WRITE_TOKEN) return 'GITHUB_WRITE_TOKEN belum di-set. Set token dengan scope "repo" atau "Contents: Read and write".';
        const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
        if (!ghMatch) return 'URL GitHub tidak valid. Format: https://github.com/owner/repo';
        if (/[?#]/.test(file_path)) return '⚠️ file_path tidak boleh mengandung ? atau # — cek path yang dikirim.';
        function safeGHPath(p) { return p.split('/').map(seg => encodeURIComponent(seg)).join('/'); }
        const owner = ghMatch[1], repo = ghMatch[2].replace(/\.git$/, '');
        const wHdr = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + WRITE_TOKEN, 'User-Agent': 'BP-AI-Bot/1.0', 'X-GitHub-Api-Version': '2022-11-28' };
        let targetBranch = branch || '';
        if (!targetBranch) {
          try { const { data: ri } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo, { headers: wHdr, timeout: 8000 }); targetBranch = ri.default_branch || 'main'; }
          catch (branchErr) {
          const branchStatus = branchErr.response?.status;
          if (branchStatus === 404) return '⚠️ Repository tidak ditemukan atau tidak bisa diakses dengan GITHUB_WRITE_TOKEN ini.';
          if (branchStatus === 401 || branchStatus === 403) return '⚠️ GITHUB_WRITE_TOKEN tidak punya akses ke repo ini.';
          targetBranch = 'main'; // fallback jika error jaringan
        }
        }
        let existingSha;
        try {
          const { data: fd } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safeGHPath(file_path) + '?ref=' + encodeURIComponent(targetBranch), { headers: wHdr, timeout: 10000 });
          existingSha = fd.sha;
        } catch (e) { if (e.response?.status !== 404) return 'Gagal cek file existing: ' + e.message; }
        try {
          const body = { message: commit_message, content: Buffer.from(content, 'utf-8').toString('base64'), branch: targetBranch };
          if (existingSha) body.sha = existingSha;
          const { data } = await axios.put('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safeGHPath(file_path), body, { headers: wHdr, timeout: 15000 });
          return '\u2705 File `' + file_path + '` berhasil ' + (existingSha ? 'diupdate' : 'dibuat') + ' di ' + owner + '/' + repo + ' (branch: ' + targetBranch + ')\n\uD83D\uDD17 Commit: ' + (data.commit?.html_url || '(lihat GitHub)');
        } catch (e) {
          const st = e.response?.status;
          if (st === 401 || st === 403) return 'GITHUB_WRITE_TOKEN tidak punya izin write. Cek scope token (harus "repo" atau "Contents: Read and write").';
          if (st === 409) return 'Conflict: SHA tidak cocok. Coba panggil tool lagi.';
          if (st === 422) return 'Gagal commit (422): ' + (e.response?.data?.message || e.message);
          return 'Gagal tulis file: ' + e.message;
        }
      },
    },


    // ─── GitHub File Editor (exact string replacement) ───────────────────────────
    editGitHubFile: {
      desc: 'Edit sebagian file di GitHub dengan mengganti teks lama ke teks baru — LEBIH AMAN dari writeGitHubFile untuk file besar karena hanya mengubah bagian yang perlu. Pakai GITHUB_WRITE_TOKEN. WAJIB: panggil readGitHubRepo atau readGitHubFileLines dulu untuk mendapatkan old_string yang tepat. Sertakan 5-10 baris konteks di old_string agar unik.',
      timeout: 30000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_url:       { type: 'STRING', description: 'URL repo GitHub. Contoh: https://github.com/owner/repo' },
          file_path:      { type: 'STRING', description: 'Path file di repo. Contoh: lib/agent.js, src/index.ts' },
          old_string:     { type: 'STRING', description: 'Teks yang akan diganti — harus PERSIS sama dengan isi file (whitespace, indentasi, baris baru). Sertakan konteks sekitar agar unik.' },
          new_string:     { type: 'STRING', description: 'Teks pengganti. Bisa string kosong untuk menghapus old_string.' },
          commit_message: { type: 'STRING', description: 'Pesan commit. Contoh: "fix: perbaiki error handler di route login"' },
          branch:         { type: 'STRING', description: 'Branch target (opsional). Default: branch utama repo' },
        },
        required: ['repo_url', 'file_path', 'old_string', 'new_string', 'commit_message'],
      },
      async fn({ repo_url, file_path, old_string, new_string, commit_message, branch }) {
        const WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN;
        if (!WRITE_TOKEN) return 'GITHUB_WRITE_TOKEN belum di-set.';
        const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
        if (!ghMatch) return 'URL GitHub tidak valid.';
        if (/[?#]/.test(file_path)) return '⚠️ file_path tidak boleh mengandung ? atau #.';
        function safeGHPath(p) { return p.split('/').map(seg => encodeURIComponent(seg)).join('/'); }
        const owner = ghMatch[1], repo = ghMatch[2].replace(/\.git$/, '');
        const wHdr = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + WRITE_TOKEN, 'User-Agent': 'BP-AI-Bot/1.0', 'X-GitHub-Api-Version': '2022-11-28' };
        let targetBranch = branch || '';
        if (!targetBranch) {
          try {
            const { data: ri } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo, { headers: wHdr, timeout: 8000 });
            targetBranch = ri.default_branch || 'main';
          } catch (branchErr) {
            const s = branchErr.response?.status;
            if (s === 404) return '⚠️ Repository tidak ditemukan atau tidak bisa diakses.';
            if (s === 401 || s === 403) return '⚠️ GITHUB_WRITE_TOKEN tidak punya akses ke repo ini.';
            targetBranch = 'main';
          }
        }
        // Baca isi file saat ini
        let currentContent, existingSha;
        try {
          const { data: fd } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safeGHPath(file_path) + '?ref=' + encodeURIComponent(targetBranch), { headers: wHdr, timeout: 12000 });
          if (fd.encoding !== 'base64') return 'File tidak bisa dibaca (binary atau terlalu besar).';
          currentContent = Buffer.from(fd.content, 'base64').toString('utf8');
          existingSha = fd.sha;
        } catch (e) {
          if (e.response?.status === 404) return 'File `' + file_path + '` tidak ditemukan di ' + owner + '/' + repo + '. Gunakan writeGitHubFile untuk membuat file baru.';
          return 'Gagal baca file untuk editGitHubFile: ' + e.message;
        }
        // Validasi old_string
        if (!currentContent.includes(old_string)) {
          return '⚠️ old_string tidak ditemukan di ' + file_path + ' — teks harus PERSIS sama (whitespace, indentasi, baris baru). Gunakan readGitHubFileLines atau readGitHubRepo untuk melihat isi file yang aktual sebelum mengedit.';
        }
        const count = currentContent.split(old_string).length - 1;
        if (count > 1) {
          return '⚠️ old_string ditemukan ' + count + ' kali di ' + file_path + ' — tambahkan lebih banyak konteks (baris sebelum/sesudah) di old_string agar unik.';
        }
        const updatedContent = currentContent.replace(old_string, new_string);
        // Commit hasil edit
        try {
          const body = { message: commit_message, content: Buffer.from(updatedContent, 'utf-8').toString('base64'), branch: targetBranch, sha: existingSha };
          const { data } = await axios.put('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safeGHPath(file_path), body, { headers: wHdr, timeout: 20000 });
          const oldLines = old_string.split('\n').length, newLines = new_string.split('\n').length;
          return '✅ editGitHubFile berhasil di `' + file_path + '` (' + owner + '/' + repo + ', branch: ' + targetBranch + ')\n' +
                 '📝 -' + oldLines + ' / +' + newLines + ' baris\n' +
                 '🔗 Commit: ' + (data.commit?.html_url || '(lihat GitHub)');
        } catch (e) {
          const st = e.response?.status;
          if (st === 401 || st === 403) return 'GITHUB_WRITE_TOKEN tidak punya izin write.';
          if (st === 409) return 'Conflict: SHA tidak cocok. Coba lagi.';
          if (st === 422) return 'Gagal commit (422): ' + (e.response?.data?.message || e.message);
          return 'Gagal editGitHubFile: ' + e.message;
        }
      },
    },

    // ─── GitHub File Deleter ──────────────────────────────────────────────────

      previewGitHubDiff: {
        desc: 'Preview diff SEBELUM commit ke GitHub — tampilkan old vs new tanpa mengubah file. WAJIB panggil ini sebelum writeGitHubFile/editGitHubFile untuk perubahan kode penting agar user bisa review.',
        timeout: 20000,
        params: {
          type: 'OBJECT',
          properties: {
            repo_url:    { type: 'STRING', description: 'URL repo GitHub. Contoh: https://github.com/owner/repo' },
            file_path:   { type: 'STRING', description: 'Path file di repo. Contoh: lib/ai.js' },
            new_content: { type: 'STRING', description: 'Isi file baru yang akan di-commit (full content)' },
            branch:      { type: 'STRING', description: 'Branch (opsional). Default: branch utama repo' },
          },
          required: ['repo_url', 'file_path', 'new_content'],
        },
        async fn({ repo_url, file_path, new_content, branch }) {
          const WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN;
          if (!WRITE_TOKEN) return 'GITHUB_WRITE_TOKEN belum di-set.';
          const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
          if (!ghMatch) return 'URL GitHub tidak valid.';
          const owner = ghMatch[1], repo = ghMatch[2].replace(/\.git$/, '');
          const wHdr = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + WRITE_TOKEN, 'User-Agent': 'BP-AI-Bot/1.0', 'X-GitHub-Api-Version': '2022-11-28' };
          try {
            let targetBranch = branch || '';
            if (!targetBranch) {
              const { data: ri } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo, { headers: wHdr, timeout: 8000 });
              targetBranch = ri.default_branch || 'main';
            }
            const safePath = file_path.split('/').map(s => encodeURIComponent(s)).join('/');
            let oldContent = '';
            try {
              const { data: fc } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safePath + '?ref=' + encodeURIComponent(targetBranch), { headers: wHdr, timeout: 10000 });
              oldContent = Buffer.from(fc.content, 'base64').toString('utf-8');
            } catch (e) { if ((e.response || {}).status === 404) oldContent = ''; else throw e; }
            const oldL = oldContent.split('\n'), newL = new_content.split('\n');
            const diffLines = []; let added = 0, removed = 0, changed = 0;
            for (let i = 0; i < Math.max(oldL.length, newL.length); i++) {
              const o = oldL[i], n = newL[i];
              if (o === undefined) { diffLines.push('+ L' + (i+1) + ': ' + String(n).slice(0,120)); added++; }
              else if (n === undefined) { diffLines.push('- L' + (i+1) + ': ' + String(o).slice(0,120)); removed++; }
              else if (o !== n) { diffLines.push('- L'+(i+1)+': '+String(o).slice(0,100)+'\n+ L'+(i+1)+': '+String(n).slice(0,100)); changed++; }
            }
            if (!diffLines.length) return '✅ Tidak ada perubahan — konten file sama persis.';
            const summary = '📋 **Preview diff** `' + owner + '/' + repo + '` → `' + file_path + '` (branch: `' + targetBranch + '`)\n' +
              '> ✅ ' + added + ' baris baru | ✏️ ' + changed + ' diubah | 🗑️ ' + removed + ' dihapus\n' +
              '> ' + oldL.length + ' baris → ' + newL.length + ' baris\n\n';
            const preview = diffLines.slice(0, 40).join('\n');
            const trunc = diffLines.length > 40 ? '\n... (' + (diffLines.length-40) + ' perubahan lainnya)' : '';
            return summary + '```diff\n' + preview + trunc + '\n```\nGunakan writeGitHubFile/editGitHubFile untuk commit jika sudah sesuai.';
          } catch (e) { return '⚠️ Gagal preview diff: ' + e.message; }
        },
      },

        deleteGitHubFile: {
      desc: 'Hapus file dari repository GitHub. Pakai GITHUB_WRITE_TOKEN. Gunakan hanya jika user eksplisit minta hapus file dari repo.',
      timeout: 20000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_url:       { type: 'STRING', description: 'URL repo GitHub. Contoh: https://github.com/owner/repo' },
          file_path:      { type: 'STRING', description: 'Path file yang dihapus. Contoh: old-script.js' },
          commit_message: { type: 'STRING', description: 'Pesan commit hapus. Contoh: "chore: remove deprecated file"' },
          branch:         { type: 'STRING', description: 'Branch target (opsional)' },
        },
        required: ['repo_url', 'file_path'],
      },
      async fn({ repo_url, file_path, commit_message, branch }) {
        const WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN;
        if (!WRITE_TOKEN) return 'GITHUB_WRITE_TOKEN belum di-set.';
        const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
        if (!ghMatch) return 'URL GitHub tidak valid.';
        if (/[?#]/.test(file_path)) return '⚠️ file_path tidak boleh mengandung ? atau # — cek path yang dikirim.';
        function safeGHPath(p) { return p.split('/').map(seg => encodeURIComponent(seg)).join('/'); }
        const owner = ghMatch[1], repo = ghMatch[2].replace(/\.git$/, '');
        const wHdr = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + WRITE_TOKEN, 'User-Agent': 'BP-AI-Bot/1.0', 'X-GitHub-Api-Version': '2022-11-28' };
        let targetBranch = branch || '';
        if (!targetBranch) {
          try { const { data: ri } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo, { headers: wHdr, timeout: 8000 }); targetBranch = ri.default_branch || 'main'; }
          catch (branchErr) {
          const branchStatus = branchErr.response?.status;
          if (branchStatus === 404) return '⚠️ Repository tidak ditemukan atau tidak bisa diakses dengan GITHUB_WRITE_TOKEN ini.';
          if (branchStatus === 401 || branchStatus === 403) return '⚠️ GITHUB_WRITE_TOKEN tidak punya akses ke repo ini.';
          targetBranch = 'main'; // fallback jika error jaringan
        }
        }
        let fileSha;
        try {
          const { data: fd } = await axios.get('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safeGHPath(file_path) + '?ref=' + encodeURIComponent(targetBranch), { headers: wHdr, timeout: 10000 });
          fileSha = fd.sha;
        } catch (e) {
          if (e.response?.status === 404) return 'File `' + file_path + '` tidak ditemukan di ' + owner + '/' + repo + '.';
          return 'Gagal baca file: ' + e.message;
        }
        try {
          await axios.delete('https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + safeGHPath(file_path), { headers: wHdr, data: { message: commit_message || 'chore: delete ' + file_path, sha: fileSha, branch: targetBranch }, timeout: 15000 });
          return '\u2705 File `' + file_path + '` berhasil dihapus dari ' + owner + '/' + repo + '.';
        } catch (e) {
          if (e.response?.status === 401 || e.response?.status === 403) return 'GITHUB_WRITE_TOKEN tidak punya izin hapus file.';
          return 'Gagal hapus file: ' + e.message;
        }
      },
    },


    // ─── Search Code di GitHub (seperti ripgrep) ──────────────────────────────
    searchGitHubCode: {
      desc: 'Cari pattern/teks/nama fungsi di seluruh file repo GitHub (seperti grep/ripgrep). Gunakan untuk: menemukan definisi fungsi, mencari variabel, lacak dari mana error berasal, cari semua penggunaan suatu fungsi.',
      timeout: 25000,
      maxOutput: 15000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_url:     { type: 'STRING', description: 'URL repositori GitHub. Contoh: https://github.com/user/repo' },
          query:        { type: 'STRING', description: 'Teks/pattern yang dicari. Contoh: "handleGitHubEdit", "OWNER_ID", "async function"' },
          file_pattern: { type: 'STRING', description: 'Filter path/ekstensi (opsional). Contoh: ".js", "lib/", "src/"' },
          branch:       { type: 'STRING', description: 'Branch yang dicari (opsional). Default: branch utama' },
        },
        required: ['repo_url', 'query'],
      },
      async fn({ repo_url, query, file_pattern, branch }) {
        const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
        if (!ghMatch) return 'URL GitHub tidak valid.';
        const owner = ghMatch[1], repo = ghMatch[2].replace(/\.git$/, '');
        const ghPat = process.env.GITHUB_WRITE_TOKEN;
        const headers = { 'User-Agent': 'BP-AI-Bot/1.0', 'Accept': 'application/vnd.github+json' };
        if (ghPat) headers['Authorization'] = 'Bearer ' + ghPat;
        const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo;

        try {
          // Ambil semua file via git tree, lalu grep secara lokal (GitHub Search API butuh indexed & rate-limited)
          const { data: repoInfo } = await axios.get(apiBase, { headers, timeout: 8000 });
          const activeBranch = branch || repoInfo.default_branch;
          const { data: treeData } = await axios.get(apiBase + '/git/trees/' + activeBranch + '?recursive=1', { headers, timeout: 10000 });
          const SKIP = /node_modules|\/dist\/|\/build\/|\.min\.js|\.map$|package-lock|\.lock$|yarn\.lock/i;
          const CODE_EXT = /\.(js|ts|jsx|tsx|py|sol|go|rs|java|rb|php|json|yaml|yml|toml|md|txt|sh|env\.example)$/i;
          let candidates = (treeData.tree || [])
            .filter(f => f.type === 'blob' && CODE_EXT.test(f.path) && !SKIP.test(f.path) && f.size < 150000);
          if (file_pattern) candidates = candidates.filter(f => f.path.includes(file_pattern));
          // Baca paralel maks 15 file untuk grep
          const toSearch = candidates.slice(0, 15);
          const results = [];
          const fileContents = await Promise.all(toSearch.map(async f => {
            try {
              const { data: fd } = await axios.get(apiBase + '/contents/' + f.path + '?ref=' + encodeURIComponent(activeBranch), { headers, timeout: 8000 });
              if (fd.encoding !== 'base64') return null;
              return { path: f.path, content: Buffer.from(fd.content, 'base64').toString('utf8') };
            } catch (_) { return null; }
          }));
          const queryLower = query.toLowerCase();
          let totalMatches = 0;
          for (const fc of fileContents) {
            if (!fc) continue;
            const lines = fc.content.split('\n');
            const matches = [];
            lines.forEach((line, i) => {
              if (line.toLowerCase().includes(queryLower)) {
                matches.push('  ' + (i + 1) + ' | ' + line.trimEnd());
              }
            });
            if (matches.length) {
              results.push('**' + fc.path + '** (' + matches.length + ' baris):');
              matches.slice(0, 15).forEach(m => results.push(m));
              if (matches.length > 15) results.push('  ... dan ' + (matches.length - 15) + ' baris lagi');
              results.push('');
              totalMatches += matches.length;
            }
          }
          if (!results.length) return 'Tidak ada hasil untuk "' + query + '"' + (file_pattern ? ' di path "' + file_pattern + '"' : '') + ' di repo ' + owner + '/' + repo + '.';
          return ['**Pencarian "' + query + '" di ' + owner + '/' + repo + '** (' + totalMatches + ' hasil di ' + toSearch.length + ' file diperiksa):', ''].concat(results).join('\n');
        } catch (e) {
          const st = e.response?.status;
          if (st === 404) return 'Repo tidak ditemukan atau tidak bisa diakses.';
          return 'Gagal search: ' + e.message;
        }
      },
    },

    // ─── Baca File GitHub dengan Range Baris (seperti ReadFile Replit) ─────────
    readGitHubFileLines: {
      desc: 'Baca file GitHub dengan range baris spesifik — seperti ReadFile Replit. Gunakan untuk: baca bagian tertentu file besar, lihat satu fungsi spesifik, atau drill down setelah readGitHubRepo/searchGitHubCode.',
      timeout: 15000,
      maxOutput: 50000,
      params: {
        type: 'OBJECT',
        properties: {
          repo_url:   { type: 'STRING', description: 'URL repositori GitHub. Contoh: https://github.com/user/repo' },
          file_path:  { type: 'STRING', description: 'Path file. Contoh: src/index.js, lib/agent.js' },
          start_line: { type: 'STRING', description: 'Baris mulai (1-based). Negatif = dari akhir (misal -50 = 50 baris terakhir). Opsional.' },
          end_line:   { type: 'STRING', description: 'Baris akhir inklusif. Opsional — kosong = sampai akhir file.' },
          branch:     { type: 'STRING', description: 'Branch (opsional). Default: branch utama repo.' },
        },
        required: ['repo_url', 'file_path'],
      },
      async fn({ repo_url, file_path, start_line, end_line, branch }) {
        const ghMatch = (repo_url || '').match(/github\.com\/([^\/]+)\/([^\/\s?#]+)/);
        if (!ghMatch) return 'URL GitHub tidak valid.';
        const owner = ghMatch[1], repo = ghMatch[2].replace(/\.git$/, '');
        const ghPat = process.env.GITHUB_WRITE_TOKEN;
        const headers = { 'User-Agent': 'BP-AI-Bot/1.0', 'Accept': 'application/vnd.github+json' };
        if (ghPat) headers['Authorization'] = 'Bearer ' + ghPat;
        const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo;
        try {
          let targetBranch = branch || '';
          if (!targetBranch) {
            const { data: ri } = await axios.get(apiBase, { headers, timeout: 8000 });
            targetBranch = ri.default_branch;
          }
          const { data: fd } = await axios.get(apiBase + '/contents/' + file_path + '?ref=' + encodeURIComponent(targetBranch), { headers, timeout: 10000 });
          if (fd.encoding !== 'base64') return 'File tidak bisa dibaca (binary atau terlalu besar — coba file_path lebih spesifik).';
          const content = Buffer.from(fd.content, 'base64').toString('utf8');
          const allLines = content.split('\n');
          const total = allLines.length;
          // Parse range
          let s = start_line ? parseInt(start_line) : 1;
          let e2 = end_line   ? parseInt(end_line)   : total;
          if (s < 0) s  = Math.max(1, total + s + 1);
          if (e2 < 0) e2 = total + e2 + 1;
          s  = Math.max(1, Math.min(s,  total));
          e2 = Math.max(s, Math.min(e2, total));
          const selected = allLines.slice(s - 1, e2);
          const ext = file_path.split('.').pop() || '';
          const out = [
            '**File:** `' + file_path + '` (' + total + ' baris total, branch: ' + targetBranch + ')',
            '**Menampilkan baris ' + s + '–' + e2 + '** dari ' + total + (e2 < total ? ' — gunakan readGitHubFileLines lagi untuk lanjut' : ''),
            '```' + ext,
            ...selected.map((l, i) => (s + i) + ' | ' + l),
            '```',
          ];
          return out.join('\n');
        } catch (err) {
          const st = err.response?.status;
          if (st === 404) return 'File "' + file_path + '" tidak ditemukan di ' + owner + '/' + repo + '.';
          return 'Gagal baca file: ' + err.message;
        }
      },
    },

    };


    // ─── Execute Tool ─────────────────────────────────────────────────────────────

    async function executeTool(name, args, userId) {
    const tool = TOOLS[name];
    if (!tool) return 'Error: tool "' + name + '" tidak dikenal.';
    try {
      const result = await Promise.race([
        tool.fn(args || {}, { userId: userId || 'default' }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), tool.timeout || TOOL_TIMEOUT)),
      ]);
      return String(result).slice(0, tool.maxOutput || 8000);
    } catch (e) {
      console.error('[agent] tool "' + name + '" error:', e.message);
      // [FIX] Sebelumnya pesan error ('Error ' + name + ': ' + e.message) dikirim sebagai
      // tool result BIASA ke LLM (via functionResponse/tool message) — tidak ada penanda
      // eksplisit bahwa operasi GAGAL, sehingga model kadang menganggapnya sebagai output
      // normal dan melanjutkan seolah tool berhasil (mis. mengira file sudah ditulis
      // padahal writeFile timeout). Sekarang pesan dibuat eksplisit sebagai kegagalan.
      return '❌ TOOL_ERROR: Tool "' + name + '" GAGAL dieksekusi — ' + e.message + '. Anggap operasi ini TIDAK berhasil, jangan lanjutkan seolah-olah berhasil.';
    }
    }

    // ─── Schema helpers ───────────────────────────────────────────────────────────

    // Gemini function declarations — omit `parameters` entirely for tools with no params
    // (empty properties:{} can cause a 400 error on some Gemini API versions)
    // ─── Dynamic Tool Selection ──────────────────────────────────────────────────
    // Kirim hanya tool yang relevan dengan query — hemat token, hindari 413 Groq.

    // Kategori tiap tool
    const TOOL_CATEGORIES = {
      getCryptoPrice: 'crypto', getDexPrice: 'crypto', getBinancePrice: 'crypto',
      getTrendingTokens: 'crypto', getFearGreed: 'crypto', getEthGasPrice: 'crypto',
      getDefiTVL: 'crypto', getBtcFees: 'crypto', analyzeTokenSecurity: 'crypto',
      getWalletPortfolio: 'crypto', getOnchainData: 'crypto', getCryptoRankData: 'crypto',
      getAlchemyOnchain: 'crypto',
      webSearch: 'web', fetchUrl: 'web',
      executeCode: 'coding', writeFile: 'coding', editFile: 'coding', appendFile: 'coding', readFile: 'coding',
      listFiles: 'coding', searchFiles: 'coding', installPackage: 'coding', resetSandbox: 'coding', readGitHubRepo: 'coding', searchGitHubCode: 'coding', readGitHubFileLines: 'coding', createGitHubRepo: 'coding', writeGitHubFile: 'coding', editGitHubFile: 'coding', deleteGitHubFile: 'coding',
    };

    // Deteksi kategori query berdasarkan kata kunci
    function detectCategory(question) {
      if (!question) return ['crypto'];
      const q = question.toLowerCase();
      const isCrypto = /harga|price|token|coin|crypto|wallet|defi|dex|gas fee|tvl|fee|blockchain|on.?chain|trending|market.?cap|chart|btc|eth|sol|bnb|base chain|arbitrum|trading|candle|rsi|macd|pump|dump|liquidity|smart.?money|token.?scan|contract|address|0x[0-9a-f]/.test(q);
      // [FIX #7] Tambah kata kunci Indonesia yang umum dipakai: benerin, perbaiki, cek error, dll
      const isGitHub = /github\.com\/[^\s]+\/[^\s]+/.test(question) || /\brepo\b|repository|github|gitlab/.test(q);
      const isCoding = isGitHub || /\bkode\b|\bcode\b|script|\bprogram\b|\bdebug\b|\berror\b|fungsi|\bfunction\b|\bclass\b|python|javascript|node\.?js|bash|typescript|\bjava\b|\binstall\b|\bpip\b|\bnpm\b|jalankan kode|run code|execute|compile|\blibrary\b|\bmodule\b|\bimport\b|deploy.?server|database|sql|html|css|perbaiki|benerin|cek error|fixing|refactor|algoritma|variabel|syntax|bug|loop|array|object|endpoint|api route|dockerfile|env file|package\.json|buatkan.{0,20}(program|skrip|kode|bot|api|server|tool)|otomasi|automasi|webhook|crawler|scraper|parser|generator|converter|validator|cron|pipeline|\bcsv\b|\bexcel\b|\bpdf\b|\bjson\b|\bxml\b|\bregex\b/.test(q) || q.includes('```');
      const isWeb = /\bbrowse\b|buka web|buka url|buka halaman|buka link|baca web|baca url|baca halaman|baca link|baca dok|cari di web|search web|search internet|cari di internet|cara pakai|cara penggunaan|dokumentasi|api doc|api ref|how to use|tutorial|referensi|\breference\b|https?:\/\//.test(q);
      const cats = [];
      if (isCrypto) cats.push('crypto');
      if (isCoding) cats.push('coding');
      if (isWeb) cats.push('web');
      // [FIX] Fallback: jika tidak ada kata kunci terdeteksi, aktifkan semua tools.
      // Mencegah tools hilang saat user pakai kalimat pendek/ambigu ("benerin yang tadi", "lanjut", dll).
      if (cats.length === 0) { cats.push('crypto'); cats.push('coding'); cats.push('web'); }
      return cats;
    }

    // Build OAI tool defs hanya untuk kategori yang relevan
    function buildOAIDefs(cats) {
      return Object.entries(TOOLS)
        .filter(([name]) => cats.includes(TOOL_CATEGORIES[name] || 'crypto'))
        .map(([name, t]) => ({
          type: 'function',
          function: {
            name,
            description: t.desc,
            parameters: {
              type: 'object',
              properties: Object.fromEntries(
                Object.entries(t.params.properties || {}).map(([k, v]) => [
                  k, { type: (v.type || 'STRING').toLowerCase(), description: v.description },
                ])
              ),
              required: t.params.required || [],
            },
          },
        }));
    }

    // Build Gemini tool defs hanya untuk kategori yang relevan
    function buildGeminiDefs(cats) {
      const decls = Object.entries(TOOLS)
        .filter(([name]) => cats.includes(TOOL_CATEGORIES[name] || 'crypto'))
        .map(([name, t]) => {
          const hasProps = Object.keys(t.params.properties || {}).length > 0;
          const decl = { name, description: t.desc };
          if (hasProps) {
            decl.parameters = {
              type: t.params.type,
              properties: t.params.properties,
              ...(t.params.required?.length ? { required: t.params.required } : {}),
            };
          }
          return decl;
        });
      return [{ function_declarations: decls }];
    }

    // ─── Gemini Agent ─────────────────────────────────────────────────────────────

    async function runGeminiAgent(question, history, systemPrompt, onToolCall, overrideSystemPrompt, toolCache = new Map(), userId = null) {
    if (overrideSystemPrompt) systemPrompt = overrideSystemPrompt;
    if (!GEMINI_KEYS.length) throw new Error('no Gemini keys');
    const models = (Array.isArray(TEXT_MODELS) && TEXT_MODELS.length) ? TEXT_MODELS : ['gemini-2.0-flash'];
    const nK = GEMINI_KEYS.length, nM = models.length, total = nK * nM;
    const startSlot = _agentPickStart('gemini', nK, nM);
    let lastErr;

    for (let attempt = 0; attempt < total; attempt++) {
      const slot = (startSlot + attempt) % total;
      const ki = Math.floor(slot / nM), mi = slot % nM;
      const key = GEMINI_KEYS[ki], model = models[mi];
      if (_aIsRL('gemini', ki, model)) continue;

      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
      const _gemHist = _trimHistoryForAgent(history, systemPrompt, question, AGENT_TOKEN_LIMITS.gemini);
      if (_gemHist.length < history.length) {
        console.log(`[agent/gemini] ⚠️ History dipotong ${(history.length - _gemHist.length) / 2} pasang (Gemini token limit)`);
      }
      const safe = sanitizeHistoryForGemini(_gemHist);
      const contents = [
        ...safe.map(h => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content || '' }] })),
        { role: 'user', parts: [{ text: question }] },
      ];
      console.log('[agent/gemini] coba key#' + ki + ' model=' + model);
      try {
        for (let iter = 0; iter < MAX_ITER; iter++) {
          const { data } = await axios.post(url, {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            ...(() => {
              const _gc = detectCategory(question);
              const _gd = buildGeminiDefs(_gc);
              if (!_gc.length) return {}; // pesan biasa — skip tools
              return {
                tools: _gd,
                tool_config: { function_calling_config: {
                  // Paksa panggil tool ('ANY') hanya di iterasi pertama agar model ambil data
                  // real-time. Iterasi berikutnya pakai 'AUTO' — kalau Gemini sudah punya cukup
                  // data dari tool call sebelumnya, biarkan ia menjawab langsung alih-alih
                  // dipaksa memanggil tool lagi (sebelumnya ini menyebabkan getOnchainData
                  // dipanggil berulang 6x untuk query yang sama sampai loop iterasi habis).
                  // 'AUTO' di semua iterasi — model memilih sendiri apakah perlu call tool.
                  // 'ANY' sebelumnya memaksa tool call di iter 0 untuk kategori crypto, tapi
                  // jika tidak ada tool yang cocok model akan loop sampai MAX_ITER lalu throw.
                  mode: 'AUTO',
                } },
              };
            })(),
            generationConfig: { maxOutputTokens: 8192 },
          }, { timeout: 90000 });

          const candidate = data?.candidates?.[0];
          if (!candidate) throw new Error('Gemini response kosong');
          const parts   = candidate.content?.parts || [];
          const fnCalls = parts.filter(p => p.functionCall);
          const texts   = parts.filter(p => p.text && p.text.trim());

          if (!fnCalls.length) {
            _agentCursor.gemini = (slot + 1) % total; // round-robin
            console.log('[agent/gemini] ✅ selesai key#' + ki + ' model=' + model);
            return stripThinkTags(texts.map(p => p.text).join('\n').trim());
          }
          contents.push({ role: 'model', parts });
          const toolResults = await Promise.all(fnCalls.map(async fc => {
            const { name, args } = fc.functionCall;
            if (onToolCall) await onToolCall(name, args).catch(() => {});
            const _gck = name + '::' + JSON.stringify(args || {});
            let result;
            if (toolCache.has(_gck)) {
              console.log('[agent/gemini] \u2713 cache: ' + name + ' (hemat API call)');
              result = toolCache.get(_gck);
            } else {
              console.log('[agent/gemini] \u2192 ' + name + '(' + JSON.stringify(args || {}).slice(0, 80) + ')');
              result = await executeTool(name, args || {}, userId);
              toolCache.set(_gck, result);
            }
            return { functionResponse: { name, response: { content: result } } };
          }));
          contents.push({ role: 'user', parts: toolResults });
        }
        throw new Error('Agent loop melebihi batas iterasi');
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        if (AGENT_RETRYABLE.has(status)) {
          _aMarkRL('gemini', ki, model);
          _agentCursor.gemini = (slot + 1) % total;
        }
        console.log('[agent/gemini] key#' + ki + ' model=' + model + ' gagal (' + (status || e.code || (e.message||'').slice(0,40)) + '), coba berikutnya...');
      }
    }
    throw lastErr || new Error('Semua key/model Gemini habis di agent');
    }

    // ─── OpenAI / Groq Agent ──────────────────────────────────────────────────────

    // provider = 'groq' | 'openai' (dipakai sebagai key untuk _agentCursor)
    // toolCache dibagikan antar semua percobaan key/model dalam satu runAgent call.
    async function runOAIAgent(provider, apiUrl, keys, models, question, history, systemPrompt, onToolCall, overrideSystemPrompt, isDMOwner, toolCache = new Map(), userId = null) {
    if (overrideSystemPrompt) systemPrompt = overrideSystemPrompt;
    if (!keys.length) throw new Error('no keys');
    if (!models.length) throw new Error(`[agent/${provider}] tidak ada model dikonfigurasi. Set ${provider.toUpperCase()}_MODELS di Railway.`);
    const nK = keys.length, nM = models.length, total = nK * nM;
    const startSlot = _agentPickStart(provider, nK, nM);
    let lastErr;

    // Base messages dibangun SEKALI dan dibagikan antar semua percobaan key/model.
    // Trim history agar payload HTTP tidak melebihi batas token provider (cegah 413).
    const _tokenLimit = AGENT_TOKEN_LIMITS[provider] || AGENT_TOKEN_LIMITS.groq;
    const _safeHist = _trimHistoryForAgent(history, systemPrompt, question, _tokenLimit);
    if (_safeHist.length < history.length) {
      console.log(`[agent/${provider}] ⚠️ History dipotong ${(history.length - _safeHist.length) / 2} pasang agar muat token (${_tokenLimit} tok)`);
    }
    // Atomesus tidak support system role — gabungkan system prompt ke pesan user pertama
    // agar instruksi & kepribadian bot tetap terbaca meski role 'system' tidak didukung.
    const _atomesusSystemPrefix = systemPrompt
      ? '[Instruksi sistem: ' + systemPrompt.slice(0, 500) + ']\n\n'
      : '';
    const _oaiBaseMessages = provider === 'atomesus'
      ? [
          ..._safeHist
            .filter(h => h.role === 'assistant' || h.role === 'user')
            .map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content || '' })),
          { role: 'user', content: _atomesusSystemPrefix + question },
        ]
      : [
          { role: 'system', content: systemPrompt },
          ..._safeHist.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content || '' })),
          { role: 'user', content: question },
        ];
    let _oaiAccMessages = _oaiBaseMessages; // tumbuh seiring tool calls
    let _oaiToolsExecuted = false;
    const _504retries = new Map(); // slot → jumlah retry 504 yang sudah dilakukan
    const MAX_504_RETRY = 1;      // maks 1 retry per slot — 3s overhead lalu langsung fallback ke provider lain
    const _oaiTruncRetried = new Set(); // slot yang sudah di-retry sekali dengan tool results dipotong (413)

    // [FIX #3] Batas atas: tiap slot bisa dikunjungi 1x normal + maks 1x retry-504 +
    // maks 1x retry-truncate-413 sebelum menyerah, jadi cap dihitung deterministik dari
    // `total` (bukan dari ukuran _504retries/_oaiTruncRetried yang baru terisi saat runtime).
    const MAX_ATTEMPTS = total * (1 + MAX_504_RETRY + 1);
    for (let attempt = 0; attempt < Math.max(total + MAX_504_RETRY, MAX_ATTEMPTS); attempt++) {
      const slot = (startSlot + attempt) % total;
      const ki = Math.floor(slot / nM), mi = slot % nM;
      const key = keys[ki], model = models[mi];
      if (_aIsRL(provider, ki, model)) continue;

      // Lanjutkan dari accMessages jika tools sudah pernah dieksekusi; otherwise mulai segar.
      const messages = (_oaiToolsExecuted && _oaiAccMessages.length) ? [..._oaiAccMessages] : [..._oaiBaseMessages];
      console.log('[agent/' + provider + '] coba key#' + ki + ' model=' + model + (_oaiToolsExecuted ? ' (resume setelah tool)' : ''));
      try {
        for (let iter = 0; iter < MAX_ITER; iter++) {
          const _cats = provider === 'atomesus' ? [] : detectCategory(question);
          const _tools = buildOAIDefs(_cats);
          const { data } = await axios.post(apiUrl, {
            model, messages,
            // Kirim tools HANYA jika pesan butuh data real-time (crypto/coding)
            // Pesan percakapan biasa atau Atomesus: skip tools agar payload tidak 413
            ...(_tools.length ? {
              tools: _tools,
              tool_choice: (iter === 0 && !_oaiToolsExecuted && !_cats.includes('coding')) ? 'required' : 'auto',
            } : {}),
            // max_tokens WAJIB untuk Atomesus — tanpa ini model generate tak terbatas → kena 60s upstream timeout → 504
            max_tokens: provider === 'atomesus' ? 1024 : 8192,
          }, {
            timeout: 90000,
            headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          });

          const msg = data?.choices?.[0]?.message;
          if (!msg) throw new Error('Response kosong');
          messages.push(msg);
          if (!msg.tool_calls?.length) {
            _agentCursor[provider] = (slot + 1) % total; // round-robin
            if (provider === 'atomesus') { _atomesusConsecFails.count = 0; } // reset circuit breaker
            console.log('[agent/' + provider + '] ✅ selesai key#' + ki + ' model=' + model);
            return stripThinkTags(msg.content) || '';
          }
          await Promise.all(msg.tool_calls.map(async tc => {
            const name = tc.function.name;
            let args = {};
            try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
            if (onToolCall) await onToolCall(name, args).catch(() => {});
            const _ck = name + '::' + JSON.stringify(args);
            let result;
            if (toolCache.has(_ck)) {
              console.log('[agent/' + provider + '] \u2713 cache: ' + name + ' (hemat API call)');
              result = toolCache.get(_ck);
            } else {
              console.log('[agent/' + provider + '] \u2192 ' + name + '(' + JSON.stringify(args).slice(0, 80) + ')');
              result = await executeTool(name, args, userId);
              toolCache.set(_ck, result);
            }
            messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }));
          // Simpan state — percobaan berikutnya resume dari sini tanpa re-call tools.
          _oaiAccMessages = [...messages];
          _oaiToolsExecuted = true;
        }
        throw new Error('Agent loop melebihi batas iterasi');
      } catch (e) {
        lastErr = e;
        const status = e.response?.status;
        if (status === 413 && _oaiToolsExecuted && !_oaiTruncRetried.has(slot)) {
          // 413 SETELAH tool results (payload besar) — ini masalah UKURAN REQUEST INI,
          // bukan model itu sendiri, jadi JANGAN blokir model. Potong tool results dan
          // retry slot yang SAMA sekali sebelum menyerah ke slot berikutnya.
          const LIMIT = 800;
          // [FIX] Pangkas head+tail, bukan cuma buang ekor — bagian akhir tool result
          // (mis. baris error/traceback paling bawah, hasil akhir command) sering lebih
          // penting daripada bagian tengah, jadi disimpan sebagian juga.
          _oaiAccMessages = _oaiAccMessages.map(m => {
            if (m.role !== 'tool' || typeof m.content !== 'string' || m.content.length <= LIMIT) return m;
            const headLen = Math.ceil(LIMIT * 0.7);
            const tailLen = LIMIT - headLen;
            const head = m.content.slice(0, headLen);
            const tail = m.content.slice(-tailLen);
            return { ...m, content: `${head}\n...[bagian tengah dipotong agar muat token]...\n${tail}` };
          });
          _oaiTruncRetried.add(slot);
          console.log('[agent/' + provider + '] 413 setelah tool — hasil dipotong, retry slot yang sama (bukan blokir model)');
          attempt--; // ulangi slot yang sama dengan payload yang sudah dipotong
        } else if (status === 413 || status === 400) {
          // 413 tanpa tool (prompt dasar + history sudah kepanjangan) atau 400 (format tidak
          // didukung model ini) — kemungkinan besar bergantung pada UKURAN REQUEST ini, bukan
          // cacat permanen model, jadi blokir SEBENTAR saja (bukan 2 jam) agar model tidak
          // "hilang" seharian untuk pertanyaan-pertanyaan berikutnya yang lebih kecil.
          const _ttl = status === 400 ? 2 * 3600_000 : 10 * 60_000; // 400=format salah (2j), 413=ukuran (10mnt)
          _agentRL.set(provider + '::' + ki + '::' + model, Date.now() + _ttl);
          console.log('[agent/' + provider + '] key#' + ki + ' model=' + model + ' status ' + status + ' (blokir ' + Math.round(_ttl / 60000) + ' menit).');
        } else if (AGENT_RETRYABLE.has(status)) {
          // 504 = upstream timeout (transient) → cooldown pendek; 429/500/503 → cooldown panjang
          if (status === 504) {
            const _n504 = (_504retries.get(slot) || 0) + 1;
            _504retries.set(slot, _n504);
            if (_n504 <= MAX_504_RETRY) {
              // Retry slot yang sama setelah sleep — decrement attempt agar loop tetap di slot ini
              console.log('[agent/' + provider + '] ⏳ 504 upstream timeout — retry #' + _n504 + '/' + MAX_504_RETRY + ' dalam ' + (AGENT_RL_504_MS/1000) + 's...');
              await new Promise(r => setTimeout(r, AGENT_RL_504_MS));
              attempt--; // ulangi slot yang sama
            } else {
              // Habis jatah retry 504 — lanjut ke slot berikutnya
              _agentRL.set(provider + '::'+ ki +'::'+ model, Date.now() + AGENT_RL_504_MS);
              _agentCursor[provider] = (slot + 1) % total;
              console.log('[agent/' + provider + '] ❌ 504 habis ' + MAX_504_RETRY + 'x retry, skip slot');
              // Update circuit breaker
              if (provider === 'atomesus') { _atomesusConsecFails.count++; _atomesusConsecFails.lastFail = Date.now(); }
            }
          } else {
            _aMarkRL(provider, ki, model);
            _agentCursor[provider] = (slot + 1) % total;
          }
        }
        console.log('[agent/' + provider + '] key#' + ki + ' model=' + model + ' gagal (' + (status || e.code || (e.message||'').slice(0,40)) + '), coba berikutnya...');
      }
    }
    throw lastErr || new Error('Semua key/model ' + provider + ' habis di agent');
    }

    // ─── Main runAgent ────────────────────────────────────────────────────────────

    const AGENT_ADDENDUM = '\n\n--- AGENT MODE: WAJIB PAKAI TOOLS ---\n' +
    '\u26a0\ufe0f ATURAN KERAS: DILARANG menjawab data harga, gas, token, TVL, trending, atau analisis on-chain\n' +
    'dari pengetahuan training. Data training KEDALUWARSA. SELALU ambil data real-time via tools dulu.\n\n' +
    'Tools yang tersedia:\n' +
    '\u2022 getCryptoPrice \u2192 harga & market cap CoinGecko (BTC, ETH, SOL, dan coin besar)\n' +
    '\u2022 getBinancePrice \u2192 harga spot Binance real-time (contoh: BTCUSDT, ETHUSDT)\n' +
    '\u2022 getDexPrice \u2192 harga dari DEX (altcoin/memecoin kecil, bisa pakai contract address)\n' +
    '\u2022 getOnchainData \u2192 data on-chain GMGN: info token Sol/EVM, smart money, trending per chain\n' +
    '\u2022 getTrendingTokens \u2192 token trending CoinGecko hari ini\n' +
    '\u2022 getFearGreed \u2192 sentimen pasar (Fear & Greed Index real-time)\n' +
    '\u2022 getEthGasPrice \u2192 biaya gas Ethereum (Slow/Standard/Fast Gwei)\n' +
    '\u2022 getBtcFees \u2192 biaya transaksi Bitcoin mempool real-time\n' +
    '\u2022 getDefiTVL \u2192 Total Value Locked protocol DeFi dari DefiLlama\n' +
    '\u2022 analyzeTokenSecurity \u2192 audit keamanan token EVM SAJA (CA harus 0x + 40 hex, BUKAN Solana/base58) \u2014 honeypot, rug, LP lock\n' +
    '\u2022 getWalletPortfolio \u2192 semua aset wallet EVM via Zerion\n' +
    '\nSTRATEGI (wajib diikuti):\n' +
    '- Harga coin mainstream (BTC/ETH/SOL dll): getCryptoPrice ATAU getBinancePrice\n' +
    '- Token kecil/memecoin: getDexPrice atau getOnchainData\n' +
    '- Token Solana/Base kecil: getOnchainData lalu getDexPrice sebagai pelengkap\n' +
    '- Analisis token EVM (CA 0x + tepat 40 hex char, BUKAN Solana): analyzeTokenSecurity\n' +
    '- Sentimen pasar: getFearGreed + getTrendingTokens\n' +
    '- Token fundamental (ATH/ATL/supply/kategori): getCryptoRankData\n' +
    '- On-chain Base Network (ETH balance, token holdings, blok): getAlchemyOnchain\n' +
    '- Portfolio wallet multi-chain: getWalletPortfolio (Zerion)\n' +
    '- Token security/rug check: analyzeTokenSecurity\n' +
    '- Gas fee ETH: getEthGasPrice\n' +
    '- BTC mempool fee: getBtcFees\n' +
    '- DeFi TVL protocol: getDefiTVL\n' +
    '- On-chain GMGN (Solana/EVM trending, smart money, wallet): getOnchainData\n' +
    '- WAJIB gunakan tools untuk semua pertanyaan crypto/web3/onchain.\n' +
    '- Untuk memecoin/altcoin kecil: getDexPrice + getOnchainData + getCryptoRankData paralel.\n' +
    '- Panggil beberapa tools SEKALIGUS (parallel) jika saling melengkapi.\n' +
    'Format jawaban akhir sesuai Discord (tanpa tabel pipe, tanpa HTML).\n' +
    '- Buat repository GitHub baru: WAJIB panggil createGitHubRepo — JANGAN kasih panduan manual (git init, UI GitHub, dll)\n' +
    '- Edit/tulis/commit file ke GitHub repo: WAJIB panggil writeGitHubFile — JANGAN beri tutorial git/CLI\n' +
    '- Hapus file dari GitHub repo: WAJIB panggil deleteGitHubFile\n' +
    '\n🖥️ CODING AGENT TOOLS (E2B Sandbox):\n' +
    '• executeCode → jalankan kode Python/JS/Bash/TypeScript/dll dalam sandbox aman\n' +
    '• writeFile → tulis file ke sandbox (file baru / overwrite total)\n' +
    '• editFile → edit sebagian file sandbox dengan old_string→new_string (LEBIH AMAN untuk file besar)\n' +
    '• readFile → baca isi file dari sandbox\n' +
    '• listFiles → lihat daftar file/folder di sandbox\n' +
    '• installPackage → install pip/npm/apt package\n' +
    '• readGitHubRepo → baca repo GitHub (file tree + isi kode) untuk review/debug/bug-check. Repo publik: selalu bisa. Repo private: butuh GITHUB_WRITE_TOKEN dengan scope repo.\n' +
    '\u2022 writeGitHubFile \u2192 tulis/update file di GitHub repo (GITHUB_WRITE_TOKEN). Buat file baru atau overwrite file ada.\n' +
    '\u2022 deleteGitHubFile \u2192 hapus file dari GitHub repo (GITHUB_WRITE_TOKEN).\n' +
    '\u2022 createGitHubRepo \u2192 buat repo GitHub baru (GITHUB_WRITE_TOKEN).\n' +
    '\n\u26A0\uFE0F GITHUB WRITE RULES:\n' +
    '- writeGitHubFile/editGitHubFile/deleteGitHubFile/createGitHubRepo pakai GITHUB_WRITE_TOKEN (BUKAN GITHUB_TOKEN)\n' +
    '- WAJIB: Selalu readGitHubRepo atau readGitHubFileLines SEBELUM menulis/mengedit file GitHub apapun\n' +
    '- Untuk perubahan parsial: PAKAI editGitHubFile (bukan writeGitHubFile) — lebih aman, tidak merusak kode lain\n' +
    '- content di writeGitHubFile = FULL file content (bukan diff/patch)\n' +
    '- Jangan pernah menimpa file besar dengan writeGitHubFile jika hanya mengubah beberapa baris\n' +
    '\nCODING AGENT RULES (ikuti persis):\n' +
    '\n0. PLANNING WAJIB untuk task kompleks:\n' +
    '   Sebelum mulai task yang menyentuh >2 file, refaktor besar, atau arsitektur baru:\n' +
    '   - Tulis plan singkat: file apa yang diubah, urutan langkah, risiko\n' +
    '   - Format: "Rencana: (1) baca X, (2) edit Y di bagian Z, (3) verifikasi output"\n' +
    '   - Baru eksekusi step by step sesuai plan\n' +
    '1. WAJIB executeCode untuk verifikasi — jangan pernah tebak output.\n' +
    '2. ALUR STANDAR:\n' +
    '   a) Rencanakan file yang dibutuhkan (tulis plan jika >2 file)\n' +
    '   b) installPackage jika perlu library (SEBELUM executeCode)\n' +
    '   c) writeFile untuk file baru, editFile untuk edit parsial file yang ada\n' +
    '   d) Verifikasi sintaks: executeCode bash node --check / python3 -m py_compile\n' +
    '   e) executeCode → lihat output\n' +
    '   f) Error? Baca traceback → identifikasi baris → perbaiki → executeCode lagi\n' +
    '   g) Ulangi sampai berhasil (maks 12 iterasi)\n' +
    '3. ATURAN EDIT FILE WAJIB (sandbox):\n' +
    '   - SELALU readFile sebelum writeFile/editFile untuk tahu isi file saat ini\n' +
    '   - Untuk perubahan kecil/parsial: WAJIB gunakan editFile (lebih aman, hemat token)\n' +
    '   - Untuk file baru atau overwrite total: gunakan writeFile\n' +
    '   - Setelah edit: readFile lagi untuk verifikasi hasilnya benar\n' +
    '4. DEBUGGING TOOLS YANG TERSEDIA:\n' +
    '   - searchFiles(pattern): grep cari fungsi/error di semua file sandbox\n' +
    '   - readFile(path): cek isi file, audit kode yang sudah ditulis\n' +
    '   - listFiles(path): lihat struktur folder, konfirmasi file terbuat\n' +
    '   - appendFile(path, content): tambah ke file tanpa hapus isi lama\n' +
    '   - editFile(path, old_string, new_string): ganti bagian kode tanpa overwrite penuh\n' +
    '5. MULTI-FILE PROJECT:\n' +
    '   - writeFile semua file (main, config, utils) → test tiap bagian → gabungkan\n' +
    '   - Pastikan import path benar sebelum executeCode\n' +
    '6. GITHUB WORKFLOW:\n' +
    '   - WAJIB readGitHubRepo atau readGitHubFileLines SEBELUM edit file GitHub apapun\n' +
    '   - Gunakan previewGitHubDiff untuk menampilkan diff ke user SEBELUM commit perubahan besar\n' +
    '   - Untuk perubahan kecil/parsial: WAJIB gunakan editGitHubFile (lebih aman, tidak merusak kode lain)\n' +
    '   - Untuk file baru atau overwrite total: gunakan writeGitHubFile\n' +
    '   - searchGitHubCode untuk cari fungsi/pattern di seluruh repo tanpa baca semua file\n' +
    '   - readGitHubFileLines untuk baca range baris spesifik (drill down setelah readGitHubRepo)\n' +
    '   - Bisa edit beberapa file berurutan dalam satu sesi\n' +
    '   - commit_message harus deskriptif (feat/fix/refactor: deskripsi)';

    // ── Address Auto-Detection ─────────────────────────────────────────────────
    function b58decode(s) {
      const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      let n = BigInt(0);
      for (const c of s) {
        const d = ALPHA.indexOf(c);
        if (d < 0) return null;
        n = n * 58n + BigInt(d);
      }
      const hex = n.toString(16).padStart(64, '0');
      return hex.length === 64 ? hex : null; // 32 bytes = 64 hex chars
    }
    function detectAddressInMsg(text) {
      // EVM: harus tepat 0x + 40 hex chars
      const evmMatch = text.match(/\b(0x[a-fA-F0-9]{40})\b/);
      if (evmMatch) return { type: 'evm', address: evmMatch[1] };
      // Solana: base58, 32-44 char, lalu validasi decode = 32 bytes
      const candidates = text.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g) || [];
      for (const cand of candidates) {
        if (b58decode(cand) !== null) return { type: 'sol', address: cand };
      }
      return null;
    }

        async function runAgent(question, history = [], isDMOwner = false, onToolCall = null, overrideSystemPrompt = null, userId = null) {
    // DM owner pakai pair-programmer prompt agar lebih dalam dan teknikal
    const basePrompt = isDMOwner ? (SYSTEM_PROMPT_DM || SYSTEM_PROMPT) : SYSTEM_PROMPT;
    const systemPrompt = (basePrompt || '') + AGENT_ADDENDUM;
    let lastErr;
    const toolCache = new Map(); // dibagi ke semua provider — tool tidak dipanggil ulang saat retry

    // Auto-inject address hint agar model selalu memanggil tool yang tepat
    // Guard: hanya aktif jika konteks crypto/token atau pesan singkat (kemungkinan besar CA)
    const CRYPTO_KEYWORDS = /token|analisis|ca\b|contract|address|solana|sol\b|chain|coin|memecoin|defi|swap|dex|mint|wallet|harga|price/i;
    const isCryptoContext = CRYPTO_KEYWORDS.test(question) || question.trim().split(/\s+/).length <= 5;
    const addrDetect = isCryptoContext ? detectAddressInMsg(question) : null;
    let effectiveQuestion = question;
    // Auto-inject GitHub URL hint
    // Ambil URL GitHub LENGKAP dari pertanyaan (termasuk path /blob/main/file.js jika ada)
    const ghUrlMatch = question.match(/https?:\/\/github\.com\/[^\s]+/);
    // [FIX] Juga cek history jika URL GitHub ada di pesan sebelumnya tapi tidak di pesan saat ini
    // Ini memperbaiki kasus: user kirim URL di pesan A, lalu "baca semua kode" di pesan B tanpa URL
    const ghUrlFromHistory = !ghUrlMatch && Array.isArray(history)
      ? (() => {
          for (let i = history.length - 1; i >= 0; i--) {
            const m = (history[i].content || '').match(/https?:\/\/github\.com\/[^\s]+/);
            if (m) return m;
          }
          return null;
        })()
      : null;
    const _ghMatch = ghUrlMatch || ghUrlFromHistory;
    if (_ghMatch) {
      // Bersihkan trailing punctuation (.,!?) yang bukan bagian URL
      const fullGhUrl = _ghMatch[0].replace(/[.,!?)]+$/, '');
      effectiveQuestion = question + [
        '',
        '[INSTRUKSI AGENT: Ada URL GitHub: ' + fullGhUrl,
        'WAJIB panggil readGitHubRepo dengan repo_url = "' + fullGhUrl + '" SEKARANG.',
        'Setelah dapat isi file, analisis kode untuk bug, error, security issues, dan anti-pattern.',
        'Jangan jawab apapun sebelum tool dipanggil dan data diterima.]',
      ].join('\n');
    }

    // Append address hint ke effectiveQuestion (bukan timpa dari question) agar
    // tidak overwrite injeksi GitHub URL yang sudah dilakukan di atas.
    if (addrDetect && addrDetect.type === 'sol') {
      effectiveQuestion += [
        '',
        '[INSTRUKSI AGENT: Ada Solana contract address: ' + addrDetect.address,
        'WAJIB panggil getOnchainData dengan query = "' + addrDetect.address + '" SEKARANG.',
        'Jangan jawab apapun sebelum tool dipanggil dan data diterima.]',
      ].join('\n');
    } else if (addrDetect && addrDetect.type === 'evm') {
      effectiveQuestion += [
        '',
        '[INSTRUKSI AGENT: Ada EVM contract address: ' + addrDetect.address,
        'WAJIB panggil getOnchainData dengan query = "' + addrDetect.address + '" untuk info GMGN.',
        'Juga panggil analyzeTokenSecurity dengan contract_address = "' + addrDetect.address + '" secara paralel.]',
      ].join('\n');
    }

    // Provider loop dinamis — urutan & key bisa diubah via !provider / !setkey Discord
    const _providerOrder = _runtimeOrder || ['conduit', 'groq', 'gemini', 'openai', 'iamhc'];
    for (const _p of _providerOrder) {
      const _pKeys = _getKeys(_p);
      if (!_pKeys.length) continue;
      // Circuit breaker: skip Atomesus sementara kalau sering 504
      if (_p === 'atomesus') {
        const _aSkip = _atomesusConsecFails.count >= ATOMESUS_SKIP_AFTER
                    && (Date.now() - _atomesusConsecFails.lastFail) < ATOMESUS_SKIP_WINDOW;
        if (_aSkip) {
          const _secLeft = Math.round((ATOMESUS_SKIP_WINDOW - (Date.now() - _atomesusConsecFails.lastFail)) / 1000);
          console.log('[agent] atomesus: skip sementara (sudah gagal ' + _atomesusConsecFails.count + 'x, reset dalam ~' + _secLeft + 's)');
          continue;
        }
      }
      try {
        let text;
        if (_p === 'gemini') {
          text = await runGeminiAgent(effectiveQuestion, history, systemPrompt, onToolCall, overrideSystemPrompt, toolCache, userId);
        } else {
          const _pUrl =
            _p === 'groq'     ? 'https://api.groq.com/openai/v1/chat/completions'
          : _p === 'openai'   ? 'https://api.openai.com/v1/chat/completions'
          : _p === 'atomesus' ? 'https://api.atomesus.com/v1/chat/completions'
          : _p === 'conduit'  ? 'https://api.conduit.ozdoev.net/v1/chat/completions'
          : _p === 'iamhc'    ? 'https://api.iamhc.cn/v1/chat/completions'
          : null;
          const _pModels =
            _p === 'groq'     ? GROQ_MODELS
          : _p === 'openai'   ? OPENAI_MODELS
          : _p === 'atomesus' ? ATOMESUS_MODELS
          : _p === 'conduit'  ? CONDUIT_MODELS
          : _p === 'iamhc'    ? IAMHC_MODELS
          : [];
          if (!_pUrl || !_pModels.length) continue;
          text = await runOAIAgent(
            _p, _pUrl, _pKeys, _pModels,
            effectiveQuestion, history, systemPrompt, onToolCall, overrideSystemPrompt, isDMOwner, toolCache, userId,
          );
        }
        return { text, sources: [] };
      } catch (e) {
        lastErr = e;
        console.log('[agent]', _p, 'habis semua key/model:', e.message?.slice(0, 120));
      }
    }

    throw lastErr || new Error('Semua provider agent gagal');
    }

    module.exports = { runAgent, setAgentOrder, getAgentStatus };
    

