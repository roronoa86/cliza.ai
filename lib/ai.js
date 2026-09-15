// lib/ai.js
// Otak AI dipakai bersama oleh webhook (api/index.js) dan bot gateway (bot.js).
// MENDUKUNG BANYAK PROVIDER AI (Groq, Gemini, OpenAI) dengan AUTO-FALLBACK:
//   - Tiap provider punya daftar API key & model sendiri, dirotasi (kalau satu kena limit, coba key/model lain).
//   - Urutan: Groq key0→semua model→key1→semua model→...→Gemini→OpenAI.
//   - Setiap request baru SELALU mulai dari Groq key0 model pertama.
// Generate gambar tetap KHUSUS Gemini (Groq tidak punya model image generation).

const axios = require('axios');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Shared utilities (stripThinkTags, parseList) — single source of truth di lib/utils.js
const { stripThinkTags, parseList: parseEnvList } = require('./utils');

// === GEMINI ===
// Model sepenuhnya dari env — set GEMINI_MODELS=model1,model2 di Railway
const RETRYABLE_STATUS = [429, 500, 503];
const TEXT_MODELS  = parseEnvList(process.env.GEMINI_MODELS,       []);
const IMAGE_MODELS = parseEnvList(process.env.GEMINI_IMAGE_MODELS,  []);
const GEMINI_KEYS  = parseEnvList(process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY, []);

// === GROQ ===
// Model sepenuhnya dari env — set GROQ_MODELS=model1,model2 di Railway
const GROQ_MODELS = parseEnvList(process.env.GROQ_MODELS, []);
const GROQ_KEYS   = parseEnvList(process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY, []);

// === OPENAI ===
// Model sepenuhnya dari env — set OPENAI_MODELS=model1,model2 di Railway
const OPENAI_MODELS = parseEnvList(process.env.OPENAI_MODELS, []);
const OPENAI_KEYS   = parseEnvList(process.env.OPENAI_API_KEYS || process.env.OPENAI_API_KEY, []);

// === CONDUIT ===
// Conduit adalah OpenAI-compatible API gateway (satu key, semua model: Claude, GPT, Gemini, Grok, dll).
// Set CONDUIT_API_KEY dan CONDUIT_MODELS=model1,model2 di Railway
const CONDUIT_MODELS = parseEnvList(process.env.CONDUIT_MODELS, []);
const CONDUIT_KEYS   = parseEnvList(process.env.CONDUIT_API_KEYS || process.env.CONDUIT_API_KEY, []);

// === IAMHC ===
// IAMHC adalah OpenAI-compatible API gateway di https://api.iamhc.cn/
// Set IAMHC_API_KEY dan IAMHC_MODELS=model1,model2 di Railway
const IAMHC_KEYS   = parseEnvList(process.env.IAMHC_API_KEYS || process.env.IAMHC_API_KEY, []);
const IAMHC_MODELS = parseEnvList(process.env.IAMHC_MODELS, []);

const PROVIDER_ORDER=parseEnvList(process.env.AI_PROVIDER_ORDER,['conduit','groq','gemini','openai','iamhc']);

// Runtime override — diubah via !provider Discord. null = pakai PROVIDER_ORDER dari env.
let _runtimeProviderOrder = null;
function setProviderOrder(order) {
  _runtimeProviderOrder = Array.isArray(order) && order.length ? [...order] : null;
  console.log('[ai] runtime provider order →', (_runtimeProviderOrder || PROVIDER_ORDER).join(' → '));
}

  // ── Startup validation: peringatkan jika tidak ada provider yang siap ─────
  (function checkProviders() {
    const configured = [];
if (GROQ_KEYS.length && GROQ_MODELS.length) configured.push('groq');
    if (GEMINI_KEYS.length && TEXT_MODELS.length) configured.push('gemini');
    if (OPENAI_KEYS.length && OPENAI_MODELS.length) configured.push('openai');
    if (CONDUIT_KEYS.length && CONDUIT_MODELS.length) configured.push('conduit');
      if (IAMHC_KEYS.length && IAMHC_MODELS.length) configured.push('iamhc');

    if (configured.length === 0) {
      console.warn('[ai] ⚠️  PERINGATAN: Tidak ada provider AI yang terkonfigurasi!');
      console.warn('[ai]    Set minimal salah satu pasangan env berikut di Railway:');
      console.warn('[ai]    • GROQ_API_KEY + GROQ_MODELS');
      console.warn('[ai]    • GEMINI_API_KEY + GEMINI_MODELS');
      console.warn('[ai]    • OPENAI_API_KEY + OPENAI_MODELS');
      console.warn('[ai]    • CONDUIT_API_KEY + CONDUIT_MODELS');
        console.warn('[ai]    • IAMHC_API_KEY + IAMHC_MODELS');
    console.warn('[ai]    Bot akan gagal merespons semua pesan AI sampai ini diset.');
    } else {
      console.log('[ai] ✅ Provider siap:', configured.join(', '));
      console.log('[ai]    Urutan fallback:', PROVIDER_ORDER.filter(p => configured.includes(p)).join(' → '));
    }
  })();

  const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';
const COINGECKO_API_KEY  = process.env.COINGECKO_API_KEY  || '';
const CRYPTORANK_API_KEY = process.env.CRYPTORANK_API_KEY || '';
const ALCHEMY_BASE_RPC   = process.env.ALCHEMY_BASE_RPC   || '';
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || '';
const POLYGONSCAN_API_KEY = process.env.POLYGONSCAN_API_KEY || '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';
// [FIX] Token TERPISAH untuk fitur tulis (commit) ke GitHub — GITHUB_TOKEN dipakai
// data_store.js untuk sync Gist (persist data bot). Supaya fitur auto-edit/commit
// (berisiko lebih tinggi, ditulis oleh AI) tidak pakai token yang sama dengan Gist,
// pakai akun/token terpisah GITHUB_WRITE_TOKEN. Fallback ke GITHUB_TOKEN jika belum di-set.
const GITHUB_WRITE_TOKEN = process.env.GITHUB_WRITE_TOKEN || ''; // Khusus repo creation — set di Railway, tidak fallback ke bot token

const CHAIN_EXPLORERS = {
  eth: { base: 'https://api.etherscan.io/api', key: ETHERSCAN_API_KEY, name: 'Ethereum' },
  bsc: { base: 'https://api.bscscan.com/api', key: BSCSCAN_API_KEY, name: 'BNB Chain' },
  polygon: { base: 'https://api.polygonscan.com/api', key: POLYGONSCAN_API_KEY, name: 'Polygon' },
};

const COINGECKO_ID_MAP = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  bnb: 'binancecoin',
  sol: 'solana', solana: 'solana',
  xrp: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  ton: 'the-open-network',
  trx: 'tron', tron: 'tron',
  matic: 'matic-network', polygon: 'matic-network',
  dot: 'polkadot', polkadot: 'polkadot',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  shib: 'shiba-inu',
  link: 'chainlink', chainlink: 'chainlink',
  pepe: 'pepe',
  sui: 'sui',
  arb: 'arbitrum', arbitrum: 'arbitrum',
  op: 'optimism', optimism: 'optimism',
  usdt: 'tether', usdc: 'usd-coin',
  // Tambahan
  floki: 'floki', wif: 'dogwifcoin', bonk: 'bonk',
  near: 'near', apt: 'aptos', inj: 'injective-protocol',
  sei: 'sei-network', tia: 'celestia', jup: 'jupiter-exchange-solana',
};

// ============================================================
// SYSTEM PROMPTS
// ============================================================

