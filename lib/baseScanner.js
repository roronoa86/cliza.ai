// lib/baseScanner.js
// !base <ca> — Base Network Token Scam Analyzer
// Logic identik dengan BASE FORENSICS v4 (roronoa86/base-token-scanner)
// Pure deterministic — no AI
'use strict';

const axios = require('axios');

// ─── Constants ────────────────────────────────────────────────────────────────
const BASE_CHAIN = '8453';
const BASE_RPC   = process.env.ALCHEMY_BASE_RPC || 'https://mainnet.base.org';

const POOL_ADDRS = new Set([
  '0x498581ff718922c3f8e6a244956af099b2652b2b', // Uniswap v4 PoolManager Base
  '0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24', // Uniswap v3 NonfungiblePositionManager Base
  '0x2626664c2603336e57b271c5c0b26f421741e481', // Uniswap v3 SwapRouter02 Base
  '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', // Aerodrome Router
  '0x420dd381b31aef6683db6b902084cb0ffece40da', // Aerodrome v2
  // Clanker locker contracts — hold LP tokens untuk token Clanker resmi
  '0x63d2dfea64b3433f4071a98665bcd7ca14d93496', // Clanker v4 Locker
  '0x33e2eda238edcf470309b8c6d228986a1204c8f9', // Clanker v3.1 Locker
  '0x5ec4f99f342038c67a312a166ff56e6d70383d86', // Clanker v3 Locker
  '0x618a9840691334ee8d24445a4ada4284bf42417d', // Clanker v2 Locker
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  // Flaunch PositionManager — hold Uniswap v4 LP positions sebagai hook
  '0x6a53f8b799be11a2a3264ef0bff183dcb12d9571', // Flaunch PositionManager v1
  '0xb4512bf57d50fbcb64a3adf8b17a79b2a204c18c', // Flaunch PositionManager v2
  '0x498581ff718922c3f8e6a244956af099b2652b2b', // UV4 PoolManager (Base) — holder LP semua UV4 pool
]);

const BASESCAN_API     = 'https://api.basescan.org/api';
const BASESCAN_API_KEY  = process.env.ETHERSCAN_API_KEY  || '';
const BLOCKSCOUT_API_KEY = process.env.BLOCKSCOUT_API_KEY || '';
// Helper: append api keys to URLs
const bsKey  = () => BASESCAN_API_KEY  ? `&apikey=${BASESCAN_API_KEY}`  : '';
const blkHdr = () => BLOCKSCOUT_API_KEY ? { headers: { 'Authorization': `Bearer ${BLOCKSCOUT_API_KEY}` } } : {};

const SEL = {
  allData:     '0xb974b0a3',
  isVerified:  '0x80007e83',
  totalSupply: '0x18160ddd',
  owner:       '0x8da5cb5b',
  decimals:    '0x313ce567',
  name:        '0x06fdde03',
  symbol:      '0x95d89b41',
  balanceOf:   '0x70a08231',
  // Bankr "eco" launch flow (bankr.bot) — token dideploy via Doppler protocol.
  // Semua token Doppler dideploy dari template minimal-proxy yang sama
  // (bytecode identik antar token — BUKAN red flag, sama seperti Clanker).
  dopplerPool:       '0x16f0115b', // pool() view returns (address)
  dopplerPoolUnlock: '0x63c65b6f', // isPoolUnlocked() view returns (bool)
};

// Template/factory Doppler resmi yang dipakai jalur Bankr "eco" di Base (lowercase)
const DOPPLER_TEMPLATES = {
  '0xdb7b520bb5c3a2c5d4871198081911359f93be87': 'Bankr/Doppler ERC20V1 Template',
};
const BANKR_API_BASE = 'https://api.bankr.bot';
const BURN_ADDRS = [
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000000',
  '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead', // Doppler/Bankr "eco" burned-position sentinel
];

// Sumber: https://github.com/clanker-devco/clanker-sdk/blob/main/src/utils/clankers.ts
// Semua alamat factory resmi Clanker di Base (lowercase)
const CLANKER_FACTORIES = {
  '0xe85a59c628f7d27878aceb4bf3b35733630083a9': 'Clanker v4',
  '0x2a787b2362021cc3eea3c24c4748a6cd5b687382': 'Clanker v3.1',
  '0x375c15db32d28cecdcab5c03ab889bf15cbd2c5e': 'Clanker v3.0',  // Fix: sebelumnya salah
  '0x732560fa1d1a76350b1a500155ba978031b53833': 'Clanker v2',    // Fix: sebelumnya salah
  '0x9b84fce5dcd9a38d2d01d5d72373f6b6b067c3e1': 'Clanker v1',    // Fix: sebelumnya salah
  '0x250c9fb2b411b48273f69879007803790a6aea47': 'Clanker v0',    // Tambah: sebelumnya tidak ada
};

// Event signature (topic0) dari tiap factory — untuk eth_getLogs yang tepat
// Ditemukan dari: eth_getTransactionReceipt tx deploy token Clanker v4
// topic1 = token address (indexed), topic2 = deployer (indexed)
const CLANKER_FACTORY_EVENTS = {
  '0xe85a59c628f7d27878aceb4bf3b35733630083a9': '0x9299d1d1a88d8e1abdc591ae7a167a6bc63a8f17d695804e9091ee33aa89fb67', // v4
  // v0-v3: event sig belum diverifikasi, pakai null (match semua event)
};

// Clanker locker addresses (dari SDK) — penting untuk deteksi LP lock
const CLANKER_LOCKERS = new Set([
  '0x63d2dfea64b3433f4071a98665bcd7ca14d93496', // v4
  '0x33e2eda238edcf470309b8c6d228986a1204c8f9', // v3.1
  '0x5ec4f99f342038c67a312a166ff56e6d70383d86', // v3
  '0x618a9840691334ee8d24445a4ada4284bf42417d', // v2
]);

const LP_LOCKERS = {
  // Clanker official lockers (dari SDK)
  '0x63d2dfea64b3433f4071a98665bcd7ca14d93496': 'Clanker v4 Locker',
  '0x33e2eda238edcf470309b8c6d228986a1204c8f9': 'Clanker v3.1 Locker',
  '0x5ec4f99f342038c67a312a166ff56e6d70383d86': 'Clanker v3 Locker',
  '0x618a9840691334ee8d24445a4ada4284bf42417d': 'Clanker v2 Locker',
  // 3rd-party lockers
  '0x231278eded31537905d50a6c870cd08e4d0d6cb': 'Unicrypt UNCX',
  '0xdba68f07d1b7ca219f78ae8582da0df4dad84f3': 'Unicrypt V3',
  '0x71b5759d73262fbb223956913ecf4ecc51057641': 'Team.Finance',
  '0xddd0cbcb0f1cf4cd4e99ba0eb6b9f9ffe3cedc72': 'Mudra Locker',
  '0x407993575c91ce7643a4d4ccace9d90afe02b5e3': 'PinkLock v2',
  '0x7ee058420ff9f9e9e2da6f5f392fd951d4e5c9a3': 'PinkLock',
  // Flaunch PositionManagers — LP locked in Uniswap v4 pool managed by Flaunch hook
  '0x6a53f8b799be11a2a3264ef0bff183dcb12d9571': 'Flaunch PositionManager v1',
  '0xb4512bf57d50fbcb64a3adf8b17a79b2a204c18c': 'Flaunch PositionManager v2',
  '0x498581ff718922c3f8e6a244956af099b2652b2b': 'Uniswap v4 PoolManager',
};

// ─── Flaunch Ecosystem ────────────────────────────────────────────────────────
    // Source: https://docs.flaunch.gg — PositionManager adalah factory + LP hook Uniswap v4
    const FLAUNCH_POSITION_MANAGERS = {
    '0x6a53f8b799be11a2a3264ef0bff183dcb12d9571': 'Flaunch PositionManager v1',
    '0xb4512bf57d50fbcb64a3adf8b17a79b2a204c18c': 'Flaunch PositionManager v2',
    };
    const FLAUNCH_FEE_ADDRS = new Set([
    '0x72e6f7948b1b1a343b477f39aabd2e35e6d27dde', // FeeEscrow
    '0x1150c53eb4ce3ade47808d1d1ac9636b774ee079', // ProtocolFeeRecipient
    ]);
    const FLAUNCH_API = 'https://dev-api.flayerlabs.xyz';
    // Flaunch tokens = EIP-1167 clone dari salah satu dari DUA template resmi Flaunch
      // ⚠️ BUG FIX: Semula hanya 1 template — tapi ada 2 template berbeda dengan creator yang sama
      //   (0xB8A70b4d1547bf6193bd67A73F4F98ea9FD0A973 = Flaunch deployer resmi)
      const FLAUNCH_MEMECOIN_TEMPLATES = new Set([
        '0xf1eeeeeeecd95e9eb2df58484ceed175acbd945c', // Memecoin — template PositionManager v1 awal
        '0xa327725c2dcd8077dbc49701dd7a673ffb768145', // MemecoinTreasury — template PM v1 terbaru & v2
      ]);
    // Uniswap v4 PoolManager (Base mainnet) — memegang seluruh UV4 LP termasuk Flaunch
    const UV4_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b';

    const DANGER_FN_LIST = [
  'mint','crosschainMint','setOwner','updateAdmin','blacklist',
  'setFee','pause','updateImage','updateMetadata','freezeAccount',
  'setMaxWallet','setMaxTx','enableTrading','addBlacklist','setTax',
];

// ─── Format helpers ───────────────────────────────────────────────────────────
function short(addr) {
  if (!addr || addr.length < 10) return addr || 'N/A';
  return addr.slice(0, 6) + '…' + addr.slice(-4);
}

function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '?';
  const num = Number(n);
  if (isNaN(num)) return '?';
  if (num >= 1e9) return (num / 1e9).toFixed(2) + 'B';
  if (num >= 1e6) return (num / 1e6).toFixed(2) + 'M';
  if (num >= 1e3) return (num / 1e3).toFixed(1) + 'K';
  return num.toFixed(2);
}

function fmtPrice(p) {
  if (!p) return 'N/A';
  const n = parseFloat(p);
  if (isNaN(n)) return 'N/A';
  if (n < 0.000001) return '$' + n.toExponential(4);
  if (n < 0.01)     return '$' + n.toFixed(8);
  if (n < 1)        return '$' + n.toFixed(6);
  return '$' + n.toFixed(4);
}

function fmtAge(ts) {
  if (!ts || isNaN(ts)) return 'N/A';
  const d = Math.floor((Date.now() - ts) / 86400000);
  if (d === 0)  return 'Hari ini';
  if (d === 1)  return 'Kemarin';
  if (d < 30)   return d + ' hari lalu';
  if (d < 365)  return Math.floor(d / 30) + ' bulan lalu';
  return Math.floor(d / 365) + ' tahun lalu';
}

function fmtSupply(bi, dec) {
  try {
    const d = isNaN(parseInt(dec)) ? 18 : parseInt(dec);
    const divisor = 10n ** BigInt(d);
    return fmtNum(Number(bi / divisor));
  } catch { return bi.toString(); }
}

// ─── LP Lock from GoPlus lp_holders ──────────────────────────────────────────
function parseLPLock(goplus) {
  const empty = { hasData: false, locked: false, burned: false, lockerNames: [], lockedPct: 0, burnedPct: 0, holders: [] };
  if (!goplus?.lp_holders || !Array.isArray(goplus.lp_holders)) return empty;
  const holders = goplus.lp_holders;
  let lockedPct = 0, burnedPct = 0;
  const lockerNames = [];
  let isLocked = false;
  for (const h of holders) {
    const pct  = parseFloat(h.percent || '0') * 100;
    const addr = (h.address || '').toLowerCase();
    const isDead = addr === '0x000000000000000000000000000000000000dead'
                || addr === '0x0000000000000000000000000000000000000000';
    // Kenali Clanker locker dan LP_LOCKERS sebagai "locked" meski GoPlus tidak flag h.locked=1
    const isKnownLocker = CLANKER_LOCKERS.has(addr) || !!LP_LOCKERS[addr];
    if (isDead) {
      burnedPct += pct;
    } else if (h.locked === 1 || h.locked === '1' || isKnownLocker) {
      isLocked = true;
      lockedPct += pct;
      const name = h.tag || LP_LOCKERS[addr] || 'Locker';
      if (!lockerNames.includes(name)) lockerNames.push(name);
    }
  }
  return { hasData: true, locked: isLocked, burned: burnedPct > 50, lockerNames, lockedPct, burnedPct, holders };
}

