// lib/gmgn.js — v7
// SEMUA endpoint pakai openapi.gmgn.ai (X-APIKEY). DexScreener sebagai supplement.
// Mendukung SOL, ETH, BSC, Base dengan field lengkap per chain.
//
// ENDPOINT AKTIF:
//   token   : /v1/token/info, /v1/token/security, /v1/token/pool_info
//   market  : /v1/market/rank (multi-interval), /v1/market/token_top_traders,
//             /v1/market/token_top_holders, /v1/market/token_kline,
//             /v1/market/token_signal (POST), /v1/trenches (POST)
//   user    : /v1/user/wallet_stats (7d/30d), /v1/user/wallet_activity,
//             /v1/user/wallet_token_balance, /v1/user/created_tokens,
//             /v1/user/smartmoney, /v1/user/kol, /v1/user/info

const https  = require('https');
const zlib   = require('zlib');
const crypto = require('crypto');

const OPENAPI_HOST = 'openapi.gmgn.ai';
const DEX_HOST     = 'api.dexscreener.com';
const GECKO_HOST   = 'api.geckoterminal.com';
const GMGN_API_KEY = process.env.GMGN_API_KEY || '';

const SUPPORTED_CHAINS = ['sol', 'eth', 'bsc', 'base', 'robinhood'];
const CHAIN_ALIAS = {
  solana: 'sol', ethereum: 'eth', ether: 'eth',
  bnb: 'bsc', bnbchain: 'bsc', binance: 'bsc',
  robin: 'robinhood', rbn: 'robinhood', rh: 'robinhood',
};
const CHAIN_TO_DEX = { sol: 'solana', eth: 'ethereum', bsc: 'bsc', base: 'base', robinhood: 'robinhood' };
const CHAIN_LABEL  = { sol: 'Solana', eth: 'Ethereum', bsc: 'BNB Chain', base: 'Base', robinhood: 'Robinhood' };

// DexScreener chainId → internal chain name (untuk auto-detect)
const DEX_TO_CHAIN = {
  solana: 'sol', ethereum: 'eth', bsc: 'bsc', base: 'base', robinhood: 'robinhood',
};

// GeckoTerminal network ID → internal chain name
const GECKO_TO_CHAIN = {
  eth: 'eth', ethereum: 'eth',
  bsc: 'bsc', 'binance-smart-chain': 'bsc',
  base: 'base',
  solana: 'sol',
  'robinhood-chain': 'robinhood', robinhood: 'robinhood',
};

const VALID_INTERVALS = ['1m', '5m', '1h', '6h', '24h'];
const VALID_RESOLUTIONS = ['30s', '1m', '5m', '15m', '1h', '4h', '1d'];

// ── Address utils ─────────────────────────────────────────
function isSolAddr(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s); }
function isEvmAddr(s) { return /^0x[a-fA-F0-9]{40}$/.test(s); }
function isAddr(s)    { return isSolAddr(s) || isEvmAddr(s); }
function guessChain(a){ return isEvmAddr(a) ? 'eth' : 'sol'; }
function resolveChain(raw) {
  const l = (raw || '').toLowerCase();
  return CHAIN_ALIAS[l] || (SUPPORTED_CHAINS.includes(l) ? l : null);
}
function isEvm(chain) { return chain === 'eth' || chain === 'bsc' || chain === 'base' || chain === 'robinhood'; }

// ── detectGmgnQuery ───────────────────────────────────────
function detectGmgnQuery(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^gmgn\b/i.test(t)) return null;
  const parts = t.split(/\s+/);
  const raw1 = parts[1] || '', sub1 = raw1.toLowerCase();
  const raw2 = parts[2] || '', sub2 = raw2.toLowerCase();
  const raw3 = parts[3] || '', sub3 = raw3.toLowerCase();

  // ── Direct address ────────────────────────────────────
  // EVM addr bisa di banyak chain → tandai autoDetect agar handleGmgnCommand query DexScreener dulu
  if (isAddr(raw1)) return { type: 'token', chain: guessChain(raw1), address: raw1, autoDetect: isEvmAddr(raw1) };

  const c1 = resolveChain(sub1);
  if (c1 && isAddr(raw2)) return { type: 'token', chain: c1, address: raw2 };

  // ── TRENDING (extended: interval support) ─────────────
  if (sub1 === 'trending' || sub1 === 'trend') {
    // gmgn trending [chain] [interval] OR gmgn trending [interval] [chain]
    const maybeInterval = VALID_INTERVALS.includes(sub2) ? sub2 : (VALID_INTERVALS.includes(sub3) ? sub3 : '1h');
    const maybeChain    = resolveChain(sub2) || resolveChain(sub3) || 'sol';
    return { type: 'trending', chain: maybeChain, interval: maybeInterval };
  }

  // ── SMART (existing: top traders of token / global) ───
  if (sub1 === 'smart') {
    if (isAddr(raw2)) return { type: 'smart', chain: guessChain(raw2), address: raw2 };
    const c2 = resolveChain(sub2);
    if (c2 && isAddr(raw3)) return { type: 'smart', chain: c2, address: raw3 };
    return { type: 'smart', chain: c2 || 'sol', address: null };
  }

  // ── WALLET (extended: activity + 30d) ────────────────
  if (sub1 === 'wallet' || sub1 === 'dompet') {
    const period = (sub2 === '30d' || sub3 === '30d') ? '30d' : '7d';
    if (isAddr(raw2)) return { type: 'wallet', chain: guessChain(raw2), address: raw2, period };
    const cw = resolveChain(sub2), raw3x = parts[3] || '';
    if (cw && isAddr(raw3x)) return { type: 'wallet', chain: cw, address: raw3x, period };
    return null;
  }

  // ── NEW: TRENCHES ─────────────────────────────────────
  if (sub1 === 'new' || sub1 === 'trench' || sub1 === 'trenches') {
    // gmgn new [subtype] [chain]  OR  gmgn new [chain] [subtype]
    const subtypeMap = {
      grad: 'completed', completed: 'completed', graduate: 'completed',
      near: 'near_completion', bonding: 'near_completion', graduating: 'near_completion',
      new: 'new_creation', launch: 'new_creation', fresh: 'new_creation',
    };
    let subtype = 'new_creation';
    let chain   = 'sol';
    for (const p of [sub2, sub3]) {
      if (subtypeMap[p]) subtype = subtypeMap[p];
      else if (resolveChain(p)) chain = resolveChain(p);
    }
    return { type: 'trenches', chain, subtype };
  }

  // ── NEW: SIGNAL ───────────────────────────────────────
  if (sub1 === 'signal' || sub1 === 'signals') {
    const chain = resolveChain(sub2) || 'sol';
    // signal only works on sol & bsc
    const validChain = (chain === 'sol' || chain === 'bsc') ? chain : 'sol';
    return { type: 'signal', chain: validChain };
  }

  // ── NEW: SMARTMONEY FEED (different from gmgn smart) ─
  if (sub1 === 'smartmoney' || sub1 === 'sm') {
    return { type: 'smartmoney_feed', chain: resolveChain(sub2) || 'sol' };
  }

  // ── NEW: KOL FEED ─────────────────────────────────────
  if (sub1 === 'kol' || sub1 === 'kols') {
    return { type: 'kol_feed', chain: resolveChain(sub2) || 'sol' };
  }

  // ── NEW: TOP HOLDERS ──────────────────────────────────
  if (sub1 === 'holders' || sub1 === 'holder') {
    if (isAddr(raw2)) return { type: 'holders', chain: guessChain(raw2), address: raw2 };
    const ch = resolveChain(sub2);
    if (ch && isAddr(raw3)) return { type: 'holders', chain: ch, address: raw3 };
    return null;
  }

  // ── NEW: KLINE CHART ──────────────────────────────────
  if (sub1 === 'chart' || sub1 === 'kline' || sub1 === 'candle') {
    const res = VALID_RESOLUTIONS.includes(sub2) ? sub2 : (VALID_RESOLUTIONS.includes(sub3) ? sub3 : '1h');
    if (isAddr(raw2)) return { type: 'chart', chain: guessChain(raw2), address: raw2, resolution: res };
    const cc = resolveChain(sub2);
    if (cc && isAddr(raw3)) {
      const r4 = (parts[4] || '').toLowerCase();
      const res2 = VALID_RESOLUTIONS.includes(r4) ? r4 : '1h';
      return { type: 'chart', chain: cc, address: raw3, resolution: res2 };
    }
    return null;
  }

  // ── NEW: DEV CHECK ────────────────────────────────────
  if (sub1 === 'dev' || sub1 === 'creator') {
    if (isAddr(raw2)) return { type: 'devcheck', chain: guessChain(raw2), address: raw2 };
    const cd = resolveChain(sub2);
    if (cd && isAddr(raw3)) return { type: 'devcheck', chain: cd, address: raw3 };
    return null;
  }

  // ── Bare chain → trending that chain (1h default) ─────
  if (c1 && !raw2) return { type: 'trending', chain: c1, interval: '1h' };

  return null;
}