const SYSTEM_PROMPT_BASE = [
  // ⚠️ FORMAT DISCORD — WAJIB DIPATUHI
  '⚠️ ATURAN FORMAT DISCORD — WAJIB DIPATUHI TANPA PENGECUALIAN: (1) DILARANG KERAS menggunakan karakter pipe | di mana pun — baik tabel markdown maupun pemisah teks. Discord tidak merender tabel, hasilnya hanya baris | yang berantakan. (2) DILARANG menggunakan tag HTML seperti <br> atau <b>. (3) DILARANG menggunakan heading besar (###, ####). Gunakan maksimal ## untuk judul utama atau ** bold**. (4) Untuk perbandingan beberapa entitas, WAJIB format ini:\n\n  Opsi A — bullet grouping:\n  • **Binance**\n    Target pasar: Global, trader aktif\n    Likuiditas: tertinggi di dunia\n  • **Bitfinex**\n    Target pasar: Trader profesional\n\n  Opsi B — header per entitas:\n  **# Binance**\n  • Target pasar: Global, trader aktif\n  • Likuiditas: tertinggi di dunia\n  **# Bitfinex**\n  • Target pasar: Trader profesional\n\n  JANGAN gabungkan semua info dalam satu baris atau pakai | sebagai pemisah.',

  'Kamu adalah **Web3 & Crypto AI Agent** — spesialis blockchain, DeFi, on-chain analytics, dan crypto trading. Kamu memiliki akses REAL-TIME ke data harga (CoinGecko, Binance, DexScreener), on-chain data (Alchemy Base, Etherscan, GMGN), wallet portfolio (Zerion), token security analysis, smart money tracking, dan market sentiment. WAJIB gunakan tools yang tersedia untuk setiap pertanyaan crypto/web3 — JANGAN jawab dari memori jika ada tool yang relevan.',
  'Kamu adalah AI super cerdas dan serba bisa di server Discord, selevel asisten AI coding/teknis kelas atas (setara Claude).',
  'Kalau ada data tambahan yang disisipkan di prompt dengan label [DATA REAL-TIME], anggap itu sumber paling akurat dan utamakan dibanding hasil tebakan.',
  'Jawab dengan jelas, akurat, dan to-the-point dalam Bahasa Indonesia (kecuali user minta bahasa lain).',
  'Selalu utamakan kebenaran faktual berdasarkan data yang benar-benar tersedia, bukan tebakan.',

  // Coding
  'Kamu menguasai coding di level senior/principal engineer: JavaScript/TypeScript, Node.js, Python, Go, Rust, Java, C/C++, PHP, Solidity, SQL, Bash, dan framework populer (React, Next.js, Vue, Express, NestJS, Django, FastAPI, dll).',
  'Saat menulis atau review kode: gunakan best practice, perhatikan edge case, error handling, keamanan (hindari SQL injection, XSS, command injection, hardcoded secret), dan performa.',
  'Kalau diminta debug, baca error/stack trace dengan teliti, jelaskan ROOT CAUSE-nya (bukan cuma tempelan/patch), lalu beri solusi konkret dengan kode yang bisa langsung dipakai.',
  'Kalau kode panjang, gunakan code block dengan bahasa yang sesuai (```js, ```python, dst).',
  'Kalau user minta arsitektur/desain sistem, pertimbangkan skalabilitas, biaya, dan trade-off.',
  'Kalau user meminta melihat file github, kamu harus langsung membaca github bukan cuma pakai google search.',

  // Crypto
  'Kamu paham mendalam soal crypto & trading: analisis fundamental, teknikal (support/resistance, RSI, MACD, EMA/SMA, volume, funding rate, open interest), tokenomics, on-chain metrics, dan manajemen risiko.',
  'Kamu paham blockchain: PoW/PoS, Layer 1 vs Layer 2, EVM vs non-EVM, gas fee, mempool, bridge, DeFi, NFT.',
  'Kamu paham smart contract: Solidity, standar token (ERC-20/721/1155), dan celah keamanan (reentrancy, overflow, access control, flash loan, front-running).',
  'SELALU beri disclaimer singkat (NFA) di akhir kalau memberi opini investasi/trading — tapi tetap jawab konkret duluan, jangan jadikan alasan menolak.',

  // Web
  'Kamu paham web modern: HTML/CSS, REST/GraphQL, JWT/OAuth, CORS/CSRF/HTTPS, deployment (Vercel, Docker, VPS, Nginx).',

  // [FIX BARU] Larangan tegas anti-hallusinasi
  'PENTING: JANGAN PERNAH memberikan link GitHub palsu seperti https://github.com/your-repo atau placeholder seperti "your-repo", "your-project". SELALU tulis kode nyata di dalam code block.',
  'JANGAN PERNAH mengatakan kamu tidak bisa mengirim file atau tidak bisa memberikan kode lengkap — selalu tulis kode LENGKAP langsung di dalam code block.',
  'Jika kode terlalu panjang untuk satu respons, beri tahu user untuk meminta bagian tertentu — JANGAN potong kode di tengah tanpa penjelasan.',

  // Cara menjawab
  'Kalau pertanyaan ambigu, buat asumsi paling wajar, sebutkan singkat asumsinya, lalu tetap jawab lengkap.',

  // Panjang jawaban Discord
  'PANJANG JAWABAN: Sesuaikan panjang dengan kompleksitas pertanyaan. Pertanyaan singkat/biasa: jawab ringkas 1-2 pesan Discord (maks ~3900 karakter). Analisis kode, audit, debug mendalam, atau pertanyaan kompleks: boleh panjang hingga 7800 karakter (4 pesan). JANGAN menulis ulang pertanyaan, jangan basa-basi, jangan repetisi. Langsung ke inti — jangan potong analisis yang belum selesai.',
].join(' ');

// System prompt KHUSUS mode DM owner — pair programmer pribadi, analisis mendalam, paham semua file & konteks.
const SYSTEM_PROMPT_DM_CODING = `

[MODE PRIVATE: PAIR PROGRAMMER PRIBADI OWNER]

Kamu sedang dalam sesi private dengan owner bot ini. Ikuti aturan berikut dengan KETAT:

CARA BERPIKIR SEBELUM MENJAWAB:
Sebelum menulis jawaban apapun, lakukan analisis internal penuh:
1. Baca pertanyaan/kode dengan sangat teliti dari awal sampai akhir — jangan skip.
2. Identifikasi SEMUA aspek: bug yang jelas, bug tersembunyi, anti-pattern, security hole, memory leak, race condition, performa, edge case.
3. Susun jawaban yang paling benar dan lengkap di kepala terlebih dahulu.
4. Verifikasi logika/kode yang akan kamu berikan — apakah benar-benar bisa dijalankan? Apakah ada yang terlewat?
5. Baru tulis jawaban final. Jangan keluarkan "chain of thought" — hanya hasil akhir yang rapi.

ANALISIS FILE DAN KODE:
- Baca SELURUH file/kode yang dikirim sebelum menjawab, jangan hanya lihat sebagian.
- Temukan semua masalah: bug kritis, potensi masalah, anti-pattern, technical debt — urutkan dari yang paling berbahaya.
- Jelaskan ROOT CAUSE setiap masalah (bukan hanya gejala), tunjukkan baris yang bermasalah.
- Kalau ada masalah di luar yang ditanyakan, sebutkan juga di bagian "Catatan Tambahan".

MENULIS KODE:
- Tulis implementasi LENGKAP yang benar-benar bisa langsung dijalankan — BUKAN skeleton, BUKAN placeholder, BUKAN "TODO: implement".
- Sertakan semua import, error handling yang proper, validasi input, dan komentar pada logika non-obvious.
- Kalau ada beberapa pendekatan, bandingkan trade-off-nya sebelum merekomendasikan yang terbaik.
- Kode yang kamu hasilkan harus bisa langsung di-copy-paste dan berjalan tanpa modifikasi tambahan.
- JANGAN PERNAH potong kode dengan "// ... sisanya sama" atau "// rest of the code" — SELALU tulis lengkap.

FORMAT BALASAN FILE:
- Kalau owner mengirim file (misal index.js, app.py, style.css, data.json), SELALU balas dengan file dengan tipe/ekstensi yang SAMA.
- Contoh: owner kirim bot.js → balas dengan file .js. Owner kirim app.py → balas file .py. Owner kirim index.html → balas file .html.
- Gunakan nama file yang sama dengan yang dikirim owner jika memungkinkan.
- Jangan pecah satu file menjadi banyak file kecuali owner meminta.
- Jika file sangat besar (> 500 baris), berikan kode lengkap tetap dalam satu code block — jangan dipotong.

KONTEKS PERCAKAPAN (SANGAT PENTING):
- WAJIB ingat dan manfaatkan seluruh riwayat percakapan di sesi ini — ini adalah sesi pair programming berkelanjutan.
- Kalau owner menyebut "itu", "ini", "tadi", "fungsi itu", "file itu", "yang kita bahas sebelumnya" — SELALU rujuk ke konteks yang tepat tanpa meminta klarifikasi.
- Kalau owner melanjutkan kode dari pesan sebelumnya, pahami sebagai kelanjutan, bukan pertanyaan baru.
- Kalau owner pernah menyebut stack, bahasa, framework, atau arsitektur tertentu — gunakan sebagai konteks default.
- Konteks ini tetap berlaku meskipun provider AI berganti (Groq → Gemini → OpenAI) — riwayat percakapan selalu dikirim ulang ke provider manapun.

PROAKTIF:
- Kalau melihat masalah di luar yang ditanyakan, sebutkan di bagian "⚠️ Perhatian Tambahan".
- Kalau owner minta sesuatu yang berpotensi bug, kerjakan dulu baru tambahkan catatan risikonya.
- Sarankan improvement kalau ada cara yang jauh lebih baik, efisien, atau aman.

ANTI-HALLUSINASI (WAJIB DIPATUHI):
- DILARANG KERAS memberikan link GitHub palsu seperti https://github.com/your-repo/your-project atau placeholder apapun.
- DILARANG mengatakan "karena keterbatasan platform, saya tidak bisa mengirim file" — kamu BISA dan HARUS mengirim kode lengkap dalam code block.
- Jika kode yang diminta sangat panjang dan tidak muat dalam satu respons, bagi menjadi beberapa bagian dan beri tahu owner: "Ini bagian 1/3, ketik 'lanjut' untuk bagian berikutnya."

ATURAN EDIT FILE (TOOLS) — WAJIB DIPATUHI:
- SELALU baca file terlebih dahulu (readFile untuk sandbox, readGitHubRepo/readGitHubFileLines untuk GitHub) SEBELUM menulis atau mengedit file apapun.
- Untuk perubahan kecil/parsial pada file yang sudah ada: WAJIB gunakan editFile (sandbox) atau editGitHubFile (GitHub) — bukan overwrite penuh. Ini mencegah kerusakan kode yang tidak diubah.
- Untuk file baru atau memang perlu overwrite total: gunakan writeFile / writeGitHubFile.
- Setelah setiap operasi tulis: verifikasi hasilnya dengan readFile / readGitHubFileLines.
- JANGAN pernah menebak isi file — selalu baca dulu, baru edit.

PLANNING WAJIB untuk task kompleks:
- Sebelum mengerjakan task yang menyentuh lebih dari 2 file, refaktor besar, atau perubahan arsitektur:
  1. Tulis rencana singkat: file apa yang diubah, urutan langkah, potensi risiko
  2. Format: "Rencana: (1) baca X untuk cek struktur, (2) edit fungsi Y di file Z, (3) verifikasi dengan test/run"
  3. Baru eksekusi step by step sesuai rencana
- Untuk task sederhana (1 file, 1 fungsi): langsung kerjakan tanpa perlu tulis rencana.

VERIFIKASI SETELAH MENULIS KODE:
- Setelah writeFile/editFile untuk file JS/TS: panggil executeCode({ language: 'bash', code: 'node --check namafile.js' }) untuk cek sintaks.
- Setelah writeFile/editFile untuk file Python: panggil executeCode({ language: 'bash', code: 'python3 -m py_compile namafile.py' }) untuk cek sintaks.
- Jangan anggap kode sudah benar sebelum ada konfirmasi dari executeCode.`;

