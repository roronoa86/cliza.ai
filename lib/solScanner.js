// lib/solScanner.js
// !sol <ca> — Universal Solana Token Scanner v3
// Support: pump.fun, Bonk.fun/LetsBonk, Raydium AMM/CPMM, Meteora DLMM/DAMM,
//          Orca CLMM, PumpSwap, dan semua token Solana lainnya
'use strict';

const axios = require('axios');

// ─── Constants ─────────────────────────────────────────────────────────────────
const SOL_RPC          = process.env.ALCHEMY_SOL_RPC || 'https://api.mainnet-beta.solana.com';
const PUMP_PROGRAM     = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP_AMM     = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const LETSBONK_PROGRAM = 'LanMV9sAd7wArD4vJFi88ypZuz6CtBQBCqNKn8K63FU';
const RAYDIUM_AMM_V4   = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const RAYDIUM_CPMM     = 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C';
const METEORA_DLMM     = 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo';
const METEORA_DAMM     = 'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB';
const ORCA_WHIRLPOOL   = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

// Known burn / dead addresses for LP tokens
// FIX: hapus 'burnXXXXX' (placeholder tidak valid) dan So1endDq2Y (Solend program aktif, bukan burn addr)
// Deteksi utama burn dilakukan via dead-owner check on-chain di checkLPBurn()
const BURN_ADDRS = new Set([
  '1nc1nerator11111111111111111111111111111111',      // Solana incinerator (resmi)
  '11111111111111111111111111111111',                  // System Program (unrecoverable)
]);

// Known LP lock program addresses (escrow/timelock programs) — VERIFIED ON-CHAIN
// FIX: Hapus 4 program NOT_FOUND + perbaiki ID Streamflow yang salah
// Verifikasi via getAccountInfo mainnet 2025-07-03
const LOCK_PROGRAMS = new Set([
  'E2aDXpk16ip23E3eEHAxXBtudF9V22pYj2e69saCpqJA', // Team Finance Solana ✓ (ACCOUNT, verified)
  'strmRqUCoQUgGUan5YhzUZa6KqdzwX5L6FpUxfmKg5m',   // Streamflow mainnet ✓ (PROGRAM, verified) — FIXED dari ID salah
  'stkitrT1Uoy18Dk1fTrgPw8W6MVzoCfYoAFT4MLsmhq',   // Strata lock ✓ (PROGRAM, verified)
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',  // PumpFun protocol lock ✓ (ACCOUNT, verified)
  // DIHAPUS (NOT_FOUND on-chain — tidak valid):
  // '2veqfzjXkTMTNNf6zBHr9poBF8WerUBARPbbfcFQjUzg' // "Raydium LP Lock v1" — NOT_FOUND
  // 'LockrWmn6K5twhz3y8RNepAzpFABBcCkMGJuaVA1YEM'  // "Common lock" — NOT_FOUND
  // 'FLockFM7D2LfAFUrSADPsKZ7sBKNkE6YT9JQZZ2Xptm' // "Fluxbeam lock" — NOT_FOUND
  // 'LocpQgucEm5e7F4ZoKMPZhMhMQ6NJK3fVZJN4bEXyYy'  // "Generic lock" — NOT_FOUND
]);

// Base58 alphabet
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function short(s, head = 4, tail = 4) {
  if (!s || s.length <= head + tail + 3) return s || 'N/A';
  return s.slice(0, head) + '…' + s.slice(-tail);
}
function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '?';
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000)     return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000)         return (n / 1_000).toFixed(2) + 'K';
  return n.toFixed(2);
}
function fmtSol(lamports) {
  if (!lamports && lamports !== 0) return '? SOL';
  return (Number(lamports) / 1e9).toFixed(4) + ' SOL';
}
function fmtPct(n) {
  if (n === null || n === undefined || isNaN(n)) return '?%';
  return n.toFixed(2) + '%';
}
function isBurn(addr) {
  return addr ? BURN_ADDRS.has(addr) : false;
}
function isLockProgram(addr) {
  return addr ? LOCK_PROGRAMS.has(addr) : false;
}

// ─── Base58 encoder ───────────────────────────────────────────────────────────
function bytesToBase58(bytes) {
  const buf = Buffer.from(bytes);
  if (!buf.some(b => b)) return '1'.repeat(buf.length);
  let n = BigInt('0x' + buf.toString('hex'));
  let result = '';
  const base = BigInt(58);
  while (n > 0n) { result = B58[Number(n % base)] + result; n /= base; }
  for (const b of buf) { if (b === 0) result = '1' + result; else break; }
  return result || '1';
}

// ─── Solana JSON-RPC helper ────────────────────────────────────────────────────
let _rpcId = 1;
async function rpcCall(method, params, timeout = 10000) {
  try {
    const { data } = await axios.post(SOL_RPC, {
      jsonrpc: '2.0', id: _rpcId++, method, params,
    }, { timeout, headers: { 'Content-Type': 'application/json' } });
    if (data?.error) return null;
    return data?.result ?? null;
  } catch { return null; }
}

async function getTokenLargestAccounts(mint) {
  try {
    const res = await rpcCall('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
    return res?.value || [];
  } catch { return []; }
}

async function resolveOwners(tokenAccounts) {
  if (!tokenAccounts.length) return [];
  try {
    const addrs = tokenAccounts.map(a => a.address);
    const res = await rpcCall('getMultipleAccounts', [addrs, { encoding: 'jsonParsed' }]);
    const values = res?.value || [];
    return tokenAccounts.map((ta, i) => ({
      ...ta,
      owner: values[i]?.data?.parsed?.info?.owner || null,
    }));
  } catch { return tokenAccounts.map(a => ({ ...a, owner: null })); }
}

// ─── On-chain account owner helper ────────────────────────────────────────────
async function getAccountOwner(addr) {
  if (!addr) return null;
  try {
    const res = await rpcCall('getAccountInfo', [addr, { encoding: 'base64' }], 8000);
    return res?.value?.owner ?? null;
  } catch { return null; }
}

// ─── On-chain creation-tx check helper ────────────────────────────────────────
// Uses limit=1000: if returned count < 1000 we have ALL sigs → oldest IS creation.
// For tokens with > 1000 txs (very active) we skip this method to avoid false negatives.
async function checkCreationTxProgram(mint, targetProgram) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [
      mint,
      { limit: 1000, commitment: 'confirmed' },
    ], 15000);
    if (!sigs || !sigs.length) return false;
    // Only proceed if we got all signatures (token is young enough)
    if (sigs.length >= 1000) return false;

    const creationSig = sigs[sigs.length - 1]?.signature;
    if (!creationSig) return false;

    const tx = await rpcCall('getTransaction', [
      creationSig,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ], 15000);
    if (!tx) return false;

    const accountKeys = (tx.transaction?.message?.accountKeys || [])
      .map(k => (typeof k === 'string' ? k : k?.pubkey))
      .filter(Boolean);

    return accountKeys.includes(targetProgram);
  } catch { return false; }
}

// ─── On-chain pump.fun verification ──────────────────────────────────────────
// FIX: pump.fun API returns 200 for ANY Solana token address (false positives!).
// Multi-signal approach — any ONE signal being true is sufficient:
//   Signal 1: bonding curve account owner = PUMP_PROGRAM (on-curve tokens)
//   Signal 2: pump_swap_pool account owner = PUMPSWAP_AMM (graduated via PumpSwap)
//   Signal 3: creation tx contains PUMP_PROGRAM (recent tokens with < 1000 txs)
async function verifyPumpFunOnChain(mint, pumpApiData) {
  const bondingCurve = pumpApiData?.bonding_curve;
  const pumpSwapPool = pumpApiData?.pump_swap_pool;

  // Signal 1: bonding curve owned by PUMP_PROGRAM → on-curve pump.fun token
  if (bondingCurve) {
    const bcOwner = await getAccountOwner(bondingCurve);
    if (bcOwner === PUMP_PROGRAM) return true;
  }

  // Signal 2: pump_swap_pool owned by PUMPSWAP_AMM → graduated pump.fun token
  if (pumpSwapPool) {
    const poolOwner = await getAccountOwner(pumpSwapPool);
    if (poolOwner === PUMPSWAP_AMM) return true;
  }

  // Signal 3: creation tx check (works for tokens with < 1000 total txs)
  const inCreationTx = await checkCreationTxProgram(mint, PUMP_PROGRAM);
  if (inCreationTx) return true;

  return false;
}

// ─── On-chain LetsBonk verification ──────────────────────────────────────────
async function verifyLetsBonkOnChain(mint, bonkApiData) {
  const bondingCurve = bonkApiData?.bonding_curve;

  // Signal 1: bonding curve owned by LETSBONK_PROGRAM
  if (bondingCurve) {
    const bcOwner = await getAccountOwner(bondingCurve);
    if (bcOwner === LETSBONK_PROGRAM) return true;
  }

  // Signal 2: creation tx check
  const inCreationTx = await checkCreationTxProgram(mint, LETSBONK_PROGRAM);
  if (inCreationTx) return true;

  return false;
}

// ─── PumpSwap pool layout decoder ─────────────────────────────────────────────
// Layout: discriminator(8) + bump(1) + index(2) + creator(32) + base_mint(32)
//         + quote_mint(32) + lp_mint(32) + pool_base_token_account(32) + pool_quote_token_account(32)
async function decodePumpSwapPool(poolAddr) {
  try {
    const res = await rpcCall('getAccountInfo', [poolAddr, { encoding: 'base64' }]);
    if (!res?.value?.data?.[0]) return null;
    const buf = Buffer.from(res.value.data[0], 'base64');
    if (buf.length < 211) return null;
    // poolIndex: u16 LE at offset 9 (discriminator 8 + bump 1)
    // Per PUMP_SWAP_README: CANONICAL_POOL_INDEX == 0 for pump.fun migrate instruction
    const poolIndex = buf.readUInt16LE(9);
    // lp_supply: u64 LE at offset 203 (right after poolQuoteTokenAccount ends at 203)
    const lpSupply  = Number(buf.readBigUInt64LE(203));
    return {
      poolIndex,    // 0 = canonical pump.fun migrated pool
      lpMint:               bytesToBase58(buf.slice(107, 139)),
      poolBaseTokenAccount: bytesToBase58(buf.slice(139, 171)),
      poolQuoteTokenAccount:bytesToBase58(buf.slice(171, 203)),
      lpSupply,     // raw u64 — cross-verify vs getTokenSupply(lpMint).value.amount
    };
  } catch { return null; }
}

