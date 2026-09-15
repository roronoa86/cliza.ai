
// lib/zerion.js — Zerion Wallet Intelligence API
// Docs: https://developers.zerion.io
// Auth: Basic base64(ZERION_API_KEY + ":")

const https = require('https');

const BASE_URL = 'api.zerion.io';

// Cache redirect destinations — tiap endpoint hanya redirect 1x seumur proses
const redirectCache = {};

// Cache hasil portfolio per wallet — TTL 5 menit, hemat quota bulanan
const portfolioCache = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

function authHeader() {
  const key = (process.env.ZERION_API_KEY || '').trim();
  if (!key) throw new Error('`ZERION_API_KEY` belum diset di Railway environment variables!');
  return 'Basic ' + Buffer.from(key + ':').toString('base64');
}

function zerionGetOnce(path, auth) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: BASE_URL,
      path: path,
      method: 'GET',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        'User-Agent': 'BP.AI-Bot/1.0',
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', (e) => reject(new Error('Network error: ' + e.message)));
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Zerion API timeout (15s)')); });
    req.end();
  });
}

function zerionGet(path, params) {
  return new Promise(async (resolve, reject) => {
    let auth;
    try { auth = authHeader(); } catch (e) { return reject(e); }

    // Jangan encode bracket [] — Zerion pakai filter[trash] bukan filter%5Btrash%5D
    const qs = params && Object.keys(params).length
      ? '?' + Object.entries(params).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&')
      : '';

    const originalPath = '/v1' + path + qs;
    let currentPath = redirectCache[originalPath] || originalPath;

    const maxRedirects = 5;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      let resp;
      try { resp = await zerionGetOnce(currentPath, auth); }
      catch (e) { return reject(e); }

      const { status, headers, body } = resp;

      // Follow redirect & cache tujuannya agar request berikutnya langsung ke URL final
      if (status >= 300 && status < 400) {
        const location = headers.location;
        if (!location) return reject(new Error('Zerion redirect tanpa Location header'));
        if (hop === maxRedirects) return reject(new Error('Zerion terlalu banyak redirect (>5)'));
        const nextPath = location.startsWith('http')
          ? new URL(location).pathname + (new URL(location).search || '')
          : location;
        redirectCache[originalPath] = nextPath;
        currentPath = nextPath;
        continue;
      }

      if (status === 202) return resolve(null); // masih diproses, perlu polling

      if (status === 401 || status === 403)
        return reject(new Error('ZERION_API_KEY tidak valid. Cek Railway env vars.'));

      if (status === 429) {
        // Tampilkan detail body agar bisa dibedakan: monthly quota vs per-second limit
        let detail = '';
        try {
          const parsed = JSON.parse(body);
          detail = parsed?.errors?.[0]?.detail || parsed?.message || '';
        } catch (_) { detail = body.slice(0, 120); }
        return reject(new Error(
          'Rate limit Zerion (HTTP 429).' +
          (detail ? ' Detail: ' + detail : '') +
          ' Cek sisa quota di: https://zerion.io/developer'
        ));
      }

      if (status === 404)
        return reject(new Error('Wallet tidak ditemukan di Zerion.'));

      if (status >= 400) {
        let msg = 'Zerion API error HTTP ' + status;
        try { msg = JSON.parse(body)?.errors?.[0]?.detail || msg; } catch (_) {}
        return reject(new Error(msg));
      }

      const ct = headers['content-type'] || '';
      if (!ct.includes('application/json') && !ct.includes('application/vnd.api+json')) {
        return reject(new Error(
          'Zerion response bukan JSON (content-type: ' + ct + '). ' +
          'Cek ZERION_API_KEY. Preview: ' + body.slice(0, 80)
        ));
      }

      try { return resolve(JSON.parse(body)); }
      catch (e) { return reject(new Error('Gagal parse response Zerion: ' + e.message)); }
    }
  });
}