// ─── RPC helpers ──────────────────────────────────────────────────────────────
async function rpcBatchWithTimeout(calls, timeoutMs = 10000, _attempt = 0) {
  try {
    const body = calls.map((c, i) => ({
      jsonrpc: '2.0', method: 'eth_call', id: i + 1,
      params: [{ to: c.to, data: c.data }, 'latest'],
    }));
    const { data } = await axios.post(BASE_RPC, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    });
    const arr = Array.isArray(data) ? data : [data];
    // Public Base RPC (mainnet.base.org) rate-limits concurrent requests (error -32016
    // "over rate limit"). Round 1 fires many parallel calls to the same endpoint, so a
    // single retry isn't always enough — retry up to 3x with exponential backoff before
    // giving up and treating it as "no data".
    const rateLimited = arr.some(x => x?.error?.code === -32016 || /rate limit/i.test(x?.error?.message || ''));
    if (rateLimited && _attempt < 3) {
      const backoff = 800 * Math.pow(2, _attempt) + Math.floor(Math.random() * 400);
      await new Promise(r => setTimeout(r, backoff));
      return rpcBatchWithTimeout(calls, timeoutMs, _attempt + 1);
    }
    return calls.map((_, i) => {
      const res = arr.find(x => x.id === i + 1);
      return res ? (res.result || null) : null;
    });
  } catch { return calls.map(() => null); }
}

async function rpcGetDeployer(addr, timeoutMs = 8000) {
  try {
    const body = [
      { jsonrpc: '2.0', method: 'eth_getTransactionCount', id: 1, params: [addr, 'latest'] },
      { jsonrpc: '2.0', method: 'eth_getBalance',          id: 2, params: [addr, 'latest'] },
    ];
    const { data } = await axios.post(BASE_RPC, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: timeoutMs,
    });
    const arr = Array.isArray(data) ? data : [data];
    const nc = arr.find(x => x.id === 1);
    const bc = arr.find(x => x.id === 2);
    return {
      nonce:   nc?.result ? parseInt(nc.result, 16) : null,
      balance: bc?.result ? BigInt(bc.result)       : null,
    };
  } catch { return { nonce: null, balance: null }; }
}

// ─── ABI decode ───────────────────────────────────────────────────────────────
function decodeString(hex) {
  try {
    if (!hex || hex === '0x') return '';
    const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
    if (!raw) return '';
    const hexToStr = h => (h.match(/../g) || []).map(b => String.fromCharCode(parseInt(b, 16))).join('').replace(/\0/g, '');
    if (raw.slice(0, 64) === '0000000000000000000000000000000000000000000000000000000000000020') {
      const len = parseInt(raw.slice(64, 128), 16);
      if (!len) return '';
      return hexToStr(raw.slice(128, 128 + len * 2));
    }
    return hexToStr(raw.slice(0, 64));
  } catch { return ''; }
}

function decodeBool(hex) {
  if (!hex || hex === '0x') return null;
  const raw = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (raw.length < 64) return null;
  const last = raw.slice(-64);
  if (!/^0{63}[01]$/.test(last)) return null;
  return last[63] === '1';
}

function decodeUint(hex) {
  if (!hex || hex === '0x') return null;
  try { return BigInt(hex); } catch { return null; }
}

function decodeAddr(hex) {
  if (!hex || hex.length < 42) return null;
  const a = '0x' + hex.slice(-40).toLowerCase();
  return a === '0x0000000000000000000000000000000000000000' ? null : a;
}

// ─── On-chain reads ───────────────────────────────────────────────────────────
async function readTokenRPC(addr) {
  // Batch ERC-20 basics (5s timeout)
  const [supplyHex, ownerHex, decimalsHex, nameHex, symbolHex] = await rpcBatchWithTimeout([
    { to: addr, data: SEL.totalSupply },
    { to: addr, data: SEL.owner },
    { to: addr, data: SEL.decimals },
    { to: addr, data: SEL.name },
    { to: addr, data: SEL.symbol },
  ], 5000);

  // isVerified() — Clanker-only, shorter timeout
  let isVerified = null;
  try {
    const [verHex] = await rpcBatchWithTimeout([{ to: addr, data: SEL.isVerified }], 3000);
    if (verHex && verHex !== '0x' && verHex.length >= 66) {
      isVerified = decodeBool(verHex);
    }
  } catch {}

  return {
    totalSupply: decodeUint(supplyHex),
    owner:       ownerHex ? decodeAddr(ownerHex) : null,
    decimals:    decimalsHex ? (parseInt(decimalsHex, 16) || 18) : 18,
    name:        decodeString(nameHex),
    symbol:      decodeString(symbolHex),
    isVerified,
  };
}

async function readAllData(addr) {
  const [result] = await rpcBatchWithTimeout([{ to: addr, data: SEL.allData }], 5000);
  if (!result || result === '0x' || result.length < 322) return null;
  try {
    const hex = result.startsWith('0x') ? result.slice(2) : result;
    const originalAdmin = '0x' + hex.slice(24, 64);
    const admin         = '0x' + hex.slice(88, 128);
    const readDynStr = slotIdx => {
      try {
        const offset = parseInt(hex.slice(slotIdx * 64, (slotIdx + 1) * 64), 16) * 2;
        if (!offset || offset >= hex.length) return '';
        const len = parseInt(hex.slice(offset, offset + 64), 16);
        if (!len || offset + 64 + len * 2 > hex.length) return '';
        const raw = hex.slice(offset + 64, offset + 64 + len * 2);
        return (raw.match(/../g) || []).map(b => String.fromCharCode(parseInt(b, 16))).join('').replace(/\0/g, '');
      } catch { return ''; }
    };
    return {
      originalAdmin: originalAdmin.toLowerCase(),
      admin:         admin.toLowerCase(),
      image:         readDynStr(2),
      metadata:      readDynStr(3),
      context:       readDynStr(4),
    };
  } catch { return null; }
}

// ─── Bankr "eco" (Doppler) on-chain reads ─────────────────────────────────────
// pool() dan isPoolUnlocked() hanya ada di token yang dideploy via jalur
// Bankr "eco" (Doppler protocol). Selector tidak exist di ERC-20 biasa/Clanker,
// jadi respon null/kosong berarti bukan token Doppler — bukan error.
async function readDopplerRPC(addr) {
  let poolAddress = null, poolUnlocked = null;
  try {
    // Satu batched call (bukan 2 request terpisah) — mengurangi beban ke public RPC
    // yang gampang kena rate-limit saat Round 1 memanggil banyak fungsi paralel.
    const [poolHex, unlockHex] = await rpcBatchWithTimeout([
      { to: addr, data: SEL.dopplerPool },
      { to: addr, data: SEL.dopplerPoolUnlock },
    ], 6000);
    if (poolHex && poolHex !== '0x' && poolHex.length >= 66) poolAddress = decodeAddr(poolHex);
    if (unlockHex && unlockHex !== '0x' && unlockHex.length >= 66) poolUnlocked = decodeBool(unlockHex);
  } catch {}
  return { poolAddress, poolUnlocked };
}

// Bankr public API — GET /public/doppler/token-fees/{addr}. Jika token ini
// dideploy via Bankr, endpoint mengembalikan { source: "doppler", ... }.
// Dipakai sebagai bukti independen di luar on-chain read, tanpa butuh API key.
async function fetchBankrDoppler(addr) {
  try {
    const { data } = await axios.get(
      `${BANKR_API_BASE}/public/doppler/token-fees/${addr}`,
      { timeout: 8000 }
    );
    // Real response shape: { address, chain, tokens: [{ tokenAddress, source, poolId, ... }], ... }
    // There is no top-level `source`/`poolAddress`/`isPoolUnlocked` — must match by tokenAddress.
    const match = Array.isArray(data?.tokens)
      ? data.tokens.find(t => (t.tokenAddress || '').toLowerCase() === addr.toLowerCase())
      : null;
    if (!match || (match.source || '').toLowerCase() !== 'doppler') return null;
    return {
      found: true,
      poolId: match.poolId || null,
      // This endpoint reports fee-sharing data, not on-chain lock status —
      // poolAddress/isPoolUnlocked always come from readDopplerRPC() instead.
      poolAddress: null,
      isPoolUnlocked: null,
    };
  } catch { return null; }
}

// ─── API fetches ──────────────────────────────────────────────────────────────
async function fetchGoPlus(addr) {
  try {
    const { data } = await axios.get(
      `https://api.gopluslabs.io/api/v1/token_security/${BASE_CHAIN}?contract_addresses=${addr}`,
      { timeout: 10000 }
    );
    if (data?.code !== 1) return null;
    return data.result?.[addr.toLowerCase()] || data.result?.[addr] || null;
  } catch { return null; }
}

// ─── GeckoTerminal (CoinGecko DEX data) ──────────────────────────────────────
// Menggantikan DexScreener — lebih lengkap untuk token Base DEX
// Gunakan COINGECKO_API_KEY dari env jika tersedia, fallback ke free tier (rate-limited)
function _gtHeaders() {
  const key = process.env.COINGECKO_API_KEY || '';
  if (!key) return {};
  // Pro key → x-cg-pro-api-key, Demo key → x-cg-demo-api-key
  // CoinGecko Demo key biasanya diawali "CG-"
  return key.startsWith('CG-')
    ? { 'x-cg-demo-api-key': key }
    : { 'x-cg-pro-api-key': key };
}

async function fetchDex(addr) {
  try {
    const headers = _gtHeaders();
    // Ambil top pools untuk token ini di Base network
    const { data } = await axios.get(
      `https://api.geckoterminal.com/api/v2/networks/base/tokens/${addr}/pools`,
      { headers, timeout: 10000, params: { page: 1 } }
    );
    const pools = data?.data;
    if (!Array.isArray(pools) || pools.length === 0) return null;

    // Normalize ke format pair yang sama dengan sebelumnya
    // agar computeScore & formatDiscord tidak berubah
    return pools.map(p => {
      const at   = p.attributes || {};
      const rels = p.relationships || {};
      const dexId = rels.dex?.data?.id || 'unknown';
      const createdAt = at.pool_created_at ? new Date(at.pool_created_at).getTime() : null;
      return {
        pairAddress:  at.address || '',
        dexId:        dexId.replace(/_/g, ' '),
        priceUsd:     at.base_token_price_usd   || null,
        marketCap:    parseFloat(at.market_cap_usd || at.fdv_usd || '0') || 0,
        liquidity:    { usd: parseFloat(at.reserve_in_usd || '0') || 0 },
        volume:       { h24: parseFloat(at.volume_usd?.h24 || '0') || 0 },
        priceChange:  { h24: parseFloat(at.price_change_percentage?.h24 || '0') || 0 },
        txns:         {
          h24: {
            buys:  parseInt(at.transactions?.h24?.buys  || '0') || 0,
            sells: parseInt(at.transactions?.h24?.sells || '0') || 0,
          },
        },
        pairCreatedAt: createdAt,
        // chain selalu base (kita query base network)
        chainId: 'base',
      };
    });
  } catch { return null; }
}

