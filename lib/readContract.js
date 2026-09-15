// lib/readContract.js  v4
    // !read [chain] <CA>              -> semua view functions tampil otomatis (persis Read Contract tab Basescan)
    // !read [chain] <CA> <fn> [args]  -> panggil fungsi yang butuh input
    // Chain: base (default) | eth | bsc
    'use strict';

    const axios      = require('axios');
    const { ethers } = require('ethers');

    // ── Chains ─────────────────────────────────────────────────────────────────────
    const CHAINS = {
    base: {
      rpc:     process.env.ALCHEMY_BASE_RPC || 'https://mainnet.base.org',
      scanApi: 'https://api.basescan.org/api',
      scanKey: () => process.env.ETHERSCAN_API_KEY || '',
      scanUrl: 'https://basescan.org/address/',
      label:   'Base', geckoNet: 'base',
    },
    eth: {
      rpc:     process.env.ALCHEMY_ETH_RPC || 'https://ethereum-rpc.publicnode.com',
      scanApi: 'https://api.etherscan.io/api',
      scanKey: () => process.env.ETHERSCAN_API_KEY || '',
      scanUrl: 'https://etherscan.io/address/',
      label:   'Ethereum', geckoNet: 'eth',
    },
    bsc: {
      rpc:     'https://bsc-dataseed.binance.org',
      scanApi: 'https://api.bscscan.com/api',
      scanKey: () => process.env.BSCSCAN_API_KEY || '',
      scanUrl: 'https://bscscan.com/address/',
      label:   'BNB Chain', geckoNet: 'bsc',
    },
    };

    // ── Detect ─────────────────────────────────────────────────────────────────────
    function detectReadContractQuery(text) {
    const m = (text || '').trim().match(
      /^!?read\s+(?:(base|eth|bsc|ethereum|bnb|binance)\s+)?(0x[a-fA-F0-9]{40})(?:\s+(.*))?$/i
    );
    if (!m) return null;
    let chain = (m[1] || 'base').toLowerCase();
    if (chain === 'ethereum') chain = 'eth';
    if (chain === 'bnb' || chain === 'binance') chain = 'bsc';
    const rest = (m[3] || '').trim();
    if (rest) {
      const parts = rest.match(/"([^"]*?)"|'([^']*?)'|(\S+)/g) || [];
      const fnName = parts[0];
      const args   = parts.slice(1).map(p => p.replace(/^["']|["']$/g, ''));
      return { chain, ca: m[2], fnName, args };
    }
    return { chain, ca: m[2] };
    }

    // ── Helpers ────────────────────────────────────────────────────────────────────
    function castArg(raw, type) {
    const t = (type || '').replace(/\[.*?\]$/, '');
    if (t === 'address') return raw;
    if (t === 'bool')    return raw === 'true' || raw === '1';
    if (t.startsWith('uint') || t.startsWith('int')) {
      try { return BigInt(raw); } catch { return raw; }
    }
    return raw;
    }

    function fmtVal(v, decimals) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'bigint') {
      if (v === 0n) return '0';
      const s = v.toString();
      if (decimals !== undefined && s.length > 10) {
        const d   = Number(decimals) || 18;
        const div = 10n ** BigInt(d);
        const num = Number(v / div);
        const fmt = num >= 1e9 ? (num/1e9).toFixed(2)+'B'
                  : num >= 1e6 ? (num/1e6).toFixed(2)+'M'
                  : num >= 1e3 ? num.toLocaleString('en')
                  : num.toFixed(4);
        return s + '  (' + fmt + ')';
      }
      if (s.length > 15) return s;
      return Number(v).toLocaleString('en');
    }
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') {
      if (!v) return '(empty)';
      return v;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return '[' + v.map(x => fmtVal(x)).join(', ') + ']';
    }
    if (v && typeof v === 'object') {
      const pairs = Object.entries(v).filter(([k]) => isNaN(k));
      if (pairs.length) return '{' + pairs.map(([k, x]) => k + ': ' + fmtVal(x)).join(', ') + '}';
    }
    return String(v);
    }

    // Format satu nilai menggunakan ABI type definition (handle tuple/struct dengan nama field)
    function fmtTyped(v, abiOut) {
    if (!abiOut) return fmtVal(v);
    const t = abiOut.type || '';

    // Tuple — tampilkan setiap field dengan namanya
    if (t === 'tuple' && abiOut.components && v && typeof v === 'object' && !Array.isArray(v)) {
      return abiOut.components.map(comp => {
        const fieldVal = v[comp.name] !== undefined ? v[comp.name] : v[comp.name];
        return '  ' + comp.name.padEnd(26) + ': ' + fmtTyped(fieldVal, comp);
      }).join('\n');
    }

    // Array of tuples
    if (t === 'tuple[]' && Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return v.map((item, i) =>
        '  [' + i + ']\n' + fmtTyped(item, { ...abiOut, type: 'tuple' })
      ).join('\n');
    }

    // Int/uint array — tampilkan inline
    if (t.endsWith('[]') && Array.isArray(v)) {
      if (v.length === 0) return '[]';
      return '[' + v.map(x => fmtVal(x)).join(', ') + ']';
    }

    // bigint dengan format ribuan
    if (typeof v === 'bigint') return fmtVal(v);

    return fmtVal(v);
    }

    // Format hasil lengkap berdasarkan outputs[] dari ABI
    function fmtAbi(decoded, outputs) {
    if (!outputs || outputs.length === 0) return fmtVal(decoded);

    // Satu output
    if (outputs.length === 1) {
      const out = outputs[0];
      const v   = Array.isArray(decoded) && decoded.length === 1 ? decoded[0] : decoded;
      // Jika tuple — tampilkan struct dengan nama field
      if (out.type === 'tuple' && out.components) {
        return '\n' + fmtTyped(v, out);
      }
      return fmtTyped(v, out);
    }

    // Multiple outputs — label setiap field
    const vals = Array.isArray(decoded) ? decoded : [decoded];
    return '\n' + outputs.map((out, i) => {
      const label = (out.name || ('out' + i)).padEnd(26);
      return '  ' + label + ': ' + fmtTyped(vals[i], out);
    }).join('\n');
    }

    function fmtUsd(n) {
    const num = Number(n);
    if (!num || isNaN(num)) return null;
    if (num >= 1e9) return '$' + (num/1e9).toFixed(2) + 'B';
    if (num >= 1e6) return '$' + (num/1e6).toFixed(2) + 'M';
    if (num >= 1e3) return '$' + (num/1e3).toFixed(1) + 'K';
    return '$' + num.toFixed(4);
    }

    // ── ABI fetch ──────────────────────────────────────────────────────────────────
    // Chain ID mapping untuk fallback anyabi.xyz
    const CHAIN_IDS = { base: 8453, eth: 1, bsc: 56 };

    async function fetchAbi(chain, ca) {
    const cfg = CHAINS[chain];
    if (!cfg) return null;

    // 1) Coba via scan API (Basescan / Etherscan / BscScan)
    try {
      const key = cfg.scanKey();
      const url = cfg.scanApi + '?module=contract&action=getabi&address=' + ca + (key ? '&apikey=' + key : '');
      const { data } = await axios.get(url, { timeout: 10000 });
      if (data.status === '1' && data.result && data.result !== 'Contract source code not verified') {
        return JSON.parse(data.result);
      }
    } catch {}

    // 2) Fallback: anyabi.xyz (gratis, tidak perlu API key, support Base/ETH/BSC)
    try {
      const chainId = CHAIN_IDS[chain] || 1;
      const { data } = await axios.get('https://anyabi.xyz/api/get-abi/' + chainId + '/' + ca, { timeout: 12000 });
      if (data && data.abi) return data.abi;
    } catch {}

    // 3) Fallback: openchain.xyz (Dune-based, support EVM luas)
    try {
      const { data } = await axios.get('https://api.openchain.xyz/signature-database/v1/lookup?filter=0x' + ca.slice(2), { timeout: 8000 });
      // openchain tidak return full ABI, skip jika tidak ada abi field
      if (data && data.abi) return data.abi;
    } catch {}

    return null;
    }

    // ── Pool fetch ─────────────────────────────────────────────────────────────────
    async function fetchPoolData(geckoNet, ca) {
    try {
      const url = 'https://api.geckoterminal.com/api/v2/networks/' + geckoNet + '/tokens/' + ca + '/pools?page=1';
      const { data } = await axios.get(url, {
        headers: { Accept: 'application/json;version=20230302' }, timeout: 10000,
      });
      const pools = data && data.data;
      if (!pools || pools.length === 0) return null;
      return pools.slice(0, 3).map(p => ({
        name:   p.attributes?.name   || '?',
        addr:   p.attributes?.address || '?',
        dex:    p.relationships?.dex?.data?.id || '?',
        fee:    p.attributes?.swap_fee || null,
        price:  p.attributes?.base_token_price_usd || null,
        liq:    p.attributes?.reserve_in_usd || null,
        vol24h: p.attributes?.volume_usd?.h24 || null,
        fdv:    p.attributes?.fdv_usd || null,
        mcap:   p.attributes?.market_cap_usd || null,
      }));
    } catch { return null; }
    }

    // ── RPC batch ──────────────────────────────────────────────────────────────────
    async function rpcBatch(rpc, calls, timeoutMs = 15000) {
    if (!calls.length) return [];
    try {
      const body = calls.map((c, i) => ({
        jsonrpc: '2.0', method: 'eth_call', id: i + 1,
        params: [{ to: c.to, data: c.data }, 'latest'],
      }));
      const { data } = await axios.post(rpc, body, {
        headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs,
      });
      const arr = Array.isArray(data) ? data : [data];
      return calls.map((_, i) => {
        const r = arr.find(x => x.id === i + 1);
        return r?.result || null;
      });
    } catch { return calls.map(() => null); }
    }

    // ── Minimal ERC20 ABI (fallback for unverified) ────────────────────────────────
    const ERC20_ABI_MIN = [
    { name: 'name',        type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { name: 'symbol',      type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
    { name: 'decimals',    type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
    { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
    { name: 'owner',       type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
    ];

    // ── Main handler ───────────────────────────────────────────────────────────────
    async function handleReadContractCommand(query) {
    const { chain, ca, fnName, args } = query;
    const cfg = CHAINS[chain] || CHAINS.base;
    const scanLabel = { base: 'Basescan', eth: 'Etherscan', bsc: 'BscScan' }[chain] || 'Basescan';

    // ── Mode: panggil fungsi tertentu dengan argumen ──────────────────────────────
    if (fnName) {
      const abiResult = await fetchAbi(chain, ca);
      if (!abiResult) return '⚠️ Contract `' + ca + '` belum terverifikasi di ' + scanLabel + '.';

      const candidates = abiResult.filter(fn => fn.type === 'function' && fn.name === fnName);
      if (!candidates.length)
        return '❌ Fungsi `' + fnName + '` tidak ditemukan.\nCoba `!read ' + ca + '` untuk lihat daftar fungsi.';

      const fn = candidates.find(f => (f.inputs || []).length === (args || []).length) || candidates[0];
      const typedArgs = (args || []).map((raw, i) => castArg(raw, (fn.inputs?.[i] || {}).type));
      const iface = new ethers.Interface(abiResult);
      let calldata;
      try { calldata = iface.encodeFunctionData(fnName, typedArgs); }
      catch (e) {
        const sig = fnName + '(' + (fn.inputs||[]).map(i => i.type + ' ' + i.name).join(', ') + ')';
        return '❌ Gagal encode args: ' + e.message + '\nSignature: `' + sig + '`';
      }
      const [raw] = await rpcBatch(cfg.rpc, [{ to: ca, data: calldata }]);
      if (!raw || raw === '0x') return '⚠️ `' + fnName + '` reverted atau argumen salah.';

      let decoded;
      try { decoded = iface.decodeFunctionResult(fnName, raw); }
      catch (e) { return '❌ Gagal decode: ' + e.message; }

      const lines = [
        '🔍 **`' + fnName + '`**  (' + cfg.label + ')',
        '`' + ca + '`',
        '',
        '```',
      ];
      if (args?.length) lines.push('Input  : ' + args.join(', '), '');
      if (decoded.length === 1) {
        const out   = (fn.outputs || [])[0];
        const label = out?.name || 'result';
        lines.push(label.padEnd(20) + ': ' + fmtVal(decoded[0]));
      } else {
        Array.from(decoded).forEach((v, i) => {
          const out   = (fn.outputs || [])[i];
          const label = out?.name ? out.name + ' (' + out.type + ')' : 'out' + i;
          lines.push(label.padEnd(28) + ': ' + fmtVal(v));
        });
      }
      lines.push('```');
      lines.push('🔗 [' + scanLabel + '](' + cfg.scanUrl + ca + ')');
      return lines.join('\n');
    }

    // ── Mode default: tampilkan SEMUA data persis kayak Read Contract tab ──────────
    const [abiResult, poolData] = await Promise.all([
      fetchAbi(chain, ca),
      fetchPoolData(cfg.geckoNet, ca),
    ]);

    const workingAbi = abiResult || ERC20_ABI_MIN;
    const iface      = new ethers.Interface(workingAbi);

    // Pisahkan view/pure functions
    const viewFns = workingAbi.filter(
      fn => fn.type === 'function' && (fn.stateMutability === 'view' || fn.stateMutability === 'pure')
    );
    const noInputFns  = viewFns.filter(fn => (fn.inputs || []).length === 0);
    const hasInputFns = viewFns.filter(fn => (fn.inputs || []).length >  0);
    const writeFns    = abiResult
      ? abiResult.filter(fn => fn.type === 'function' && fn.stateMutability !== 'view' && fn.stateMutability !== 'pure')
      : [];

    // Batch call semua no-input view functions sekaligus
    const BATCH = 30;
    const callItems = noInputFns.map(fn => ({
      fn, to: ca, data: (() => { try { return iface.encodeFunctionData(fn.name, []); } catch { return null; } })()
    })).filter(c => c.data);

    const allRaw = [];
    for (let i = 0; i < callItems.length; i += BATCH) {
      const slice  = callItems.slice(i, i + BATCH);
      const res    = await rpcBatch(cfg.rpc, slice, 15000);
      allRaw.push(...res);
    }

    // Decode hasil
    let tokenName = null, symbol = null, decimals = null;
    const readResults = [];
    callItems.forEach((c, i) => {
      const hex = allRaw[i];
      if (!hex || hex === '0x') { readResults.push({ fn: c.fn, value: null, err: true }); return; }
      try {
        const dec = iface.decodeFunctionResult(c.fn.name, hex);
        const val = dec.length === 1 ? dec[0] : Array.from(dec);
        if (c.fn.name === 'name'     && typeof val === 'string')  tokenName = val;
        if (c.fn.name === 'symbol'   && typeof val === 'string')  symbol    = val;
        if (c.fn.name === 'decimals' && (typeof val === 'bigint' || typeof val === 'number')) decimals = Number(val);
        readResults.push({ fn: c.fn, value: val, err: false });
      } catch { readResults.push({ fn: c.fn, value: null, err: true }); }
    });

    // ── Build output ──────────────────────────────────────────────────────────────
    const title = tokenName ? tokenName + (symbol ? ' (' + symbol + ')' : '') : ca.slice(0, 10) + '...';
    const lines = [
      '📋 **READ CONTRACT — ' + title + '**',
      '🔗 **' + cfg.label + '**  `' + ca + '`',
      abiResult ? '✅ Contract terverifikasi' : '⚠️ Tidak terverifikasi (hanya ERC20)',
    ];

    // ── Read functions (no input) — hasil langsung ────────────────────────────────
    const shown = readResults.filter(r => !r.err);
    if (shown.length > 0) {
      lines.push('');
      lines.push('**📖 Read Functions**');
      lines.push('```');
      let num = 1;
      readResults.forEach(r => {
        if (r.err || r.value === null) return;
        const outputs = r.fn.outputs || [];
        const outType = outputs.length === 1 ? outputs[0].type : outputs.map(o => o.type).join(', ');

        let display;
        if (r.fn.name === 'totalSupply' && decimals !== null) {
          // totalSupply: tampilkan raw + formatted
          const raw = typeof r.value === 'bigint' ? r.value : BigInt(r.value.toString());
          display = fmtVal(raw, decimals);
        } else {
          // Gunakan fmtAbi untuk handle tuple/struct dengan nama field
          const vals = Array.isArray(r.value) ? r.value : [r.value];
          display = fmtAbi(vals, outputs);
        }

        const label = num + '. ' + r.fn.name + (outType ? '  →  ' + outType : '');
        lines.push(label);
        // Jika display multi-line (tuple), tidak perlu indent tambahan
        if (display && display.startsWith('\n')) {
          lines.push(display);
        } else {
          lines.push('   ' + display);
        }
        lines.push('');
        num++;
      });
      lines.push('```');
    }

    // ── Read functions yang butuh input ───────────────────────────────────────────
    if (hasInputFns.length > 0) {
      lines.push('');
      lines.push('**📝 Functions (butuh input)**');
      lines.push('```');
      let num = (shown.length || 0) + 1;
      hasInputFns.forEach(fn => {
        const inputs  = (fn.inputs  || []).map(i => i.type + (i.name ? ' ' + i.name : '')).join(', ');
        const outputs = (fn.outputs || []).map(o => o.type).join(', ');
        lines.push(num + '. ' + fn.name + '(' + inputs + ')  →  ' + outputs);
        num++;
      });
      lines.push('```');
      lines.push('→ Panggil: `!read ' + ca + ' <namaFn> <arg1> <arg2>`');
      lines.push('  Contoh:  `!read ' + ca + ' balanceOf 0xWalletAddress`');
    }

    // ── Write functions ───────────────────────────────────────────────────────────
    if (writeFns.length > 0) {
      lines.push('');
      lines.push('**✏️ Write Functions (' + writeFns.length + ')**');
      lines.push('```');
      writeFns.slice(0, 15).forEach((fn, i) => {
        const inputs = (fn.inputs || []).map(i => i.type + (i.name ? ' ' + i.name : '')).join(', ');
        lines.push((i + 1) + '. ' + fn.name + '(' + inputs + ')  [' + fn.stateMutability + ']');
      });
      if (writeFns.length > 15) lines.push('   ... dan ' + (writeFns.length - 15) + ' lainnya');
      lines.push('```');
    }

    // ── Pool data ─────────────────────────────────────────────────────────────────
    if (poolData && poolData.length > 0) {
      lines.push('');
      lines.push('**💧 Pool / Market Data**');
      poolData.forEach((p, idx) => {
        lines.push('```');
        lines.push('Pool ' + (idx + 1) + ' : ' + p.name + '  (' + p.dex + ')');
        lines.push('Address  : ' + p.addr);
        if (p.fee)    lines.push('Fee      : ' + p.fee);
        if (p.price) {
          const pr = parseFloat(p.price);
          lines.push('Price    : $' + (pr < 0.000001 ? pr.toExponential(4) : pr.toFixed(8)));
        }
        if (p.liq)    lines.push('Liq      : ' + fmtUsd(p.liq));
        if (p.vol24h) lines.push('Vol 24h  : ' + fmtUsd(p.vol24h));
        if (p.fdv)    lines.push('FDV      : ' + fmtUsd(p.fdv));
        if (p.mcap)   lines.push('Mkt Cap  : ' + fmtUsd(p.mcap));
        lines.push('```');
      });
    }

    lines.push('');
    lines.push('🔗 [Lihat di ' + scanLabel + '](' + cfg.scanUrl + ca + ')');
    return lines.join('\n');
    }

    module.exports = { detectReadContractQuery, handleReadContractCommand };
    