// lib/multisend.js — Kirim ETH / ERC-20 ke banyak wallet via smart contract (Base Mainnet)
    // Contract: 0x712127985b107eEfa2085BcAd0C78D7ff7F36FDe
    //
    // Format perintah:
    //   multisend <nominal> usdc to <addr1> <addr2> ...   — kirim USDC
    //   multisend <nominal> eth  to <addr1> <addr2> ...   — kirim ETH
    //   multisend <nominal> <CA> to <addr1> <addr2> ...   — kirim token sembarang (CA = 0x...)
    //
    // Pemisah alamat bebas: spasi, koma, baris baru — semua oke.
    // USDC/ERC-20: approve MaxUint256 otomatis setiap call (gas Base ~$0.001).
    // ETH: langsung kirim via selector payable.

    const USDC_BASE          = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const MULTISEND_CONTRACT = '0x712127985b107eEfa2085BcAd0C78D7ff7F36FDe';

    // Selectors dikonfirmasi via eth_call (contract tidak terverifikasi di Basescan)
    const SEL_MULTISEND_TOKEN = '0x4bbf2a86'; // (address token, address[] recipients, uint256 amountPerAddr)
    const SEL_MULTISEND_ETH   = '0x0391496c'; // (address[] recipients, uint256 amountPerAddr) payable

    const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function symbol() view returns (string)',
    ];

    const MAX_U256 = BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');

    let _ethers   = null;
    let _provider = null;
    let _wallet   = null;

    function loadWallet() {
    if (_wallet) return { ethers: _ethers, provider: _provider, wallet: _wallet };
    try { _ethers = require('ethers'); } catch (e) { throw new Error('Package "ethers" belum terinstall.'); }
    const pk  = process.env.BOT_PRIVATE_KEY;
    const rpc = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
    if (!pk) throw new Error('BOT_PRIVATE_KEY tidak diset di Railway!');
    _provider = new _ethers.JsonRpcProvider(rpc);
    _wallet   = new _ethers.Wallet(pk, _provider);
    return { ethers: _ethers, provider: _provider, wallet: _wallet };
    }

    /**
    * Parse perintah multisend — sangat fleksibel:
    *   - Token bisa: usdc | eth | 0x<CA>
    *   - Alamat bisa dipisah spasi, koma, baris baru, atau kombinasi apapun
    *   - Perintah bisa multi-baris
    *
    * @param {string} text — isi pesan (mentah, termasuk newline)
    * @returns {{ amount, token, recipients }} atau null
    */
    function parseMultisendCommand(text) {
    const normalized = (text || '').trim().replace(/\r/g, '');

    // Capture: nominal + token (usdc/eth/CA) + semua teks setelah kata "to"
    const m = normalized.match(
      /^multisend\s+([\d.,]+)\s+(usdc|eth|0x[a-fA-F0-9]{40})\s+to\b([\s\S]+)$/i
    );
    if (!m) return null;

    const amount = parseFloat(m[1].replace(',', '.'));
    if (isNaN(amount) || amount <= 0) return null;

    const token = m[2].toLowerCase(); // 'usdc', 'eth', atau '0x...'

    // Ekstrak semua wallet address valid dari bagian setelah "to"
    // Regex:  memastikan tidak menangkap substring dari tx hash 64-char
    // Hanya match "0x" yang TIDAK didahului/diikuti hex char lain
    const recipients = (m[3].match(/(?<![a-fA-F0-9])0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/gi) || [])
      .map(a => a.toLowerCase())
      .filter((a, i, arr) => arr.indexOf(a) === i); // deduplikasi

    if (recipients.length === 0) return null;
    return { amount, token, recipients };
    }

    /**
    * Format jumlah token untuk display (hapus trailing zeros).
    */
    function fmtAmount(bigint, decimals) {
    const d = Number(decimals);
    // Cap display precision at 8 — hindari float noise dari token 18-desimal
    const displayD = Math.min(d, 8);
    const s = (Number(bigint) / Math.pow(10, d)).toFixed(displayD);
    // Hanya strip trailing zeros SETELAH titik desimal (jangan strip dari integer)
    if (!s.includes('.')) return s || '0';
    return s.replace(/\.?0+$/, '') || '0';
    }

    /**
    * Konversi amount (float) ke unit terkecil token, cap di 8 desimal untuk menghindari float error.
    */
    function parseTokenAmount(ethers, amount, decimals) {
    const d = Math.min(Number(decimals), 8);
    return ethers.parseUnits(amount.toFixed(d), decimals);
    }

    /**
    * Multisend ERC-20 (USDC atau token sembarang).
    * Selalu approve dulu sebelum multisend.
    */
    async function multisendToken({ amount, recipients, tokenAddress, decimals: forcedDecimals }) {
    const { ethers, provider, wallet } = loadWallet();
    const coder = ethers.AbiCoder.defaultAbiCoder();

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);

    // Ambil decimals dan symbol secara paralel
    const [decimals, symbol] = await Promise.all([
      forcedDecimals != null
        ? Promise.resolve(forcedDecimals)
        : tokenContract.decimals().then(Number).catch(() => 18), // fallback 18 jika contract non-standard
      tokenContract.symbol().catch(() => tokenAddress.slice(0, 6) + '...' + tokenAddress.slice(-4)),
    ]);

    const amountPerAddr = parseTokenAmount(ethers, amount, decimals);
    const totalAmount   = amountPerAddr * BigInt(recipients.length);

    // Validasi saldo
    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance < totalAmount) {
      throw new Error(
        `Saldo ${symbol} tidak cukup.\nPunya: **${fmtAmount(balance, decimals)} ${symbol}** | Dibutuhkan: **${fmtAmount(totalAmount, decimals)} ${symbol}** (${amount} × ${recipients.length} wallet)`
      );
    }

    // Step 1: Approve MaxUint256 (selalu, tanpa conditional, paling reliable)
    console.log(`[multisend] Approving ${symbol} (MaxUint256) untuk contract ${MULTISEND_CONTRACT}...`);
    const approveTx = await tokenContract.approve(MULTISEND_CONTRACT, MAX_U256, { gasLimit: 60000n });
    console.log(`[multisend] Approve TX: ${approveTx.hash}`);
    await approveTx.wait(1);
    console.log('[multisend] Approve confirmed.');

    // Step 2: Encode calldata multisend token
    const encoded = coder.encode(
      ['address', 'address[]', 'uint256'],
      [tokenAddress, recipients, amountPerAddr]
    );
    const data     = SEL_MULTISEND_TOKEN + encoded.slice(2);
    const gasLimit = BigInt(100000 + recipients.length * 33000); // ~33k/wallet (benchmark OKX 200 wallet)

    const tx      = await wallet.sendTransaction({ to: MULTISEND_CONTRACT, data, gasLimit });
    console.log(`[multisend] ${symbol} multisend TX: ${tx.hash}`);
    const receipt = await tx.wait(1);
    console.log(`[multisend] Confirmed block #${receipt.blockNumber}`);

    return {
      token          : symbol,
      tokenAddress,
      amountPerWallet: fmtAmount(amountPerAddr, decimals),
      totalAmount    : fmtAmount(totalAmount, decimals),
      recipients,
      from           : wallet.address,
      txHash         : receipt.hash,
      txUrl          : `https://basescan.org/tx/${receipt.hash}`,
      blockNumber    : receipt.blockNumber,
    };
    }

    /**
    * Multisend ETH native via contract payable.
    */
    async function multisendEth({ amount, recipients }) {
    const { ethers, provider, wallet } = loadWallet();
    const coder = ethers.AbiCoder.defaultAbiCoder();

    const amountPerAddr = ethers.parseEther(String(amount));
    const totalAmount   = amountPerAddr * BigInt(recipients.length);

    // Validasi saldo ETH
    const balance  = await provider.getBalance(wallet.address);
    const feeData  = await provider.getFeeData();
    const gasPrice = feeData.gasPrice || feeData.maxFeePerGas;
    const gasLimit = BigInt(60000 + recipients.length * 22000);
    const gasCost  = gasPrice * gasLimit;

    if (balance < totalAmount + gasCost) {
      const have = parseFloat(ethers.formatEther(balance)).toFixed(6);
      const need = parseFloat(ethers.formatEther(totalAmount)).toFixed(6);
      throw new Error(
        `Saldo ETH tidak cukup.\nPunya: **${have} ETH** | Dibutuhkan: **${need} ETH** + gas (${amount} × ${recipients.length} wallet)`
      );
    }

    const encoded = coder.encode(['address[]', 'uint256'], [recipients, amountPerAddr]);
    const data    = SEL_MULTISEND_ETH + encoded.slice(2);

    const tx      = await wallet.sendTransaction({ to: MULTISEND_CONTRACT, data, value: totalAmount, gasLimit });
    console.log(`[multisend] ETH multisend TX: ${tx.hash}`);
    const receipt = await tx.wait(1);

    return {
      token          : 'ETH',
      tokenAddress   : null,
      amountPerWallet: String(amount),
      totalAmount    : parseFloat(ethers.formatEther(totalAmount)).toFixed(6).replace(/\.?0+$/, ''),
      recipients,
      from           : wallet.address,
      txHash         : receipt.hash,
      txUrl          : `https://basescan.org/tx/${receipt.hash}`,
      blockNumber    : receipt.blockNumber,
    };
    }

    /**
    * Entry point.
    */
    async function executeMultisend({ amount, token, recipients }) {
    if (token === 'usdc') {
      return await multisendToken({ amount, recipients, tokenAddress: USDC_BASE, decimals: 6 });
    }
    if (token === 'eth') {
      return await multisendEth({ amount, recipients });
    }
    if (/^0x[a-fA-F0-9]{40}$/i.test(token)) {
      // Token custom — auto-detect decimals & symbol dari contract
      // Validasi: pastikan ada bytecode di address (bukan EOA)
      const { provider } = loadWallet();
      const code = await provider.getCode(token);
      if (code === '0x' || code === '') {
        throw new Error(`Alamat "${token.slice(0,6)}...${token.slice(-4)}" bukan kontrak token — tidak ada bytecode.`);
      }
      return await multisendToken({ amount, recipients, tokenAddress: token, decimals: null });
    }
    throw new Error(`Token "${token}" tidak didukung. Gunakan: usdc, eth, atau alamat kontrak (0x...)`);
    }

    module.exports = { parseMultisendCommand, executeMultisend };
    