// ─── Raydium Pool info (get LP mint dari pool address) ────────────────────────
async function fetchRaydiumPoolInfo(poolAddr) {
  try {
    const { data } = await axios.get(
      `https://api-v3.raydium.io/pools/info/ids?ids=${poolAddr}`,
      { timeout: 10000 }
    );
    const pool = data?.data?.data?.[0] || data?.data?.[0] || null;
    if (!pool) return null;
    return {
      type:     pool.type || 'Standard',
      lpMint:   pool.lpMint?.address || pool.lpMint || null,
      tvl:      pool.tvl || null,
      openTime: pool.openTime || null,
    };
  } catch { return null; }
}

// ─── Meteora on-chain pool type detection ────────────────────────────────────
// Cek program owner account on-chain untuk tahu tipe pool (DLMM / DAMM / DAMM_V2)
const METEORA_DAMM_V2 = 'cpamdpfCFGEbVhCczVPvVNdWCUHFNnFmzXUWQMdLqV7';
async function detectMeteoraDammPoolType(poolAddr) {
  const owner = await getAccountOwner(poolAddr);
  if (!owner) return null;
  if (owner === METEORA_DLMM)    return 'DLMM';
  if (owner === METEORA_DAMM)    return 'DAMM';
  if (owner === METEORA_DAMM_V2) return 'DAMM_V2';
  return null;
}

// ─── Meteora pool info ─────────────────────────────────────────────────────────
// FIX: Tambah dukungan DAMM v2 API (permanent_lock_liquidity, vested_liquidity)
// Sebelumnya: DLMM API kadang gagal & DAMM tidak extract lock fields dengan benar.
// Sekarang: deteksi tipe pool on-chain, fetch lock data sesuai tipe,
//           dan analisis secondary Meteora pools (bukan hanya primary pool).
async function fetchMeteoraPoolInfo(poolAddr) {
  // Jalankan DLMM API + on-chain detection secara paralel untuk efisiensi
  const [poolTypeOnChain, dlmmResult] = await Promise.all([
    detectMeteoraDammPoolType(poolAddr),
    axios.get(`https://dlmm-api.meteora.ag/pair/${poolAddr}`, { timeout: 8000 })
      .then(r => r.data).catch(() => null),
  ]);

  // DLMM pool — posisi berbasis NFT, tidak ada LP mint tunggal
  if (dlmmResult && dlmmResult.address) {
    return {
      type: 'DLMM',
      lpMint: null,
      locked: false, // posisi bisa ditarik kecuali individual position-nya di-lock
      totalLiquidity: dlmmResult.liquidity || null,
      activeBinId: dlmmResult.active_bin_id || null,
    };
  }
  if (poolTypeOnChain === 'DLMM') {
    // DLMM terdeteksi on-chain tapi API tidak ada data — tetap return DLMM type
    return { type: 'DLMM', lpMint: null, locked: false };
  }

  // DAMM v2 — gunakan amm-v2.meteora.ag API resmi
  // Endpoint: GET /pools/{pool_address}?page=0&size=1
  // Fields kunci: permanent_lock_liquidity, vested_liquidity.months_3/months_6, tvl
  try {
    const { data: damm2 } = await axios.get(
      `https://amm-v2.meteora.ag/pools/${poolAddr}?page=0&size=1`,
      { timeout: 8000 }
    );
    if (damm2 && !damm2.message) return parseDammPool(damm2);
  } catch {}

  // Legacy DAMM v1 endpoints sebagai fallback
  const dammEndpoints = [
    `https://amm-v2.meteora.ag/pools?address=${poolAddr}`,
    `https://app.meteora.ag/api/pool/${poolAddr}`,
  ];
  for (const url of dammEndpoints) {
    try {
      const { data: damm } = await axios.get(url, { timeout: 8000 });
      const pool = Array.isArray(damm) ? damm[0]
                 : (damm?.pool_address || damm?.address ? damm : null);
      if (pool) return parseDammPool(pool);
    } catch {}
  }

  // Terdeteksi DAMM on-chain tapi semua API gagal
  if (poolTypeOnChain === 'DAMM' || poolTypeOnChain === 'DAMM_V2') {
    return { type: 'DAMM', lpMint: null, locked: false, lockedPct: 0, securedPct: 0, tvl: 0 };
  }
  return null;
}

// Helper: parse DAMM pool response (v1 atau v2) ke format seragam.
// Mendukung DAMM v2 API fields: permanent_lock_liquidity, vested_liquidity, tvl
// Semua field numerik di-sanitize: NaN / Infinity / negative → 0 (hardened parsing)
function parseDammPool(pool) {
  function safeNum(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  const vl           = pool.vested_liquidity || {};
  const permanentLock = safeNum(pool.permanent_lock_liquidity);
  const vested3m      = safeNum(vl.months_3);
  const vested6m      = safeNum(vl.months_6);
  const tvl           = safeNum(pool.tvl);
  const totalLocked   = permanentLock + vested3m + vested6m;
  const lockedPct     = tvl > 0 ? Math.min(100, (totalLocked / tvl) * 100) : 0;
  return {
    type:          'DAMM',
    lpMint:        pool.lp_mint || pool.lp_token || null,
    locked:        totalLocked > 0,
    permanentLock, vested3m, vested6m, tvl,
    totalLocked,   lockedPct,
    securedPct:    lockedPct,
  };
}

// ─── LP lock check — cek burn % DAN lock program ─────────────────────────────
// FIX v2: Tambah dead-owner detection via on-chain lookup.
// Sebelumnya hanya cek BURN_ADDRS (2 alamat hardcoded) → miss mayoritas LP burn nyata.
// Contoh real: WIF/SOL LP 39.8% burned ke dead wallets, RAY/SOL 76% — semua miss sebelumnya!
//
// Alur deteksi:
//  1. Burn alamat terkenal (BURN_ADDRS)
//  2. Dead owner: owner wallet tidak ada di chain → LP tidak bisa dipindah → efektif burned
//  3. Lock program (LOCK_PROGRAMS): escrow/timelock resmi
async function checkLPBurn(lpMint) {
  if (!lpMint) return null;
  try {
    // Fetch top holders + total mint supply secara paralel
    const [rawHolders, supplyRes] = await Promise.all([
      getTokenLargestAccounts(lpMint),
      rpcCall('getTokenSupply', [lpMint]),
    ]);
    if (!rawHolders.length) return null;
    const holders = await resolveOwners(rawHolders);
    const active  = holders.filter(h => h.uiAmount > 0);
    // PENTING: gunakan total mint supply sebagai denominator (bukan hanya top-20 sum!)
    // top-20 sum bisa understated jika ada LP di luar top 20 → burn% jadi overstated
    const top20sum = active.reduce((s, h) => s + (h.uiAmount || 0), 0);
    const mintSupply = supplyRes?.value?.uiAmount || 0;
    // Pilih denominator yang lebih besar (paling konservatif / tidak overstated)
    const total = mintSupply > top20sum ? mintSupply : top20sum;

    // Kumpulkan owner yang belum diketahui (bukan known burn/lock) untuk dicek on-chain
    const unknownOwners = [
      ...new Set(
        active
          .map(h => h.owner)
          .filter(o => o && !isBurn(o) && !isLockProgram(o))
      ),
    ];

    // Cek keberadaan owner accounts on-chain secara batch
    // Jika NOT_FOUND → dead wallet → LP token tidak bisa dipindah → efektif burned
    // HARDENING: hanya tandai dead jika RPC sukses + response length sesuai
    // (hindari false positive akibat timeout/error jaringan)
    const deadOwners = new Set();
    if (unknownOwners.length > 0) {
      const res = await rpcCall(
        'getMultipleAccounts',
        [unknownOwners, { encoding: 'base64' }],
        12000
      );
      // Validasi: hanya proses jika RPC berhasil dan jumlah nilai sesuai
      const vals = res?.value;
      if (Array.isArray(vals) && vals.length === unknownOwners.length) {
        unknownOwners.forEach((o, i) => {
          if (vals[i] === null) deadOwners.add(o); // explicit null = account tidak ada = dead
        });
      }
      // Jika RPC gagal/partial → deadOwners tetap kosong → burn% tidak melonjak palsu
    }

    // Count burned (known BURN_ADDRS + dead owners) dan locked (LOCK_PROGRAMS)
    const burned = active
      .filter(h => isBurn(h.owner) || deadOwners.has(h.owner))
      .reduce((s, h) => s + (h.uiAmount || 0), 0);
    const locked = active
      .filter(h => isLockProgram(h.owner))
      .reduce((s, h) => s + (h.uiAmount || 0), 0);
    const secured    = burned + locked;
    const burnPct    = total > 0 ? (burned  / total) * 100 : 0;
    const lockPct    = total > 0 ? (locked  / total) * 100 : 0;
    const securedPct = total > 0 ? (secured / total) * 100 : 0;

    return {
      lpMint, holders: active, total, burned, locked, secured,
      burnPct, lockPct, securedPct,
      deadOwners: [...deadOwners], // untuk badge display di formatDiscord
    };
  } catch { return null; }
}

// ─── pump.fun API (v3) ────────────────────────────────────────────────────────
// CATATAN: API ini return 200 + data untuk token APAPUN, termasuk WIF/BONK/RAY.
// Jangan gunakan sebagai satu-satunya indikator platform — wajib verifikasi on-chain.
async function fetchPumpFun(mint) {
  try {
    const { data } = await axios.get(
      `https://frontend-api-v3.pump.fun/coins/${mint}`,
      { timeout: 10000, headers: { 'Accept': 'application/json' } }
    );
    if (!data || !data.mint) return null;
    return data;
  } catch { return null; }
}

// ─── Bonk.fun / LetsBonk API ─────────────────────────────────────────────────
async function fetchBonkFun(mint) {
  const endpoints = [
    `https://api.bonk.fun/coins/${mint}`,
    `https://api.letsbonk.fun/coins/${mint}`,
    `https://frontend-api.letsbonk.fun/coins/${mint}`,
  ];
  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, {
        timeout: 8000, headers: { 'Accept': 'application/json' }
      });
      if (data && (data.mint || data.address)) return { ...data, _source: 'bonkfun' };
    } catch {}
  }
  return null;
}

// ─── DexScreener ──────────────────────────────────────────────────────────────
async function fetchDexScreener(mint) {
  try {
    const { data } = await axios.get(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { timeout: 10000 }
    );
    const pairs = (data?.pairs || []).filter(p =>
      p.chainId === 'solana' && p.liquidity?.usd > 0
    );
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    return pairs;
  } catch { return null; }
}