const SYSTEM_PROMPT_SEARCH_ADDENDUM = [
  'Kamu PUNYA akses internet lewat Google Search. JANGAN PERNAH bilang kamu tidak punya data real-time.',
  'Kalau pertanyaan butuh info terkini, cari secara AGRESIF dan jawab dengan ANGKA/FAKTA konkret beserta waktunya.',
].join(' ');

const SYSTEM_PROMPT_NOSEARCH_ADDENDUM = [
  'Kamu TIDAK punya akses browsing/internet langsung saat ini.',
  'Kalau ada blok [DATA REAL-TIME] di prompt, itu data API yang sudah diambil sebelumnya — gunakan sebagai fakta terkini.',
  'Kalau pertanyaan butuh info terkini yang tidak ada di [DATA REAL-TIME], katakan jujur kamu tidak punya akses realtime.',
].join(' ');

const SYSTEM_PROMPT = `${SYSTEM_PROMPT_BASE} ${SYSTEM_PROMPT_SEARCH_ADDENDUM}`;

// Ekspor agar agent.js bisa pakai pair-programmer prompt saat DM owner
const SYSTEM_PROMPT_DM = `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_DM_CODING}`;

// ============================================================
// VALIDASI HISTORY UNTUK GEMINI
// Gemini API MENGHARUSKAN contents bergantian antara 'user' dan 'model'.
// Dua role sama berturut-turut akan digabung. Diawali 'model' akan dibuang dari depan.
// ============================================================
function sanitizeHistoryForGemini(history) {
  if (!history || history.length === 0) return [];

  const sanitized = [];
  for (const entry of history) {
    if (!entry || !entry.role || !entry.content) continue;
    const geminiRole = entry.role === 'assistant' ? 'model' : 'user';

    if (sanitized.length === 0) {
      // Role tetap pakai konvensi internal (user/assistant) — dikonversi ke model/user saat build Gemini request
      sanitized.push({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.content });
      continue;
    }

    const last = sanitized[sanitized.length - 1];
    const lastGeminiRole = last.role === 'assistant' ? 'model' : 'user';

    if (geminiRole === lastGeminiRole) {
      sanitized[sanitized.length - 1] = {
        role: last.role,
        content: last.content + '\n\n' + entry.content,
      };
    } else {
      sanitized.push({ role: entry.role, content: entry.content });
    }
  }

  while (sanitized.length > 0 && sanitized[0].role === 'assistant') {
    sanitized.shift();
  }

  return sanitized;
}

// ============================================================
// TOKEN ESTIMATOR & HISTORY TRUNCATOR
// Groq free tier: ~6.000 token per request (termasuk system prompt + history + pertanyaan).
// Gemini free tier: ~30.000 token per request (jauh lebih besar).
// Estimasi kasar: 1 token ≈ 4 karakter (cukup akurat untuk bahasa Indonesia/Inggris campuran).
// ============================================================

// Batas token aman per provider (lebih kecil dari batas resmi supaya ada margin).
const PROVIDER_TOKEN_LIMITS = {
  groq:   5000,   // Groq free tier: ~6000, kita pakai 5000 buat aman
  gemini: 28000,  // Gemini free tier: ~30000
  openai:  14000,
  conduit: 14000, // Conduit — sama seperti OpenAI (tergantung model yang dipilih)
    iamhc:   14000, // IAMHC — OpenAI-compatible gateway (tergantung model yang dipilih)
};

// [FIX #8] Divisor 3.5 lebih konservatif untuk teks Indonesia + kode sumber
// (kode lebih padat: ~2-3 char/token; Indonesia ~4-5 char/token → rata-rata ~3.5)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