async function fetchBSToken(addr) {
  // Blockscout v2 + Basescan + /addresses/ (proxy_type & implementations) — paralel
  try {
    const [d, d2, d3] = await Promise.all([
      axios.get(`https://base.blockscout.com/api/v2/tokens/${addr}`, { timeout: 7000, ...blkHdr() }).then(r => r.data).catch(() => null),
      axios.get(`${BASESCAN_API}?module=token&action=tokeninfo&contractaddress=${addr}${bsKey()}`, { timeout: 7000 }).then(r => r.data).catch(() => null),
      // d3: /addresses/ endpoint — memberikan proxy_type + implementations (kunci deteksi Flaunch)
      axios.get(`https://base.blockscout.com/api/v2/addresses/${addr}`, { timeout: 7000, ...blkHdr() }).then(r => r.data).catch(() => null),
    ]);
    let base = null;
    if (d?.name) {
      base = d;
    } else if (d2?.status === '1' && d2?.result?.[0]) {
      const t = d2.result[0];
      base = {
        name:          t.tokenName,
        symbol:        t.symbol,
        decimals:      t.divisor,
        total_supply:  t.totalSupply,
        holders_count: t.holdersCount,
      };
    }
    // Inject proxy data dari /addresses/ endpoint — selalu pakai d3 jika ada,
    // bahkan saat d/d2 (token metadata) gagal. Ini penting untuk deteksi Flaunch
    // karena proxy_type & implementations bisa ada tanpa metadata token.
    if (d3) {
      if (!base) base = {};
      base.creator_address_hash = d3.creator_address_hash?.toLowerCase() || null;
      // Normalize proxy_type: lowercase & strip non-alnum agar tidak miss karena format variant
      base.proxy_type           = d3.proxy_type ? d3.proxy_type.toLowerCase().replace(/[^a-z0-9]/g, '') : null;
      base.implementations      = d3.implementations || [];
      // is_verified dari /addresses/ — untuk EIP-1167 proxy ini true jika implementation template verified
      // Lebih akurat dari /smart-contracts/ yang return undefined untuk pure proxy
      base.is_verified          = d3.is_verified ?? null;
    }
    return base || null;
  } catch {}
  return null;
}

async function fetchContractCreator(addr) {
  const padded = '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();

  // ── 1. Blockscout address API — paling akurat untuk factory-deployed tokens ──
  // Langsung return factory address (bukan EOA) untuk token yang di-deploy via factory
  try {
    const { data } = await axios.get(
      `https://base.blockscout.com/api/v2/addresses/${addr}`,
      { timeout: 7000 }
    );
    const creator = data?.creator_address_hash?.toLowerCase();
    if (creator) return creator;
  } catch {}

  // ── 2. Direct on-chain: deploymentInfoForToken(address) untuk Clanker v4 ──
  // View function on factory — bekerja bahkan sebelum Blockscout index token baru
  // Selector 0x06562980 = keccak256("deploymentInfoForToken(address)")[0:4]
  try {
    const calldata = '0x06562980' + padded.slice(2);
    const { data } = await axios.post(BASE_RPC, {
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to: '0xe85a59c628f7d27878aceb4bf3b35733630083a9', data: calldata }, 'latest']
    }, { timeout: 5000 });
    // Returns (address token, address hook, address locker) — each 32 bytes
    if (data?.result && data.result !== '0x' && data.result.length >= 130) {
      const returnedToken = '0x' + data.result.slice(26, 66);
      if (returnedToken.toLowerCase() === addr.toLowerCase()) {
        return '0xe85a59c628f7d27878aceb4bf3b35733630083a9';
      }
    }
  } catch {}

  // ── 3. Basescan getcontractcreation ──
  try {
    const { data } = await axios.get(
      `${BASESCAN_API}?module=contract&action=getcontractcreation&contractaddresses=${addr}${bsKey()}`,
      { timeout: 7000 }
    );
    if (data?.status === '1' && data.result?.[0]) {
      return data.result[0].contractCreator?.toLowerCase() || null;
    }
  } catch {}

  // ── 4. eth_getLogs — cari event factory (fallback untuk token lama) ──
  try {
    const blkRes = await axios.post(BASE_RPC, {
      jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: []
    }, { timeout: 4000 });
    const latest = parseInt(blkRes.data?.result || '0x0', 16);
    const fromBlock = '0x' + Math.max(latest - 2000000, 0).toString(16);
    const factories = Object.keys(CLANKER_FACTORIES);
    const found = await Promise.any(
      factories.map(async (factory) => {
        const eventSig = CLANKER_FACTORY_EVENTS[factory] || null;
        const topics = [eventSig, padded]; // topic1 = tokenAddress (indexed per ABI)
        try {
          const { data } = await axios.post(BASE_RPC, {
            jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
            params: [{ address: factory, topics, fromBlock, toBlock: 'latest' }]
          }, { timeout: 9000 });
          if (data?.result?.length > 0) return factory;
        } catch {}
        throw new Error('not found in ' + factory);
      })
    ).catch(() => null);
    if (found) return found;
  } catch {}

  // ── 5. alchemy_getAssetTransfers (last resort — tidak reliable untuk factory tokens) ──
  try {
    const { data } = await axios.post(BASE_RPC, {
      jsonrpc: '2.0', id: 1,
      method: 'alchemy_getAssetTransfers',
      params: [{ toAddress: addr, category: ['internal'], maxCount: '0x5', order: 'asc' }]
    }, { timeout: 8000 });
    const from = data?.result?.transfers?.[0]?.from?.toLowerCase();
    if (from && from !== '0x0000000000000000000000000000000000000000') return from;
  } catch {}

  return null;
}

async function fetchBSHolders(addr) {
  // Blockscout v2 API → Blockscout v1 API → Basescan
  const [d, d2, d3] = await Promise.all([
    axios.get(`https://base.blockscout.com/api/v2/tokens/${addr}/holders?limit=20`, { timeout: 8000, ...blkHdr() }).then(r => r.data).catch(() => null),
    axios.get(`https://base.blockscout.com/api?module=token&action=getTokenHolders&contractaddress=${addr}&page=1&offset=20`, { timeout: 7000 }).then(r => r.data).catch(() => null),
    axios.get(`${BASESCAN_API}?module=token&action=tokenholderlist&contractaddress=${addr}&page=1&offset=20${bsKey()}`, { timeout: 7000 }).then(r => r.data).catch(() => null),
  ]);
  if (d?.items?.length > 0) return d.items;
  if (Array.isArray(d2?.result) && d2.result.length > 0) {
    return d2.result.map(h => ({ address: { hash: h.address, is_contract: false }, value: h.value }));
  }
  if (Array.isArray(d3?.result) && d3.result.length > 0) {
    return d3.result.map(h => ({ address: { hash: h.TokenHolderAddress, is_contract: false }, value: h.TokenHolderQuantity }));
  }
  return null;
}

async function fetchBSContract(addr) {
  const [d, d2] = await Promise.all([
    axios.get(`https://base.blockscout.com/api/v2/smart-contracts/${addr}`, { timeout: 7000, ...blkHdr() }).then(r => r.data).catch(() => null),
    axios.get(`${BASESCAN_API}?module=contract&action=getsourcecode&address=${addr}${bsKey()}`, { timeout: 7000 }).then(r => r.data).catch(() => null),
  ]);
  if (d?.name !== undefined || d?.is_verified !== undefined) return d;
  if (d2?.status === '1' && d2?.result?.[0]) {
    const r = d2.result[0];
    let abi = null;
    if (r.ABI && r.ABI !== 'Contract source code not verified') {
      try { abi = JSON.parse(r.ABI); } catch { abi = r.ABI; }
    }
    return {
      name:             r.ContractName || null,
      is_verified:      !!(r.SourceCode && r.SourceCode !== ''),
      compiler_version: r.CompilerVersion || null,
      abi,
      is_contract:      true,
    };
  }
  return null;
}

async function fetchBSAddress(addr) {
  try {
    const { data } = await axios.get(`https://base.blockscout.com/api/v2/addresses/${addr}`, { timeout: 7000, ...blkHdr() });
    if (data) return data;
  } catch {}
  return { transaction_count: null, is_contract: false };
}

// ─── Flaunch REST API ─────────────────────────────────────────────────────────
    // Docs: GET /v1/base/tokens/:addr (info dasar) | GET /v1/base/tokens/:addr/details (fairLaunchActive di status{})
    // ⚠️ dev-api.flayerlabs.xyz kadang 522 — Method 3 (API) bisa gagal total, graceful degradation aktif
    async function fetchFlaunchInfo(addr) {
    try {
      const [r1, r2, r3] = await Promise.allSettled([
        // Endpoint utama — berisi name, symbol, marketCap, dll
        axios.get(`${FLAUNCH_API}/v1/base/tokens/${addr}`, { timeout: 7000 }).then(r => r.data),
        // Endpoint details — fairLaunchActive ada di dalam status{}
        axios.get(`${FLAUNCH_API}/v1/base/tokens/${addr}/details`, { timeout: 7000 }).then(r => r.data),
        // Legacy endpoint (kompatibilitas mundur)
        axios.get(`${FLAUNCH_API}/v1/base/token/${addr}`, { timeout: 7000 }).then(r => r.data),
      ]);
      // Pilih data dasar dari endpoint yang berhasil (r1 utama, r3 legacy, r2 /details sebagai fallback)
      const d = (r1.status === 'fulfilled' && r1.value && !r1.value.error) ? r1.value
              : (r3.status === 'fulfilled' && r3.value && !r3.value.error) ? r3.value
              : null;
      // Jika basic/legacy endpoint gagal tapi /details berhasil, /details cukup untuk konfirmasi
      const detailsOnlyRaw = !d && (r2.status === 'fulfilled' && r2.value && !r2.value.error)
        ? (r2.value?.data || r2.value) : null;
      const rawBase = d ? (d.data || d) : detailsOnlyRaw;
      if (!rawBase) return null;
      const raw = rawBase;
      if (!raw?.tokenAddress && !raw?.symbol && !raw?.name && !raw?.status) return null;

      // fairLaunchActive: cek dari basic response ATAU dari /details .status.fairLaunchActive
      const detailsRaw = (r2.status === 'fulfilled' && r2.value && !r2.value.error)
        ? (r2.value?.data || r2.value) : null;
      const fairLaunchRaw = raw.fairLaunchActive ?? detailsRaw?.status?.fairLaunchActive ?? null;
      const fairLaunchActive = fairLaunchRaw === true  || fairLaunchRaw === 'true'  ? true
                             : fairLaunchRaw === false || fairLaunchRaw === 'false' ? false
                             : null; // null = API tidak merespon, status tidak diketahui

      return {
        tokenAddress:     (raw.tokenAddress || raw.address || addr).toLowerCase(),
        name:             raw.name             || null,
        symbol:           raw.symbol           || null,
        description:      raw.description      || null,
        image:            raw.image            || null,
        marketCapETH:     raw.marketCapETH     || raw.market_cap_eth
                          || detailsRaw?.price?.marketCapETH || null,
        createdAt:        raw.createdAt        || raw.created_at     || null,
        fairLaunchActive,  // boolean | null (null jika API tidak merespon)
        ownerAddress:     (raw.ownerAddress || raw.owner_address || null)?.toLowerCase() || null,
        manager:          raw.manager          || null,
        // positionManager: field ini TIDAK ADA di REST API response — selalu null
        positionManager:  null,
      };
    } catch { return null; }
    }

    // ─── STEP 1–9: Risk Scoring Engine ───────────────────────────────────────────