// ── HTTP helpers ──────────────────────────────────────────
function _checkKey() {
  if (!GMGN_API_KEY) throw new Error(
    'GMGN_API_KEY belum di-set di environment variables.'
  );
}

function _buildQs(params) {
  return Object.entries({
    ...(params || {}),
    timestamp: Math.floor(Date.now() / 1000),
    client_id : crypto.randomUUID(),
  }).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
}

function _decode(res, chunks) {
  const enc = (res.headers['content-encoding'] || '').toLowerCase();
  let stream = res;
  if      (enc === 'gzip')    stream = res.pipe(zlib.createGunzip());
  else if (enc === 'br')      stream = res.pipe(zlib.createBrotliDecompress());
  else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
  return stream;
}

function openGet(path, params) {
  _checkKey();
  const qs = _buildQs(params);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OPENAPI_HOST, path: path + '?' + qs, method: 'GET',
      headers : { 'X-APIKEY': GMGN_API_KEY, 'Accept': 'application/json',
                  'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'gmgn-cli/1.5.0' },
      timeout : 15000,
    }, (res) => {
      const chunks = [];
      _decode(res, chunks).on('data', c => chunks.push(c)).on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          if (j && j.code !== undefined) {
            if (j.code !== 0) return reject(new Error(j.message || j.error || 'API error ' + j.code));
            return resolve(j.data !== undefined ? j.data : j);
          }
          resolve(j);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout koneksi GMGN.')); });
    req.end();
  });
}

function openPost(path, params, body) {
  _checkKey();
  const qs     = _buildQs(params);
  const bodyStr = JSON.stringify(body || {});
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: OPENAPI_HOST, path: path + '?' + qs, method: 'POST',
      headers : {
        'X-APIKEY': GMGN_API_KEY, 'Accept': 'application/json',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr),
        'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'gmgn-cli/1.5.0',
      },
      timeout : 15000,
    }, (res) => {
      const chunks = [];
      _decode(res, chunks).on('data', c => chunks.push(c)).on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString());
          if (j && j.code !== undefined) {
            if (j.code !== 0) return reject(new Error(j.message || j.error || 'API error ' + j.code));
            return resolve(j.data !== undefined ? j.data : j);
          }
          resolve(j);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout koneksi GMGN.')); });
    req.write(bodyStr);
    req.end();
  });
}

// ── GeckoTerminal helpers (CoinGecko) ────────────────────
function _geckoHeaders() {
  const key = process.env.COINGECKO_API_KEY || '';
  const base = { 'Accept': 'application/json', 'User-Agent': 'gmgn-cli/1.5.0' };
  if (!key) return base;
  // Demo key diawali "CG-", Pro key tidak
  return key.startsWith('CG-')
    ? { ...base, 'x-cg-demo-api-key': key }
    : { ...base, 'x-cg-pro-api-key': key };
}