// [FIX] Kondensasi ekstraktif — dipakai saat pasangan lama dibuang dari history supaya
// intinya tidak hilang total (dibanding cuma di-drop mentah). Bukan ringkasan AI (tidak
// ada call API tambahan, jadi tidak nambah biaya/latensi) — cuma cuplikan awal tiap pesan.
function _condenseDroppedPairs(pairs) {
  if (!pairs.length) return null;
  const lines = pairs.map((h) => {
    const role = h.role === 'assistant' ? 'AI' : 'User';
    const snippet = (h.content || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    return `${role}: ${snippet}${(h.content || '').length > 150 ? '…' : ''}`;
  });
  return {
    role: 'user',
    content: `[Ringkasan ${pairs.length} pasang percakapan lama yang dipangkas agar muat batas token]\n${lines.join('\n')}`,
  };
}

// Potong history dari yang paling lama agar total token request tidak melebihi batas.
// Selalu hapus sepasang (user+assistant) sekaligus agar urutan tetap valid.
// Pasangan yang dibuang dikondensasi jadi satu baris ringkas (bukan hilang total).
// Mengembalikan history yang sudah dipangkas + jumlah pasangan yang dibuang.
function truncateHistoryToFit(history, systemText, questionText, maxTokens) {
  const systemTokens = estimateTokens(systemText);
  const questionTokens = estimateTokens(questionText);
  const overhead = systemTokens + questionTokens + 200; // 200 = buffer untuk metadata JSON

  if (overhead >= maxTokens) {
    // Bahkan tanpa history pun sudah terlalu besar — tidak bisa truncate lebih jauh
    return { history: [], dropped: Math.floor(history.length / 2) };
  }

  let truncated = [...history];
  let dropped = 0;
  const droppedPairs = [];

  while (truncated.length > 0) {
    const historyTokens = truncated.reduce((sum, h) => sum + estimateTokens(h.content), 0);
    if (overhead + historyTokens <= maxTokens) break;
    // Buang 1 pasang (user + assistant) paling lama
    droppedPairs.push(...truncated.slice(0, 2));
    truncated = truncated.slice(2);
    dropped++;
  }

  if (droppedPairs.length) {
    const recap = _condenseDroppedPairs(droppedPairs);
    const recapTokens = estimateTokens(recap.content);
    // Sisipkan ringkasan hanya jika masih muat di budget token yang tersisa.
    if (overhead + recapTokens + truncated.reduce((s, h) => s + estimateTokens(h.content), 0) <= maxTokens) {
      truncated = [recap, ...truncated];
    }
  }

  return { history: truncated, dropped };
}

// ============================================================
// REGISTRY PROVIDER
// [FIX] Tambah max_tokens di Groq & OpenAI agar respons tidak truncate di tengah kode.
// [FIX] Tambah auto-truncate history sebelum build request.
// ============================================================
const PROVIDERS = {
  groq: {
    keys: GROQ_KEYS,
    models: GROQ_MODELS,
    supportsSearch: false,
    tokenLimit: PROVIDER_TOKEN_LIMITS.groq,
    buildRequest(model, key, { question, history = [], isDMOwner = false, systemOverride = null }) {
      const systemContent = systemOverride || `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_DM_CODING}\n\n${SYSTEM_PROMPT_NOSEARCH_ADDENDUM}`;

      const { history: safeHistory, dropped } = truncateHistoryToFit(
        history, systemContent, question, PROVIDER_TOKEN_LIMITS.groq
      );
      if (dropped > 0) {
        console.log(`[groq] ⚠️ History dipotong ${dropped} pasang agar muat dalam batas token (${PROVIDER_TOKEN_LIMITS.groq} token).`);
      }

      const historyMessages = safeHistory.map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      }));

      return {
        url: 'https://api.groq.com/openai/v1/chat/completions',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: {
          model,
          max_tokens: 8192,
          messages: [
            { role: 'system', content: systemContent },
            ...historyMessages,
            { role: 'user', content: question },
          ],
        },
      };
    },
    parseResponse(data) {
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        console.warn('[groq] ⚠️ Respons terpotong karena max_tokens. Pertimbangkan memecah file menjadi lebih kecil.');
      }
      const text = stripThinkTags(choice?.message?.content) || 'Tidak ada jawaban.';
      return { text, sources: [] };
    },
  },

  gemini: {
    keys: GEMINI_KEYS,
    models: TEXT_MODELS,
    supportsSearch: true,
    tokenLimit: PROVIDER_TOKEN_LIMITS.gemini,
    buildRequest(model, key, { question, history = [], isDMOwner = false, systemOverride = null }) {
      const systemContent = systemOverride || `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_DM_CODING}\n\n${SYSTEM_PROMPT_SEARCH_ADDENDUM}`;

      const { history: safeHistory, dropped } = truncateHistoryToFit(
        history, systemContent, question, PROVIDER_TOKEN_LIMITS.gemini
      );
      if (dropped > 0) {
        console.log(`[gemini] ⚠️ History dipotong ${dropped} pasang agar muat dalam batas token.`);
      }

      const cleanHistory = sanitizeHistoryForGemini(safeHistory);
      const historyContents = cleanHistory.map((h) => ({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }],
      }));

      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
        headers: {},
        body: {
          contents: [
            ...historyContents,
            { role: 'user', parts: [{ text: question }] },
          ],
          systemInstruction: { parts: [{ text: systemContent }] },
          // systemOverride berarti mode skill khusus — nonaktifkan google_search agar AI
          // mengikuti instruksi skill tanpa mencoba browsing sendiri
          tools: systemOverride ? undefined : [{ google_search: {} }],
          generationConfig: {
            maxOutputTokens: 8192,
            thinkingConfig: { thinkingBudget: 0 },
          },
        },
      };
    },
    parseResponse(data) {
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason === 'MAX_TOKENS') {
        console.warn('[gemini] ⚠️ Respons terpotong karena MAX_TOKENS. Pertimbangkan memecah file menjadi lebih kecil.');
      }
      const text = candidate?.content?.parts?.filter(p => !p.thought).map((p) => p.text).filter(Boolean).join('') || 'Tidak ada jawaban.';
      const chunks = candidate?.groundingMetadata?.groundingChunks || [];
      const sources = chunks.map((c) => c.web).filter(Boolean).map((w) => ({ title: w.title || w.uri, uri: w.uri }));
      return { text, sources };
    },
  },

  openai: {
    keys: OPENAI_KEYS,
    models: OPENAI_MODELS,
    supportsSearch: false,
    tokenLimit: PROVIDER_TOKEN_LIMITS.openai,
    buildRequest(model, key, { question, history = [], isDMOwner = false, systemOverride = null }) {
      const systemContent = systemOverride || `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_DM_CODING}\n\n${SYSTEM_PROMPT_NOSEARCH_ADDENDUM}`;

      const { history: safeHistory, dropped } = truncateHistoryToFit(
        history, systemContent, question, PROVIDER_TOKEN_LIMITS.openai
      );
      if (dropped > 0) {
        console.log(`[openai] ⚠️ History dipotong ${dropped} pasang agar muat dalam batas token.`);
      }

      const historyMessages = safeHistory.map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      }));

      return {
        url: 'https://api.openai.com/v1/chat/completions',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: {
          model,
          max_tokens: 8192,
          messages: [
            { role: 'system', content: systemContent },
            ...historyMessages,
            { role: 'user', content: question },
          ],
        },
      };
    },
    parseResponse(data) {
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        console.warn('[openai] ⚠️ Respons terpotong karena max_tokens. Pertimbangkan memecah file menjadi lebih kecil.');
      }
      return{text:stripThinkTags(choice?.message?.content)||'Tidak ada jawaban.',sources:[]};
    },
  },

  // === CONDUIT ===
  // OpenAI-compatible API gateway — satu key, akses ke Claude, GPT, Gemini, Grok, dll.
  // Endpoint: https://api.conduit.ozdoev.net/v1/chat/completions
  conduit: {
    keys: CONDUIT_KEYS,
    models: CONDUIT_MODELS,
    supportsSearch: false,
    tokenLimit: PROVIDER_TOKEN_LIMITS.conduit,
    buildRequest(model, key, { question, history = [], isDMOwner = false, systemOverride = null }) {
      const systemContent = systemOverride || `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_DM_CODING}\n\n${SYSTEM_PROMPT_NOSEARCH_ADDENDUM}`;

      const { history: safeHistory, dropped } = truncateHistoryToFit(
        history, systemContent, question, PROVIDER_TOKEN_LIMITS.conduit
      );
      if (dropped > 0) {
        console.log(`[conduit] ⚠️ History dipotong ${dropped} pasang agar muat dalam batas token.`);
      }

      const historyMessages = safeHistory.map((h) => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      }));

      return {
        url: 'https://api.conduit.ozdoev.net/v1/chat/completions',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: {
          model,
          max_tokens: 8192,
          messages: [
            { role: 'system', content: systemContent },
            ...historyMessages,
            { role: 'user', content: question },
          ],
        },
      };
    },
    parseResponse(data) {
      const choice = data?.choices?.[0];
      if (choice?.finish_reason === 'length') {
        console.warn('[conduit] ⚠️ Respons terpotong karena max_tokens. Pertimbangkan memecah file menjadi lebih kecil.');
      }
      return { text: stripThinkTags(choice?.message?.content) || 'Tidak ada jawaban.', sources: [] };
    },
  },

    // === IAMHC ===
    // OpenAI-compatible API gateway — https://api.iamhc.cn/v1/chat/completions
    // Set IAMHC_API_KEY dan IAMHC_MODELS di Railway.
    iamhc: {
      keys: IAMHC_KEYS,
      models: IAMHC_MODELS,
      supportsSearch: false,
      tokenLimit: PROVIDER_TOKEN_LIMITS.iamhc,
      buildRequest(model, key, { question, history = [], isDMOwner = false, systemOverride = null }) {
        const systemContent = systemOverride || `${SYSTEM_PROMPT_BASE}${SYSTEM_PROMPT_DM_CODING}\n\n${SYSTEM_PROMPT_NOSEARCH_ADDENDUM}`;

        const { history: safeHistory, dropped } = truncateHistoryToFit(
          history, systemContent, question, PROVIDER_TOKEN_LIMITS.iamhc
        );
        if (dropped > 0) {
          console.log(`[iamhc] ⚠️ History dipotong ${dropped} pasang agar muat dalam batas token.`);
        }

        const historyMessages = safeHistory.map((h) => ({
          role: h.role === 'assistant' ? 'assistant' : 'user',
          content: h.content,
        }));

        return {
          url: 'https://api.iamhc.cn/v1/chat/completions',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: {
            model,
            max_tokens: 8192,
            messages: [
              { role: 'system', content: systemContent },
              ...historyMessages,
              { role: 'user', content: question },
            ],
          },
        };
      },
      parseResponse(data) {
        const choice = data?.choices?.[0];
        if (choice?.finish_reason === 'length') {
          console.warn('[iamhc] ⚠️ Respons terpotong karena max_tokens. Pertimbangkan memecah file menjadi lebih kecil.');
        }
        return { text: stripThinkTags(choice?.message?.content) || 'Tidak ada jawaban.', sources: [] };
      },
    },
    };

{
  const active = PROVIDER_ORDER.filter((id) => PROVIDERS[id]?.keys.length);
  console.log(active.length
    ? `[ai] Urutan provider aktif: ${active.join(' -> ')}`
    : '[ai] ⚠️ TIDAK ADA provider AI yang dikonfigurasi! Isi minimal salah satu: GROQ_API_KEY(S) atau GEMINI_API_KEY(S).');
  // Log per-provider: jumlah key dan daftar model (seperti userbot.js / Vtardio)
  const _LABEL={groq:'Groq  ',gemini:'Gemini',openai:'OpenAI',conduit:'Conduit'};
  for(const _id of['conduit','groq','gemini','openai']){
    const _p = PROVIDERS[_id];
    if (!_p) continue;
    const _modelList = _p.models.length ? _p.models.join(', ') : '(tidak ada model dikonfigurasi)';
    console.log(`[ai] ${_LABEL[_id]}: ${_p.keys.length} key | Models: ${_modelList}`);
  }
}

// [FIX #1] blockedModels pakai TTL Map — tidak lagi permanent block selamanya.
// Error 413/400/403 → blokir 2 jam; 404 → blokir 24 jam; meta-error → blokir 30 menit.
const BLOCKED_TTL_LONG   = 2   * 3600_000; // 2 jam  — 400/403 (format/permission — cacat model, bukan ukuran request)
const BLOCKED_TTL_SIZE   = 10  * 60_000;   // 10 mnt — 413 (context window kecil untuk REQUEST INI, bukan cacat permanen model)
const BLOCKED_TTL_PERM   = 24  * 3600_000; // 24 jam — 404 model tidak ada
const BLOCKED_TTL_META   = 30  * 60_000;   // 30 mnt — meta-error (bisa recover)
const blockedModels = new Map(); // key → expiry timestamp