// ─── Orca Whirlpool API ───────────────────────────────────────────────────────
// Gunakan Orca v2 API untuk cek lockedLiquidityPercent secara akurat
// Ref: https://docs.orca.so/api-reference/whirlpools
async function fetchOrcaPoolInfo(poolAddr) {
  if (!poolAddr) return null;
  try {
    const { data: resp } = await axios.get(
      `https://api.orca.so/v2/solana/pools/${poolAddr}`,
      { timeout: 10000 }
    );
    const pool = resp?.data || resp;
    if (!pool) return null;

    // lockedLiquidityPercent adalah array entry lock dari Orca
    // Nilai lockedPercentage adalah persen (0-100), biasanya sangat kecil
    const lockEntries = Array.isArray(pool.lockedLiquidityPercent)
      ? pool.lockedLiquidityPercent : [];

    // PENTING: Orca lockedPercentage adalah FRACTION (0-1), bukan persen (0-100)
    // Contoh: 0.999999 = 99.9999%, 0.000001 = 0.0001%
    const lockedPct = lockEntries.reduce((sum, e) => {
      return sum + parseFloat(e.lockedPercentage || e.locked_percentage || 0) * 100;
    }, 0);

    return {
      type: 'orca_clmm',
      lockedPct,           // persen (0-100) yang terkunci via Orca lock
      lockEntries,         // raw entries untuk display detail
      tvlUsdc: parseFloat(pool.tvlUsdc || 0),
      poolAddr,
    };
  } catch { return null; }
}

// ─── Jupiter Token Info ───────────────────────────────────────────────────────
async function fetchJupiterTokenInfo(mint) {
  // Coba beberapa endpoint Jupiter karena API sering berubah
  const endpoints = [
    `https://tokens.jup.ag/token/${mint}`,
    `https://api.jup.ag/tokens/v1/token/${mint}`,
  ];
  for (const url of endpoints) {
    try {
      const { data } = await axios.get(url, { timeout: 8000 });
      if (data && data.symbol) return data;
    } catch {}
  }
  return null;
}


// ─── GMGN Token Info ─────────────────────────────────────────────────────────
// Sumber data pasar yang lebih akurat: harga real-time, volume, likuiditas, tx count
async function fetchGmgnTokenInfo(mint) {
  const key = process.env.GMGN_API_KEY;
  if (!key) return null;
  try {
    const ts  = Math.floor(Date.now() / 1000);
    const cid = Math.random().toString(36).slice(2) + ts;
    const { data } = await axios.get('https://openapi.gmgn.ai/v1/token/info', {
      params : { chain: 'sol', address: mint, timestamp: ts, client_id: cid },
      headers: { 'X-APIKEY': key, 'Accept': 'application/json', 'User-Agent': 'gmgn-cli/1.5.0' },
      timeout   : 12000,
      decompress: true,
    });
    // GMGN response: { code: 0, msg: 'ok', data: { price, pool, liquidity, market_cap, ... } }
    if (data?.code === 0 && data?.data) return data.data;
    return null;
  } catch { return null; }
}

// ─── GoPlus Security (Solana) ──────────────────────────────────────────────────
async function fetchGoPlusSol(mint) {
  try {
    const { data } = await axios.get(
      `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${mint}`,
      { timeout: 12000 }
    );
    if (data?.code !== 1) return null;
    return data.result?.[mint] || data.result?.[mint.toLowerCase()] || null;
  } catch { return null; }
}

// ─── Launchpad detection ──────────────────────────────────────────────────────
// FIX: pumpData dan bonkData sekarang hanya dipakai jika sudah diverifikasi on-chain.
// Parameter isPumpFunVerified dan isBonkVerified wajib diisi dari verifyPumpFunOnChain().
function detectLaunchpad(pumpData, bonkData, dexPairs, isPumpFunVerified, isBonkVerified) {
  // pump.fun — hanya jika on-chain verification LULUS
  if (pumpData && isPumpFunVerified) {
    const graduated = pumpData.complete === true;
    const poolAddr  = pumpData.pump_swap_pool || pumpData.pool_address || null;
    return {
      name: 'pump.fun',
      type: graduated ? 'pumpswap' : 'bonding_curve',
      graduated,
      poolAddr,
      dexType: graduated ? 'pumpswap' : 'bonding_curve',
      lpLockType: graduated ? 'protocol_locked' : 'bonding_curve_locked',
    };
  }

  // Bonk.fun / LetsBonk — hanya jika on-chain verification LULUS
  if (bonkData && isBonkVerified) {
    const graduated = bonkData.complete === true || !!bonkData.raydium_pool;
    return {
      name: 'Bonk.fun / LetsBonk',
      type: graduated ? 'raydium' : 'bonding_curve',
      graduated,
      poolAddr: bonkData.raydium_pool || null,
      dexType: graduated ? 'raydium' : 'bonding_curve',
      lpLockType: graduated ? 'check_burn' : 'bonding_curve_locked',
    };
  }

  // Fallback: deteksi dari DexScreener pair (untuk semua token non-launchpad)
  if (dexPairs && dexPairs.length > 0) {
    const top   = dexPairs[0];
    const dexId = (top.dexId || '').toLowerCase();
    if (dexId.includes('pumpswap') || dexId === 'pump') {
      // SAFETY: hanya percaya protocol_locked jika pump.fun sudah diverifikasi on-chain
      // DexScreener bisa salah label pool sebagai pumpswap → fallback ke check_burn
      const lpLock = isPumpFunVerified ? 'protocol_locked' : 'check_burn';
      return { name: 'PumpSwap AMM', type: 'pumpswap', graduated: true, poolAddr: top.pairAddress, dexType: 'pumpswap', lpLockType: lpLock };
    }
    if (dexId.includes('raydium')) {
      return { name: 'Raydium', type: 'raydium', graduated: true, poolAddr: top.pairAddress, dexType: 'raydium', lpLockType: 'check_burn' };
    }
    if (dexId.includes('meteora')) {
      return { name: 'Meteora', type: 'meteora', graduated: true, poolAddr: top.pairAddress, dexType: 'meteora', lpLockType: 'meteora' };
    }
    if (dexId.includes('orca')) {
      return { name: 'Orca', type: 'orca', graduated: true, poolAddr: top.pairAddress, dexType: 'orca', lpLockType: 'orca_clmm' };
    }
    if (dexId.includes('bonk')) {
      return { name: 'Bonk.fun / LetsBonk', type: 'raydium', graduated: true, poolAddr: top.pairAddress, dexType: 'raydium', lpLockType: 'check_burn' };
    }
    return { name: dexId || 'DEX', type: 'unknown_dex', graduated: true, poolAddr: top.pairAddress, dexType: dexId, lpLockType: 'check_burn' };
  }

  return { name: 'Unknown', type: 'unknown', graduated: false, poolAddr: null, dexType: null, lpLockType: null };
}

// ─── Bonding curve progress (pump.fun & Bonk.fun) ────────────────────────────
const GRADUATION_SOL_LAMPORTS = 85_000_000_000; // 85 SOL
function calcBondingCurveProgress(platformData) {
  if (!platformData) return null;
  const complete = platformData.complete === true;
  if (complete) return { pct: 100, complete: true };
  const realSol  = Number(platformData.real_sol_reserves || 0);
  const target   = Number(platformData.graduation_threshold || GRADUATION_SOL_LAMPORTS);
  const pct = Math.min(100, (realSol / target) * 100);
  return { pct, realSol, complete: false };
}