// Retry khusus untuk 202 polling (wallet baru yang belum terindeks)
// 429 TIDAK di-retry — langsung lempar error agar quota tidak terbuang
async function zerionGetRetry(path, params, maxRetries) {
  const tries = maxRetries || 2;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const result = await zerionGet(path, params);
      if (result !== null) return result;
      // 202: wallet belum terindeks, tunggu lalu coba lagi
      if (i < tries - 1) await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      // Jangan retry 429 atau auth error — langsung lempar
      if (e.message.includes('429') || e.message.includes('tidak valid')) throw e;
      lastErr = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

// ── Formatters ───────────────────────────────────────────────────────────
function fmtUSD(n) {
  if (n == null || isNaN(n)) return '$—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e6) return sign + '$' + (abs / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return sign + '$' + abs.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return (n < 0 ? '-$' : '$') + abs.toFixed(2);
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (abs >= 1) return parseFloat(n.toFixed(4)).toString();
  return parseFloat(n.toPrecision(4)).toString();
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return '—%';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function shortAddr(addr) {
  if (!addr || addr.length < 10) return addr || '—';
  return addr.slice(0, 6) + '...' + addr.slice(-4);
}

const CHAIN_NAMES = {
  ethereum: 'Ethereum', base: 'Base', arbitrum: 'Arbitrum',
  optimism: 'Optimism', polygon: 'Polygon', 'zksync-era': 'zkSync Era',
  linea: 'Linea', scroll: 'Scroll', blast: 'Blast', zora: 'Zora',
  avalanche: 'Avalanche', bnb: 'BNB Chain', gnosis: 'Gnosis',
  solana: 'Solana', berachain: 'Berachain', monad: 'Monad',
  hyperevm: 'HyperEVM', '0g': '0G', 'binance-smart-chain': 'BSC',
};
function chainName(id) { return CHAIN_NAMES[id] || id; }

// Resolve ENS name ke hex address via ENS public API (gratis, tanpa API key)
async function resolveENS(name) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.ensideas.com',
      path: '/ens/resolve/' + encodeURIComponent(name),
      method: 'GET',
      headers: { 'User-Agent': 'BP.AI-Bot/1.0', Accept: 'application/json' },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.address && /^0x[a-fA-F0-9]{40}$/.test(json.address)) {
            resolve(json.address.toLowerCase());
          } else {
            reject(new Error('ENS "' + name + '" tidak ditemukan atau belum ada address.'));
          }
        } catch (_) {
          reject(new Error('Gagal resolve ENS: ' + name));
        }
      });
    });
    req.on('error', e => reject(new Error('Network error saat resolve ENS: ' + e.message)));
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('ENS resolve timeout')); });
    req.end();
  });
}

// Deteksi perintah balance:
//   "balance 0xAbC123..."   → EVM hex address
//   "balance vitalik.eth"   → ENS name (akan di-resolve dulu)
//   "balance name.any-tld"  → ENS-style name dengan TLD apapun
function detectBalanceQuery(text) {
  const t = (text || '').trim();
  // EVM hex address
  const mHex = t.match(/^balance\s+(0x[a-fA-F0-9]{40})\s*$/i);
  if (mHex) return mHex[1].toLowerCase();
  // ENS / human-readable name: letters/numbers/hyphens + dot + tld (2-10 chars)
  const mEns = t.match(/^balance\s+([a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,10})\s*$/i);
  if (mEns) return mEns[1].toLowerCase(); // return nama ENS, resolve nanti
  return null;
}