function _isModelBlocked(key) {
  const exp = blockedModels.get(key);
  if (!exp) return false;
  if (Date.now() >= exp) { blockedModels.delete(key); return false; }
  return true;
}
function _blockModel(key, ttl) {
  const prev = blockedModels.get(key);
  const exp  = Date.now() + ttl;
  if (prev && prev > exp) return; // sudah lebih lama, jangan perpendek
  blockedModels.set(key, exp);
}

// ── Persistent cursor + 429 cooldown — mencegah restart dari key#0/model#0 setiap request ──
// Slot = ki * nModels + mi (key-first: habiskan semua model key0 sebelum pindah key1)
const _callCursor = { groq: 0, gemini: 0, openai: 0, conduit: 0, iamhc: 0 };
let _imgKeyCursor = 0; // cursor khusus callGemini (image generation)
const _callRL = new Map(); // "${provider}::${ki}::${model}" → expiry timestamp
const CALL_RL_MS = 65_000; // 65 detik cooldown setelah 429 (sedikit > window 1 menit API)

function _isCallRL(p, ki, m) {
  const k = `${p}::${ki}::${m}`;
  const u = _callRL.get(k);
  if (!u) return false;
  if (Date.now() >= u) { _callRL.delete(k); return false; }
  return true;
}
function _markCallRL(p, ki, m) {
  _callRL.set(`${p}::${ki}::${m}`, Date.now() + CALL_RL_MS);
  console.log(`[${p}] ⏳ key#${ki} model=${m} rate-limit ${Math.round(CALL_RL_MS/1000)}s (skip sampai cooldown habis)`);
}

// Deteksi pesan meta-error dari Claude/AI yang tidak seharusnya ditampilkan ke user
function isAIMetaError(text) {
  if (!text) return false;
  const patterns = [
    /the response did not generate correctly/i,
    /please resend the last message/i,
    /continue without resetting the session/i,
    /i was unable to generate a response/i,
    /my response was cut off/i,
  ];
  return patterns.some((p) => p.test(text));
}

async function callProviderOnce(providerId, opts, timeout) {
  const provider = PROVIDERS[providerId];
  if (!provider || provider.keys.length === 0) {
    const e = new Error(`Provider "${providerId}" tidak dikonfigurasi (API key kosong).`);
    e.response = { status: 401, data: { error: { message: e.message } } };
    throw e;
  }
  const nK = provider.keys.length;
  const nM = provider.models.length;
  if (nM === 0) {
    const e = new Error(`Provider "${providerId}" tidak punya model dikonfigurasi.`);
    e.response = { status: 503, data: { error: { message: e.message } } };
    throw e;
  }

  // Iterasi slot (key × model) mulai dari cursor terakhir — bukan selalu dari key#0.
  // Setelah 429: cursor maju ke slot berikutnya → request selanjutnya otomatis skip.
  // Setelah sukses: cursor tetap di posisi ini → request berikutnya mulai dari sini.
  const totalSlots = nK * nM;
  const startSlot = (_callCursor[providerId] || 0) % totalSlots;
  let lastErr;
  let lastKi = -1;

  for (let i = 0; i < totalSlots; i++) {
    const slot = (startSlot + i) % totalSlots;
    const ki = Math.floor(slot / nM);
    const mi = slot % nM;
    const key = provider.keys[ki];
    const model = provider.models[mi];

    if (_isModelBlocked(`${providerId}::${model}`)) continue;
    if (_isCallRL(providerId, ki, model)) continue;

    // Log perpindahan key
    if (ki !== lastKi) {
      if (lastKi !== -1) console.log(`[${providerId}] key#${lastKi} habis semua model, pindah ke key#${ki}...`);
      lastKi = ki;
    }

    const { url, headers, body } = provider.buildRequest(model, key, opts);
    try {
      const { data } = await axios.post(url, body, { headers, timeout });
      const parsed = provider.parseResponse(data);
      if (isAIMetaError(parsed.text)) {
        console.warn(`[${providerId}] ⚠️ key#${ki} model=${model} meta-error, blokir permanen...`);
        lastErr = new Error(`Meta-error dari ${providerId}/${model}: ${parsed.text.slice(0, 80)}`);
        lastErr.response = { status: 503, data: { error: { message: lastErr.message } } };
        _blockModel(`${providerId}::${model}`, BLOCKED_TTL_META);
        continue;
      }
      console.log(`[${providerId}] ✅ ok key#${ki} model=${model}`);
      // Cursor tetap di slot ini — model/key yang berhasil dipakai lagi untuk request berikutnya.
      // Cursor hanya maju jika model/key rate-limit atau error.
      _callCursor[providerId] = slot;
      return parsed;
    } catch (err) {
      lastErr = err;
      lastErr.providerId = providerId;
      lastErr.aiModel = model;
      const status = err.response?.status;
      const apiCode = err.response?.data?.error?.code || err.response?.data?.code;
      const apiMsg = err.response?.data?.error?.message || '';

      if (status === 413) {
        // Ukuran REQUEST INI yang kebesaran (history/prompt/tool result), bukan cacat
        // permanen model — blokir sebentar saja agar pertanyaan berikutnya yang lebih
        // kecil tidak ikut kehilangan akses ke model ini selama 2 jam.
        console.log(`[${providerId}] key#${ki} model=${model} 413 (context window kecil), blokir ${Math.round(BLOCKED_TTL_SIZE / 60000)} menit.`);
        _blockModel(`${providerId}::${model}`, BLOCKED_TTL_SIZE); continue;
      }
      if (status === 403 && (apiCode === 'model_permission_blocked_org' || /blocked at the organization|permission/i.test(apiMsg))) {
        console.log(`[${providerId}] key#${ki} model=${model} DIBLOKIR org-level, blokir 2 jam.`);
        _blockModel(`${providerId}::${model}`, BLOCKED_TTL_LONG); continue;
      }
      if (status === 400) {
        console.log(`[${providerId}] key#${ki} model=${model} 400 (format tidak didukung), blokir 2 jam.`);
        _blockModel(`${providerId}::${model}`, BLOCKED_TTL_LONG); continue;
      }
      if (status === 404) {
        console.log(`[${providerId}] key#${ki} model=${model} 404 (model tidak ditemukan), blokir 24 jam.`);
        _blockModel(`${providerId}::${model}`, BLOCKED_TTL_PERM); continue;
      }
      if (RETRYABLE_STATUS.includes(status)) {
        // 429/500/503: rate-limit sementara, maju cursor agar request berikutnya skip slot ini
        _markCallRL(providerId, ki, model);
        _callCursor[providerId] = (slot + 1) % totalSlots;
      } else if (!err.response || ['ECONNABORTED', 'ETIMEDOUT'].includes(err.code)) {
        console.log(`[${providerId}] key#${ki} model=${model} timeout/network, coba model berikutnya...`);
      } else {
        console.log(`[${providerId}] key#${ki} model=${model} status ${status} (${apiCode || ''}), coba model berikutnya...`);
      }
    }
  }

  if (!lastErr) {
    const e = new Error(`Provider "${providerId}" tidak menghasilkan respons (semua slot diblokir/rate-limited).`);
    e.response = { status: 503, data: { error: { message: e.message } } };
    throw e;
  }
  throw lastErr;
}

async function callAI(opts, timeout, forceProviders) {
  const order = (forceProviders || _runtimeProviderOrder || PROVIDER_ORDER).filter((id) => PROVIDERS[id]?.keys.length);
  if (order.length === 0) {
    const e = new Error('Tidak ada provider AI yang dikonfigurasi. Set minimal salah satu: GROQ_API_KEY(S) atau GEMINI_API_KEY(S).');
    e.response = { status: 401, data: { error: { message: e.message } } };
    throw e;
  }

  let lastErr;
  for (const providerId of order) {
    try {
      const result = await callProviderOnce(providerId, opts, timeout);
      result.providerId = providerId;
      return result;
    } catch (err) {
      // Pastikan provider terakhir yang gagal selalu teridentifikasi di friendlyError
      err.providerId = err.providerId || providerId;
      lastErr = err;
      console.log(`[callAI] provider "${providerId}" habis/limit, pindah ke provider berikutnya...`);
      continue;
    }
  }
  throw lastErr;
}

