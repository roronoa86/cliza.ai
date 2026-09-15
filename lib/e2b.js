// lib/e2b.js
// E2B Code Interpreter — sandbox eksekusi kode aman per user Discord.
// Tiap user dapat sandbox unik yang persist ~10 menit inaktivitas.
// Support: Python, JavaScript, TypeScript, Bash, R, Java.
'use strict';

const E2B_API_KEY = process.env.E2B_API_KEY || '';
const SANDBOX_TIMEOUT_MS = 10 * 60 * 1000; // 10 menit inaktivitas

// Map: userId → { sandboxId, lastUsed }
const _sessions = new Map();

// Cleanup idle sessions setiap 5 menit — panggil sb.kill() agar E2B tidak leak resource
setInterval(async () => {
  const now = Date.now();
  for (const [uid, s] of _sessions.entries()) {
    if (now - s.lastUsed > SANDBOX_TIMEOUT_MS) {
      _sessions.delete(uid);
      console.log('[e2b] session expired: user ' + uid);
      if (s.sandboxId && E2B_API_KEY) {
        try {
          const { Sandbox } = require('@e2b/code-interpreter');
          const sb = await Sandbox.connect(s.sandboxId, { apiKey: E2B_API_KEY });
          await sb.kill().catch(killErr => console.error('[e2b] gagal kill sandbox idle user=' + uid + ':', killErr.message));
        } catch (e) {
          console.error('[e2b] gagal cleanup sandbox idle user=' + uid + ':', e.message);
        }
      }
    }
  }
}, 5 * 60 * 1000).unref();

async function getSandbox(userId) {
  if (!E2B_API_KEY) throw new Error('E2B_API_KEY belum di-set di Railway environment variables.');
  const { Sandbox } = require('@e2b/code-interpreter');

  const existing = _sessions.get(userId);
  if (existing) {
    try {
      const sb = await Sandbox.connect(existing.sandboxId, { apiKey: E2B_API_KEY });
      existing.lastUsed = Date.now();
      return sb;
    } catch (connErr) {
      console.log('[e2b] reconnect gagal user=' + userId + ' (' + connErr.message + ') — buat sandbox baru');
      _sessions.delete(userId);
    }
  }

  const sb = await Sandbox.create({ apiKey: E2B_API_KEY, timeoutMs: 30 * 60 * 1000 });
  _sessions.set(userId, { sandboxId: sb.sandboxId, lastUsed: Date.now() });
  console.log('[e2b] sandbox baru user=' + userId + ' id=' + sb.sandboxId);
  return sb;
}

// Smart truncation: output besar → tampilkan head + tail agar info krusial tidak hilang
function smartTrunc(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  const half = Math.floor(maxLen / 2);
  return str.slice(0, half) + '\n... [' + (str.length - maxLen) + ' karakter dipotong] ...\n' + str.slice(-half);
}

function fmtResult(result) {
  const parts = [];
  const stdout = (result.logs?.stdout || []).join('').trim();
  const stderr = (result.logs?.stderr || []).join('').trim();

  if (result.error) {
    // Tampilkan error DAN stderr — stderr sering berisi traceback lengkap yang krusial untuk debug
    parts.push('❌ **Error:**\n```\n' + smartTrunc(String(result.error), 2000) + '\n```');
    if (stderr) parts.push('📋 **Stderr (traceback):**\n```\n' + smartTrunc(stderr, 1500) + '\n```');
  } else {
    if (stderr) parts.push('⚠️ **Stderr:**\n```\n' + smartTrunc(stderr, 800) + '\n```');
  }

  if (stdout) parts.push('📤 **Output:**\n```\n' + smartTrunc(stdout, 4000) + '\n```');

  for (const r of result.results || []) {
    if (r.text) parts.push(String(r.text).slice(0, 1000));
    if (r.png) parts.push('📊 [Chart/gambar dihasilkan oleh kode]');
  }
  return parts.join('\n\n') || '✅ Kode selesai dijalankan (tanpa output).';
}

async function runCode(userId, language, code) {
  try {
    const sb = await getSandbox(userId);
    const result = await sb.runCode(code, { language: language || 'python', timeoutMs: 28000 });
    return fmtResult(result);
  } catch (e) {
    return '❌ Gagal jalankan kode: ' + e.message;
  }
}

async function writeFile(userId, filePath, content) {
  try {
    const sb = await getSandbox(userId);
    await sb.files.write(filePath, content);
    return '✅ File berhasil ditulis: `' + filePath + '` (' + content.length + ' chars)';
  } catch (e) {
    return '❌ Gagal tulis file: ' + e.message;
  }
}

// [FIX] Lock in-memory per (userId+filePath) — mencegah race condition read-then-write
// saat dua appendFile ke file yang sama dipanggil nyaris bersamaan (mis. dari Promise.all
// di lib/agent.js saat model memanggil beberapa tool paralel). Tanpa lock ini, salah satu
// write bisa menimpa write lainnya karena keduanya membaca "existing" yang sama sebelum
// salah satunya sempat menulis.
const _fileLocks = new Map();
function _withFileLock(key, fn) {
  const prevTail = _fileLocks.get(key) || Promise.resolve();
  const result = prevTail.then(fn, fn);
  _fileLocks.set(key, result.catch(() => {}));
  return result;
}