// ── Fetch & format wallet portfolio ──────────────────────────────────────
async function fetchZerionPortfolio(address) {
  let addr = address.toLowerCase().trim();

  authHeader(); // throws early if key missing

  // Resolve ENS name jika bukan hex address
  let displayAddr = address; // tampilkan nama ENS di output
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) {
    try {
      const resolved = await resolveENS(addr);
      displayAddr = address + ' (' + resolved.slice(0, 6) + '...' + resolved.slice(-4) + ')';
      addr = resolved;
    } catch (e) {
      throw new Error('Gagal resolve nama "' + address + '": ' + e.message);
    }
  }

  // Cek cache dulu — hemat quota jika wallet sama dicek dalam 5 menit
  const cached = portfolioCache[addr];
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.result;
  }

  // Request SEQUENTIAL bukan paralel — hindari burst rate limit
  // Delay 800ms antar request agar tidak kena per-second throttle Zerion
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  let portfolio = null, positions = [], nftMeta = null, pnl = null;

  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/portfolio', { currency: 'usd' });
    portfolio = r?.data?.attributes ?? null;
  } catch (e) {
    throw e; // portfolio wajib — lempar error langsung
  }

  await delay(1200);
  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/positions', {
      'filter[trash]': 'only_non_trash',
      'sort': '-value',
      'page[size]': '100',
      'currency': 'usd',
    });
    positions = r?.data ?? [];
  } catch (e) {
    positions = []; // positions opsional — lanjutkan tanpa error
    if (!e.message.includes('429')) console.error('[zerion] positions error:', e.message);
  }

  await delay(1200);
  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/nft-positions', { 'page[size]': '1' });
    nftMeta = r?.meta ?? null;
  } catch (_) {}

  await delay(1200);
  try {
    const r = await zerionGetRetry('/wallets/' + addr + '/pnl', { currency: 'usd' });
    pnl = r?.data?.attributes ?? null;
  } catch (_) {}

  if (!portfolio && positions.length === 0) {
    return (
      '⚠️ **Wallet tidak ditemukan atau belum terindeks.**\n' +
      'Kemungkinan penyebab:\n' +
      '• Wallet baru / tidak ada aktivitas on-chain\n' +
      '• Zerion sedang mengindeks (coba lagi 30 detik)\n' +
      '• `ZERION_API_KEY` tidak valid\n\n' +
      '🔗 [Cek manual di Zerion](<https://app.zerion.io/' + address + '/overview>)'
    );
  }

  const lines = [];

  const total    = portfolio?.total?.positions ?? 0;
  const change1d = portfolio?.changes?.absolute_1d ?? null;
  const pct1d    = portfolio?.changes?.percent_1d ?? null;
  const changeStr = change1d != null
    ? ' (' + (change1d >= 0 ? '+' : '') + fmtUSD(change1d) + ' / ' + fmtPct(pct1d) + ' 24h)'
    : '';

  lines.push('💼 **Wallet: `' + (displayAddr || shortAddr(address)) + '`**');
  lines.push('`' + addr + '`');
  lines.push('');
  lines.push('💰 **Total: ' + fmtUSD(total) + '**' + changeStr);

  const dist = portfolio?.positions_distribution_by_type;
  if (dist) {
    const parts = [];
    if (dist.wallet)    parts.push('Wallet: '   + fmtUSD(dist.wallet));
    if (dist.deposited) parts.push('DeFi: '     + fmtUSD(dist.deposited));
    if (dist.staked)    parts.push('Staked: '   + fmtUSD(dist.staked));
    if (dist.borrowed)  parts.push('Debt: '     + fmtUSD(dist.borrowed));
    if (dist.locked)    parts.push('Locked: '   + fmtUSD(dist.locked));
    if (parts.length)   lines.push('📂 ' + parts.join(' · '));
  }

  if (nftMeta?.total != null && nftMeta.total > 0)
    lines.push('🖼️ NFT: ' + nftMeta.total + ' item');

  const byChain = portfolio?.positions_distribution_by_chain;
  if (byChain) {
    const sorted = Object.entries(byChain).sort((a, b) => b[1] - a[1]).slice(0, 6);
    if (sorted.length) {
      lines.push('');
      lines.push('🔗 **By Chain:**');
      sorted.forEach(([chain, val]) => {
        const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
        lines.push('  ' + chainName(chain).padEnd(12) + fmtUSD(val).padStart(10) + '  (' + pct + '%)');
      });
    }
  }

  const topPos = positions
    .filter(p => {
      const v = p.attributes?.value;
      return v != null && v >= 1;  // hanya token dengan nilai >= $1
    })
    .sort((a, b) => (b.attributes?.value ?? 0) - (a.attributes?.value ?? 0))  // sort client-side: terbesar dulu
    .slice(0, 10);  // top 10

  if (topPos.length) {
    lines.push('');
    lines.push('🪙 **Token & Posisi:**');
    lines.push('```');
    lines.push('Symbol     Nilai USD    Chain');
    lines.push('──────────────────────────────────');
    topPos.forEach((pos) => {
      const attr = pos.attributes || {};
      const info = attr.fungible_info || {};
      const chainId = pos.relationships?.chain?.data?.id
        || (info.implementations || [])[0]?.chain_id || '';
      const chain = chainName(chainId).slice(0, 8);
      const val  = attr.value ?? 0;
      const sym  = (info.symbol || '?').slice(0, 8).padEnd(8);
      const valS = fmtUSD(val).padStart(12);
      lines.push(sym + ' ' + valS + '  ' + chain);
    });
    lines.push('```');
  } else {
    lines.push('\n_(tidak ada posisi terdeteksi)_');
  }

  if (pnl) {
    const tg = pnl.total_gain, rg = pnl.realized_gain;
    const ug = pnl.unrealized_gain, tgPct = pnl.relative_total_gain_percentage;
    const tf = pnl.total_fee;
    lines.push('');
    lines.push('📈 **PnL (FIFO):**');
    lines.push('```');
    if (tg != null) lines.push('Total      : ' + (tg >= 0 ? '+' : '') + fmtUSD(tg) + '  (' + fmtPct(tgPct) + ')');
    if (rg != null) lines.push('Realized   : ' + (rg >= 0 ? '+' : '') + fmtUSD(rg));
    if (ug != null) lines.push('Unrealized : ' + (ug >= 0 ? '+' : '') + fmtUSD(ug));
    if (tf != null) lines.push('Fees       : ' + fmtUSD(tf));
    lines.push('```');
  }

  lines.push('');
  lines.push('🔗 [Zerion](<https://app.zerion.io/' + addr + '/overview>) · [Debank](<https://debank.com/profile/' + addr + '>) · [Etherscan](<https://etherscan.io/address/' + addr + '>)');

  let msg = lines.join('\n');
  if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong, lihat link Zerion)_';

  // Simpan ke cache
  portfolioCache[addr] = { ts: Date.now(), result: msg };

  return msg;
}


    // ─────────────────────────────────────────────────────────────────────────────
    // FITUR-FITUR ZERION BARU
    // ─────────────────────────────────────────────────────────────────────────────

    // ── Transactions ──────────────────────────────────────────────────────────
    function detectTxsQuery(text) {
    const t = (text || '').trim();
    const m = t.match(/^txs\s+(0x[a-fA-F0-9]{40}|[a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,10})\s*$/i);
    return m ? m[1].toLowerCase() : null;
    }

    async function fetchZerionTransactions(address) {
    let addr = address.toLowerCase().trim();
    authHeader();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) addr = await resolveENS(addr);

    const r = await zerionGetRetry('/wallets/' + addr + '/transactions', {
      'page[size]': '10',
      'currency': 'usd',
    });
    const txs = r?.data ?? [];
    if (!txs.length) return '📭 Tidak ada transaksi ditemukan untuk wallet ini.';

    const typeIcon = {
      send:'📤', receive:'📥', approve:'✅', trade:'🔄',
      deposit:'📦', withdraw:'📤', borrow:'💸', repay:'💰', execute:'⚡', deploy:'🚀',
    };

    const lines = [];
    lines.push('📋 **10 Transaksi Terakhir**');
    lines.push('`' + shortAddr(addr) + '`');
    lines.push('');

    for (const tx of txs) {
      const attr   = tx.attributes || {};
      const type   = attr.operation_type || 'unknown';
      const status = attr.status || '';
      const hash   = attr.hash || '';
      const minedAt = attr.mined_at
        ? new Date(attr.mined_at * 1000).toISOString().slice(0, 16).replace('T', ' ')
        : '—';
      const chainId = tx.relationships?.chain?.data?.id || '';
      const icon    = typeIcon[type] || '🔷';
      const statusIcon = status === 'confirmed' ? '' : status === 'pending' ? ' ⏳' : ' ❌';

      const transfers = attr.transfers || [];
      let transferStr = '';
      if (transfers.length > 0) {
        const first = transfers[0];
        const sym = first.fungible_info?.symbol || 'TOKEN';
        const qty = first.quantity?.numeric ? parseFloat(first.quantity.numeric) : null;
        const val = first.value != null ? ' ≈ ' + fmtUSD(first.value) : '';
        transferStr = qty != null ? (' ' + fmtNum(qty) + ' ' + sym + val) : '';
      }

      lines.push(icon + ' **' + type + '**' + statusIcon + transferStr);
      lines.push('   ' + chainName(chainId) + ' · ' + minedAt + ' UTC');
      if (hash) lines.push('   [`' + hash.slice(0, 10) + '...`](<https://etherscan.io/tx/' + hash + '>)');
      lines.push('');
    }

    lines.push('🔗 [Lihat semua di Zerion](<https://app.zerion.io/' + addr + '/history>)');
    let msg = lines.join('\n');
    if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong)_';
    return msg;
    }

    // ── Detailed Positions ────────────────────────────────────────────────────
    function detectPositionsQuery(text) {
    const t = (text || '').trim();
    const m = t.match(/^positions\s+(0x[a-fA-F0-9]{40}|[a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,10})\s*$/i);
    return m ? m[1].toLowerCase() : null;
    }

    async function fetchZerionPositions(address) {
    let addr = address.toLowerCase().trim();
    authHeader();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) addr = await resolveENS(addr);

    const r = await zerionGetRetry('/wallets/' + addr + '/positions', {
      'filter[trash]': 'only_non_trash',
      'sort': '-value',
      'page[size]': '50',
      'currency': 'usd',
    });
    const positions = r?.data ?? [];
    if (!positions.length) return '📭 Tidak ada posisi ditemukan.';

    const byChain = {};
    for (const pos of positions) {
      const attr = pos.attributes || {};
      const val  = attr.value ?? 0;
      if (val < 0.5) continue;
      const chainId = pos.relationships?.chain?.data?.id
        || (attr.fungible_info?.implementations || [])[0]?.chain_id || 'unknown';
      if (!byChain[chainId]) byChain[chainId] = [];
      byChain[chainId].push(pos);
    }

    const chainsSorted = Object.entries(byChain)
      .map(([c, ps]) => [c, ps.reduce((s, p) => s + (p.attributes?.value ?? 0), 0), ps])
      .sort((a, b) => b[1] - a[1]);

    const lines = [];
    lines.push('🪙 **Posisi Token Detail**');
    lines.push('`' + shortAddr(addr) + '`');

    for (const [chainId, chainTotal, ps] of chainsSorted) {
      lines.push('');
      lines.push('**' + chainName(chainId) + '** — ' + fmtUSD(chainTotal));
      lines.push('```');
      lines.push('Symbol    Qty              Nilai USD   Harga');
      lines.push('──────────────────────────────────────────────');
      for (const pos of ps.slice(0, 8)) {
        const attr  = pos.attributes || {};
        const info  = attr.fungible_info || {};
        const sym   = (info.symbol || '?').slice(0, 7).padEnd(7);
        const qty   = attr.quantity?.numeric ? parseFloat(attr.quantity.numeric) : null;
        const qtyS  = qty != null ? fmtNum(qty).padStart(14) : '             —';
        const val   = fmtUSD(attr.value ?? 0).padStart(10);
        const price = attr.price ? fmtUSD(attr.price).padStart(8) : '       —';
        lines.push(sym + '  ' + qtyS + '  ' + val + '  ' + price);
      }
      if (ps.length > 8) lines.push('  ... dan ' + (ps.length - 8) + ' token lain');
      lines.push('```');
    }

    lines.push('');
    lines.push('🔗 [Zerion](<https://app.zerion.io/' + addr + '/overview>)');
    let msg = lines.join('\n');
    if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong)_';
    return msg;
    }

    // ── NFT Holdings ──────────────────────────────────────────────────────────
    function detectNFTQuery(text) {
    const t = (text || '').trim();
    const m = t.match(/^nft\s+(0x[a-fA-F0-9]{40}|[a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,10})\s*$/i);
    return m ? m[1].toLowerCase() : null;
    }

    async function fetchZerionNFTs(address) {
    let addr = address.toLowerCase().trim();
    authHeader();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) addr = await resolveENS(addr);

    const r = await zerionGetRetry('/wallets/' + addr + '/nft-positions', {
      'page[size]': '15',
      'currency': 'usd',
    });
    const nfts = r?.data ?? [];
    const meta = r?.meta ?? {};
    if (!nfts.length) return '📭 Wallet ini tidak memiliki NFT yang terdeteksi di Zerion.';

    const lines = [];
    lines.push('🖼️ **NFT Holdings**');
    lines.push('`' + shortAddr(addr) + '`');
    if (meta.total != null) lines.push('Total: **' + meta.total + '** NFT');
    lines.push('');

    for (const item of nfts.slice(0, 12)) {
      const attr       = item.attributes || {};
      const nftInfo    = attr.nft_info || {};
      const collection = nftInfo.collection_info || {};
      const name       = nftInfo.name || collection.name || '—';
      const collName   = collection.name || '';
      const chainId    = item.relationships?.chain?.data?.id || '';
      const floor      = attr.floor_price != null ? ' · Floor: ' + fmtUSD(attr.floor_price) : '';
      const value      = attr.value       != null ? ' · Est: '   + fmtUSD(attr.value)        : '';
      const extra      = collName && collName !== name ? ' (' + collName + ')' : '';
      lines.push('🔹 **' + name + extra + '**');
      lines.push('   ' + chainName(chainId) + floor + value);
    }

    if ((meta.total ?? 0) > 12) lines.push('\n_...dan ' + (meta.total - 12) + ' NFT lain_');
    lines.push('');
    lines.push('🔗 [Lihat NFT di Zerion](<https://app.zerion.io/' + addr + '/nfts>)');

    let msg = lines.join('\n');
    if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong)_';
    return msg;
    }

    // ── Gas Prices ────────────────────────────────────────────────────────────
    function detectGasQuery(text) {
    const t = (text || '').trim().toLowerCase();
    return t === 'gas' || t === 'gas price' || t === 'gasprice';
    }

    async function fetchZerionGas() {
    authHeader();
    const r = await zerionGetRetry('/gas-prices/', {});
    const items = r?.data ?? [];
    if (!items.length) return '⛽ Data gas tidak tersedia saat ini.';

    const lines = [];
    lines.push('⛽ **Gas Prices — Real-Time**');
    lines.push('```');
    lines.push('Chain           Slow        Normal      Fast');
    lines.push('─────────────────────────────────────────────');

    for (const item of items) {
      const attr    = item.attributes || {};
      const classic = attr.info?.classic ?? {};
      const chain   = chainName(item.id || '').slice(0, 14).padEnd(14);
      const slow    = classic.slow?.max_fee    != null ? classic.slow.max_fee.toFixed(1)    + ' Gw' : '—';
      const normal  = classic.fast?.max_fee    != null ? classic.fast.max_fee.toFixed(1)    + ' Gw'
                    : classic.average?.max_fee != null ? classic.average.max_fee.toFixed(1) + ' Gw' : '—';
      const fast    = classic.rapid?.max_fee   != null ? classic.rapid.max_fee.toFixed(1)   + ' Gw' : '—';
      lines.push(chain + '  ' + slow.padStart(9) + '  ' + normal.padStart(9) + '  ' + fast.padStart(9));
    }
    lines.push('```');
    lines.push('_Real-time via Zerion · Satuan: Gwei_');
    return lines.join('\n');
    }

    // ── Token Info ────────────────────────────────────────────────────────────
    function detectZTokenQuery(text) {
    const t = (text || '').trim();
    const m = t.match(/^ztoken\s+(.+)$/i);
    return m ? m[1].trim() : null;
    }

    async function fetchZerionToken(query) {
    authHeader();
    const isCA = /^0x[a-fA-F0-9]{40}$/.test(query.trim());
    let fungible = null;

    if (isCA) {
      const r = await zerionGetRetry('/fungibles/', {
        'filter[implementation_address]': query.trim(),
        'page[size]': '1',
        'currency': 'usd',
      });
      fungible = r?.data?.[0] ?? null;
    } else {
      const r = await zerionGetRetry('/fungibles/', {
        'filter[search_query]': query,
        'page[size]': '1',
        'currency': 'usd',
      });
      fungible = r?.data?.[0] ?? null;
    }

    if (!fungible) return '❌ Token **' + query + '** tidak ditemukan di Zerion.';

    const attr   = fungible.attributes || {};
    const info   = attr.fungible_info  || attr;
    const market = attr.market_data    || {};
    const name   = info.name   || attr.name   || '—';
    const symbol = info.symbol || attr.symbol || '—';
    const desc   = info.description || '';
    const price  = market.price        ?? attr.price ?? null;
    const mc     = market.market_cap   ?? null;
    const vol24  = market.total_volume ?? null;
    const pct1d  = market.changes?.percent_1d ?? null;
    const pct7d  = market.changes?.percent_7d ?? null;
    const ath    = market.ath ?? null;
    const atl    = market.atl ?? null;

    const lines = [];
    lines.push('🪙 **' + name + ' (' + symbol + ')**');
    if (price != null) {
      const chStr = pct1d != null ? ' ' + fmtPct(pct1d) + ' 24h' : '';
      lines.push('💰 Harga: **' + fmtUSD(price) + '**' + chStr);
    }
    if (pct7d  != null) lines.push('📅 7d: ' + fmtPct(pct7d));
    if (mc     != null) lines.push('📊 Market Cap: ' + fmtUSD(mc));
    if (vol24  != null) lines.push('📈 Volume 24h: ' + fmtUSD(vol24));
    if (ath    != null) lines.push('🏆 ATH: ' + fmtUSD(ath));
    if (atl    != null) lines.push('📉 ATL: ' + fmtUSD(atl));

    const impls = info.implementations || [];
    if (impls.length) {
      lines.push('');
      lines.push('🔗 **Tersedia di chain:**');
      for (const impl of impls.slice(0, 5)) {
        const c  = chainName(impl.chain_id);
        const ca = impl.address
          ? '`' + impl.address.slice(0, 8) + '...' + impl.address.slice(-6) + '`'
          : 'native';
        lines.push('  • ' + c + ': ' + ca);
      }
    }

    if (desc) {
      lines.push('');
      lines.push('ℹ️ ' + desc.slice(0, 200) + (desc.length > 200 ? '...' : ''));
    }

    lines.push('');
    lines.push('🔗 [Zerion](<https://app.zerion.io/explore/asset/' + symbol.toLowerCase() + '-' + (fungible.id || '') + '>)');

    let msg = lines.join('\n');
    if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong)_';
    return msg;
    }

    // ── PnL Detail ────────────────────────────────────────────────────────────
    function detectPnLQuery(text) {
    const t = (text || '').trim();
    const m = t.match(/^pnl\s+(0x[a-fA-F0-9]{40}|[a-zA-Z0-9][a-zA-Z0-9\-]*\.[a-zA-Z]{2,10})\s*$/i);
    return m ? m[1].toLowerCase() : null;
    }

    async function fetchZerionPnL(address) {
    let addr = address.toLowerCase().trim();
    authHeader();
    if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) addr = await resolveENS(addr);

    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    let pnl = null, positions = [];

    try {
      const r = await zerionGetRetry('/wallets/' + addr + '/pnl', { currency: 'usd' });
      pnl = r?.data?.attributes ?? null;
    } catch (_) {}

    await delay(800);

    try {
      const r = await zerionGetRetry('/wallets/' + addr + '/positions', {
        'filter[trash]': 'only_non_trash',
        'sort': '-absolute_change_1d',
        'page[size]': '20',
        'currency': 'usd',
      });
      positions = r?.data ?? [];
    } catch (_) {}

    const lines = [];
    lines.push('📈 **P&L Detail**');
    lines.push('`' + shortAddr(addr) + '`');
    lines.push('');

    if (pnl) {
      const tg = pnl.total_gain, rg = pnl.realized_gain, ug = pnl.unrealized_gain;
      const tgPct = pnl.relative_total_gain_percentage, tf = pnl.total_fee;
      lines.push('**📊 Ringkasan PnL (FIFO):**');
      lines.push('```');
      if (tg   != null) lines.push('Total P&L  : ' + (tg >= 0 ? '+' : '') + fmtUSD(tg)   + '  (' + fmtPct(tgPct) + ')');
      if (rg   != null) lines.push('Realized   : ' + (rg >= 0 ? '+' : '') + fmtUSD(rg));
      if (ug   != null) lines.push('Unrealized : ' + (ug >= 0 ? '+' : '') + fmtUSD(ug));
      if (tf   != null) lines.push('Total Fees : ' + fmtUSD(tf));
      lines.push('```');
    } else {
      lines.push('_Data PnL global tidak tersedia untuk wallet ini_');
    }

    const withChange = positions.filter(p => p.attributes?.changes?.absolute_1d != null);
    if (withChange.length) {
      lines.push('');
      lines.push('**🏆 Top Movers 24h:**');
      lines.push('```');
      lines.push('Symbol    Perubahan 24h    % Perubahan');
      lines.push('────────────────────────────────────────');
      for (const pos of withChange.slice(0, 8)) {
        const attr = pos.attributes || {};
        const sym  = (attr.fungible_info?.symbol || '?').slice(0, 7).padEnd(7);
        const chg  = attr.changes?.absolute_1d ?? 0;
        const pct  = attr.changes?.percent_1d  ?? 0;
        const chgS = ((chg >= 0 ? '+' : '') + fmtUSD(chg)).padStart(14);
        const pctS = fmtPct(pct).padStart(12);
        lines.push(sym + '  ' + chgS + '  ' + pctS);
      }
      lines.push('```');
    }

    lines.push('');
    lines.push('🔗 [Zerion](<https://app.zerion.io/' + addr + '/overview>)');

    let msg = lines.join('\n');
    if (msg.length > 1950) msg = msg.slice(0, 1900) + '\n_...(terpotong)_';
    return msg;
    }

    module.exports = {
    detectBalanceQuery, fetchZerionPortfolio,
    detectTxsQuery, fetchZerionTransactions,
    detectPositionsQuery, fetchZerionPositions,
    detectNFTQuery, fetchZerionNFTs,
    detectGasQuery, fetchZerionGas,
    detectZTokenQuery, fetchZerionToken,
    detectPnLQuery, fetchZerionPnL,
    };