// ─── Main scorer ───────────────────────────────────────────────────────────────
function computeScore({ pumpData, bonkData, isPumpFunVerified, isBonkVerified, goplus, dexPairs, holders, lpData, launchpad }) {
  const R = [], Y = [], G = [], I = [];
  let score = 0;
  const add = (list, msg, pts = 0) => { list.push(msg); score += pts; };
  const pair = dexPairs?.[0] || null;

  // 1. Platform
  if (pumpData && isPumpFunVerified)       add(G, 'Token dibuat via pump.fun launchpad ✓');
  else if (bonkData && isBonkVerified)     add(G, 'Token dibuat via Bonk.fun / LetsBonk launchpad ✓');
  else if (launchpad.type !== 'unknown')   add(I, 'Token pada ' + launchpad.name + ' — bukan launchpad pump.fun/bonk.fun');
  else                                      add(I, 'Platform token tidak teridentifikasi');

  // 2. Mint & Freeze authority
  if (goplus) {
    const mintAuth   = goplus.mint_authority;
    const freezeAuth = goplus.freeze_authority;
    if (!mintAuth   || mintAuth === '')   add(G, 'Mint Authority: REVOKED ✓');
    else                                  add(R, 'Mint Authority: MASIH ADA (' + short(mintAuth) + ') — bisa inflate supply!', 3);
    if (!freezeAuth || freezeAuth === '') add(G, 'Freeze Authority: REVOKED ✓');
    else                                  add(Y, 'Freeze Authority: MASIH ADA (' + short(freezeAuth) + ')', 1);
  } else {
    add(Y, 'GoPlus Security: tidak tersedia untuk token ini', 1);
  }

  // 3. Bonding curve / graduation status
  const platformData = (pumpData && isPumpFunVerified) ? pumpData
                     : (bonkData && isBonkVerified)    ? bonkData
                     : null;
  if (platformData) {
    const prog = calcBondingCurveProgress(platformData);
    if (prog.complete) {
      const target = (pumpData && isPumpFunVerified) ? 'PumpSwap AMM' : 'Raydium AMM';
      add(G, 'Status: GRADUATED → sudah di ' + target + ' ✓');
    } else {
      if (prog.pct >= 90)      add(Y, 'Bonding curve ' + prog.pct.toFixed(1) + '% — hampir lulus!');
      else if (prog.pct >= 50) add(G, 'Bonding curve ' + prog.pct.toFixed(1) + '% — progress solid');
      else if (prog.pct >= 20) add(I, 'Bonding curve ' + prog.pct.toFixed(1) + '% — masih awal');
      else                     add(Y, 'Bonding curve ' + prog.pct.toFixed(1) + '% — sangat awal/baru', 1);
    }
  }

  // 4. LP lock analysis
  const llt = launchpad.lpLockType;
  if (llt === 'bonding_curve_locked') {
    add(G, 'LP LOCK: 🔒 Dalam bonding curve — tidak bisa di-rug sebelum graduation ✓');
  } else if (llt === 'protocol_locked') {
    if (lpData?.mintClosed) {
      const _mcDesc = lpData.mintClosed === 'closed' ? 'LP mint ditutup permanen' : 'LP supply = 0 (semua burned)';
      add(G, 'LP LOCK: 🔒 100% LP BURNED — ' + _mcDesc + ' oleh protokol ' + launchpad.name + ' ✓');
    } else if (lpData && lpData.burnPct !== undefined) {
      const sp = lpData.securedPct;
      const bp = lpData.burnPct;
      const lp = lpData.lockPct || 0;
      if (sp >= 99)      add(G, 'LP LOCK: 🔒 ' + sp.toFixed(1) + '% LP burned+locked — aman ✓ (protokol ' + launchpad.name + ')');
      else if (sp >= 80) add(G, 'LP LOCK: 🔒 ' + sp.toFixed(1) + '% LP secured (burned ' + bp.toFixed(1) + '% + locked ' + lp.toFixed(1) + '%)');
      else if (sp >= 50) add(Y, 'LP LOCK: ⚠️ ' + sp.toFixed(1) + '% LP secured — ' + (100-sp).toFixed(1) + '% bisa ditarik oleh penyedia LP', 1);
      else if (sp >  0)  add(R, 'LP LOCK: 🚨 Hanya ' + sp.toFixed(1) + '% LP secured — penyedia LP bisa rug pull!', 2);
      else               add(R, 'LP LOCK: 🚨 0% LP burned/locked — penyedia LP bisa tarik semua likuiditas kapan saja!', 3);
    } else {
      add(G, 'LP LOCK: 🔒 Protokol ' + launchpad.name + ' — LP di-burn/dikunci setelah migrasi ✓');
    }
    const _dead_mm = new Set(lpData?.deadOwners || []);
    const mmHolders = (lpData?.holders || []).filter(h => !BURN_ADDRS.has(h.owner) && !_dead_mm.has(h.owner) && !LOCK_PROGRAMS.has(h.owner));
    if (mmHolders.length > 0) add(I, 'Market maker LP: ' + mmHolders.length + ' penyedia tambahan (bukan core liquidity)');
  } else if (llt === 'check_burn') {
    if (lpData) {
      const sp = lpData.securedPct; // burned + locked
      const bp = lpData.burnPct;
      const lp = lpData.lockPct;
      if (sp >= 99)       add(G, 'LP LOCK: 🔒 ' + sp.toFixed(1) + '% LP aman (burned+locked) ✓');
      else if (sp >= 80)  add(G, 'LP LOCK: 🔒 ' + sp.toFixed(1) + '% LP secured (burned ' + bp.toFixed(1) + '% + locked ' + lp.toFixed(1) + '%)');
      else if (sp >= 50)  add(Y, 'LP LOCK: ⚠️ ' + sp.toFixed(1) + '% LP secured — sisanya bisa ditarik', 1);
      else if (sp >= 5)   add(Y, 'LP LOCK: ⚠️ Hanya ' + sp.toFixed(1) + '% LP secured — TIDAK aman', 2);
      else if (sp > 0)    add(R, 'LP LOCK: 🚨 Hanya ' + sp.toFixed(2) + '% LP secured — pada dasarnya tidak ada yang terkunci!', 3);
      else                add(R, 'LP LOCK: 🚨 0% LP burned/locked — creator bisa rug pull kapan saja!', 3);
    } else {
      add(Y, 'LP LOCK: Tidak bisa diverifikasi otomatis — cek manual di DEX', 1);
    }
  } else if (llt === 'meteora') {
    if (lpData?.type === 'DLMM') {
      add(I, 'LP LOCK: ℹ️ Meteora DLMM — posisi NFT. Tiap LP bisa tarik kapan saja kecuali position-nya di-lock individual. Cek di app.meteora.ag');
    } else if (lpData?.type === 'DAMM') {
      const lp = lpData.lockedPct != null ? lpData.lockedPct : (lpData.securedPct != null ? lpData.securedPct : 0);
      if (lp >= 99)      add(G, 'LP LOCK: 🔒 ' + lp.toFixed(1) + '% Meteora DAMM liquidity terkunci ✓');
      else if (lp >= 50) add(Y, 'LP LOCK: ⚠️ ' + lp.toFixed(1) + '% Meteora DAMM terkunci — sisanya bisa ditarik', 1);
      else if (lp > 0)   add(Y, 'LP LOCK: ⚠️ Hanya ' + lp.toFixed(1) + '% terkunci di Meteora DAMM', 2);
      else               add(R, 'LP LOCK: 🚨 0% liquidity terkunci di Meteora DAMM — bisa di-rug kapan saja!', 3);
    } else {
      add(I, 'LP LOCK: Meteora pool — cek posisi di app.meteora.ag');
    }
  } else if (llt === 'orca_clmm') {
    if (lpData && lpData.type === 'orca_clmm') {
      const lp = lpData.lockedPct || 0;
      if (lp >= 99)      add(G, 'LP LOCK: 🔒 ' + lp.toFixed(2) + '% liquidity terkunci via Orca lock ✓');
      else if (lp >= 50) add(Y, 'LP LOCK: ⚠️ ' + lp.toFixed(2) + '% liquidity terkunci — sisanya bisa ditarik', 1);
      else if (lp >= 1)  add(Y, 'LP LOCK: ⚠️ Hanya ' + lp.toFixed(2) + '% terkunci — sebagian besar LP bisa ditarik', 2);
      else if (lp > 0)   add(Y, 'LP LOCK: ⚠️ Hanya ' + lp.toFixed(6) + '% terkunci — praktis tidak ada yang dikunci', 2);
      else               add(Y, 'LP LOCK: ⚠️ 0% terkunci — semua posisi bisa ditarik kapan saja', 1);
    } else {
      add(Y, 'LP LOCK: ⚠️ Orca CLMM — tidak bisa verifikasi lock (API timeout)', 1);
    }
  } else {
    if (launchpad.type !== 'unknown') add(I, 'LP LOCK: Tidak diverifikasi — cek manual di DEX explorer');
  }

  // 4b. Secondary pools signifikan
  if (dexPairs && dexPairs.length > 1) {
    const _sTopLiq = dexPairs[0]?.liquidity?.usd || 0;
    const _sBig = dexPairs.slice(1).filter(p => (p.liquidity?.usd || 0) >= Math.max(10000, _sTopLiq * 0.05));
    if (_sBig.length > 0) {
      const _sNames = _sBig.slice(0, 3).map(p => (p.dexId || 'DEX') + ' $' + fmtNum(p.liquidity?.usd || 0)).join(', ');
      add(I, 'Ada ' + _sBig.length + ' pool lain signifikan: ' + _sNames + ' — cek LP lock-nya juga');
    }
  }

  // 5. Market data
  if (pair) {
    const liq  = pair.liquidity?.usd || 0;
    const pc24 = pair.priceChange?.h24;
    if (liq < 1000)       add(R, 'Likuiditas sangat rendah: $' + liq.toFixed(0), 3);
    else if (liq < 5000)  add(Y, 'Likuiditas rendah: $' + fmtNum(liq), 1);
    else if (liq < 50000) add(Y, 'Likuiditas sedang: $' + fmtNum(liq));
    else                  add(G, 'Likuiditas cukup: $' + fmtNum(liq) + ' ✓');

    if (pc24 !== null && pc24 !== undefined) {
      if (pc24 > 300)      add(R, 'Pump ekstrem 24h: +' + pc24.toFixed(0) + '% — hati-hati dump', 2);
      else if (pc24 > 100) add(Y, 'Kenaikan tajam 24h: +' + pc24.toFixed(0) + '%', 1);
      else if (pc24 < -70) add(R, 'Crash 24h: ' + pc24.toFixed(0) + '%', 2);
      else if (pc24 < -40) add(Y, 'Penurunan tajam 24h: ' + pc24.toFixed(0) + '%', 1);
    }
    const age = pair.pairCreatedAt ? Math.floor((Date.now() - pair.pairCreatedAt) / 86400000) : null;
    if (age !== null && age < 1)      add(R, 'Token BARU HARI INI — sangat berisiko', 1);
    else if (age !== null && age < 3) add(Y, 'Token baru: ' + age + ' hari', 1);
  }

  // 6. Holder concentration
  if (goplus?.holder_count) {
    const hc = parseInt(goplus.holder_count);
    if (hc < 50)       add(R, 'Holder sangat sedikit: ' + hc + ' — terpusat', 2);
    else if (hc < 200) add(Y, 'Holder masih sedikit: ' + hc, 1);
    else               add(G, 'Holder: ' + fmtNum(hc) + ' ✓');
  }
  if (goplus?.top10_holder_rate) {
    const t10 = parseFloat(goplus.top10_holder_rate) * 100;
    if (t10 > 80)      add(R, 'Top 10 holder: ' + t10.toFixed(1) + '% — sangat terpusat!', 2);
    else if (t10 > 50) add(Y, 'Top 10 holder: ' + t10.toFixed(1) + '% — cukup terpusat', 1);
    else               add(G, 'Top 10 holder: ' + t10.toFixed(1) + '% ✓');
  }

  // 7. Creator
  if (goplus?.creator_percentage) {
    const devPct = parseFloat(goplus.creator_percentage) * 100;
    if (devPct > 20)      add(R, 'Creator pegang ' + devPct.toFixed(1) + '% supply — dump risk!', 2);
    else if (devPct > 10) add(Y, 'Creator pegang ' + devPct.toFixed(1) + '%', 1);
    else if (devPct > 0)  add(G, 'Creator holding kecil: ' + devPct.toFixed(2) + '% ✓');
    else                  add(G, 'Creator tidak pegang supply ✓');
  }

  return { R, Y, G, I, score };
}

// Helper: validasi URL sosial (filter localhost, placeholder, dll)
function isValidSocialUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const lower = url.toLowerCase();
  if (lower.includes('localhost') || lower.includes('127.0.0.1') || lower.includes('0.0.0.0')) return false;
  if (lower === 'https://' || lower === 'http://' || lower.length < 8) return false;
  try { new URL(url); return true; } catch { return false; }
}

