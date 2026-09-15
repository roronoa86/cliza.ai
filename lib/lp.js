// lib/lp.js — LP Analysis & Calculator  v3
// Sumber data:
//   PRIMARY   : GeckoTerminal (pool detection, quote price, vol h1/h6/h24, actual fee)
//   RAYDIUM   : api-v3.raydium.io (tick spacing, day/week/month APR, price range)
//   METEORA   : dlmm-api.meteora.ag (bin_step, active_id, APR)
//   FALLBACK  : DexScreener (jika GeckoTerminal kosong)
//
// Subcommand:
//   lp <CA> [modal_usd] [range%]   → Analisa LP pool terbaik
//   lp pos <wallet>                → Lihat posisi LP aktif di wallet (Raydium/Meteora)

'use strict';
const https = require('https');

// ── Address helpers ───────────────────────────────────────────────────────────
function isSolAddr(s) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || ''); }
function isEvmAddr(s) { return /^0x[a-fA-F0-9]{40}$/.test(s || ''); }

// ── HTTP GET helper ───────────────────────────────────────────────────────────
function httpGet(url, extraHeaders, timeoutMs) {
  timeoutMs = timeoutMs || 10000;
  return new Promise((resolve) => {
    const hdrs = Object.assign(
      { 'User-Agent': 'BP.AI-Bot/3.0', Accept: 'application/json' },
      extraHeaders || {}
    );
    const req = https.get(url, { headers: hdrs }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

// ── GeckoTerminal headers ─────────────────────────────────────────────────────
function geckoHeaders() {
  const key = process.env.COINGECKO_API_KEY || '';
  const base = { 'User-Agent': 'BP.AI-Bot/3.0', Accept: 'application/json' };
  if (!key) return base;
  return key.startsWith('CG-')
    ? Object.assign({}, base, { 'x-cg-demo-api-key': key })
    : Object.assign({}, base, { 'x-cg-pro-api-key': key });
}

// ── Network / Chain maps ──────────────────────────────────────────────────────
const GECKO_NETWORK = {
  solana: 'sol', eth: 'eth', ethereum: 'eth',
  bsc: 'bsc', 'binance-smart-chain': 'bsc',
  base: 'base', arbitrum: 'arbitrum', 'arbitrum-one': 'arbitrum',
  polygon_pos: 'polygon', polygon: 'polygon',
};
const CHAIN_TO_GECKO = {
  sol: 'solana', eth: 'eth', bsc: 'bsc', base: 'base',
  arbitrum: 'arbitrum', polygon: 'polygon_pos',
};
const CHAIN_LABEL = {
  sol: 'Solana', eth: 'Ethereum', bsc: 'BNB Chain', base: 'Base',
  arbitrum: 'Arbitrum', polygon: 'Polygon',
};

// ── DEX info ──────────────────────────────────────────────────────────────────
const DEX_INFO = {
  meteora:        { label: 'Meteora DLMM',    type: 'clmm', defaultFee: 0.0025 },
  meteora_dlmm:   { label: 'Meteora DLMM',    type: 'clmm', defaultFee: 0.0025 },
  raydium:        { label: 'Raydium AMM',     type: 'amm',  defaultFee: 0.0025 },
  raydium_clmm:   { label: 'Raydium CLMM',   type: 'clmm', defaultFee: 0.0025 },
  raydium_cp:     { label: 'Raydium CPMM',   type: 'amm',  defaultFee: 0.0025 },
  orca:           { label: 'Orca Whirlpool',  type: 'clmm', defaultFee: 0.003  },
  uniswap_v3:     { label: 'Uniswap V3',      type: 'clmm', defaultFee: 0.003  },
  uniswap_v2:     { label: 'Uniswap V2',      type: 'amm',  defaultFee: 0.003  },
  uniswap:        { label: 'Uniswap',         type: 'amm',  defaultFee: 0.003  },
  pancakeswap_v3: { label: 'PancakeSwap V3',  type: 'clmm', defaultFee: 0.0025 },
  pancakeswap:    { label: 'PancakeSwap V2',  type: 'amm',  defaultFee: 0.0025 },
  aerodrome:      { label: 'Aerodrome',       type: 'amm',  defaultFee: 0.003  },
  zerofi:         { label: 'ZeroFi AMM',      type: 'amm',  defaultFee: 0.003  },
  lifinity:       { label: 'Lifinity',        type: 'amm',  defaultFee: 0.002  },
};

function dexInfo(dexId) {
  const raw = (dexId || '').toLowerCase();
  const key = raw.replace(/-/g, '_');
  return DEX_INFO[key] || DEX_INFO[raw] || { label: dexId || 'Unknown DEX', type: 'amm', defaultFee: 0.003 };
}

// ── Parse fee dari nama pool ("WETH / USDC 0.05%" → 0.0005) ──────────────────
function parseFeeFromName(name) {
  if (!name) return null;
  const m = name.match(/(\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  if (isNaN(pct) || pct <= 0 || pct > 10) return null;
  return pct / 100;
}

// ════════════════════════════════════════════════════════════════════════
// ── API FETCHERS ─────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

// GeckoTerminal: daftar pool untuk token CA
async function fetchGeckoPools(ca, network) {
  const tryNetwork = async (slug) => {
    const url = `https://api.geckoterminal.com/api/v2/networks/${slug}/tokens/${ca}/pools?page=1`;
    const d = await httpGet(url, geckoHeaders(), 10000);
    if (d && Array.isArray(d.data) && d.data.length > 0) return parseGeckoPools(d.data, slug);
    return [];
  };

  if (network) {
    const slug = CHAIN_TO_GECKO[network] || network;
    const pools = await tryNetwork(slug);
    if (pools.length > 0) return pools;
  }

  // Tidak tahu chain → coba semua secara paralel
  const results = await Promise.all(['solana', 'eth', 'bsc', 'base'].map(s => tryNetwork(s)));
  const all = [].concat(...results);
  return all.sort((a, b) => b.tvl - a.tvl);
}

function parseGeckoPools(dataArr, networkSlug) {
  return dataArr.map(p => {
    const a = p.attributes || {};
    const r = p.relationships || {};
    const dexId    = r.dex?.data?.id || '';
    const network  = r.network?.data?.id || networkSlug;
    const chain    = GECKO_NETWORK[network] || network;
    const tvl      = parseFloat(a.reserve_in_usd) || 0;
    const vol24h   = parseFloat(a.volume_usd?.h24) || 0;
    const price    = parseFloat(a.base_token_price_usd) || 0;
    const quotePrice = parseFloat(a.quote_token_price_usd) || 0;
    const name     = a.name || '';
    // Pool address: id format = "solana_ADDRESS" or "eth_ADDRESS"
    const poolAddr = p.id.replace(/^[^_]+_/, '');
    const fee      = parseFeeFromName(name) || dexInfo(dexId).defaultFee;
    return { poolId: p.id, poolAddr, name, chain, network: networkSlug || network, dexId, tvl, vol24h, price, quotePrice, fee };
  }).filter(p => p.price > 0).sort((a, b) => b.tvl - a.tvl);
}

// GeckoTerminal: pool DETAIL — quote price akurat, volume per jam, fee aktual
async function fetchGeckoPoolDetail(networkSlug, poolAddr) {
  const url = `https://api.geckoterminal.com/api/v2/networks/${networkSlug}/pools/${poolAddr}`;
  const d = await httpGet(url, geckoHeaders(), 8000);
  if (!d || !d.data) return null;
  const a = d.data.attributes || {};
  return {
    basePrice:    parseFloat(a.base_token_price_usd)   || 0,
    quotePrice:   parseFloat(a.quote_token_price_usd)  || 0,
    reserve:      parseFloat(a.reserve_in_usd)         || 0,
    poolFee:      parseFloat(a.pool_fee_percentage)    || 0,   // aktual dari kontrak
    volM5:        parseFloat(a.volume_usd?.m5)         || 0,
    volM15:       parseFloat(a.volume_usd?.m15)        || 0,
    volM30:       parseFloat(a.volume_usd?.m30)        || 0,
    volH1:        parseFloat(a.volume_usd?.h1)         || 0,
    volH6:        parseFloat(a.volume_usd?.h6)         || 0,
    volH24:       parseFloat(a.volume_usd?.h24)        || 0,
    priceChH1:    parseFloat(a.price_change_percentage?.h1)  || 0,
    priceChH6:    parseFloat(a.price_change_percentage?.h6)  || 0,
    priceChH24:   parseFloat(a.price_change_percentage?.h24) || 0,
  };
}

// Raydium CLMM: tick spacing + APR historis day/week/month
async function fetchRaydiumPool(mint) {
  const url = `https://api-v3.raydium.io/pools/info/mint?mint1=${mint}&poolType=concentrated&poolSortField=default&sortType=desc&pageSize=3&page=1`;
  const d = await httpGet(url, {}, 8000);
  if (!d || !d.success || !d.data?.data?.length) return null;
  const p = d.data.data[0];
  return {
    id:           p.id,
    tickSpacing:  p.config?.tickSpacing    || null,
    feeRate:      p.config?.tradeFeeRate   || null,   // basis points × 10 (1500 = 0.15%)
    feeRateRaw:   p.feeRate                || null,
    price:        p.price                  || null,
    tvl:          p.tvl                    || null,
    // APR historis
    aprDay:       p.day?.feeApr            || null,
    aprWeek:      p.week?.feeApr           || null,
    aprMonth:     p.month?.feeApr          || null,
    volDay:       p.day?.volume            || null,
    volWeek:      p.week?.volume           || null,
    volMonth:     p.month?.volume          || null,
    feesDay:      p.day?.volumeFee         || null,
    feesWeek:     p.week?.volumeFee        || null,
    // Price range 24h = proxy liquidity depth
    priceMinDay:  p.day?.priceMin          || null,
    priceMaxDay:  p.day?.priceMax          || null,
    priceMinWeek: p.week?.priceMin         || null,
    priceMaxWeek: p.week?.priceMax         || null,
  };
}

// Raydium CLMM: posisi wallet
async function fetchRaydiumPositions(wallet) {
  // Try several endpoints
  const urls = [
    `https://api-v3.raydium.io/main/position/list?wallet=${wallet}`,
    `https://api-v3.raydium.io/pools/position/list?owner=${wallet}`,
  ];
  for (const url of urls) {
    const d = await httpGet(url, {}, 8000);
    if (d && d.success && Array.isArray(d.data)) return d.data;
  }
  return [];
}

// Meteora DLMM: bin_step, APR, fee dari search
async function fetchMeteoraPools(ca) {
  const d = await httpGet(
    `https://dlmm-api.meteora.ag/pair/all_by_groups?page=0&limit=5&sort_key=tvl&order_by=desc&search_term=${ca}`,
    {}, 10000
  );
  if (!d || !Array.isArray(d.groups)) return [];
  const pairs = [];
  for (const g of d.groups) { if (Array.isArray(g.pairs)) pairs.push(...g.pairs); }
  return pairs
    .filter(p => p && p.current_price > 0)
    .map(p => ({
      address:     p.address,
      name:        p.name,
      binStep:     p.bin_step        || null,
      feePct:      p.base_fee_percentage || null,
      fees24h:     parseFloat(p.fees_24h)         || 0,
      feesHour:    parseFloat(p.fees_hour)         || 0,
      volume24h:   parseFloat(p.trade_volume_usd)  || 0,
      apr:         parseFloat(p.apr)               || 0,
      apy:         parseFloat(p.apy)               || 0,
      tvl:         parseFloat(p.liquidity)         || 0,
      currentPrice: parseFloat(p.current_price)    || 0,
      activeId:    p.active_id       || null,
    }));
}

// Meteora: posisi wallet
async function fetchMeteoraPositions(wallet) {
  const d = await httpGet(
    `https://dlmm-api.meteora.ag/position/${wallet}`,
    {}, 8000
  );
  if (!d || !Array.isArray(d)) return [];
  return d;
}

// DexScreener: fallback pool detection
async function fetchDexScreenerPools(ca) {
  const d = await httpGet(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, {}, 10000);
  if (!d || !Array.isArray(d.pairs)) return [];
  return d.pairs
    .filter(p => parseFloat(p.priceUsd) > 0)
    .sort((a, b) => (parseFloat(b.liquidity?.usd) || 0) - (parseFloat(a.liquidity?.usd) || 0))
    .map(p => ({
      poolId:    p.pairAddress,
      poolAddr:  p.pairAddress,
      name:      `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      chain:     p.chainId === 'solana' ? 'sol' : p.chainId,
      network:   p.chainId,
      dexId:     p.dexId || '',
      tvl:       parseFloat(p.liquidity?.usd) || 0,
      vol24h:    parseFloat(p.volume?.h24)    || 0,
      price:     parseFloat(p.priceUsd)       || 0,
      quotePrice: 0,
      fee:       dexInfo(p.dexId).defaultFee,
    }));
}

// ════════════════════════════════════════════════════════════════════════
// ── MATH ──────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

// CLMM: token ratio via sqrt-price formula (Uniswap V3)
function clmmTokenRatio(price, lowerPrice, upperPrice, modal) {
  if (price <= lowerPrice) return { amountA: modal, amountB: 0, ratioA: 100, ratioB: 0 };
  if (price >= upperPrice) return { amountA: 0, amountB: modal, ratioA: 0, ratioB: 100 };
  const P  = Math.sqrt(price);
  const Pa = Math.sqrt(lowerPrice);
  const Pb = Math.sqrt(upperPrice);
  const Lx = (P * Pb) / (Pb - P);
  const Ly = (P - Pa);
  const valA = Lx * price;
  const valB = Ly;
  const total = valA + valB;
  if (total === 0) return { amountA: modal / 2, amountB: modal / 2, ratioA: 50, ratioB: 50 };
  const ratioA = (valA / total) * 100;
  const ratioB = (valB / total) * 100;
  return { amountA: (ratioA / 100) * modal, amountB: (ratioB / 100) * modal, ratioA, ratioB };
}

// AMM V2: 50/50
function ammTokenRatio(modal) {
  return { amountA: modal / 2, amountB: modal / 2, ratioA: 50, ratioB: 50 };
}

// Impermanent Loss
function calcIL(priceNow, priceNew, lowerPrice, upperPrice, type) {
  if (type !== 'clmm') {
    const r = priceNew / priceNow;
    return { il: ((2 * Math.sqrt(r) / (1 + r)) - 1) * 100, outOfRange: false };
  }
  const inRange = priceNew >= lowerPrice && priceNew <= upperPrice;
  const r = priceNew / priceNow;
  const ilBase = (2 * Math.sqrt(r) / (1 + r)) - 1;
  if (!inRange) {
    if (priceNew < lowerPrice) {
      const rEdge = lowerPrice / priceNow;
      const ilEdge = (2 * Math.sqrt(rEdge) / (1 + rEdge)) - 1;
      const extraDrop = (priceNew - lowerPrice) / lowerPrice;
      return { il: (ilEdge + extraDrop * 0.5) * 100, outOfRange: true };
    } else {
      const rEdge = upperPrice / priceNow;
      const ilEdge = (2 * Math.sqrt(rEdge) / (1 + rEdge)) - 1;
      const extraGain = (priceNew - upperPrice) / upperPrice;
      return { il: (ilEdge - extraGain * 0.5) * 100, outOfRange: true };
    }
  }
  const rangePct = (upperPrice - lowerPrice) / priceNow;
  const cf = Math.min(2.5, 0.5 / Math.max(rangePct, 0.05));
  return { il: ilBase * cf * 100, outOfRange: false };
}

// Fee APR
function calcFeeApr(vol24h, fee, tvl) {
  if (!tvl) return 0;
  return (vol24h * fee / tvl) * 365 * 100;
}

// Current tick dari harga
function priceToTick(price) {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

// Tick ke harga
function tickToPrice(tick) {
  return Math.pow(1.0001, tick);
}

// Jumlah tick dalam range
function ticksInRange(lower, upper, spacing) {
  const lo = Math.round(priceToTick(lower) / spacing) * spacing;
  const hi = Math.round(priceToTick(upper) / spacing) * spacing;
  return Math.max(0, (hi - lo) / spacing);
}

// Jumlah bin Meteora dalam range
function binsInRange(lowerPrice, upperPrice, binStep) {
  if (!binStep) return null;
  // Setiap bin = perubahan harga sebesar binStep bps
  const ratio = upperPrice / lowerPrice;
  const bins  = Math.round(Math.log(ratio) / Math.log(1 + binStep / 10000));
  return bins;
}

// ════════════════════════════════════════════════════════════════════════
// ── FORMATTERS ────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs === 0) return '0';
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  if (abs >= 1)   return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(4);
  const s = n.toPrecision(4);
  return parseFloat(s).toString();
}

function fmtUsd(n)  { return (n > 0 || n < 0) ? '$' + fmt(n) : '$0'; }

function fmtPrice(n) {
  if (!n || isNaN(n)) return '—';
  if (n >= 1000)    return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 1)       return '$' + n.toFixed(4);
  if (n >= 0.001)   return '$' + n.toFixed(6);
  if (n >= 0.000001) return '$' + n.toFixed(8);
  return '$' + n.toExponential(4);
}

function fmtAmt(n) {
  if (!n || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (abs >= 1)   return n.toFixed(2);
  return n.toPrecision(4);
}

function fmtPct(n, sign) {
  if (isNaN(n)) return '—';
  const s = (sign !== false && n > 0) ? '+' : '';
  return s + n.toFixed(2) + '%';
}

function aprBadge(apr) {
  if (!apr) return '';
  if (apr >= 100) return ' 🔥';
  if (apr >= 50)  return ' ✨';
  if (apr >= 20)  return ' 🟢';
  return '';
}

// ════════════════════════════════════════════════════════════════════════
// ── VOLATILITY MATH  (Parkinson estimator) ───────────────────────────────
// ════════════════════════════════════════════════════════════════════════

/**
 * σ_daily dari high-low range satu periode.
 * Parkinson's formula: σ = ln(H/L) / (2√ln2)
 * Multi-day: σ_daily = ln(H/L) / (√days × 2√ln2)
 */
function parkinsonSigma(high, low, days) {
  if (!high || !low || high <= low) return null;
  days = days || 1;
  return Math.log(high / low) / (Math.sqrt(days) * 2 * Math.sqrt(Math.LN2));
}

/**
 * Gabungkan σ_daily dari dua periode (1d & 7d) — weight by sqrt(n).
 * Jika salah satu null, pakai yang ada saja.
 */
function blendSigma(sigma1d, sigma7d) {
  if (sigma1d && sigma7d) return (sigma1d + sigma7d * Math.sqrt(7)) / (1 + Math.sqrt(7));
  return sigma1d || sigma7d || 0.05; // default 5% jika tidak ada data
}

/**
 * Hitung half-width range optimal.
 * halfWidth = k × σ_daily × √horizon
 * k=1.5 (default) memberikan ~87% probabilitas in-range selama horizon hari.
 */
function optimalHalfWidth(sigmaDaily, horizonDays, k) {
  k = k || 1.5;
  return k * sigmaDaily * Math.sqrt(horizonDays);
}

// ════════════════════════════════════════════════════════════════════════
// ── P&L MATH (CLMM)  ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

/**
 * Hitung nilai posisi CLMM pada harga P_new.
 * Menggunakan virtual-liquidity formula, bukan aproksimasi V2.
 * Returns { valueQuote, amountA, amountB }
 * amountA dalam satuan token A, amountB dalam satuan token B.
 * valueQuote = amountA × P_new + amountB  (dalam USD jika P dalam USD)
 */
function clmmPositionValue(P_entry, P_now, P_lower, P_upper, modalUsd) {
  // Hitung liquidity L dari modal di harga entry
  function liquidity(P, Pa, Pb, modal) {
    if (P <= Pa) {
      // Full token A — L = modal / (1/√Pa - 1/√Pb)
      const denom = 1 / Math.sqrt(Pa) - 1 / Math.sqrt(Pb);
      return denom > 0 ? modal / denom : 0;
    }
    if (P >= Pb) {
      // Full token B — L = modal / (√Pb - √Pa)
      const denom = Math.sqrt(Pb) - Math.sqrt(Pa);
      return denom > 0 ? modal / denom : 0;
    }
    // In range — split via sqrt-price formula
    const sp  = Math.sqrt(P);
    const spa = Math.sqrt(Pa);
    const spb = Math.sqrt(Pb);
    // L from token A side: L = amountA / (1/sp - 1/spb)
    // L from token B side: L = amountB / (sp - spa)
    // modal = L*(1/sp - 1/spb)*P + L*(sp - spa)
    // Solve for L:
    const Lx = (sp * spb) / (spb - sp); // per unit token A → value factor
    const Ly = sp - spa;                 // per unit token B → value factor
    const ratio_A = Lx * P;
    const ratio_B = Ly;
    const total = ratio_A + ratio_B;
    if (total === 0) return 0;
    // L normalised so total value = modal
    return modal / total;
  }

  const L = liquidity(P_entry, P_lower, P_upper, modalUsd);
  if (L === 0) return { valueQuote: 0, amountA: 0, amountB: 0, inRange: false };

  // Hitung token amounts pada harga P_now
  let amountA, amountB;
  const spa = Math.sqrt(P_lower);
  const spb = Math.sqrt(P_upper);

  if (P_now <= P_lower) {
    amountA = L * (1 / spa - 1 / spb);
    amountB = 0;
  } else if (P_now >= P_upper) {
    amountA = 0;
    amountB = L * (spb - spa);
  } else {
    const sp = Math.sqrt(P_now);
    amountA = L * (1 / sp - 1 / spb);
    amountB = L * (sp - spa);
  }

  const valueQuote = amountA * P_now + amountB;
  const inRange = P_now > P_lower && P_now < P_upper;
  return { valueQuote, amountA, amountB, inRange };
}

/**
 * Hitung V_hodl: nilai kalau hanya HODL token awal (tidak masuk LP).
 * Deposit rasio mengikuti clmmTokenRatio di entry price.
 */
function vHodl(P_entry, P_now, P_lower, P_upper, modalUsd) {
  const entryPos = clmmPositionValue(P_entry, P_entry, P_lower, P_upper, modalUsd);
  // Units dideposit: amountA token A + amountB token B
  const hodlValue = entryPos.amountA * P_now + entryPos.amountB;
  return hodlValue;
}

// ════════════════════════════════════════════════════════════════════════
// ── DETECT QUERY ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

function detectLpQuery(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  if (!/^lp\b/i.test(t)) return null;
  const parts = t.split(/\s+/);
  const sub = (parts[1] || '').toLowerCase();

  // lp pos <wallet>
  if (/^pos(ition)?$/.test(sub)) {
    const wallet = parts[2] || '';
    if (!isSolAddr(wallet) && !isEvmAddr(wallet)) return null;
    return { type: 'position', wallet };
  }

  // lp pnl <CA> <entry_price> <modal> [range%] [days]
  if (sub === 'pnl') {
    const ca = parts[2] || '';
    if (!isSolAddr(ca) && !isEvmAddr(ca)) return null;
    const entryPrice = parseFloat(parts[3]);
    if (!entryPrice || entryPrice <= 0) return null;
    const modal    = parseFloat(parts[4]) || 100;
    const rangePct = parseFloat(parts[5]) || 20;
    const days     = parseFloat(parts[6]) || null;
    return { type: 'pnl', ca, entryPrice, modal, rangePct, days };
  }

  // lp rebalance <CA>
  if (/^reb(alance)?$/.test(sub)) {
    const ca = parts[2] || '';
    if (!isSolAddr(ca) && !isEvmAddr(ca)) return null;
    return { type: 'rebalance', ca };
  }

  // lp <CA> [modal] [range%]
  const ca = parts[1] || '';
  if (!isSolAddr(ca) && !isEvmAddr(ca)) return null;
  const modal    = parseFloat(parts[2]) || 100;
  const rangePct = parseFloat(parts[3]) || 20;
  return { type: 'analyze', ca, modal, rangePct };
}

// ════════════════════════════════════════════════════════════════════════
// ── HANDLE COMMAND ────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════

async function handleLpCommand(query) {
  if (query.type === 'position')  return handleLpPosition(query.wallet);
  if (query.type === 'pnl')       return handleLpPnl(query);
  if (query.type === 'rebalance') return handleLpRebalance(query);
  return handleLpAnalyze(query);
}

// ── LP ANALYZE ────────────────────────────────────────────────────────────────
async function handleLpAnalyze({ ca, modal, rangePct }) {
  modal    = modal    || 100;
  rangePct = rangePct || 20;

  const guessChain = isEvmAddr(ca) ? 'eth' : 'sol';

  // 1. Pool list dari GeckoTerminal
  let pools = await fetchGeckoPools(ca, guessChain);
  if (pools.length === 0) {
    const fb = await fetchDexScreenerPools(ca);
    pools = fb;
  }
  if (pools.length === 0) {
    throw new Error(`Token \`${ca.slice(0,8)}…\` tidak ditemukan di GeckoTerminal maupun DexScreener. Pastikan CA benar dan sudah terdaftar di pool publik.`);
  }

  const best = pools[0];
  const { chain, network, dexId, poolAddr, name: poolName, tvl, fee: feeGuess } = best;
  let { price, quotePrice } = best;
  let vol24h  = best.vol24h;
  let fee     = feeGuess;

  // 2. Ambil pool detail (quote price akurat, hourly volume, actual fee) + protocol data secara paralel
  const isMeteora = dexId.toLowerCase().includes('meteora');
  const isRaydium = dexId.toLowerCase().replace(/-/g,'_').includes('raydium_clmm');
  const netSlug   = CHAIN_TO_GECKO[chain] || network || 'solana';

  const [detail, raydiumData, meteoraData] = await Promise.all([
    fetchGeckoPoolDetail(netSlug, poolAddr),
    (chain === 'sol' && isRaydium) ? fetchRaydiumPool(ca) : Promise.resolve(null),
    isMeteora ? fetchMeteoraPools(ca) : Promise.resolve([]),
  ]);

  // Override dengan data yang lebih akurat
  if (detail) {
    if (detail.basePrice  > 0)  price      = detail.basePrice;
    if (detail.quotePrice > 0)  quotePrice = detail.quotePrice;
    if (detail.volH24     > 0)  vol24h     = detail.volH24;
    if (detail.poolFee    > 0)  fee        = detail.poolFee / 100;  // % → desimal
  }

  const dex = dexInfo(dexId);

  // Fee override dari Meteora
  let meteora = null;
  if (isMeteora && meteoraData.length > 0) {
    meteora = meteoraData[0];
    if (meteora.feePct > 0) fee = meteora.feePct / 100;
  }

  // Fee override dari Raydium config
  let raydium = null;
  if (isRaydium && raydiumData) {
    raydium = raydiumData;
    if (raydium.feeRate > 0) fee = raydium.feeRate / 1e6; // basis points × 10 → desimal
  }

  // 3. Range
  const factor     = rangePct / 100;
  const lowerPrice = price * (1 - factor);
  const upperPrice = price * (1 + factor);

  // 4. Token ratio & REAL AMOUNTS
  const ratio = dex.type === 'clmm'
    ? clmmTokenRatio(price, lowerPrice, upperPrice, modal)
    : ammTokenRatio(modal);

  const tokA = (poolName.split('/')[0] || 'Token A').trim();
  const tokB = (poolName.split('/')[1] || 'Token B').trim();

  // Real token units
  const unitsA = price      > 0 ? ratio.amountA / price      : null;
  const unitsB = quotePrice > 0 ? ratio.amountB / quotePrice : null;

  // 5. IL scenarios
  const scenarios = [
    { label: '+20%',  mult: 1.2  },
    { label: '+50%',  mult: 1.5  },
    { label: '+100%', mult: 2.0  },
    { label: '-20%',  mult: 0.8  },
    { label: '-50%',  mult: 0.5  },
    { label: '-75%',  mult: 0.25 },
  ];
  const ilRows = scenarios.map(s => {
    const { il, outOfRange } = calcIL(price, price * s.mult, lowerPrice, upperPrice, dex.type);
    return { label: s.label, pNew: price * s.mult, il, outOfRange };
  });

  // 6. Fee stats
  const feeApr  = calcFeeApr(vol24h, fee, tvl);
  const feeH1   = detail ? detail.volH1  * fee : null;
  const feeH6   = detail ? detail.volH6  * fee : null;
  const feeH24  = vol24h * fee;
  const feeDay  = modal * feeApr / 100 / 365;
  const feeMo   = modal * feeApr / 100 / 12;

  // APR historis
  const aprDay   = raydium?.aprDay   || meteora?.apr  || null;
  const aprWeek  = raydium?.aprWeek  || null;
  const aprMonth = raydium?.aprMonth || null;

  // Tick / bin info
  let tickInfo = null;
  if (dex.type === 'clmm') {
    const ts = raydium?.tickSpacing || null;
    if (ts) {
      const curTick   = priceToTick(price);
      const tickLow   = Math.round(priceToTick(lowerPrice) / ts) * ts;
      const tickHigh  = Math.round(priceToTick(upperPrice) / ts) * ts;
      const numTicks  = Math.max(0, (tickHigh - tickLow) / ts);
      tickInfo = { spacing: ts, curTick, tickLow, tickHigh, numTicks };
    }
    if (meteora?.binStep) {
      const bins = binsInRange(lowerPrice, upperPrice, meteora.binStep);
      tickInfo = { binStep: meteora.binStep, bins, activeId: meteora.activeId };
    }
  }

  // Price range 24h/7d (liquidity depth proxy)
  const priceRange24h = raydium ? { min: raydium.priceMinDay, max: raydium.priceMaxDay } : null;
  const priceRange7d  = raydium ? { min: raydium.priceMinWeek, max: raydium.priceMaxWeek } : null;

  // ── FORMAT OUTPUT ──────────────────────────────────────────────────────────
  const chainEmoji = { sol:'🟣', eth:'🔷', bsc:'🟡', base:'🔵', arbitrum:'🔴', polygon:'🟪' };
  const ce = chainEmoji[chain] || '⬜';

  const L = [];
  const p = (...a) => L.push(...a);

  // Header
  p(`💧 **LP Analysis — ${tokA}**`);
  p(`${ce} ${CHAIN_LABEL[chain] || chain} · **${dex.label}**`);
  p(`Pool: \`${poolName}\``);
  p('');

  // ── Data Pool ──
  p(`**📊 Data Pool**`);
  p(`• Harga       : **${fmtPrice(price)}**`);
  if (detail?.priceChH1 !== undefined) {
    const ch = detail.priceChH1;
    const chBadge = ch > 0 ? '▲' : ch < 0 ? '▼' : '→';
    p(`• Perubahan   : ${chBadge} 1h **${fmtPct(ch)}** · 6h **${fmtPct(detail.priceChH6)}** · 24h **${fmtPct(detail.priceChH24)}**`);
  }
  p(`• TVL         : **${fmtUsd(tvl)}**`);
  p(`• Volume 24h  : **${fmtUsd(vol24h)}**`);
  if (detail?.volH1) p(`• Volume 1h   : **${fmtUsd(detail.volH1)}**`);
  p(`• Fee Tier    : **${(fee * 100).toFixed(3)}%**`);
  if (tickInfo?.spacing)  p(`• Tick Spacing: **${tickInfo.spacing}** · Tick Sekarang: ${tickInfo.curTick.toLocaleString()}`);
  if (tickInfo?.binStep)  p(`• Bin Step    : **${tickInfo.binStep} bps** · Active Bin ID: ${tickInfo.activeId || '—'}`);
  p('');

  // ── Range LP ──
  p(`**📐 Range LP** — Modal **${fmtUsd(modal)}** · ±${rangePct}% dari harga`);
  p(`• 🔴 Lower  : **${fmtPrice(lowerPrice)}**`);
  p(`• 🟢 Tengah : **${fmtPrice(price)}** ← harga sekarang`);
  p(`• 🔴 Upper  : **${fmtPrice(upperPrice)}**`);
  if (tickInfo?.numTicks)  p(`• Ticks dalam range: **${tickInfo.numTicks}** tick`);
  if (tickInfo?.bins)      p(`• Bins dalam range : **${tickInfo.bins}** bin`);
  p('');

  // ── Komposisi Deposit ──
  p(`**💰 Komposisi Deposit**`);
  p(dex.type === 'clmm'
    ? `_(CLMM: rasio bergerak sesuai posisi harga dalam range)_`
    : `_(AMM V2: selalu 50/50)_`);
  p(`• **${tokA}** ${fmtUsd(ratio.amountA).padStart(10)}  (${ratio.ratioA.toFixed(1)}%) ${unitsA !== null ? '→ ~**' + fmtAmt(unitsA) + ' ' + tokA + '**' : ''}`);
  p(`• **${tokB}** ${fmtUsd(ratio.amountB).padStart(10)}  (${ratio.ratioB.toFixed(1)}%) ${unitsB !== null ? '→ ~**' + fmtAmt(unitsB) + ' ' + tokB + '**' : ''}`);
  p(`• **Total**  ${fmtUsd(modal).padStart(10)}  (100%)`);
  p('');

  // ── Fee & APR ──
  p(`**💸 Pendapatan Fee**`);
  if (feeH1 !== null) p(`• Fee 1 jam lalu   : **${fmtUsd(feeH1)}** _(dari vol ${fmtUsd(detail?.volH1)})_`);
  if (feeH6 !== null) p(`• Fee 6 jam lalu   : **${fmtUsd(feeH6)}** _(dari vol ${fmtUsd(detail?.volH6)})_`);
  p(`• Fee 24h pool     : **${fmtUsd(feeH24)}** _(dari vol ${fmtUsd(vol24h)})_`);
  p('');
  p(`• Est. APR sekarang: **${fmtPct(feeApr)}**${aprBadge(feeApr)} _(Vol24h × Fee ÷ TVL × 365)_`);
  if (aprDay   != null) p(`• APR 1 hari       : **${fmtPct(aprDay)}**${aprBadge(aprDay)}`);
  if (aprWeek  != null) p(`• APR 7 hari       : **${fmtPct(aprWeek)}**${aprBadge(aprWeek)}`);
  if (aprMonth != null) p(`• APR 30 hari      : **${fmtPct(aprMonth)}**${aprBadge(aprMonth)}`);
  p(`• Fee/hari (modal ${fmtUsd(modal)}): **${fmtUsd(feeDay)}**`);
  p(`• Fee/bulan         : **${fmtUsd(feeMo)}**`);
  if (meteora?.fees24h > 0) p(`• Fee 24h pool (Meteora): **${fmtUsd(meteora.fees24h)}**`);
  p('');

  // ── Liquidity Depth (price range proxy) ──
  if (priceRange24h?.min && priceRange24h?.max) {
    p(`**📊 Kedalaman Likuiditas**`);
    p(`• Range harga 24h  : ${fmtPrice(priceRange24h.min)} – ${fmtPrice(priceRange24h.max)}`);
    if (priceRange7d?.min) p(`• Range harga 7 hari: ${fmtPrice(priceRange7d.min)} – ${fmtPrice(priceRange7d.max)}`);
    // Apakah range LP berada dalam zona aktif
    const inLiqZone = lowerPrice >= priceRange24h.min && upperPrice <= priceRange24h.max;
    p(inLiqZone
      ? `• Status range LP   : 🟢 **Berada di zona aktif 24h** — likuiditas ramai di sini`
      : `• Status range LP   : 🟡 **Sebagian di luar zona aktif 24h** — pertimbangkan penyesuaian range`);
    p('');
  }

  // ── IL Simulasi ──
  p(`**📉 Simulasi Impermanent Loss** vs HODL`);
  for (const r of ilRows) {
    const badge = r.outOfRange ? '🔴' : r.il < -5 ? '🟡' : '🟢';
    const oor   = r.outOfRange ? ' _(out-of-range)_' : '';
    p(`• ${r.label.padEnd(5)} → ${fmtPrice(r.pNew).padEnd(14)}  IL **${fmtPct(r.il, false)}** ${badge}${oor}`);
  }
  if (dex.type === 'clmm') p(`_🔴 Out-of-range = posisi stop earning fee, konversi penuh ke satu sisi_`);
  p('');

  // ── Pool Alternatif ──
  if (pools.length > 1) {
    p(`**🔀 Pool Lain yang Tersedia**`);
    pools.slice(1, 5).forEach(pl => {
      const d   = dexInfo(pl.dexId);
      const apr = calcFeeApr(pl.vol24h, pl.fee, pl.tvl);
      p(`• **${d.label}** — TVL ${fmtUsd(pl.tvl)} · Vol ${fmtUsd(pl.vol24h)} · APR ~${fmtPct(apr)}${aprBadge(apr)}`);
    });
    p('');
  }

  // ── Tips ──
  p(`**📌 Tips**`);
  if (dex.type === 'clmm') {
    p(`• Range sempit ±5-10% → fee besar, tapi sering out-of-range kalau volatile`);
    p(`• Range lebar ±30-50% → lebih aman, modal kurang efisien`);
    p(`• Token baru/volatile: mulai ±20-30%, cek ulang 24-48 jam`);
    if (isMeteora) p(`• Meteora: shape **spot** = merata, **bid-ask** = skew ke satu sisi`);
  } else {
    p(`• AMM V2: tidak ada range, IL rumus klasik. Cocok untuk pair stabil`);
    p(`• Pertimbangkan CLMM (Raydium/Meteora) untuk efisiensi modal lebih tinggi`);
  }
  p(`• Cek posisi LP aktif kamu: \`lp pos <wallet>\``);
  p('');

  const sources = ['GeckoTerminal'];
  if (raydium)  sources.push('Raydium API');
  if (meteora)  sources.push('Meteora DLMM');
  p(`_📡 ${sources.join(' + ')} · estimasi, bukan saran investasi_`);

  return L.join('\n');
}

// ── LP POSITION TRACKER ───────────────────────────────────────────────────────
async function handleLpPosition(wallet) {
  const isSol = isSolAddr(wallet);
  const isEvm = isEvmAddr(wallet);

  const L = [];
  const p = (...a) => L.push(...a);

  p(`**🗂️ LP Positions — \`${wallet.slice(0,8)}…${wallet.slice(-4)}\`**`);
  p('');

  let found = 0;

  if (isSol) {
    // Raydium CLMM positions
    const raydiumPos = await fetchRaydiumPositions(wallet);
    if (raydiumPos.length > 0) {
      found += raydiumPos.length;
      p(`**Raydium CLMM (${raydiumPos.length} posisi)**`);
      for (const pos of raydiumPos.slice(0, 10)) {
        const sym  = `${pos.mintA?.symbol || '?'}/${pos.mintB?.symbol || '?'}`;
        const liq  = pos.liquidity ? fmtUsd(parseFloat(pos.liquidity)) : '—';
        const fees = pos.rewardInfos?.reduce((s, r) => s + parseFloat(r.pendingReward || 0), 0);
        p(`• **${sym}** — Likuiditas: ${liq}${fees > 0 ? ' · Fee belum klaim: ' + fmtUsd(fees) : ''}`);
        if (pos.priceLower && pos.priceUpper) {
          p(`  Range: ${fmtPrice(pos.priceLower)} – ${fmtPrice(pos.priceUpper)}`);
        }
      }
      p('');
    }

    // Meteora DLMM positions
    const meteoraPos = await fetchMeteoraPositions(wallet);
    if (meteoraPos.length > 0) {
      found += meteoraPos.length;
      p(`**Meteora DLMM (${meteoraPos.length} posisi)**`);
      for (const pos of meteoraPos.slice(0, 10)) {
        const sym   = pos.name || pos.pair_name || `${pos.mint_x?.slice(0,4)}…/${pos.mint_y?.slice(0,4)}…`;
        const liq   = pos.total_liquidity_value ? fmtUsd(parseFloat(pos.total_liquidity_value)) : '—';
        const feeA  = parseFloat(pos.fee_x || 0);
        const feeB  = parseFloat(pos.fee_y || 0);
        const hasF  = feeA > 0 || feeB > 0;
        p(`• **${sym}** — Nilai: ${liq}${hasF ? ' · Fee pending: ' + fmtAmt(feeA) + '/' + fmtAmt(feeB) : ''}`);
        if (pos.lower_bin_id && pos.upper_bin_id) {
          p(`  Bin range: ${pos.lower_bin_id} – ${pos.upper_bin_id}`);
        }
      }
      p('');
    }
  }

  if (found === 0) {
    p(`_Tidak ada posisi LP yang ditemukan untuk wallet ini._`);
    p(`_(Hanya mendukung Raydium CLMM dan Meteora DLMM via public API)_`);
  }

  return L.join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// ── LP PNL ────────────────────────────────────────────────────────────────
// Syntax: lp pnl <CA> <entry_price> <modal> [range%] [days]
// ════════════════════════════════════════════════════════════════════════

async function handleLpPnl({ ca, entryPrice, modal, rangePct, days }) {
  modal    = modal    || 100;
  rangePct = rangePct || 20;

  const guessChain = isEvmAddr(ca) ? 'eth' : 'sol';

  // Ambil data pool
  let pools = await fetchGeckoPools(ca, guessChain);
  if (!pools.length) pools = await fetchDexScreenerPools(ca);
  if (!pools.length) {
    throw new Error(`Token \`${ca.slice(0,8)}…\` tidak ditemukan di pool manapun.`);
  }

  const best       = pools[0];
  const { chain, network, dexId, poolAddr, name: poolName } = best;
  let   { price, quotePrice, tvl, vol24h, fee } = best;

  const isRaydium = dexId.toLowerCase().replace(/-/g,'_').includes('raydium_clmm');
  const isMeteora = dexId.toLowerCase().includes('meteora');
  const netSlug   = CHAIN_TO_GECKO[chain] || network || 'solana';
  const dex       = dexInfo(dexId);

  const [detail, raydiumData, meteoraData] = await Promise.all([
    fetchGeckoPoolDetail(netSlug, poolAddr),
    (chain === 'sol' && isRaydium) ? fetchRaydiumPool(ca) : Promise.resolve(null),
    isMeteora ? fetchMeteoraPools(ca) : Promise.resolve([]),
  ]);

  if (detail) {
    if (detail.basePrice  > 0) price      = detail.basePrice;
    if (detail.quotePrice > 0) quotePrice = detail.quotePrice;
    if (detail.volH24     > 0) vol24h     = detail.volH24;
    if (detail.poolFee    > 0) fee        = detail.poolFee / 100;
  }
  if (isMeteora && meteoraData[0]?.feePct > 0) fee = meteoraData[0].feePct / 100;
  if (isRaydium && raydiumData?.feeRate   > 0) fee = raydiumData.feeRate / 1e6;

  const tokA = (poolName.split('/')[0] || 'TokenA').trim();
  const tokB = (poolName.split('/')[1] || 'USDC').trim();

  // Range dari entry price
  const factor     = rangePct / 100;
  const lowerPrice = entryPrice * (1 - factor);
  const upperPrice = entryPrice * (1 + factor);

  // ── Status range sekarang ─────────────────────────────────────────────
  const nowInRange  = price >= lowerPrice && price <= upperPrice;
  const edgeLow     = Math.abs(price - lowerPrice) / entryPrice * 100;
  const edgeHigh    = Math.abs(upperPrice - price) / entryPrice * 100;
  const edgeProx    = nowInRange ? Math.min(edgeLow, edgeHigh) : 0;
  const rangeStatus = price < lowerPrice ? '🔴 OUT (di bawah range)'
                    : price > upperPrice ? '🔴 OUT (di atas range)'
                    : edgeProx < 3       ? '🟡 AT-RISK (dekat batas)'
                    : '🟢 IN RANGE';

  // ── IL & P&L ─────────────────────────────────────────────────────────
  const posNow  = clmmPositionValue(entryPrice, price, lowerPrice, upperPrice, modal);
  const holdVal = vHodl(entryPrice, price, lowerPrice, upperPrice, modal);
  const ilValue  = holdVal - posNow.valueQuote;              // positif = rugi
  const ilPct    = holdVal > 0 ? (ilValue / holdVal) * 100 : 0;

  // APR: gunakan historis Raydium kalau ada, fallback hitung dari vol24h
  const feeAprPct = raydiumData?.aprWeek || raydiumData?.aprDay
    || calcFeeApr(vol24h, fee, tvl);

  // Fee earned — gunakan APR × modal jika tahu berapa hari
  let feeEarned = null;
  let feeCoverage = null;
  let breakEvenDays = null;

  if (days && days > 0) {
    feeEarned = modal * (feeAprPct / 100) * (days / 365);
    // Jika out of range, fee hanya earned selama in-range
    if (!nowInRange) {
      // Konservatif: asumsikan 50% waktu in-range — user bisa kalkulasi sendiri
      feeEarned = feeEarned * 0.5;
    }
  }

  // Fee per hari (estimasi dari APR sekarang)
  const feePerDay = modal * (feeAprPct / 100) / 365;

  if (ilValue > 0 && feePerDay > 0) {
    breakEvenDays = ilValue / feePerDay;
  }
  if (feeEarned !== null && ilValue > 0) {
    feeCoverage = feeEarned / Math.max(ilValue, 0.01);
  }

  const netPnl = feeEarned !== null ? feeEarned - Math.max(ilValue, 0) : null;

  // ── Build output ──────────────────────────────────────────────────────
  const L = [];
  const p = s => L.push(s);

  p(`**📊 LP P&L — ${tokA}/${tokB}** (${dex.label})`);
  p(`**CA:** \`${ca.slice(0,8)}…\``);
  p('');
  p(`**Posisi kamu**`);
  p(`• Entry price  : ${fmtPrice(entryPrice)}`);
  p(`• Harga skrg  : ${fmtPrice(price)} ${detail?.priceChH24 ? fmtPct(detail.priceChH24, true) + ' (24h)' : ''}`);
  p(`• Range        : ${fmtPrice(lowerPrice)} – ${fmtPrice(upperPrice)} (±${rangePct}%)`);
  p(`• Modal        : ${fmtUsd(modal)}${days ? ` · Durasi: ${days} hari` : ''}`);
  p(`• Status       : ${rangeStatus}`);
  p('');
  p(`**💸 Impermanent Loss**`);
  p(`• Nilai posisi skrg : ${fmtUsd(posNow.valueQuote)}`);
  p(`  → ${tokA}: ${fmtAmt(posNow.amountA)} unit${price > 0 ? ' (' + fmtUsd(posNow.amountA * price) + ')' : ''}`);
  p(`  → ${tokB}: ${fmtAmt(posNow.amountB)} unit${quotePrice > 0 ? ' (' + fmtUsd(posNow.amountB * quotePrice) + ')' : ''}`);
  p(`• Nilai kalau HODL  : ${fmtUsd(holdVal)}`);
  p(`• IL (rugi vs HODL) : **${fmtUsd(ilValue)}** (${fmtPct(ilPct, false)})`);

  if (ilValue <= 0) {
    p(`• ✅ Tidak ada IL — posisi masih profitable vs HODL`);
  }

  p('');
  p(`**💰 Fee & Net P&L**`);
  p(`• APR pool (fee)   : ${fmtPct(feeAprPct)}${aprBadge(feeAprPct)}`);
  p(`• Fee / hari       : ~${fmtUsd(feePerDay)} / ${modal} modal`);

  if (feeEarned !== null) {
    p(`• Fee earned       : ~${fmtUsd(feeEarned)} (${days} hari${!nowInRange ? ' ×50% out-of-range est.' : ''})`);
    if (netPnl !== null) {
      const netSign = netPnl >= 0 ? '+' : '';
      p(`• **Net P&L vs HODL: ${netSign}${fmtUsd(netPnl)}** (${netSign}${fmtPct(netPnl / modal * 100, false)})`);
    }
    if (feeCoverage !== null) {
      const cov = feeCoverage.toFixed(2) + 'x';
      p(`• Fee coverage     : **${cov}** ${feeCoverage >= 1 ? '✅ Fee sudah menutup IL' : '⚠️ IL belum tertutup fee'}`);
    }
  } else {
    p(`_Tambahkan jumlah hari (mis: \`lp pnl ${ca.slice(0,8)} ${entryPrice} ${modal} ${rangePct} 30\`) untuk hitung fee & net P&L_`);
  }

  if (breakEvenDays !== null) {
    p(`• Break-even       : ~${breakEvenDays > 365 ? (breakEvenDays/30).toFixed(0)+' bulan' : breakEvenDays.toFixed(0)+' hari'} pada APR saat ini`);
  }

  p('');
  p(`**📈 Simulasi IL di berbagai harga**`);
  const simPrices = [-50, -30, -20, +20, +50, +100].map(pct => ({
    pct,
    pNew: entryPrice * (1 + pct / 100),
  }));
  for (const s of simPrices) {
    const pos   = clmmPositionValue(entryPrice, s.pNew, lowerPrice, upperPrice, modal);
    const hold  = vHodl(entryPrice, s.pNew, lowerPrice, upperPrice, modal);
    const il    = hold - pos.valueQuote;
    const ilP   = hold > 0 ? il / hold * 100 : 0;
    const oor   = s.pNew < lowerPrice || s.pNew > upperPrice;
    const sign  = s.pct >= 0 ? '+' : '';
    p(`• ${sign}${s.pct}% (${fmtPrice(s.pNew)}) : IL ${fmtUsd(il)} (${fmtPct(ilP, false)})${oor ? ' 🔴' : ''}`);
  }

  p('');
  const poolUrl = chain === 'sol'
    ? `https://raydium.io/liquidity/?inputMint=${ca}`
    : `https://app.uniswap.org/explore/tokens/ethereum/${ca}`;
  p(`🔗 [Raydium](<${poolUrl}>) · [GeckoTerminal](<https://www.geckoterminal.com/${CHAIN_TO_GECKO[chain]||'solana'}/pools/${poolAddr}>)`);

  return L.join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// ── LP REBALANCE ──────────────────────────────────────────────────────────
// Syntax: lp rebalance <CA>
// ════════════════════════════════════════════════════════════════════════

async function handleLpRebalance({ ca }) {
  const guessChain = isEvmAddr(ca) ? 'eth' : 'sol';

  let pools = await fetchGeckoPools(ca, guessChain);
  if (!pools.length) pools = await fetchDexScreenerPools(ca);
  if (!pools.length) {
    throw new Error(`Token \`${ca.slice(0,8)}…\` tidak ditemukan di pool manapun.`);
  }

  const best    = pools[0];
  const { chain, network, dexId, poolAddr, name: poolName, tvl, vol24h, fee } = best;
  let   { price } = best;

  const isRaydium = dexId.toLowerCase().replace(/-/g,'_').includes('raydium_clmm');
  const isMeteora = dexId.toLowerCase().includes('meteora');
  const netSlug   = CHAIN_TO_GECKO[chain] || network || 'solana';
  const dex       = dexInfo(dexId);
  const tokA = (poolName.split('/')[0] || 'TokenA').trim();
  const tokB = (poolName.split('/')[1] || 'USDC').trim();

  const [detail, raydiumData, meteoraData] = await Promise.all([
    fetchGeckoPoolDetail(netSlug, poolAddr),
    (chain === 'sol' && isRaydium) ? fetchRaydiumPool(ca) : Promise.resolve(null),
    isMeteora ? fetchMeteoraPools(ca) : Promise.resolve([]),
  ]);

  if (detail?.basePrice > 0) price = detail.basePrice;

  // ── Kumpulkan data historis ───────────────────────────────────────────
  const priceH1day  = raydiumData?.priceMaxDay  || null;
  const priceL1day  = raydiumData?.priceMinDay  || null;
  const priceH7day  = raydiumData?.priceMaxWeek || null;
  const priceL7day  = raydiumData?.priceMinWeek || null;

  // Meteora: estimasi range dari APR + fee data
  const meteoraAPR = meteoraData[0]?.apr || null;

  // APR historis
  const aprDay   = raydiumData?.aprDay   || meteoraData[0]?.apr  || null;
  const aprWeek  = raydiumData?.aprWeek  || null;
  const aprMonth = raydiumData?.aprMonth || null;

  // ── Hitung σ_daily ────────────────────────────────────────────────────
  const sigma1d = parkinsonSigma(priceH1day, priceL1day, 1);
  const sigma7d = parkinsonSigma(priceH7day, priceL7day, 7);
  const sigma   = blendSigma(sigma1d, sigma7d);
  const sigmaPct = sigma * 100;

  // ── Hitung 3 strategi range ───────────────────────────────────────────
  // Strategi  |  k   |  horizon  |  prob in-range
  // Agresif   | 1.0  |  3 hari   |  ~68%
  // Moderat   | 1.5  |  7 hari   |  ~87%
  // Konserv.  | 2.0  | 14 hari   |  ~95%
  const strategies = [
    { name: '⚡ Agresif',    k: 1.0, horizon: 3,  prob: '~68%', note: 'fee tinggi, rebalance lebih sering' },
    { name: '⚖️ Moderat',    k: 1.5, horizon: 7,  prob: '~87%', note: 'keseimbangan fee vs stabilitas' },
    { name: '🛡️ Konservatif', k: 2.0, horizon: 14, prob: '~95%', note: 'jarang out-of-range, fee lebih rendah' },
  ];

  // ── Range 24h & 7d aktual ─────────────────────────────────────────────
  const has24h = priceH1day && priceL1day;
  const has7d  = priceH7day && priceL7day;
  const actual24hPct = has24h ? (priceH1day - priceL1day) / price * 100 : null;
  const actual7dPct  = has7d  ? (priceH7day - priceL7day) / price * 100 : null;

  // ── Build output ──────────────────────────────────────────────────────
  const L = [];
  const p = s => L.push(s);

  p(`**📐 LP Rebalance Advisor — ${tokA}/${tokB}** (${dex.label})`);
  p(`**CA:** \`${ca.slice(0,8)}…\``);
  p('');

  p(`**📊 Harga & Volatilitas**`);
  p(`• Harga sekarang  : ${fmtPrice(price)}`);
  p(`• TVL pool        : ${fmtUsd(tvl)}`);

  if (has24h) {
    p(`• Range 24h aktual: ${fmtPrice(priceL1day)} – ${fmtPrice(priceH1day)} (lebar ${fmtPct(actual24hPct, false)})`);
  }
  if (has7d) {
    p(`• Range 7d aktual : ${fmtPrice(priceL7day)} – ${fmtPrice(priceH7day)} (lebar ${fmtPct(actual7dPct, false)})`);
  }

  if (sigma1d || sigma7d) {
    p(`• **σ_daily (volatilitas)**: ${fmtPct(sigmaPct, false)}`);
    if (sigma1d) p(`  → 1d Parkinson: ${fmtPct(sigma1d * 100, false)}`);
    if (sigma7d) p(`  → 7d Parkinson: ${fmtPct(sigma7d * 100, false)}`);
  } else {
    p(`• σ_daily: _tidak ada data historis Raydium (${dex.label} mungkin bukan CLMM)_`);
  }

  p('');
  p(`**💰 APR & Fee**`);
  const feeApr = calcFeeApr(vol24h, fee, tvl);
  p(`• APR sekarang    : ${fmtPct(aprDay || feeApr)}${aprBadge(aprDay || feeApr)}`);
  if (aprWeek)  p(`• APR 7 hari      : ${fmtPct(aprWeek)}${aprBadge(aprWeek)}`);
  if (aprMonth) p(`• APR 30 hari     : ${fmtPct(aprMonth)}${aprBadge(aprMonth)}`);

  p('');
  p(`**🎯 Saran Range (berdasarkan σ = ${fmtPct(sigmaPct, false)})**`);
  p(`_halfWidth = k × σ × √horizon_`);
  p('');

  for (const s of strategies) {
    const hw      = optimalHalfWidth(sigma, s.horizon, s.k);
    const hwPct   = hw * 100;
    const lo      = price * (1 - hw);
    const hi      = price * (1 + hw);

    // APR estimasi: range lebih sempit → modal lebih terkonsentrasi → APR lebih tinggi
    // Perkiraan kasar: APR ∝ 1/halfWidth  (relative to 20% base)
    const aprBase   = aprWeek || aprDay || feeApr || 0;
    const aprEst    = aprBase * (0.20 / Math.max(hw, 0.02)); // normalisasi ke ±20%

    // Berapa lama break-even kalau modal 1000
    const feePerDay1k = 1000 * (aprEst / 100) / 365;
    const ilAt7d      = has7d
      ? Math.max(0, 1000 - (clmmPositionValue(price, price, lo, hi, 1000).valueQuote * (actual7dPct ? Math.abs(actual7dPct) / 100 : 0)))
      : null;

    p(`**${s.name}** ±${fmtPct(hwPct, false)}`);
    p(`  Range: ${fmtPrice(lo)} – ${fmtPrice(hi)}`);
    p(`  Estimasi APR: ~${fmtPct(Math.min(aprEst, 999), false)}${aprBadge(aprEst)}`);
    p(`  Prob in-range ${s.horizon} hari: ${s.prob} · ${s.note}`);
    p('');
  }

  // ── Kapan waktunya rebalance ──────────────────────────────────────────
  p(`**⏱️ Kapan Rebalance?**`);
  p(`• 🔴 **Keluar dari range** → Segera evaluasi, sudah tidak earned fee`);
  p(`• 🟡 **Harga < 3% dari batas** → Siapkan rencana rebalance`);
  p(`• 💸 **Biaya rebalance** biasanya $1–3 (gas + swap impact)`);

  const aprForCalc = aprWeek || aprDay || feeApr || 0;
  if (aprForCalc > 0) {
    // Berapa hari fee cukup untuk tutup biaya rebalance $2.50
    const rebalCost   = 2.5;
    const modal100    = 100;
    const daysTocover = rebalCost / (modal100 * aprForCalc / 100 / 365);
    p(`• Untuk modal $100: biaya rebalance balik modal dalam ~${daysTocover.toFixed(0)} hari fee`);
    p(`  → Jangan rebalance kalau IL belum melebihi biaya rebalance (${rebalCost})`);
  }

  p('');
  p(`**📌 Tips**`);
  p(`• High volume (volume/TVL > 0.5): pilih range lebih sempit (agresif)`);
  p(`• Low volume / harga choppy: pilih range lebih lebar (konservatif)`);
  p(`• Pasang alert harga di ${fmtPrice(price * (1 - sigma * 2))} dan ${fmtPrice(price * (1 + sigma * 2))}`);
  p(`• Cek posisi minimal 1x/hari untuk token volatile (σ > 5%/hari)`);

  p('');
  p(`🔗 [GeckoTerminal](<https://www.geckoterminal.com/${CHAIN_TO_GECKO[chain]||'solana'}/pools/${poolAddr}>) · [Raydium](<https://raydium.io/liquidity/?inputMint=${ca}>)`);

  return L.join('\n');
}

module.exports = { detectLpQuery, handleLpCommand };