// callGemini: khusus generateImage() karena butuh body generationConfig khusus.
// [FIX #2] callGemini image generation — loop key×model sekali, backoff hanya saat 429/503.
// Return langsung saat sukses, tanpa iterasi rounds berulang untuk slot yang sudah dicoba.
async function callGemini(models, body, timeout, rounds = 3) {
  if (GEMINI_KEYS.length === 0) {
    const e = new Error('GEMINI_API_KEYS / GEMINI_API_KEY belum di-set.');
    e.response = { status: 401, data: { error: { message: 'API key kosong.' } } };
    throw e;
  }

  const modelList = [...new Set(Array.isArray(models) ? models : [models])].filter(Boolean);
  if (modelList.length === 0) throw new Error('[callGemini] Tidak ada model gambar dikonfigurasi. Set GEMINI_IMAGE_MODELS di env.');

  let lastErr;
  const startImgKey = _imgKeyCursor % Math.max(GEMINI_KEYS.length, 1);
  const totalSlots = GEMINI_KEYS.length * modelList.length;
  // Putaran pertama: coba semua slot tanpa backoff.
  // Putaran berikutnya (hanya jika semua 429/503): backoff exponential.
  for (let round = 0; round <= rounds; round++) {
    let anyRetryable = false;
    for (let ki = 0; ki < GEMINI_KEYS.length; ki++) {
      const keyIdx = (startImgKey + ki) % GEMINI_KEYS.length;
      const key = GEMINI_KEYS[keyIdx];
      for (const model of modelList) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
        try {
          const { data } = await axios.post(url, body, { timeout });
          _imgKeyCursor = (keyIdx + 1) % Math.max(GEMINI_KEYS.length, 1);
          return data; // [FIX] early return langsung — tidak lanjut ke slot/round berikutnya
        } catch (err) {
          lastErr = err;
          lastErr.geminiModel = model;
          const status = err.response?.status;
          if (status === 429 || status === 503 || status === 500) anyRetryable = true;
          console.log(`[callGemini/image] key#${keyIdx} model=${model} status ${status || err.code}, coba kombinasi lain...`);
        }
      }
    }
    // Jika tidak ada yang retryable, tidak perlu backoff — langsung lempar error
    if (!anyRetryable || round >= rounds) break;
    const waitTime = Math.pow(2, round) * 2000 + Math.random() * 1000;
    console.log(`[callGemini/image] semua key & model rate-limited, backoff ${Math.round(waitTime)}ms (putaran ${round + 1}/${rounds})`);
    await sleep(waitTime);
  }
  _imgKeyCursor = (startImgKey + GEMINI_KEYS.length) % Math.max(GEMINI_KEYS.length, 1);
  throw lastErr;
}

// ============================================================
// UTILITIES
// ============================================================

const EXT_MAP = {
  javascript: 'js', js: 'js', node: 'js',
  typescript: 'ts', ts: 'ts',
  jsx: 'jsx', tsx: 'tsx',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss',
  python: 'py', py: 'py',
  json: 'json',
  bash: 'sh', sh: 'sh', shell: 'sh', shellscript: 'sh',
  yaml: 'yaml', yml: 'yaml',
  markdown: 'md', md: 'md',
  sql: 'sql',
  java: 'java',
  c: 'c', cpp: 'cpp', 'c++': 'cpp',
  go: 'go', golang: 'go',
  rust: 'rs', rs: 'rs',
  php: 'php',
  solidity: 'sol', sol: 'sol',
  xml: 'xml', csv: 'csv', txt: 'txt',
};

function extractCodeBlocks(text) {
  const regex = /```(\w[\w+-]*)?\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let match;
  while ((match = regex.exec(text || '')) !== null) {
    const code = match[2].replace(/\s+$/, '');
    if (code.trim()) blocks.push({ lang: (match[1] || '').toLowerCase(), code });
  }
  return blocks;
}

function stripCodeBlocks(text) {
  return (text || '').replace(/```(\w[\w+-]*)?\r?\n[\s\S]*?```/g, '').trim();
}

function isImageRequest(text) {
  const t = (text || '').toLowerCase();
  return /\b(buat(kan)?|gambar(kan)?|lukis(kan)?|bikin(kan)?|generate|render|design|desain|sketsa|ilustrasi|foto)\b/.test(t)
    && /\b(gambar|foto|ilustrasi|logo|poster|wallpaper|sketsa|image|picture|art|artwork|desain|design)\b/.test(t);
}

function isCryptoPriceRequest(text) {
  const t = (text || '').toLowerCase();
  return /\b(harga|price|kurs|market\s*cap|marketcap|gas\s*fee|trending|fear\s*and\s*greed|fear\s*&\s*greed|tvl)\b/.test(t)
    && (/\b(btc|eth|bnb|sol|crypto|kripto|koin|coin|token|altcoin)\b/.test(t) || /\b(gas|tvl|trending|fear)\b/.test(t));
}

function extractCoinIds(text) {
  const t = (text || '').toLowerCase();
  const words = t.match(/[a-z0-9-]+/g) || [];
  const ids = new Set();
  for (const w of words) {
    if (COINGECKO_ID_MAP[w]) ids.add(COINGECKO_ID_MAP[w]);
  }
  return [...ids];
}

// ============================================================
// API CRYPTO
// ============================================================

async function getCryptoPrice(ids, vsCurrency = 'usd') {
  if (!ids || ids.length === 0) return null;
  try {
    const cgHdr = COINGECKO_API_KEY ? { 'x-cg-api-key': COINGECKO_API_KEY } : {};
    const { data } = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: { ids: ids.join(','), vs_currencies: vsCurrency, include_24hr_change: true, include_market_cap: true, include_last_updated_at: true },
      headers: cgHdr,
      timeout: 8000,
    });
    return data;
  } catch (err) {
    console.error('[getCryptoPrice] gagal:', err.response?.status || err.message);
    return null;
  }
}

async function getTrendingCrypto() {
  try {
    const cgHdr2 = COINGECKO_API_KEY ? { 'x-cg-api-key': COINGECKO_API_KEY } : {};
    const { data } = await axios.get('https://api.coingecko.com/api/v3/search/trending', { headers: cgHdr2, timeout: 8000 });
    return (data?.coins || []).slice(0, 7).map((c) => ({ name: c.item?.name, symbol: c.item?.symbol, rank: c.item?.market_cap_rank }));
  } catch (err) {
    console.error('[getTrendingCrypto] gagal:', err.response?.status || err.message);
    return null;
  }
}

async function getDexScreenerInfo(query) {
  if (!query) return null;
  try {
    const { data } = await axios.get('https://api.dexscreener.com/latest/dex/search', { params: { q: query }, timeout: 8000 });
    const pairs = (data?.pairs || []).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)).slice(0, 3);
    if (pairs.length === 0) return null;
    return pairs.map((p) => ({
      chain: p.chainId, dex: p.dexId,
      pair: `${p.baseToken?.symbol}/${p.quoteToken?.symbol}`,
      priceUsd: p.priceUsd, change24h: p.priceChange?.h24,
      liquidityUsd: p.liquidity?.usd, volume24h: p.volume?.h24, fdv: p.fdv, url: p.url,
    }));
  } catch (err) {
    console.error('[getDexScreenerInfo] gagal:', err.response?.status || err.message);
    return null;
  }
}

async function getBinanceTicker(symbolPair) {
  if (!symbolPair) return null;
  try {
    const { data } = await axios.get('https://api.binance.com/api/v3/ticker/24hr', { params: { symbol: symbolPair.toUpperCase() }, timeout: 8000 });
    return { symbol: data.symbol, lastPrice: data.lastPrice, change24hPct: data.priceChangePercent, high24h: data.highPrice, low24h: data.lowPrice, volume24h: data.volume };
  } catch (err) {
    console.error('[getBinanceTicker] gagal:', err.response?.status || err.message);
    return null;
  }
}

async function getBtcMempoolFees() {
  try {
    const { data } = await axios.get('https://mempool.space/api/v1/fees/recommended', { timeout: 8000 });
    return data;
  } catch (err) {
    console.error('[getBtcMempoolFees] gagal:', err.response?.status || err.message);
    return null;
  }
}

async function getFearGreedIndex() {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/', { timeout: 8000 });
    const v = data?.data?.[0];
    if (!v) return null;
    return { value: v.value, classification: v.value_classification, timestamp: v.timestamp };
  } catch (err) {
    console.error('[getFearGreedIndex] gagal:', err.response?.status || err.message);
    return null;
  }
}

async function getDefiLlamaTVL(protocol) {
  if (!protocol) return null;
  try {
    const { data } = await axios.get(`https://api.llama.fi/tvl/${encodeURIComponent(protocol)}`, { timeout: 8000 });
    return typeof data === 'number' ? { protocol, tvlUsd: data } : null;
  } catch (err) {
    console.error('[getDefiLlamaTVL] gagal:', err.response?.status || err.message);
    return null;
  }
}

// ============================================================
// API BLOCKCHAIN
// ============================================================

async function getGasPrice(chain = 'eth') {
  const cfg = CHAIN_EXPLORERS[chain];
  if (!cfg || !cfg.key) return null;
  try {
    const { data } = await axios.get(cfg.base, { params: { module: 'gastracker', action: 'gasoracle', apikey: cfg.key }, timeout: 8000 });
    if (data?.status !== '1') return null;
    return { chain: cfg.name, ...data.result };
  } catch (err) {
    console.error(`[getGasPrice:${chain}] gagal:`, err.response?.status || err.message);
    return null;
  }
}

async function getContractSource(address, chain = 'eth') {
  const cfg = CHAIN_EXPLORERS[chain];
  if (!cfg || !cfg.key || !address) return null;
  try {
    const { data } = await axios.get(cfg.base, { params: { module: 'contract', action: 'getsourcecode', address, apikey: cfg.key }, timeout: 10000 });
    const result = data?.result?.[0];
    if (!result || !result.SourceCode) return null;
    return { chain: cfg.name, name: result.ContractName, compiler: result.CompilerVersion, isProxy: result.Proxy === '1', sourceCode: result.SourceCode };
  } catch (err) {
    console.error(`[getContractSource:${chain}] gagal:`, err.response?.status || err.message);
    return null;
  }
}