function computeScore({
  addr, rpcData, allData, goplus, pairs, tokenInfo,
  holders, contractInfo, deployerInfo, deployerAddr,
  deployerEthBal, deployerNonce, contractCreator, flaunchInfo,
  dopplerRpc, bankrApi,
}) {
  const R = [], Y = [], G = [], I = [];
  let score = 0;
  const add = (list, msg, pts = 0) => { list.push(msg); score += pts; };

  const pair = pairs?.[0] || null;

  // ── STEP 1: Clanker detection — multi-layer ──
  const creatorFromBasescan   = (contractCreator || '').toLowerCase();
  const creatorFromBlockscout = (tokenInfo?.creator_address_hash || '').toLowerCase();
  const creatorHash = creatorFromBasescan || creatorFromBlockscout || '';

  // ── STEP 1c: Bankr "eco" (Doppler) detection — multi-layer ──
  // Layer 1: contract creator cocok dengan template Doppler resmi.
  // Layer 2: token punya pool()/isPoolUnlocked() (ABI shape khas Doppler).
  // Layer 3: Bankr public API konfirmasi source="doppler" secara independen.
  const isDopplerFactory = !!DOPPLER_TEMPLATES[creatorHash];
  const dopplerFactoryName = DOPPLER_TEMPLATES[creatorHash] || null;
  const hasDopplerAbi = !!(dopplerRpc && (dopplerRpc.poolAddress !== null || dopplerRpc.poolUnlocked !== null));
  const isDoppler = isDopplerFactory || hasDopplerAbi || !!bankrApi?.found;
  const dopplerPoolAddr = dopplerRpc?.poolAddress || bankrApi?.poolAddress || null;
  const dopplerPoolBurned = dopplerPoolAddr ? BURN_ADDRS.includes(dopplerPoolAddr.toLowerCase()) : false;
  const dopplerPoolUnlocked = dopplerRpc?.poolUnlocked !== null && dopplerRpc?.poolUnlocked !== undefined
    ? dopplerRpc.poolUnlocked : bankrApi?.isPoolUnlocked;
  const dopplerPoolLocked = dopplerPoolUnlocked === false || dopplerPoolBurned;

  const isCreatedViaClankerFactory = !!CLANKER_FACTORIES[creatorHash];
  const clankerFactoryName         = CLANKER_FACTORIES[creatorHash] || null;
  const hasClankerContext          = allData?.context?.toLowerCase?.().includes('clanker') || false;
  const isFarcasterClanker         = allData?.context?.toLowerCase?.().includes('farcaster') ||
                                     allData?.platform?.toLowerCase?.().includes('farcaster') || false;
  const hasAllData                 = allData !== null;
  const hasIsVerifiedFunction      = rpcData?.isVerified !== null && rpcData?.isVerified !== undefined;

  let isClankerAbi = false, hasValidAbi = false;
  if (contractInfo?.abi) {
    try {
      const abiStr = (typeof contractInfo.abi === 'string'
        ? contractInfo.abi
        : JSON.stringify(contractInfo.abi)).toLowerCase();
      isClankerAbi = abiStr.includes('alldata') && abiStr.includes('originaladmin');
      hasValidAbi  = abiStr.length > 100;
    } catch {}
  }

  const isClanker = isCreatedViaClankerFactory || hasAllData || hasIsVerifiedFunction || hasClankerContext || isClankerAbi;

    // ── STEP 1b: Flaunch detection ──
    // Method 1 (fallback): creator address match
    const flaunchFactoryAddr = Object.keys(FLAUNCH_POSITION_MANAGERS).find(k => creatorHash === k) || null;
    const isFlaunchFactory   = !!flaunchFactoryAddr;
    const flaunchVersionName = flaunchFactoryAddr ? FLAUNCH_POSITION_MANAGERS[flaunchFactoryAddr] : null;

    // Method 2 (PRIMARY): Flaunch token = EIP-1167 clone dari Memecoin template
    // Terdeteksi via proxy_type + implementations dari Blockscout /addresses/ (sudah di-inject ke tokenInfo)
    // proxy_type sudah di-normalize (lowercase, strip non-alnum) di fetchBSToken → 'eip1167'
    const isFlaunchProxy = !!(tokenInfo?.proxy_type?.replace(/[^a-z0-9]/g, '') === 'eip1167' &&
      Array.isArray(tokenInfo?.implementations) &&
      tokenInfo.implementations.some(
        impl => FLAUNCH_MEMECOIN_TEMPLATES.has((impl.address_hash || '').toLowerCase())
      ));

    // Method 3: Flaunch REST API confirmation
    const isFlaunchApi = !!(flaunchInfo?.tokenAddress);

    // Combined — salah satu cukup untuk deteksi
    const isFlaunch = isFlaunchFactory || isFlaunchProxy || isFlaunchApi;

  // ── STEP 2: Source verification ──
  // Catatan: contractInfo.is_verified dari /smart-contracts/ endpoint
  // Untuk EIP-1167 proxy (Flaunch), endpoint ini return undefined — TAPI
  // /addresses/ endpoint return is_verified=true karena implementation template-nya verified.
  // Gunakan tokenInfo.is_verified (dari /addresses/ via fetchBSToken) sebagai fallback.
  const sourceVerified = contractInfo?.is_verified === true || tokenInfo?.is_verified === true;
  if (isDoppler) {
    if (sourceVerified) add(G, 'Source code terverifikasi di explorer ✓');
    else add(I, 'Source code: Bankr/Doppler template bytecode — template standar (minimal-proxy), verifikasi di explorer tidak wajib');
  } else if (isFlaunch) {
    // Semua token Flaunch = EIP-1167 proxy dari template terverifikasi (Memecoin / MemecoinTreasury)
    // Blockscout /addresses/ menandai is_verified=true untuk semua proxy dengan verified implementation
    const implAddr = (tokenInfo?.implementations?.[0]?.address_hash || '').toLowerCase();
    const templateName = implAddr === '0xf1eeeeeeecd95e9eb2df58484ceed175acbd945c' ? 'Memecoin'
                       : implAddr === '0xa327725c2dcd8077dbc49701dd7a673ffb768145' ? 'MemecoinTreasury'
                       : 'Memecoin template';
    add(G, 'Source code: EIP-1167 proxy dari template **' + templateName + '** yang terverifikasi di Blockscout ✓');
    add(I, 'Template: [basescan](<https://basescan.org/address/' + (implAddr || '0xf1eeeeeeecd95e9eb2df58484ceed175acbd945c') + '>) — source terbuka, bisa diaudit siapapun');
  } else if (isClanker) {
    if (sourceVerified) add(G, 'Source code terverifikasi di explorer ✓');
    else add(I, 'Source code: Clanker factory bytecode — template standar, verifikasi di explorer tidak wajib');
  } else {
    if (!sourceVerified) add(Y, 'Source code kontrak TIDAK terverifikasi di explorer', 1);
    else add(G, 'Source code terverifikasi di Blockscout ✓');
  }

  // ── STEP 3: Clanker-specific analysis ──
  if (isClanker) {
    if (isCreatedViaClankerFactory) {
      add(G, 'Token dibuat via Clanker Factory resmi: ' + clankerFactoryName + ' ✓');
    } else if (hasIsVerifiedFunction || hasAllData) {
      add(I, 'Token terdeteksi Clanker via RPC (isVerified/allData), factory belum terindex di Basescan (mungkin terlalu baru)');
    } else if (hasClankerContext || isClankerAbi) {
      add(Y, 'Token bergaya Clanker (dari context/ABI), factory & isVerified belum terkonfirmasi', 1);
    }

    // Parse context JSON untuk deteksi interface (clanker.world vs lainnya)
    let parsedCtx = null;
    try { if (allData?.context) parsedCtx = JSON.parse(allData.context); } catch {}
    const isClankerWorldInterface = parsedCtx?.interface === 'clanker.world';

    if (rpcData.isVerified === true) {
      add(G, 'isVerified() = TRUE — Deploy via clanker.world web interface (verifikasi penuh on-chain) ✓');
    } else if (rpcData.isVerified === false) {
      if (isClankerWorldInterface) {
        // Deploy via clanker.world miniapp/Farcaster — isVerified=false adalah NORMAL (miniapp tidak trigger verify())
        add(G, 'Deploy via clanker.world (' + (parsedCtx?.platform || '3rd-party') + ') ✓ — isVerified()=false normal untuk jalur miniapp/Farcaster');
      } else if (isCreatedViaClankerFactory) {
        // Factory resmi terkonfirmasi tapi bukan clanker.world interface
        add(I, 'isVerified() = FALSE — Deploy via ' + clankerFactoryName + ' (factory resmi), bukan clanker.world interface. LP aman via factory.');
      } else {
        // Factory tidak dikenal + bukan clanker.world = perlu perhatian
        add(Y, 'isVerified() = FALSE & context bukan clanker.world — token tidak melewati interface resmi Clanker', 1);
      }
    } else if (hasIsVerifiedFunction) {
      add(I, 'isVerified() callable tapi no response — token sudah kena timeout, coba scan ulang');
    }

    if (allData) {
      if (parsedCtx) add(I, 'Platform: ' + (parsedCtx.interface || '?') + ' via ' + (parsedCtx.platform || '?') + (parsedCtx.id ? ' (id:' + parsedCtx.id + ')' : ''));
      else if (allData.context) add(I, 'Platform context: ' + allData.context);
      if (!allData.image)    add(Y, 'allData(): Tidak ada image/logo token', 1);
      if (!allData.metadata) add(Y, 'allData(): Tidak ada metadata/social token', 1);
      if (allData.originalAdmin && allData.admin && allData.originalAdmin !== allData.admin) {
        add(Y, 'Admin dipindahkan: ' + allData.originalAdmin.slice(0, 10) + '… → ' + allData.admin.slice(0, 10) + '…', 1);
      }
      if (allData.admin) add(I, 'Current admin: ' + allData.admin);
    }
  }

  // ── STEP 3b: Bankr "eco" (Doppler) — analisis pool lock ──
  if (isDoppler) {
    if (isDopplerFactory) {
      add(G, 'Token dibuat via Bankr "eco" launch flow — template: ' + dopplerFactoryName + ' ✓');
    } else if (bankrApi?.found) {
      add(I, 'Token terkonfirmasi Bankr/Doppler via API (bankr.bot), factory template belum terverifikasi via creator address');
    } else if (hasDopplerAbi) {
      add(Y, 'Token bergaya Bankr/Doppler (ABI punya pool()/isPoolUnlocked()), belum terkonfirmasi via factory/API', 1);
    }
    if (dopplerPoolAddr) add(I, 'Doppler pool(): ' + dopplerPoolAddr);
    if (dopplerPoolLocked) {
      add(G, 'isPoolUnlocked() = FALSE' + (dopplerPoolBurned ? ' & pool() sudah di-burn ke dead address' : '') + ' — likuiditas TERKUNCI, tidak bisa ditarik ✓');
    } else if (dopplerPoolUnlocked === true) {
      add(R, '⚠️ isPoolUnlocked() = TRUE — likuiditas Doppler BELUM terkunci, developer BISA menarik pool', 3);
    } else {
      add(Y, 'Status kunci pool Doppler tidak dapat dikonfirmasi (RPC/API gagal merespon) — verifikasi manual disarankan', 1);
    }
  }

  // ── STEP 4: LP Lock status ──
  const lpLock = parseLPLock(goplus);
    if (isDoppler && dopplerPoolLocked) {
      add(G, 'LP STATUS: Pool Doppler/Bankr terkunci (isPoolUnlocked=false / burned) — tidak bisa di-rug ✓');
    } else if (isFlaunch) {
      add(G, 'LP STATUS: LP ada di Uniswap v4 Pool resmi Flaunch — dikontrol PositionManager, tidak bisa di-rug ✓');
      if (flaunchInfo?.fairLaunchActive === true) {
        add(I, 'FAIR LAUNCH masih AKTIF — harga fixed price, koin TIDAK BISA dijual hingga Fair Launch selesai (~30 menit)');
      } else if (flaunchInfo?.fairLaunchActive === false) {
        add(I, 'Fair Launch sudah selesai — trading bebas via Uniswap v4');
      } else {
        add(I, 'Status Fair Launch tidak dapat dikonfirmasi (Flaunch API tidak merespon) — cek manual di flaunch.gg');
      }
    } else if (isClanker && (isCreatedViaClankerFactory || hasAllData)) {
      add(G, 'LP STATUS: LP ada di Uniswap v4 Pool resmi Clanker — tidak bisa di-rug oleh admin ✓');
    } else {
    if (lpLock.hasData) {
      if (lpLock.locked && lpLock.lockedPct >= 80) {
        add(G, 'LP LOCKED: ' + lpLock.lockedPct.toFixed(1) + '% LP terkunci via ' + lpLock.lockerNames.join(', ') + ' ✓');
      } else if (lpLock.locked) {
        add(Y, 'LP sebagian terkunci: ' + lpLock.lockedPct.toFixed(1) + '% via ' + lpLock.lockerNames.join(', ') + ' — ' + (100 - lpLock.lockedPct).toFixed(1) + '% masih bisa di-remove', 1);
      } else if (lpLock.burnedPct >= 80) {
        add(G, 'LP BURNED: ' + lpLock.burnedPct.toFixed(1) + '% LP sudah di-burn ke dead address — permanen ✓');
      } else if (lpLock.burnedPct > 0) {
        add(Y, 'LP sebagian di-burn: ' + lpLock.burnedPct.toFixed(1) + '% — sisa bisa di-remove', 1);
      } else {
        add(R, 'LP TIDAK DIKUNCI & TIDAK DI-BURN — deployer bisa remove liquidity kapanpun (rug risk!)', 3);
      }
    } else if (goplus) {
      add(Y, 'Status LP lock tidak bisa dikonfirmasi — cek manual via DeFi Scanner / Basescan', 1);
    } else {
      add(Y, 'GoPlus tidak tersedia — LP lock tidak bisa dideteksi otomatis', 1);
    }
  }

  // ── STEP 5: GoPlus security scan ──
  if (goplus) {
    if (goplus.is_honeypot === '1')           add(R, '🍯 HONEYPOT — token tidak bisa dijual!', 5);
    if (goplus.is_mintable === '1')           add(R, 'Fungsi MINT ada — supply bisa ditambah oleh owner', 3);
    if (goplus.owner_change_balance === '1')  add(R, 'Owner bisa ubah balance wallet lain secara langsung', 4);
    if (goplus.hidden_owner === '1')          add(R, 'Hidden owner / backdoor tersembunyi terdeteksi', 3);
    if (goplus.is_blacklisted === '1')        add(R, 'Fungsi BLACKLIST — owner bisa blokir wallet', 2);
    if (goplus.slippage_modifiable === '1')   add(R, 'Slippage bisa dimodifikasi oleh owner', 2);
    if (goplus.cannot_sell_all === '1')       add(R, 'Tidak bisa sell semua token sekaligus', 2);
    if (goplus.transfer_pausable === '1')     add(R, 'Transfer bisa di-pause oleh owner', 2);
    if (goplus.is_proxy === '1')              add(Y, 'Proxy contract — logika bisa diupgrade oleh owner', 1);
    if (goplus.trading_cooldown === '1')      add(Y, 'Trading cooldown aktif antar transaksi', 1);
    if (goplus.is_anti_whale === '1')         add(I, 'Anti-whale mechanism aktif');
    if (goplus.personal_slippage_modifiable === '1') add(Y, 'Slippage bisa diset per-wallet oleh owner', 1);

    const buyTax  = goplus.buy_tax  ? parseFloat(goplus.buy_tax)  * 100 : 0;
    const sellTax = goplus.sell_tax ? parseFloat(goplus.sell_tax) * 100 : 0;
    if (buyTax > 10)       add(R, 'Buy tax sangat tinggi: ' + buyTax.toFixed(1) + '%', 2);
    else if (buyTax > 5)   add(Y, 'Buy tax tinggi: ' + buyTax.toFixed(1) + '%', 1);
    else if (buyTax > 0)   add(G, 'Buy tax wajar: ' + buyTax.toFixed(1) + '% ✓');
    else                   add(G, 'Buy tax: 0% ✓');

    if (sellTax > 10)      add(R, 'Sell tax sangat tinggi: ' + sellTax.toFixed(1) + '%', 2);
    else if (sellTax > 5)  add(Y, 'Sell tax tinggi: ' + sellTax.toFixed(1) + '%', 1);
    else if (sellTax > 0)  add(G, 'Sell tax wajar: ' + sellTax.toFixed(1) + '% ✓');
    else                   add(G, 'Sell tax: 0% ✓');

    const creatorPct = goplus.creator_percent ? parseFloat(goplus.creator_percent) * 100 : 0;
      if (isFlaunch) {
        if (creatorPct > 0) add(I, 'Creator revenue allocation: ' + creatorPct.toFixed(2) + '% (normal untuk Flaunch — creator dapat share dari swap fee)');
      } else if (isDoppler) {
        if (creatorPct > 0) add(I, 'Creator/deployer allocation: ' + creatorPct.toFixed(2) + '% (normal untuk Bankr "eco" launch)');
      } else if (isClanker) {
        if (creatorPct > 0) add(I, 'Creator reward allocation: ' + creatorPct.toFixed(2) + '% (normal untuk Clanker)');
    } else {
      if (creatorPct > 15)      add(R, 'Creator masih pegang ' + creatorPct.toFixed(1) + '% supply — dump risk', 2);
      else if (creatorPct > 5)  add(Y, 'Creator masih pegang ' + creatorPct.toFixed(1) + '% supply', 1);
      else if (creatorPct > 0)  add(G, 'Creator holding rendah: ' + creatorPct.toFixed(2) + '% ✓');
    }

    if (goplus.is_in_dex === '0') add(R, 'Token tidak listing di DEX apapun', 3);
    if (goplus.is_open_source === '0' && !isClanker && !isDoppler && !sourceVerified) {
      add(Y, 'GoPlus: Source code tidak open source di manapun (konfirmasi dari 2 sumber)', 1);
    }
  } else {
    add(Y, 'GoPlus Security scan tidak tersedia (CORS / token terlalu baru)', 1);
  }

  // ── STEP 6: ABI dangerous functions ──
  if (contractInfo?.abi) {
    const abiStr = JSON.stringify(contractInfo.abi).toLowerCase();
    const hits = DANGER_FN_LIST.filter(fn => abiStr.includes('"' + fn + '"'));
    if (hits.length > 0) add(Y, 'Fungsi berbahaya di ABI: ' + hits.join(', '), hits.length);
    else add(G, 'Tidak ada fungsi berbahaya di ABI ✓');
  } else if (isDoppler) {
    add(I, 'ABI tidak fully tersedia — tapi Bankr/Doppler template bytecode sudah standard, aman');
  } else if (isClanker) {
    if (hasValidAbi) add(G, 'ABI dapat di-scan (Clanker factory) ✓ — "tidak terverifikasi" di Basescan normal untuk factory pattern');
    else add(I, 'ABI tidak fully tersedia — tapi Clanker factory bytecode sudah standard, aman');
  } else {
    add(Y, 'ABI tidak tersedia — tidak bisa scan fungsi berbahaya', 1);
  }

  // ── STEP 7: Market data ──
  if (!pair) {
    add(I, 'Belum ada pair di GeckoTerminal/Base — Token terlalu baru, sedang di-index. Tunggu 15-30 menit lalu scan ulang.', 0);
  } else {
    const liq = pair.liquidity?.usd || 0;
    const age = pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000) : null;
    const pc24 = pair.priceChange?.h24;

    if (liq < 1000)       add(R, 'Likuiditas sangat rendah: $' + liq.toFixed(0), 3);
    else if (liq < 5000)  add(Y, 'Likuiditas rendah: $' + fmtNum(liq), 1);
    else if (liq < 50000) add(Y, 'Likuiditas sedang: $' + fmtNum(liq));
    else                  add(G, 'Likuiditas cukup: $' + fmtNum(liq) + ' ✓');

    if (age !== null && age < 1)   add(R, 'Token dibuat HARI INI — sangat baru', 1);
    else if (age !== null && age < 7) add(Y, 'Token baru: ' + age + ' hari', 1);

    if (pc24 !== null && pc24 !== undefined) {
      if (pc24 > 200)       add(R, 'Pump ekstrem 24h: +' + pc24.toFixed(0) + '% — potensi pump & dump', 2);
      else if (pc24 > 50)   add(Y, 'Kenaikan tajam 24h: +' + pc24.toFixed(0) + '%', 1);
      else if (pc24 < -70)  add(R, 'Crash besar 24h: ' + pc24.toFixed(0) + '% — kemungkinan rug', 2);
      else if (pc24 < -30)  add(Y, 'Penurunan tajam 24h: ' + pc24.toFixed(0) + '%', 1);
    }
  }

  // ── STEP 8: Holder concentration ──
  let concData = null;
  const supply = rpcData.totalSupply || (tokenInfo?.total_supply ? BigInt(tokenInfo.total_supply) : null);
  if (holders?.length > 0 && supply && supply > 0n) {
    const realHolders = holders.filter(h => {
      const ha = ((h.address?.hash || h.address) || '').toString().toLowerCase();
      return !POOL_ADDRS.has(ha) && ha !== '0x0000000000000000000000000000000000000000' && ha.length > 0;
    });
    let top3 = 0n, top10 = 0n;
    realHolders.slice(0, 3).forEach(h  => { try { top3  += BigInt(h.value || '0'); } catch {} });
    realHolders.slice(0, 10).forEach(h => { try { top10 += BigInt(h.value || '0'); } catch {} });
    const pct = n => Number((n * 10000n) / supply) / 100;
    const t3 = pct(top3), t10 = pct(top10);
    concData = { top3Pct: t3, top10Pct: t10, realHolders };

    if (t3 > 40)       add(R, 'Top 3 holder (non-pool) kuasai ' + t3.toFixed(1) + '% supply — sangat terkonsentrasi', 3);
    else if (t3 > 20)  add(Y, 'Top 3 holder kuasai ' + t3.toFixed(1) + '%', 1);
    else               add(G, 'Distribusi top 3 holder wajar: ' + t3.toFixed(1) + '% ✓');

    if (t10 > 60)      add(R, 'Top 10 holder kuasai ' + t10.toFixed(1) + '% — risiko dump besar', 2);
    else if (t10 > 40) add(Y, 'Top 10 holder kuasai ' + t10.toFixed(1) + '%', 1);
    else               add(G, 'Distribusi top 10 holder wajar: ' + t10.toFixed(1) + '% ✓');
  }

  const holderCount = tokenInfo?.holders_count ? parseInt(tokenInfo.holders_count) : 0;
  if (holderCount > 0 && holderCount < 30)       add(R, 'Jumlah holder sangat sedikit: ' + holderCount, 2);
  else if (holderCount > 0 && holderCount < 100) add(Y, 'Jumlah holder sedikit: ' + holderCount, 1);
  else if (holderCount >= 500)                   add(G, 'Holder cukup banyak: ' + holderCount + ' ✓');

  // ── STEP 9: Deployer forensics ──
  const txCount = deployerNonce ?? deployerInfo?.transaction_count ?? deployerInfo?.tx_count ?? null;
  if (txCount !== null) {
    if (txCount < 5)        add(R, 'Deployer wallet sangat baru — hanya ' + txCount + ' tx', 2);
    else if (txCount < 20)  add(Y, 'Deployer wallet masih baru: ' + txCount + ' tx', 1);
    else                    add(G, 'Deployer wallet berpengalaman: ' + txCount + ' tx ✓');
    if (!isClanker && !isDoppler && deployerInfo?.is_contract === false && txCount < 10) {
      add(Y, 'Deployer EOA baru tanpa history — risiko lebih tinggi', 1);
    }
  } else {
    add(Y, 'Data deployer tidak tersedia', 1);
  }

  if (deployerEthBal !== null) {
    const ethBal = Number(deployerEthBal) / 1e18;
    if (ethBal > 10) add(I, 'Deployer masih pegang ' + ethBal.toFixed(3) + ' ETH');
  }

  if (!tokenInfo?.website && !allData?.metadata) add(Y, 'Tidak ada website/metadata resmi', 1);

  // ── Verdict ──
  const totalFlags = R.length + Y.length;
  let verdict;
  if (score >= 15)     verdict = 'EXTREME';
  else if (score >= 8) verdict = 'HIGH';
  else if (score >= 4) verdict = 'MEDIUM';
  else                 verdict = 'LOW';

  return {
    addr, verdict, score, totalFlags,
    isClanker, isCreatedViaClankerFactory, clankerFactoryName, creatorHash,
    hasIsVerifiedFunction, isFarcasterClanker, lpLock, concData, supply,
    isFlaunch, isFlaunchFactory, isFlaunchProxy, flaunchVersionName, flaunchFactoryAddr,
    isDoppler, isDopplerFactory, dopplerFactoryName, dopplerPoolAddr,
    dopplerPoolUnlocked, dopplerPoolBurned, dopplerPoolLocked,
    flags: { red: R, yellow: Y, green: G, info: I },
  };
}