// ─── Discord formatter ────────────────────────────────────────────────────────
function formatDiscord({ mint, pumpData, bonkData, isPumpFunVerified, isBonkVerified, jupInfo, goplus, dexPairs, holders, lpData, launchpad, R, Y, G, I, score, secondaryMeteoraPools = [], gmgnInfo = null }) {
  const lines = [];
  const pair  = dexPairs?.[0] || null;
  let sn = 1;

  const platformData  = (pumpData && isPumpFunVerified) ? pumpData
                      : (bonkData && isBonkVerified)    ? bonkData
                      : null;
  const tokenName     = platformData?.name   || jupInfo?.name   || goplus?.token_name   || pair?.baseToken?.name   || 'Unknown';
  const tokenSymbol   = platformData?.symbol || jupInfo?.symbol || goplus?.token_symbol || pair?.baseToken?.symbol || '???';
  const isGraduated   = launchpad.graduated;

  const riskLabel = score <= 0 ? '🟢 LOW RISK'
                  : score <= 3 ? '🟡 MEDIUM RISK'
                  : score <= 7 ? '🟠 HIGH RISK'
                  : '🔴 VERY HIGH RISK';

  // DEX label per type
  const DEX_LABELS = {
    pumpswap: '🟣 PumpSwap',
    raydium:  '🔵 Raydium',
    meteora:  '🟤 Meteora',
    orca:     '🩵 Orca',
    bonding_curve: '⏳ Bonding Curve',
    unknown:  '❓ Unknown',
  };
  const dexLabel = DEX_LABELS[launchpad.type] || launchpad.name || '❓';

  // ── Header ──
  lines.push('**🌕 SOL TOKEN SCANNER — ' + tokenName.toUpperCase() + ' (' + tokenSymbol + ')**');
  lines.push('`' + mint + '`');
  lines.push('**Risk Score: ' + score + ' — ' + riskLabel + '**');
  lines.push('');

  // ── 1. Token Info ──
  lines.push('**' + (sn++) + '️⃣ TOKEN INFO**');
  lines.push('• Name: ' + tokenName + ' (' + tokenSymbol + ')');
  lines.push('• Chain: Solana');
  lines.push('• Platform: ' + launchpad.name + (isGraduated ? ' ✅ GRADUATED' : launchpad.type === 'bonding_curve' ? ' ⏳ Bonding Curve' : ''));
  lines.push('• DEX: ' + dexLabel);

  if (pumpData && isPumpFunVerified) {
    if (pumpData.description) lines.push('• Desc: ' + pumpData.description.slice(0, 120));
    const socials = [];
    if (isValidSocialUrl(pumpData.twitter))  socials.push('[Twitter](<' + pumpData.twitter + '>)');
    if (isValidSocialUrl(pumpData.telegram)) socials.push('[Telegram](<' + pumpData.telegram + '>)');
    if (isValidSocialUrl(pumpData.website))  socials.push('[Website](<' + pumpData.website + '>)');
    if (socials.length)    lines.push('• Sosial: ' + socials.join(' | '));
    if (pumpData.created_timestamp) lines.push('• Dibuat: ' + new Date(pumpData.created_timestamp).toISOString().slice(0, 10));
    if (pumpData.usd_market_cap)    lines.push('• MC (pump.fun): $' + fmtNum(pumpData.usd_market_cap));
    if (pumpData.nsfw)              lines.push('• ⚠️ NSFW: Ya');
  } else if (bonkData && isBonkVerified) {
    if (bonkData.description) lines.push('• Desc: ' + (bonkData.description || '').slice(0, 120));
    const socials = [];
    if (isValidSocialUrl(bonkData.twitter))  socials.push('[Twitter](<' + bonkData.twitter + '>)');
    if (isValidSocialUrl(bonkData.telegram)) socials.push('[Telegram](<' + bonkData.telegram + '>)');
    if (isValidSocialUrl(bonkData.website))  socials.push('[Website](<' + bonkData.website + '>)');
    if (socials.length)    lines.push('• Sosial: ' + socials.join(' | '));
    if (bonkData.created_timestamp) lines.push('• Dibuat: ' + new Date(bonkData.created_timestamp).toISOString().slice(0, 10));
  } else if (jupInfo) {
    if (jupInfo.tags?.length)  lines.push('• Tags: ' + jupInfo.tags.slice(0, 3).join(', '));
    if (jupInfo.extensions?.website) lines.push('• Website: ' + jupInfo.extensions.website);
    if (jupInfo.extensions?.twitter) lines.push('• Twitter: ' + jupInfo.extensions.twitter);
  }
  if (goplus?.holder_count) lines.push('• Total Holders: ' + fmtNum(parseInt(goplus.holder_count)));
  lines.push('');

  // ── 2. Bonding Curve / Graduation Status ──
  lines.push('**' + (sn++) + '️⃣ STATUS BONDING CURVE**');
  if (platformData) {
    const prog = calcBondingCurveProgress(platformData);
    const targetDex = (pumpData && isPumpFunVerified) ? 'PumpSwap' : 'Raydium';
    lines.push('• Platform: ' + launchpad.name);
    lines.push('• Status: ' + (isGraduated ? '✅ GRADUATED → ' + targetDex : '⏳ Masih di bonding curve'));
    lines.push('• Progress: **' + prog.pct.toFixed(2) + '%** menuju graduation');
    const barLen = 20, filled = Math.round((prog.pct / 100) * barLen);
    lines.push('• `[' + '█'.repeat(filled) + '░'.repeat(barLen - filled) + '] ' + prog.pct.toFixed(1) + '%`');
    if (!isGraduated) {
      if (platformData.real_sol_reserves) lines.push('• SOL terkumpul: **' + fmtSol(platformData.real_sol_reserves) + '** / 85 SOL');
      if (platformData.real_token_reserves) {
        const rem = Number(platformData.real_token_reserves) / 1e6;
        lines.push('• Token tersisa di curve: ' + fmtNum(rem));
      }
    }
    if (pumpData?.bonding_curve && isPumpFunVerified) lines.push('• Bonding curve: [Solscan](<https://solscan.io/account/' + pumpData.bonding_curve + '>)');
    if (bonkData?.bonding_curve && isBonkVerified)   lines.push('• Bonding curve: [Solscan](<https://solscan.io/account/' + bonkData.bonding_curve + '>)');
    const poolAddr = (pumpData?.pump_swap_pool || pumpData?.pool_address || bonkData?.raydium_pool);
    if (isGraduated && poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + poolAddr + '>)');
  } else {
    lines.push('• Token ini dari ' + (launchpad.name || 'DEX langsung') + ' — tidak memiliki bonding curve');
    if (pair?.pairCreatedAt) lines.push('• Pool dibuat: ' + new Date(pair.pairCreatedAt).toISOString().slice(0, 10));
  }
  lines.push('');

  // ── 3. LP Lock ──
  lines.push('**' + (sn++) + '️⃣ LP LOCK STATUS**');
  const llt = launchpad.lpLockType;
  if (llt === 'bonding_curve_locked') {
    lines.push('• Status: 🔒 **LP TERKUNCI dalam bonding curve ' + launchpad.name + '**');
    lines.push('• Creator tidak bisa tarik likuiditas sebelum graduation');
  } else if (llt === 'protocol_locked') {
    if (lpData && lpData.mintClosed) {
      // LP sepenuhnya burned on-chain — konfirmasi via getTokenSupply + getAccountInfo
      const _closedLabel = lpData.mintClosed === 'closed'
        ? '🔒 **100% LP BURNED — LP Mint Ditutup** ✅'
        : '🔒 **100% LP BURNED — Supply = 0** ✅';
      const _mechDetail = lpData.mintClosed === 'closed'
        ? 'lalu mem-burn SEMUA LP token dan **menutup mint secara permanen**'
        : 'lalu mem-burn SEMUA LP token (supply = 0; mint account masih eksis)';
      lines.push('• Status: ' + _closedLabel);
      lines.push('• LP Mint: `' + (lpData.lpMint || '?') + '`');
      lines.push('• Mekanisme: pump.fun mencetak LP token saat migrasi (~85 SOL + token ke PumpSwap),');
      lines.push('  ' + _mechDetail);
      lines.push('• ✅ Creator TIDAK BISA menarik likuiditas awal — aman penuh');
      if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
      if (lpData.poolIndex === 0) lines.push('• ℹ️ Pool index 0 — canonical pump.fun migrate pool ✓');
    } else if (lpData && lpData.burnPct !== undefined) {
      const sp  = lpData.securedPct;
      const bp  = lpData.burnPct;
      const lp  = lpData.lockPct || 0;
      const _deadSet3 = new Set(lpData.deadOwners || []);
      const nonSecuredH = (lpData.holders || []).filter(h =>
        !BURN_ADDRS.has(h.owner) && !_deadSet3.has(h.owner) && !LOCK_PROGRAMS.has(h.owner) && h.uiAmount > 0
      );
      const lockIcon3 = sp >= 99 ? '🔒' : sp >= 80 ? '🔒' : sp >= 50 ? '⚠️' : '🚨';
      const spFmt3 = sp < 5 ? sp.toFixed(2) : sp.toFixed(1);
      // Label sumber data: dari Pool.lp_supply (lebih akurat) atau dari holders langsung
      const srcLabel = lpData.derivedFromPool ? ' _(dihitung dari Pool.lp_supply)_' : '';

      lines.push('• Status: ' + lockIcon3 + ' **' + spFmt3 + '% LP aman** (burned: ' + bp.toFixed(1) + '% + locked: ' + lp.toFixed(1) + '%)' + srcLabel);
      lines.push('• LP Mint: `' + (lpData.lpMint || '?') + '`');

      if (sp >= 99) {
        // LP hampir seluruhnya aman — konfirmasi positif
        lines.push('• Mekanisme: LP dicetak saat migrasi bonding curve (~85 SOL), lalu **' + bp.toFixed(1) + '% di-burn** oleh protokol ' + launchpad.name);
        if (lpData.currentCirculating > 0) {
          const decimals9 = lpData.currentCirculating / 1e9;
          lines.push('• Sisa beredar: ' + decimals9.toFixed(4) + ' LP (' + (100-sp).toFixed(2) + '%) di market maker — likuiditas awal aman');
        } else {
          lines.push('• ✅ Core liquidity aman — creator tidak bisa tarik likuiditas awal');
        }
        if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
        if (nonSecuredH.length > 0) {
          lines.push('• ℹ️ Market maker LP: ' + nonSecuredH.length + ' penyedia (' + nonSecuredH.slice(0,3).map((h,i)=>{
            const pct = lpData.total > 0 ? ((h.uiAmount/lpData.total)*100).toFixed(2)+'%' : '?%';
            return '#'+(i+1)+' `'+short(h.owner||h.address)+'` ('+pct+')';
          }).join(', ') + ')');
        }
      } else if (sp >= 50) {
        // Sebagian burn, tapi sisa signifikan
        lines.push('• Mekanisme: LP dicetak saat migrasi — **' + bp.toFixed(1) + '% burned, ' + (100-sp).toFixed(1) + '% masih bebas**');
        lines.push('• ⚠️ ' + (100-sp).toFixed(1) + '% LP BELUM aman — bisa ditarik oleh:');
        if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
        nonSecuredH.slice(0, 5).forEach((h, i) => {
          const pctStr = lpData.total > 0 ? ((h.uiAmount / lpData.total) * 100).toFixed(2) + '%' : '?%';
          lines.push('  #' + (i+1) + ' `' + short(h.owner || h.address) + '` (' + pctStr + ')');
        });
      } else {
        // sp < 50: LP sebagian besar atau seluruhnya tidak aman
        const totalUnsecuredPct = (100 - sp).toFixed(1);
        if (bp === 0 && lp === 0) {
          lines.push('• ⚠️ LP token dicetak oleh protokol ' + launchpad.name + ' tapi **BELUM di-burn**');
          lines.push('• 🚨 **' + totalUnsecuredPct + '% LP bisa ditarik** — penyedia berikut bisa rug pull kapan saja:');
        } else {
          lines.push('• Mekanisme: LP dicetak saat migrasi — hanya ' + sp.toFixed(1) + '% aman, **' + totalUnsecuredPct + '% masih bebas**');
          lines.push('• 🚨 **' + totalUnsecuredPct + '% LP bisa ditarik** — penyedia berikut bisa tarik likuiditas:');
        }
        if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
        nonSecuredH.slice(0, 5).forEach((h, i) => {
          const pctStr = lpData.total > 0 ? ((h.uiAmount / lpData.total) * 100).toFixed(2) + '%' : '?%';
          lines.push('  #' + (i+1) + ' `' + short(h.owner || h.address) + '` (' + pctStr + ')');
        });
        if (nonSecuredH.length > 5) lines.push('  ... dan ' + (nonSecuredH.length - 5) + ' penyedia lainnya');
      }
    } else {
      // Fallback: LP data gagal di-fetch
      lines.push('• Status: 🔒 **LP TERKUNCI OLEH PROTOKOL ' + launchpad.name.toUpperCase() + '**');
      lines.push('• LP token dari migrasi bonding curve (~85 SOL + token) di-burn/dikunci permanen oleh protokol');
      lines.push('• ℹ️ Data LP tidak tersedia saat ini — asumsikan aman (pump.fun protocol)');
      if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
    }
  } else if (llt === 'check_burn' && lpData) {
    const sp = lpData.securedPct;
    const bp = lpData.burnPct;
    const lp = lpData.lockPct;
    const lockIcon = sp >= 99 ? '🔒' : sp >= 80 ? '🔒' : sp >= 50 ? '⚠️' : '🚨';
    const spFmt = sp < 5 ? sp.toFixed(2) : sp.toFixed(1);
    lines.push('• Status: ' + lockIcon + ' **' + spFmt + '% LP aman** (burned: ' + bp.toFixed(1) + '% + locked: ' + lp.toFixed(1) + '%)');
    lines.push('• LP Mint: `' + (lpData.lpMint || '?') + '`');
    lines.push('• Total LP: ' + fmtNum(lpData.total) + ' | Burned: ' + fmtNum(lpData.burned) + ' | Locked: ' + fmtNum(lpData.locked));
    if (sp < 99) lines.push('• ⚠️ Sisa ' + (100 - sp).toFixed(1) + '% LP tidak aman — bisa ditarik!');
    if (lpData.holders.length > 0) {
      lines.push('• Top LP holders:');
      lpData.holders.slice(0, 4).forEach((h, i) => {
        const pct    = lpData.total > 0 ? ((h.uiAmount / lpData.total) * 100).toFixed(1) : '?';
        const _deadSet = new Set(lpData.deadOwners || []);
        const burnMk = (isBurn(h.owner) || _deadSet.has(h.owner)) ? ' 🔥 DEAD/BURNED'
                     : isLockProgram(h.owner)                     ? ' 🔒 LOCKED'
                     : '';
        lines.push('  #' + (i + 1) + ' `' + short(h.owner || h.address) + '` — ' + pct + '%' + burnMk);
      });
    }
    if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
  } else if (llt === 'check_burn' && !lpData) {
    lines.push('• Status: ❓ Tidak bisa diverifikasi otomatis');
    lines.push('• Cek LP burn di: [DexScreener](<https://dexscreener.com/solana/' + mint + '>)');
  } else if (llt === 'meteora') {
    if (lpData?.type === 'DLMM') {
      lines.push('• Status: ℹ️ **Meteora DLMM — Concentrated Liquidity Position**');
      lines.push('• Likuiditas tersimpan dalam position NFT (tiap penyedia kelola posisinya sendiri)');
      lines.push('• ⚠️ Tidak ada LP yang di-burn — penyedia bisa tarik kapan saja kecuali position-nya di-lock');
      lines.push('• Cek posisi individual di [Meteora](<https://app.meteora.ag>)');
    } else if (lpData?.type === 'DAMM') {
      const lp = lpData.lockedPct != null ? lpData.lockedPct : (lpData.securedPct != null ? lpData.securedPct : 0);
      const lockIcon = lp >= 99 ? '🔒' : lp >= 50 ? '⚠️' : lp > 0 ? '⚠️' : '🚨';
      lines.push('• Status: ' + lockIcon + ' **Meteora DAMM — ' + lp.toFixed(1) + '% liquidity terkunci**');
      if (lpData.permanentLock > 0)
        lines.push('• 🔒 Permanent lock: $' + fmtNum(lpData.permanentLock));
      if (lpData.vested3m > 0)
        lines.push('• 🔒 Vested >= 3 bulan: $' + fmtNum(lpData.vested3m));
      if (lpData.vested6m > 0)
        lines.push('• 🔒 Vested >= 6 bulan: $' + fmtNum(lpData.vested6m));
      if (lpData.tvl > 0)
        lines.push('• TVL Pool: $' + fmtNum(lpData.tvl));
      if (lp < 100)
        lines.push('• ⚠️ Sisa ' + (100 - lp).toFixed(1) + '% liquidity TIDAK terkunci — bisa ditarik kapan saja');
    } else {
      lines.push('• Status: ℹ️ Meteora pool — cek posisi di [Meteora](<https://app.meteora.ag>)');
    }
    if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
  } else if (launchpad.type === 'orca') {
    if (lpData && lpData.type === 'orca_clmm') {
      const lp = lpData.lockedPct || 0;
      if (lp >= 99) {
        lines.push('• Status: 🔒 **' + lp.toFixed(2) + '% liquidity terkunci via Orca lock ✓**');
        lines.push('• Semua likuiditas aman — terkunci permanen di Orca');
      } else if (lp >= 50) {
        lines.push('• Status: ⚠️ **' + lp.toFixed(2) + '% liquidity terkunci** (via Orca lock)');
        lines.push('• ⚠️ Sisa ' + (100 - lp).toFixed(2) + '% posisi bisa ditarik kapan saja');
      } else if (lp >= 1) {
        lines.push('• Status: ⚠️ **Hanya ' + lp.toFixed(2) + '% terkunci** — sebagian besar bisa ditarik');
        lines.push('• ⚠️ ' + (100 - lp).toFixed(2) + '% likuiditas tidak terkunci — risiko penarikan tinggi');
      } else if (lp > 0) {
        lines.push('• Status: 🚨 **Hanya ' + lp.toFixed(6) + '% terkunci — praktis 0%**');
        lines.push('• ⚠️ Semua posisi penyedia dapat ditarik kapan saja');
      } else {
        lines.push('• Status: 🚨 **0% liquidity terkunci — TIDAK ADA lock**');
        lines.push('• Semua posisi CLMM dapat ditarik kapan saja oleh penyedia');
      }
      if (lp > 0 && lpData.lockEntries?.length > 0) {
        lpData.lockEntries.forEach(e => {
          const _lpct = parseFloat(e.lockedPercentage || e.locked_percentage || 0) * 100; // ×100: fraction→persen
          const _lpctStr = _lpct >= 99.99 ? '100.00' : _lpct < 0.01 ? _lpct.toExponential(2) : _lpct.toFixed(4);
          lines.push('  • 🔒 ' + (e.name || 'Lock') + ': ' + _lpctStr + '% terkunci');
        });
      }
    } else {
      lines.push('• Status: ⚠️ **Orca CLMM — Tidak bisa ambil data lock (API timeout)**');
      lines.push('• Asumsikan posisi bisa ditarik kapan saja — cek manual');
    }
    lines.push('• Cek posisi di [Orca](<https://www.orca.so/pools>)');
    if (launchpad.poolAddr) lines.push('• Pool: [Solscan](<https://solscan.io/account/' + launchpad.poolAddr + '>)');
  } else {
    lines.push('• Status: ❓ Tidak bisa diverifikasi otomatis');
    lines.push('• Cek manual: [DexScreener](<https://dexscreener.com/solana/' + mint + '>)');
  }
  // ── Secondary pools signifikan ─────────────────────────────────────────────
  // FIX: Secondary Meteora pools sekarang menampilkan status lock aktual
  // (DLMM vs DAMM, persentase terkunci, permanent lock) bukan hanya link generic.
  if (dexPairs && dexPairs.length > 1) {
    const _topLiq = dexPairs[0]?.liquidity?.usd || 0;
    const _threshold = Math.max(10000, _topLiq * 0.05);
    const _secPools = dexPairs.slice(1).filter(p => (p.liquidity?.usd || 0) >= _threshold);
    if (_secPools.length > 0) {
      lines.push('• **Pool lain yang perlu dicek:**');
      _secPools.slice(0, 4).forEach(p => {
        const _dex = (p.dexId || 'dex').toLowerCase();
        const _liq = '$' + fmtNum(p.liquidity?.usd || 0);
        let _st;
        if (_dex.includes('meteora')) {
          const _meta = secondaryMeteoraPools.find(m => m.pairAddress === p.pairAddress);
          const _info = _meta ? _meta.meteoraInfo : null;
          if (_info && _info.type === 'DLMM') {
            _st = 'ℹ️ DLMM — posisi NFT, tiap LP bisa tarik kapan saja. [Cek di Meteora](<https://app.meteora.ag/pools/' + p.pairAddress + '>)';
          } else if (_info && _info.type === 'DAMM') {
            const _lp  = _info.lockedPct != null ? _info.lockedPct : (_info.securedPct != null ? _info.securedPct : 0);
            const _ico = _lp >= 99 ? '🔒' : _lp >= 50 ? '⚠️' : _lp > 0 ? '⚠️' : '🚨';
            const _perm = _info.permanentLock > 0 ? ' (permanent: $' + fmtNum(_info.permanentLock) + ')' : '';
            const _v3   = _info.vested3m > 0 ? ' (vested 3bln: $' + fmtNum(_info.vested3m) + ')' : '';
            _st = _ico + ' DAMM — **' + _lp.toFixed(1) + '% terkunci**' + _perm + _v3;
          } else {
            _st = '⚠️ Meteora — cek posisi di [Meteora](<https://app.meteora.ag/pools/' + p.pairAddress + '>)';
          }
        } else if (_dex.includes('raydium')) {
          _st = '❓ Raydium — cek [LP di Solscan](<https://solscan.io/account/' + p.pairAddress + '>)';
        } else if (_dex.includes('orca')) {
          _st = '⚠️ Orca CLMM — posisi NFT, bisa ditarik';
        } else if (_dex.includes('pumpswap')) {
          _st = '🔒 PumpSwap — LP terkunci protokol';
        } else {
          _st = '❓ Cek [DexScreener](<https://dexscreener.com/solana/' + p.pairAddress + '>)';
        }
        lines.push('  • 🔹 ' + _dex + ' ' + _liq + ' — ' + _st);
      });
    }
  }

  lines.push('');

  // ── 4. Security ──
  lines.push('**' + (sn++) + '️⃣ SECURITY ANALYSIS (GoPlus)**');
  if (goplus) {
    const isToken22 = (goplus.is_token_2022 === '1' || goplus.is_token_2022 === true) || (platformData?.token_program && platformData.token_program !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    lines.push('• Token Program: ' + (isToken22 ? 'SPL Token-2022 ⚠️' : 'SPL Token (legacy) ✅'));
    lines.push('• Mint Authority: ' + (goplus.mint_authority ? '🚨 Belum revoked: ' + short(goplus.mint_authority) : '✅ Revoked'));
    lines.push('• Freeze Authority: ' + (goplus.freeze_authority ? '⚠️ Ada: ' + short(goplus.freeze_authority) : '✅ Revoked'));
    if (goplus.top10_holder_rate) lines.push('• Top 10 konsentrasi: ' + fmtPct(parseFloat(goplus.top10_holder_rate) * 100));
    if (goplus.is_honeypot === '1') lines.push('• 🚨 HONEYPOT: GoPlus mendeteksi sebagai honeypot!');
    if (goplus.can_take_back_ownership === '1') lines.push('• 🚨 Ownership bisa diambil balik!');
  } else {
    lines.push('• ⚠️ GoPlus tidak tersedia untuk token ini');
    lines.push('• Cek manual: [GoPlus](<https://gopluslabs.io/token-security/solana/' + mint + '>)');
  }
  lines.push('');

  // ── 5. Market Data ──
  lines.push('**' + (sn++) + '️⃣ DATA PASAR**');
  if (pair) {
    // GMGN sebagai sumber utama (lebih akurat & real-time), DexScreener sebagai fallback
    // fin(v, fb): parse ke float, return fb jika hasilnya tidak finite (guard NaN/Infinity)
    const fin = (v, fb = 0) => { const n = parseFloat(v); return Number.isFinite(n) ? n : fb; };
    const gp   = gmgnInfo?.price || {};
    const gliq = fin(gmgnInfo?.pool?.liquidity || gmgnInfo?.liquidity);

    const priceVal = fin(gp.price, fin(pair.priceUsd));
    const liqVal   = (gliq > 0) ? gliq : fin(pair.liquidity?.usd);
    const vol24h   = fin(gp.volume_24h) > 0 ? fin(gp.volume_24h) : fin(pair.volume?.h24);
    const buys     = Number.isFinite(parseFloat(gp.buys_24h))  ? Math.round(parseFloat(gp.buys_24h))
                   : (pair.txns?.h24?.buys  || 0);
    const sells    = Number.isFinite(parseFloat(gp.sells_24h)) ? Math.round(parseFloat(gp.sells_24h))
                   : (pair.txns?.h24?.sells || 0);
    const mcGmgn   = fin(gmgnInfo?.market_cap);
    const mcVal    = mcGmgn > 0 ? mcGmgn : fin(pair.marketCap || pair.fdv);

    // Price change 24h: hitung dari GMGN (price vs price_24h), fallback DexScreener
    let pc24;
    const gCur = fin(gp.price);
    const g24  = fin(gp.price_24h);
    if (gCur > 0 && g24 > 0) {
      const rawPc = (gCur - g24) / g24 * 100;
      pc24 = Number.isFinite(rawPc) ? rawPc : fin(pair.priceChange?.h24);
    } else {
      pc24 = fin(pair.priceChange?.h24);
    }

    lines.push('• DEX: ' + (pair.dexId || 'N/A') + ' | Pair: ' + (pair.baseToken?.symbol || tokenSymbol) + '/' + (pair.quoteToken?.symbol || 'SOL'));
    lines.push('• Harga: $' + priceVal.toFixed(8));
    lines.push('• Market Cap: $' + fmtNum(mcVal));
    lines.push('• Likuiditas: $' + fmtNum(liqVal));
    lines.push('• Volume 24h: $' + fmtNum(vol24h));
    lines.push('• Price Change 24h: ' + (pc24 >= 0 ? '+' : '') + pc24.toFixed(2) + '%');
    lines.push('• Transaksi 24h: ' + buys + ' buys / ' + sells + ' sells');
    if (pair.pairAddress) {
      lines.push('• Pool: [DexScreener](<https://dexscreener.com/solana/' + pair.pairAddress + '>) | [Solscan](<https://solscan.io/account/' + pair.pairAddress + '>)');
    }
    if (pair.pairCreatedAt) lines.push('• Pair dibuat: ' + new Date(pair.pairCreatedAt).toISOString().slice(0, 10));
    if (dexPairs.length > 1) {
      lines.push('• Pair lain: ' + dexPairs.slice(1, 4).map(p => p.dexId + ' $' + fmtNum(p.liquidity?.usd || 0)).join(' | '));
    }
  } else if (platformData?.usd_market_cap) {
    lines.push('• Market Cap (' + launchpad.name + '): $' + fmtNum(platformData.usd_market_cap));
    lines.push('• ℹ️ Pair DEX belum ada — token masih di bonding curve');
  } else {
    lines.push('• Belum ada data pasar DEX');
  }
  lines.push('');

  // ── 6. Holders ──
  lines.push('**' + (sn++) + '️⃣ DISTRIBUSI HOLDER**');
  const poolBaseAcct = (lpData && lpData.type !== 'DLMM') ? lpData.poolBaseTokenAccount : null;
  if (holders && holders.length > 0) {
    lines.push('• Top ' + Math.min(holders.length, 10) + ' holders:');
    holders.slice(0, 10).forEach((h, i) => {
      const owner = h.owner || h.address || 'N/A';
      const amt   = fmtNum(h.uiAmount || 0);
      const isBc  = platformData && (owner === platformData.bonding_curve || h.address === platformData.associated_bonding_curve);
      const isPool = poolBaseAcct && (h.address === poolBaseAcct);
      const badge = isBurn(owner)        ? ' 🔥 BURNED'
                  : isLockProgram(owner) ? ' 🔒 LOCKED'
                  : isBc                 ? ' 🎯 BONDING CURVE'
                  : isPool               ? ' 🏊 POOL LIQUIDITY'
                  : '';
      lines.push('  #' + (i + 1) + ' `' + short(owner) + '` — ' + amt + badge);
    });
  } else if (goplus?.top10_holder_rate) {
    lines.push('• Top 10 holder rate: ' + fmtPct(parseFloat(goplus.top10_holder_rate) * 100));
    if (goplus.holder_count) lines.push('• Total holders: ' + fmtNum(parseInt(goplus.holder_count)));
  } else {
    lines.push('• Data holder tidak tersedia (RPC rate-limited atau token sangat baru)');
  }
  lines.push('');

  // ── 7. Creator ──
  lines.push('**' + (sn++) + '️⃣ CREATOR / DEV WALLET**');
  const creator = platformData?.creator || goplus?.creator_address || null;
  if (creator) {
    lines.push('• Alamat: `' + creator + '`');
    lines.push('• 🔗 [Solscan](<https://solscan.io/account/' + creator + '>) | [GMGN](<https://gmgn.ai/sol/address/' + creator + '>)');
    if (goplus?.creator_percentage) {
      const devPct  = parseFloat(goplus.creator_percentage) * 100;
      const devBadge = devPct > 20 ? '🚨' : devPct > 5 ? '⚠️' : '✅';
      lines.push('• Dev holding: ' + devBadge + ' ' + devPct.toFixed(2) + '% supply');
    }
  } else {
    lines.push('• Creator tidak ditemukan di data publik');
  }
  lines.push('');

  // ── 8. Links ──
  lines.push('**' + (sn++) + '️⃣ LINKS**');
  lines.push('• 📊 [DexScreener](<https://dexscreener.com/solana/' + mint + '>)');
  lines.push('• 🌿 [Birdeye](<https://birdeye.so/token/' + mint + '?chain=solana>)');
  lines.push('• 🔍 [Solscan](<https://solscan.io/token/' + mint + '>)');
  lines.push('• 🛡️ [GoPlus](<https://gopluslabs.io/token-security/solana/' + mint + '>)');
  if (isPumpFunVerified) lines.push('• 🟣 [pump.fun](<https://pump.fun/' + mint + '>)');
  if (isBonkVerified)   lines.push('• 🐶 [Bonk.fun](<https://bonk.fun/en/' + mint + '>)');
  if (launchpad.type === 'raydium')  lines.push('• 🔵 [Raydium](<https://raydium.io/swap/?inputMint=sol&outputMint=' + mint + '>)');
  if (launchpad.type === 'meteora')  lines.push('• 🟤 [Meteora](<https://app.meteora.ag>)');
  if (launchpad.type === 'orca')     lines.push('• 🩵 [Orca](<https://www.orca.so>)');
  lines.push('');

  // ── Risk Summary ──
  lines.push('**📊 RISK SUMMARY**');
  if (R.length) { lines.push('🔴 **MERAH:**'); R.forEach(m => lines.push('  • ' + m)); }
  if (Y.length) { lines.push('🟡 **KUNING:**'); Y.forEach(m => lines.push('  • ' + m)); }
  if (G.length) { lines.push('🟢 **HIJAU:**'); G.forEach(m => lines.push('  • ' + m)); }
  if (I.length) { lines.push('ℹ️ **INFO:**'); I.forEach(m => lines.push('  • ' + m)); }
  lines.push('');
  lines.push('**Verdict: ' + riskLabel + ' (score: ' + score + ')**');
  lines.push('_Scan by BP.AI — DYOR, bukan financial advice_');

  return lines.join('\n');
}

// ─── Main entry ────────────────────────────────────────────────────────────────
async function runSolScanner(mint) {
  // Validasi format Solana address
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    return '❌ `' + mint + '` bukan Solana address yang valid.\nFormat: base58, 32-44 karakter.';
  }

  // ── Round 1: Parallel fetch semua sumber data ─────────────────────────────
  // Fetch API data + on-chain verification secara paralel
  const [pumpData, bonkData, dexPairs, goplus, rawHolders, jupInfo, gmgnInfo] = await Promise.all([
    fetchPumpFun(mint),
    fetchBonkFun(mint),
    fetchDexScreener(mint),
    fetchGoPlusSol(mint),
    getTokenLargestAccounts(mint),
    fetchJupiterTokenInfo(mint),
    fetchGmgnTokenInfo(mint),
  ]);

  // Token tidak ditemukan sama sekali
  if (!pumpData && !bonkData && !goplus && !dexPairs && (!rawHolders || rawHolders.length === 0) && !jupInfo) {
    return (
      '❌ Token `' + mint + '` tidak ditemukan di Solana.\n\n' +
      'Kemungkinan: alamat salah, token di chain lain, atau sangat baru.\n' +
      '🔍 Cek: https://solscan.io/token/' + mint
    );
  }

  // ── Round 1b: On-chain verification pump.fun / bonkfun ───────────────────
  // FIX: Pump.fun API return data untuk SEMUA token — wajib verifikasi on-chain!
  // Jalankan verifikasi on-chain paralel; kalau API data null → skip verify (false)
  const [isPumpFunVerified, isBonkVerified] = await Promise.all([
    pumpData ? verifyPumpFunOnChain(mint, pumpData) : Promise.resolve(false),
    bonkData ? verifyLetsBonkOnChain(mint, bonkData) : Promise.resolve(false),
  ]);

  // ── Deteksi launchpad ────────────────────────────────────────────────────
  const launchpad = detectLaunchpad(pumpData, bonkData, dexPairs, isPumpFunVerified, isBonkVerified);

  // ── Round 2: Resolve holders + fetch LP info paralel ─────────────────────
  let poolLpFetchPromise = Promise.resolve(null);

  // Siapkan daftar secondary Meteora pools yang signifikan untuk dianalisis lock-nya.
  // FIX: Bot sebelumnya TIDAK menganalisis LP lock untuk secondary Meteora pools.
  const _topLiq2 = dexPairs && dexPairs[0] && dexPairs[0].liquidity ? (dexPairs[0].liquidity.usd || 0) : 0;
  const _thresh2 = Math.max(10000, _topLiq2 * 0.05);
  const _secMetaPairs = (dexPairs || []).slice(1).filter(p =>
    (p.liquidity && p.liquidity.usd ? p.liquidity.usd : 0) >= _thresh2 &&
    (p.dexId || '').toLowerCase().includes('meteora') &&
    !!p.pairAddress
  );

  if (launchpad.lpLockType === 'protocol_locked' && launchpad.poolAddr) {
    // PumpSwap: decode pool → LP mint → hitung burn% via Pool.lp_supply vs getTokenSupply
    //
    // METODE UTAMA: Pool.lp_supply (dari Pool account) adalah TOTAL LP yang pernah dicetak.
    // getTokenSupply(lpMint) = LP yang masih beredar sekarang.
    // derivedBurnPct = (Pool.lp_supply - current_supply) / Pool.lp_supply × 100
    //
    // Ini mengatasi dua bug sekaligus:
    //   1. getTokenLargestAccounts kadang return 0 walaupun ada holder (RPC bug)
    //   2. Sebelumnya tidak pernah cross-check Pool.lp_supply
    //
    // Fallback: getProgramAccounts untuk identifikasi holder sisa LP yang belum burned
    poolLpFetchPromise = decodePumpSwapPool(launchpad.poolAddr).then(async decoded => {
      if (!decoded?.lpMint) return null;
      const poolLpSupply = decoded.lpSupply;
      if (!poolLpSupply || poolLpSupply <= 0) return null;

      // Ambil current circulating supply + mint account existence secara paralel
      const [mintSupplyRes, mintAcctRes] = await Promise.all([
        rpcCall('getTokenSupply', [decoded.lpMint]),
        rpcCall('getAccountInfo', [decoded.lpMint, { encoding: 'base64' }], 8000),
      ]);
      if (!mintSupplyRes) {
        // RPC gagal — fallback ke checkLPBurn saja
        const lpBurn = await checkLPBurn(decoded.lpMint);
        return lpBurn ? { ...lpBurn, poolLpSupply, poolIndex: decoded.poolIndex, type: 'pumpswap' } : null;
      }

      const currentSupply = Number(mintSupplyRes?.value?.amount ?? 0);
      const mintExists    = mintAcctRes?.value !== null && mintAcctRes?.value !== undefined;

      // ── Case 1: supply = 0 → sepenuhnya burned ──
      if (currentSupply === 0) {
        const mintClosed = !mintExists ? 'closed' : 'burned';
        return {
          lpMint: decoded.lpMint,
          holders: [], total: poolLpSupply, burned: poolLpSupply, locked: 0,
          secured: poolLpSupply, burnPct: 100, lockPct: 0, securedPct: 100,
          deadOwners: [], mintClosed,
          poolLpSupply, poolIndex: decoded.poolIndex, type: 'pumpswap',
        };
      }

      // ── Case 2: supply > 0 → hitung derivedBurnPct dari Pool.lp_supply ──
      const burnedFromPool = poolLpSupply - currentSupply;
      const derivedBurnPct = burnedFromPool > 0 ? (burnedFromPool / poolLpSupply) * 100 : 0;

      // Cari holder sisa LP untuk identifikasi risiko:
      // Coba getTokenLargestAccounts dulu, fallback ke getProgramAccounts
      let remainingHolders = [];
      const largestRes = await rpcCall('getTokenLargestAccounts', [decoded.lpMint, { commitment: 'confirmed' }]);
      const rawLargest  = largestRes?.value || [];
      if (rawLargest.length > 0) {
        // getTokenLargestAccounts berhasil — resolve owners
        const ownerRes = await rpcCall('getMultipleAccounts', [rawLargest.map(h => h.address), { encoding: 'jsonParsed' }]);
        remainingHolders = rawLargest.map((h, i) => ({
          ...h,
          owner: ownerRes?.value?.[i]?.data?.parsed?.info?.owner || null,
        }));
      } else {
        // RPC bug: getTokenLargestAccounts return 0 padahal supply > 0
        // Fallback ke getProgramAccounts untuk cari token accounts
        const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
        const progRes = await rpcCall('getProgramAccounts', [TOKEN_PROGRAM, {
          encoding: 'jsonParsed',
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: decoded.lpMint } }],
          commitment: 'confirmed',
        }]);
        if (Array.isArray(progRes)) {
          remainingHolders = progRes
            .map(a => ({
              address: a.pubkey,
              uiAmount: a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0,
              owner: a.account?.data?.parsed?.info?.owner || null,
            }))
            .filter(h => h.uiAmount > 0)
            .sort((a, b) => b.uiAmount - a.uiAmount);
        }
      }

      // Hitung locked dari holder yang ada di LOCK_PROGRAMS
      const lockedFromHolders = remainingHolders
        .filter(h => LOCK_PROGRAMS.has(h.owner))
        .reduce((s, h) => s + (h.uiAmount || 0), 0);
      const lockedPct = poolLpSupply > 0 ? (lockedFromHolders / poolLpSupply) * 100 : 0;
      const securedPct = derivedBurnPct + lockedPct;

      // Dead-owner check untuk holder sisa yang tidak di-lock
      const unknownOwners = [...new Set(
        remainingHolders.map(h => h.owner).filter(o => o && !BURN_ADDRS.has(o) && !LOCK_PROGRAMS.has(o))
      )];
      let deadOwners = [];
      if (unknownOwners.length > 0) {
        const deadRes = await rpcCall('getMultipleAccounts', [unknownOwners, { encoding: 'base64' }]);
        if (Array.isArray(deadRes?.value)) {
          unknownOwners.forEach((o, i) => { if (deadRes.value[i] === null) deadOwners.push(o); });
        }
      }
      const lockedFromDead = remainingHolders
        .filter(h => deadOwners.includes(h.owner))
        .reduce((s, h) => s + (h.uiAmount || 0), 0);
      const adjustedLockedPct = poolLpSupply > 0 ? ((lockedFromHolders + lockedFromDead) / poolLpSupply) * 100 : 0;
      const adjustedSecuredPct = derivedBurnPct + adjustedLockedPct;

      return {
        lpMint: decoded.lpMint,
        holders: remainingHolders,
        total: poolLpSupply,
        burned: burnedFromPool,
        locked: lockedFromHolders + lockedFromDead,
        secured: burnedFromPool + lockedFromHolders + lockedFromDead,
        burnPct: derivedBurnPct,
        lockPct: adjustedLockedPct,
        securedPct: adjustedSecuredPct,
        currentCirculating: currentSupply,
        deadOwners,
        derivedFromPool: true,   // gunakan Pool.lp_supply sebagai total
        poolLpSupply,
        poolIndex: decoded.poolIndex,
        type: 'pumpswap',
      };
    });
  } else if (launchpad.lpLockType === 'check_burn' && launchpad.poolAddr) {
    // Raydium / Orca / generic: fetch LP mint
    poolLpFetchPromise = (async () => {
      const raydiumPool = await fetchRaydiumPoolInfo(launchpad.poolAddr);
      const lpMint = raydiumPool?.lpMint || null;
      if (!lpMint) return null;
      const lpBurn = await checkLPBurn(lpMint);
      return lpBurn ? { ...lpBurn, type: launchpad.type, raydiumPool } : null;
    })();
  } else if (launchpad.lpLockType === 'meteora' && launchpad.poolAddr) {
    poolLpFetchPromise = (async () => {
      const meteoraInfo = await fetchMeteoraPoolInfo(launchpad.poolAddr);
      if (!meteoraInfo) return null;
      if (meteoraInfo.type === 'DAMM' && meteoraInfo.lpMint) {
        const lpBurn = await checkLPBurn(meteoraInfo.lpMint);
        return lpBurn ? { ...lpBurn, ...meteoraInfo } : { ...meteoraInfo };
      }
      return meteoraInfo;
    })();
  } else if (launchpad.lpLockType === 'orca_clmm' && launchpad.poolAddr) {
    // Orca CLMM: gunakan Orca API untuk dapat lockedLiquidityPercent yang akurat
    poolLpFetchPromise = fetchOrcaPoolInfo(launchpad.poolAddr);
  }

  // Fetch semua data secara paralel: holders, primary LP, dan secondary Meteora pools
  const [holders, lpData, secondaryMeteoraPools] = await Promise.all([
    rawHolders.length > 0 ? resolveOwners(rawHolders) : Promise.resolve([]),
    poolLpFetchPromise,
    // Fetch lock data untuk secondary Meteora pools secara paralel
    _secMetaPairs.length > 0
      ? Promise.all(
          _secMetaPairs.map(async p => {
            let meteoraInfo = null;
            try { meteoraInfo = await fetchMeteoraPoolInfo(p.pairAddress); } catch (e) {}
            return { pairAddress: p.pairAddress, dexId: p.dexId, liquidity: p.liquidity, meteoraInfo };
          })
        )
      : Promise.resolve([]),
  ]);

  // ── Score & format ──────────────────────────────────────────────────────
  const analysis = computeScore({
    pumpData, bonkData, isPumpFunVerified, isBonkVerified,
    goplus, dexPairs, holders, lpData, launchpad,
  });

  return formatDiscord({
    mint, pumpData, bonkData, isPumpFunVerified, isBonkVerified,
    jupInfo, goplus, dexPairs, holders, lpData, launchpad,
    secondaryMeteoraPools, gmgnInfo,
    ...analysis,
  });
}

module.exports = { runSolScanner };