// ============================================================
// API GITHUB
// ============================================================

async function getGitHubRepo(owner, repo) {
  if (!owner || !repo) return null;
  try {
    const headers = GITHUB_WRITE_TOKEN ? { Authorization: `Bearer ${GITHUB_WRITE_TOKEN}` } : {};
    const { data } = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers, timeout: 8000 });
    return { fullName: data.full_name, description: data.description, stars: data.stargazers_count, forks: data.forks_count, language: data.language, openIssues: data.open_issues_count, url: data.html_url };
  } catch (err) {
    console.error('[getGitHubRepo] gagal:', err.response?.status || err.message);
    return null;
  }
}

function githubHeaders() {
  const h = { Accept: 'application/vnd.github+json', 'User-Agent': 'BP-AI-Bot/1.0', 'X-GitHub-Api-Version': '2022-11-28' };
  if (GITHUB_WRITE_TOKEN) h.Authorization = `Bearer ${GITHUB_WRITE_TOKEN}`;
  return h;
}

async function getDefaultBranch(owner, repo) {
  const { data } = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers: githubHeaders(), timeout: 8000 });
  return data.default_branch || 'main';
}

async function getGitHubFileContent(owner, repo, filePath, branch) {
  const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
  const { data } = await axios.get(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(filePath)}${ref}`,
    { headers: githubHeaders(), timeout: 10000 },
  );
  if (Array.isArray(data) || !data.content) throw new Error(`"${filePath}" bukan file tunggal atau tidak ditemukan.`);
  return { content: Buffer.from(data.content, 'base64').toString('utf-8'), sha: data.sha, path: data.path };
}


// [FIX] Validasi sintaks sebelum commit ke GitHub — cegah patch SEARCH/REPLACE yang
// menghasilkan kode rusak (kurung tak seimbang, dst) ter-commit tanpa terdeteksi.
// Sama seperti Replit Agent yang selalu verifikasi (typecheck/build) sebelum menganggap
// edit selesai — di sini kita pakai pengecekan sintaks lokal (tanpa eksekusi kode).
function validateSyntax(filePath, content) {
  const ext = (filePath.split('.').pop() || '').toLowerCase();

  if (ext === 'json') {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (e) {
      return { valid: false, error: 'JSON tidak valid: ' + e.message };
    }
  }

  if (ext === 'js' || ext === 'cjs') {
    // File ESM (import/export) tidak bisa diparse oleh vm.Script (parser CommonJS) —
    // skip validasi ketimbang salah nge-block perubahan yang sebenarnya valid.
    // [FIX] Regex sebelumnya /^s*(imports|exports)/m salah ketik: "s*" seharusnya "\s*"
    // (whitespace), dan "imports|exports" seharusnya "import|export" (keyword JS asli,
    // bukan kata jamak). Akibatnya regex nyaris tidak pernah match, sehingga file ESM
    // (yang pakai import/export) selalu lolos ke vm.Script dan SELALU dilaporkan sebagai
    // "syntax error" palsu meskipun kodenya valid.
    if (/^\s*(import|export)\b/m.test(content)) {
      return { valid: true, skipped: true };
    }
    try {
      const vm = require('vm');
      // Hanya parse, TIDAK dieksekusi — aman untuk kode apa pun (termasuk yang berbahaya).
      new vm.Script(content, { filename: filePath });
      return { valid: true };
    } catch (e) {
      return { valid: false, error: 'Syntax error JavaScript: ' + e.message };
    }
  }

  // ts/tsx/py/sol/go/dll — tidak ada parser sintaks yang reliable tanpa toolchain
  // tambahan, jadi kita skip (tidak block, tapi juga tidak false-positive).
  return { valid: true, skipped: true };
}

async function commitGitHubFile(owner, repo, filePath, newContent, commitMessage, sha, branch) {
  if (!GITHUB_WRITE_TOKEN) {
    const e = new Error('GITHUB_WRITE_TOKEN (atau GITHUB_TOKEN) belum di-set / tidak punya izin tulis.');
    e.response = { status: 401, data: { message: e.message } };
    throw e;
  }
  const body = { message: commitMessage, content: Buffer.from(newContent, 'utf-8').toString('base64'), sha };
  if (branch) body.branch = branch;
  const { data } = await axios.put(
    `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURI(filePath)}`,
    body,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_WRITE_TOKEN}`,
        'User-Agent': 'BP-AI-Bot/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15000,
    },
  );
  return { commitUrl: data.commit?.html_url, contentUrl: data.content?.html_url, sha: data.content?.sha };
}

// ============================================================
// REAL-TIME CONTEXT
// ============================================================

async function buildRealtimeContext(question) {
  const lines = [];

  if (isCryptoPriceRequest(question)) {
    const ids = extractCoinIds(question);

    if (ids.length > 0) {
      const prices = await getCryptoPrice(ids);
      if (prices) {
        for (const id of ids) {
          const p = prices[id];
          if (!p) continue;
          const change = p.usd_24h_change != null ? p.usd_24h_change.toFixed(2) : 'N/A';
          lines.push(`- ${id}: $${p.usd} (24h: ${change}%, market cap: $${Math.round(p.usd_market_cap || 0).toLocaleString('en-US')})`);
        }
      }
    }

    if (/\btrending\b/.test(question.toLowerCase())) {
      const trending = await getTrendingCrypto();
      if (trending?.length) lines.push(`- Trending di CoinGecko: ${trending.map((c) => `${c.name} (${c.symbol?.toUpperCase()})`).join(', ')}`);
    }

    if (/fear\s*(and|&)?\s*greed/.test(question.toLowerCase())) {
      const fng = await getFearGreedIndex();
      if (fng) lines.push(`- Crypto Fear & Greed Index: ${fng.value} (${fng.classification})`);
    }

    if (/\bgas\b/.test(question.toLowerCase())) {
      for (const chain of Object.keys(CHAIN_EXPLORERS)) {
        const gas = await getGasPrice(chain);
        if (gas) lines.push(`- Gas price ${gas.chain}: Safe ${gas.SafeGasPrice} / Propose ${gas.ProposeGasPrice} / Fast ${gas.FastGasPrice} Gwei`);
      }
    }

    if (/\btvl\b/.test(question.toLowerCase())) {
      const match = question.toLowerCase().match(/tvl\s+(?:dari|di|of)?\s*([a-z0-9-]+)|([a-z0-9-]+)\s+tvl/);
      const protocol = match?.[1] || match?.[2];
      if (protocol) {
        const tvl = await getDefiLlamaTVL(protocol);
        if (tvl) lines.push(`- TVL ${tvl.protocol}: $${Math.round(tvl.tvlUsd).toLocaleString('en-US')}`);
      }
    }

    if (/\bbinance\b/i.test(question)) {
      const symbolMatch = question.toUpperCase().match(/\b(BTC|ETH|BNB|SOL|XRP|ADA|DOGE|TON|TRX|MATIC|DOT|AVAX|SHIB|LINK|PEPE|SUI|ARB|OP|USDT|USDC)\b/);
      if (symbolMatch && symbolMatch[1] !== 'USDT' && symbolMatch[1] !== 'USDC') {
        const ticker = await getBinanceTicker(`${symbolMatch[1]}USDT`);
        if (ticker) lines.push(`- [Binance] ${ticker.symbol}: $${ticker.lastPrice} (24h: ${ticker.change24hPct}%, high $${ticker.high24h}, low $${ticker.low24h})`);
      }
    }

    const addressMatch = question.match(/\b0x[a-fA-F0-9]{40}\b/);
    if (addressMatch || /\bdex(screener)?\b/i.test(question)) {
      const queryTarget = addressMatch ? addressMatch[0] : ids[0] || question;
      const dexInfo = await getDexScreenerInfo(queryTarget);
      if (dexInfo?.length) {
        for (const p of dexInfo) {
          lines.push(`- [DexScreener] ${p.pair} di ${p.dex} (${p.chain}): $${p.priceUsd} (24h: ${p.change24h}%), liquidity $${Math.round(p.liquidityUsd || 0).toLocaleString('en-US')}`);
        }
      }
    }

    if (/\b(mempool|btc\s*fee|bitcoin\s*fee|fee\s*btc)\b/i.test(question)) {
      const fees = await getBtcMempoolFees();
      if (fees) lines.push(`- BTC network fee (sat/vB): fastest ${fees.fastestFee}, 30min ${fees.halfHourFee}, 1hr ${fees.hourFee}, economy ${fees.economyFee}`);
    }
  }

  // [FIX #6] Regex spesifik GitHub-style: hindari false match path/semver/IP
  const repoMatch = question.match(/(?:^|[\s/])([a-zA-Z0-9][a-zA-Z0-9_-]{0,38})\/([a-zA-Z0-9][a-zA-Z0-9._-]{0,99})(?=\s|$)/);
  if (repoMatch && /github|repo|library|lib|package/i.test(question)) {
    const repoInfo = await getGitHubRepo(repoMatch[1], repoMatch[2]);
    if (repoInfo) lines.push(`- GitHub ${repoInfo.fullName}: ⭐${repoInfo.stars}, bahasa ${repoInfo.language || '-'}, "${repoInfo.description || 'tanpa deskripsi'}"`);
  }

  if (lines.length === 0) return '';
  return `\n\n[DATA REAL-TIME — sumber API langsung, gunakan ini sebagai acuan utama]\n${lines.join('\n')}\n[/DATA REAL-TIME]`;
}