// ─── Discord text formatter ───────────────────────────────────────────────────
function formatDiscord({
  addr, verdict, score, totalFlags,
  isClanker, isCreatedViaClankerFactory, clankerFactoryName, creatorHash,
  hasIsVerifiedFunction, isFarcasterClanker, lpLock, concData, supply,
  isFlaunch, isFlaunchFactory, isFlaunchProxy, flaunchVersionName, flaunchFactoryAddr,
  isDoppler, isDopplerFactory, dopplerFactoryName, dopplerPoolAddr,
  dopplerPoolUnlocked, dopplerPoolBurned, dopplerPoolLocked,
  flags,
  // raw data
  rpcData, allData, goplus, pairs, tokenInfo, holders,
  deployerInfo, deployerAddr, deployerEthBal, deployerNonce, contractInfo,
  flaunchInfo, bankrApi,
}) {
  const lines = [];
  const pair    = pairs?.[0] || null;
  const name    = tokenInfo?.name    || rpcData.name    || 'UNKNOWN';
  const symbol  = tokenInfo?.symbol  || rpcData.symbol  || '???';
  const decimals = rpcData.decimals ?? parseInt(tokenInfo?.decimals || '18');

  const VE = { LOW: '🟢', MEDIUM: '🟡', HIGH: '🟠', EXTREME: '🔴' };
  const VD = {
    LOW:     'Tidak ada red flag signifikan. Tetap lakukan riset mandiri sebelum investasi.',
    MEDIUM:  'Ada beberapa tanda peringatan. Lakukan due diligence lebih mendalam.',
    HIGH:    'Multiple red flag terdeteksi. Hati-hati — kemungkinan rug atau scam.',
    EXTREME: 'RISIKO EKSTREM. Token ini sangat berbahaya. Kemungkinan besar scam/honeypot.',
  };

  // ── Header ──
  lines.push('```');
  lines.push('╔══════════════════════════════════════════╗');
  lines.push('  🔍 BASE FORENSICS  ·  ' + symbol + ' / ' + name);
  lines.push('╚══════════════════════════════════════════╝');
  lines.push('```');

  // ── Verdict ──
  const isVerStr = isDoppler
    ? (isDopplerFactory ? '🟠 BANKR ECO (' + dopplerFactoryName + ')'
      : bankrApi?.found ? '🟠 BANKR ECO (API confirmed)'
      : '⚠️ BANKR ECO-STYLE (deteksi via ABI)')
    : isFlaunch
    ? (isFlaunchFactory   ? '🟣 FLAUNCH (' + (flaunchVersionName || 'PositionManager') + ')'
      : isFlaunchProxy    ? '🟣 FLAUNCH (EIP-1167 proxy)'
      : '🟣 FLAUNCH (via API)')
    : isCreatedViaClankerFactory
      ? ('✅ CLANKER (' + clankerFactoryName + ')')
      : (allData != null)
        ? 'ℹ️ CLANKER (Farcaster / 3rd-party deploy)'
        : hasIsVerifiedFunction
          ? '⚠️ CLANKER (factory belum terkonfirmasi)'
          : isClanker
            ? '⚠️ CLANKER-STYLE (deteksi via context/ABI)'
            : 'ERC-20';
  lines.push(VE[verdict] + ' **' + verdict + ' RISK** | Score: **' + score + '/20** | ' + flags.red.length + ' 🔴  ' + flags.yellow.length + ' 🟡  ' + flags.green.length + ' ✅');
  lines.push('> ' + VD[verdict]);
  lines.push('[' + isVerStr + '] `' + addr + '`');
  lines.push('');

  // ── ① Token Overview ──
  lines.push('**① TOKEN OVERVIEW (BASE RPC)**');
  lines.push('• Contract: [basescan](<https://basescan.org/address/' + addr + '>)');
  if (supply)  lines.push('• Supply: ' + fmtSupply(supply, decimals));
  lines.push('• Decimals: ' + decimals);
  lines.push('• Owner: ' + (rpcData.owner ? short(rpcData.owner) : '✅ Renounced / N/A'));
  lines.push('• Holders: ' + (tokenInfo?.holders_count || 'N/A'));
  // Source: untuk EIP-1167 proxy (Flaunch), contractInfo.is_verified=undefined tapi tokenInfo.is_verified=true
  const _srcVerified = contractInfo?.is_verified === true || tokenInfo?.is_verified === true;
  lines.push('• Source: ' + (isFlaunch
    ? '✅ Verified (via EIP-1167 proxy → template terverifikasi)'
    : isDoppler
    ? (_srcVerified ? '✅ Verified' : 'ℹ️ Template Bankr/Doppler — verifikasi eksplisit tidak wajib')
    : _srcVerified ? '✅ Verified' : '❌ Tidak terverifikasi'));
  if (contractInfo?.compiler_version) lines.push('• Compiler: ' + contractInfo.compiler_version);
  lines.push('');

  // ── ② Bankr "eco" (Doppler) Ecosystem (jika terdeteksi) ──
  let _secNum = 2;
  if (isDoppler) {
    lines.push('**' + (_secNum) + ' 🟠 BANKR "ECO" (DOPPLER) — ANALISIS LENGKAP**');
    lines.push('• Platform: 🟠 **Bankr "eco"** — token launch flow via Doppler protocol (bankr.bot, Base-only)');
    if (isDopplerFactory) {
      lines.push('• Template: [basescan](<https://basescan.org/address/' + creatorHash + '>) (' + dopplerFactoryName + ')');
    } else if (bankrApi?.found) {
      lines.push('• Template: belum cocok dengan creator address, tapi Bankr API mengonfirmasi source="doppler"');
    } else {
      lines.push('• Template: terdeteksi via ABI shape (pool()/isPoolUnlocked()), belum terkonfirmasi factory/API');
    }
    lines.push('• pool(): ' + (dopplerPoolAddr ? short(dopplerPoolAddr) : '❌ tidak terbaca'));
    lines.push('• isPoolUnlocked(): ' + (
      dopplerPoolUnlocked === true  ? '⚠️ TRUE — pool BELUM terkunci' :
      dopplerPoolUnlocked === false ? '✅ FALSE — pool TERKUNCI' : '❓ tidak dapat dikonfirmasi'
    ));
    if (dopplerPoolBurned) lines.push('• pool() address: 🔥 sudah di-burn ke dead address — permanen terkunci');
    lines.push('• Status: ' + (dopplerPoolLocked
      ? '🔒 **LIKUIDITAS TERKUNCI** — tidak bisa ditarik developer ✓'
      : dopplerPoolUnlocked === true
        ? '🚨 **LIKUIDITAS BELUM TERKUNCI** — developer BISA menarik pool!'
        : '❓ Status tidak dapat dipastikan otomatis — verifikasi manual di basescan/bankr.bot'));
    lines.push('• 🔗 [Cek fee/pool via Bankr API](<https://api.bankr.bot/public/doppler/token-fees/' + addr + '>)');
    lines.push('');
    lines.push('ℹ️ **Tentang Bankr "eco" / Doppler:**');
    lines.push('• Semua token "eco" dideploy dari template minimal-proxy yang identik antar token — ini NORMAL, bukan red flag (sama seperti Clanker).');
    lines.push('• Keamanan LP ditentukan oleh isPoolUnlocked(): FALSE = aman (terkunci), TRUE = risiko rug likuiditas.');
    lines.push('• Jika pool() sudah di-burn ke dead address, likuiditas permanen tidak bisa ditarik siapapun.');
    lines.push('');
    _secNum = 3;
  }

  // ── Flaunch Ecosystem (jika terdeteksi) ──
    if (isFlaunch) {
      lines.push('**' + (_secNum++) + ' 🟣 FLAUNCH ECOSYSTEM — ANALISIS LENGKAP**');
      const pmName = flaunchVersionName || 'Flaunch PositionManager';
      lines.push('• Platform: 🟣 **Flaunch** — Fixed Price Fair Launch Protocol (Base)');
      if (isFlaunchFactory && flaunchFactoryAddr) {
        lines.push('• Factory/PM: [basescan](<https://basescan.org/address/' + flaunchFactoryAddr + '>) (' + pmName + ')');
      } else if (isFlaunchProxy) {
        lines.push('• Factory: Terdeteksi via EIP-1167 proxy signature (Memecoin template Flaunch)');
        lines.push('• PositionManager: [v1](<https://basescan.org/address/0x6A53F8b799bE11a2A3264eF0bfF183dCB12d9571>) | [v2](<https://basescan.org/address/0xB4512bf57d50fbcb64a3adF8b17a79b2A204C18C>)');
      } else {
        lines.push('• Factory: Terdeteksi via Flaunch API (PositionManager sebagai hook Uniswap v4)');
      }
      if (flaunchInfo?.fairLaunchActive === true) {
        lines.push('• Fair Launch: 🚦 **AKTIF** — Harga masih FIXED untuk semua buyer!');
        lines.push('  > ⚠️ Koin yang dibeli saat Fair Launch TIDAK BISA DIJUAL sampai periode selesai (~30 menit sejak launch). Aman dari harga rug, tapi ada lock sementara.');
      } else if (flaunchInfo?.fairLaunchActive === false) {
        lines.push('• Fair Launch: ✅ **SELESAI** — Trading bebas via Uniswap v4. Price discovery sudah aktif.');
      } else {
        lines.push('• Fair Launch: ❓ Status tidak diketahui (cek manual di flaunch.gg)');
      }
      if (flaunchInfo) {
        if (flaunchInfo.ownerAddress) lines.push('• Creator/Owner: [basescan](<https://basescan.org/address/' + flaunchInfo.ownerAddress + '>)');
        if (flaunchInfo.manager)      lines.push('• Revenue Manager: ' + flaunchInfo.manager);
        if (flaunchInfo.description)  lines.push('• Deskripsi: ' + String(flaunchInfo.description).slice(0, 120));
        if (flaunchInfo.marketCapETH) lines.push('• Market Cap (Flaunch): ' + parseFloat(flaunchInfo.marketCapETH).toFixed(4) + ' ETH');
        if (flaunchInfo.createdAt) {
          try {
            const ts = Number(flaunchInfo.createdAt);
            if (!isNaN(ts) && ts > 0) {
              const cd = new Date(ts * 1000).toISOString().slice(0, 10);
              lines.push('• Launch Date: ' + cd);
            }
          } catch {}
        }
        lines.push('• 🔗 [Lihat di Flaunch.gg](<https://flaunch.gg/base/coin/' + addr + '>)');
      }
      lines.push('');
      lines.push('ℹ️ **Tentang Flaunch:**');
      lines.push('• Flaunch = launchpad Uniswap v4 di Base. LP dikelola via PositionManager hook — tidak bisa di-remove oleh siapapun ✓');
      lines.push('• Creator otomatis dapat revenue dari setiap swap fee (tidak perlu rug untuk profit).');
      lines.push('• Fair Launch 30 menit pertama: semua orang dapat harga yang sama — sniper tidak punya keunggulan.');
      lines.push('');
    }

    // ── Clanker allData() ──
    lines.push('**' + (_secNum++) + ' CLANKER ALLDATA() — ON-CHAIN ADMIN & METADATA**');
  if (isClanker) {
    let _fmtCtx = null;
    try { if (allData?.context) _fmtCtx = JSON.parse(allData.context); } catch {}
    const _isClankerWorld = _fmtCtx?.interface === 'clanker.world';

    const factLabel = isCreatedViaClankerFactory ? clankerFactoryName
                    : _isClankerWorld             ? 'Clanker (' + (_fmtCtx?.platform || 'clanker.world') + ')'
                    : (hasIsVerifiedFunction || allData != null) ? 'CLANKER (RPC)'
                    : 'CLANKER-STYLE';
    lines.push('• Platform: ' + factLabel);
    if (isCreatedViaClankerFactory) {
      lines.push('• Factory: [basescan](<https://basescan.org/address/' + creatorHash + '>) (' + clankerFactoryName + ')');
    } else if (_isClankerWorld) {
      lines.push('• Factory: Clanker v4 (via clanker.world — belum terindex di Basescan, normal untuk token baru)');
    } else {
      lines.push('• Factory: Belum terkonfirmasi di Basescan (token terlalu baru?)');
    }
    lines.push('• isVerified(): ' + (
      rpcData.isVerified === true  ? '✅ TRUE — deploy via clanker.world web interface' :
      rpcData.isVerified === false && _isClankerWorld ? '✅ FALSE (normal) — miniapp/Farcaster tidak trigger verify() on-chain' :
      rpcData.isVerified === false ? 'ℹ️ FALSE — belum diverifikasi on-chain' : 'N/A'
    ));
    if (allData) {
      lines.push('• Orig Admin: ' + short(allData.originalAdmin) + '  →  Current Admin: ' + short(allData.admin));
      lines.push('• Image: ' + (allData.image    ? '✅ Ada' : '❌ Kosong'));
      lines.push('• Metadata: ' + (allData.metadata ? '✅ Ada' : '❌ Kosong'));
      if (allData.context) lines.push('• Context: ' + allData.context.slice(0, 80));
      if (rpcData.isVerified === true) {
        lines.push('> ✅ isVerified=TRUE — Token terverifikasi via clanker.world. LP terkunci di Uniswap v4 Pool Clanker.');
      } else if (rpcData.isVerified === false) {
        if (_isClankerWorld) {
          lines.push('> ✅ isVerified=FALSE normal — miniapp/Farcaster tidak memanggil verify() on-chain. LP aman via Clanker factory ✓');
        } else {
          lines.push('> ℹ️ isVerified=FALSE — Belum diverifikasi on-chain. LP lock ditentukan oleh factory, bukan nilai isVerified.');
        }
      }
    } else {
      const reason = isCreatedViaClankerFactory
        ? 'Dibuat via ' + clankerFactoryName + ' tapi allData() tidak ada → Clanker versi lama.'
        : 'isVerified() merespon tapi allData() tidak → mungkin Clanker versi lama.';
      lines.push('• allData(): Tidak tersedia — ' + reason);
    }
  } else {
    lines.push('• Bukan token Clanker — Regular ERC-20' + (isDoppler ? ' (lihat bagian BANKR ECO di atas untuk detail Doppler)' : ''));
  }
  lines.push('');

  // ── LP Lock ──
    lines.push('**' + (_secNum++) + ' LP LOCK STATUS**');
  if (isDoppler && dopplerPoolLocked) {
    lines.push('• Status: 🔒 **LP TERKUNCI** — Bankr "eco"/Doppler pool (' + (dopplerPoolBurned ? 'pool() di-burn ke dead address' : 'isPoolUnlocked()=false') + ')');
    lines.push('• Deployer tidak bisa menarik likuiditas selama status ini bertahan.');
  } else if (isDoppler) {
    lines.push('• Status: ' + (dopplerPoolUnlocked === true
      ? '🚨 **LP BELUM TERKUNCI** — isPoolUnlocked()=true, developer BISA menarik pool!'
      : '❓ Status kunci pool Doppler tidak dapat dikonfirmasi otomatis — verifikasi manual.'));
  } else if (isFlaunch) {  // Semua metode deteksi Flaunch (proxy/factory/api) → LP pasti terkunci via PositionManager
      lines.push('• Status: 🔒 **LP TERKUNCI PERMANEN** — Uniswap v4 via Flaunch PositionManager');
      lines.push('• Mekanisme: LP ada di **Uniswap v4 PoolManager** dikontrol hook PositionManager Flaunch — tidak bisa di-rug ✓');
      const pmAddr = flaunchFactoryAddr || '0x6A53F8b799bE11a2A3264eF0bfF183dCB12d9571';
      lines.push('• UV4 PoolManager: [basescan](<https://basescan.org/address/0x498581ff718922c3f8e6a244956af099b2652b2b>) — memegang seluruh LP token Flaunch');
      lines.push('• PositionManager hook: [basescan](<https://basescan.org/address/' + pmAddr + '>)');
      if (flaunchInfo?.fairLaunchActive === true) {
        lines.push('• ⚠️ Fair Launch AKTIF: koin yang dibeli sekarang tidak bisa dijual sampai periode selesai!');
      }
      lines.push('• Creator Revenue: Creator dapat % dari swap fee otomatis — tidak ada incentive untuk rug.');
      if (goplus?.lp_holders?.length > 0) {
        lines.push('• LP Holders (GoPlus):');
        goplus.lp_holders.slice(0, 3).forEach((h, i) => {
          const ha  = (h.address || '').toString();
          const pct = h.percent ? (parseFloat(h.percent) * 100).toFixed(2) : '?';
          const isLk  = h.is_locked === '1' || h.is_locked === 1;
          const isDead = ['0x000000000000000000000000000000000000dead','0x0000000000000000000000000000000000000000'].includes(ha.toLowerCase());
          const lockerLabel = LP_LOCKERS[ha.toLowerCase()];
          const badge = isDead ? '🔥 BURNED' : lockerLabel ? '🔒 ' + lockerLabel : isLk ? '🔒 LOCKED' : '⚠ FREE';
          lines.push('  #' + (i + 1) + ' ' + (ha ? ha.slice(0,8) + '…' + ha.slice(-4) : 'N/A') + ' ' + pct + '% ' + badge);
        });
      }
    } else if (isClanker && (isCreatedViaClankerFactory || allData != null)) {
      lines.push('• Status: 🔒 LP AMAN — Uniswap v4 Pool Clanker resmi');
      lines.push('• Admin TIDAK BISA remove liquidity — dikontrol smart contract Clanker.');
  } else if (lpLock?.hasData) {
    if (lpLock.locked && lpLock.lockedPct >= 80) {
      lines.push('• Status: 🔒 LP TERKUNCI ' + lpLock.lockedPct.toFixed(1) + '% — ' + lpLock.lockerNames.join(', '));
      lines.push('• Deployer tidak bisa remove liquidity selama kunci aktif.');
    } else if (lpLock.locked) {
      lines.push('• Status: ⚠️ LP SEBAGIAN TERKUNCI (' + lpLock.lockedPct.toFixed(1) + '%)');
      lines.push('• Sisa ' + (100 - lpLock.lockedPct).toFixed(1) + '% masih bisa di-remove oleh deployer.');
    } else if (lpLock.burnedPct >= 80) {
      lines.push('• Status: 🔥 LP BURNED ' + lpLock.burnedPct.toFixed(1) + '% — Permanen');
      lines.push('• Liquidity ini tidak bisa di-remove (di dead address).');
    } else if (lpLock.burnedPct > 0) {
      lines.push('• Status: ⚠️ LP SEBAGIAN DI-BURN (' + lpLock.burnedPct.toFixed(1) + '%)');
      lines.push('• Sisa ' + (100 - lpLock.burnedPct).toFixed(1) + '% masih bisa di-remove.');
    } else {
      lines.push('• Status: 🚨 LP TIDAK DIKUNCI & TIDAK DI-BURN');
      lines.push('• Deployer bisa remove seluruh liquidity kapanpun — rug risk utama!');
    }
    if (lpLock.lockerNames?.length > 0) lines.push('• Locker: ' + lpLock.lockerNames.join(', '));
    if (goplus?.lp_holders?.length > 0) {
      const topLpH = goplus.lp_holders.slice(0, 5);
      topLpH.forEach((h, i) => {
        const ha     = (h.address || '').toString();
        const isDead = ['0x000000000000000000000000000000000000dead','0x0000000000000000000000000000000000000000'].includes(ha.toLowerCase());
        const isLk   = h.is_locked === '1' || h.is_locked === 1;
        const pct    = h.percent ? (parseFloat(h.percent) * 100).toFixed(2) : '?';
        const tag    = isDead ? 'DEAD' : isLk ? 'LOCKED' : 'FREE';
        const badge  = isDead ? '🔥 BURNED' : isLk ? '🔒 LOCKED' : '⚠ FREE';
        lines.push('  #' + (i+1) + ' ' + (ha ? ha.slice(0, 8) + '…' + ha.slice(-4) : 'N/A') + ' [' + tag + '] ' + pct + '% ' + badge);
      });
    }
  } else if (isClanker) {
    lines.push('• ⚠️ Token bergaya Clanker (dari context/ABI) tapi factory belum terkonfirmasi di Basescan.');
    lines.push('• Status LP tidak bisa dipastikan otomatis. Periksa via GoPlus / DeFi Scanner / Basescan.');
  } else {
    lines.push('• ❓ Data LP lock tidak tersedia — GoPlus tidak merespon atau token terlalu baru.');
  }
  lines.push('');

  // ── Market Data ──
    lines.push('**' + (_secNum++) + ' MARKET DATA (GECKOTERMINAL / COINGECKO)**');
  if (pair) {
    const pc24 = pair.priceChange?.h24;
    const pcStr = pc24 != null ? (pc24 > 0 ? '+' : '') + pc24.toFixed(2) + '%' : 'N/A';
    const liqVal = pair.liquidity?.usd || 0;
    lines.push('• Harga: ' + fmtPrice(pair.priceUsd));
    lines.push('• Market Cap: ' + (pair.marketCap ? '$' + fmtNum(pair.marketCap) : 'N/A'));
    lines.push('• Likuiditas: ' + (liqVal ? '$' + fmtNum(liqVal) : 'N/A') + (liqVal < 5000 && liqVal > 0 ? ' ⚠️' : liqVal < 1000 && liqVal > 0 ? ' 🚨' : ''));
    lines.push('• Volume 24h: ' + (pair.volume?.h24 ? '$' + fmtNum(pair.volume.h24) : 'N/A'));
    lines.push('• Txns 24h: ' + (pair.txns?.h24 ? (pair.txns.h24.buys + pair.txns.h24.sells) : 'N/A'));
    lines.push('• Perubahan: ' + pcStr);
    lines.push('• Pair Umur: ' + fmtAge(pair.pairCreatedAt));
    lines.push('• Jml Pairs: ' + (pairs?.length || 0));
    lines.push('• Chart: [geckoterminal](<https://www.geckoterminal.com/base/tokens/' + addr + '>)');
  } else {
    lines.push('• N/A — Belum ada pair di GeckoTerminal (Base)');
    lines.push('• Token terlalu baru, GeckoTerminal masih index. Tunggu 15–30 menit lalu scan ulang.');
  }
  lines.push('');

  // ── GoPlus Security ──
  lines.push('**' + (_secNum++) + ' SECURITY SCAN (GOPLUS LABS)**');
  if (goplus) {
    const gp      = goplus;
    const hp      = gp.is_honeypot    === '1';
    const mint    = gp.is_mintable    === '1';
    const bl      = gp.is_blacklisted === '1';
    const hidOwn  = gp.hidden_owner   === '1';
    const proxy   = gp.is_proxy       === '1';
    const pause   = gp.transfer_pausable === '1';
    const slipM   = gp.slippage_modifiable === '1';
    const owChBal = gp.owner_change_balance === '1';
    const btxt    = gp.buy_tax  ? (parseFloat(gp.buy_tax)  * 100).toFixed(1) + '%' : 'N/A';
    const stxt    = gp.sell_tax ? (parseFloat(gp.sell_tax) * 100).toFixed(1) + '%' : 'N/A';
    const crPct   = gp.creator_percent ? (parseFloat(gp.creator_percent) * 100).toFixed(2) + '%' : 'N/A';
    const ownPct  = gp.owner_percent   ? (parseFloat(gp.owner_percent)   * 100).toFixed(2) + '%' : 'N/A';

    lines.push('• Honeypot: ' + (hp      ? '🚨 YA — JANGAN BELI!' : '✅ Tidak'));
    lines.push('• Mintable: ' + (mint     ? '⚠️ YA'               : '✅ Tidak'));
    lines.push('• Blacklist: ' + (bl      ? '⚠️ YA'               : '✅ Tidak'));
    lines.push('• Hidden Owner: ' + (hidOwn ? '🚨 YA'             : '✅ Tidak'));
    lines.push('• Proxy: ' + (proxy       ? '⚠️ YA'               : '✅ Tidak'));
    if (pause   ) lines.push('• Transfer Pause: 🚨 YA — bisa di-pause oleh owner');
    if (slipM   ) lines.push('• Slippage Mod: 🚨 YA — bisa dimodifikasi owner');
    if (owChBal ) lines.push('• Change Balance: 🚨 YA — owner bisa ubah balance wallet lain!');
    lines.push('• Buy Tax: ' + btxt + '  |  Sell Tax: ' + stxt);
    lines.push('• Creator Bal: ' + crPct + '  |  Owner Bal: ' + ownPct);
    lines.push('• LP Holders: ' + (gp.lp_holder_count || 'N/A'));
    if (!isClanker || !(isCreatedViaClankerFactory || allData != null)) {
      const lp = lpLock;
      const lpStatus = !lp?.hasData ? 'Data tidak tersedia' :
                       lp.locked && lp.lockedPct >= 80 ? '🔒 LOCKED ' + lp.lockedPct.toFixed(1) + '% (' + lp.lockerNames.join(', ') + ')' :
                       lp.locked ? '⚠ Sebagian Locked ' + lp.lockedPct.toFixed(1) + '%' :
                       lp.burnedPct >= 80 ? '🔥 BURNED ' + lp.burnedPct.toFixed(1) + '%' :
                       lp.burnedPct > 0  ? '⚠ Burned ' + lp.burnedPct.toFixed(1) + '% saja' :
                       '🚨 TIDAK DIKUNCI';
      lines.push('• LP Lock Status: ' + lpStatus);
    }
  } else {
    lines.push('• ⚠ GoPlus tidak bisa diakses.');
    lines.push('• Cek manual: [goplus](<https://gopluslabs.io/token-security/8453/' + addr + '>)');
  }
  lines.push('');

  // ── Holder Distribution ──
  lines.push('**' + (_secNum++) + ' HOLDER DISTRIBUTION**');
  if (concData) {
    lines.push('• Top 3: ' + concData.top3Pct.toFixed(1)  + '% ' + (concData.top3Pct  > 40 ? '🚨' : concData.top3Pct  > 20 ? '⚠️' : '✅'));
    lines.push('• Top 10: ' + concData.top10Pct.toFixed(1) + '% ' + (concData.top10Pct > 60 ? '🚨' : concData.top10Pct > 40 ? '⚠️' : '✅'));
  }
  if (holders?.length > 0 && supply && supply > 0n) {
    const allH = holders.slice(0, 15);
    allH.forEach((h, i) => {
      const ha     = ((h.address?.hash || h.address) || '').toString();
      const isPool = POOL_ADDRS.has(ha.toLowerCase());
      const isCtx  = h.address?.is_contract || false;
      let pct = 0;
      try { pct = Number((BigInt(h.value || '0') * 10000n) / supply) / 100; } catch {}
      const badge = isPool ? '[POOL]' : isCtx ? '[CONTRACT]' : '[EOA]';
      const flag  = isPool ? '' : pct > 15 ? ' 🚨' : pct > 5 ? ' ⚠️' : '';
      const pctStr = pct < 0.01 && pct > 0 ? pct.toExponential(2) : pct.toFixed(2);
      lines.push('  #' + (i + 1) + ' ' + (ha ? ha.slice(0, 6) + '…' + ha.slice(-4) : 'N/A') + ' ' + badge + ' ' + pctStr + '%' + flag);
    });
  } else {
    lines.push('• Data holder tidak tersedia — token terlalu baru atau API tidak response.');
  }
  lines.push('');

  // ── Deployer Forensics ──
  lines.push('**' + (_secNum++) + ' DEPLOYER FORENSICS**');
  const depAddr  = deployerAddr || 'Unknown';
  const depTxCnt = deployerNonce ?? deployerInfo?.transaction_count ?? deployerInfo?.tx_count;
  const depBal   = deployerEthBal !== null ? (Number(deployerEthBal) / 1e18).toFixed(4) + ' ETH' : 'N/A';
  const depIsCtx = deployerInfo?.is_contract ? 'Kontrak (Safe/Factory)' : 'EOA (wallet biasa)';
  const depLabel = depTxCnt !== undefined && depTxCnt !== null
    ? (depTxCnt < 10 ? 'FRESH WALLET 🚨' : depTxCnt < 50 ? 'BARU ⚠️' : 'AKTIF ✅')
    : 'UNKNOWN';

  lines.push('• Alamat: ' + (depAddr !== 'Unknown' ? '[basescan](<https://basescan.org/address/' + depAddr + '>)' : 'Unknown'));
  lines.push('• Tipe Wallet: ' + depIsCtx);
  lines.push('• Total Transaksi: ' + (depTxCnt !== undefined && depTxCnt !== null ? depTxCnt + ' (' + depLabel + ')' : 'N/A'));
  lines.push('• Saldo ETH: ' + depBal);
  lines.push('');

  // ── ⑧ Red Flags & Peringatan ──
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('**⑧ RED FLAGS & PERINGATAN (BANKR CHECKLIST)**');
  if (flags.red.length > 0)    flags.red.forEach(f    => lines.push('🔴 ' + f));
  if (flags.yellow.length > 0) flags.yellow.forEach(f => lines.push('🟡 ' + f));
  if (flags.green.length > 0)  flags.green.slice(0, 6).forEach(f => lines.push('✅ ' + f));
  if (flags.info.length > 0)   flags.info.forEach(f   => lines.push('ℹ️ ' + f));
  if (flags.red.length + flags.yellow.length + flags.green.length + flags.info.length === 0) {
    lines.push('⚠️ Tidak ada data cukup untuk analisis flag');
  }
  lines.push('');

  // ── ⑨ Panduan & Cek Manual ──
  lines.push('**⑨ PANDUAN & CEK MANUAL**');
  if (isClanker) {
    if (rpcData.isVerified === true) {
      lines.push('isVerified=TRUE → token sudah diverifikasi oleh clanker.world. LP di Uniswap v4 PoolManager Clanker.');
      lines.push('Admin **tidak bisa rug-pull LP.** Yang perlu diperhatikan: honeypot, tax, konsentrasi holder.');
    } else if (rpcData.isVerified === false) {
      lines.push('isVerified=FALSE → token belum diverifikasi oleh clanker.world (bisa karena baru atau 3rd-party deploy). LP aman jika via factory resmi.');
      lines.push('Bukan berarti scam, tapi LP tidak otomatis dikelola Clanker. **Periksa LP lock status.**');
    }
    lines.push('Ciri Clanker legit: factory address terkonfirmasi, allData() lengkap (image+metadata+context), admin Safe multisig. isVerified=TRUE adalah bonus verifikasi tambahan dari clanker.world.');
    lines.push('Red flag: "harus redeploy untuk fix tokenomics" — Clanker v4 support semua di deploy awal.');
    lines.push('• Clanker: [clanker.world](<https://clanker.world/token/' + addr + '>)');
  } else {
    lines.push('Ciri non-Clanker aman: source verified, LP lock/burn, owner renounced, 0% tax, holder tersebar.');
  }
  lines.push('• GoPlus: [goplus](<https://gopluslabs.io/token-security/8453/' + addr + '>)');
  lines.push('• TokenSniffer: [tokensniffer](<https://tokensniffer.com/token/base/' + addr + '>)');
  lines.push('• DeFi Scan: [de.fi](<https://de.fi/scanner?chain=base&address=' + addr + '>)');
  lines.push('');
  lines.push('_Analisis bersifat informatif, bukan saran investasi. Data: GoPlus · GeckoTerminal · Blockscout · Base RPC. Selalu **DYOR.**_');

  return lines.join('\n');
}