function geckoSearchPools(ca) {
  return new Promise((resolve) => {
    const path = '/api/v2/search/pools?query=' + encodeURIComponent(ca) + '&include=base_token';
    const req = https.request({
      hostname: GECKO_HOST, path, method: 'GET',
      headers: _geckoHeaders(),
      timeout: 6000,
    }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Auto-detect chain: GeckoTerminal dulu → fallback DexScreener ─
async function detectChainFromDex(ca) {
  // 1. Coba GeckoTerminal (CoinGecko) — lebih cepat & pakai API key
  try {
    const gRes = await geckoSearchPools(ca);
    if (gRes && Array.isArray(gRes.data) && gRes.data.length > 0) {
      const sorted = gRes.data
        .filter(p => p.relationships?.network?.data?.id)
        .sort((a, b) => {
          const la = parseFloat(a.attributes?.reserve_in_usd || 0);
          const lb = parseFloat(b.attributes?.reserve_in_usd || 0);
          return lb - la;
        });
      if (sorted.length > 0) {
        const networkId = sorted[0].relationships.network.data.id;
        const chain = GECKO_TO_CHAIN[networkId] || null;
        if (chain) return chain;
      }
    }
  } catch (_) {}

  // 2. Fallback ke DexScreener
  try {
    const dexRes = await dexGet(ca);
    if (dexRes && dexRes.pairs && dexRes.pairs.length > 0) {
      const sorted = dexRes.pairs
        .filter(p => p.liquidity && p.liquidity.usd != null)
        .sort((a, b) => parseFloat(b.liquidity.usd) - parseFloat(a.liquidity.usd));
      const best = sorted[0] || dexRes.pairs[0];
      return DEX_TO_CHAIN[best.chainId] || null;
    }
  } catch (_) {}

  return null;
}

// ── DexScreener supplement ────────────────────────────────
function dexGet(ca) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: DEX_HOST, path: '/latest/dex/tokens/' + ca, method: 'GET',
      headers : { 'Accept': 'application/json', 'User-Agent': 'gmgn-cli/1.5.0' },
      timeout : 8000,
    }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── Format helpers ────────────────────────────────────────
function fmt(n, d) {
  d = (d === undefined) ? 2 : d;
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  if (Math.abs(num) >= 1e9) return (num / 1e9).toFixed(d) + 'B';
  if (Math.abs(num) >= 1e6) return (num / 1e6).toFixed(d) + 'M';
  if (Math.abs(num) >= 1e3) return (num / 1e3).toFixed(d) + 'K';
  return num.toFixed(d);
}
function fmtPrice(n) {
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num) || num === 0) return 'N/A';
  if (num < 0.000001) return '$' + num.toExponential(4);
  if (num < 0.0001)   return '$' + num.toFixed(8);
  if (num < 0.01)     return '$' + num.toFixed(6);
  if (num < 1)        return '$' + num.toFixed(5);
  if (num < 1000)     return '$' + num.toFixed(4);
  return '$' + fmt(num);
}
function fmtPct(n) {
  if (n == null) return 'N/A';
  const num = parseFloat(n);
  if (isNaN(num)) return 'N/A';
  return (num >= 0 ? '+' : '') + num.toFixed(2) + '%';
}
function pricePct(now, before) {
  if (!now || !before) return null;
  const b = parseFloat(before);
  if (!b) return null;
  const diff = (parseFloat(now) - b) / b * 100;
  return isNaN(diff) ? null : diff;
}
function fmtAge(ts) {
  if (!ts) return null;
  const sec = ts > 9999999999 ? Math.floor(ts / 1000) : ts;
  const s   = Math.floor(Date.now() / 1000) - sec;
  if (s < 0)      return 'baru saja';
  if (s < 60)     return s + ' detik';
  if (s < 3600)   return Math.floor(s / 60) + ' menit';
  if (s < 86400)  return Math.floor(s / 3600) + ' jam';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return d + ' hari' + (h > 0 ? ' ' + h + 'j' : '');
}
function fmtTs(ts) {
  if (!ts) return 'N/A';
  const sec = ts > 9999999999 ? Math.floor(ts / 1000) : ts;
  return new Date(sec * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false,
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function shortAddr(a) {
  if (!a || a.length <= 12) return a || 'N/A';
  return a.slice(0, isEvmAddr(a) ? 8 : 6) + '...' + a.slice(-4);
}
function chainBadge(chain) {
  const m = { sol: '🟣', eth: '🔷', bsc: '🟡', base: '🔵', robinhood: '🟢' };
  return (m[chain] || '⬜') + ' ' + (CHAIN_LABEL[chain] || chain.toUpperCase());
}
function pct100(n, digits) {
  if (n == null) return null;
  const v = parseFloat(n) * 100;
  if (isNaN(v) || v === 0) return null;
  return v.toFixed(digits !== undefined ? digits : 1) + '%';
}
function nonZero(v) { return v != null && parseFloat(v) !== 0; }

// ── TOKEN INFO (LENGKAP — multi chain) ───────────────────
async function handleTokenInfo(chain, ca) {
  const dexChain = CHAIN_TO_DEX[chain] || chain;

  const [infoRes, secRes, dexRes] = await Promise.all([
    openGet('/v1/token/info', { chain, address: ca }),
    openGet('/v1/token/security', { chain, address: ca }).catch(() => null),
    dexGet(ca),
  ]);

  if (!infoRes && !dexRes) throw new Error('Token tidak ditemukan di ' + chainBadge(chain) + '.');

  const gi   = infoRes || {};
  const p    = gi.price || {};
  const dev  = gi.dev   || {};
  const st   = gi.stat  || {};
  const wt   = gi.wallet_tags_stat || {};
  const lk   = gi.link  || {};
  const sec  = secRes   || {};
  const pool = gi.pool  || {};

  // Best DexScreener pair
  let pair = null;
  if (dexRes && dexRes.pairs) {
    pair = dexRes.pairs
      .filter(x => x.chainId === dexChain)
      .sort((a, b) => (parseFloat(b.volume?.h24) || 0) - (parseFloat(a.volume?.h24) || 0))[0] || null;
  }

  // ── Identitas ─────────────────────────────────────────
  const name     = gi.name   || pair?.baseToken?.name   || 'Unknown';
  const symbol   = gi.symbol || pair?.baseToken?.symbol || '?';
  const platform = gi.launchpad_platform || gi.launchpad
    || (pair?.dexId ? pair.dexId.charAt(0).toUpperCase() + pair.dexId.slice(1) : '');
  const ageSec   = gi.open_timestamp || gi.creation_timestamp
    || (pair?.pairCreatedAt ? Math.floor(pair.pairCreatedAt / 1000) : null);
  const age      = fmtAge(ageSec) || 'N/A';
  const ctoFlag  = dev.cto_flag === 1;

  // ── DexPaid ────────────────────────────────────────────
  const dexPaidItems = [];
  if (dev.dexscr_update_link === 1) dexPaidItems.push('✅ Update Info');
  if (dev.dexscr_ad          === 1) dexPaidItems.push('📢 Ad');
  if (dev.dexscr_boost_fee   > 0)  dexPaidItems.push('🚀 Boost');
  if (dev.dexscr_trending_bar === 1) dexPaidItems.push('📊 Trending Bar');
  const dexPaid = dexPaidItems.length > 0 ? dexPaidItems.join(' · ') : '❌ Belum';

  // ── Harga & Market ────────────────────────────────────
  const curPrice = p.price || pair?.priceUsd;
  const priceStr = fmtPrice(curPrice);
  const mcRaw    = p.market_cap || pair?.marketCap || null;
  const fdvRaw   = pair?.fdv || null;
  const mc       = mcRaw  ? '$' + fmt(mcRaw)  : 'N/A';
  const fdvStr   = fdvRaw ? '$' + fmt(fdvRaw) : null;

  const athPrice   = p.ath || gi.ath_price;
  const athStr     = athPrice ? fmtPrice(athPrice) : 'N/A';
  const athDropPct = (curPrice && athPrice)
    ? fmtPct((parseFloat(curPrice) - parseFloat(athPrice)) / parseFloat(athPrice) * 100) : null;

  // Liquidity — pool.liquidity lebih akurat
  const liqNow   = parseFloat(pool.liquidity || gi.liquidity || pair?.liquidity?.usd || 0);
  const liqInit  = parseFloat(pool.initial_liquidity || 0);
  let liqStr     = liqNow > 0 ? '$' + fmt(liqNow) : 'N/A';
  if (liqInit > 0 && liqNow > 0) {
    const drain = (liqNow - liqInit) / liqInit * 100;
    liqStr += ' _(awal: $' + fmt(liqInit) + ', ' + fmtPct(drain) + ')_';
  }

  const holders = gi.holder_count ? gi.holder_count.toLocaleString() : 'N/A';

  // Supply
  const circSupply  = gi.circulating_supply ? fmt(parseFloat(gi.circulating_supply), 0) : null;
  const totalSupply = gi.total_supply       ? fmt(parseFloat(gi.total_supply), 0)        : null;

  // ── Pergerakan semua timeframe ────────────────────────
  const ch5m  = pricePct(p.price, p.price_5m);
  const ch1h  = pricePct(p.price, p.price_1h) ?? p.price_change_percent1h;
  const ch6h  = pricePct(p.price, p.price_6h) ?? p.price_change_percent6h;
  const ch24h = pricePct(p.price, p.price_24h) ?? p.price_change_percent24h
    ?? (pair ? parseFloat(pair.priceChange?.h24) : null);

  const dexCh1h  = pair?.priceChange?.h1;
  const dexCh6h  = pair?.priceChange?.h6;
  const dexCh24h = pair?.priceChange?.h24;

  const vol5m  = nonZero(p.volume_5m)  ? '$' + fmt(p.volume_5m)  : null;
  const vol1h  = nonZero(p.volume_1h)  ? '$' + fmt(p.volume_1h)
    : (pair?.volume?.h1  ? '$' + fmt(pair.volume.h1)  : null);
  const vol6h  = nonZero(p.volume_6h)  ? '$' + fmt(p.volume_6h)
    : (pair?.volume?.h6  ? '$' + fmt(pair.volume.h6)  : null);
  const vol24h = nonZero(p.volume_24h) ? '$' + fmt(p.volume_24h)
    : (pair?.volume?.h24 ? '$' + fmt(pair.volume.h24) : null);

  function swapLine(swaps, buys, sells, txnBuys, txnSells) {
    const b = buys   ?? txnBuys   ?? null;
    const s = sells  ?? txnSells  ?? null;
    const total = (swaps != null && swaps > 0) ? swaps
                : (b != null && s != null) ? b + s : null;
    if (total == null || total === 0) return null;
    const detail = (b != null && s != null) ? ' (' + fmt(b, 0) + '🟢 ' + fmt(s, 0) + '🔴)' : '';
    return fmt(total, 0) + detail;
  }

  const swap5m  = swapLine(p.swaps_5m,  p.buys_5m,  p.sells_5m);
  const swap1h  = swapLine(p.swaps_1h,  p.buys_1h,  p.sells_1h,  pair?.txns?.h1?.buys,  pair?.txns?.h1?.sells);
  const swap6h  = swapLine(p.swaps_6h,  p.buys_6h,  p.sells_6h,  pair?.txns?.h6?.buys,  pair?.txns?.h6?.sells);
  const swap24h = swapLine(p.swaps_24h, p.buys_24h, p.sells_24h, pair?.txns?.h24?.buys, pair?.txns?.h24?.sells);

  // ── Social links ─────────────────────────────────────
  const gmgnTwitter = lk.twitter_username
    ? 'https://x.com/' + lk.twitter_username.split('/')[0]
    : (lk.twitter ? (lk.twitter.startsWith('http') ? lk.twitter : 'https://x.com/' + lk.twitter) : null);
  const gmgnWeb = lk.website  || null;
  const gmgnTg  = lk.telegram || null;

  const dexInfo     = pair?.info || {};
  const dexWebsites = (dexInfo.websites || []).map(w => w.url).filter(Boolean);
  const dexSocials  = dexInfo.socials || [];
  const dexTwitter  = (dexSocials.find(s => s.type === 'twitter') || {}).url;
  const dexTg       = (dexSocials.find(s => s.type === 'telegram') || {}).url;

  const twitterUrl = gmgnTwitter || dexTwitter || null;
  const webUrl     = gmgnWeb     || dexWebsites[0] || null;
  const tgUrl      = gmgnTg      || dexTg || null;

  // ── Developer ────────────────────────────────────────
  const creatorAddr    = dev.creator_address || null;
  const creatorStatus  = dev.creator_token_status === 'creator_close' ? '🚪 Sudah keluar'
    : (nonZero(dev.creator_token_balance)
        ? '🤝 Hold ' + fmt(parseFloat(dev.creator_token_balance), 0) + ' token'
        : (dev.creator_token_status || 'N/A'));
  const createdCount   = st.creator_created_count  || null;
  const openCount      = dev.creator_open_count    ?? null;
  const twitterChanges = Array.isArray(dev.twitter_name_change_history)
    ? dev.twitter_name_change_history.length : 0;
  const deletedPosts   = dev.twitter_del_post_token_count ?? null;
  const devHoldRate    = pct100(st.dev_team_hold_rate);
  const athToken       = dev.ath_token_info;
  const devAthStr      = athToken
    ? athToken.symbol + ' _(ATH MC: $' + fmt(parseFloat(athToken.ath_mc || 0)) + ')_' : null;

  // ── Security ─────────────────────────────────────────
  let mintRenounced, freezeRenounced, ownerRenounced;
  if (isEvm(chain)) {
    ownerRenounced = sec.renounced === 1 ? '✅ Ya'
      : sec.renounced === 0 ? '❌ Tidak'
      : sec.is_renounced === true ? '✅ Ya'
      : sec.is_renounced === false ? '❌ Tidak' : 'N/A';
  } else {
    mintRenounced   = sec.renounced_mint           === true  ? '✅ Ya'
                    : sec.renounced_mint           === false ? '❌ Tidak' : 'N/A';
    freezeRenounced = sec.renounced_freeze_account === true  ? '✅ Ya'
                    : sec.renounced_freeze_account === false ? '❌ Tidak' : 'N/A';
  }

  const honeypot = sec.honeypot === 1  ? '⚠️ Ada'
    : sec.honeypot === 0 ? '✅ Tidak'
    : sec.is_honeypot === true ? '⚠️ Ada'
    : sec.is_honeypot === false ? '✅ Tidak' : '❓ Unknown';

  const openSource = sec.is_open_source === true || sec.open_source === 1 ? '✅ Ya'
    : sec.is_open_source === false || sec.open_source === 0 ? '❌ Tidak' : null;

  const blacklist  = sec.blacklist === 1 ? '⚠️ Ada blacklist' : null;
  const buyTax     = sec.buy_tax  != null ? parseFloat(sec.buy_tax ).toFixed(1) + '%' : '0.0%';
  const sellTax    = sec.sell_tax != null ? parseFloat(sec.sell_tax).toFixed(1) + '%' : '0.0%';
  const canNotSell = sec.can_not_sell > 0 ? '⚠️ ' + sec.can_not_sell + ' wallet tidak bisa jual' : null;
  const secFlags   = Array.isArray(sec.flags) && sec.flags.length > 0 ? sec.flags.join(', ') : null;
  const secAlert   = sec.is_show_alert ? '⚠️ Ada peringatan keamanan' : null;

  let lpBurn = 'N/A';
  const burnRatioSec = parseFloat(sec.burn_ratio || 0);
  if (sec.burn_status === 'burn' || burnRatioSec >= 0.95) {
    lpBurn = '🔥 Burned';
  } else if (burnRatioSec > 0) {
    lpBurn = (burnRatioSec * 100).toFixed(1) + '% burned';
  } else if (sec.lock_summary?.is_locked) {
    const details  = sec.lock_summary.lock_detail || [];
    const lockParts = details.filter(d => !d.is_blackhole).map(d => {
      const pct = d.percent ? (parseFloat(d.percent) * 100).toFixed(1) + '%' : '';
      return (pct ? pct + ' ' : '') + (d.pool || 'Locked');
    });
    const burnParts = details.filter(d => d.is_blackhole).map(d => {
      const pct = d.percent ? (parseFloat(d.percent) * 100).toFixed(1) + '%' : '';
      return pct ? '🔥 ' + pct + ' Burned' : '🔥 Burned';
    });
    const allParts = [...burnParts, ...lockParts];
    lpBurn = allParts.length > 0 ? allParts.join(' · ') : '🔒 Locked';
  } else if (gi.locked_ratio > 0) {
    lpBurn = (gi.locked_ratio * 100).toFixed(1) + '% locked';
  }

  const top10raw = sec.top_10_holder_rate || dev.top_10_holder_rate || st.top_10_holder_rate;
  const top10    = pct100(top10raw);

  // ── Smart Money & wallet tags ─────────────────────────
  const smartW    = wt.smart_wallets      ?? null;
  const renownedW = wt.renowned_wallets   ?? null;
  const sniperW   = wt.sniper_wallets     ?? null;
  const freshW    = wt.fresh_wallets      ?? null;
  const bundlerW  = wt.bundler_wallets    ?? null;
  const ratW      = wt.rat_trader_wallets ?? null;
  const whaleW    = wt.whale_wallets      ?? null;
  const hasSmartData = [smartW, renownedW, sniperW, freshW, bundlerW, ratW, whaleW]
    .some(v => v != null && v > 0);

  // ── Risk Metrics ─────────────────────────────────────
  const sniperHold   = pct100(st.top70_sniper_hold_rate);
  const botDegenRate = pct100(st.bot_degen_rate);
  const bundlerRate  = pct100(st.top_bundler_trader_percentage);
  const entrapRate   = st.top_entrapment_trader_percentage
    ? (parseFloat(st.top_entrapment_trader_percentage) > 0
        ? pct100(st.top_entrapment_trader_percentage) : null) : null;
  const hasRiskData  = [sniperHold, botDegenRate, bundlerRate, entrapRate].some(v => v != null);

  // ── BUILD OUTPUT ─────────────────────────────────────
  const L = [];

  // Header
  L.push('🔍 **' + name + ' (' + symbol + ')** — ' + (CHAIN_LABEL[chain] || chain));
  L.push('📄 `' + ca + '`');
  const metaParts = [];
  if (platform) metaParts.push('🚀 ' + platform);
  metaParts.push('⏱️ Umur: ' + age);
  if (ctoFlag) metaParts.push('🏳️ CTO');
  L.push(metaParts.join(' │ '));

  // DexPaid — selalu tampilkan
  L.push('💳 **DexPaid**: ' + dexPaid);

  // Socials
  const socials = [];
  if (twitterUrl) socials.push('[Twitter](<' + twitterUrl + '>)');
  if (webUrl)     socials.push('[Web](<' + webUrl + '>)');
  if (tgUrl)      socials.push('[Telegram](<' + tgUrl + '>)');
  if (socials.length) L.push('🌐 ' + socials.join(' · '));
  L.push('');

  // ── Market ───────────────────────────────────────────
  L.push('📊 **Market**');
  L.push('• Harga        : ' + priceStr);
  L.push('• Market Cap   : ' + mc);
  if (fdvStr && fdvStr !== mc) L.push('• FDV          : ' + fdvStr);
  if (athStr !== 'N/A') {
    L.push('• ATH Price    : ' + athStr + (athDropPct ? ' _(' + athDropPct + ' dari ATH)_' : ''));
  }
  L.push('• Likuiditas   : ' + liqStr);
  L.push('• Holders      : ' + holders);
  if (circSupply && totalSupply) {
    L.push('• Supply       : ' + circSupply + (circSupply !== totalSupply ? ' / ' + totalSupply + ' total' : ''));
  }
  L.push('');

  // ── Pergerakan ───────────────────────────────────────
  L.push('📈 **Pergerakan**');
  function mkRow(label, chPct, chFallback, vol, swap) {
    const finalPct = chPct != null ? chPct : chFallback;
    const pStr  = finalPct != null ? fmtPct(finalPct) : 'N/A';
    const vStr  = vol  ? ' │ Vol: ' + vol : '';
    const swStr = swap ? ' │ ' + swap + ' swap' : '';
    return '• ' + label + ': ' + pStr + vStr + swStr;
  }
  if (vol5m || (ch5m != null && Math.abs(ch5m) > 0.001)) {
    L.push(mkRow('5m ', ch5m, null, vol5m, swap5m));
  }
  L.push(mkRow('1h ', ch1h, dexCh1h, vol1h, swap1h));
  if (vol6h || ch6h != null || dexCh6h != null) {
    L.push(mkRow('6h ', ch6h, dexCh6h, vol6h, swap6h));
  }
  L.push(mkRow('24h', ch24h, dexCh24h, vol24h, swap24h));
  L.push('');

  // ── Developer ─────────────────────────────────────────
  if (creatorAddr) {
    L.push('👨‍💻 **Developer**');
    L.push('• Wallet   : `' + shortAddr(creatorAddr) + '` → ' + creatorStatus);
    const devStats = [];
    if (createdCount != null && createdCount > 0) devStats.push('buat ' + createdCount + ' token');
    if (openCount    != null && openCount    > 0) devStats.push('buka ' + openCount + '× di token ini');
    if (devStats.length) L.push('• Histori  : ' + devStats.join(', '));
    const devRisks = [];
    if (twitterChanges > 0) devRisks.push('⚠️ ganti nama Twitter ' + twitterChanges + '×');
    if (deletedPosts   > 0) devRisks.push('⚠️ hapus ' + deletedPosts + ' post');
    if (devRisks.length)    L.push('• Twitter  : ' + devRisks.join(' · '));
    if (devHoldRate)        L.push('• Dev hold : ' + devHoldRate);
    if (devAthStr)          L.push('• Best token dev: ' + devAthStr);
    L.push('');
  }

  // ── Security ─────────────────────────────────────────
  if (Object.keys(sec).length > 0) {
    L.push('🔒 **Security**');
    if (isEvm(chain)) {
      L.push('• Owner Renounced : ' + ownerRenounced);
      if (openSource) L.push('• Open Source     : ' + openSource);
    } else {
      L.push('• Mint Renounced   : ' + mintRenounced);
      L.push('• Freeze Renounced : ' + freezeRenounced);
    }
    L.push('• Honeypot         : ' + honeypot);
    L.push('• Buy Tax: ' + buyTax + '   │ Sell Tax: ' + sellTax);
    L.push('• LP Burn/Lock     : ' + lpBurn);
    if (top10)       L.push('• Top 10 Holder    : ' + top10);
    if (blacklist)   L.push('• ' + blacklist);
    if (canNotSell)  L.push('• ' + canNotSell);
    if (secAlert)    L.push('• ' + secAlert);
    if (secFlags)    L.push('• Flags: ' + secFlags);
    L.push('');
  }

  // ── Smart Money & Wallet Tags ─────────────────────────
  if (hasSmartData) {
    L.push('💰 **Smart Money**');
    if (smartW    > 0) L.push('• Smart Wallets  : ' + smartW);
    if (renownedW > 0) L.push('• Renowned       : ' + renownedW);
    if (whaleW    > 0) L.push('• Whale          : ' + whaleW);
    if (sniperW   > 0) L.push('• Sniper         : ' + sniperW);
    if (freshW    > 0) L.push('• Fresh Wallet   : ' + freshW);
    if (bundlerW  > 0) L.push('• Bundler        : ' + bundlerW);
    if (ratW      > 0) L.push('• Rat Trader     : ' + ratW);
    L.push('');
  }

  // ── Risk Metrics ─────────────────────────────────────
  if (hasRiskData) {
    L.push('⚠️ **Risk Metrics**');
    if (sniperHold)   L.push('• Sniper hold : ' + sniperHold);
    if (botDegenRate) L.push('• Bot/Degen   : ' + botDegenRate);
    if (bundlerRate)  L.push('• Bundler %   : ' + bundlerRate);
    if (entrapRate)   L.push('• Entrapment  : ' + entrapRate);
    L.push('');
  }

  L.push('🔗 <https://gmgn.ai/' + chain + '/token/' + ca + '>');
  return L.join('\n');
}


// ── TRENDING (extended: multi-interval) ──────────────────
async function handleTrending(chain, interval) {
  const iv   = interval || '1h';
  const data = await openGet('/v1/market/rank', { chain, interval: iv, limit: 10 });
  const inner = (data && data.data) ? data.data : data;
  const list  = (inner && inner.rank) ? inner.rank : (Array.isArray(inner) ? inner : []);
  if (!list.length) return '❌ Tidak ada data trending untuk ' + chainBadge(chain) + '.';

  const ivLabel = { '1m': '1 Menit', '5m': '5 Menit', '1h': '1 Jam', '6h': '6 Jam', '24h': '24 Jam' }[iv] || iv;
  const L = ['🔥 **Trending (' + ivLabel + ') — ' + chainBadge(chain) + '**\n_(berdasarkan jumlah swap)_', ''];
  list.slice(0, 10).forEach((t, i) => {
    const name  = t.name   || t.symbol || '?';
    const sym   = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
    const ch1   = t.price_change_percent1h  != null ? fmtPct(t.price_change_percent1h)  : null;
    const ch24  = t.price_change_percent24h != null ? fmtPct(t.price_change_percent24h) : null;
    const chStr = ch1 || ch24 || '';
    const price = fmtPrice(t.price);
    const mc    = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    const swaps = t.swaps ? ' | ' + fmt(t.swaps, 0) + ' swaps' : '';
    const bs    = (t.buys && t.sells) ? ' | ' + t.buys + '🟢 ' + t.sells + '🔴' : '';
    const sm    = t.smart_degen_count > 0 ? ' 🧠' + t.smart_degen_count : '';
    L.push((i + 1) + '. **' + name + sym + '** ' + chStr + sm);
    L.push('   ' + price + mc + swaps + bs);
    if (t.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return L.join('\n');
}

// ── SMART MONEY (top traders of token / global) ──────────
async function handleSmartMoney(chain, ca) {
  if (ca) {
    const data = await openGet('/v1/market/token_top_traders', {
      chain, address: ca, limit: 10, order_by: 'profit', direction: 'desc',
    });
    const list = data?.list || (Array.isArray(data) ? data : []);
    if (!list.length) return '🧠 **Smart Traders**\n`' + ca + '`\n\n_Tidak ada data._';

    const L = ['🧠 **Smart Traders** — ' + chainBadge(chain), '`' + ca + '`', ''];
    list.slice(0, 10).forEach((t, i) => {
      const pnl    = t.profit != null
        ? (parseFloat(t.profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(t.profit)) : 'N/A';
      const pnlPct = t.profit_change != null ? fmtPct(parseFloat(t.profit_change) * 100) : '';
      const tags   = (Array.isArray(t.tags) && t.tags.length) ? ' 🏷️ ' + t.tags.slice(0, 3).join(', ') : '';
      const name   = t.name || shortAddr(t.address);
      L.push('**' + (i + 1) + '.** ' + name + tags);
      L.push('    PnL: ' + pnl + (pnlPct ? ' ' + pnlPct : ''));
      L.push('');
    });
    return L.join('\n');
  }

  // Global: pakai trending 1h sebagai proxy
  const data  = await openGet('/v1/market/rank', { chain, interval: '1h', limit: 10 });
  const inner = (data && data.data) ? data.data : data;
  const list  = (inner && inner.rank) ? inner.rank : [];
  if (!list.length) return '💡 **Top Smart Trades**\n_Data tidak tersedia._';

  const L = ['💡 **Top Smart Trades (1h) — ' + chainBadge(chain) + '**', ''];
  list.forEach((t, i) => {
    const name = t.name || t.symbol || '?';
    const ch   = t.price_change_percent1h != null ? fmtPct(t.price_change_percent1h) : '';
    const mc   = t.market_cap ? ' | MC: $' + fmt(t.market_cap) : '';
    const sm   = t.smart_degen_count > 0 ? ' | 🧠' + t.smart_degen_count : '';
    L.push((i + 1) + '. **' + name + '** ' + ch + mc + sm);
    if (t.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return L.join('\n');
}

// ── WALLET (extended: stats 7d/30d + activity) ───────────
async function handleWallet(chain, address, period) {
  const p = period || '7d';
  const [statsRes, actRes] = await Promise.all([
    openGet('/v1/user/wallet_stats', { chain, wallet_address: address, period: p }),
    openGet('/v1/user/wallet_activity', { chain, wallet_address: address, limit: 5 }).catch(() => null),
  ]);

  const w = Array.isArray(statsRes) ? statsRes[0] : statsRes;
  if (!w) throw new Error('Data wallet tidak tersedia di ' + chainBadge(chain) + '.');

  const pLabel = p === '30d' ? '30 Hari' : '7 Hari';
  const pnlRaw = w.realized_profit != null ? parseFloat(w.realized_profit) : null;
  const pnl    = pnlRaw != null ? (pnlRaw >= 0 ? '+' : '') + '$' + fmt(Math.abs(pnlRaw)) : 'N/A';
  const pnlPct = w.realized_profit_pnl != null ? fmtPct(parseFloat(w.realized_profit_pnl) * 100) : 'N/A';
  const winRate= w.pnl_stat?.winrate  != null ? (parseFloat(w.pnl_stat.winrate) * 100).toFixed(1) + '%' : 'N/A';
  const win5x  = w.pnl_stat?.pnl_gt_5x_num  ?? null;
  const win2x  = w.pnl_stat?.pnl_2x_5x_num  ?? null;
  const win0x  = w.pnl_stat?.pnl_0x_2x_num  ?? null;
  const lossH  = w.pnl_stat?.pnl_nd5_0x_num ?? null;
  const totalTk= w.pnl_stat?.token_num       ?? null;
  const buy    = w.buy  ?? '?';
  const sell   = w.sell ?? '?';
  const boughtCost  = nonZero(w.bought_cost)  ? '$' + fmt(w.bought_cost)  : null;
  const soldIncome  = nonZero(w.sold_income)  ? '$' + fmt(w.sold_income)  : null;
  const avgHoldSec  = w.pnl_stat?.avg_holding_period;
  const avgHold     = avgHoldSec != null ? _fmtDuration(avgHoldSec) : null;
  const nativeSymbol= chain === 'sol' ? 'SOL' : (chain === 'eth' || chain === 'base' || chain === 'robinhood') ? 'ETH' : 'BNB';
  const nativeBal   = w.native_balance && parseFloat(w.native_balance) > 0
    ? parseFloat(w.native_balance).toFixed(4) + ' ' + nativeSymbol : null;

  const tags    = w.common?.tags || [];
  const tagStr  = tags.length ? ' 🏷️ ' + tags.join(', ') : '';
  const twitterU= w.common?.twitter_username;
  const fundFrom= w.common?.fund_from;

  const L = [
    '👛 **Analisis Wallet** — ' + chainBadge(chain),
    '`' + address + '`' + tagStr,
  ];
  if (twitterU) L.push('🐦 [@' + twitterU + '](<https://x.com/' + twitterU + '>)');
  if (fundFrom) L.push('💳 Fund dari: ' + fundFrom);
  L.push('');

  L.push('**📊 Statistik Trading (' + pLabel + ')**');
  L.push('• PnL     : ' + pnl + (pnlPct !== 'N/A' ? ' (' + pnlPct + ')' : ''));
  L.push('• Win Rate: ' + winRate);
  L.push('• Trades  : ' + buy + ' buy / ' + sell + ' sell');
  if (totalTk != null) L.push('• Token   : ' + totalTk + ' token ditrade');
  if (boughtCost && soldIncome) L.push('• Volume  : ' + boughtCost + ' beli · ' + soldIncome + ' jual');
  if (avgHold) L.push('• Avg Hold: ' + avgHold);

  if (win5x != null || win2x != null) {
    L.push('');
    L.push('**📈 PnL Breakdown**');
    if (win5x  != null) L.push('• >5x    : ' + win5x + ' token');
    if (win2x  != null) L.push('• 2x–5x  : ' + win2x + ' token');
    if (win0x  != null) L.push('• 0–2x   : ' + win0x + ' token');
    if (lossH  != null) L.push('• Rugi   : ' + lossH + ' token');
  }

  if (nativeBal) { L.push(''); L.push('**💰 Saldo**'); L.push('• Native : ' + nativeBal); }

  // Activity feed
  const acts = actRes?.activities || (Array.isArray(actRes) ? actRes : []);
  if (acts.length) {
    L.push('');
    L.push('**🔄 Aktivitas Terbaru**');
    acts.slice(0, 5).forEach(a => {
      const side  = a.event_type === 'buy' ? '🟢 Buy' : '🔴 Sell';
      const sym   = a.token?.symbol || '?';
      const usd   = a.cost_usd ? '$' + parseFloat(a.cost_usd).toFixed(2) : (a.amount_usd ? '$' + parseFloat(a.amount_usd).toFixed(2) : '');
      const time  = a.timestamp ? fmtTs(a.timestamp) : '';
      const lp    = a.launchpad_platform ? ' [' + a.launchpad_platform + ']' : '';
      L.push('• ' + side + ' **' + sym + '**' + lp + (usd ? ' ' + usd : '') + (time ? ' — ' + time : ''));
    });
  }

  L.push('');
  L.push('🔗 [GMGN Wallet](<https://gmgn.ai/' + chain + '/address/' + address + '>)');
  return L.join('\n');
}

function _fmtDuration(sec) {
  if (sec < 60)     return sec + ' detik';
  if (sec < 3600)   return Math.floor(sec / 60) + ' menit';
  if (sec < 86400)  return Math.floor(sec / 3600) + ' jam';
  return Math.floor(sec / 86400) + ' hari';
}

// ── TRENCHES — new token monitoring ──────────────────────
async function handleTrenches(chain, subtype) {
  const st = subtype || 'new_creation';
  const data = await openPost('/v1/trenches', { chain }, {
    chain, type: st, filters: [], limit: 15,
  });

  // Response always has new_creation / pump / completed regardless of requested type
  const keyMap = { new_creation: 'new_creation', near_completion: 'pump', completed: 'completed' };
  const resKey = keyMap[st] || 'new_creation';
  const inner  = data?.data || data;
  const list   = inner?.[resKey] || [];

  const labelMap = {
    new_creation : '🆕 **Token Baru Launch**',
    near_completion: '⚡ **Near Graduation** (Bonding Curve ~Full)',
    completed    : '🎓 **Sudah Graduate ke DEX**',
  };
  const label = labelMap[st] || '🆕 Token Baru';

  if (!list.length) return label + ' — ' + chainBadge(chain) + '\n\n_Tidak ada data saat ini._';

  const L = [label + ' — ' + chainBadge(chain), ''];
  list.slice(0, 10).forEach((t, i) => {
    const name   = t.name || t.symbol || '?';
    const sym    = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
    const price  = fmtPrice(t.price);
    const mc     = t.usd_market_cap ? '$' + fmt(t.usd_market_cap) : (t.market_cap ? '$' + fmt(t.market_cap) : '');
    const liq    = t.liquidity ? '$' + fmt(t.liquidity) : '';
    const age    = fmtAge(t.created_timestamp || t.open_timestamp);
    const holders= t.holder_count ? fmt(t.holder_count, 0) + ' holder' : '';
    const swaps  = t.swaps_1h ? fmt(t.swaps_1h, 0) + ' swaps/1h' : (t.swaps ? fmt(t.swaps, 0) + ' swaps' : '');
    const sm     = t.smart_degen_count > 0 ? ' | 🧠' + t.smart_degen_count : '';
    const renown = t.renowned_count > 0    ? ' | ⭐' + t.renowned_count : '';
    const lpad   = t.launchpad_platform || t.launchpad || '';
    const rugScore = t.rug_ratio != null ? ' | Rug:' + (parseFloat(t.rug_ratio) * 100).toFixed(0) + '%' : '';
    const mintRen= t.renounced_mint === 1 ? '✅' : (t.renounced_mint === 0 ? '⚠️' : '');

    L.push('**' + (i + 1) + '.** ' + name + sym + (lpad ? ' _[' + lpad + ']_' : ''));
    const line2parts = [price, mc && 'MC:' + mc, liq && 'Liq:' + liq, age && '🕐' + age].filter(Boolean);
    L.push('   ' + line2parts.join(' | '));
    const line3parts = [holders, swaps, sm.trim(), renown.trim(), rugScore.trim(), mintRen && 'Mint:' + mintRen].filter(Boolean);
    if (line3parts.length) L.push('   ' + line3parts.join(' | '));
    if (t.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
  });
  return L.join('\n');
}

// ── SIGNAL FEED ───────────────────────────────────────────
const SIGNAL_LABEL = {
  1: '📊 K-line Spike', 2: '📢 Dex Ad', 3: '🔗 Link Updated',
  4: '📈 Dex Trending', 5: '🚀 Dex Boost', 6: '⚡ Price Spike',
  7: '🏆 Price ATH', 8: '🎯 MC Key Level', 9: '📺 Live', 10: '🚨 Bundler Sell',
  11: '🔄 CTO', 12: '🧠 Smart Buy', 13: '📣 Platform Call',
  17: '🎒 Bags Claim', 18: '🎁 Pump Claim',
};

async function handleSignal(chain) {
  // signal_type 14,15,16 dilarang oleh API (return 400)
  const data = await openPost('/v1/market/token_signal', { chain }, {
    chain,
    groups: [{ signal_type: [1, 6, 7, 10, 11, 12, 13], filters: [], limit: 15 }],
  });

  const list = data?.data || (Array.isArray(data) ? data : []);
  if (!list.length) return '📡 **Signal Feed** — ' + chainBadge(chain) + '\n\n_Tidak ada signal aktif._';

  const L = ['📡 **Signal Feed** — ' + chainBadge(chain), ''];
  list.slice(0, 10).forEach((s, i) => {
    const sigLabel = SIGNAL_LABEL[s.signal_type] || '📌 Signal ' + s.signal_type;
    const name  = s.cur_data?.name || s.cur_data?.symbol || shortAddr(s.token_address);
    const sym   = (s.cur_data?.symbol && s.cur_data?.symbol !== s.cur_data?.name) ? ' (' + s.cur_data.symbol + ')' : '';
    const mc    = s.market_cap    ? 'MC: $' + fmt(s.market_cap) : '';
    const ath   = s.ath           ? 'ATH: $' + fmt(s.ath) : '';
    const trig  = s.trigger_mc    ? 'Trig@$' + fmt(s.trigger_mc) : '';
    const times = s.signal_times  > 1 ? '×' + s.signal_times : '';
    const age   = s.trigger_at    ? fmtTs(s.trigger_at) : '';
    const smBuy = s.cur_data?.smart_degen_count > 0 ? '🧠' + s.cur_data.smart_degen_count : '';

    L.push(sigLabel + ' **' + name + sym + '** ' + times);
    const meta = [mc, ath, trig, smBuy, age].filter(Boolean).join(' | ');
    if (meta) L.push('   ' + meta);
    if (s.token_address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + s.token_address + '>)');
  });
  return L.join('\n');
}

// ── SMART MONEY FEED ──────────────────────────────────────
async function handleSmartMoneyFeed(chain) {
  const data = await openGet('/v1/user/smartmoney', { chain, limit: 15 });
  const list = data?.list || (data?.data?.list) || (Array.isArray(data) ? data : []);
  if (!list.length) return '🧠 **Smart Money Feed** — ' + chainBadge(chain) + '\n\n_Tidak ada data._';

  return _formatWalletFeed('🧠 **Smart Money Feed**', chain, list);
}

// ── KOL FEED ─────────────────────────────────────────────
async function handleKolFeed(chain) {
  const data = await openGet('/v1/user/kol', { chain, limit: 15 });
  const list = data?.list || (data?.data?.list) || (Array.isArray(data) ? data : []);
  if (!list.length) return '⭐ **KOL Feed** — ' + chainBadge(chain) + '\n\n_Tidak ada data._';

  return _formatWalletFeed('⭐ **KOL Feed**', chain, list);
}

function _formatWalletFeed(title, chain, list) {
  const L = [title + ' — ' + chainBadge(chain) + '\n_Transaksi terbaru wallet tagged:_', ''];
  const seen = new Set();
  list.slice(0, 15).forEach(tx => {
    if (!tx.base_address || seen.has(tx.base_address + tx.transaction_hash)) return;
    seen.add(tx.base_address + tx.transaction_hash);

    const mi    = tx.maker_info || {};
    const name  = mi.name || mi.twitter_name || shortAddr(tx.maker);
    const sym   = tx.base_token?.symbol || shortAddr(tx.base_address);
    const side  = tx.side === 'buy' ? '🟢 Buy' : '🔴 Sell';
    const usd   = tx.amount_usd ? '$' + parseFloat(tx.amount_usd).toFixed(2) : '';
    const age   = tx.timestamp ? fmtTs(tx.timestamp) : '';
    const tags  = (Array.isArray(mi.tags) && mi.tags.length) ? ' [' + mi.tags.slice(0, 2).join(', ') + ']' : '';

    L.push(side + ' **' + sym + '** ' + (usd ? usd + ' ' : '') + '← **' + name + '**' + tags);
    if (age) L.push('   ' + age);
    if (tx.base_address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + tx.base_address + '>)');
  });
  return L.join('\n');
}

// ── TOP HOLDERS ───────────────────────────────────────────
async function handleTopHolders(chain, ca) {
  const data = await openGet('/v1/market/token_top_holders', { chain, address: ca, limit: 15 });
  const list = data?.list || data?.data?.list || (Array.isArray(data) ? data : []);
  if (!list.length) return '👥 **Top Holders**\n`' + ca + '`\n\n_Tidak ada data._';

  const L = ['👥 **Top Holders** — ' + chainBadge(chain), '`' + ca + '`', ''];
  list.slice(0, 10).forEach((h, i) => {
    const pct     = h.amount_percentage != null ? (parseFloat(h.amount_percentage) * 100).toFixed(2) + '%' : '?';
    const usd     = h.usd_value  ? '$' + fmt(h.usd_value) : '';
    const upnl    = h.unrealized_profit != null
      ? (parseFloat(h.unrealized_profit) >= 0 ? '+' : '') + '$' + fmt(Math.abs(h.unrealized_profit)) : null;
    const tags    = (Array.isArray(h.tags) && h.tags.length) ? ' 🏷️ ' + h.tags.slice(0, 2).join(', ') : '';
    const maker   = (Array.isArray(h.maker_token_tags) && h.maker_token_tags.length) ? h.maker_token_tags.slice(0, 2).join(', ') : '';
    const name    = h.name || shortAddr(h.address);
    const isSusp  = h.is_suspicious ? ' ⚠️' : '';
    const lastAct = h.last_active_timestamp ? fmtTs(h.last_active_timestamp) : '';

    L.push('**' + (i + 1) + '.** ' + name + tags + isSusp);
    const line2 = [pct + ' hold', usd && usd, upnl && 'uPnL:' + upnl, maker || null].filter(Boolean).join(' | ');
    L.push('   ' + line2);
    if (lastAct) L.push('   Terakhir aktif: ' + lastAct);
    if (h.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/address/' + h.address + '>)');
  });
  return L.join('\n');
}

// ── KLINE CHART (text OHLCV table) ───────────────────────
async function handleChart(chain, ca, resolution) {
  const res  = resolution || '1h';
  const limit = res === '1m' ? 30 : res === '5m' ? 24 : res === '15m' ? 24 : 16;
  const data = await openGet('/v1/market/token_kline', { chain, address: ca, resolution: res, limit });
  const raw  = data?.list || data?.data?.list || (Array.isArray(data) ? data : []);
  if (!raw.length) return '📊 **Chart**\n`' + ca + '`\n\n_Tidak ada data kline._';

  // Ambil token name dari dex jika ada
  const dex  = await dexGet(ca).catch(() => null);
  const name = dex?.pairs?.[0]?.baseToken?.symbol || shortAddr(ca);

  const candles = raw.slice(-16); // max 16 baris
  const prices  = candles.map(c => parseFloat(c.close)).filter(Boolean);
  const priceMin = Math.min(...prices);
  const priceMax = Math.max(...prices);

  const BAR_W = 8;
  const lines = ['📊 **' + name + '** — ' + res + ' chart — ' + chainBadge(chain), '`' + ca + '`', ''];
  lines.push('```');
  lines.push('Time           | Open       | Close      | Chg%  | Vol($)');
  lines.push('─'.repeat(62));

  candles.forEach(c => {
    const ts    = c.time > 9999999999 ? Math.floor(c.time / 1000) : c.time;
    const d     = new Date(ts * 1000);
    const label = (d.getMonth()+1).toString().padStart(2,'0') + '/' +
                  d.getDate().toString().padStart(2,'0') + ' ' +
                  d.getHours().toString().padStart(2,'0') + ':' +
                  d.getMinutes().toString().padStart(2,'0');
    const open  = parseFloat(c.open);
    const close = parseFloat(c.close);
    const chg   = open ? ((close - open) / open * 100) : 0;
    const dir   = chg >= 0 ? '▲' : '▼';
    const vol   = c.volume ? fmt(parseFloat(c.volume)) : '-';
    const chgStr = dir + Math.abs(chg).toFixed(2) + '%';

    const openStr  = fmtPrice(open).padEnd(10);
    const closeStr = fmtPrice(close).padEnd(10);
    const chgPad   = chgStr.padEnd(7);
    lines.push(label + ' | ' + openStr + ' | ' + closeStr + ' | ' + chgPad + '| ' + vol);
  });
  lines.push('```');

  const lastC   = candles[candles.length - 1];
  const firstC  = candles[0];
  const totalChg = firstC && lastC ? ((parseFloat(lastC.close) - parseFloat(firstC.open)) / parseFloat(firstC.open) * 100) : null;
  if (totalChg != null) lines.push('📈 Total ' + limit + ' candle: ' + (totalChg >= 0 ? '+' : '') + totalChg.toFixed(2) + '%');
  lines.push('🔗 [GMGN](<https://gmgn.ai/' + chain + '/token/' + ca + '>)');
  return lines.join('\n');
}

// ── DEV CHECK (created tokens) ────────────────────────────
async function handleDevCheck(chain, wallet) {
  const data = await openGet('/v1/user/created_tokens', { chain, wallet_address: wallet, limit: 20 });
  const inner= data?.data || data;
  const tokens = inner?.tokens || [];

  const L = ['👨‍💻 **Dev Check** — ' + chainBadge(chain), '`' + wallet + '`', ''];

  const athInfo = inner?.creator_ath_info;
  if (athInfo?.ath_token) {
    L.push('🏆 **Best Token (ATH)**');
    L.push('• Token: ' + (athInfo.token_name || athInfo.token_symbol || shortAddr(athInfo.ath_token)));
    L.push('• ATH MC: $' + fmt(athInfo.ath_mc));
    L.push('');
  }

  const openCnt = inner?.open_count;
  const innerCnt = inner?.inner_count;
  const openRatio= inner?.open_ratio;
  if (openCnt != null) {
    L.push('📊 **Statistik Launch**');
    L.push('• Total token dibuat : ' + (innerCnt ?? '?'));
    L.push('• Berhasil grad DEX  : ' + openCnt + (openRatio ? ' (' + openRatio + ')' : ''));
    L.push('');
  }

  if (!tokens.length) {
    L.push('_Tidak ada token yang dibuat oleh wallet ini._');
  } else {
    L.push('**📋 Token Terbaru (' + tokens.length + ' token)**');
    tokens.slice(0, 10).forEach((t, i) => {
      const name  = t.name || t.symbol || shortAddr(t.address);
      const sym   = (t.symbol && t.symbol !== t.name) ? ' (' + t.symbol + ')' : '';
      const mc    = t.usd_market_cap ? '$' + fmt(t.usd_market_cap) : '';
      const ath   = t.ath_market_cap ? 'ATH: $' + fmt(t.ath_market_cap) : '';
      const age   = fmtAge(t.created_timestamp || t.open_timestamp);
      const grad  = t.open_timestamp ? '✅ Grad' : '⏳ Bonding';
      const lpad  = t.launchpad_platform || '';

      L.push('**' + (i + 1) + '.** ' + name + sym + (lpad ? ' [' + lpad + ']' : ''));
      const meta = [mc && 'MC:' + mc, ath, age && '🕐' + age, grad].filter(Boolean).join(' | ');
      if (meta) L.push('   ' + meta);
      if (t.address) L.push('   [GMGN](<https://gmgn.ai/' + chain + '/token/' + t.address + '>)');
    });
  }

  L.push('');
  L.push('🔗 [GMGN Wallet](<https://gmgn.ai/' + chain + '/address/' + wallet + '>)');
  return L.join('\n');
}

// ── DISPATCH ─────────────────────────────────────────────
async function handleGmgnCommand(query) {
  if (!query || typeof query !== 'object') return '❌ Query GMGN tidak valid.';
  const { type, chain, address, interval, period, subtype, resolution } = query;
  try {
    if (type === 'token') {
      let resolvedChain = chain;
      // Auto-detect chain dari DexScreener jika EVM address tanpa chain spesifik
      if (query.autoDetect) {
        const detected = await detectChainFromDex(address);
        if (detected) resolvedChain = detected;
      }
      return await handleTokenInfo(resolvedChain, address);
    }
    if (type === 'trending')       return await handleTrending(chain, interval);
    if (type === 'smart')          return await handleSmartMoney(chain, address);
    if (type === 'wallet')         return await handleWallet(chain, address, period);
    if (type === 'trenches')       return await handleTrenches(chain, subtype);
    if (type === 'signal')         return await handleSignal(chain);
    if (type === 'smartmoney_feed')return await handleSmartMoneyFeed(chain);
    if (type === 'kol_feed')       return await handleKolFeed(chain);
    if (type === 'holders')        return await handleTopHolders(chain, address);
    if (type === 'chart')          return await handleChart(chain, address, resolution);
    if (type === 'devcheck')       return await handleDevCheck(chain, address);
    return [
      '❌ Command GMGN tidak dikenal. Command tersedia:',
      '```',
      'gmgn <CA>                     Analisis token (auto-detect chain)',
      'gmgn <chain> <CA>             eth / bsc / base / sol / robinhood',
      'gmgn trending [chain] [tf]    Trending: 1m 5m 1h 6h 24h',
      'gmgn new [chain] [subtype]    Token baru launch / near / grad',
      'gmgn signal [chain]           Real-time signal (sol/bsc)',
      'gmgn smartmoney [chain]       Feed smart money',
      'gmgn kol [chain]              Feed KOL/influencer',
      'gmgn smart <CA>               Top traders token',
      'gmgn holders <CA>             Top holder list',
      'gmgn chart <CA> [tf]          Kline chart: 1m 5m 1h 4h 1d',
      'gmgn wallet [chain] <addr>    Analisis wallet + aktivitas',
      'gmgn dev <wallet>             Cek token buatan dev',
      '```',
    ].join('\n');
  } catch (err) {
    throw new Error(err?.message || 'Error tidak diketahui');
  }
}

module.exports = { detectGmgnQuery, handleGmgnCommand };