// ============================================================
// FUNGSI UTAMA
// askGemini(question, history, isDMOwner)
//   - history  : riwayat percakapan — dikirim ke provider MANAPUN yang aktif.
//   - isDMOwner: aktifkan system prompt coding mendalam di semua provider.
// ============================================================
async function askGemini(question, history = [], isDMOwner = false, skipProviders = [], systemOverride = null) {
  const extraContext = await buildRealtimeContext(question);
  const finalQuestion = question + extraContext;
  const baseOrder = _runtimeProviderOrder || PROVIDER_ORDER;
  const effectiveOrder = skipProviders.length
    ? baseOrder.filter((p) => !skipProviders.includes(p))
    : _runtimeProviderOrder ? [..._runtimeProviderOrder] : null;
  // Timeout 300 detik — beri AI waktu berpikir untuk analisis mendalam
  const result = await callAI({ question: finalQuestion, history, isDMOwner, systemOverride }, 300000, effectiveOrder);
  return { text: result.text, sources: result.sources || [], provider: result.providerId };
}

const askAI = askGemini;

async function generateImage(prompt, model) {
  if (GEMINI_KEYS.length === 0) {
    const e = new Error('Generate gambar butuh GEMINI_API_KEY.');
    e.response = { status: 401, data: { error: { message: e.message } } };
    throw e;
  }
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } };
  const modelsToTry = model ? [...new Set([...(Array.isArray(model) ? model : [model]), ...IMAGE_MODELS])] : IMAGE_MODELS;
  const data = await callGemini(modelsToTry, body, 30000);
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let imageBuffer = null;
  let text = '';
  for (const p of parts) {
    if (p.inlineData?.data) imageBuffer = Buffer.from(p.inlineData.data, 'base64');
    else if (p.text) text += p.text;
  }
  return { imageBuffer, text };
}

// ============================================================
// KONVERSI TABEL MARKDOWN → TEKS PLAIN (Discord tidak render tabel)
// Menggunakan pendekatan line-by-line agar lebih akurat dari regex.
// ============================================================
function convertTablesForDiscord(text) {
  if (!text) return text;

  // Hapus tag HTML <br> → newline
  text = text.replace(/<br\s*\/?>/gi, '\n');

  const lines = text.split('\n');
  const result = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Deteksi baris tabel: dimulai dengan |
    if (/^\s*\|/.test(line)) {
      // Kumpulkan semua baris tabel berturut-turut
      const tableLines = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        tableLines.push(lines[i].trim());
        i++;
      }

      const parseRow = (l) => l.split('|').map(c => c.trim()).filter(c => c.length > 0);
      const header = parseRow(tableLines[0]);

      // Deteksi baris separator (---|--- atau :---:|)
      let dataStart = 1;
      if (tableLines.length > 1 && /^[\|:\-\s]+$/.test(tableLines[1])) {
        dataStart = 2;
      }

      const rows = tableLines.slice(dataStart).map(parseRow).filter(r => r.length > 0);

      if (header.length === 0 || rows.length === 0) {
        // Bukan tabel valid — buang pipe saja
        result.push(...tableLines.map(l => l.replace(/\|/g, ' ').replace(/\s{2,}/g, ' ').trim()));
      } else if (header.length <= 2) {
        // 2 kolom: key-value → "• **Key:** Value"
        if (header.length === 2) result.push(`**${header[0]} — ${header[1]}**`);
        for (const row of rows) {
          if (row.length >= 2) result.push(`• **${row[0]}:** ${row[1]}`);
          else if (row.length === 1) result.push(`• ${row[0]}`);
        }
      } else {
        // 3+ kolom: tiap ROW jadi satu entry bullet, field dipisah newline (bukan pipe)
        // Format: • **NamaEntitas**\n  Field1: Val1\n  Field2: Val2
        for (const row of rows) {
          const firstName = row[0] || '';
          result.push(`• **${firstName}**`);
          for (let idx = 1; idx < header.length; idx++) {
            const val = row[idx] || '—';
            result.push(`  ${header[idx]}: ${val}`);
          }
        }
      }
      result.push(''); // baris kosong setelah tabel
    } else {
      result.push(line);
      i++;
    }
  }

  // Safety: buang semua pipe | yang masih tersisa di luar code block
  let finalText = result.join('\n');
  // Pertahankan | di dalam code block ``` — hanya buang pipe di teks biasa
  const parts = finalText.split(/(^```.*?^```)/ms);
  finalText = parts.map((chunk, idx) => {
    // Ganjil = di dalam code block, biarkan
    if (idx % 2 === 1) return chunk;
    // Buang baris yang HANYA berisi pipe + spasi (sisa tabel gagal-parse)
    return chunk.split('\n').map(line => {
      if (/^[\|\s\-:]+$/.test(line)) return '';
      return line;
    }).join('\n');
  }).join('');
  return finalText;
}


function formatAnswer(text, sources = []) {
  let out = convertTablesForDiscord(text) || 'Tidak ada jawaban.';
  if (sources.length > 0) {
    const seen = new Set();
    const unique = [];
    for (const s of sources) {
      if (s.uri && !seen.has(s.uri)) { seen.add(s.uri); unique.push(s); }
      if (unique.length >= 5) break;
    }
    const list = unique.map((s, i) => `${i + 1}. [${s.title}](<${s.uri}>)`).join('\n');
    const footer = `\n\n📚 **Sumber:**\n${list}`;
    // Hard cap: 2 pesan Discord max (3800 chars total)
    const maxBody = 3800 - footer.length;
    if (out.length > maxBody) out = out.slice(0, maxBody - 1) + '…';
    out += footer;
  } else if (out.length > 3800) {
    // Hard cap 2 pesan Discord — potong di batas kata
    const cut = out.lastIndexOf(' ', 3799);
    out = out.slice(0, cut > 3000 ? cut : 3799) + '…';
  }
  return out;
}

function friendlyError(err) {
  if (err == null || typeof err !== 'object') {
    console.error('[ai] friendlyError dipanggil dengan err non-objek:', err);
    return '⚠️ Semua provider AI gagal merespons. Coba lagi nanti.';
  }
  const status = err.response?.status;
  const apiMsg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
  const providerLabel = err.providerId ? err.providerId.toUpperCase() : 'AI';
  const failedModel = err.aiModel || err.geminiModel || 'unknown';
  // Potong apiMsg agar tidak bocor ke log (maks 120 karakter)
    const safeMsg = typeof apiMsg === 'string' ? apiMsg.slice(0, 120).replace(/[A-Za-z0-9_\-]{30,}/g, '[REDACTED]') : apiMsg;
    console.error('[ai] Gagal:', providerLabel, status, safeMsg);
  if (status === 401 && /tidak ada provider|tidak dikonfigurasi/i.test(apiMsg || '')) return '⚠️ Belum ada provider AI yang dikonfigurasi. Set minimal salah satu env: `GROQ_API_KEY` atau `GEMINI_API_KEY`.';
  if (status === 429) return `⚠️ Rate limit ${providerLabel} tercapai di semua key/provider. Coba lagi sebentar, atau tambah API key lain.`;
  if (status === 503 || status === 500) return `⚠️ Server ${providerLabel} sedang overload. Coba lagi beberapa saat lagi.`;
  if (status === 404) return `⚠️ Model "${failedModel}" (${providerLabel}) tidak ditemukan/dipensiunkan. Cek/ubah env model-nya.`;
  return `⚠️ Gagal memproses jawaban AI (${providerLabel}). (${status || 'error'}: ${apiMsg})`;
}

// createGitHubRepo dipindahkan ke lib/agent.js (tool agent, bukan utility AI)

module.exports = {
  COINGECKO_API_KEY, CRYPTORANK_API_KEY, ALCHEMY_BASE_RPC,
  SYSTEM_PROMPT, SYSTEM_PROMPT_DM, TEXT_MODELS, IMAGE_MODELS,
  callGemini, isImageRequest, askGemini, askAI, generateImage, formatAnswer, friendlyError,
  PROVIDERS, PROVIDER_ORDER, setProviderOrder,
  EXT_MAP, extractCodeBlocks, stripCodeBlocks,
  isCryptoPriceRequest, extractCoinIds, getCryptoPrice, getTrendingCrypto, getFearGreedIndex, getDefiLlamaTVL,
  getGasPrice, getContractSource,
  getGitHubRepo, getDefaultBranch, getGitHubFileContent, commitGitHubFile, validateSyntax,
  buildRealtimeContext, getDexScreenerInfo, getBtcMempoolFees, getBinanceTicker,
  sanitizeHistoryForGemini,
  // Keys/models — single source of truth, diimport oleh agent.js
  GEMINI_KEYS, GROQ_KEYS, OPENAI_KEYS, GROQ_MODELS, OPENAI_MODELS,
  CONDUIT_KEYS, CONDUIT_MODELS, IAMHC_KEYS, IAMHC_MODELS,
};