// ─── Main entrypoint ──────────────────────────────────────────────────────────
async function runBaseScanner(rawAddr) {
  const addr = (rawAddr || '').toLowerCase().trim();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    return '❌ Format CA tidak valid. Harus `0x` + 40 karakter hex.\nContoh: `!base 0x1234...abcd`';
  }

  // Round 1 — semua paralel (termasuk Flaunch API + Bankr/Doppler)
    const [rpcData, allData, goplus, pairs, tokenInfo, contractCreator, flaunchInfo, dopplerRpc, bankrApi] = await Promise.all([
      readTokenRPC(addr),
      readAllData(addr),
      fetchGoPlus(addr),
      fetchDex(addr),
      fetchBSToken(addr),
      fetchContractCreator(addr),
      fetchFlaunchInfo(addr),
      readDopplerRPC(addr),
      fetchBankrDoppler(addr),
    ]);

  // Validasi: bukan kontrak?
  if (!rpcData.totalSupply && !rpcData.name && !tokenInfo?.name) {
    return (
      '❌ Alamat `' + addr + '` bukan kontrak di Base atau tidak bisa diakses.\n\n' +
      'Kemungkinan: alamat salah, token ada di chain lain, atau belum deploy.'
    );
  }

  // Deployer address (GoPlus.creator_address > allData.originalAdmin > tokenInfo fallback)
  const deployerAddr = (goplus?.creator_address || allData?.originalAdmin || tokenInfo?.creator_address_hash || null)?.toLowerCase() || null;

  // Round 2 — paralel
  const [holders, contractInfo, deployerInfo, deployerRpc] = await Promise.all([
    fetchBSHolders(addr),
    fetchBSContract(addr),
    deployerAddr ? fetchBSAddress(deployerAddr) : Promise.resolve(null),
    deployerAddr ? rpcGetDeployer(deployerAddr)  : Promise.resolve({ nonce: null, balance: null }),
  ]);

  // Scoring
  const analysis = computeScore({
    addr, rpcData, allData, goplus, pairs, tokenInfo,
    holders, contractInfo, deployerInfo, deployerAddr,
    deployerEthBal: deployerRpc.balance,
    deployerNonce:  deployerRpc.nonce,
    contractCreator, flaunchInfo,
    dopplerRpc, bankrApi,
  });

  // Format
  return formatDiscord({
    ...analysis,
    rpcData, allData, goplus, pairs, tokenInfo, holders,
    contractInfo, deployerInfo, deployerAddr,
    deployerEthBal: deployerRpc.balance,
    deployerNonce:  deployerRpc.nonce,
    flaunchInfo, bankrApi,
  });
}

module.exports = { runBaseScanner };