// appendFile: tambah konten ke file yang sudah ada tanpa overwrite
async function appendFile(userId, filePath, content) {
  const lockKey = userId + '::' + filePath;
  return _withFileLock(lockKey, async () => {
    try {
      const sb = await getSandbox(userId);
      let existing = '';
      try { existing = await sb.files.read(filePath); } catch (_) {}
      await sb.files.write(filePath, existing + content);
      return '✅ Konten berhasil ditambahkan ke `' + filePath + '`';
    } catch (e) {
      return '❌ Gagal append file: ' + e.message;
    }
  });
}

async function readFile(userId, filePath) {
  try {
    const sb = await getSandbox(userId);
    const content = await sb.files.read(filePath);
    const ext = filePath.split('.').pop() || '';
    const str = String(content);
    return '📄 **' + filePath + '** (' + str.length + ' chars):\n```' + ext + '\n' + smartTrunc(str, 4000) + '\n```';
  } catch (e) {
    return '❌ File tidak ditemukan: `' + filePath + '` — ' + e.message;
  }
}

// [FIX] readFileRaw: mengembalikan isi file MENTAH (tanpa bungkus markdown/header/truncation)
// — dipakai oleh tool internal seperti editFile yang butuh isi asli file untuk operasi
// string-replace. readFile() di atas TIDAK cocok untuk ini karena hasilnya sudah dibungkus
// format tampilan (header "📄 **path**...", code fence, dan dipotong smartTrunc di 4000
// karakter) — jika teks berbungkus itu ditulis balik ke file, file akan tercemar/rusak.
async function readFileRaw(userId, filePath) {
  const sb = await getSandbox(userId);
  const content = await sb.files.read(filePath);
  return String(content);
}

async function listFiles(userId, dirPath) {
  try {
    const sb = await getSandbox(userId);
    const files = await sb.files.list(dirPath || '/home/user');
    if (!files || !files.length) return '📁 `' + (dirPath || '/home/user') + '` kosong.';
    const lines = files.map(f => (f.type === 'dir' ? '📂 ' : '📄 ') + f.name + (f.size ? ' (' + f.size + ' B)' : ''));
    return '📁 **' + (dirPath || '/home/user') + '** (' + files.length + ' item):\n' + lines.join('\n');
  } catch (e) {
    return '❌ Gagal list files: ' + e.message;
  }
}

// [FIX] Escape sebuah string agar aman dipakai sebagai satu argumen shell tunggal
// (dibungkus single-quote). Ini teknik standar shell-escaping: tutup quote, tambahkan
// backslash-quote literal, buka quote lagi — aman untuk karakter shell apa pun ($, `, ;, &&, |, dst).
function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// searchFiles: grep pattern di sandbox — cari fungsi, variabel, string dalam file-file
async function searchFiles(userId, pattern, dirPath) {
  const dir = dirPath || '/home/user';
  // [FIX] Sebelumnya `dir` diinterpolasi mentah TANPA quoting ke command shell — pattern
  // sudah di-escape tapi dir tidak, jadi dir yang mengandung `;`, `` ` ``, `$()`, dll bisa
  // dipakai untuk menyisipkan command tambahan (command injection di dalam sandbox).
  // Sekarang keduanya di-quote dengan shQuote() agar selalu diperlakukan sebagai literal.
  const cmd = "grep -rn --include='*.py' --include='*.js' --include='*.ts' --include='*.sh' --include='*.txt' --include='*.json' --include='*.md' -e " + shQuote(pattern) + " " + shQuote(dir) + " 2>/dev/null | head -50";
  return await runCode(userId, 'bash', cmd);
}

async function installPackage(userId, manager, packages) {
  if (!['pip', 'npm', 'apt'].includes(manager)) {
    return '❌ Package manager tidak dikenal: "' + manager + '". Gunakan: pip, npm, apt';
  }
  const tokens = String(packages || '').trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return '❌ Tidak ada nama package yang diberikan.';
  // [FIX] Sebelumnya `packages` diinterpolasi mentah ke command shell tanpa validasi apa
  // pun — string apapun (termasuk `; rm -rf ~` atau `&& curl ... | sh`) akan dieksekusi
  // sebagai shell command, bukan sekadar "nama package". Sekarang setiap token divalidasi
  // dengan whitelist karakter yang wajar untuk nama package (pip/npm/apt).
  const validPkg = /^[A-Za-z0-9][A-Za-z0-9._@/+=~^-]*$/;
  const bad = tokens.filter(t => !validPkg.test(t));
  if (bad.length) {
    return '❌ Nama package tidak valid: ' + bad.join(', ') + ' — hanya huruf, angka, titik, dash, underscore, @, /, +, =, ~, ^ yang diperbolehkan.';
  }
  const safePackages = tokens.join(' ');
  const cmds = {
    pip:  'pip install ' + safePackages + ' -q 2>&1 | tail -5',
    npm:  'npm install ' + safePackages + ' --save 2>&1 | tail -10',
    apt:  'apt-get install -y ' + safePackages + ' -qq 2>&1 | tail -5',
  };
  return await runCode(userId, 'bash', cmds[manager]);
}

function resetSession(userId) {
  _sessions.delete(userId);
  return '🔄 Sandbox session di-reset. Sandbox baru dibuat di request berikutnya.';
}

module.exports = { runCode, writeFile, appendFile, readFile, readFileRaw, listFiles, searchFiles, installPackage, resetSession };
