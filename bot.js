// bot.js
// Bot Discord ALWAYS-ON (Gateway/WebSocket) — merespons saat di-tag/mention,
// tanpa perlu slash command. Jalankan dengan: `node bot.js`.
//
// PENTING: Bot ini HARUS di-host di tempat always-on (Railway, Fly.io, VPS, Render, dll),
// BUKAN di Vercel Serverless — karena koneksi Gateway perlu proses hidup terus.
//
// Wajib aktifkan "MESSAGE CONTENT INTENT" di Discord Developer Portal:
//   Applications -> (bot kamu) -> Bot -> Privileged Gateway Intents -> Message Content Intent.

const fs = require('fs');
const store = require('./data_store');
const path = require('path');
const http = require('http');
const axios = require('axios');
const translateApi = require('google-translate-api-x');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } = require('discord.js');
const { Client: SelfbotClient } = require('discord.js-selfbot-v13');
const { handleChartCommand } = require('./lib/chartAnalysis');
const {
  isImageRequest,
  askAI,
  askGemini,
  generateImage,
  formatAnswer,
  friendlyError,
  extractCodeBlocks,
  stripCodeBlocks,
  EXT_MAP,
  getDefaultBranch,
  getGitHubFileContent,
  commitGitHubFile,
  validateSyntax,
  PROVIDERS,
  PROVIDER_ORDER,
} = require('./lib/ai');
const { runAgent, setAgentOrder, getAgentStatus } = require('./lib/agent');
const { isScamAnalysisRequest, runScamAnalysis } = require('./lib/tokenScamAnalysis');
const {
    detectBalanceQuery, fetchZerionPortfolio,
    detectTxsQuery, fetchZerionTransactions,
    detectPositionsQuery, fetchZerionPositions,
    detectNFTQuery, fetchZerionNFTs,
    detectGasQuery, fetchZerionGas,
    detectZTokenQuery, fetchZerionToken,
    detectPnLQuery, fetchZerionPnL,
    } = require('./lib/zerion');
const { searchUsername } = require('./lib/sherlock');
const { lookupIP, lookupDNS, lookupGitHub, lookupPhone, runEndpoints } = require('./lib/osintExtra');
const { analyzePhotoGPS, analyzePhotoFromURL, lookupGeoIP, lookupMaps, lookupTimezone } = require('./lib/geoPhoto');
const { pickWinnerOnChain, isShuffleConfigured, getWalletInfo } = require('./lib/shuffle');
const { parseSendCommand, sendToken, getBalance } = require('./lib/send');
const { parseMultisendCommand, executeMultisend } = require('./lib/multisend');
const { detectGmgnQuery, handleGmgnCommand } = require('./lib/gmgn');
const { detectLpQuery, handleLpCommand }   = require('./lib/lp');
const { detectReadContractQuery, handleReadContractCommand } = require('./lib/readContract');

// ============================================================
// KONFIGURASI
// ============================================================

if (!process.env.OWNER_ID) throw new Error('[bot] OWNER_ID belum di-set di Railway env — wajib diisi (Discord user ID pemilik bot).');
const OWNER_ID = process.env.OWNER_ID;

// ── AI on/off per channel atau server ───────────────────────────────────────
// Key: 'ch:<channelId>' atau 'sv:<guildId>'
const aiDisabled = new Set();
let aiGlobalOff = false; // true = AI mati di semua server
const AI_STATE_FILE = path.join(__dirname, 'data', 'ai_state_bot.json');

function saveAiState() {
  try {
    fs.mkdirSync(path.dirname(AI_STATE_FILE), { recursive: true });
    const _s = { globalOff: aiGlobalOff, disabled: [...aiDisabled] };
    fs.writeFileSync(AI_STATE_FILE, JSON.stringify(_s, null, 2), 'utf8');
    store.saveKey('ai_state_bot', { ..._s, ts: Date.now() }).catch(e => console.warn('[store] ai_state_bot:', e.message));
    store.saveKey('ai_state', _s).catch(e => console.warn('[store] ai_state:', e.message));
  } catch (e) { console.warn('[bot] gagal simpan ai_state:', e.message); }
}

function loadAiState() {
  try {
    if (!fs.existsSync(AI_STATE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(AI_STATE_FILE, 'utf8'));
    if (obj.globalOff) aiGlobalOff = true;
    if (Array.isArray(obj.disabled)) obj.disabled.forEach(k => aiDisabled.add(k));
    console.log('[bot] ai_state dimuat: globalOff=' + aiGlobalOff + ', disabled=' + aiDisabled.size + ' entry');
  } catch (e) { console.warn('[bot] gagal muat ai_state:', e.message); }
}
loadAiState(); // muat status AI on/off saat startup

// ── Reactor clients (jalan langsung di bot.js, tidak butuh userbot.js) ───────
const REACTOR_TOKENS = (process.env.DISCORD_REACTOR_TOKENS || '')
  .split(',').map(t => t.trim()).filter(Boolean);

const RUMBLE_BOT_ID   = '693167035068317736';
const GIVEAWAY_BOT_IDS = new Set(['530082442967646230', '294882584201003009']);
const joinedGiveawayIds = new Set();

const disabledReactors = new Set();   // label yang sengaja dimatikan via toggle
const reactorIdentity  = new Map();   // label -> { id, tag, changed, ... }

function _extractButtonRows(msg) {
  const raw = msg.components || msg?.rawComponents || [];
  return raw.map(row => row.components || row.data?.components || []);
}

async function _reactorAutoJoinGiveaway(message, rc, label) {
  try {
    if (message.partial) message = await message.fetch().catch(() => message);
    if (!GIVEAWAY_BOT_IDS.has(message.author?.id || '')) return;
    if (joinedGiveawayIds.has(message.id + ':' + label)) return;
    const rows = _extractButtonRows(message);
    let joined = false;
    for (const row of rows) {
      for (const btn of row) {
        const cid = btn.customId || btn.custom_id;
        if (!cid) continue;
        try {
          if (typeof message.clickButton === 'function') await message.clickButton(cid);
          else throw new Error('clickButton tidak tersedia');
          joined = true;
          // ── Info channel & server untuk log + notif owner ──────────────
          const _gwCh    = message.channel;
          const _gwGuild = message.guild;
          const _gwChName  = _gwCh?.name  ? '#' + _gwCh.name  : '(DM/unknown)';
          const _gwSrvName = _gwGuild?.name || '(DM/unknown)';
          const _gwSrvId   = _gwGuild?.id  || '-';
          const _gwChId    = _gwCh?.id     || '-';
          const _gwMsgLink = _gwGuild
            ? 'https://discord.com/channels/' + _gwGuild.id + '/' + _gwChId + '/' + message.id
            : '(DM)';
          const _gwBtnName = btn.label || cid;
          const _gwTag     = rc.user?.tag || label;

          console.log(
            '[' + label + '] 🎉 klik giveaway "' + _gwBtnName + '" berhasil' +
            ' | server: ' + _gwSrvName + ' (' + _gwSrvId + ')' +
            ' | channel: ' + _gwChName + ' (' + _gwChId + ')' +
            ' | ' + _gwMsgLink
          );

          // Kirim notif DM ke owner via bot utama
          try {
            const _gwOwner = await client.users.fetch(OWNER_ID).catch(() => null);
            if (_gwOwner) {
              const _gwMsg =
                '🎉 **Reactor klik giveaway berhasil!**\n' +
                '• **Reactor:** ' + _gwTag + ' (' + label + ')\n' +
                '• **Tombol:** `' + _gwBtnName + '`\n' +
                '• **Server:** ' + _gwSrvName + ' (`' + _gwSrvId + '`)\n' +
                '• **Channel:** ' + _gwChName + ' (`' + _gwChId + '`)\n' +
                '• **Pesan:** ' + _gwMsgLink;
              await _gwOwner.send(_gwMsg).catch(e => console.warn('[' + label + '] gagal DM owner giveaway notif:', e.message));
            }
          } catch (_gwE) { console.warn('[' + label + '] notif owner error:', _gwE.message); }
        } catch (e) { console.warn('[' + label + '] gagal klik tombol giveaway:', e.message); }
      }
    }
    if (joined) {
      joinedGiveawayIds.add(message.id + ':' + label);
      setTimeout(() => joinedGiveawayIds.delete(message.id + ':' + label), 30 * 60 * 1000);
    }
  } catch (e) { console.warn('[' + label + '] autoJoinGiveaway error:', e.message); }
}

function saveReactorStatus() {
  const _rcMap = { 0:'READY',1:'CONNECTING',2:'RECONNECTING',3:'IDLE',4:'NEARLY',5:'DISCONNECTED',6:'WAITING_FOR_GUILDS',7:'IDENTIFYING',8:'RESUMING' };
  const statusArr = reactorClients.map(r => {
    const state  = r.rc.ws ? (_rcMap[r.rc.ws.status] || String(r.rc.ws.status)) : 'UNKNOWN';
    const ping   = (r.rc.ws && r.rc.ws.ping != null && r.rc.ws.ping >= 0) ? r.rc.ws.ping : null;
    const ident  = reactorIdentity.get(r.label);
    let uptime = '?';
    if (r.rc.user && r.rc.readyAt) {
      const ms = Date.now() - r.rc.readyAt.getTime();
      const h  = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      uptime = h > 0 ? h + 'j ' + m + 'm' : m + 'm';
    }
    return {
      label: r.label, online: !!r.rc.user,
      tag: r.rc.user ? r.rc.user.tag : null,
      id:  r.rc.user ? r.rc.user.id  : null,
      ping, uptime, state,
      changed: ident ? ident.changed : false,
      prevTag: (ident && ident.changed) ? ident.prevTag : null,
      disabled: disabledReactors.has(r.label),
    };
  });
  store.saveKey('reactor_status', statusArr).catch(e => console.warn('[reactor] gagal simpan status:', e.message));
}

const reactorClients = REACTOR_TOKENS.map((tok, i) => {
  const label = 'reactor-' + (i + 1);
  const rc = new SelfbotClient({ checkUpdate: false, partials: ['MESSAGE', 'CHANNEL', 'REACTION'] });

  rc.on('clientReady', () => {
    if (disabledReactors.has(label)) {
      console.log('[' + label + '] Disabled — destroy setelah auto-reconnect.');
      rc.destroy();
      return;
    }
    const prev = reactorIdentity.get(label);
    if (!prev) {
      reactorIdentity.set(label, { id: rc.user.id, tag: rc.user.tag, changed: false, firstSeenAt: Date.now() });
      console.log('[' + label + '] Online: ' + rc.user.tag + ' | react-only mode');
    } else if (prev.id !== rc.user.id) {
      console.warn('[' + label + '] ⚠️ TOKEN BERUBAH! ' + prev.tag + ' → ' + rc.user.tag);
      reactorIdentity.set(label, { id: rc.user.id, tag: rc.user.tag, changed: true, prevTag: prev.tag, prevId: prev.id, firstSeenAt: prev.firstSeenAt, changedAt: Date.now() });
    } else {
      console.log('[' + label + '] Online kembali: ' + rc.user.tag);
    }
    saveReactorStatus();
  });

  rc.on('error',      e => console.warn('[' + label + '] error:', e.message));
  rc.on('shardError', e => console.warn('[' + label + '] shard error:', e.message));

  rc.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.id !== RUMBLE_BOT_ID) return;
      const emojiName = reaction.emoji.name?.toLowerCase() || '';
      if (!emojiName.includes('swrd') && !emojiName.includes('sword')) return;
      if (reaction.users?.cache?.has(rc.user?.id)) return;
      const msg = reaction.message.partial
        ? await reaction.message.fetch().catch(() => reaction.message)
        : reaction.message;
      await msg.react(reaction.emoji);
      console.log('[' + label + '] ✅ auto-react ' + reaction.emoji.name + ' di #' + (msg.channel?.name || msg.channel?.id));
    } catch (e) { console.warn('[' + label + '] gagal react:', e.message); }
  });

  rc.on('messageCreate', async (message) => {
    if (!message.author?.bot) return;
    await _reactorAutoJoinGiveaway(message, rc, label);
  });

  return { rc, token: tok, label };
});

if (REACTOR_TOKENS.length === 0) {
  console.log('[reactor] Tidak ada token — set DISCORD_REACTOR_TOKENS untuk mengaktifkan.');
}

// -- Sync AI state dari userbot.js setiap 60 detik --
let _aiSyncTs = Date.now();
setInterval(async function() {
  try {
    const _sd = await store.loadAll();
    const _ub = _sd.ai_state_ub;
    if (_ub && _ub.ts && _ub.ts > _aiSyncTs) {
      _aiSyncTs = _ub.ts;
      if (_ub.globalOff) aiGlobalOff = true;
      if (Array.isArray(_ub.disabled)) _ub.disabled.forEach(function(k) { aiDisabled.add(k); });
      console.log('[bot] Sync AI<-userbot: globalOff=' + aiGlobalOff + ' disabled=' + aiDisabled.size);
    }
  } catch (e) { console.warn('[bot] AI sync poll error:', e.message); }
}, 60000);


const MAX_FILES_DM    = 10;
const MAX_FILES_CH    = 10;

// Batas ukuran file per-attachment (200 KB).
const MAX_FILE_BYTES = 200 * 1024;

// Batas total ukuran semua file dalam satu pesan yang dikirim ke AI.
// Jika melebihi ini, file akan diproses satu per satu agar tidak melebihi context window.
// [FIX] Turunkan threshold untuk mencegah AI truncate karena kelebihan token.
const MAX_TOTAL_BYTES_COMBINED = 60 * 1024; // 60KB total sebelum split satu-per-satu

// Discord membatasi maks 10 file per reply.
const DISCORD_MAX_FILES = 10;

// Batas ukuran file sebelum masuk mode chunked (map-reduce).
// Di atas ini, file dibagi ~48KB per chunk agar muat di context window AI.
const CHUNK_THRESHOLD = 55 * 1024;  // 55KB
const CHUNK_SIZE      = 48 * 1024;  // 48KB per chunk

// Pola yang mengindikasikan AI memberikan respons palsu/hallusinasi.
// [FIX BARU] Deteksi konten yang tidak berguna agar bisa di-retry.
const HALLUCINATION_PATTERNS = [
    // === Bahasa Indonesia ===
    /https?:\/\/github\.com\/your[-_]?repo/i,
    /github\.com\/your[-_]?project/i,
    /\byour[-_]?repo\b/i,
    /\[nama[-_ ]?repo\]/i,
    /silakan\s+kunjungi\s+tautan/i,
    /karena\s+keterbatasan\s+platform/i,
    /saya\s+tidak\s+dapat\s+mengirim\s+file/i,
    /saya\s+tidak\s+bisa\s+mengirim\s+file/i,
    // === Bahasa Inggris ===
    /https?:\/\/github\.com\/(user|username|yourusername|owner)\//i,
    /\byour[_-]?project\b/i,
    /\[your[-_]?repo(sitory)?\]/i,
    /due\s+to\s+(platform\s+)?limitations?/i,
    /i\s+cannot\s+(send|provide|attach)\s+(a\s+)?file/i,
    /i\s+am\s+unable\s+to\s+(send|provide|attach)/i,
    /unfortunately[,\s]+i\s+can'?t\s+(send|provide)/i,
    /please\s+visit\s+the\s+link/i,
    /as\s+an\s+ai[,\s]+i\s+(don'?t|cannot|can'?t)\s+have\s+access/i,
  ];
  
const HISTORY_FILE = path.join(require('os').tmpdir(), 'bp_ai_history.json');

// [FIX #10] Per-user AI rate limiting — mencegah spam yang menguras API quota
const AI_USER_COOLDOWN_MS = 3000; // 3 detik antar request per user (channel — sama dengan DM owner)
const AI_USER_COOLDOWN_DM = 3000; // 3 detik untuk DM owner
const _aiUserCooldown = new Map(); // userId → last request timestamp
function _checkUserCooldown(userId, isDMOwner) {
  const now = Date.now();
  const cdMs = isDMOwner ? AI_USER_COOLDOWN_DM : AI_USER_COOLDOWN_MS;
  const last = _aiUserCooldown.get(userId) || 0;
  if (now - last < cdMs) return Math.ceil((cdMs - (now - last)) / 1000);
  _aiUserCooldown.set(userId, now);
  return 0; // 0 = boleh lanjut
}

// ============================================================
// MANAJEMEN RIWAYAT
// ============================================================

// Sliding window: simpan N pasang terakhir, tidak hapus semua.
// Discord dipakai sebagai "database" — bootstrap dari channel saat restart.
const MAX_HISTORY_LEN_DM      = 4;   // 2 pasang percakapan untuk DM owner
const MAX_HISTORY_LEN_CHANNEL = 4;   // 2 turn untuk channel
const MAX_MSG_CHARS           = 500; // potong pesan sangat panjang agar hemat token

function truncateContent(text) {
  if (!text) return '';
  return text.length > MAX_MSG_CHARS ? text.slice(0, MAX_MSG_CHARS) + '…' : text;
}

let allHistory = {};
try {
  if (fs.existsSync(HISTORY_FILE)) {
    allHistory = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    console.log(`[bot] Riwayat dimuat: ${Object.keys(allHistory).length} sesi dari ${HISTORY_FILE}`);
  }
} catch (e) {
  console.error('[bot] Gagal memuat riwayat dari file, mulai dari kosong:', e.message);
  allHistory = {};
}
// [FIX #12b] Jika /tmp kosong setelah redeploy, restore dari data_store
// Dilakukan async agar tidak block startup
(async function restoreHistoryFromStore() {
  try {
    if (Object.keys(allHistory).length > 0) return; // sudah ada dari file, skip
    const stored = await store.loadKey('ai_history_bot').catch(() => null);
    if (stored && stored.data && typeof stored.data === 'object') {
      const entries = Object.keys(stored.data).length;
      if (entries > 0) {
        Object.assign(allHistory, stored.data);
        console.log(`[bot] Riwayat dipulihkan dari store: ${entries} sesi`);
        // Sync ulang ke file
        fs.writeFile(HISTORY_FILE, JSON.stringify(allHistory, null, 2), 'utf-8', () => {});
      }
    }
  } catch (e) { console.warn('[bot] Gagal restore history dari store:', e.message); }
})();

// [FIX #12] Sync history ke data_store agar tidak hilang saat /tmp terhapus (Railway redeploy)
function saveHistory() {
  fs.writeFile(HISTORY_FILE, JSON.stringify(allHistory, null, 2), 'utf-8', (err) => {
    if (err) console.error('[bot] Gagal menyimpan riwayat:', err.message);
  });
  // Backup async ke store (non-blocking, fire-and-forget)
  store.saveKey('ai_history_bot', { data: allHistory, ts: Date.now() })
    .catch(e => console.warn('[bot] Gagal sync history ke store:', e.message));
}

function getHistory(key) {
  if (!allHistory[key]) allHistory[key] = [];
  return allHistory[key];
}

function clearHistory(key) {
  delete allHistory[key];
  delete allHistory[key + '__summary'];
  saveHistory();
}

// Summary disimpan di allHistory dengan suffix '__summary'
function getSummary(key) { return allHistory[key + '__summary'] || null; }
function setSummary(key, text) {
  if (text) allHistory[key + '__summary'] = text.replace(/\n+/g, ' ').trim().slice(0, 300);
  else delete allHistory[key + '__summary'];
  saveHistory();
}

async function summarizeDropped(key, dropped) {
  const existing = getSummary(key);
  const parts = [];
  if (existing) parts.push(`Ringkasan sebelumnya: ${existing}`);
  parts.push(...dropped.map(t => `${t.role === 'user' ? 'User' : 'AI'}: ${t.content}`));
  const convo = parts.join('\n');
  const prompt = `Buat ringkasan singkat (1-2 kalimat, bahasa yang sama dengan percakapan) untuk dijadikan konteks AI:\n\n${convo}`;
  try {
    const { text } = await askGemini(prompt, [], false);
    return text;
  } catch {
    return existing; // fallback ke summary lama jika gagal
  }
}

async function pushHistory(key, historyUserContent, assistantText, isDMOwner) {
  const history = getHistory(key);
  history.push({ role: 'user', content: truncateContent(historyUserContent) });
  history.push({ role: 'assistant', content: truncateContent(assistantText) });

  const maxLen = isDMOwner ? MAX_HISTORY_LEN_DM : MAX_HISTORY_LEN_CHANNEL;
  if (history.length > maxLen) {
    const dropped = history.splice(0, history.length - maxLen);
    const newSummary = await summarizeDropped(key, dropped);
    setSummary(key, newSummary);
  }

  saveHistory();
}

function getHistoryForAI(key, isDMOwner) {
  const history = getHistory(key);
  const maxLen = isDMOwner ? MAX_HISTORY_LEN_DM : MAX_HISTORY_LEN_CHANNEL;
  const recent = history.slice(-maxLen);
  const summary = getSummary(key);
  if (summary) {
    return [
      { role: 'user', content: `[Ringkasan percakapan sebelumnya: ${summary}]` },
      { role: 'assistant', content: 'Baik, saya sudah memahami konteks tersebut.' },
      ...recent,
    ];
  }
  return recent;
}

// Bootstrap: muat ulang konteks dari Discord saat restart
// sehingga history tidak hilang meski /tmp terhapus.
const bootstrapPromises = new Map(); // key → Promise (fix race condition)

  async function bootstrapHistory(key, channel, isDMOwner) {
    if (bootstrapPromises.has(key)) return bootstrapPromises.get(key);
    const p = _doBootstrap(key, channel, isDMOwner);
    bootstrapPromises.set(key, p);
    return p;
  }

  async function _doBootstrap(key, channel, isDMOwner) {
    if (allHistory[key] && allHistory[key].length > 0) return; // sudah ada dari file

    try {
    const botId = channel.client?.user?.id;
    const fetched = await channel.messages.fetch({ limit: 30 });
    const msgs = [...fetched.values()]
      .filter(m => m.content && m.content.trim().length > 2)
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    const history = getHistory(key);
    for (const msg of msgs) {
      const isBot = msg.author.id === botId;
      // Bersihkan mention dari pesan
      const content = msg.content.replace(/<@!?\d+>/g, '').trim();
      if (!content) continue;
      history.push({ role: isBot ? 'assistant' : 'user', content: truncateContent(content) });
    }
    const maxLen = isDMOwner ? MAX_HISTORY_LEN_DM : MAX_HISTORY_LEN_CHANNEL;
    while (history.length > maxLen) history.splice(0, 2);
    console.log(`[bot] bootstrap ${key}: ${history.length} pesan dimuat dari Discord`);
  } catch (e) {
    console.warn(`[bot] bootstrap gagal ${key}:`, e.message);
  }
}

// ============================================================
// EKSTENSI FILE YANG DIDUKUNG
// ============================================================

const TEXT_FILE_EXTENSIONS = [
  'js', 'ts', 'jsx', 'tsx', 'html', 'htm', 'css', 'scss',
  'json', 'jsonc', 'py', 'sh', 'bash', 'sql', 'yaml', 'yml',
  'md', 'mdx', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'php',
  'sol', 'txt', 'env', 'xml', 'csv', 'toml', 'ini', 'conf',
  'vue', 'svelte', 'kt', 'swift', 'rb', 'lua', 'r', 'dart',
];

// ============================================================
// HEALTH SERVER
// ============================================================

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot is running');
}).listen(port, () => console.log(`[bot] Health server di port ${port}`));

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers, // wajib untuk !shuffle — aktifkan juga di Discord Dev Portal
  ],
  // Partials.Message + Partials.Interaction wajib agar interactionCreate
  // tetap terpicu pada pesan yang belum di-cache (termasuk tombol di guild channel).
  partials: [Partials.Channel, Partials.Message, Partials.Interaction],
});

// discord.js v14+: gunakan 'clientReady' bukan 'ready' (ready sudah deprecated).
client.once('clientReady', () => {
  console.log(`[bot] ===== v2025-06-28-INTERACTION-FIX =====`);
  console.log(`[bot] Login sebagai ${client.user.tag}`);
  console.log(`[bot] Partials: ${JSON.stringify(client.options.partials)}`);
  console.log(`[bot] interactionCreate listener count: ${client.listenerCount('interactionCreate')}`);
  // Isi cache top-coins (untuk resolusi simbol + logo) saat startup, lalu refresh berkala.
  refreshTopCoinsCache();
  setInterval(refreshTopCoinsCache, TOP_COINS_TTL_MS);
});
// ⚠️ Jangan log objek error mentah di sini — kalau ini axios error, err.config.headers
// berisi Authorization: Bearer <API key> dan akan bocor ke log Railway.
// safeErr: JANGAN PERNAH log objek Error/axios mentah — err.config.headers bisa berisi
// Authorization: Bearer <API key> dan bocor ke log Railway. Selalu string aman saja.
function safeErrStr(err) {
  if (err == null) return String(err);
  if (typeof err === 'string') return err;
  const msg = (typeof err.message === 'string' && err.message) ? err.message : '[unknown error, no message]';
  const status = err.response?.status || err.status;
  return status ? `${msg} (status ${status})` : msg;
}
function safeStack(err, lines = 20) {
  return (err && typeof err.stack === 'string') ? err.stack.split('\n').slice(0, lines).join('\n') : '';
}
client.on('error', (err) => console.error('[bot] Client error:', safeErrStr(err)));
process.on('unhandledRejection', (err, promise) => {
  console.error('[bot] Unhandled rejection:', safeErrStr(err));
  console.error('[bot] Stack:', safeStack(err, 20));
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function getExt(filename = '') {
  const m = filename.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function makeFile(content, filename) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  return new AttachmentBuilder(buffer, { name: filename });
}

async function downloadAttachmentText(attachment, isOwner = false) {
  const timeout = 120000;
  // Tolak file yang jelas-jelas terlalu besar SEBELUM download agar hemat bandwidth
  if (attachment.size > MAX_FILE_BYTES) {
    throw new Error(
      'File terlalu besar (' + Math.round(attachment.size / 1024) + 'KB). ' +
      'Maksimum ' + Math.round(MAX_FILE_BYTES / 1024) + 'KB per file. ' +
      'Coba pecah file menjadi bagian yang lebih kecil.'
    );
  }
  const { data } = await axios.get(attachment.url, { responseType: 'text', timeout });
  const text = String(data);
  // Double-check setelah download (ukuran Discord kadang beda dengan isi teks)
  if (text.length > MAX_FILE_BYTES) {
    return text.slice(0, MAX_FILE_BYTES) +
      '\n\n// [DIPOTONG: file asli ' + Math.round(text.length / 1024) + 'KB, hanya ' +
      Math.round(MAX_FILE_BYTES / 1024) + 'KB pertama yang dikirim ke AI]';
  }
  return text;
}

// [FIX BARU] Deteksi apakah respons AI mengandung hallusinasi/konten palsu.
function containsHallucination(text) {
  return HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text));
}

// [FIX BARU] Validasi code block — pastikan isinya cukup panjang dan bukan placeholder.
// Minimum 50 karakter — code yang valid pasti lebih panjang dari itu.
function isValidCodeBlock(code) {
  if (!code || code.trim().length < 50) return false;
  const lower = code.toLowerCase();
  // Deteksi placeholder yang biasa AI gunakan saat truncate
  const placeholders = ['// ...', '/* ... */', '// kode selanjutnya', '// rest of', '...omitted', '// tambahkan sisanya'];
  const placeholderCount = placeholders.filter((p) => lower.includes(p)).length;
  // Boleh ada 1 placeholder (komentar biasa), tapi lebih dari 1 curiga truncated
  if (placeholderCount > 1) return false;
  return true;
}

function shouldSendAsFile(question, blocks, isDMOwner) {
  if (!blocks.length) return false;
  const totalLen = blocks.reduce((n, b) => n + b.code.length, 0);
  // Kirim sebagai file HANYA jika: kode panjang (>1500 char), atau user minta file eksplisit
  // Beberapa block pendek tetap dikirim inline — Discord support code block sampai 2000 char
  if (totalLen > 1500) return true;
  return /\b(kirim\s*file|sebagai\s*file|buatkan\s*(file|website|web|halaman|program|script)|download|simpan\s*sebagai)\b/i.test(question);
}

// Kirim jawaban sebagai file attachment.
// [FIX] Validasi setiap code block sebelum dijadikan file — skip block yang kosong/placeholder.
async function replyWithFiles(message, text, blocks, originalFileNames = []) {
  // Filter block yang tidak valid sebelum dijadikan file
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    // Tidak ada block valid — kirim sebagai teks biasa
    const explanation = stripCodeBlocks(text);
    await message.reply({
      content: (explanation || '⚠️ AI tidak menghasilkan kode yang valid. Coba kirim ulang dengan instruksi lebih spesifik.').slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const cappedBlocks = validBlocks.slice(0, DISCORD_MAX_FILES);

  const files = cappedBlocks.map((b, i) => {
    if (originalFileNames.length === 1 && cappedBlocks.length === 1) {
      return makeFile(b.code, originalFileNames[0]);
    }
    if (originalFileNames[i]) {
      return makeFile(b.code, originalFileNames[i]);
    }
    const ext = EXT_MAP[b.lang] || (TEXT_FILE_EXTENSIONS.includes(b.lang) ? b.lang : 'txt');
    const filename = cappedBlocks.length > 1 ? `file_${i + 1}.${ext}` : `output.${ext}`;
    return makeFile(b.code, filename);
  });

  const explanation = stripCodeBlocks(text);
  const truncatedNote = blocks.length > DISCORD_MAX_FILES
    ? `\n\n⚠️ Hanya ${DISCORD_MAX_FILES} file pertama yang dikirim (Discord membatasi maks ${DISCORD_MAX_FILES} file per pesan).`
    : '';

  // [FIX] Tambah info jumlah file yang berhasil divalidasi
  const skippedNote = (blocks.length - validBlocks.length) > 0
    ? `\n⚠️ ${blocks.length - validBlocks.length} code block dilewati karena isinya tidak lengkap.`
    : '';

  await message.reply({
    content: ((explanation || '📎 Ini hasilnya, dikirim sebagai file.') + truncatedNote + skippedNote).slice(0, 2000),
    files,
    flags: MessageFlags.SuppressEmbeds,
  });
}


// ============================================================
// SPLIT PESAN PANJANG — Discord maks 2000 karakter per pesan
// Otomatis pecah jawaban panjang jadi beberapa pesan tanpa memotong di tengah kalimat.
// ============================================================

const DISCORD_MAX_CHARS = 1990;

function splitMessage(text, maxLen = DISCORD_MAX_CHARS) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > maxLen) {
    let splitAt = -1;

    // 1. Pecah di paragraf (baris kosong)
    const paraIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (paraIdx > maxLen * 0.4) splitAt = paraIdx + 2;

    // 2. Pecah di baris baru tunggal
    if (splitAt < 0) {
      const nlIdx = remaining.lastIndexOf('\n', maxLen);
      if (nlIdx > maxLen * 0.4) splitAt = nlIdx + 1;
    }

    // 3. Pecah di akhir kalimat (. ! ?)
    if (splitAt < 0) {
      const sentMatch = remaining.slice(0, maxLen).match(/^[\s\S]*[.!?](?=\s)/);
      if (sentMatch && sentMatch[0].length > maxLen * 0.4) splitAt = sentMatch[0].length;
    }

    // 4. Pecah di spasi
    if (splitAt < 0) {
      const spaceIdx = remaining.lastIndexOf(' ', maxLen);
      if (spaceIdx > maxLen * 0.3) splitAt = spaceIdx + 1;
    }

    // 5. Fallback: potong paksa
    if (splitAt < 0) splitAt = maxLen;

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks.filter(c => c.length > 0);
}

async function sendLongReply(message, text, flags = MessageFlags.SuppressEmbeds) {
    // Max 4 pesan Discord × 1950 karakter = 7800 karakter total
    const MAX_REPLY = 7800;
    const CHUNK_SIZE = 1950;
    var safe = (text || '').trim();
    if (safe.length > MAX_REPLY) {
      var cut = safe.lastIndexOf('\n', MAX_REPLY - 1);
      safe = safe.slice(0, cut > 5000 ? cut : MAX_REPLY - 1) + '\n…';
    }
    const chunks = splitMessage(safe, CHUNK_SIZE);
    if (chunks.length === 0) return;

    await message.reply({ content: chunks[0].slice(0, 2000), flags });

    for (let i = 1; i < chunks.length; i++) {
      await new Promise(r => setTimeout(r, 300));
      const prefix = `*(lanjutan ${i + 1}/${chunks.length})*\n`;
      const body = chunks[i].slice(0, 2000 - prefix.length);
      await message.channel.send({ content: prefix + body, flags });
    }
  }

// ============================================================
// CRYPTO CONVERSION -- menggunakan CoinGecko API
// Contoh: "5 usdc to idr" --> "5 $USDC ke IDR = Rp 82.500"
// ============================================================
// ============================================================
// TOP COINS CACHE -- daftar lengkap (top ~1000 by market cap) dari CoinGecko /coins/markets
// Dipakai untuk resolusi simbol -> coinId + logo tanpa perlu hardcode satu-satu,
// dan sebagai daftar "aman" untuk command tanpa prefix (mis. "1 btc") supaya tidak
// salah tangkap kata biasa yang kebetulan cocok dengan ticker koin obscure.
// ============================================================
const topCoinsCache = {
  bySymbol: new Map(), // symbol(lower) -> { id, symbol, name, image, market_cap_rank }
  fetchedAt: 0,
};
const TOP_COINS_TTL_MS = 60 * 60 * 1000; // refresh tiap 1 jam
const TOP_COINS_PAGES = 4; // 4 x 250 = top 1000 coin by market cap

async function refreshTopCoinsCache() {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { Accept: 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  var next = new Map();
  try {
    for (var page = 1; page <= TOP_COINS_PAGES; page++) {
      var resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
        params: {
          vs_currency: 'usd',
          order: 'market_cap_desc',
          per_page: 250,
          page: page,
          sparkline: false,
        },
        headers: headers,
        timeout: 10000,
      });
      var list = resp.data || [];
      if (list.length === 0) break;
      list.forEach(function (c) {
        var sym = (c.symbol || '').toLowerCase();
        if (!sym) return;
        var existing = next.get(sym);
        // Simpan yang market_cap_rank paling tinggi (angka lebih kecil = lebih besar market cap)
        if (!existing || (c.market_cap_rank != null && (existing.market_cap_rank == null || c.market_cap_rank < existing.market_cap_rank))) {
          next.set(sym, {
            id: c.id,
            symbol: sym,
            name: c.name,
            image: c.image || null,
            market_cap_rank: c.market_cap_rank,
          });
        }
      });
      // jeda kecil antar page biar tidak kena rate limit CoinGecko
      await new Promise(function (r) { setTimeout(r, 300); });
    }
    if (next.size > 0) {
      topCoinsCache.bySymbol = next;
      topCoinsCache.fetchedAt = Date.now();
      console.log('[topcoins] Cache diperbarui: ' + next.size + ' coin (top ' + (TOP_COINS_PAGES * 250) + ' by market cap)');
    }
  } catch (e) {
    console.warn('[topcoins] Gagal refresh cache:', e.message);
  }
}

function getTopCoin(symbol) {
  return topCoinsCache.bySymbol.get((symbol || '').toLowerCase()) || null;
}

const COIN_ID_MAP = {
  btc: 'bitcoin', bitcoin: 'bitcoin',
  eth: 'ethereum', ethereum: 'ethereum',
  usdc: 'usd-coin',
  usdt: 'tether', tether: 'tether',
  bnb: 'binancecoin',
  sol: 'solana', solana: 'solana',
  xrp: 'ripple', ripple: 'ripple',
  ada: 'cardano', cardano: 'cardano',
  doge: 'dogecoin', dogecoin: 'dogecoin',
  dot: 'polkadot', polkadot: 'polkadot',
  avax: 'avalanche-2', avalanche: 'avalanche-2',
  matic: 'matic-network', polygon: 'matic-network',
  link: 'chainlink', chainlink: 'chainlink',
  ltc: 'litecoin', litecoin: 'litecoin',
  shib: 'shiba-inu', shiba: 'shiba-inu',
  uni: 'uniswap', uniswap: 'uniswap',
  atom: 'cosmos', cosmos: 'cosmos',
  near: 'near',
  apt: 'aptos', aptos: 'aptos',
  arb: 'arbitrum', arbitrum: 'arbitrum',
  op: 'optimism', optimism: 'optimism',
  inj: 'injective-protocol', injective: 'injective-protocol',
  sui: 'sui',
  ton: 'the-open-network',
  pepe: 'pepe',
  trx: 'tron', tron: 'tron',
  xlm: 'stellar', stellar: 'stellar',
  icp: 'internet-computer',
  fil: 'filecoin', filecoin: 'filecoin',
  sand: 'the-sandbox',
  axs: 'axie-infinity',
};

// vs_currencies yang didukung CoinGecko sebagai target
const SUPPORTED_VS = new Set([
  'idr','usd','eur','gbp','jpy','krw','cny','sgd','aud','myr',
  'thb','php','inr','vnd','brl','try','rub','cad','chf','hkd',
  'btc','eth','bnb','sats',
]);

// Cache dinamis untuk token yang tidak ada di COIN_ID_MAP
const dynamicCoinIdCache = {};
// Cache harga USD dari DexScreener untuk token micro-cap
const dynamicDexCache = {};

// Cari harga USD token dari DexScreener (fallback saat CoinGecko tidak kenal token)
async function resolveDexPrice(symbol) {
  const lower = symbol.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(dynamicDexCache, lower)) return dynamicDexCache[lower];
  try {
    const resp = await axios.get('https://api.dexscreener.com/latest/dex/search', {
      params: { q: symbol }, timeout: 7000
    });
    const pairs = ((resp.data && resp.data.pairs) || [])
      .filter(function(p) {
        return p.baseToken && p.baseToken.symbol &&
               p.baseToken.symbol.toLowerCase() === lower && p.priceUsd;
      })
      .sort(function(a, b) {
        return ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0);
      });
    const best = pairs[0] || null;
    if (best) {
      const price = parseFloat(best.priceUsd);
      const quoteSym = (best.quoteToken && best.quoteToken.symbol) ? best.quoteToken.symbol : '?';
      dynamicDexCache[lower] = {
        priceUsd: price,
        pair: best.baseToken.symbol + '/' + quoteSym,
        dex: best.dexId || 'dex',
        chain: best.chainId || 'chain',
        imageUrl: (best.info && best.info.imageUrl) || null
      };
      console.log('[dex] Found ' + symbol.toUpperCase() + ' via DexScreener: USD ' + price +
        ' (' + (best.dexId || '') + '/' + (best.chainId || '') + ')');
    } else {
      dynamicDexCache[lower] = null;
      console.log('[dex] ' + symbol.toUpperCase() + ' tidak ditemukan di DexScreener');
    }
    return dynamicDexCache[lower];
  } catch (e) {
    console.warn('[dex] resolveDexPrice gagal untuk "' + symbol + '":', e.message);
    dynamicDexCache[lower] = null;
    return null;
  }
}

// Kurs USD->IDR (di-cache 30 menit) dipakai sebagai fallback saat CMC gagal kasih quote IDR
// (plan Basic CMC sering cuma boleh 1 convert currency / kadang IDR ditolak), dan untuk
// hasil dari DexScreener yang memang tidak pernah punya quote IDR sama sekali.
let _usdIdrRateCache = { rate: null, ts: 0 };
async function getUsdToIdrRate() {
  const now = Date.now();
  if (_usdIdrRateCache.rate && (now - _usdIdrRateCache.ts) < 30 * 60 * 1000) {
    return _usdIdrRateCache.rate;
  }
  try {
    const resp = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 6000 });
    const rate = resp.data && resp.data.rates && resp.data.rates.IDR;
    if (typeof rate === 'number' && rate > 0) {
      _usdIdrRateCache = { rate: rate, ts: now };
      return rate;
    }
    return _usdIdrRateCache.rate || null;
  } catch (e) {
    console.warn('[fx] Gagal ambil kurs USD->IDR:', e.message);
    return _usdIdrRateCache.rate || null;
  }
}

// Fallback harga + logo dari CoinMarketCap, dipakai saat CoinGecko tidak punya data
// token tersebut atau sedang bermasalah (mis. rate limit). Butuh COINMARKETCAP_API_KEY.
async function fetchFromCMC(symbol) {
  var key = process.env.COINMARKETCAP_API_KEY;
  if (!key) return null;
  var sym = symbol.toUpperCase();
  var headers = { 'X-CMC_PRO_API_KEY': key, Accept: 'application/json' };
  try {
    // Plan gratis/basic CMC cuma izinkan 1 convert currency per request,
    // jadi USD dan IDR harus dua panggilan terpisah.
    var usdResp = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
      params: { symbol: sym, convert: 'USD' }, headers: headers, timeout: 8000
    });
    var usdEntry = usdResp.data && usdResp.data.data && usdResp.data.data[sym];
    if (Array.isArray(usdEntry)) usdEntry = usdEntry[0];
    var usd = usdEntry && usdEntry.quote && usdEntry.quote.USD ? usdEntry.quote.USD.price : null;
    if (usd == null) return null;
    var idr = null;
    try {
      var idrResp = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
        params: { symbol: sym, convert: 'IDR' }, headers: headers, timeout: 8000
      });
      var idrEntry = idrResp.data && idrResp.data.data && idrResp.data.data[sym];
      if (Array.isArray(idrEntry)) idrEntry = idrEntry[0];
      idr = idrEntry && idrEntry.quote && idrEntry.quote.IDR ? idrEntry.quote.IDR.price : null;
    } catch (idrErr) {
      console.warn('[cmc] Gagal ambil IDR untuk ' + sym + ' (plan mungkin tidak izinkan convert IDR):', idrErr.message);
    }
    // Plan CMC (terutama Basic/free) kadang menolak convert selain USD -> pakai kurs forex sbg fallback
    if (idr == null) {
      var fxRate = await getUsdToIdrRate();
      if (fxRate) idr = usd * fxRate;
    }
    var logo = null;
    try {
      var infoResp = await axios.get('https://pro-api.coinmarketcap.com/v2/cryptocurrency/info', {
        params: { symbol: sym }, headers: headers, timeout: 6000
      });
      var infoEntry = infoResp.data && infoResp.data.data && infoResp.data.data[sym];
      if (Array.isArray(infoEntry)) infoEntry = infoEntry[0];
      logo = (infoEntry && infoEntry.logo) || null;
    } catch (infoErr) {
      console.warn('[cmc] Gagal ambil logo untuk ' + sym + ':', infoErr.message);
    }
    return { usd: usd, idr: idr, logo: logo };
  } catch (e) {
    console.warn('[cmc] fetchFromCMC gagal untuk "' + symbol + '":', e.message);
    return null;
  }
}

// Ambil logo: cache top-coins (gratis, tanpa network) -> fetchCoinThumbnail (network)
async function getCoinImage(sym, coinId, cgKey) {
  var top = getTopCoin(sym);
  if (top && top.image) return top.image;
  return await fetchCoinThumbnail(coinId, cgKey);
}

// Resolusi coin ID: hardcoded map -> cache top-coins -> cache dinamis -> CoinGecko /search
async function resolveCoinId(symbol) {
  const lower = symbol.toLowerCase();
  if (COIN_ID_MAP[lower]) return COIN_ID_MAP[lower];
  var topMatch = getTopCoin(lower);
  if (topMatch) return topMatch.id;
  if (Object.prototype.hasOwnProperty.call(dynamicCoinIdCache, lower)) return dynamicCoinIdCache[lower];
  try {
    const cgKey = process.env.COINGECKO_API_KEY || '';
    const headers = { Accept: 'application/json' };
    if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
    const resp = await axios.get(
      'https://api.coingecko.com/api/v3/search?query=' + encodeURIComponent(lower),
      { headers: headers, timeout: 6000 }
    );
    const coins = (resp.data && resp.data.coins) ? resp.data.coins : [];
    const exact = coins.find(function(c) { return c.symbol.toLowerCase() === lower; });
    const match = exact || coins[0] || null;
    dynamicCoinIdCache[lower] = match ? match.id : null;
    if (match) console.log('[crypto] Found: ' + symbol + ' -> ' + match.id + ' (' + match.name + ')');
    else console.log('[crypto] Tidak ditemukan di CoinGecko: ' + symbol.toUpperCase());
    return dynamicCoinIdCache[lower];
  } catch (e) {
    console.warn('[crypto] resolveCoinId gagal untuk "' + symbol + '":', e.message);
    dynamicCoinIdCache[lower] = null;
    return null;
  }
}

function formatCryptoAmount(amount, currency) {
  var cur = currency.toLowerCase();
  if (cur === 'btc' || cur === 'sats') {
    return amount.toFixed(8) + ' ' + cur.toUpperCase();
  }
  if (cur === 'eth' || cur === 'bnb') {
    return amount.toFixed(6) + ' ' + cur.toUpperCase();
  }
  if (cur === 'idr' || cur === 'krw' || cur === 'vnd') {
    return 'Rp ' + Math.round(amount).toLocaleString('id-ID');
  }
  if (cur === 'jpy') {
    return Math.round(amount).toLocaleString('id-ID') + ' JPY';
  }
  if (amount >= 1) {
    return amount.toFixed(2) + ' ' + cur.toUpperCase();
  }
  return amount.toPrecision(6) + ' ' + cur.toUpperCase();
}

function parseConvAmount(raw) {
  var s = raw.toLowerCase().replace(/,/g, '.');
  var mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; s = s.slice(0, -1); }
  return parseFloat(s) * mult;
}


// ============================================================
// TWITTER USERNAME HISTORY -- menggunakan memory.lol API
// Contoh: "twit monad" atau "twit elonmusk,vitalik"
// ============================================================
function detectTwitterQuery(text) {
  const m = text.match(/^twit\s+([a-zA-Z0-9_]+(?:,[a-zA-Z0-9_]+)*)$/i);
  if (!m) return null;
  return { usernames: m[1].split(',').map(u => u.trim()) };
}

// Ambil data satu username dari memory.lol
async function _fetchOneTwitterHistory(uname, mlToken) {
  const url = 'https://api.memory.lol/v1/tw/' + encodeURIComponent(uname);
  let resp;
  if (mlToken) {
    resp = await axios.post(
      url,
      'token=' + encodeURIComponent(mlToken),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 }
    );
  } else {
    resp = await axios.get(url, { timeout: 10000 });
  }
  return (resp.data && resp.data.accounts) ? resp.data.accounts : [];
}

// Cari earliest snapshot Wayback Machine untuk satu username
async function _waybackEarliest(uname) {
  try {
    const wbResp = await axios.get('https://web.archive.org/cdx/search/cdx', {
      params: { url: 'twitter.com/' + uname, output: 'json', fl: 'timestamp', filter: 'statuscode:200', limit: 1, from: '20060101' },
      timeout: 7000,
    });
    const rows = wbResp.data;
    if (Array.isArray(rows) && rows.length >= 2) {
      const ts = rows[1][0];
      return ts.slice(0,4) + '-' + ts.slice(4,6) + '-' + ts.slice(6,8);
    }
  } catch (_) {}
  return null;
}

async function fetchTwitterHistory(usernames) {
  const mlToken = process.env.MEMORYLOL_TOKEN;
  const isFullAccess = !!mlToken;

  // Request per username secara paralel (API hanya terima satu username per endpoint)
  const [accountsPerUser, wbDates] = await Promise.all([
    Promise.all(usernames.map(u => _fetchOneTwitterHistory(u, mlToken).catch(() => []))),
    // Wayback Machine — maks 3 username agar tidak timeout
    Promise.all(usernames.slice(0, 3).map(u => _waybackEarliest(u))),
  ]);

  // Gabungkan Wayback dates
  const wbEarliest = {};
  usernames.slice(0, 3).forEach((u, i) => { if (wbDates[i]) wbEarliest[u.toLowerCase()] = wbDates[i]; });

  // Gabungkan semua accounts (hapus duplikat berdasarkan id_str)
  const seenIds = new Set();
  const accounts = [];
  for (const accs of accountsPerUser) {
    for (const acc of accs) {
      const id = acc.id_str || String(acc.id);
      if (!seenIds.has(id)) { seenIds.add(id); accounts.push(acc); }
    }
  }

  if (accounts.length === 0) {
    let msg = '\u274C Tidak ada data history Twitter untuk **@' + usernames.join(', @') + '**\n';
    msg += '_(Akun tidak dikenali dalam database memory.lol)_';
    for (const [uname, date] of Object.entries(wbEarliest)) {
      msg += '\n\n\uD83D\uDDC4\uFE0F **Wayback Machine**: @' + uname + ' pertama diarsipkan sekitar **' + date + '**';
    }
    return [msg];
  }

  const accessNote = isFullAccess
    ? '_(akses penuh \u2014 full history)_'
    : '_(akses publik \u2014 60 hari | ketik **twit login** di DM untuk akses penuh)_';

  const header = '\uD83D\uDC26 **Twitter/X Username History** untuk **@' + usernames.join(', @') + '**\n' + accessNote + '\n';

  const blocks = [];
  for (const acc of accounts) {
    const accId = acc.id_str || String(acc.id);
    const screenNames = acc['screen_names'] || acc['screen-names'] || {};
    const entries = Object.keys(screenNames).map(sn => {
      const dates = screenNames[sn];
      if (!dates || (Array.isArray(dates) && dates.length === 0)) {
        return { sn, label: '_(tanggal tidak diketahui)_', hasDate: false };
      }
      if (Array.isArray(dates) && dates.length === 1) {
        return { sn, label: 'terlihat: ' + dates[0], hasDate: true };
      }
      if (Array.isArray(dates) && dates.length >= 2) {
        return { sn, label: dates[0] + ' \u2192 ' + dates[dates.length - 1], hasDate: true };
      }
      return { sn, label: String(dates), hasDate: false };
    });
    entries.sort((a, b) => (b.hasDate ? 1 : 0) - (a.hasDate ? 1 : 0));
    const nameList = entries.map(e => '  \u2022 **@' + e.sn + '** \u2014 ' + e.label).join('\n');
    let block = '\uD83C\uDD94 ID: ' + accId + '\n' + nameList;
    for (const [uname, date] of Object.entries(wbEarliest)) {
      if (Object.keys(screenNames).some(sn => sn.toLowerCase() === uname)) {
        block += '\n  \uD83D\uDDC4\uFE0F Wayback: @' + uname + ' diarsipkan pertama ~**' + date + '**';
      }
    }
    blocks.push(block);
  }

  // Bagi hasil menjadi pesan-pesan ≤ 2000 karakter
  const messages = [];
  let cur = header + '\n';
  for (const block of blocks) {
    const add = block + '\n\n';
    if (cur.length + add.length > 1950) { messages.push(cur.trimEnd()); cur = add; }
    else { cur += add; }
  }
  if (cur.trim()) messages.push(cur.trimEnd());
  return messages.length ? messages : [header + '_(tidak ada data)_'];
}


// ============================================================
// OSINT SCAN — URL / Domain / IP safety check
// Sumber gratis: URLhaus, ThreatFox, URLscan.io (tanpa API key)
// Opsional: AbuseIPDB (ABUSEIPDB_API_KEY), VirusTotal (VIRUSTOTAL_API_KEY)
// Command: scan <url|domain|ip>
// ============================================================
function detectOsintScan(text) {
  const m = text.match(/^scan\s+(.+)$/i);
  if (!m) return null;
  // Defang: hxxp→http, [.]→. agar bisa diproses
  const clean = m[1].trim()
    .replace(/hxxps?/gi, s => s.toLowerCase().replace('hxxp', 'http'))
    .replace(/\[\.\]/g, '.').replace(/\[dot\]/gi, '.');
  let type;
  if (/^https?:\/\//i.test(clean)) type = 'url';
  else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(clean)) type = 'ip';
  else if (/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/i.test(clean)) type = 'domain';
  else return null;
  return { target: clean, type };
}

async function runOsintScan(target, type) {
  const results = {};
  const tasks = [];

  // URLhaus — malware URL database (gratis, tanpa key)
  if (type === 'url' || type === 'domain') {
    const uhTarget = type === 'url' ? target : 'http://' + target;
    tasks.push(
      axios.post('https://urlhaus-api.abuse.ch/v1/url/',
        'url=' + encodeURIComponent(uhTarget),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
      ).then(r => { results.urlhaus = r.data; }).catch(() => { results.urlhaus = { error: true }; })
    );
  }

  // ThreatFox — IOC database (gratis, tanpa key)
  tasks.push(
    axios.post('https://threatfox-api.abuse.ch/api/v1/',
      { query: 'search_ioc', search_term: target },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    ).then(r => { results.threatfox = r.data; }).catch(() => { results.threatfox = { error: true }; })
  );

  // URLscan.io — passive scan search (gratis, tanpa key)
  const usQ = type === 'ip' ? `page.ip:"${target}"` : type === 'url' ? `page.url:"${target}"` : `page.domain:"${target}"`;
  tasks.push(
    axios.get('https://urlscan.io/api/v1/search/', { params: { q: usQ, size: 5 }, timeout: 8000 })
      .then(r => { results.urlscan = r.data; }).catch(() => { results.urlscan = { error: true }; })
  );

  // AbuseIPDB — IP reputation (opsional, butuh ABUSEIPDB_API_KEY)
  if (type === 'ip' && process.env.ABUSEIPDB_API_KEY) {
    tasks.push(
      axios.get('https://api.abuseipdb.com/api/v2/check', {
        params: { ipAddress: target, maxAgeInDays: 90 },
        headers: { Key: process.env.ABUSEIPDB_API_KEY, Accept: 'application/json' }, timeout: 8000
      }).then(r => { results.abuseipdb = r.data; }).catch(() => { results.abuseipdb = { error: true }; })
    );
  }

  // VirusTotal — multi-engine scan (opsional, butuh VIRUSTOTAL_API_KEY)
  if (process.env.VIRUSTOTAL_API_KEY) {
    let vtType, vtId = target;
    if (type === 'url') { vtType = 'urls'; vtId = Buffer.from(target).toString('base64').replace(/=+$/, ''); }
    else if (type === 'ip') vtType = 'ip_addresses';
    else vtType = 'domains';
    tasks.push(
      axios.get(`https://www.virustotal.com/api/v3/${vtType}/${vtId}`, {
        headers: { 'x-apikey': process.env.VIRUSTOTAL_API_KEY }, timeout: 10000
      }).then(r => { results.virustotal = r.data; }).catch(() => { results.virustotal = { error: true }; })
    );
  }

  await Promise.all(tasks);

  // ── Format output ───────────────────────────────────────────
  let danger = 0; // 0=bersih 1=mencurigakan 2=berbahaya
  const lines = [];
  const typeEmoji = { url: '🔗', domain: '🌐', ip: '🖥️' }[type];
  const typeLabel = { url: 'URL', domain: 'Domain', ip: 'IP Address' }[type];

  lines.push(`${typeEmoji} **OSINT Scan — ${typeLabel}**`);
  lines.push(`\`${target}\``);
  lines.push('');

  // URLhaus
  if (results.urlhaus && !results.urlhaus.error) {
    const uh = results.urlhaus;
    if (uh.query_status === 'is_listed') {
      danger = Math.max(danger, 2);
      lines.push(`🚨 **URLhaus:** Terdeteksi malware/phishing (status: ${uh.url_status || 'listed'})`);
      if (uh.threat) lines.push(`   └ Threat: ${uh.threat}`);
      if (uh.tags && uh.tags.length) lines.push(`   └ Tags: ${uh.tags.join(', ')}`);
    } else {
      lines.push('✅ **URLhaus:** Tidak ada di database malware');
    }
  } else if (results.urlhaus) {
    lines.push('⏸️ **URLhaus:** Timeout / error');
  }

  // ThreatFox
  if (results.threatfox && !results.threatfox.error) {
    const tf = results.threatfox;
    if (tf.query_status === 'ok' && Array.isArray(tf.data) && tf.data.length > 0) {
      danger = Math.max(danger, 2);
      const d = tf.data[0];
      lines.push('🚨 **ThreatFox:** IOC dikenal berbahaya!');
      if (d.threat_type) lines.push(`   └ Threat type: ${d.threat_type}`);
      if (d.malware_printable || d.malware) lines.push(`   └ Malware: ${d.malware_printable || d.malware}`);
      if (d.confidence_level != null) lines.push(`   └ Confidence: ${d.confidence_level}%`);
    } else {
      lines.push('✅ **ThreatFox:** Tidak ada di database IOC');
    }
  } else if (results.threatfox) {
    lines.push('⏸️ **ThreatFox:** Timeout / error');
  }

  // URLscan.io
  if (results.urlscan && !results.urlscan.error) {
    const total = results.urlscan.total || 0;
    if (total > 0) {
      const r0 = results.urlscan.results[0];
      const malicious = r0?.verdicts?.overall?.malicious;
      const score = r0?.verdicts?.overall?.score || 0;
      if (malicious) {
        danger = Math.max(danger, 2);
        lines.push(`🚨 **URLscan.io:** Ditandai berbahaya (${total} scan ditemukan)`);
      } else if (score > 50) {
        danger = Math.max(danger, 1);
        lines.push(`⚠️ **URLscan.io:** Score ${score} — mencurigakan (${total} scan)`);
      } else {
        lines.push(`✅ **URLscan.io:** ${total} scan, tidak ada flag bahaya`);
        if (r0?.page?.country) lines.push(`   └ Server: ${r0.page.country} ${r0.page.server || ''}`.trim());
      }
    } else {
      lines.push('✅ **URLscan.io:** Belum pernah di-scan');
    }
  } else if (results.urlscan) {
    lines.push('⏸️ **URLscan.io:** Timeout / error');
  }

  // AbuseIPDB
  if (results.abuseipdb && !results.abuseipdb.error) {
    const ab = results.abuseipdb.data;
    if (ab) {
      const score = ab.abuseConfidenceScore || 0;
      if (score >= 80) { danger = Math.max(danger, 2); lines.push(`🚨 **AbuseIPDB:** Score ${score}% — IP sangat berbahaya`); }
      else if (score >= 25) { danger = Math.max(danger, 1); lines.push(`⚠️ **AbuseIPDB:** Score ${score}% — ada laporan abuse`); }
      else { lines.push(`✅ **AbuseIPDB:** Score ${score}% — relatif bersih`); }
      const info = [ab.countryCode, ab.isp].filter(Boolean).join(' · ');
      if (info) lines.push(`   └ ${info}`);
      if (ab.totalReports > 0) lines.push(`   └ Total laporan: ${ab.totalReports}`);
    }
  }

  // VirusTotal
  if (results.virustotal && !results.virustotal.error) {
    const stats = results.virustotal.data?.attributes?.last_analysis_stats;
    if (stats) {
      const mal = stats.malicious || 0;
      const sus = stats.suspicious || 0;
      const total = Object.values(stats).reduce((a, b) => a + b, 0);
      if (mal > 0) { danger = Math.max(danger, 2); lines.push(`🚨 **VirusTotal:** ${mal}/${total} engine — malicious`); }
      else if (sus > 0) { danger = Math.max(danger, 1); lines.push(`⚠️ **VirusTotal:** ${sus}/${total} engine — suspicious`); }
      else { lines.push(`✅ **VirusTotal:** 0/${total} engine bersih`); }
    }
  } else if (results.virustotal && process.env.VIRUSTOTAL_API_KEY) {
    lines.push('⏸️ **VirusTotal:** Error / tidak ditemukan');
  }

  lines.push('');
  const verdict = ['✅ **BERSIH** — tidak ada ancaman terdeteksi',
                   '⚠️ **MENCURIGAKAN** — lanjutkan dengan hati-hati',
                   '🚨 **BERBAHAYA** — jangan klik/buka ini!'][danger];
  lines.push(`**Verdict:** ${verdict}`);

  const missingKeys = [];
  if (!process.env.ABUSEIPDB_API_KEY) missingKeys.push('ABUSEIPDB\_API\_KEY');
  if (!process.env.VIRUSTOTAL_API_KEY) missingKeys.push('VIRUSTOTAL\_API\_KEY');
  if (missingKeys.length) lines.push(`\n_💡 Set ${missingKeys.join(' / ')} di env untuk cek tambahan_`);

  return lines.join('\n');
}


// ============================================================
// RECON — DNS, subdomain, whois via HackerTarget (gratis, no key)
// Command: recon <domain>
// ============================================================
async function runRecon(domain) {
  const ht = 'https://api.hackertarget.com';
  const [dns, sub, whoisR] = await Promise.all([
    axios.get(`${ht}/dnslookup/?q=${encodeURIComponent(domain)}`, { timeout: 10000 }).then(r => r.data).catch(() => null),
    axios.get(`${ht}/hostsearch/?q=${encodeURIComponent(domain)}`, { timeout: 10000 }).then(r => r.data).catch(() => null),
    axios.get(`${ht}/whois/?q=${encodeURIComponent(domain)}`, { timeout: 10000 }).then(r => r.data).catch(() => null),
  ]);
  const lines = [];
  lines.push(`\u{1F310} **Recon \u2014 ${domain}**`);
  lines.push('');
  if (dns && !dns.includes('error')) {
    const dnsLines = dns.trim().split('\n').slice(0, 10);
    lines.push('**\u{1F4CB} DNS Records:**');
    lines.push('```');
    dnsLines.forEach(l => lines.push(l));
    if (dns.trim().split('\n').length > 10) lines.push(`... +${dns.trim().split('\n').length - 10} more`);
    lines.push('```');
  }
  if (sub && !sub.includes('error')) {
    const subList = sub.trim().split('\n').filter(Boolean);
    lines.push(`**\u{1F577}\uFE0F Subdomains (${subList.length} ditemukan):**`);
    lines.push('```');
    subList.slice(0, 15).forEach(l => lines.push(l));
    if (subList.length > 15) lines.push(`... +${subList.length - 15} more`);
    lines.push('```');
  }
  if (whoisR && !whoisR.includes('error')) {
    const important = whoisR.split('\n').filter(l =>
      /registrar|creation|expir|updated|registrant|name server|org:|country/i.test(l)
    ).slice(0, 8);
    if (important.length) {
      lines.push('**\u{1F4DD} Whois (ringkas):**');
      lines.push('```');
      important.forEach(l => lines.push(l.trim()));
      lines.push('```');
    }
  }
  if (lines.length <= 2) lines.push('\u23F8\uFE0F Tidak ada data \u2014 domain tidak valid atau API timeout');
  return lines.join('\n');
}

// ============================================================
// PORTS — open ports + CVE via Shodan InternetDB (gratis, no key)
// Command: ports <ip>
// ============================================================
async function runPorts(ip) {
  const lines = [];
  lines.push(`\u{1F5A5}\uFE0F **Port Scan \u2014 ${ip}**`);
  lines.push('');
  try {
    const { data } = await axios.get(`https://internetdb.shodan.io/${ip}`, { timeout: 10000 });
    if (data.ports && data.ports.length) {
      lines.push(`**\u{1F513} Open Ports (${data.ports.length}):** ${data.ports.join(', ')}`);
    } else {
      lines.push('\u2705 **Open Ports:** Tidak ada port terbuka terdeteksi');
    }
    if (data.hostnames && data.hostnames.length)
      lines.push(`**\u{1F310} Hostnames:** ${data.hostnames.join(', ')}`);
    if (data.tags && data.tags.length)
      lines.push(`**\u{1F3F7}\uFE0F Tags:** ${data.tags.join(', ')}`);
    if (data.vulns && data.vulns.length) {
      lines.push('');
      lines.push(`**\u{1F6A8} CVE Ditemukan (${data.vulns.length}):**`);
      lines.push('```');
      data.vulns.slice(0, 10).forEach(v => lines.push(v));
      if (data.vulns.length > 10) lines.push(`... +${data.vulns.length - 10} more`);
      lines.push('```');
      lines.push('> \u26A0\uFE0F IP ini memiliki kerentanan yang diketahui publik');
    } else {
      lines.push('\u2705 **CVE:** Tidak ada kerentanan diketahui');
    }
    if (data.cpes && data.cpes.length)
      lines.push(`**\u2699\uFE0F Software:** ${data.cpes.slice(0, 5).join(', ')}`);
  } catch (e) {
    if (e.response && e.response.status === 404)
      lines.push('\u2705 IP tidak ditemukan di database Shodan \u2014 tidak ada data port/CVE');
    else
      lines.push('\u23F8\uFE0F Shodan timeout atau error: ' + e.message);
  }
  lines.push('');
  lines.push('_Sumber: Shodan InternetDB (gratis, no key)_');
  return lines.join('\n');
}

// ============================================================
// WHOIS — domain info via HackerTarget (gratis, no key)
// Command: whois <domain>
// ============================================================
async function runWhois(domain) {
  const lines = [];
  lines.push(`\u{1F4DD} **Whois \u2014 ${domain}**`);
  lines.push('');
  try {
    const { data } = await axios.get(
      `https://api.hackertarget.com/whois/?q=${encodeURIComponent(domain)}`,
      { timeout: 10000 }
    );
    if (!data || data.includes('error') || data.includes('API count')) {
      lines.push('\u23F8\uFE0F Whois tidak tersedia: ' + (data || 'timeout'));
      return lines.join('\n');
    }
    const important = data.split('\n').filter(l =>
      /registrar|creation date|expir|updated date|registrant|name server|org:|country|status|dnssec/i.test(l)
    );
    lines.push('```');
    (important.length ? important.slice(0, 20) : data.trim().split('\n').slice(0, 25))
      .forEach(l => lines.push(l.trim()));
    lines.push('```');
  } catch (e) {
    lines.push('\u23F8\uFE0F Whois gagal: ' + e.message);
  }
  return lines.join('\n');
}

// ============================================================
// LEAK CHECK — cek email breach via LeakCheck.io
// Command: leak <email>
// Key: LEAKCHECK_API_KEY (free tier 50 req/hari — leakcheck.io)
// ============================================================
async function runLeakCheck(email) {
  const lines = [];
  lines.push(`\u{1F4E7} **Infostealer Check \u2014 ${email}**`);
  lines.push('');
  try {
    const { data } = await axios.get(
      'https://cavalier.hudsonrock.com/api/json/v2/osint-tools/search-by-email',
      { params: { email }, timeout: 12000 }
    );

    const stealers = data.stealers || [];
    if (!stealers.length) {
      lines.push('\u2705 **Tidak ditemukan** di database infostealer yang diketahui.');
      return lines.join('\n');
    }

    const totalUser = data.total_user_services || 0;
    const totalCorp = data.total_corporate_services || 0;
    lines.push(`\u{1F6A8} **Ditemukan di ${stealers.length} infeksi infostealer!**`);
    if (totalUser) lines.push(`\u{1F4CA} Akun user terdampak: **${totalUser.toLocaleString()}**`);
    if (totalCorp) lines.push(`\u{1F3E2} Layanan korporat terdampak: **${totalCorp.toLocaleString()}**`);
    lines.push('');

    stealers.slice(0, 5).forEach((s, i) => {
      const date = s.date_compromised ? new Date(s.date_compromised).toLocaleDateString('id-ID', { year:'numeric', month:'short', day:'numeric' }) : 'Tidak diketahui';
      lines.push(`**[${i+1}] Infeksi ${date}**`);
      if (s.operating_system && s.operating_system !== 'Not Found') lines.push(`   \u{1F4BB} OS: ${s.operating_system}`);
      if (s.computer_name && s.computer_name !== 'Not Found') lines.push(`   \u{1F5A5}\uFE0F Komputer: ${s.computer_name}`);
      if (s.ip && s.ip !== 'Not Found') lines.push(`   \u{1F4CD} IP: ${s.ip}`);
      if (s.malware_path && s.malware_path !== 'Not Found') lines.push(`   \u{1F9F9} Malware: \`${s.malware_path.trim()}\``);
      if (s.top_logins && s.top_logins.filter(Boolean).length) {
        lines.push(`   \u{1F464} Login bocor: ${s.top_logins.filter(Boolean).slice(0, 3).join(', ')}`);
      }
      if (s.total_user_services) lines.push(`   \u{1F4C1} Akun: ${s.total_user_services} layanan`);
      lines.push('');
    });
    if (stealers.length > 5) lines.push(`_... +${stealers.length - 5} infeksi lainnya_\n`);

    lines.push('> \u26A0\uFE0F Kredensial dari komputer ini kemungkinan beredar di dark web. Ganti semua password segera!');

  } catch (e) {
    lines.push('\u23F8\uFE0F Hudson Rock API error: ' + e.message);
  }
  return lines.join('\n');
}


// ============================================================
// CRYPTORANK — data harga, gainers, losers, market overview
// Commands: cr <token> | gainers | losers | market
// ============================================================
const _crCache = { currencies: null, cachedAt: 0 };
const CR_CACHE_TTL = 3 * 60 * 1000; // 3 menit

async function crFetchCurrencies() {
  const now = Date.now();
  if (_crCache.currencies && now - _crCache.cachedAt < CR_CACHE_TTL) {
    return _crCache.currencies;
  }
  const key = process.env.CRYPTORANK_API_KEY;
  if (!key) throw new Error('CRYPTORANK_API_KEY belum diset di environment.');
  const resp = await axios.get('https://api.cryptorank.io/v1/currencies', {
    params: { api_key: key, limit: 500 },
    timeout: 12000,
  });
  const data = resp.data?.data || [];
  _crCache.currencies = data;
  _crCache.cachedAt = now;
  return data;
}

function crFmt(n) {
  if (n == null) return 'N/A';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1) return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return '$' + n.toPrecision(4);
}

function crPct(n) {
  if (n == null) return 'N/A';
  return (n >= 0 ? '🟢 +' : '🔴 ') + n.toFixed(2) + '%';
}

function detectCrQuery(text) {
  const m = text.match(/^cr\s+([a-zA-Z0-9]+)$/i);
  if (m) return { type: 'token', symbol: m[1].toUpperCase() };
  if (/^gainers$/i.test(text)) return { type: 'gainers' };
  if (/^losers$/i.test(text)) return { type: 'losers' };
  if (/^market$/i.test(text)) return { type: 'market' };
  return null;
}

async function fetchCrToken(symbol) {
  const coins = await crFetchCurrencies();
  const coin = coins.find(c => c.symbol?.toUpperCase() === symbol.toUpperCase())
    || coins.find(c => c.slug?.toLowerCase() === symbol.toLowerCase());
  if (!coin) return '\u274C Token **' + symbol + '** tidak ditemukan di CryptoRank.\n_(coba simbol yang benar, misal: cr BTC, cr ETH, cr SOL)_';
  const v = coin.values?.USD || {};
  const sup = coin.circulatingSupply ? (coin.circulatingSupply / 1e6).toFixed(2) + 'M' : 'N/A';
  const maxSup = coin.maxSupply ? (coin.maxSupply / 1e6).toFixed(2) + 'M' : '\u221E';
  return [
    '\uD83D\uDCCA **' + coin.name + ' (' + coin.symbol + ')** \u2014 Rank #' + coin.rank,
    '\uD83D\uDCB5 Harga    : **' + crFmt(v.price) + '**',
    '\uD83D\uDCC8 24h      : ' + crPct(v.percentChange24h),
    '\uD83D\uDCC5 7d       : ' + crPct(v.percentChange7d),
    '\uD83D\uDCC5 30d      : ' + crPct(v.percentChange30d),
    '\uD83D\uDCC5 3 bulan  : ' + crPct(v.percentChange3m),
    '\uD83D\uDCC5 6 bulan  : ' + crPct(v.percentChange6m),
    '\uD83D\uDCB0 Mkt Cap  : ' + crFmt(v.marketCap),
    '\uD83D\uDD04 Vol 24h  : ' + crFmt(v.volume24h),
    '\uD83E\uDE99 Supply   : ' + sup + ' / max ' + maxSup,
    '_(via CryptoRank)_',
  ].join('\n');
}

async function fetchCrGainers() {
  const coins = await crFetchCurrencies();
  const top = [...coins]
    .filter(c => c.values?.USD?.percentChange24h != null && (c.values?.USD?.marketCap || 0) > 1e6)
    .sort((a, b) => b.values.USD.percentChange24h - a.values.USD.percentChange24h)
    .slice(0, 10);
  const rows = top.map((c, i) => {
    const v = c.values.USD;
    return (i + 1) + '. **' + c.symbol + '** ' + crPct(v.percentChange24h) + ' \u2014 ' + crFmt(v.price) + ' | MCap ' + crFmt(v.marketCap);
  });
  return '\uD83D\uDE80 **Top 10 Gainers 24h** _(via CryptoRank)_\n\n' + rows.join('\n');
}

async function fetchCrLosers() {
  const coins = await crFetchCurrencies();
  const top = [...coins]
    .filter(c => c.values?.USD?.percentChange24h != null && (c.values?.USD?.marketCap || 0) > 1e6)
    .sort((a, b) => a.values.USD.percentChange24h - b.values.USD.percentChange24h)
    .slice(0, 10);
  const rows = top.map((c, i) => {
    const v = c.values.USD;
    return (i + 1) + '. **' + c.symbol + '** ' + crPct(v.percentChange24h) + ' \u2014 ' + crFmt(v.price) + ' | MCap ' + crFmt(v.marketCap);
  });
  return '\uD83D\uDCC9 **Top 10 Losers 24h** _(via CryptoRank)_\n\n' + rows.join('\n');
}

async function fetchCrMarket() {
  const key = process.env.CRYPTORANK_API_KEY;
  if (!key) throw new Error('CRYPTORANK_API_KEY belum diset.');
  const resp = await axios.get('https://api.cryptorank.io/v1/global', {
    params: { api_key: key },
    timeout: 8000,
  });
  const d = resp.data?.data || {};
  const v = d.values?.USD || {};
  const coins = await crFetchCurrencies();
  const btcPct = coins.find(c => c.symbol === 'BTC')?.values?.USD?.percentChange24h;
  const ethPct = coins.find(c => c.symbol === 'ETH')?.values?.USD?.percentChange24h;
  return [
    '\uD83C\uDF0D **Global Market Overview** _(via CryptoRank)_',
    '\uD83D\uDCB0 Total Market Cap : **' + crFmt(v.totalMarketCap) + '**',
    '\uD83D\uDD04 Volume 24h       : ' + crFmt(v.totalVolume24h),
    '\u20BF  BTC Dominance   : **' + (d.btcDominance || 0).toFixed(2) + '%** ' + (btcPct != null ? crPct(btcPct) : ''),
    '\u039E  ETH Dominance   : **' + (d.ethDominance || 0).toFixed(2) + '%** ' + (ethPct != null ? crPct(ethPct) : ''),
    '\uD83E\uDE99 Active Coins     : ' + (d.activeCurrencies || 0).toLocaleString(),
    '\uD83D\uDCCA Active Markets   : ' + (d.activeMarkets || 0).toLocaleString(),
  ].join('\n');
}

async function handleCrCommand(type, symbol) {
  if (type === 'token') return fetchCrToken(symbol);
  if (type === 'gainers') return fetchCrGainers();
  if (type === 'losers') return fetchCrLosers();
  if (type === 'market') return fetchCrMarket();
  return null;
}

// Buat tombol delete (hanya pemilik pesan yang bisa klik)
function makeDeleteRow(userId) {
  const btn = new ButtonBuilder()
    .setCustomId('del_' + userId)
    .setLabel('Hapus')
    .setEmoji('🗑️')
    .setStyle(ButtonStyle.Danger);
  return new ActionRowBuilder().addComponents(btn);
}

// ── Provider Panel ────────────────────────────────────────────────────────
const PROVIDER_META = {
  groq:     { emoji: '⚡', label: 'Groq',     style: ButtonStyle.Success },
  gemini:   { emoji: '✨', label: 'Gemini',   style: ButtonStyle.Primary },
  openai:   { emoji: '🤖', label: 'OpenAI',   style: ButtonStyle.Secondary },
  atomesus: { emoji: '🔮', label: 'Atomesus', style: ButtonStyle.Danger },
  conduit:  { emoji: '🔀', label: 'Conduit',  style: ButtonStyle.Primary },
  iamhc:    { emoji: '🌐', label: 'IamHC',    style: ButtonStyle.Primary },
};
const ALL_PROVIDERS = ['groq', 'gemini', 'openai', 'atomesus', 'conduit', 'iamhc'];

function makeProviderPanel() {
  const status = getAgentStatus();
  const order = status.order;
  const keyCount = status.keyCount;
  const activeSet = new Set(order);

  const orderStr = order.map(function(p) {
    var m = PROVIDER_META[p];
    return m.emoji + ' ' + m.label + ' (' + (keyCount[p] || 0) + ' key)';
  }).join(' → ');
  const offProviders = ALL_PROVIDERS.filter(function(p) { return !activeSet.has(p); });
  const offStr = offProviders.length ? offProviders.map(function(p) { return PROVIDER_META[p].label; }).join(', ') + ' (nonaktif)' : '';

  const content =
    '🤖 **AI Provider Panel**\n' +
    '```\nUrutan aktif: ' + (orderStr || '(tidak ada)') + '\n' +
    (offStr ? 'Nonaktif   : ' + offStr + '\n' : '') +
    '```\n' +
    '_Klik tombol = aktifkan/nonaktifkan. Select menu = jadikan prioritas utama._';

  var toggleBtns = ALL_PROVIDERS.map(function(p) {
    var m = PROVIDER_META[p];
    var isActive = activeSet.has(p);
    return new ButtonBuilder()
      .setCustomId('provider_toggle_' + p)
      .setLabel((isActive ? '✅ ' : '⭕ ') + m.label + ' (' + (keyCount[p] || 0) + '🔑)')
      .setStyle(isActive ? m.style : ButtonStyle.Secondary);
  });
  // Discord max 5 buttons per ActionRow — chunk per 5
    var toggleRows = [];
    for (var _i = 0; _i < toggleBtns.length; _i += 5) {
      toggleRows.push(new ActionRowBuilder().addComponents(toggleBtns.slice(_i, _i + 5)));
    }

  var selectOpts = ALL_PROVIDERS.map(function(p) {
    var m = PROVIDER_META[p];
    var isFirst = order[0] === p;
    return {
      label: m.label + (isFirst ? ' ← prioritas saat ini' : ''),
      description: (keyCount[p] || 0) + ' key' + (activeSet.has(p) ? '' : ' (nonaktif)'),
      value: p,
      emoji: { name: m.emoji },
      default: isFirst,
    };
  });
  var selectRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('provider_primary')
      .setPlaceholder('🔝 Jadikan provider ini prioritas utama...')
      .addOptions(selectOpts)
  );

  return { content: content, components: [...toggleRows, selectRow] };
}


// -- Reactor Panel (baca langsung dari in-memory reactorClients) --
function makeReactorPanel() {
  const embed = new EmbedBuilder()
    .setColor(0xE74C3C)
    .setTitle('⚔️ Reactor Accounts')
    .setTimestamp()
    .setFooter({ text: 'Dikelola langsung oleh bot.js · Klik Refresh untuk update' });

  if (reactorClients.length === 0) {
    embed.setDescription('**Belum ada token reactor.**\n💡 Set `DISCORD_REACTOR_TOKENS=tokenA,tokenB` di env lalu restart bot.');
  } else {
    let desc = '', changedCount = 0, offlineCount = 0;
    for (const r of reactorClients) {
      const online  = !!r.rc.user;
      const disabled = disabledReactors.has(r.label);
      const ident   = reactorIdentity.get(r.label);
      const ping    = (r.rc.ws && r.rc.ws.ping != null && r.rc.ws.ping >= 0) ? r.rc.ws.ping : null;
      let uptime = '?';
      if (online && r.rc.readyAt) {
        const ms = Date.now() - r.rc.readyAt.getTime();
        const h  = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
        uptime = h > 0 ? h + 'j ' + m + 'm' : m + 'm';
      }
      const icon = disabled ? '⛔' : (online ? '🟢' : '🔴');
      const statusTxt = disabled
        ? 'dimatikan manual'
        : (online
            ? '**' + (r.rc.user?.tag || '?') + '** (`' + (r.rc.user?.id || '?') + '`) | ' + (ping != null ? ping + 'ms' : '—') + ' | uptime ' + uptime
            : 'offline');
      desc += '• **' + r.label + '** — ' + icon + ' ' + statusTxt + '\n';
      if (ident && ident.changed) { changedCount++; desc += '  ⚠️ *Token berubah! Sebelumnya: ' + ident.prevTag + '*\n'; }
      if (!online) offlineCount++;
    }
    if (changedCount > 0) desc += '\n🚨 **' + changedCount + ' reactor ganti akun!**';
    if (offlineCount > 0 && offlineCount < reactorClients.length) desc += '\n⚠️ ' + offlineCount + ' reactor offline.';
    else if (offlineCount === 0) desc += '\n✅ Semua reactor online.';
    embed.setDescription(desc);
    embed.addFields(
      { name: 'Total',    value: String(reactorClients.length), inline: true },
      { name: 'Online',   value: String(reactorClients.filter(r => !!r.rc.user).length), inline: true },
      { name: 'Disabled', value: String(disabledReactors.size), inline: true }
    );
  }

  const rows = [];
  if (reactorClients.length > 0) {
    for (let i = 0; i < Math.min(reactorClients.length, 8); i += 4) {
      const chunk = reactorClients.slice(i, i + 4);
      const btns  = chunk.map(r => {
        const on  = !!r.rc.user;
        const dis = disabledReactors.has(r.label);
        return new ButtonBuilder()
          .setCustomId('reactor_toggle_' + r.label)
          .setLabel((dis ? '⛔ ' : on ? '🟢 ' : '🔴 ') + r.label)
          .setStyle(dis ? ButtonStyle.Secondary : on ? ButtonStyle.Success : ButtonStyle.Danger);
      });
      rows.push(new ActionRowBuilder().addComponents(btns));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('reactor_refresh').setLabel('🔄 Refresh').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('reactor_restart_all').setLabel('🔃 Restart Semua').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('reactor_restart_offline').setLabel('🔃 Restart Offline').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('reactor_del').setLabel('🗑️ Tutup').setStyle(ButtonStyle.Secondary),
  ));
  return { embeds: [embed], components: rows };
}

// ── Embed helpers ─────────────────────────────────────────────────────────
const EMBED_COLORS = {
  price_up:  0x57F287,
  price_down:0xED4245,
  price_dex: 0x5865F2,
  cr:        0xF1C40F,
  gainers:   0x57F287,
  losers:    0xED4245,
  market:    0x5865F2,
  base_scan: 0xF0A500,
  sol_scan:  0x9B59B6,
  gmgn:      0x00C4B4,
  balance:   0x3498DB,
    zerion_txs:  0x7289DA,
    zerion_pos:  0x2ECC71,
    zerion_nft:  0xF39C12,
    zerion_gas:  0xE74C3C,
    zerion_token:0x9B59B6,
    zerion_pnl:  0x1ABC9C,
  twitter:   0x1DA1F2,
  osint:     0xE67E22,
  send:      0x2ECC71,
  translate: 0x1ABC9C,
  default:   0x2B2D31,
  lp:        0x00B894,
  read_contract: 0x5B6ACE,
};

// === Translate: 4 bentuk trigger, semua lewat @mention bot ===
//   1. reply + "translate"            -> translate pesan yang di-reply, auto-flip ID<->EN
//   2. reply + "translate <kode>"     -> translate pesan yang di-reply ke bahasa <kode>
//   3. "translate <pesan>"            -> translate teks <pesan> langsung, auto-flip ID<->EN
//   4. "translate <kode> <pesan>"     -> translate teks <pesan> langsung ke bahasa <kode>
// Beberapa kode punya casing spesifik yg wajib match persis, mis. "zh-TW"/"zh-CN"
// (bukan "zh-tw"/"zh-cn") -- kalau di-lowercase begitu saja, library tidak mengenalinya
// dan kode itu dikira bukan kode bahasa (bug: "translate zh-TW" malah nge-translate
// teks "zh-TW" itu sendiri). Jadi cari casing asli yang benar via map lowercase->asli.
var _LANG_CODE_MAP = null;
function normalizeLangCode(token) {
  if (!/^[a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?$/.test(token || '')) return null;
  if (!_LANG_CODE_MAP) {
    _LANG_CODE_MAP = {};
    Object.keys(translateApi.languages).forEach(function (k) {
      _LANG_CODE_MAP[k.toLowerCase()] = k;
    });
  }
  return _LANG_CODE_MAP[token.toLowerCase()] || null;
}

function isValidLangCode(token) {
  return !!normalizeLangCode(token);
}

function detectTranslateMentionQuery(question, hasReply) {
  var q = (question || '').trim();
  if (!/^translate\b/i.test(q)) return null;
  var rest = q.replace(/^translate\s*/i, '');
  if (!rest) {
    // "translate" doang, tanpa kode & tanpa teks -> harus ada reply
    return hasReply ? { mode: 'reply', targetOverride: null } : null;
  }
  var firstSpace = rest.indexOf(' ');
  var firstToken = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
  var normalizedCode = normalizeLangCode(firstToken);
  if (normalizedCode) {
    var remainder = firstSpace === -1 ? '' : rest.slice(firstSpace + 1).trim();
    if (remainder) {
      return { mode: 'text', targetOverride: normalizedCode, text: remainder };
    }
    // hanya kode bahasa, tanpa teks tambahan -> harus ada reply
    return hasReply ? { mode: 'reply', targetOverride: normalizedCode } : null;
  }
  // token pertama bukan kode bahasa valid -> seluruh "rest" adalah teks yang mau ditranslate
  return { mode: 'text', targetOverride: null, text: rest };
}

function langName(iso) {
  if (!iso) return 'tidak dikenal';
  var name = translateApi.languages && translateApi.languages[iso];
  return name ? name : iso.toUpperCase();
}

function extractTranslatableText(refMsg) {
  if (refMsg.content && refMsg.content.trim()) return refMsg.content.trim();
  if (refMsg.embeds && refMsg.embeds.length > 0) {
    var emb = refMsg.embeds[0];
    var parts = [];
    if (emb.title) parts.push(emb.title);
    if (emb.description) parts.push(emb.description);
    if (parts.length > 0) return parts.join('\n').trim();
  }
  return '';
}

// === !translate code — daftar semua kode bahasa, tabel rapi ala "Symbol Nilai Chain" (2 kolom ke bawah) ===
var _translateCodePagesCache = null;
function buildTranslateCodePages() {
  if (_translateCodePagesCache) return _translateCodePagesCache;
  var entries = Object.entries(translateApi.languages)
    .filter(function (e) { return e[0] !== 'auto'; })
    .sort(function (a, b) { return a[0].localeCompare(b[0]); }); // urut kode A-Z (memudahkan cari kode)

  // Lebar kolom FIXED supaya setiap baris selalu 2 kolom rata (tidak ada baris
  // "yatim" 1 kolom yang bikin tabel keliatan acak-acakan). Nama yang kepanjangan
  // dipotong + "…" — cuma ~24 dari 250 bahasa yang kena, sisanya utuh.
  var CODE_W = 8;  // kode terpanjang: "crh-Latn" (8 char)
  var NAME_W = 14;
  function cell(code, name) {
    var n = name.length > NAME_W ? name.slice(0, NAME_W - 1) + '…' : name;
    return code.padEnd(CODE_W) + ': ' + n.padEnd(NAME_W);
  }
  var cells = entries.map(function (e) { return cell(e[0], e[1]); });

  var rows = [];
  for (var i = 0; i < cells.length; i += 2) {
    rows.push(cells[i + 1] !== undefined ? cells[i] + '  ' + cells[i + 1] : cells[i]);
  }

  var header = cell('Kode', 'Bahasa').replace(': ', '  ') + '  ' + cell('Kode', 'Bahasa').replace(': ', '  ');
  var sep = '─'.repeat(header.length);

  // Discord embed description max 4096 char -> pakai budget 4000 supaya
  // aman dari overhead judul/code-block, baru split kalau kepepet.
  var MAXLEN = 4000;
  var HEAD_LEN = header.length + sep.length + 2;
  var chunks = [];
  var buf = [];
  var len = HEAD_LEN;
  for (var r = 0; r < rows.length; r++) {
    var row = rows[r];
    if (len + row.length + 1 > MAXLEN && buf.length > 0) {
      chunks.push(buf.join('\n'));
      buf = [];
      len = HEAD_LEN;
    }
    buf.push(row);
    len += row.length + 1;
  }
  if (buf.length > 0) chunks.push(buf.join('\n'));

  var total = chunks.length;
  _translateCodePagesCache = chunks.map(function (c, idx) {
    return '🌐 **Daftar Kode Bahasa Translate (' + (idx + 1) + '/' + total + ')**\n' +
      '```\n' + header + '\n' + sep + '\n' + c + '\n```';
  });
  return _translateCodePagesCache;
}

async function sendTranslateCodePages(message) {
  var pages = buildTranslateCodePages();
  var sent = [];
  for (var i = 0; i < pages.length; i++) {
    var isLast = i === pages.length - 1;
    var embed = new EmbedBuilder().setColor(EMBED_COLORS.translate).setDescription(pages[i]);
    var opts = { embeds: [embed] };
    if (isLast) opts.components = [makeDeleteRow(message.author.id)];
    var m = i === 0
      ? await message.reply(opts).catch(function () { return null; })
      : await message.channel.send(opts).catch(function () { return null; });
    if (m) sent.push(m);
  }
  if (sent.length > 0) {
    var last = sent[sent.length - 1];
    _scanMsgMap.set(last.id, [...sent]);
    setTimeout(function () { _scanMsgMap.delete(last.id); }, 2 * 60 * 60 * 1000);
  }
}

// Core translate dengan auto-flip ID<->EN kalau tidak ada targetOverride.
async function translateCore(srcText, targetOverride) {
  var firstTarget = targetOverride || 'id'; // default probe: id, dipakai juga untuk deteksi bahasa asal
  var res1;
  try {
    res1 = await translateApi(srcText, { to: firstTarget });
  } catch (e) {
    throw new Error('Layanan translate sedang gangguan/limit: ' + e.message);
  }
  var detectedIso = (res1.from && res1.from.language && res1.from.language.iso) || 'auto';
  var finalTarget = firstTarget;
  var finalRes = res1;

  if (!targetOverride && detectedIso === 'id') {
    // Auto-flip: sumber sudah Indonesia -> target sebenarnya Inggris
    finalTarget = 'en';
    try {
      finalRes = await translateApi(srcText, { to: finalTarget });
    } catch (e) {
      throw new Error('Layanan translate sedang gangguan/limit: ' + e.message);
    }
  }
  return { detectedIso: detectedIso, finalTarget: finalTarget, translatedText: finalRes.text };
}

async function handleTranslateMentionReply(message, targetOverride) {
  var refMsg = await message.fetchReference().catch(function () { return null; });
  if (!refMsg) throw new Error('Pesan yang di-reply tidak ditemukan (mungkin sudah dihapus).');
  var srcText = extractTranslatableText(refMsg);
  if (!srcText) throw new Error('Pesan yang di-reply tidak ada teksnya (cuma gambar/attachment/embed kosong).');
  if (srcText.length > 4500) srcText = srcText.slice(0, 4500);

  var r = await translateCore(srcText, targetOverride);
  var text = '🌐 **Translate** (' + langName(r.detectedIso) + ' → ' + langName(r.finalTarget) + ')\n\n'
    + '> ' + srcText.replace(/\n/g, '\n> ').slice(0, 800) + (srcText.length > 800 ? '…' : '') + '\n\n'
    + '**' + r.translatedText + '**';
  return { text: text };
}

async function handleTranslateTextQuery(srcText, targetOverride) {
  if (srcText.length > 4500) srcText = srcText.slice(0, 4500);
  var r = await translateCore(srcText, targetOverride);
  var text = '🌐 **Translate** (' + langName(r.detectedIso) + ' → ' + langName(r.finalTarget) + ')\n\n'
    + '**' + r.translatedText + '**';
  return { text: text };
}

function priceEmbedColor(text) {
  if (/\bUP\b/i.test(text) || /\+[0-9]/.test(text)) return EMBED_COLORS.price_up;
  if (/\bDOWN\b/i.test(text) || /-[0-9]/.test(text)) return EMBED_COLORS.price_down;
  return EMBED_COLORS.price_dex;
}

function makeEmbeds(text, color, title, thumbnail) {
    const col = color || EMBED_COLORS.default;
    const MAX = 3900; // buffer aman di bawah Discord limit 4096

    // Cek apakah ada code fence ``` yang belum ditutup di dalam str
    // Kembalikan nama bahasa fence yang terbuka, atau null kalau semua tertutup
    function openFence(str) {
      let open = false;
      let lang = '';
      const re = /```([a-z]*)/g;
      let m;
      while ((m = re.exec(str)) !== null) {
        if (!open) { open = true; lang = m[1]; }
        else        { open = false; lang = ''; }
      }
      return open ? lang : null;
    }

    const lines  = (text || '').split('\n');
    const result = [];
    let cur      = '';
    let isFirst  = true;

    function flush() {
      if (!cur.trim()) return;
      const fence = openFence(cur);
      // Tutup code block yang masih terbuka sebelum flush
      const desc = fence !== null ? cur + '\n```' : cur;
      const e = new EmbedBuilder().setColor(col);
      if (isFirst && title) e.setTitle(title.slice(0, 256));
      if (isFirst && thumbnail) e.setThumbnail(thumbnail);
      e.setDescription(desc.slice(0, 4096));
      result.push(e);
      // Embed berikutnya mulai dengan membuka ulang fence yang sama
      cur     = fence !== null ? '```' + fence + '\n' : '';
      isFirst = false;
    }

    for (const line of lines) {
      const candidate = cur ? cur + '\n' + line : line;
      if (candidate.length > MAX) {
        flush();
        cur = line;
      } else {
        cur = candidate;
      }
    }
    flush();

    if (result.length === 0) {
      const e = new EmbedBuilder().setColor(col);
      if (title) e.setTitle(title.slice(0, 256));
      if (thumbnail) e.setThumbnail(thumbnail);
      e.setDescription('\u200b');
      result.push(e);
    }
    return result;
    }

async function sendEmbedReply(message, text, color, title, components, thumbnail) {
  const embeds = makeEmbeds(text, color, title, thumbnail);
  const sent = [];
  for (let i = 0; i < embeds.length; i++) {
    const isLast = i === embeds.length - 1;
    const opts = { embeds: [embeds[i]] };
    if (isLast && components) opts.components = components;
    try {
      const m = i === 0
        ? await message.reply(opts)
        : await message.channel.send(opts);
      if (m) sent.push(m);
    } catch (embedErr) {
      console.warn('[embed] Gagal kirim embed, fallback plain text:', embedErr.message);
      try {
        // Fallback: kirim sebagai plain text jika embed gagal
        const plainOpts = { content: (text || '').slice(0, 2000) };
        if (isLast && components) plainOpts.components = components;
        const mFallback = i === 0
          ? await message.reply(plainOpts)
          : await message.channel.send(plainOpts);
        if (mFallback) sent.push(mFallback);
      } catch (_) {}
    }
  }
  return sent;
}

async function detectCryptoConversion(question) {
  var m = question.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  var from = m[2].toLowerCase();
  var to = m[3].toLowerCase();
  if (isNaN(amount) || amount <= 0) return null;
  // Resolusi: COIN_ID_MAP -> cache -> CoinGecko /search -> DexScreener
  var coinId = await resolveCoinId(from);
  if (!coinId) {
    var dexInfo = await resolveDexPrice(from);
    if (!dexInfo) return { notFound: true, from: from, to: to };
    if (!SUPPORTED_VS.has(to)) return { notFound: true, from: from, to: to };
    return { amount: amount, from: from, to: to, coinId: null, dexInfo: dexInfo };
  }
  var toIsVs = SUPPORTED_VS.has(to);
  var toCoinId = toIsVs ? null : await resolveCoinId(to);
  if (!toIsVs && !toCoinId) return null;
  return { amount: amount, from: from, to: to, coinId: coinId, toCoinId: toCoinId };
}

// Deteksi: "price btc" atau "p eth" (tanpa tag bot)
function detectPriceQuery(text) {
  var m = text.match(/^(?:price|p)\s+([a-zA-Z0-9]+)$/i);
  if (!m) return null;
  var sym = m[1].toLowerCase();
  return { sym: sym, coinId: COIN_ID_MAP[sym] || null };
}

async function fetchCoinThumbnail(coinId, cgKey) {
  try {
    var imgHeaders = { 'Accept': 'application/json' };
    if (cgKey) imgHeaders['x-cg-demo-api-key'] = cgKey;
    var imgResp = await axios.get(
      'https://api.coingecko.com/api/v3/coins/' + coinId
      + '?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false',
      { headers: imgHeaders, timeout: 5000 }
    );
    var img = imgResp.data && imgResp.data.image;
    return (img && (img.large || img.small || img.thumb)) || null;
  } catch (imgErr) {
    console.warn('[thumbnail] Gagal ambil logo untuk ' + coinId + ':', imgErr.message);
    return null;
  }
}

// Format market cap dengan satuan yang sesuai besarannya (T/B/M/K), bukan selalu "B"
// (sebelumnya token micro-cap seperti $315,931 tampil sebagai "$0.00B").
function formatMarketCap(mcap) {
  if (mcap >= 1e12) return '$' + (mcap / 1e12).toFixed(2) + 'T';
  if (mcap >= 1e9) return '$' + (mcap / 1e9).toFixed(2) + 'B';
  if (mcap >= 1e6) return '$' + (mcap / 1e6).toFixed(2) + 'M';
  if (mcap >= 1e3) return '$' + (mcap / 1e3).toFixed(2) + 'K';
  return '$' + mcap.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function fetchCoinPrice(pq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var headers = { 'Accept': 'application/json' };
  if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
  // Resolve coinId dinamis jika tidak ada di COIN_ID_MAP
  var coinId = pq.coinId;
  if (!coinId) {
    coinId = await resolveCoinId(pq.sym);
  }
  if (!coinId) {
    var cmcNf = await fetchFromCMC(pq.sym);
    if (cmcNf) return buildCmcPriceResult(pq.sym, cmcNf);
    var dexInfoNf = await resolveDexPrice(pq.sym);
    if (dexInfoNf) return await buildDexPriceResult(pq.sym, dexInfoNf);
    throw new Error('Token **' + pq.sym.toUpperCase() + '** tidak ditemukan di CoinGecko, CoinMarketCap, maupun DexScreener.');
  }
  var url = 'https://api.coingecko.com/api/v3/simple/price'
    + '?ids=' + coinId
    + '&vs_currencies=usd,idr,btc'
    + '&include_24hr_change=true'
    + '&include_market_cap=true'
    + '&precision=8';
  var resp = await axios.get(url, { headers: headers, timeout: 8000 });
  var d = resp.data[coinId];
  var sym = pq.sym.toUpperCase();
  // Jika CoinGecko return kosong (token ada tapi tanpa data harga), fallback ke DexScreener
  if (!d || d.usd == null) {
    var cmcFb = await fetchFromCMC(pq.sym);
    if (cmcFb) return buildCmcPriceResult(pq.sym, cmcFb);
    var dexInfo = await resolveDexPrice(pq.sym);
    if (dexInfo) return await buildDexPriceResult(pq.sym, dexInfo);
    throw new Error('Harga **' + sym + '** tidak tersedia di CoinGecko, CoinMarketCap, maupun DexScreener.');
  }
  var usd = d.usd;
  var idr = d.idr;
  var chg = d.usd_24h_change;
  var mcap = d.usd_market_cap;
  var chgStr = chg != null ? (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%' : 'N/A';
  var usdStr = usd == null ? 'N/A' : (usd >= 1
    ? usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : usd.toPrecision(6));
  var idrStr = idr == null ? 'N/A' : 'Rp ' + Math.round(idr).toLocaleString('id-ID');
  var mcapStr = mcap ? formatMarketCap(mcap) : 'N/A';
  var arrow = chg != null ? (chg >= 0 ? '**UP**' : '**DOWN**') : '';
  var text = '**$' + sym + '** ' + arrow + ' ' + chgStr + ' (24 jam)\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + 'Market Cap: ' + mcapStr + '\n'
    + '_(via CoinGecko)_';
  // Ambil logo coin (best-effort, jangan gagalkan response harga jika ini error)
  var thumbnail = await getCoinImage(pq.sym, coinId, cgKey);
  return { text: text, thumbnail: thumbnail };
}

async function buildDexPriceResult(sym, dexInfo) {
  var symUp = sym.toUpperCase();
  var dexUsd = dexInfo.priceUsd;
  var dexUsdStr = dexUsd >= 1
    ? dexUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : dexUsd.toPrecision(6);
  // DexScreener tidak pernah kasih quote IDR, jadi dikonversi manual dari kurs USD->IDR
  var fxRate = await getUsdToIdrRate();
  var dexIdrStr = fxRate ? 'Rp ' + Math.round(dexUsd * fxRate).toLocaleString('id-ID') + ' (estimasi)' : 'N/A';
  var dexText = '**$' + symUp + '**\n'
    + 'USD: $' + dexUsdStr + '\n'
    + 'IDR: ' + dexIdrStr + '\n'
    + 'Pair: ' + dexInfo.pair + ' (' + dexInfo.dex + '/' + dexInfo.chain + ')\n'
    + '_(via DexScreener)_';
  return { text: dexText, thumbnail: dexInfo.imageUrl || null };
}

function buildCmcPriceResult(sym, cmc) {
  var symUp = sym.toUpperCase();
  var usdStr = cmc.usd >= 1
    ? cmc.usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : cmc.usd.toPrecision(6);
  var idrStr = cmc.idr != null ? 'Rp ' + Math.round(cmc.idr).toLocaleString('id-ID') : 'N/A';
  var text = '**$' + symUp + '**\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + '_(via CoinMarketCap)_';
  return { text: text, thumbnail: cmc.logo || null };
}

// Deteksi: "1 btc", "0.12 btc", "1k btc", "1m btc", "1b btc" (jumlah koin -> nilai USD & IDR)
// Resolusi token sama seperti command "p <token>" (CoinGecko dinamis -> CoinMarketCap -> DexScreener),
// jadi token seperti "edgen" yang bisa dicari via "p edgen" juga bisa dipakai di sini.
// Kalau token benar-benar tidak dikenal di manapun, return null (diam, tidak membalas chat biasa).
async function detectAmountQuery(text) {
  var m = text.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)$/i);
  if (!m) return null;
  var amount = parseConvAmount(m[1]);
  if (isNaN(amount) || !isFinite(amount) || amount <= 0) return null;
  var sym = m[2].toLowerCase();

  var coinId = await resolveCoinId(sym);
  if (coinId) return { amount: amount, sym: sym, coinId: coinId };

  var cmc = await fetchFromCMC(sym);
  if (cmc) return { amount: amount, sym: sym, cmc: cmc };

  var dexInfo = await resolveDexPrice(sym);
  if (dexInfo) return { amount: amount, sym: sym, dexInfo: dexInfo };

  return null;
}

async function fetchAmountPrice(aq) {
  var cgKey = process.env.COINGECKO_API_KEY || '';
  var symUp = aq.sym.toUpperCase();
  var usd = null;
  var idr = null;
  var sourceLabel = 'CoinGecko';

  if (aq.coinId) {
    var headers = { 'Accept': 'application/json' };
    if (cgKey) headers['x-cg-demo-api-key'] = cgKey;
    var url = 'https://api.coingecko.com/api/v3/simple/price'
      + '?ids=' + aq.coinId
      + '&vs_currencies=usd,idr'
      + '&precision=8';
    var resp = await axios.get(url, { headers: headers, timeout: 8000 });
    var d = resp.data[aq.coinId];
    usd = d && d.usd != null ? d.usd : null;
    idr = d && d.idr != null ? d.idr : null;
    if (usd == null) {
      var cmcFb = await fetchFromCMC(aq.sym);
      if (cmcFb) {
        usd = cmcFb.usd; idr = cmcFb.idr; sourceLabel = 'CoinMarketCap';
      } else {
        var dexFb = await resolveDexPrice(aq.sym);
        if (dexFb) {
          usd = dexFb.priceUsd;
          var fxRateFb = await getUsdToIdrRate();
          idr = fxRateFb ? usd * fxRateFb : null;
          sourceLabel = 'DexScreener';
        }
      }
    }
  } else if (aq.cmc) {
    usd = aq.cmc.usd; idr = aq.cmc.idr; sourceLabel = 'CoinMarketCap';
  } else if (aq.dexInfo) {
    usd = aq.dexInfo.priceUsd;
    var fxRateDi = await getUsdToIdrRate();
    idr = fxRateDi ? usd * fxRateDi : null;
    sourceLabel = 'DexScreener';
  }

  if (usd == null) throw new Error('Harga **' + symUp + '** tidak tersedia saat ini.');

  var usdTotal = aq.amount * usd;
  var idrTotal = idr != null ? aq.amount * idr : null;
  var amountStr = (aq.amount % 1 === 0 ? aq.amount.toLocaleString('en-US') : String(aq.amount));
  var usdStr = usdTotal >= 1
    ? usdTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : usdTotal.toPrecision(6);
  var idrStr = idrTotal != null ? 'Rp ' + Math.round(idrTotal).toLocaleString('id-ID') : 'N/A';
  var text = '**' + amountStr + ' $' + symUp + '**\n'
    + 'USD: $' + usdStr + '\n'
    + 'IDR: ' + idrStr + '\n'
    + '_(via ' + sourceLabel + ')_';
  var thumbnail = aq.coinId
    ? await getCoinImage(aq.sym, aq.coinId, cgKey)
    : (aq.cmc && aq.cmc.logo) || (aq.dexInfo && aq.dexInfo.imageUrl) || null;
  return { text: text, thumbnail: thumbnail };
}

async function fetchCryptoConversion(conv) {
  var amount = conv.amount;
  var from = conv.from;
  var to = conv.to;
  var coinId = conv.coinId;
  if (!from || !to) throw new Error('Data konversi tidak lengkap');
  var fromSym = from.toUpperCase();
  var toSym = to.toUpperCase();
  var cgKey = process.env.COINGECKO_API_KEY || '';

  // DexScreener path: token micro-cap yang tidak ada di CoinGecko
  if (conv.dexInfo) {
    var dexPriceUsd = conv.dexInfo.priceUsd;
    var targetRate = 1;
    if (to !== 'usd') {
      var rateHeaders = { 'Accept': 'application/json' };
      if (cgKey) rateHeaders['x-cg-demo-api-key'] = cgKey;
      var rateResp = await axios.get(
        'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=' + to + '&precision=6',
        { headers: rateHeaders, timeout: 6000 }
      );
      var rateData = rateResp.data && rateResp.data['tether'];
      targetRate = (rateData && rateData[to]) ? rateData[to] : 1;
    }
    var priceInTarget = dexPriceUsd * targetRate;
    var resultInTarget = amount * priceInTarget;
    var dexSrc = (conv.dexInfo.dex || 'dex') + '/' + (conv.dexInfo.chain || 'chain');
    var dl1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(resultInTarget, to) + '**';
    var dl2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(priceInTarget, to);
    return dl1 + '\n' + dl2 + '\n_(via DexScreener - ' + dexSrc + ', harga real-time)_';
  }

  // CoinGecko path
  var toCoinId = conv.toCoinId || COIN_ID_MAP[to] || null;
  var toIsVsCurrency = SUPPORTED_VS.has(to);
  var ids = coinId;
  var vsCurrencies = to;
  if (!toIsVsCurrency && toCoinId) {
    ids = coinId + ',' + toCoinId;
    vsCurrencies = 'usd';
  }
  var cgUrl = 'https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=' + vsCurrencies + '&precision=8';
  var cgHeaders = { 'Accept': 'application/json' };
  if (cgKey) cgHeaders['x-cg-demo-api-key'] = cgKey;
  var resp = await axios.get(cgUrl, { headers: cgHeaders, timeout: 8000 });
  var data = resp.data;
  var result, line1, line2;
  if (!toIsVsCurrency && toCoinId) {
    var fromUsd = data[coinId] && data[coinId]['usd'];
    var toUsd = data[toCoinId] && data[toCoinId]['usd'];
    if (!fromUsd || !toUsd) throw new Error('Data harga tidak tersedia');
    result = (amount * fromUsd) / toUsd;
    line1 = '**' + amount + ' $' + fromSym + ' ke $' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(fromUsd / toUsd, to);
  } else {
    var price = data[coinId] && data[coinId][to];
    if (price == null) throw new Error('Data harga tidak tersedia');
    result = amount * price;
    line1 = '**' + amount + ' $' + fromSym + ' ke ' + toSym + ' = ' + formatCryptoAmount(result, to) + '**';
    line2 = '1 $' + fromSym + ' = ' + formatCryptoAmount(price, to);
  }
  return line1 + '\n' + line2 + '\n_(via CoinGecko, harga real-time)_';
}

// ============================================================
// GITHUB EDIT
// ============================================================

function parseGitHubFileRef(text) {
  const urlMatch = text.match(/https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/\s]+)\/([^\s?#]+)/i);
  if (urlMatch) {
    return {
      owner: urlMatch[1], repo: urlMatch[2],
      branch: urlMatch[3], path: decodeURIComponent(urlMatch[4]),
      raw: urlMatch[0],
    };
  }
  const shortMatch = text.match(/\b([\w.-]+)\/([\w.-]+):([\w\-./]+\.[a-zA-Z0-9]+)\b/);
  if (shortMatch) {
    return { owner: shortMatch[1], repo: shortMatch[2], branch: null, path: shortMatch[3], raw: shortMatch[0] };
  }
  return null;
}

function friendlyGitHubError(err, ref) {
  const status = err.response?.status;
  const apiMsg = err.response?.data?.message || err.message;
  console.error('[bot] GitHub edit gagal:', status, apiMsg);
  if (status === 404) return `⚠️ Repo/file tidak ditemukan: \`${ref.owner}/${ref.repo}\` path \`${ref.path}\`. Cek nama repo, path, dan branch-nya.`;
  if (status === 401 || status === 403) return '⚠️ Bot tidak punya izin menulis ke repo ini. Pastikan `GITHUB_WRITE_TOKEN` punya scope **repo** atau permission **Contents: Read and write**.';
  if (status === 409) return '⚠️ Konflik: file sudah berubah sejak terakhir dibaca (sha mismatch). Kirim ulang permintaannya.';
  if (status === 422) return `⚠️ Gagal commit (422): ${apiMsg}. Cek apakah nama branch/path valid.`;
  return `⚠️ Gagal edit file GitHub. (${status || 'error'}: ${apiMsg})`;
}

// [FIX #11] handleGitHubEdit: kirim backup file asli SEBELUM commit agar user bisa undo manual
async function handleGitHubEdit(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent, sha } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    // [FIX #11] Kirim file backup ke user SEBELUM apapun dilakukan
    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;
    await message.reply({
      content: `📦 **Backup file asli** (sebelum diedit) — simpan jika ingin rollback manual:`,
      files: [makeFile(oldContent, `BACKUP_${replyFilename}`)],
      flags: MessageFlags.SuppressEmbeds,
    }).catch(() => {}); // non-fatal jika gagal kirim backup

    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini, identifikasi error/masalahnya, lalu perbaiki dan rapikan.';

    // [FIX BARU] File besar (>10KB owner / >3KB non-owner) tidak bisa ditulis ulang penuh
    // dalam satu respons AI (dibatasi maxOutputTokens di lib/ai.js) — pakai patch SEARCH/REPLACE.
    const useTargetedEdit = oldContent.length > fullRewriteSafeBytes(isDMOwner);

    const prompt = useTargetedEdit
      ? buildTargetedEditPrompt(instruction, ref.path, oldContent)
      : `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
        + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
        + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    // [FIX] Deteksi hallusinasi di respons GitHub edit
    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    let newContent;
    let summary;

    if (useTargetedEdit) {
      const patches = parseSearchReplaceBlocks(text);
      if (!patches.length) {
        await message.reply(`⚠️ File **${ref.path}** (${Math.round(oldContent.length / 1024)}KB) terlalu besar untuk ditulis ulang penuh, dan AI tidak memberi format patch yang valid. Coba instruksi lebih spesifik (misal: "perbaiki fungsi X saja").`);
        return;
      }
      const { content: patched, failed, appliedCount } = applySearchReplace(oldContent, patches);
      if (appliedCount === 0) {
        await message.reply('⚠️ Gagal menerapkan perubahan — potongan kode yang disebut AI tidak cocok persis dengan file asli. Coba minta perbaikan yang lebih spesifik.');
        return;
      }
      newContent = patched;
      summary = stripCodeBlocks(text).slice(0, 500)
        + (failed.length ? `\n⚠️ ${failed.length}/${patches.length} perubahan gagal diterapkan (kode tidak cocok persis).` : '');
    } else {
      const blocks = extractCodeBlocks(text);
      if (!blocks.length) {
        await message.reply('⚠️ AI tidak mengembalikan kode dalam format yang bisa diproses ke GitHub. Coba ulangi dengan instruksi yang lebih spesifik.');
        return;
      }
      newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;

      // [FIX] Validasi kode yang akan di-commit
      if (!isValidCodeBlock(newContent)) {
        await message.reply('⚠️ Kode yang dihasilkan AI terlihat tidak lengkap (terlalu pendek atau mengandung placeholder). Coba kirim ulang.');
        return;
      }
      summary = stripCodeBlocks(text).slice(0, 600);
    }

    // [FIX] Validasi sintaks SEBELUM commit — cegah patch rusak (kurung tak seimbang,
    // hasil SEARCH/REPLACE yang salah tempel, dll) ter-commit ke GitHub tanpa terdeteksi.
    const syntaxCheck = validateSyntax(ref.path, newContent);
    if (!syntaxCheck.valid) {
      await message.reply({
        content: [
          `🚫 Perubahan DIBATALKAN — hasil edit tidak valid secara sintaks:`,
          `\`\`\`${syntaxCheck.error}\`\`\``,
          `File di GitHub **TIDAK diubah**. Coba minta perbaikan yang lebih spesifik, atau periksa manual bagian yang di-patch.`,
        ].join('\n').slice(0, 2000),
        files: [makeFile(newContent, `FAILED_${replyFilename}`)],
        flags: MessageFlags.SuppressEmbeds,
      });
      return;
    }

    const commitMessage = `Auto-edit via Discord bot: ${instruction.slice(0, 60)}`;
    const result = await commitGitHubFile(ref.owner, ref.repo, ref.path, newContent, commitMessage, sha, branch);

    await message.reply({
      content: [
        `✅ File **${ref.path}** di **${ref.owner}/${ref.repo}** (branch \`${branch}\`) berhasil diupdate.`,
        result.commitUrl ? `🔗 Commit: <${result.commitUrl}>` : '',
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}

// handleGitHubReadOnly: Ambil file dari GitHub, minta AI edit/analisis,
// lalu kirim hasilnya ke Discord SAJA — tidak ada commit ke repo.
// Dipakai untuk user selain owner.
async function handleGitHubReadOnly(message, ref, question, history, isDMOwner) {
  let branch = ref.branch;
  try {
    if (!branch) branch = await getDefaultBranch(ref.owner, ref.repo);
    const { content: oldContent } = await getGitHubFileContent(ref.owner, ref.repo, ref.path, branch);

    const replyFilename = ref.path.includes('/') ? ref.path.split('/').slice(-1)[0] : ref.path;
    const instruction = question.replace(ref.raw, '').trim()
      || 'Periksa file ini dan jelaskan isinya, atau terapkan perubahan yang diminta.';

    const useTargetedEdit = oldContent.length > fullRewriteSafeBytes(true);

    const prompt = useTargetedEdit
      ? buildTargetedEditPrompt(instruction, ref.path, oldContent)
      : `${instruction}\n\nIni isi file "${ref.path}" saat ini dari repo ${ref.owner}/${ref.repo} (branch ${branch}). `
        + `Berikan versi LENGKAP file yang sudah diperbaiki dalam SATU code block saja — jangan dipotong, jangan ada penjelasan di luar code block selain ringkasan singkat 1-2 kalimat sebelum code block:\n\n`
        + `\`\`\`\n${oldContent}\n\`\`\``;

    const { text } = await askGemini(prompt, history, isDMOwner);

    if (containsHallucination(text)) {
      await message.reply('⚠️ AI tidak memberikan kode yang valid. Coba kirim ulang permintaannya dengan instruksi lebih spesifik.');
      return;
    }

    let newContent;
    let summary;

    if (useTargetedEdit) {
      const patches = parseSearchReplaceBlocks(text);
      if (!patches.length) {
        await message.reply({ content: text.slice(0, 2000), flags: MessageFlags.SuppressEmbeds });
        return;
      }
      const { content: patched, failed, appliedCount } = applySearchReplace(oldContent, patches);
      if (appliedCount === 0) {
        await message.reply('⚠️ Patch tidak bisa diterapkan. Coba instruksi lebih spesifik.');
        return;
      }
      newContent = patched;
      summary = stripCodeBlocks(text).slice(0, 500)
        + (failed.length ? `\n⚠️ ${failed.length}/${patches.length} perubahan gagal diterapkan.` : '');
    } else {
      const blocks = extractCodeBlocks(text);
      if (!blocks.length) {
        await message.reply({ content: text.slice(0, 2000), flags: MessageFlags.SuppressEmbeds });
        return;
      }
      newContent = blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a)).code;
      // Validasi rasio ukuran — output < 40% dari input → kemungkinan terpotong
      if (oldContent.length > 3000 && newContent.length < oldContent.length * 0.4) {
        await message.reply({
          content: (
            `⚠️ Output AI (${Math.round(newContent.length / 1024)}KB) jauh lebih kecil dari file asli ` +
            `(${Math.round(oldContent.length / 1024)}KB) — kemungkinan terpotong. File **TIDAK** dikirim.\n\n` +
            `Coba minta perbaikan yang lebih spesifik (misal: "perbaiki fungsi X saja").`
          ).slice(0, 2000),
          flags: MessageFlags.SuppressEmbeds,
        });
        return;
      }
      summary = stripCodeBlocks(text).slice(0, 600);
    }

    // Kirim hasil ke Discord tanpa commit ke repo
    await message.reply({
      content: [
        `📄 **Hasil edit \`${ref.path}\`** dari \`${ref.owner}/${ref.repo}\` (branch \`${branch}\`)`,
        `ℹ️ File **tidak** diubah di repo — hanya owner yang bisa commit langsung.`,
        summary,
      ].filter(Boolean).join('\n').slice(0, 2000),
      files: [makeFile(newContent, replyFilename)],
      flags: MessageFlags.SuppressEmbeds,
    });
  } catch (err) {
    await message.reply(friendlyGitHubError(err, ref)).catch(() => {});
  }
}


// ============================================================
// TARGETED EDIT (SEARCH/REPLACE) — pengganti "tulis ulang seluruh file"
// [FIX BARU] Gemini dibatasi maxOutputTokens (8192 utk owner, 2048 utk user biasa
// — lihat lib/ai.js). 8192 token ≈ 25-30KB teks maksimum. File yang lebih besar
// dari itu SELALU akan terpotong (MAX_TOKENS) kalau diminta menulis ulang penuh,
// menghasilkan file yang jauh lebih kecil dan RUSAK — inilah kasus 239KB → 10KB.
// Solusi: untuk file besar, minta AI keluarkan blok SEARCH/REPLACE (hanya bagian
// yang berubah), lalu tempelkan (patch) ke konten asli secara lokal di server.
// Ini sama seperti cara kerja tool edit pada Replit Agent / Cursor / Aider.
// ============================================================

function fullRewriteSafeBytes(isDMOwner) {
  return 10000; // Channel dan DM owner pakai batas yang sama
}

function buildMultiFileTargetedEditPrompt(instruction, loadedFiles) {
  const fileList = loadedFiles.map(({ att, content }) => `### FILE: ${att.name}\n\`\`\`\n${content}\n\`\`\``).join('\n\n');
  return `${instruction}\n\nBerikut adalah beberapa file:\n\n${fileList}\n\n`
    + `PENTING — JANGAN tulis ulang seluruh isi file mana pun. File-file ini besar dan output kamu dibatasi, jadi menulis ulang penuh akan TERPOTONG dan merusak file.\n`
    + `Sebagai gantinya, untuk SETIAP perubahan yang perlu dibuat, tulis dulu baris penanda "### FILE: <nama_file_persis>" (harus sama persis dengan nama file di atas), lalu blok patch dengan format PERSIS seperti ini (boleh banyak blok per file, dan boleh untuk banyak file):\n\n`
    + `### FILE: <nama_file>\n`
    + `<<<<<<< SEARCH\n`
    + `(salin PERSIS potongan kode ASLI dari file itu yang ingin diganti — indentasi harus sama persis, cukup panjang agar unik di file itu)\n`
    + `=======\n`
    + `(kode pengganti yang sudah diperbaiki)\n`
    + `>>>>>>> REPLACE\n\n`
    + `Sebelum semua blok itu, tulis ringkasan singkat per file tentang apa yang diperbaiki. Jangan sertakan penjelasan lain di luar itu.`;
}

function parseMultiFileSearchReplace(text, knownFileNames) {
  const result = {};
  for (const name of knownFileNames) result[name] = [];

  const fileMarkerRe = /###\s*FILE:\s*(.+)/g;
  const markers = [];
  let fm;
  while ((fm = fileMarkerRe.exec(text))) {
    markers.push({ name: fm[1].trim(), index: fm.index + fm[0].length });
  }

  const blockRe = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;
  let bm;
  while ((bm = blockRe.exec(text))) {
    // cari marker file terdekat SEBELUM blok ini
    let owner = null;
    for (let i = markers.length - 1; i >= 0; i--) {
      if (markers[i].index <= bm.index) { owner = markers[i].name; break; }
    }
    if (!owner) continue;
    // cocokkan ke nama file yang benar-benar kita kirim (toleran jika AI sedikit ubah casing/whitespace)
    const matched = knownFileNames.find((n) => n === owner) || knownFileNames.find((n) => n.toLowerCase() === owner.toLowerCase());
    if (!matched) continue;
    result[matched].push({ search: bm[1], replace: bm[2] });
  }
  return result;
}

function parseSearchReplaceBlocks(text) {
  const blocks = [];
  const re = /<{5,}\s*SEARCH\s*\n([\s\S]*?)\n={5,}\s*\n([\s\S]*?)\n>{5,}\s*REPLACE/g;
  let m;
  while ((m = re.exec(text))) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
}

function applySearchReplace(oldContent, blocks) {
  let content = oldContent;
  const failed = [];
  for (const b of blocks) {
    const count = content.split(b.search).length - 1;
    if (count === 1) {
      content = content.replace(b.search, b.replace);
    } else {
      failed.push({ ...b, count });
    }
  }
  return { content, failed, appliedCount: blocks.length - failed.length };
}

function buildTargetedEditPrompt(instruction, filename, content) {
  return `${instruction}\n\n`
    + `Ini isi file "${filename}" saat ini:\n\`\`\`\n${content}\n\`\`\`\n\n`
    + `PENTING — JANGAN tulis ulang seluruh file. File ini besar dan output kamu dibatasi, jadi menulis ulang penuh akan TERPOTONG dan merusak file.\n`
    + `Sebagai gantinya, untuk SETIAP bagian yang perlu diubah, berikan blok dengan format PERSIS seperti ini (boleh lebih dari satu blok):\n\n`
    + `<<<<<<< SEARCH\n`
    + `(salin PERSIS potongan kode ASLI yang ingin diganti — termasuk spasi/indentasi persis sama, cukup panjang baris konteksnya agar unik di dalam file)\n`
    + `=======\n`
    + `(kode pengganti yang sudah diperbaiki)\n`
    + `>>>>>>> REPLACE\n\n`
    + `Sebelum blok-blok itu, tulis ringkasan singkat 1-3 kalimat tentang apa yang diperbaiki dan kenapa. Jangan sertakan penjelasan lain di luar itu.`;
}

// [FIX BARU] Jika total ukuran file melebihi threshold, proses tiap file secara terpisah
// agar tidak melebihi context window AI dan mencegah truncate/hallusinasi.
async function processSingleFile(message, att, content, question, history, isDMOwner) {
  const instruction = question
    || 'Periksa file ini, identifikasi semua error/masalahnya, lalu perbaiki.';

  // File > CHUNK_THRESHOLD (55KB) → gunakan chunked mode (map-reduce)
  if (content.length > CHUNK_THRESHOLD) {
    if (_isEditInstruction(instruction)) {
      await editFileInChunks(message, att, content, instruction, history, isDMOwner);
    } else {
      await analyzeFileInChunks(message, att, content, instruction, history, isDMOwner);
    }
    return;
  }

  const useTargetedEdit = content.length > fullRewriteSafeBytes(isDMOwner);

  const finalQuestion = useTargetedEdit
    ? buildTargetedEditPrompt(instruction, att.name, content)
    : `${instruction}\n\n// === File: ${att.name} ===\n${content}\n\nBerikan versi LENGKAP file yang sudah diperbaiki dalam satu code block saja — jangan dipotong.`;

  let text;
  try {
    ({ text } = await askGemini(finalQuestion, history, isDMOwner));
  } catch (aiErr) {
    console.error('[processSingleFile] askGemini error untuk', att.name, ':', aiErr.message);
    await message.reply(
      '⚠️ AI gagal memproses **' + att.name + '** (' + Math.round(content.length / 1024) + 'KB): ' +
      (aiErr.message || 'Error tidak diketahui') +
      '. Coba file yang lebih kecil atau minta operasi yang lebih spesifik.'
    ).catch(() => {});
    return;
  }

  // Deteksi hallusinasi
  if (containsHallucination(text)) {
    await message.reply(`⚠️ AI memberikan respons yang tidak valid untuk **${att.name}**. Coba kirim file ini sendiri tanpa file lain.`);
    return;
  }

  if (useTargetedEdit) {
    let patches = parseSearchReplaceBlocks(text);
    // Jika AI mengabaikan format SEARCH/REPLACE, coba sekali lagi dengan prompt lebih keras
    if (!patches.length) {
      await message.channel.sendTyping().catch(() => {});
      const retryPrompt =
        `PERHATIAN KRITIS: Kamu WAJIB menggunakan format SEARCH/REPLACE. ` +
        `JANGAN tulis kode di luar format itu — output apapun di luar format SEARCH/REPLACE akan DIABAIKAN dan tidak berguna.\n\n` +
        buildTargetedEditPrompt(instruction, att.name, content);
      try {
        const { text: retryText } = await askGemini(retryPrompt, [], isDMOwner);
        patches = parseSearchReplaceBlocks(retryText);
        if (patches.length) text = retryText; // gunakan respons retry
      } catch (_retryErr) { /* abaikan error retry, lanjut ke warning */ }
    }
    if (!patches.length) {
      const explanation = stripCodeBlocks(text).slice(0, 1400);
      await message.reply({
        content: (`⚠️ **${att.name}** (${Math.round(content.length / 1024)}KB) terlalu besar untuk ditulis ulang penuh, dan AI tetap tidak menggunakan format patch setelah 2 percobaan.\nCoba minta perbaikan yang lebih spesifik (misal: "perbaiki fungsi X saja").\n\n${explanation}`).slice(0, 2000),
        flags: MessageFlags.SuppressEmbeds,
      });
      return;
    }
    const { content: patched, failed, appliedCount } = applySearchReplace(content, patches);
    if (appliedCount === 0) {
      await message.reply(`⚠️ Gagal menerapkan perubahan ke **${att.name}** — potongan kode yang disebut AI tidak ditemukan persis di file asli (kemungkinan AI parafrase, bukan menyalin persis). Coba minta perbaikan yang lebih spesifik/kecil.`);
      return;
    }
    const explanation = stripCodeBlocks(text).slice(0, 650);
    const warn = failed.length
      ? `\n⚠️ ${failed.length} dari ${patches.length} perubahan GAGAL diterapkan (kode asli tidak cocok persis) — bagian itu TIDAK berubah.`
      : '';
    await message.reply({
      content: (`✅ **${att.name}** — ${appliedCount}/${patches.length} perubahan diterapkan (ukuran tetap ${Math.round(patched.length / 1024)}KB, asli ${Math.round(content.length / 1024)}KB).${warn}\n${explanation}`).slice(0, 2000),
      files: [makeFile(patched, att.name)],
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const blocks = extractCodeBlocks(text);
  const validBlocks = blocks.filter((b) => isValidCodeBlock(b.code));

  if (validBlocks.length === 0) {
    const explanation = stripCodeBlocks(text).slice(0, 1800);
    await message.reply({
      content: (`**${att.name}:**\n${explanation || '⚠️ AI tidak menghasilkan kode valid untuk file ini.'}`).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  const bestBlock = validBlocks.reduce((a, b) => (b.code.length > a.code.length ? b : a));
  const explanation = stripCodeBlocks(text).slice(0, 800);

  // Validasi rasio ukuran — output < 40% dari input dan file asli > 3KB → kemungkinan terpotong
  if (content.length > 3000 && bestBlock.code.length < content.length * 0.4) {
    await message.reply({
      content: (
        `⚠️ **${att.name}**: Output AI (${Math.round(bestBlock.code.length / 1024)}KB) jauh lebih kecil dari file asli ` +
        `(${Math.round(content.length / 1024)}KB) — kemungkinan terpotong. File **TIDAK** disimpan.\n\n` +
        `Coba: kirim ulang file dengan instruksi lebih spesifik (misal: "perbaiki fungsi X saja").`
      ).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    });
    return;
  }

  await message.reply({
    content: (`✅ **${att.name}** sudah diperbaiki.\n` + (explanation || '')).slice(0, 2000),
    files: [makeFile(bestBlock.code, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}


// ============================================================
// CHUNKED FILE PROCESSING — untuk file > CHUNK_THRESHOLD (55KB)
// Map-reduce: tiap chunk diringkas, lalu semua ringkasan digabung → jawaban akhir.
// Edit: 2 pass — pass 1 cari chunk relevan, pass 2 SEARCH/REPLACE hanya di sana.
// ============================================================

function _splitIntoChunks(content) {
  const chunks = [];
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    chunks.push({ text: content.slice(i, i + CHUNK_SIZE), start: i });
  }
  return chunks;
}

// Deteksi apakah instruksi bermaksud mengedit file (bukan sekadar menganalisis)
function _isEditInstruction(instruction) {
  return /\b(perbaiki|fix|ubah|ganti|edit|tambah|hapus|refactor|optimize|update|revisi|modif|koreksi|improve|rewrite|tulis ulang|rename|pindah|move|delete|remove|replace)\b/i.test(instruction || '');
}

// ANALISIS (read-only) — map-reduce per chunk
async function analyzeFileInChunks(message, att, content, question, history, isDMOwner) {
  const instruction = question || 'Analisis file ini dan jelaskan isinya secara menyeluruh.';
  const chunks = _splitIntoChunks(content);

  await message.channel.sendTyping().catch(() => {});
  const summaries = [];

  for (let i = 0; i < chunks.length; i++) {
    const mapPrompt =
      'Pertanyaan/instruksi user: "' + instruction + '"\n\n' +
      'Berikut bagian ' + (i + 1) + ' dari ' + chunks.length + ' file "' + att.name + '":\n\n' +
      '```\n' + chunks[i].text + '\n```\n\n' +
      'Dari bagian ini, ekstrak HANYA informasi yang relevan untuk menjawab pertanyaan user. ' +
      'Jika tidak ada yang relevan, tulis "tidak relevan". Ringkasan singkat saja (maks 400 kata), jangan tulis kode baru.';
    try {
      const { text: mapText } = await askGemini(mapPrompt, [], isDMOwner);
      summaries.push('[Bagian ' + (i + 1) + '/' + chunks.length + ']\n' + mapText.slice(0, 1800));
    } catch (e) {
      summaries.push('[Bagian ' + (i + 1) + '/' + chunks.length + '] Gagal: ' + e.message);
    }
    if (i < chunks.length - 1) await message.channel.sendTyping().catch(() => {});
  }

  const reducePrompt =
    'User bertanya tentang file "' + att.name + '" (' + Math.round(content.length / 1024) + 'KB, ' + chunks.length + ' bagian):\n' +
    '"' + instruction + '"\n\n' +
    'Ringkasan tiap bagian:\n\n' + summaries.join('\n\n') + '\n\n' +
    'Berikan jawaban lengkap dan komprehensif berdasarkan semua ringkasan di atas.';

  let finalText;
  try {
    ({ text: finalText } = await askGemini(reducePrompt, history, isDMOwner));
  } catch (e) {
    await message.reply('⚠️ AI gagal merangkum hasil analisis **' + att.name + '**: ' + e.message).catch(() => {});
    return;
  }

  await sendEmbedReply(
    message,
    '📄 **Analisis ' + att.name + '** (' + Math.round(content.length / 1024) + 'KB, ' + chunks.length + ' bagian)\n\n' + finalText,
    0x5865F2, null, [makeDeleteRow(message.author.id)]
  );
}

// EDIT — 2-pass: cari chunk relevan → SEARCH/REPLACE di sana
async function editFileInChunks(message, att, content, instruction, history, isDMOwner) {
  const chunks = _splitIntoChunks(content);

  await message.reply(
    '🔍 File **' + att.name + '** (' + Math.round(content.length / 1024) + 'KB) terlalu besar untuk dibaca sekaligus. ' +
    'Memindai ' + chunks.length + ' bagian untuk menemukan kode yang relevan...'
  ).catch(() => {});

  // Pass 1: cari chunk yang mengandung kode relevan
  let foundChunkText = null;

  for (let i = 0; i < chunks.length; i++) {
    await message.channel.sendTyping().catch(() => {});
    const findPrompt =
      'File: "' + att.name + '", bagian ' + (i + 1) + ' dari ' + chunks.length + '.\n' +
      'Instruksi user: "' + instruction + '"\n\n' +
      '```\n' + chunks[i].text + '\n```\n\n' +
      'Apakah bagian ini mengandung kode yang perlu diubah sesuai instruksi? ' +
      'Jawab PERSIS dengan format:\n' +
      'FOUND: ya/tidak\n' +
      'SECTION: (jika ya: salin PERSIS blok fungsi/kelas/bagian relevan — cukup bagian yang perlu diubah, bukan seluruh chunk)';
    try {
      const { text: findText } = await askGemini(findPrompt, [], false);
      if (/^FOUND:\s*ya/im.test(findText)) {
        const secMatch = findText.match(/^SECTION:\s*([\s\S]+)$/im);
        foundChunkText = (secMatch ? secMatch[1].trim() : chunks[i].text);
        console.log('[editFileInChunks] Found target in chunk ' + (i + 1) + '/' + chunks.length);
        break;
      }
    } catch (e) {
      console.warn('[editFileInChunks] find pass error chunk ' + (i + 1) + ': ' + e.message);
    }
  }

  if (!foundChunkText) {
    await message.reply(
      '⚠️ AI tidak menemukan bagian yang relevan di **' + att.name + '** untuk instruksi tersebut.\n' +
      'Coba sebutkan nama fungsi/kelas yang spesifik, contoh: "perbaiki fungsi `handleLogin`".'
    ).catch(() => {});
    return;
  }

  // Pass 2: SEARCH/REPLACE pada section yang ditemukan
  await message.channel.sendTyping().catch(() => {});
  const editPrompt = buildTargetedEditPrompt(instruction, att.name, foundChunkText);
  let editText;
  try {
    ({ text: editText } = await askGemini(editPrompt, history, isDMOwner));
  } catch (e) {
    await message.reply('⚠️ AI gagal mengedit **' + att.name + '**: ' + e.message).catch(() => {});
    return;
  }

  const patches = parseSearchReplaceBlocks(editText);
  if (!patches.length) {
    const explanation = stripCodeBlocks(editText).slice(0, 1500);
    await message.reply({
      content: ('⚠️ AI tidak menghasilkan patch yang valid untuk **' + att.name + '**. ' +
        'Coba instruksi lebih spesifik (sebutkan nama fungsi).\n\n' + explanation).slice(0, 2000),
      flags: MessageFlags.SuppressEmbeds,
    }).catch(() => {});
    return;
  }

  const { content: patched, failed, appliedCount } = applySearchReplace(content, patches);
  if (appliedCount === 0) {
    await message.reply(
      '⚠️ Gagal menerapkan perubahan ke **' + att.name + '** — potongan kode yang disebut AI tidak cocok persis. ' +
      'Coba instruksi lebih spesifik.'
    ).catch(() => {});
    return;
  }

  const warn = failed.length
    ? '\n⚠️ ' + failed.length + ' dari ' + patches.length + ' perubahan GAGAL (kode tidak cocok persis) — bagian itu tidak berubah.'
    : '';
  const explanation = stripCodeBlocks(editText).slice(0, 600);
  await message.reply({
    content: ('✅ **' + att.name + '** — ' + appliedCount + '/' + patches.length + ' perubahan diterapkan ' +
      '(' + Math.round(patched.length / 1024) + 'KB).' + warn + '\n' + explanation).slice(0, 2000),
    files: [makeFile(patched, att.name)],
    flags: MessageFlags.SuppressEmbeds,
  });
}


// ============================================================
// HELP TEXT (shared antara handler dengan dan tanpa mention)
// ============================================================

// ============================================================
// WARZONE — BATTLE ROYALE ENGINE v3
// ============================================================

const WZ_WEAPONS = {
  common:    [
    { name: 'Paper Hand',    emoji: '🤲', min: 8,  max: 18 },
    { name: 'Keyboard Bash', emoji: '⌨️', min: 10, max: 20 },
  ],
  rare:      [
    { name: 'FUD Pistol',    emoji: '🔫', min: 15, max: 28 },
    { name: 'Dump Blade',    emoji: '🗡️', min: 17, max: 30 },
  ],
  epic:      [
    { name: 'Moon Cannon',   emoji: '🌙', min: 24, max: 40 },
    { name: 'Rug Pull Hook', emoji: '🪝', min: 26, max: 42 },
  ],
  legendary: [
    { name: 'HODL Hammer',   emoji: '🔨', min: 36, max: 55 },
    { name: 'Satoshi Blade', emoji: '⚔️', min: 40, max: 58 },
  ],
  mythic:    [
    { name: 'God Candle',    emoji: '🕯️', min: 62, max: 90 },
    { name: 'Infinity Token',emoji: '♾️', min: 68, max: 95 },
  ],
};
const WZ_TIER_ORDER = ['common', 'rare', 'epic', 'legendary', 'mythic'];
const WZ_TIER_BADGE = { common: '⬜', rare: '🟦', epic: '🟪', legendary: '🟨', mythic: '🔴' };

// ── Zone config: nama + warna embed + gambar ─────────────────
// Ganti URL gambar sesuai selera — pakai link Discord attachment
// atau hosting gambar lain. Set null untuk tidak pakai gambar.
const WZ_ZONES = [
  {
    name:  '🗺️ Peta Penuh',
    color: 0x57F287,   // hijau — aman
    image: 'https://i.imgur.com/8Km9tLL.png',
    desc:  'Zona masih penuh. Semua area aman.',
  },
  {
    name:  '⚠️ Zona Menyempit',
    color: 0xFEE75C,   // kuning — waspada
    image: 'https://i.imgur.com/yV4JZKH.png',
    desc:  'Zona mulai menyempit. Jauhi batas!',
  },
  {
    name:  '🌀 Badai Merah',
    color: 0xF0A500,   // oranye — bahaya
    image: 'https://i.imgur.com/RQMxlGK.png',
    desc:  'Badai merah menyapu. Damage zona meningkat.',
  },
  {
    name:  '☠️ Zona Mematikan',
    color: 0xED4245,   // merah — sangat berbahaya
    image: 'https://i.imgur.com/2kPBZyS.png',
    desc:  'Zona mematikan. Setiap detik nyawa taruhan.',
  },
  {
    name:  '💀 FINAL ZONE',
    color: 0x2B2D31,   // hitam — chaos total
    image: 'https://i.imgur.com/4Xqg7bS.png',
    desc:  'FINAL ZONE. Tidak ada tempat bersembunyi.',
  },
];

const WZ_COLORS = {
  intro:    0x5865F2,
  round:    0x36393F,
  event:    0xF59E0B,
  killfeed: 0xED4245,
  status:   0x5865F2,
  winner:   0xF1C40F,
  lobby:    0x5865F2,
};

// Bot branding untuk author embed
const WZ_AUTHOR = { name: 'CLIZA.AI · Warzone', iconURL: 'https://i.imgur.com/jcSMxMV.png' };

function wz_randomWeapon(tier) {
  if (!tier) {
    const r = Math.random();
    tier = r < 0.38 ? 'common' : r < 0.65 ? 'rare' : r < 0.84 ? 'epic' : r < 0.96 ? 'legendary' : 'mythic';
  }
  const list = WZ_WEAPONS[tier];
  return { ...list[Math.floor(Math.random() * list.length)], tier };
}

function wz_hpBar(hp, maxHp) {
  const pct = Math.max(0, hp / maxHp);
  const filled = Math.round(pct * 10);
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const icon = pct > 0.6 ? '🟢' : pct > 0.3 ? '🟡' : hp > 0 ? '🔴' : '💀';
  return `${icon} \`${bar}\` ${hp}/${maxHp}`;
}

function wz_makePlayer(user) {
  return {
    id: user.id,
    name: user.username,
    displayName: user.displayName || user.globalName || user.username,
    hp: 175, maxHp: 175,
    armor: 0,
    weapon: wz_randomWeapon('common'),
    kills: 0, damageDealt: 0,
    alive: true, shield: false,
    position: Math.floor(Math.random() * 4),
  };
}

// ── Event handlers ──────────────────────────────────────────
function wz_evSupplyDrop(game, alive) {
  const lucky = alive[Math.floor(Math.random() * alive.length)];
  const tier = Math.random() < 0.5 ? 'legendary' : 'mythic';
  lucky.weapon = wz_randomWeapon(tier);
  return [`🎁 **${lucky.displayName}** dapat supply drop! ${lucky.weapon.emoji} **${lucky.weapon.name}** (${WZ_TIER_BADGE[tier]} ${tier.toUpperCase()})`];
}
function wz_evAirstrike(game, alive) {
  if (!alive || alive.length === 0) return [];
  const lines = [];
  const count = Math.max(1, Math.ceil(alive.length * 0.4));
  const victims = [...alive].sort(() => Math.random() - 0.5).slice(0, count);
  for (const v of victims) {
    const dmg = Math.floor(Math.random() * 20 + 12);
    v.hp -= dmg; v.hp = Math.max(0, v.hp);
    if (v.hp <= 0) { v.alive = false; lines.push(`💣 **${v.displayName}** hancur kena bom! ☠️`); }
    else lines.push(`💣 **${v.displayName}** kena serangan udara −${dmg}HP _(sisa ${v.hp}HP)_`);
  }
  return lines;
}
function wz_evMedkit(game, alive) {
  const lines = [];
  for (const p of alive) {
    const heal = Math.floor(Math.random() * 28 + 12);
    p.hp = Math.min(p.hp + heal, p.maxHp);
    lines.push(`💊 **${p.displayName}** +${heal}HP → ${p.hp}/${p.maxHp}HP`);
  }
  return lines;
}
function wz_evZoneSurge(game, alive) {
  if (!alive || alive.length === 0) return [];
  const lines = [];
  const dmg = Math.floor(Math.random() * 16 + 8);
  for (const p of alive) {
    p.hp -= dmg; p.hp = Math.max(0, p.hp);
    if (p.hp <= 0) { p.alive = false; lines.push(`⚡ **${p.displayName}** tersapu storm surge! ☠️`); }
    else lines.push(`⚡ **${p.displayName}** −${dmg}HP dari storm surge _(sisa ${p.hp}HP)_`);
  }
  return lines;
}
function wz_evBetrayal(game, alive) {
  if (alive.length < 2) return ['_Tidak ada yang dikhianati..._'];
  const victim   = alive[Math.floor(Math.random() * alive.length)];
  const betrayers = alive.filter(p => p.id !== victim.id);
  const betrayer = betrayers[Math.floor(Math.random() * betrayers.length)];
  const dmg = Math.floor(Math.random() * 32 + 16);
  victim.hp -= dmg; victim.hp = Math.max(0, victim.hp);
  betrayer.damageDealt += dmg;
  if (victim.hp <= 0) {
    victim.alive = false; betrayer.kills++;
    return [`🗡️ **${betrayer.displayName}** menghianati **${victim.displayName}** dari belakang... DIBUNUH! (−${dmg}HP) ☠️`];
  }
  return [`🗡️ **${betrayer.displayName}** tikam **${victim.displayName}** dari belakang −${dmg}HP _(sisa ${victim.hp}HP)_`];
}
function wz_evRageMode(game, alive) {
  if (!alive || alive.length === 0) return [];
  game.dmg2x = true;
  return ['🔥 **RAGE MODE AKTIF!** Semua damage **2× lipat** ronde ini — chaos total!'];
}
function wz_evSecondWind(game, alive) {
  if (!alive || alive.length === 0) return [];
  let total = 0;
  for (const p of alive) { const h = Math.floor(Math.random() * 22 + 8); p.hp = Math.min(p.hp + h, p.maxHp); total += h; }
  return [`💓 **Second Wind!** Semua pejuang +HP! Total +${total}HP ke ${alive.length} pemain!`];
}
function wz_evSniperDuel(game, alive) {
  if (alive.length < 2) return ['_Tidak cukup pemain untuk duel..._'];
  const [a, b] = [...alive].sort((x, y) => y.hp - x.hp).slice(0, 2);
  const dA = Math.floor(Math.random() * 42 + 22);
  const dB = Math.floor(Math.random() * 42 + 22);
  const lines = [`🎯 **SNIPER DUEL:** **${a.displayName}** vs **${b.displayName}**!`];
  a.hp -= dB; a.hp = Math.max(0, a.hp); b.hp -= dA; b.hp = Math.max(0, b.hp);
  a.damageDealt += dA; b.damageDealt += dB;
  if (a.hp <= 0) { a.alive = false; b.kills++; lines.push(`💥 **${a.displayName}** jatuh! **${b.displayName}** menang duel! ☠️`); }
  else lines.push(`💥 **${a.displayName}** −${dB}HP _(sisa ${a.hp}HP)_`);
  if (b.hp <= 0) { b.alive = false; a.kills++; lines.push(`💥 **${b.displayName}** tumbang! **${a.displayName}** menang! ☠️`); }
  else lines.push(`💥 **${b.displayName}** −${dA}HP _(sisa ${b.hp}HP)_`);
  return lines;
}
function wz_evShieldDrop(game, alive) {
  const lucky = alive[Math.floor(Math.random() * alive.length)];
  lucky.shield = true;
  return [`🛡️ **${lucky.displayName}** menemukan **Energi Shield**! Serangan berikutnya diserap 70%!`];
}
function wz_evCryptoWar(game, alive) {
  if (alive.length < 2) return ['_Tidak cukup untuk Crypto War..._'];
  const sorted = [...alive].sort((a, b) => b.hp - a.hp);
  const [a, b] = sorted.slice(0, 2);
  const dmg = Math.floor(Math.random() * 28 + 18);
  a.hp -= dmg; a.hp = Math.max(0, a.hp);
  b.hp -= dmg; b.hp = Math.max(0, b.hp);
  a.damageDealt += dmg; b.damageDealt += dmg;
  const lines = ['📉 **CRYPTO WAR!** Token anjlok 90% — semua trader panik saling serang!'];
  if (a.hp <= 0) { a.alive = false; lines.push(`📉 **${a.displayName}** di-rug pull habis! ☠️`); }
  else lines.push(`📉 **${a.displayName}** −${dmg}HP dari market crash _(sisa ${a.hp}HP)_`);
  if (b.hp <= 0) { b.alive = false; lines.push(`📉 **${b.displayName}** REKT total! ☠️`); }
  else lines.push(`📉 **${b.displayName}** −${dmg}HP dari market crash _(sisa ${b.hp}HP)_`);
  return lines;
}

// Kill flavour text per senjata
const WZ_KILL_MSGS = {
  'Paper Hand':    ['panic sell nyawanya','fold di momen kritis','REKT total','menyerah di titik terendah'],
  'Keyboard Bash': ['spam attack sampai KO','ctrl+alt+delete nyawanya','lag kills','buffering... deceased'],
  'FUD Pistol':    ['tembak FUD ke kepala','spread bad news satu peluru','satu shot NGMI','RIP weak hands'],
  'Dump Blade':    ['dump habis-habisan','sell pressure mematikan','bear market fatal','liquidity habis'],
  'Moon Cannon':   ['To the moon... tanpa kembali 🌙','ONE SHOT moonshot','launched to heaven'],
  'Rug Pull Hook': ['ditarik dari bawah','rug pulled ke dimensi lain','exit scammed nyawanya'],
  'HODL Hammer':   ['diamond hand smash 💎','HODL sampai yang lain mati','tidak goyah, tidak ampun'],
  'Satoshi Blade': ['satoshi smite ⚡','genesis block menghantam','original killer'],
  'God Candle':    ['GREEN CANDLE DARI LANGIT 🕯️','pump hingga mati','candle mematikan dari dewa'],
  'Infinity Token':['INFINITE DAMAGE ♾️','existence: terminated','unlimited power kills'],
};
function wz_killLine(atk, def, dmg, isCrit, hadShield) {
  const msgs = WZ_KILL_MSGS[atk.weapon.name] || ['menghabisi'];
  const flavor = msgs[Math.floor(Math.random() * msgs.length)];
  const critTag   = isCrit    ? ' ⚡ **CRITICAL!**' : '';
  const shieldTag = hadShield ? ' *(shield ditembus!)*' : '';
  return `☠️ **${atk.displayName}** ${atk.weapon.emoji} ${flavor} **${def.displayName}** *(−${dmg}HP)*${critTag}${shieldTag}`;
}
function wz_hitLine(atk, def, dmg, isCrit, hadShield) {
  const critTag   = isCrit    ? ' ⚡ **CRIT!**' : '';
  const shieldTag = hadShield ? ' 🛡️*(absorbed)*' : '';
  return `🩸 **${atk.displayName}** → **${def.displayName}** −${dmg}HP${critTag}${shieldTag} _(sisa ${def.hp}HP)_`;
}

const WZ_EVENTS = [
  { name: '📦 Supply Drop',     fn: wz_evSupplyDrop  },
  { name: '💣 Airstrike',       fn: wz_evAirstrike   },
  { name: '💊 Medkit Spawn',    fn: wz_evMedkit      },
  { name: '⚡ Storm Surge',     fn: wz_evZoneSurge   },
  { name: '🗡️ Pengkhianatan',  fn: wz_evBetrayal    },
  { name: '🔥 RAGE MODE',       fn: wz_evRageMode    },
  { name: '💓 Second Wind',     fn: wz_evSecondWind  },
  { name: '🎯 Sniper Duel',     fn: wz_evSniperDuel  },
  { name: '🛡️ Shield Drop',    fn: wz_evShieldDrop  },
  { name: '📉 Crypto War',      fn: wz_evCryptoWar   },
];

// ── Lobby embed ──────────────────────────────────────────────
function wz_lobbyEmbed(lb) {
  const elapsed   = Math.floor((Date.now() - lb.startTime) / 1000);
  const remaining = Math.max(0, 90 - elapsed);
  const pct = Math.max(0, remaining / 90);
  const f = Math.round(pct * 15);
  const timerBar = '[' + '█'.repeat(f) + '░'.repeat(15 - f) + '] ' + remaining + 's';
  return new EmbedBuilder()
    .setColor(WZ_COLORS.lobby)
    .setAuthor(WZ_AUTHOR)
    .setTitle('⚔️  WARZONE — LOBBY TERBUKA')
    .setDescription(
      `👑 **Host:** ${lb.hostName}\n\n` +
      `👥 **Pemain (${lb.players.length}/20)**\n` +
      (lb.players.map(p => `> ⚔️ **${p.displayName}**`).join('\n') || '> _(kosong)_') +
      `\n\n⏱️ \`${timerBar}\``
    )
    .addFields(
      { name: '⚔️ Gabung', value: 'Klik tombol di bawah', inline: true },
      { name: '▶️ Mulai', value: 'Host bisa mulai kapan saja', inline: true },
      { name: '👥 Min/Maks', value: '2 — 20 pemain', inline: true },
    )
    .setFooter({ text: 'Auto-start setelah 90 detik' })
    .setTimestamp();
}
function wz_lobbyText(lb) { return ''; }

// ── Main game loop ────────────────────────────────────────────
async function wz_runGame(channel, players) {
  const game = {
    players,
    round: 0, zone: 0, zoneDmg: 0,
    dmg2x: false,
  };
  warzoneGames.set(channel.id, game);

  // ── Intro embed ──────────────────────────────────────────
  const curZone = WZ_ZONES[0];
  const introEmbed = new EmbedBuilder()
    .setColor(curZone.color)
    .setAuthor(WZ_AUTHOR)
    .setTitle('⚔️  W A R Z O N E  —  B A T T L E  R O Y A L E')
    .setDescription(
      `**${players.length} pejuang** siap. Hanya satu yang bisa bertahan.\n\n` +
      players.map((p, i) => {
        const medal = i < 3 ? ['🥇','🥈','🥉'][i] : '⚔️';
        return `${medal} **${p.displayName}** · ${WZ_TIER_BADGE[p.weapon.tier]}${p.weapon.emoji} ${p.weapon.name}`;
      }).join('\n')
    )
    .addFields(
      { name: '❤️ HP Awal', value: '175', inline: true },
      { name: '🗺️ Zona', value: curZone.name, inline: true },
      { name: '⚡ Zone mulai', value: 'Ronde 4+', inline: true },
    )
    .setFooter({ text: curZone.desc })
    .setTimestamp();
  if (curZone.image) introEmbed.setImage(curZone.image);

  await channel.send({ embeds: [introEmbed] }).catch(() => {});

  // ── Animated countdown ──────────────────────────────────
  await new Promise(r => setTimeout(r, 900));
  const cdMsg = await channel.send({ content: '> ⏳ Bersiap...', flags: MessageFlags.SuppressEmbeds }).catch(() => null);
  if (cdMsg) {
    for (const txt of ['# 3️⃣', '# 3️⃣  2️⃣', '# 3️⃣  2️⃣  1️⃣', '# ⚔️  F I G H T !']) {
      await new Promise(r => setTimeout(r, 900));
      await cdMsg.edit({ content: txt, flags: MessageFlags.SuppressEmbeds }).catch(() => {});
    }
    await new Promise(r => setTimeout(r, 700));
  }

  const runRound = async () => {
    game.round++;
    game.dmg2x = false;
    const alive = game.players.filter(p => p.alive);
    if (alive.length <= 1) { await wz_endGame(channel, game); return; }

    // Zone progression setiap 4 ronde
    let zoneChanged = false;
    if (game.round % 4 === 0 && game.zone < WZ_ZONES.length - 1) {
      game.zone++;
      game.zoneDmg = game.zone * 6;
      zoneChanged = true;
    }

    const zone = WZ_ZONES[game.zone];

    // Zone change alert embed — tampilkan gambar zona baru
    if (zoneChanged) {
      const zoneEmbed = new EmbedBuilder()
        .setColor(zone.color)
        .setAuthor(WZ_AUTHOR)
        .setTitle('⚠️  ZONA MENYEMPIT!  →  ' + zone.name)
        .setDescription(zone.desc + (game.zoneDmg > 0 ? `\n\n💀 Zone damage: **−${game.zoneDmg}HP** per ronde · 35% chance terkena` : ''));
      if (zone.image) zoneEmbed.setImage(zone.image);
      await channel.send({ embeds: [zoneEmbed] }).catch(() => {});
      await new Promise(r => setTimeout(r, 700));
    }

    // ── Random event ──
    const evChance = 0.30 + game.round * 0.015;
    let eventLines = [];
    let eventName = '';
    if (Math.random() < evChance) {
      const ev = WZ_EVENTS[Math.floor(Math.random() * WZ_EVENTS.length)];
      eventName = ev.name;
      eventLines = ev.fn(game, alive.filter(p => p.alive));
    }

    // ── Combat ──
    const fighters = [...alive].filter(p => p.alive).sort(() => Math.random() - 0.5);
    const killFeed = [];
    for (const atk of fighters) {
      if (!atk.alive) continue;
      const targets = fighters.filter(p => p.alive && p.id !== atk.id);
      if (!targets.length) continue;
      const def = targets[Math.floor(Math.random() * targets.length)];
      const mult = game.dmg2x ? 2 : 1;
      let dmg = Math.floor((Math.random() * (atk.weapon.max - atk.weapon.min) + atk.weapon.min) * mult);
      const isCrit = Math.random() < 0.15;
      if (isCrit) dmg = Math.floor(dmg * 1.6);
      const hadShield = def.shield;
      if (hadShield) { dmg = Math.floor(dmg * 0.3); def.shield = false; }
      def.hp -= dmg; def.hp = Math.max(0, def.hp);
      atk.damageDealt += dmg;
      if (def.hp <= 0) {
        def.alive = false; atk.kills++;
        const curIdx = WZ_TIER_ORDER.indexOf(atk.weapon.tier);
        const upgraded = curIdx < WZ_TIER_ORDER.length - 1 && Math.random() < 0.55;
        if (upgraded) atk.weapon = wz_randomWeapon(WZ_TIER_ORDER[curIdx + 1]);
        killFeed.push(
          wz_killLine(atk, def, dmg, isCrit, hadShield) +
          (upgraded ? '  ↑ _loot → ' + WZ_TIER_BADGE[atk.weapon.tier] + atk.weapon.emoji + ' **' + atk.weapon.name + '**!_' : '')
        );
      } else {
        killFeed.push(wz_hitLine(atk, def, dmg, isCrit, hadShield));
      }
    }

    // Zone damage (35% chance)
    const zoneLines = [];
    if (game.zoneDmg > 0) {
      for (const p of game.players.filter(pp => pp.alive)) {
        if (Math.random() < 0.35) {
          p.hp -= game.zoneDmg; p.hp = Math.max(0, p.hp);
          if (p.hp <= 0) { p.alive = false; zoneLines.push(`🌀 **${p.displayName}** tewas tersapu zona! ☠️`); }
          else zoneLines.push(`🌀 **${p.displayName}** −${game.zoneDmg}HP dari zona _(sisa ${p.hp}HP)_`);
        }
      }
    }

    const nowAlive = game.players.filter(p => p.alive);
    const nowDead  = game.players.filter(p => !p.alive);

    // ── Embed 1: Round header + event ───────────────────────
    let e1desc = '';
    if (eventLines.length) {
      e1desc = eventLines.map(l => `> ${l}`).join('\n');
    } else {
      e1desc = '_Tidak ada event ronde ini._';
    }
    const roundEmbed = new EmbedBuilder()
      .setColor(eventLines.length ? WZ_COLORS.event : zone.color)
      .setAuthor(WZ_AUTHOR)
      .setTitle(`⚔️  RONDE ${game.round}  ·  ${alive.length} pejuang tersisa`)
      .setDescription(e1desc)
      .addFields(
        { name: '🗺️ Zona', value: zone.name, inline: true },
        { name: '💀 Zone Dmg', value: game.zoneDmg > 0 ? `−${game.zoneDmg}HP/ronde` : 'Belum aktif', inline: true },
        { name: '🎲 Event', value: eventLines.length ? eventName : '—', inline: true },
      )
      .setTimestamp();

    // ── Embed 2: Kill feed (merah) ──────────────────────────
    const allCombat = [...killFeed, ...zoneLines];
    const killEmbed = allCombat.length
      ? new EmbedBuilder()
          .setColor(WZ_COLORS.killfeed)
          .setTitle('📢  K I L L  F E E D')
          .setDescription(allCombat.join('\n').slice(0, 4000))
      : null;

    // ── Embed 3: Status board — gunakan fields inline 2 kolom ──
    const statusEmbed = new EmbedBuilder()
      .setColor(zone.color)
      .setTitle('📊  S T A T U S  B O A R D  ·  ' + nowAlive.length + ' Hidup');

    if (nowAlive.length > 0) {
      // Tiap pemain = 1 field inline, Discord susun 2-3 per baris otomatis
      const fields = nowAlive.map(p => {
        const killBadge = p.kills >= 4 ? ' 🔥' : p.kills >= 2 ? ' ⚡' : '';
        return {
          name: (p.alive ? '⚔️' : '☠️') + ' ' + p.displayName + killBadge + (p.shield ? ' 🛡️' : ''),
          value: wz_hpBar(p.hp, p.maxHp) + '\n' + WZ_TIER_BADGE[p.weapon.tier] + p.weapon.emoji + ' ' + p.weapon.name + ' · ' + p.kills + '🔪',
          inline: true,
        };
      });
      // Discord max 25 fields
      statusEmbed.addFields(fields.slice(0, 24));
    }

    if (nowDead.length) {
      statusEmbed.setFooter({ text: '☠️ Gugur: ' + nowDead.map(p => p.displayName).join(', ') });
    }

    const embeds = [roundEmbed, killEmbed, statusEmbed].filter(Boolean);
    await channel.send({ embeds }).catch(() => {});

    const survivors = game.players.filter(p => p.alive);
    if (survivors.length <= 1) {
      await new Promise(r => setTimeout(r, 2200));
      await wz_endGame(channel, game);
    } else {
      await new Promise(r => setTimeout(r, 5000));
      await runRound();
    }
  };

  try {
    await runRound();
  } catch (e) {
    console.error('[warzone] runRound crash:', e);
    warzoneGames.delete(channel.id);
    channel.send('⚠️ Game Warzone mengalami error dan dihentikan.').catch(() => {});
  }
}

async function wz_endGame(channel, game) {
  warzoneGames.delete(channel.id);
  const winner = game.players.find(p => p.alive);
  const byKills = [...game.players].sort((a, b) => b.kills - a.kills || b.damageDealt - a.damageDealt);
  const byDmg   = [...game.players].sort((a, b) => b.damageDealt - a.damageDealt);

  const medals = ['🥇','🥈','🥉'];
  const killBadgeFn = (k) => k >= 5 ? ' 🔥🔥' : k >= 3 ? ' 🔥' : '';

  // ── End screen title embed ───────────────────────────────
  const finalZone = WZ_ZONES[game.zone];
  const titleEmbed = new EmbedBuilder()
    .setColor(winner ? WZ_COLORS.winner : WZ_COLORS.killfeed)
    .setAuthor(WZ_AUTHOR)
    .setTitle(winner ? '🏆  ' + winner.displayName.toUpperCase() + '  MENANG!' : '💀  TIDAK ADA PEMENANG!')
    .setDescription(
      winner
        ? `> *"Hanya yang terkuat yang bertahan."*\n\n⚔️ Ronde: **${game.round}** · Pejuang: **${game.players.length}** · Zona: **${finalZone.name}**`
        : `> *"Semua pejuang gugur dalam pertempuran."*\n\n⚔️ Ronde: **${game.round}** · Pejuang: **${game.players.length}**`
    )
    .setTimestamp();
  if (winner && finalZone.image) titleEmbed.setThumbnail(finalZone.image);

  // ── Scoreboard — fields inline per pemain ───────────────
  const scoreEmbed = new EmbedBuilder()
    .setColor(WZ_COLORS.status)
    .setAuthor(WZ_AUTHOR)
    .setTitle('📊  P A P A N  S K O R  A K H I R');

  const scoreFields = byKills.slice(0, 24).map((p, i) => {
    const med = medals[i] || (i + 1) + '.';
    const st  = p.alive ? '✅ Hidup' : '☠️ Gugur';
    return {
      name: med + ' ' + p.displayName + killBadgeFn(p.kills),
      value: `${p.kills}🔪 kills · ${p.damageDealt} dmg\n${st} · ${WZ_TIER_BADGE[p.weapon.tier]}${p.weapon.emoji}`,
      inline: true,
    };
  });
  scoreEmbed.addFields(scoreFields);

  const mvp = byKills[0].kills > 0 ? `🎖️ MVP: **${byKills[0].displayName}** — ${byKills[0].kills} kills` : null;
  const top = `💥 Top Damage: **${byDmg[0].displayName}** — ${byDmg[0].damageDealt} dmg`;
  scoreEmbed.setFooter({ text: [mvp, top].filter(Boolean).join('  ·  ') });

  const againBtn = new ButtonBuilder()
    .setCustomId('warzone_again_' + channel.id)
    .setLabel('⚔️ Warzone Lagi!')
    .setStyle(ButtonStyle.Success);

  await channel.send({
    content: '_Ketik `!warzone` atau klik tombol untuk main lagi!_',
    embeds: [titleEmbed, scoreEmbed],
    components: [new ActionRowBuilder().addComponents(againBtn)],
  }).catch(() => {});
}

// COMMAND_PAGES — teks !command (multi-part, maks 1900 char/halaman)
// ============================================================
const COMMAND_PAGES = [
  // ── Embed 1/2 ─────────────────────────────────────────────
  `📖 **CLIZA.AI — Daftar Command (1/2)**

⚡ **TANPA TAG** — langsung ketik di channel

💰 **HARGA & MARKET**
\`\`\`
price [COIN]            Harga kripto real-time (CoinGecko)
p [COIN]                Singkatan price
[jml] [COIN] to [COIN]  Konversi (1 ETH to USDT, 5k USDC ke IDR)
gainers                 Top gainer kripto hari ini
losers                  Top loser kripto hari ini
market                  Overview kondisi market kripto
\`\`\`
📊 **CHART TEKNIKAL**
\`\`\`
c [simbol]              Chart default 4h — kripto, saham IDX, forex, komoditas
c [simbol] [tf]         Timeframe: 1m 5m 15m 30m 1h 2h 4h 6h 1d 1w
c [simbol] [tf] [N]     Candle custom (contoh: c ETH 1h 50)
                        Kripto: BTC ETH SOL | Saham IDX: BBCA TLKM ASII
                        Saham US: AAPL TSLA NVDA | Forex: EURUSD GBPJPY
                        Komoditas: XAU (emas) XAG (perak) OIL (minyak)
\`\`\`
📈 **CRYPTORANK**
\`\`\`
cr [COIN]               Data harga & market cap token
gainers / losers        Top gainer/loser 24h
market                  Ringkasan kondisi market
\`\`\`
🔍 **GMGN — ANALISIS TOKEN & CHAIN**
\`\`\`
gmgn <CA>               Analisis token (auto-detect chain)
gmgn <chain> <CA>       eth / bsc / base / sol / robinhood
gmgn holders <CA>       Top holder + unrealized PnL
gmgn chart <CA> [tf]    Kline OHLCV: 1m 5m 1h 4h 1d
\`\`\`
📡 **GMGN — MARKET & SIGNAL**
\`\`\`
gmgn trending [chain] [tf]   Trending: tf = 1m 5m 1h 6h 24h
gmgn new [chain]             Token baru launch (Pump.fun dll)
gmgn new near [chain]        Near graduation (bonding curve penuh)
gmgn new grad [chain]        Sudah graduate ke DEX
gmgn signal [chain]          Real-time signal (sol/bsc)
\`\`\`
🧠 **GMGN — SMART MONEY, KOL & WALLET**
\`\`\`
gmgn smartmoney [chain]      Feed buy/sell smart money wallet
gmgn kol [chain]             Feed buy/sell KOL/influencer
gmgn smart <CA>              Top smart traders token ini
gmgn wallet <address>        Analisis wallet + aktivitas terbaru
gmgn wallet <chain> <addr>   Specify chain: sol eth bsc base robinhood
gmgn dev <wallet>            Cek track record developer
\`\`\``,

  // ── Embed 2/2 ─────────────────────────────────────────────
  `📖 **CLIZA.AI — Daftar Command (2/2)**

🛡️ **TOKEN SCANNER (SCAM CHECK)**
\`\`\`
!base <CA>              Scan scam token Base Network
!read <CA>              Baca SEMUA data contract: ERC20, read/write functions, pool
!read eth <CA>          Sama untuk Ethereum  |  !read bsc <CA>  BNB Chain
!read <CA> <fn> [args]  Panggil fungsi dengan argumen (factory, pair, dll)
!sol <CA>               Scan scam token Solana
!sherlock <username>    Cari akun sosmed by username (OSINT)
\`\`\`
🕹️ **OSINT INVESTIGASI**
\`\`\`
!ip <address>           Geolocation, ISP, ASN, proxy/VPN check
!dns <domain>           DNS records lengkap (A, MX, TXT, NS, dll)
!github <username>      Profil GitHub OSINT (repo, email, lokasi)
!phone <nomor>          Lacak nomor telepon (carrier, investigasi link)
!geophoto [+ foto]      Ekstrak GPS dari foto yang di-attach
!geo-photo <url>        Ekstrak GPS dari URL foto (ExifLooter style)
!geoip <ip>             Koordinat GPS + maps dari IP address
!maps <lat,lon>         Semua link maps dari koordinat
!timezone <lokasi>      Timezone & waktu lokal kota/negara
\`\`\`
🔍 **OSINT SAFETY SCAN**
\`\`\`
scan <url/domain/ip>    Cek keamanan URL / domain / IP
recon <domain>          DNS, subdomain, whois, ASN
recon endpoints <url>   Ekstrak semua API endpoint dari halaman web
                        (scan HTML + JS files, kategorikan per tipe)
                        Contoh: recon endpoints https://example.com/api
ports <ip>              Open ports + CVE (Shodan)
whois <domain>          Info registrar & tanggal domain
leak <email>            Cek email terkait infostealer (Hudson Rock)
\`\`\`
💧 **LP ANALYSIS (LIQUIDITY POOL)**
\`\`\`
lp <CA> [modal] [range%]   Analisa LP: range, ratio, IL, fee APR
                           Contoh: lp EPjFWdd5... 500 20
lp pnl <CA> <entry> <modal> [range%] [hari]
                           P&L nyata: IL aktual, fee earned, net P&L
                           fee coverage ratio, break-even
                           Contoh: lp pnl EPj... 0.00015 500 20 30
lp rebalance <CA>          Saran range optimal dari volatilitas σ:
                           3 strategi (agresif/moderat/konservatif)
                           Contoh: lp rebalance EPj...
lp pos <wallet>            Posisi LP aktif di wallet
\`\`\`
💼 **PORTFOLIO & ZERION**
\`\`\`
balance [0x.../ENS]     Portfolio wallet (aset, PnL, chain)
positions [0x.../ENS]   Detail posisi token per chain
txs [0x.../ENS]         10 transaksi terakhir wallet
pnl [0x.../ENS]         P&L detail + top movers 24h
nft [0x.../ENS]         Koleksi NFT milik wallet
ztoken [simbol/CA]      Info token via Zerion (harga, mcap, chain)
gas                     Gas price real-time semua chain
twit [username]         Riwayat username Twitter/X
twit [u1],[u2]          Cek beberapa akun sekaligus
\`\`\`
💬 **DENGAN MENTION @bot**
\`\`\`
@bot [pertanyaan]       Chat AI bebas (analisis, coding, dll)
@bot price/gainers/losers/market/cr [COIN]
@bot c [simbol] [tf]    Chart via mention (kripto/saham/forex/komoditas)
@bot balance [wallet]   Portfolio via mention
@bot twit [username]    Twitter history via mention
@bot scan/recon/ports/whois/leak <target>
@bot [CA EVM/SOL]       Paste address → auto analisis token
@bot + file             Analisis file/dokumen/kode
\`\`\`
⚙️ **UTILITAS**
\`\`\`
!warzone                Battle Royale — siapa yang bertahan terakhir?
!command                Tampilkan daftar command ini
!provider               Status & urutan AI provider aktif
@bot !clearhistory      Hapus riwayat chat AI sesi ini
\`\`\`
💡 Setiap respons ada tombol 🗑️ **Hapus** — hanya pengirim yang bisa menekan.`,
];

// ============================================================
// HANDLER UTAMA
// ============================================================

const _PROCESSED_MSG_IDS = new Set();
// Map<lastMsgId, [msgId1, msgId2, ...]> — track semua pesan per scan agar delete bisa hapus semua
const _scanMsgMap = new Map();
// Map<channelId, { att, content, timestamp }> — ingat file terakhir per channel (30 menit)
const _lastProcessedFile = new Map();
const _LAST_FILE_TTL = 30 * 60 * 1000;
// Warzone game state
const warzoneLobbies = new Map(); // channelId -> lobby data
const warzoneGames   = new Map(); // channelId -> in-progress game
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // ── Deduplicate: cegah double-response saat 2 instance bot berjalan bersamaan ──
    if (_PROCESSED_MSG_IDS.has(message.id)) return;
    _PROCESSED_MSG_IDS.add(message.id);
    setTimeout(() => _PROCESSED_MSG_IDS.delete(message.id), 30000);

    const isDM = !message.guild;
    const mentioned = message.mentions.users.has(client.user.id);

    // === Owner commands tanpa tag (no @mention) ===
    if (!mentioned && !isDM && message.author.id === OWNER_ID) {
      const rawCmd = message.content.trim().toLowerCase();

      // === !balance — cek saldo ETH & USDC wallet bot (hanya owner) ===
      if (rawCmd === '!balance') {
        await message.channel.sendTyping().catch(() => {});
        try {
          const _bal = await getBalance();
          const _balReply =
            '💰 **Saldo Wallet Bot (Base Mainnet)**\n' +
            '```\n' +
            'Alamat : ' + _bal.address + '\n' +
            'ETH    : ' + _bal.eth + ' ETH\n' +
            'USDC   : ' + _bal.usdc + ' USDC\n' +
            '```' +
            '🔗 [Basescan](<https://basescan.org/address/' + _bal.address + '>)';
          await message.reply({
            content: _balReply,
            components: [makeDeleteRow(message.author.id)],
          });
        } catch (e) {
          await message.reply('❌ Gagal cek saldo: ' + e.message).catch(() => {});
        }
        return;
      }

      // === !setkey <provider> — jadikan provider tersebut prioritas utama (owner only) ===
      if (rawCmd.startsWith('!setkey ')) {
        var _skParts = message.content.trim().split(/\s+/);
        var _skProvider = (_skParts[1] || '').toLowerCase();
        if (!ALL_PROVIDERS.includes(_skProvider)) {
          await message.reply('❌ Provider tidak dikenal. Pilihan: `' + ALL_PROVIDERS.join(', ') + '`').catch(function(){});
          return;
        }
        var _skStatus = getAgentStatus();
        var _skOrder = [..._skStatus.order];
        if (!_skOrder.includes(_skProvider)) _skOrder.push(_skProvider);
        _skOrder = [_skProvider, ..._skOrder.filter(function(p) { return p !== _skProvider; })];
        setAgentOrder(_skOrder);
        await store.saveKey('provider_order', _skOrder).catch(function(e) { console.warn('[store] provider_order:', e.message); });
        var _skKeys = _skStatus.keyCount[_skProvider] || 0;
        await message.reply(
          '✅ Provider utama diset ke **' + _skProvider.toUpperCase() + '**\n' +
          '> Urutan baru: `' + _skOrder.join(' → ') + '`\n' +
          (_skKeys === 0 ? '⚠️ Tidak ada key untuk ' + _skProvider + ' di env Railway — bot akan skip provider ini.' : '> ' + _skKeys + ' key tersedia di env.')
        ).catch(function(){});
        return;
      }

      // === !provider — panel tombel provider AI ===
      if (rawCmd === '!provider') {
        await message.reply(makeProviderPanel()).catch(function(){});
        return;
      }

      // === !providerstatus — status singkat ===
      if (rawCmd === '!providerstatus') {
        var _psStatus = getAgentStatus();
        var _psOrder = _psStatus.order;
        var _psKeys = _psStatus.keyCount;
        var _psLines = ALL_PROVIDERS.map(function(p) {
          var inOrder = _psOrder.includes(p);
          var m = PROVIDER_META[p];
          return (inOrder ? '🟢' : '🔴') + ' **' + m.label + '**: ' + (_psKeys[p] || 0) + ' key' + (inOrder ? ' (aktif, posisi #' + (_psOrder.indexOf(p) + 1) + ')' : ' (nonaktif)');
        });
        await message.reply('**Status Provider AI**\n' + _psLines.join('\n') + '\n\nUrutan: `' + (_psOrder.join(' → ') || 'kosong') + '`').catch(function(){});
        return;
      }

      // === send <nominal> <token> to <alamat> — kirim ETH/USDC (hanya owner) ===
      const _sendOptsA = parseSendCommand(message.content.trim());
      if (_sendOptsA) {
        await message.channel.sendTyping().catch(() => {});
        const _amtLabelA = _sendOptsA.amount + ' ' + _sendOptsA.token.toUpperCase();
        const _waitMsgA = await message.reply(
          '⏳ Mengirim **' + _amtLabelA + '** ke `' + _sendOptsA.to + '`...' +
          '\n_Tunggu konfirmasi blockchain Base..._'
        ).catch(() => null);
        try {
          const _resA = await sendToken(_sendOptsA);
          const _sendEmbedOkA = new EmbedBuilder()
            .setColor(EMBED_COLORS.send)
            .setTitle('✅ Transfer Berhasil')
            .addFields(
              { name: 'Token', value: _resA.token, inline: true },
              { name: 'Nominal', value: _resA.amount + ' ' + _resA.token, inline: true },
              { name: 'Dari', value: '`' + _resA.from + '`', inline: false },
              { name: 'Ke', value: '`' + _resA.to + '`', inline: false },
              { name: 'Block', value: '#' + _resA.blockNumber, inline: true },
              { name: 'Basescan', value: '[Lihat TX](' + _resA.txUrl + ')', inline: true }
            );
          const _sendOptsOkA = { embeds: [_sendEmbedOkA], components: [makeDeleteRow(message.author.id)] };
          if (_waitMsgA) await _waitMsgA.edit(_sendOptsOkA).catch(() => {});
          else await message.reply(_sendOptsOkA).catch(() => {});
        } catch (e) {
          const _sendEmbedErrA = new EmbedBuilder().setColor(0xED4245).setTitle('❌ Gagal Kirim').setDescription(e.message);
          const _sendErrOptsA = { embeds: [_sendEmbedErrA], components: [makeDeleteRow(message.author.id)] };
          if (_waitMsgA) await _waitMsgA.edit(_sendErrOptsA).catch(() => {});
          else await message.reply(_sendErrOptsA).catch(() => {});
        }
        return;
      }

      // === multisend <nominal> <token> to <addr1> <addr2>... — kirim ke banyak wallet (hanya owner) ===
      const _msOptsA = parseMultisendCommand(message.content.trim());
      if (_msOptsA) {
        await message.channel.sendTyping().catch(() => {});
        const _msLabelA = _msOptsA.amount + ' ' + (/^0x[a-fA-F0-9]{40}$/i.test(_msOptsA.token) ? _msOptsA.token.slice(0,6)+'...'+_msOptsA.token.slice(-4) : _msOptsA.token.toUpperCase()) + ' × ' + _msOptsA.recipients.length + ' wallet';
        const _msWaitA = await message.reply(
          '⏳ Multisend **' + _msLabelA + '**...\n_Eksekusi kontrak Base Mainnet..._'
        ).catch(() => null);
        try {
          const _msResA = await executeMultisend(_msOptsA);
          const _msEmbedOkA = new EmbedBuilder()
            .setColor(EMBED_COLORS.send)
            .setTitle('✅ Multisend Berhasil')
            .addFields(
              { name: 'Token', value: _msResA.token, inline: true },
              { name: 'Per Wallet', value: _msResA.amountPerWallet + ' ' + _msResA.token, inline: true },
              { name: 'Total Kirim', value: _msResA.totalAmount + ' ' + _msResA.token, inline: true },
              { name: 'Jumlah Wallet', value: String(_msResA.recipients.length), inline: true },
              { name: 'Dari', value: '`' + _msResA.from + '`', inline: false },
              { name: 'Block', value: '#' + _msResA.blockNumber, inline: true },
              { name: 'Basescan', value: '[Lihat TX](' + _msResA.txUrl + ')', inline: true }
            );
          const _msOptsOkA = { embeds: [_msEmbedOkA], components: [makeDeleteRow(message.author.id)] };
          if (_msWaitA) await _msWaitA.edit(_msOptsOkA).catch(() => {});
          else await message.reply(_msOptsOkA).catch(() => {});
        } catch (e) {
          const _msEmbedErrA = new EmbedBuilder().setColor(0xED4245).setTitle('❌ Gagal Multisend').setDescription(e.message);
          const _msErrOptsA = { embeds: [_msEmbedErrA], components: [makeDeleteRow(message.author.id)] };
          if (_msWaitA) await _msWaitA.edit(_msErrOptsA).catch(() => {});
          else await message.reply(_msErrOptsA).catch(() => {});
        }
        return;
      }

      // === !delete [n] tanpa mention — hapus n pesan bot (hanya owner) ===
      if (/^!delete\s+\d+$/i.test(rawCmd)) {
        const n = Math.min(parseInt(message.content.trim().split(/\s+/)[1], 10), 100);
        message.delete().catch(() => {});
        const fetched = await message.channel.messages.fetch({ limit: 100 });
        const mine = [...fetched.values()]
          .filter(m => m.author.id === client.user.id)
          .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
          .slice(0, n);
        for (const m of mine) {
          await m.delete().catch(() => {});
          await new Promise(r => setTimeout(r, 500));
        }
        return;
      }

      // === !discordinfo <user_id> — Info akun Discord dari ID (owner, channel & DM) ===
      if (/^!discordinfo\b/i.test(message.content)) {
        const _uid = message.content.replace(/^!discordinfo\s*/i, '').trim();
        if (!_uid || !/^\d{15,21}$/.test(_uid)) {
          await message.reply('\u274C Format salah. Contoh: `!discordinfo 298936604148490240`').catch(() => {});
          return;
        }
        await message.channel.sendTyping().catch(() => {});
        try {
          const _dr = await fetch('https://discord.com/api/v10/users/' + _uid, {
            headers: { Authorization: 'Bot ' + process.env.DISCORD_TOKEN },
            signal: AbortSignal.timeout(8000),
          });
          if (!_dr.ok) { await message.reply('\u274C User tidak ditemukan (status ' + _dr.status + ')').catch(() => {}); return; }
          const _du = await _dr.json();
          const _createdMs = Number(BigInt(_uid) >> 22n) + 1420070400000;
          const _created = new Date(_createdMs).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          const _ageDays = Math.floor((Date.now() - _createdMs) / 86400000);
          const _ageYears = (_ageDays / 365).toFixed(1);
          const _flags = _du.public_flags || 0;
          const _badgeMap = [
            [1 << 0,  '\u{1F451} Discord Staff'], [1 << 1,  '\u{1F91D} Partnered Server Owner'],
            [1 << 2,  '\u{1F3AA} HypeSquad Events'], [1 << 3,  '\u{1F41B} Bug Hunter Lv1'],
            [1 << 6,  '\u{1F3E0} HypeSquad Bravery'], [1 << 7,  '\u{1F3E0} HypeSquad Brilliance'],
            [1 << 8,  '\u{1F3E0} HypeSquad Balance'], [1 << 9,  '\u{1F48E} Early Supporter'],
            [1 << 14, '\u{1F41B} Bug Hunter Lv2'], [1 << 17, '\u{1F468}\u200D\u{1F4BB} Early Verified Bot Dev'],
            [1 << 18, '\u{1F4D6} Discord Certified Mod'], [1 << 22, '\u{1F9D1}\u200D\u{1F4BB} Active Developer'],
          ];
          const _badges = _badgeMap.filter(([f]) => (_flags & f) === f).map(([,n]) => n);
          if (_du.bot) _badges.unshift('\u{1F916} Bot');
          const _avatar = _du.avatar
            ? 'https://cdn.discordapp.com/avatars/' + _uid + '/' + _du.avatar + '.png'
            : '(tidak ada avatar)';
          const _banner = _du.banner
            ? 'https://cdn.discordapp.com/banners/' + _uid + '/' + _du.banner + '.png'
            : null;
          const _diFields = [
            { name: '\u{1F464} Username', value: (_du.global_name || _du.username) + ' (@' + _du.username + ')', inline: false },
            { name: '\u{1F194} User ID', value: _uid, inline: true },
            { name: '\u{1F4C5} Dibuat', value: _created + ' WIB', inline: true },
            { name: '\u23F3 Umur Akun', value: _ageDays + ' hari (~' + _ageYears + ' tahun)', inline: true },
            { name: '\u{1F5BC}\uFE0F Avatar', value: _avatar, inline: false },
          ];
          if (_banner) _diFields.push({ name: '\u{1F3A8} Banner', value: _banner, inline: false });
          _diFields.push({ name: '\u{1F3C5} Badge', value: _badges.length ? _badges.join(', ') : 'Tidak ada', inline: false });
          const _diThumb = _du.avatar ? 'https://cdn.discordapp.com/avatars/' + _uid + '/' + _du.avatar + '.png' : null;
          const _diEmbed = new EmbedBuilder()
            .setColor(EMBED_COLORS.osint)
            .setTitle('\u{1F50D} Discord User Info')
            .addFields(_diFields);
          if (_diThumb) _diEmbed.setThumbnail(_diThumb);
          await message.reply({ embeds: [_diEmbed], components: [makeDeleteRow(message.author.id)] }).catch(() => {});
        } catch (e) { await message.reply('\u274C Error: ' + e.message).catch(() => {}); }
        return;
      }

      // === !dstatus — Status Discord sekarang (owner, channel & DM) ===
      if (rawCmd === '!dstatus') {
        await message.channel.sendTyping().catch(() => {});
        try {
          const [_sRes, _cRes] = await Promise.all([
            fetch('https://discordstatus.com/api/v2/status.json', { signal: AbortSignal.timeout(8000) }),
            fetch('https://discordstatus.com/api/v2/components.json', { signal: AbortSignal.timeout(8000) }),
          ]);
          const _st = await _sRes.json();
          const _co = await _cRes.json();
          const _indMap = { none: '\u2705', minor: '\u{1F7E1}', major: '\u{1F534}', critical: '\u{1F534}', maintenance: '\u{1F527}' };
          const _stMap = {
            operational: '\u2705 Normal', degraded_performance: '\u{1F7E1} Lambat',
            partial_outage: '\u{1F7E0} Sebagian Down', major_outage: '\u{1F534} Down',
            under_maintenance: '\u{1F527} Maintenance',
          };
          const _overall = _indMap[_st.status.indicator] || '\u2753';
          const _showcased = (_co.components || []).filter(c => c.showcase && !c.group);
          const _compText = _showcased.map(c => (_stMap[c.status] || c.status) + ' \u2014 ' + c.name).join('\n') || 'Tidak ada data';
          const _updated = new Date(_st.page.updated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
          const _dsColor = _st.status.indicator === 'none' ? 0x57F287
            : _st.status.indicator === 'minor' ? 0xF1C40F
            : _st.status.indicator === 'maintenance' ? 0x5865F2 : 0xED4245;
          const _dsEmbed = new EmbedBuilder()
            .setColor(_dsColor)
            .setTitle('\u{1F4E1} Status Discord \u2014 ' + _overall + ' ' + _st.status.description)
            .addFields(
              { name: 'Komponen', value: _compText.slice(0, 1024), inline: false },
              { name: '\u23F0 Update terakhir', value: _updated + ' WIB', inline: false }
            );
          await message.reply({ embeds: [_dsEmbed], components: [makeDeleteRow(message.author.id)] }).catch(() => {});
        } catch (e) { await message.reply('\u274C Error: ' + e.message).catch(() => {}); }
        return;
      }

      // === !serverinfo <invite> — Info server dari invite link (owner, channel & DM) ===
      if (/^!serverinfo\b/i.test(message.content)) {
        const _raw = message.content.replace(/^!serverinfo\s*/i, '').trim();
        const _code = _raw.replace(/.*discord(?:app)?\.gg\/(?:invite\/)?/i, '').replace(/[^a-zA-Z0-9-]/g, '');
        if (!_code) {
          await message.reply('\u274C Format salah. Contoh: `!serverinfo discord.gg/ABC123` atau `!serverinfo ABC123`').catch(() => {});
          return;
        }
        await message.channel.sendTyping().catch(() => {});
        try {
          const _ir = await fetch('https://discord.com/api/v10/invites/' + _code + '?with_counts=true&with_expiration=true', {
            headers: { Authorization: 'Bot ' + process.env.DISCORD_TOKEN },
            signal: AbortSignal.timeout(8000),
          });
          if (!_ir.ok) {
            await message.reply('\u274C Invite tidak valid atau sudah expired (status ' + _ir.status + ')').catch(() => {});
            return;
          }
          const _inv = await _ir.json();
          const _srv = _inv.guild || {};
          const _ch  = _inv.channel || {};
          const _inviter = _inv.inviter ? ('@' + _inv.inviter.username) : 'Tidak diketahui';
          const _icon = _srv.icon
            ? 'https://cdn.discordapp.com/icons/' + _srv.id + '/' + _srv.icon + '.png'
            : '(tidak ada icon)';
          const _srvCreated = _srv.id
            ? new Date(Number(BigInt(_srv.id) >> 22n) + 1420070400000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
            : '-';
          const _features = (_srv.features || []).map(f => f.replace(/_/g, ' ')).join(', ') || 'Tidak ada';
          const _siFields = [
            { name: '\u{1F194} Server ID', value: _srv.id || '-', inline: true },
            { name: '\u{1F4C5} Dibuat', value: _srvCreated + ' WIB', inline: true },
            { name: '\u{1F465} Member', value: (_inv.approximate_member_count || '?') + ' (online: ' + (_inv.approximate_presence_count || '?') + ')', inline: true },
            { name: '\u{1F4E2} Channel', value: '#' + (_ch.name || '-'), inline: true },
            { name: '\u{1F517} Invite', value: 'discord.gg/' + _code + ' (oleh ' + _inviter + ')', inline: true },
            { name: '\u2728 Fitur', value: _features.slice(0, 1024) || 'Tidak ada', inline: false },
          ];
          if (_srv.description) _siFields.unshift({ name: '\u{1F4DD} Deskripsi', value: _srv.description, inline: false });
          const _siEmbed = new EmbedBuilder()
            .setColor(EMBED_COLORS.default)
            .setTitle('\u{1F3F0} ' + (_srv.name || 'Server Info'))
            .addFields(_siFields);
          if (_icon && _icon.startsWith('http')) _siEmbed.setThumbnail(_icon);
          await message.reply({ embeds: [_siEmbed], components: [makeDeleteRow(message.author.id)] }).catch(() => {});
        } catch (e) { await message.reply('\u274C Error: ' + e.message).catch(() => {}); }
        return;
      }


      // === !reactor — panel status reactor tanpa mention ===
      if (rawCmd === '!reactor') {
        const _rcPanel2 = await makeReactorPanel();
        const _rcMsg2 = await message.reply(_rcPanel2).catch(() => null);
        if (_rcMsg2) _scanMsgMap.set(_rcMsg2.id, [_rcMsg2]);
        return;
      }

      // === !ai — panel kontrol AI tanpa mention ===
      if (rawCmd.startsWith('!ai')) {
        const _aiQ2   = rawCmd;
        const _guildId2 = message.guild ? message.guild.id : null;
        const _chId2    = message.channel.id;
        if (_aiQ2.includes(' off')) {
          if (_aiQ2.includes('all')) { aiGlobalOff = true; }
          else if (_aiQ2.includes('server') || _aiQ2.includes('sv')) { if (_guildId2) aiDisabled.add('sv:' + _guildId2); }
          else { aiDisabled.add('ch:' + _chId2); }
          saveAiState();
        } else if (_aiQ2.includes(' on')) {
          if (_aiQ2.includes('all')) { aiGlobalOff = false; }
          else if (_aiQ2.includes('server') || _aiQ2.includes('sv')) { if (_guildId2) aiDisabled.delete('sv:' + _guildId2); }
          else { aiDisabled.delete('ch:' + _chId2); }
          saveAiState();
        }
        // Build embed panel
        const _dsvLines2 = [], _dchLines2 = [];
        for (const k of aiDisabled) {
          if (k.startsWith('sv:')) { const g2 = client.guilds.cache.get(k.slice(3)); _dsvLines2.push('🔴 ' + (g2 ? g2.name : k.slice(3))); }
          else if (k.startsWith('ch:')) { const ch2 = client.channels.cache.get(k.slice(3)); _dchLines2.push('🔴 ' + (ch2 ? '#' + (ch2.name || k.slice(3)) : '#' + k.slice(3)) + ((ch2 && ch2.guild) ? ' (' + ch2.guild.name + ')' : '')); }
        }
        const _allGuilds2 = client.guilds.cache.map(g2 => (aiGlobalOff || aiDisabled.has('sv:' + g2.id) ? '🔴' : '🟢') + ' ' + g2.name + ' (' + g2.memberCount + ' members)');
        const _aiEmbed2 = new EmbedBuilder()
          .setColor(aiGlobalOff ? 0xED4245 : 0x57F287)
          .setTitle('🤖 Panel Kontrol AI')
          .setTimestamp()
          .addFields(
            { name: '🌐 Status Global', value: aiGlobalOff ? '🔴 MATI (Global)' : '🟢 HIDUP (Global)', inline: true },
            { name: '🏠 Server Ini', value: (_guildId2 && aiDisabled.has('sv:' + _guildId2)) ? '🔴 MATI' : '🟢 HIDUP', inline: true },
            { name: '💬 Channel Ini', value: aiDisabled.has('ch:' + _chId2) ? '🔴 MATI' : '🟢 HIDUP', inline: true },
          );
        if (_allGuilds2.length) _aiEmbed2.addFields({ name: '📋 Server Bot (' + _allGuilds2.length + ')', value: _allGuilds2.slice(0, 15).join('\n').slice(0, 1024) || '—', inline: false });
        if (_dsvLines2.length) _aiEmbed2.addFields({ name: '🚫 Server Nonaktif', value: _dsvLines2.slice(0, 10).join('\n').slice(0, 1024), inline: false });
        if (_dchLines2.length) _aiEmbed2.addFields({ name: '🚫 Channel Nonaktif', value: _dchLines2.slice(0, 10).join('\n').slice(0, 1024), inline: false });
        if (!aiGlobalOff && !_dsvLines2.length && !_dchLines2.length) _aiEmbed2.addFields({ name: '✅ Status', value: 'AI aktif di semua server & channel.', inline: false });
        const _svDisabled2 = _guildId2 && aiDisabled.has('sv:' + _guildId2);
        const _chDisabled2 = aiDisabled.has('ch:' + _chId2);
        const _aiRow1b = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ai_global_off').setLabel('🔇 Global OFF').setStyle(ButtonStyle.Danger).setDisabled(aiGlobalOff),
          new ButtonBuilder().setCustomId('ai_global_on').setLabel('🔊 Global ON').setStyle(ButtonStyle.Success).setDisabled(!aiGlobalOff),
          new ButtonBuilder().setCustomId('ai_sv_toggle').setLabel(_svDisabled2 ? '🟢 Server ON' : '🔴 Server OFF').setStyle(_svDisabled2 ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId('ai_ch_toggle').setLabel(_chDisabled2 ? '🟢 Channel ON' : '🔴 Channel OFF').setStyle(_chDisabled2 ? ButtonStyle.Success : ButtonStyle.Danger),
        );
        const _aiRow2b = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId('ai_del').setLabel('🗑️ Tutup').setStyle(ButtonStyle.Secondary),
        );
        const _aiMsg2 = await message.reply({ embeds: [_aiEmbed2], components: [_aiRow1b, _aiRow2b] }).catch(() => null);
        if (_aiMsg2) _scanMsgMap.set(_aiMsg2.id, [_aiMsg2]);
        return;
      }
    }


    // === !command tanpa tag — daftar command lengkap (semua user) ===
    if (!mentioned && !isDM && message.content.trim().toLowerCase() === '!command') {
      try {

        const _cmdSentNT = [];
        for (let _ci = 0; _ci < COMMAND_PAGES.length; _ci++) {
          const _isLast = _ci === COMMAND_PAGES.length - 1;
          const _pageEmbed = new EmbedBuilder().setColor(0x5865F2).setDescription(COMMAND_PAGES[_ci]);
          const _pageOpts = { embeds: [_pageEmbed] };
          if (_isLast) _pageOpts.components = [makeDeleteRow(message.author.id)];
          const _m = _ci === 0
            ? await message.reply(_pageOpts).catch(() => null)
            : await message.channel.send(_pageOpts).catch(() => null);
          if (_m) _cmdSentNT.push(_m);
        }
        if (_cmdSentNT.length > 0) {
          const _cmdLast = _cmdSentNT[_cmdSentNT.length - 1];
          _scanMsgMap.set(_cmdLast.id, [..._cmdSentNT]);
          setTimeout(() => _scanMsgMap.delete(_cmdLast.id), 2 * 60 * 60 * 1000);
        }
      } catch (e) {
        await message.reply('❌ Gagal tampilkan command: ' + e.message).catch(() => {});
      }
      return;
    }

    // === !translate code tanpa tag — daftar kode bahasa translate (semua user) ===
    if (!mentioned && !isDM && message.content.trim().toLowerCase() === '!translate code') {
      try {
        await sendTranslateCodePages(message);
      } catch (e) {
        await message.reply('❌ Gagal tampilkan daftar kode: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Crypto/price tanpa tag: "5k usdc to idr" atau "price btc" ===
    if (!mentioned && !isDM) {
      // [SAFETY GUARD] Wrap seluruh blok dalam try-catch agar jika ada library
      // yg rusak/tidak ada, bot TIDAK merespons pesan random di server.
      try {
      const rawText = message.content.trim();
      const noTagConv = await detectCryptoConversion(rawText);
      const noTagPrice = !noTagConv ? detectPriceQuery(rawText) : null;
      const noTagAmount = (!noTagConv && !noTagPrice) ? await detectAmountQuery(rawText) : null;
      if (noTagConv || noTagPrice || noTagAmount) {
        await message.channel.sendTyping().catch(() => {});
        try {
          let noTagResult, noTagThumb;
          if (noTagConv) {
            noTagResult = await fetchCryptoConversion(noTagConv);
            noTagThumb = null;
          } else if (noTagPrice) {
            const noTagPriceResult = await fetchCoinPrice(noTagPrice);
            noTagResult = noTagPriceResult.text;
            noTagThumb = noTagPriceResult.thumbnail;
          } else {
            const noTagAmountResult = await fetchAmountPrice(noTagAmount);
            noTagResult = noTagAmountResult.text;
            noTagThumb = noTagAmountResult.thumbnail;
          }
          await sendEmbedReply(message, noTagResult, priceEmbedColor(noTagResult), null, [makeDeleteRow(message.author.id)], noTagThumb);
        } catch (e) {
          await message.reply('Gagal ambil data: ' + e.message).catch(() => {});
        }
        return; // ← pastikan tidak lanjut ke handler lain setelah harga ditangani
      }
      // === CryptoRank tanpa tag: cr BTC | gainers | losers | market ===
      const noTagCr = detectCrQuery(rawText);
      if (noTagCr) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const noTagCrResult = await handleCrCommand(noTagCr.type, noTagCr.symbol);
          const _ntCrColor = noTagCr.type === 'gainers' ? EMBED_COLORS.gainers
            : noTagCr.type === 'losers' ? EMBED_COLORS.losers
            : noTagCr.type === 'market' ? EMBED_COLORS.market : EMBED_COLORS.cr;
          await sendEmbedReply(message, noTagCrResult, _ntCrColor, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          await message.reply('Gagal ambil data CryptoRank: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Twitter history tanpa tag: "twit monad" ===
      const noTagTwit = detectTwitterQuery(rawText);
      if (noTagTwit) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const noTagTwitMsgs = await fetchTwitterHistory(noTagTwit.usernames);
          await sendEmbedReply(message, noTagTwitMsgs.join('\n'), EMBED_COLORS.twitter, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
        }
        return;
      }

            // === Chart command tanpa tag: C BTC / C ETH 4h / C ETH 4h 30 ===
      const chartRawMatch = rawText.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
      if (chartRawMatch) {
        await message.channel.sendTyping().catch(() => {});
        try {
          await handleChartCommand(message, chartRawMatch[1], chartRawMatch[2] || '4h', chartRawMatch[3]);
        } catch (e) {
          await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
        }
        return;
      }
      // !shuffle bisa dipakai tanpa mention — lanjut ke handler utama
      // === Zerion portfolio: "balance 0xABC" tanpa mention ===
      const balAddr = detectBalanceQuery(rawText);
      if (balAddr) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const balResult = await fetchZerionPortfolio(balAddr);
          await sendEmbedReply(message, balResult, EMBED_COLORS.balance, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          await message.reply('❌ Gagal ambil data Zerion: ' + e.message).catch(() => {});
        }
        return;
      }

      // === Zerion: txs <wallet> ===
        const txsAddr = detectTxsQuery(rawText);
        if (txsAddr) {
          await message.channel.sendTyping().catch(() => {});
          try {
            const result = await fetchZerionTransactions(txsAddr);
            await sendEmbedReply(message, result, EMBED_COLORS.zerion_txs, null, [makeDeleteRow(message.author.id)]);
          } catch (e) {
            await message.reply('❌ Gagal ambil transaksi Zerion: ' + e.message).catch(() => {});
          }
          return;
        }

        // === Zerion: positions <wallet> ===
        const posAddr = detectPositionsQuery(rawText);
        if (posAddr) {
          await message.channel.sendTyping().catch(() => {});
          try {
            const result = await fetchZerionPositions(posAddr);
            await sendEmbedReply(message, result, EMBED_COLORS.zerion_pos, null, [makeDeleteRow(message.author.id)]);
          } catch (e) {
            await message.reply('❌ Gagal ambil posisi Zerion: ' + e.message).catch(() => {});
          }
          return;
        }

        // === Zerion: nft <wallet> ===
        const nftAddr = detectNFTQuery(rawText);
        if (nftAddr) {
          await message.channel.sendTyping().catch(() => {});
          try {
            const result = await fetchZerionNFTs(nftAddr);
            await sendEmbedReply(message, result, EMBED_COLORS.zerion_nft, null, [makeDeleteRow(message.author.id)]);
          } catch (e) {
            await message.reply('❌ Gagal ambil NFT Zerion: ' + e.message).catch(() => {});
          }
          return;
        }

        // === Zerion: gas ===
        if (detectGasQuery(rawText)) {
          await message.channel.sendTyping().catch(() => {});
          try {
            const result = await fetchZerionGas();
            await sendEmbedReply(message, result, EMBED_COLORS.zerion_gas, null, [makeDeleteRow(message.author.id)]);
          } catch (e) {
            await message.reply('❌ Gagal ambil gas price: ' + e.message).catch(() => {});
          }
          return;
        }

        // === Zerion: ztoken <simbol/CA> ===
        const ztokenQ = detectZTokenQuery(rawText);
        if (ztokenQ) {
          await message.channel.sendTyping().catch(() => {});
          try {
            const result = await fetchZerionToken(ztokenQ);
            await sendEmbedReply(message, result, EMBED_COLORS.zerion_token, null, [makeDeleteRow(message.author.id)]);
          } catch (e) {
            await message.reply('❌ Gagal ambil info token: ' + e.message).catch(() => {});
          }
          return;
        }

        // === Zerion: pnl <wallet> ===
        const pnlAddr = detectPnLQuery(rawText);
        if (pnlAddr) {
          await message.channel.sendTyping().catch(() => {});
          try {
            const result = await fetchZerionPnL(pnlAddr);
            await sendEmbedReply(message, result, EMBED_COLORS.zerion_pnl, null, [makeDeleteRow(message.author.id)]);
          } catch (e) {
            await message.reply('❌ Gagal ambil PnL Zerion: ' + e.message).catch(() => {});
          }
          return;
        }

        // === GMGN commands: gmgn <CA> | gmgn smart | gmgn new | gmgn trending | gmgn wallet | gmgn holder ===
      const gmgnQuery = detectGmgnQuery(rawText);
      if (gmgnQuery) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const gmgnResult = await handleGmgnCommand(gmgnQuery);
          await sendEmbedReply(message, gmgnResult, EMBED_COLORS.gmgn, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          await message.reply('❌ Gagal ambil data GMGN: ' + e.message).catch(() => {});
        }
        return;
      }

      // === LP Analysis: lp <CA> [modal] [range%] ===
      const _lpQuery = detectLpQuery(rawText);
      if (_lpQuery) {
        await message.channel.sendTyping().catch(() => {});
        const _lpTyping = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
        try {
          const _lpResult = await handleLpCommand(_lpQuery);
          clearInterval(_lpTyping);
          await sendEmbedReply(message, _lpResult, EMBED_COLORS.lp, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          clearInterval(_lpTyping);
          await message.reply('❌ Gagal analisa LP: ' + e.message).catch(() => {});
        }
        return;
      }

      // === !read <ca> [chain] — Read all contract view functions ===
        if (/^!read\s+/i.test(rawText)) {
          const _rcQuery = detectReadContractQuery(rawText);
          if (_rcQuery) {
            await message.channel.sendTyping().catch(() => {});
            const _rcTyping = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
            try {
              const _rcResult = await handleReadContractCommand(_rcQuery);
              clearInterval(_rcTyping);
              await sendEmbedReply(message, _rcResult, EMBED_COLORS.read_contract, null, [makeDeleteRow(message.author.id)]);
            } catch (e) {
              clearInterval(_rcTyping);
              await message.reply('\u274c Gagal baca contract: ' + e.message).catch(() => {});
            }
            return;
          }
        }

              // === !base <ca> — Base Network token scam scanner (tanpa mention) ===
      if (/^!base\s+0x[0-9a-fA-F]{40}/i.test(rawText)) {
        const caMatch = rawText.match(/0x[0-9a-fA-F]{40}/i);
        if (caMatch) {
          await message.channel.sendTyping().catch(() => {});
          const _baseTyping = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
          try {
            const { runBaseScanner } = require('./lib/baseScanner');
            const _baseResult = await runBaseScanner(caMatch[0]);
            clearInterval(_baseTyping);
            const _baseSentMsgs = await sendEmbedReply(message, _baseResult, EMBED_COLORS.base_scan, null, [makeDeleteRow(message.author.id)]);
            if (_baseSentMsgs.length > 0) {
              const _lastMsg = _baseSentMsgs[_baseSentMsgs.length - 1];
              _scanMsgMap.set(_lastMsg.id, [..._baseSentMsgs]);
              setTimeout(() => _scanMsgMap.delete(_lastMsg.id), 2 * 60 * 60 * 1000);
            }
          } catch (e) {
            clearInterval(_baseTyping);
            await message.reply('❌ Gagal scan token: ' + e.message).catch(() => {});
          }
          return;
        }
      }


      // === !sol <ca> — Solana token scanner (pump.fun) ===
      if (/^!sol\s+[1-9A-HJ-NP-Za-km-z]{32,44}/i.test(rawText)) {
        const _solCaMatch = rawText.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
        if (_solCaMatch) {
          await message.channel.sendTyping().catch(() => {});
          const _solTyping = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
          try {
            const { runSolScanner } = require('./lib/solScanner');
            const _solResult = await runSolScanner(_solCaMatch[0]);
            clearInterval(_solTyping);
            const _solSentMsgs = await sendEmbedReply(message, _solResult, EMBED_COLORS.sol_scan, null, [makeDeleteRow(message.author.id)]);
            if (_solSentMsgs.length > 0) {
              const _solLastMsg = _solSentMsgs[_solSentMsgs.length - 1];
              _scanMsgMap.set(_solLastMsg.id, [..._solSentMsgs]);
              setTimeout(() => _scanMsgMap.delete(_solLastMsg.id), 2 * 60 * 60 * 1000);
            }
          } catch (e) {
            clearInterval(_solTyping);
            await message.reply('❌ Gagal scan token SOL: ' + e.message).catch(() => {});
          }
          return;
        }
      }


      // === !sherlock <username> — OSINT username search (tanpa mention) ===
      if (/^!sherlock\s+\S+/i.test(rawText)) {
        const _shUser = rawText.split(/\s+/)[1];
        if (!_shUser) {
          await message.reply('❌ Format: `!sherlock <username>`').catch(() => {});
          return;
        }
        await message.channel.sendTyping().catch(() => {});
        const _shTypingInterval = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
        let _shStatusMsg = null;
        try {
          _shStatusMsg = await message.reply({
            content: `🔍 Mencari **${_shUser}** di 55+ platform... (30-60 detik)`,
            flags: MessageFlags.SuppressEmbeds,
          }).catch(() => null);

          const _shFound = await searchUsername(_shUser, (checked, total, foundCount) => {
            if (_shStatusMsg && checked % 15 === 0) {
              _shStatusMsg.edit({
                content: `🔍 Mencari **${_shUser}** ... ${checked}/${total} dicek, ${foundCount} ditemukan`,
                flags: MessageFlags.SuppressEmbeds,
              }).catch(() => {});
            }
          });

          clearInterval(_shTypingInterval);

          let _shResult;
          let _shResultText;
          if (_shFound.length === 0) {
            _shResultText = '🔍 **Sherlock OSINT — @' + _shUser + '**\n\n❌ Tidak ditemukan akun dengan username ini di platform yang dicek.\n_(55 platform dicek)_';
          } else {
            const _shLines = _shFound.map(r => '• [' + r.name + '](' + r.url + ')');
            _shResultText = '🔍 **Sherlock OSINT — @' + _shUser + '**\n✅ Ditemukan di **' + _shFound.length + '** platform:\n\n' + _shLines.join('\n');
          }

          if (_shStatusMsg) await _shStatusMsg.delete().catch(() => {});

          const _shSentMsgs = await sendEmbedReply(message, _shResultText, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
          if (_shSentMsgs.length > 0) {
            const _shLast = _shSentMsgs[_shSentMsgs.length - 1];
            _scanMsgMap.set(_shLast.id, [..._shSentMsgs]);
            setTimeout(() => _scanMsgMap.delete(_shLast.id), 2 * 60 * 60 * 1000);
          }
        } catch (e) {
          clearInterval(_shTypingInterval);
          if (_shStatusMsg) await _shStatusMsg.delete().catch(() => {});
          await message.reply('❌ Sherlock gagal: ' + e.message).catch(() => {});
        }
        return;
      }



      // === !warzone test — simulasi battle royale 10 bot (no lobby) ===
      if (/^!warzone\s+test$/i.test(rawText)) {
        if (warzoneGames.has(message.channel.id)) {
          await message.reply('⚔️ Warzone sedang berjalan di sini! Tunggu dulu.').catch(() => {});
          return;
        }
        if (warzoneLobbies.has(message.channel.id)) {
          await message.reply('⚠️ Ada lobby aktif di channel ini!').catch(() => {});
          return;
        }

        // Nama-nama bot NPC yang berwarna
        const WZ_BOT_NAMES = [
          'ShadowWolf','BloodAxe','IronFist','ChaosKing','VenomBlade',
          'ThunderClaw','DarkMage','SkullCrush','NightRaven','FireStorm',
          'GhostBane','StormBreaker','DeathMark','SilentKill','BlazeRunner',
          'CryptoSniper','MoonSlayer','AcidRain','VoidWalker','CursedKnight',
          'RageBeast','FrostBite','HellDiver','SteelFang','ToxicShot',
          'GrimReaper','LightBane','BoneCrusher','SoulEater','PhantomStrike',
        ];

        // Shuffle & ambil 10 nama unik
        const shuffled = [...WZ_BOT_NAMES].sort(() => Math.random() - 0.5);
        const picked   = shuffled.slice(0, 10);

        // Buat fake player objects (struktur sama dengan wz_makePlayer)
        const fakePlayers = picked.map((name, i) => ({
          id:           `bot_${i}_${Date.now()}`,
          name,
          displayName:  name,
          hp: 100, maxHp: 100,
          armor: 0,
          weapon:       wz_randomWeapon('common'),
          kills: 0, damageDealt: 0,
          alive: true, shield: false,
          position:     Math.floor(Math.random() * 4),
          isBot:        true,
        }));

        await message.reply(
          `🤖 **WARZONE TEST MODE** — ${fakePlayers.length} bot NPC siap bertarung!
` +
          `👾 ${fakePlayers.map(p => `**${p.displayName}**`).join(', ')}
` +
          `_Game dimulai dalam 2 detik..._`
        ).catch(() => {});

        await new Promise(r => setTimeout(r, 2000));
        wz_runGame(message.channel, fakePlayers)
          .catch(e => console.error('[warzone-test] error:', e));
        return;
      }

      // === !warzone — Battle Royale Game ===
      if (/^!warzone$/i.test(rawText)) {
        if (warzoneGames.has(message.channel.id)) {
          await message.reply('⚔️ Warzone sedang berjalan di channel ini! Tunggu hingga selesai.').catch(() => {});
          return;
        }
        if (warzoneLobbies.has(message.channel.id)) {
          await message.reply('⚠️ Sudah ada lobby Warzone aktif! Klik tombol untuk bergabung.').catch(() => {});
          return;
        }

        const hostPlayer = wz_makePlayer(message.author);
        const lb = {
          host: message.author.id,
          hostName: message.author.displayName || message.author.globalName || message.author.username,
          players: [hostPlayer],
          playerIds: new Set([message.author.id]),
          startTime: Date.now(),
          lobbyMsg: null,
          timer: null,
          updateIv: null,
        };
        warzoneLobbies.set(message.channel.id, lb);

        const mkRow = () => new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`warzone_join_${message.channel.id}`).setLabel('⚔️ Gabung!').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`warzone_start_${message.channel.id}`).setLabel('▶️ Mulai (Host)').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`warzone_cancel_${message.channel.id}`).setLabel('❌ Batal').setStyle(ButtonStyle.Danger),
        );

        const lbMsg = await message.channel.send({
          embeds: [wz_lobbyEmbed(lb)],
          components: [mkRow()],
        }).catch(() => null);
        if (lbMsg) lb.lobbyMsg = lbMsg;

        // Update teks lobby setiap 15 detik
        lb.updateIv = setInterval(async () => {
          const cur = warzoneLobbies.get(message.channel.id);
          if (!cur || !cur.lobbyMsg) { clearInterval(lb.updateIv); return; }
          cur.lobbyMsg.edit({ embeds: [wz_lobbyEmbed(cur)], components: [mkRow()] }).catch(() => {});
        }, 15000);

        // Auto-start setelah 90 detik
        lb.timer = setTimeout(async () => {
          clearInterval(lb.updateIv);
          const cur = warzoneLobbies.get(message.channel.id);
          if (!cur) return; // sudah distart/cancel via tombol
          warzoneLobbies.delete(message.channel.id);
          if (cur.lobbyMsg) cur.lobbyMsg.edit({ embeds: [wz_lobbyEmbed(cur)], content: '⏱️ _Waktu lobby habis!_', components: [] }).catch(() => {});
          if (cur.players.length < 2) {
            await message.channel.send('⏱️ Waktu lobby habis. Min 2 pemain diperlukan. Game dibatalkan.').catch(() => {});
            return;
          }
          await message.channel.send(`⚔️ Lobby ditutup! **${cur.players.length} pejuang** siap bertarung!`).catch(() => {});
          await new Promise(r => setTimeout(r, 1200));
          await wz_runGame(message.channel, cur.players).catch(e => console.error('[warzone] runGame error:', e));
        }, 90000);

        return;
      }

      // === !ip <address> — IP Geolocation ===
      if (/^!ip\s+\S+/i.test(rawText)) {
        const _ipTarget = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          const _ipResult = await lookupIP(_ipTarget);
          await sendEmbedReply(message, _ipResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ IP lookup gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === !dns <domain> — DNS Lookup ===
      if (/^!dns\s+\S+/i.test(rawText)) {
        const _dnsDomain = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          const _dnsResult = await lookupDNS(_dnsDomain);
          await sendEmbedReply(message, _dnsResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ DNS lookup gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === !github <username> — GitHub OSINT ===
      if (/^!github\s+\S+/i.test(rawText)) {
        const _ghUser = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          const _ghResult = await lookupGitHub(_ghUser);
          await sendEmbedReply(message, _ghResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ GitHub lookup gagal: ' + e.message).catch(() => {}); }
        return;
      }


      // === !phone <nomor> — Phone OSINT ===
      if (/^!phone\s+\S+/i.test(rawText)) {
        const _phoneNum = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          const _phoneResult = await lookupPhone(_phoneNum);
          await sendEmbedReply(message, _phoneResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Phone lookup gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === !geophoto — Ekstrak GPS dari EXIF foto ===
      if (/^!geophoto/i.test(rawText)) {
        const _geoAtts = [...message.attachments.values()].filter(a => {
          const ext = (a.name || '').split('.').pop().toLowerCase();
          return ['jpg','jpeg','png','heic','heif','tif','tiff','webp'].includes(ext) || a.contentType?.startsWith('image/');
        });
        if (_geoAtts.length === 0) {
          await message.reply('📸 Lampirkan foto (JPEG) bersama command **!geophoto**.\n> Contoh: ketik `!geophoto` lalu attach foto dari kamera.').catch(() => {});
          return;
        }
        await message.channel.sendTyping().catch(() => {});
        const _geoTyping = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
        try {
          const _geoResult = await analyzePhotoGPS(_geoAtts[0]);
          clearInterval(_geoTyping);
          await sendEmbedReply(message, _geoResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          clearInterval(_geoTyping);
          await message.reply('❌ Gagal baca GPS foto: ' + e.message).catch(() => {});
        }
        return;
      }

      // === !geo-photo <url> — EXIF GPS dari URL foto (ExifLooter style) ===
      if (/^!geo-photo\s+https?:\/\//i.test(rawText)) {
        const _gpUrl = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        const _gpTyp = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
        try {
          const _gpRes = await analyzePhotoFromURL(_gpUrl);
          clearInterval(_gpTyp);
          await sendEmbedReply(message, _gpRes, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { clearInterval(_gpTyp); await message.reply('❌ Gagal baca GPS dari URL: ' + e.message).catch(() => {}); }
        return;
      }

      // === !geoip <ip> — Koordinat GPS dari IP ===
      if (/^!geoip\s+\S+/i.test(rawText)) {
        const _gipIp = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          await sendEmbedReply(message, await lookupGeoIP(_gipIp), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ GeoIP gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === !maps <koordinat> — Semua link maps ===
      if (/^!maps\s+/i.test(rawText)) {
        const _mapsCoord = rawText.slice(rawText.indexOf(' ') + 1).trim();
        await message.channel.sendTyping().catch(() => {});
        try {
          await sendEmbedReply(message, await lookupMaps(_mapsCoord), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Maps gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === !timezone <lokasi> — Timezone dari nama kota/negara ===
      if (/^!timezone\s+/i.test(rawText)) {
        const _tzLok = rawText.slice(rawText.indexOf(' ') + 1).trim();
        await message.channel.sendTyping().catch(() => {});
        try {
          await sendEmbedReply(message, await lookupTimezone(_tzLok), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Timezone gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === scan <url|domain|ip> — OSINT safety check (tanpa mention) ===
      const _scanOsint = detectOsintScan(rawText);
      if (_scanOsint) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const _scanResult = await runOsintScan(_scanOsint.target, _scanOsint.type);
          await sendEmbedReply(message, _scanResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          await message.reply('❌ OSINT scan gagal: ' + e.message).catch(() => {});
        }
        return;
      }

      // === recon endpoints <url> — extract API endpoints dari web page ===
      if (/^recon\s+endpoints?\s+\S+/i.test(rawText)) {
        const _epUrl = rawText.split(/\s+/).slice(2).join(' ').trim();
        await message.channel.sendTyping().catch(() => {});
        try {
          const _epOut = await runEndpoints(_epUrl);
          await sendEmbedReply(message, _epOut, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ endpoint scan gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === recon <domain> — DNS, subdomains, whois (tanpa mention) ===
      if (/^recon\s+\S+/i.test(rawText)) {
        const _reconDomain = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          const _reconOut = await runRecon(_reconDomain);
          await sendEmbedReply(message, _reconOut, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ recon gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === ports <ip> — open ports + CVE (tanpa mention) ===
      if (/^ports\s+\d{1,3}(\.\d{1,3}){3}$/i.test(rawText)) {
        const _portsIp = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          await sendEmbedReply(message, await runPorts(_portsIp), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ ports gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === whois <domain> — domain info (tanpa mention) ===
      if (/^whois\s+\S+/i.test(rawText)) {
        const _whoisDomain = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          await sendEmbedReply(message, await runWhois(_whoisDomain), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ whois gagal: ' + e.message).catch(() => {}); }
        return;
      }

      // === leak <email> — breach check (tanpa mention) ===
      if (/^leak\s+\S+@\S+/i.test(rawText)) {
        const _leakEmail = rawText.split(/\s+/)[1];
        await message.channel.sendTyping().catch(() => {});
        try {
          const _leakOut = await runLeakCheck(_leakEmail);
          await sendEmbedReply(message, _leakOut, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ leak check gagal: ' + e.message).catch(() => {}); }
        return;
      }

                        if (!rawText.toLowerCase().startsWith('!shuffle')) return;
      } catch (_noMentionErr) {
        // Library error di blok non-mention — jangan balas pesan, cukup log.
        console.error('[bot] Non-mention handler error (silent):', _noMentionErr.message);
        return;
      }
    }

    if (isDM && message.author.id !== OWNER_ID) {
      await message.reply('⛔ Maaf, DM bot ini hanya bisa digunakan oleh owner.');
      return;
    }
    // === !iplog [label] -- Buat IP Logger link (owner DM only) ===
    if (isDM && message.author.id === OWNER_ID && /^!iplog/i.test(message.content)) {
      const _label = message.content.replace(/^!iplog\s*/i, '').trim() || ('link-' + Date.now());
      try {
        const _webPort = (parseInt(process.env.PORT) || 3001) - 1;
        const _resp = await fetch('http://127.0.0.1:' + _webPort + '/internal/iplog/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: _label }),
          signal: AbortSignal.timeout(5000),
        });
        const _data = await _resp.json();
        if (_data.url) {
          const msg = [
            '🎣 **IP Logger Link dibuat!**',
            '🏷️ Label : ' + _label,
            '🔗 Link  : ' + _data.url,
            '',
            '_Bagikan link ini ke target. Saat mereka klik, aku langsung DM kamu IP + lokasi mereka._',
          ].join('\n');
          await message.reply(msg).catch(() => {});
        } else {
          await message.reply('❌ Gagal buat link: ' + JSON.stringify(_data)).catch(() => {});
        }
      } catch (e) {
        await message.reply('❌ Error: ' + e.message).catch(() => {});
      }
      return;
    }



  // === !discordinfo <user_id> -- Info akun Discord dari ID ===
  if (isDM && message.author.id === OWNER_ID && /^!discordinfo\b/i.test(message.content)) {
    const _uid = message.content.replace(/^!discordinfo\s*/i, '').trim();
    if (!_uid || !/^\d{15,21}$/.test(_uid)) {
      await message.reply('❌ Format salah. Contoh: !discordinfo 298936604148490240').catch(() => {});
      return;
    }
    try {
      const _dr = await fetch('https://discord.com/api/v10/users/' + _uid, {
        headers: { Authorization: 'Bot ' + process.env.DISCORD_TOKEN },
        signal: AbortSignal.timeout(8000),
      });
      if (!_dr.ok) {
        await message.reply('❌ User tidak ditemukan (status ' + _dr.status + ')').catch(() => {});
        return;
      }
      const _du = await _dr.json();
      const _createdMs = Number(BigInt(_uid) >> 22n) + 1420070400000;
      const _created = new Date(_createdMs).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const _ageDays = Math.floor((Date.now() - _createdMs) / 86400000);
      const _ageYears = (_ageDays / 365).toFixed(1);
      const _flags = _du.public_flags || 0;
      const _badgeMap = [
        [1 << 0,  '👑 Discord Staff'],
        [1 << 1,  '🤝 Partnered Server Owner'],
        [1 << 2,  '🎪 HypeSquad Events'],
        [1 << 3,  '🐛 Bug Hunter Lv1'],
        [1 << 6,  '🏠 HypeSquad Bravery'],
        [1 << 7,  '🏠 HypeSquad Brilliance'],
        [1 << 8,  '🏠 HypeSquad Balance'],
        [1 << 9,  '💎 Early Supporter'],
        [1 << 14, '🐛 Bug Hunter Lv2'],
        [1 << 17, '👨‍💻 Early Verified Bot Dev'],
        [1 << 18, '📖 Discord Certified Mod'],
        [1 << 22, '🧑‍💻 Active Developer'],
      ];
      const _badges = _badgeMap.filter(([f]) => (_flags & f) === f).map(([,n]) => n);
      if (_du.bot) _badges.unshift('🤖 Bot');
      const _avatar = _du.avatar
        ? 'https://cdn.discordapp.com/avatars/' + _uid + '/' + _du.avatar + '.png'
        : '(tidak ada avatar)';
      const _banner = _du.banner
        ? 'https://cdn.discordapp.com/banners/' + _uid + '/' + _du.banner + '.png'
        : null;
      const _diFields = [
        { name: '👤 Username', value: (_du.global_name || _du.username) + ' (@' + _du.username + ')', inline: false },
        { name: '🆔 User ID', value: _uid, inline: true },
        { name: '📅 Dibuat', value: _created + ' WIB', inline: true },
        { name: '⏳ Umur Akun', value: _ageDays + ' hari (~' + _ageYears + ' tahun)', inline: true },
        { name: '🖼️ Avatar', value: _avatar, inline: false },
      ];
      if (_banner) _diFields.push({ name: '🎨 Banner', value: _banner, inline: false });
      _diFields.push({ name: '🏅 Badge', value: _badges.length ? _badges.join(', ') : 'Tidak ada', inline: false });
      const _diThumb = _du.avatar ? 'https://cdn.discordapp.com/avatars/' + _uid + '/' + _du.avatar + '.png' : null;
      const _diEmbed = new EmbedBuilder()
        .setColor(EMBED_COLORS.osint)
        .setTitle('🔍 Discord User Info')
        .addFields(_diFields);
      if (_diThumb) _diEmbed.setThumbnail(_diThumb);
      await message.reply({ embeds: [_diEmbed], components: [makeDeleteRow(message.author.id)] }).catch(() => {});
    } catch (e) {
      await message.reply('❌ Error: ' + e.message).catch(() => {});
    }
    return;
  }

  // === !dstatus -- Status Discord sekarang ===
  if (isDM && message.author.id === OWNER_ID && /^!dstatus$/i.test(message.content.trim())) {
    try {
      const [_sRes, _cRes] = await Promise.all([
        fetch('https://discordstatus.com/api/v2/status.json', { signal: AbortSignal.timeout(8000) }),
        fetch('https://discordstatus.com/api/v2/components.json', { signal: AbortSignal.timeout(8000) }),
      ]);
      const _st = await _sRes.json();
      const _co = await _cRes.json();
      const _indMap = { none: '✅', minor: '🟡', major: '🔴', critical: '🔴', maintenance: '🔧' };
      const _stMap = {
        operational: '✅ Normal',
        degraded_performance: '🟡 Lambat',
        partial_outage: '🟠 Sebagian Down',
        major_outage: '🔴 Down',
        under_maintenance: '🔧 Maintenance',
      };
      const _overall = _indMap[_st.status.indicator] || '❓';
      const _showcased = (_co.components || []).filter(c => c.showcase && !c.group);
      const _compText = _showcased.map(c => (_stMap[c.status] || c.status) + ' — ' + c.name).join('\n') || 'Tidak ada data';
      const _updated = new Date(_st.page.updated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
      const _dsColor = _st.status.indicator === 'none' ? 0x57F287
        : _st.status.indicator === 'minor' ? 0xF1C40F
        : _st.status.indicator === 'maintenance' ? 0x5865F2
        : 0xED4245;
      const _dsEmbed = new EmbedBuilder()
        .setColor(_dsColor)
        .setTitle('📡 Status Discord — ' + _overall + ' ' + _st.status.description)
        .addFields(
          { name: 'Komponen', value: _compText.slice(0, 1024), inline: false },
          { name: '⏰ Update terakhir', value: _updated + ' WIB', inline: false }
        );
      await message.reply({ embeds: [_dsEmbed], components: [makeDeleteRow(message.author.id)] }).catch(() => {});
    } catch (e) {
      await message.reply('❌ Error: ' + e.message).catch(() => {});
    }
    return;
  }

  // === !serverinfo <invite> -- Info server dari invite link ===
  if (isDM && message.author.id === OWNER_ID && /^!serverinfo\b/i.test(message.content)) {
    const _raw = message.content.replace(/^!serverinfo\s*/i, '').trim();
    const _code = _raw.replace(/.*discord(?:app)?\.gg\/(?:invite\/)?/i, '').replace(/[^a-zA-Z0-9-]/g, '');
    if (!_code) {
      await message.reply('❌ Format salah. Contoh: !serverinfo discord.gg/ABC123 atau !serverinfo ABC123').catch(() => {});
      return;
    }
    try {
      const _ir = await fetch('https://discord.com/api/v10/invites/' + _code + '?with_counts=true&with_expiration=true', {
        headers: { Authorization: 'Bot ' + process.env.DISCORD_TOKEN },
        signal: AbortSignal.timeout(8000),
      });
      if (!_ir.ok) {
        await message.reply('❌ Invite tidak valid atau sudah expired (status ' + _ir.status + ')').catch(() => {});
        return;
      }
      const _inv = await _ir.json();
      const _srv = _inv.guild || {};
      const _ch  = _inv.channel || {};
      const _inviter = _inv.inviter ? ('@' + _inv.inviter.username) : 'Tidak diketahui';
      const _icon = _srv.icon
        ? 'https://cdn.discordapp.com/icons/' + _srv.id + '/' + _srv.icon + '.png'
        : '(tidak ada icon)';
      const _srvCreated = _srv.id
        ? new Date(Number(BigInt(_srv.id) >> 22n) + 1420070400000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
        : '-';
      const _features = (_srv.features || []).map(f => f.replace(/_/g, ' ')).join(', ') || 'Tidak ada';
      const _siFields = [
        { name: '🆔 Server ID', value: _srv.id || '-', inline: true },
        { name: '📅 Dibuat', value: _srvCreated + ' WIB', inline: true },
        { name: '👥 Member', value: (_inv.approximate_member_count || '?') + ' (online: ' + (_inv.approximate_presence_count || '?') + ')', inline: true },
        { name: '📢 Channel', value: '#' + (_ch.name || '-'), inline: true },
        { name: '🔗 Invite', value: 'discord.gg/' + _code + ' (oleh ' + _inviter + ')', inline: true },
        { name: '✨ Fitur', value: _features.slice(0, 1024) || 'Tidak ada', inline: false },
      ];
      if (_srv.description) _siFields.unshift({ name: '📝 Deskripsi', value: _srv.description, inline: false });
      const _siEmbed = new EmbedBuilder()
        .setColor(EMBED_COLORS.default)
        .setTitle('🏰 ' + (_srv.name || 'Server Info'))
        .addFields(_siFields);
      if (_icon && _icon.startsWith('http')) _siEmbed.setThumbnail(_icon);
      await message.reply({ embeds: [_siEmbed], components: [makeDeleteRow(message.author.id)] }).catch(() => {});
    } catch (e) {
      await message.reply('❌ Error: ' + e.message).catch(() => {});
    }
    return;
  }

    // === DM owner: !setkey / !provider / !providerstatus ===
    if (isDM && message.author.id === OWNER_ID) {
      const _dmCmd = message.content.trim().toLowerCase();

      if (_dmCmd.startsWith('!setkey ')) {
        var _dskParts = message.content.trim().split(/\s+/);
        var _dskProvider = (_dskParts[1] || '').toLowerCase();
        if (!ALL_PROVIDERS.includes(_dskProvider)) {
          await message.reply('❌ Provider tidak dikenal. Pilihan: `' + ALL_PROVIDERS.join(', ') + '`').catch(function(){});
        } else {
          var _dskStatus = getAgentStatus();
          var _dskOrder = [..._dskStatus.order];
          if (!_dskOrder.includes(_dskProvider)) _dskOrder.push(_dskProvider);
          _dskOrder = [_dskProvider, ..._dskOrder.filter(function(p) { return p !== _dskProvider; })];
          setAgentOrder(_dskOrder);
          await store.saveKey('provider_order', _dskOrder).catch(function(e) { console.warn('[store] provider_order:', e.message); });
          var _dskKeys = _dskStatus.keyCount[_dskProvider] || 0;
          await message.reply(
            '✅ Provider utama diset ke **' + _dskProvider.toUpperCase() + '**\n' +
            '> Urutan baru: `' + _dskOrder.join(' → ') + '`\n' +
            (_dskKeys === 0 ? '⚠️ Tidak ada key untuk ' + _dskProvider + ' di env Railway — bot akan skip provider ini.' : '> ' + _dskKeys + ' key tersedia di env.')
          ).catch(function(){});
        }
        return;
      }

      if (_dmCmd === '!provider') {
        await message.reply(makeProviderPanel()).catch(function(){});
        return;
      }

      if (_dmCmd === '!providerstatus') {
        var _dpsStatus = getAgentStatus();
        var _dpsOrder = _dpsStatus.order;
        var _dpsKeys = _dpsStatus.keyCount;
        var _dpsLines = ALL_PROVIDERS.map(function(p) {
          var inOrder = _dpsOrder.includes(p);
          var m = PROVIDER_META[p];
          return (inOrder ? '🟢' : '🔴') + ' **' + m.label + '**: ' + (_dpsKeys[p] || 0) + ' key' + (inOrder ? ' (aktif, posisi #' + (_dpsOrder.indexOf(p) + 1) + ')' : ' (nonaktif)');
        });
        await message.reply('**Status Provider AI**\n' + _dpsLines.join('\n') + '\n\nUrutan: `' + (_dpsOrder.join(' \u2192 ') || 'kosong') + '`').catch(function(){});
        return;
      }
    }

    const isDMOwner = isDM && message.author.id === OWNER_ID;
    const historyKey = isDMOwner ? `dm-${message.author.id}` : `ch-${message.channelId}`;
    // Bootstrap history dari Discord saat pertama kali aktif setelah restart
    await bootstrapHistory(historyKey, message.channel, isDMOwner);

    const mentionRegex = new RegExp(`<@!?${client.user.id}>`, 'g');
    const question = message.content.replace(mentionRegex, '').trim();

    // === !translate code via mention — daftar kode bahasa translate (semua user) ===
    if (question.trim().toLowerCase() === '!translate code') {
      try {
        await sendTranslateCodePages(message);
      } catch (e) {
        await message.reply('❌ Gagal tampilkan daftar kode: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Translate: "translate", "translate <kode>" (reply), "translate <pesan>", "translate <kode> <pesan>" ===
    {
      const trQ = detectTranslateMentionQuery(question, !!message.reference);
      if (trQ) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const trResult = trQ.mode === 'text'
            ? await handleTranslateTextQuery(trQ.text, trQ.targetOverride)
            : await handleTranslateMentionReply(message, trQ.targetOverride);
          await sendEmbedReply(message, trResult.text, EMBED_COLORS.translate, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          await message.reply('❌ Gagal translate: ' + e.message).catch(() => {});
        }
        return;
      }
    }

    const maxFiles = isDMOwner ? MAX_FILES_DM : MAX_FILES_CH;
    const fileAttachments = [...message.attachments.values()]
      .filter((a) => TEXT_FILE_EXTENSIONS.includes(getExt(a.name)))
      .slice(0, maxFiles);

    if (!question && fileAttachments.length === 0) {
      await message.reply('Halo! Tag aku lalu tulis pertanyaanmu, lampirkan file untuk diperiksa/diperbaiki, kirim link GitHub untuk edit repo, atau minta aku buatkan gambar. 👋');
      return;
    }

    // === Perintah !delete [n] (hanya owner) ===
    if (message.author.id === OWNER_ID && /^!delete\s+\d+$/i.test(question)) {
      const n = Math.min(parseInt(question.split(/\s+/)[1], 10), 100);
      console.log(`[bot] !delete dipanggil oleh owner, n=${n}`);
      // Coba hapus pesan perintah owner
      message.delete().catch(() => {});
      // Fetch pesan recent, filter hanya pesan milik bot
      const fetched = await message.channel.messages.fetch({ limit: 100 });
      const mine = [...fetched.values()]
        .filter(m => m.author.id === client.user.id)
        .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
        .slice(0, n);
      console.log(`[bot] !delete: ditemukan ${mine.length} pesan milik bot`);
      for (const m of mine) {
        await m.delete().catch(e => console.warn(`[bot] gagal hapus ${m.id}: ${e.message}`));
        await new Promise(r => setTimeout(r, 500));
      }
      console.log(`[bot] !delete: selesai hapus ${mine.length} pesan`);
      return;
    }

    // === !command via mention — daftar command lengkap (semua user) ===
    if (question.trim().toLowerCase() === '!command') {
      try {

        const _cmdSentM = [];
        for (let _ci = 0; _ci < COMMAND_PAGES.length; _ci++) {
          const _isLast = _ci === COMMAND_PAGES.length - 1;
          const _pageEmbedM = new EmbedBuilder().setColor(0x5865F2).setDescription(COMMAND_PAGES[_ci]);
          const _pageOptsM = { embeds: [_pageEmbedM] };
          if (_isLast) _pageOptsM.components = [makeDeleteRow(message.author.id)];
          const _mM = _ci === 0
            ? await message.reply(_pageOptsM).catch(() => null)
            : await message.channel.send(_pageOptsM).catch(() => null);
          if (_mM) _cmdSentM.push(_mM);
        }
        if (_cmdSentM.length > 0) {
          const _cmdLastM = _cmdSentM[_cmdSentM.length - 1];
          _scanMsgMap.set(_cmdLastM.id, [..._cmdSentM]);
          setTimeout(() => _scanMsgMap.delete(_cmdLastM.id), 2 * 60 * 60 * 1000);
        }
      } catch (e) {
        await message.reply('❌ Gagal tampilkan command: ' + e.message).catch(() => {});
      }
      return;
    }
    // === Perintah !ClearHistory ===
    if (question.toLowerCase() === '!clearhistory') {
      const hadHistory = !!(allHistory[historyKey] && allHistory[historyKey].length > 0);
      clearHistory(historyKey);
      await message.reply(hadHistory
        ? '🗑️ Riwayat percakapan sesi ini sudah dihapus. Kita mulai dari awal!'
        : '✅ Tidak ada riwayat yang perlu dihapus untuk sesi ini.');
      return;
    }

    // === !reactor — panel status reactor (embed + tombol) ===
    if (message.author.id === OWNER_ID && question.trim().toLowerCase() === '!reactor') {
      const _rcPanel = await makeReactorPanel();
      const _rcMsg = await message.reply(_rcPanel).catch(() => null);
      if (_rcMsg) _scanMsgMap.set(_rcMsg.id, [_rcMsg]);
      return;
    }

        // === !ai — panel kontrol AI terpadu (embed + tombol ON/OFF) ===
    if (message.author.id === OWNER_ID && question.trim().toLowerCase().startsWith('!ai')) {
      const _aiQ   = question.trim().toLowerCase();
      const _isAll = _aiQ.includes('all');
      const _isSv  = !_isAll && (_aiQ.includes('server') || _aiQ.includes('sv'));
      const _guildId = message.guild ? message.guild.id : null;
      const _chId    = message.channel.id;
      const _aiKey   = _isAll ? null : _isSv ? ('sv:' + (_guildId || _chId)) : ('ch:' + _chId);
      // Aksi teks
      if (_aiQ.includes(' off')) {
        if (_isAll) aiGlobalOff = true; else if (_aiKey) aiDisabled.add(_aiKey);
        saveAiState(); console.log('[bot] AI off:', _isAll ? 'GLOBAL' : _aiKey);
      } else if (_aiQ.includes(' on')) {
        if (_isAll) { aiGlobalOff = false; } else if (_aiKey) aiDisabled.delete(_aiKey);
        saveAiState(); console.log('[bot] AI on:', _isAll ? 'GLOBAL' : _aiKey);
      }
      // Build embed panel
      const _dsvLines = [], _dchLines = [];
      for (const k of aiDisabled) {
        if (k.startsWith('sv:')) { const g = client.guilds.cache.get(k.slice(3)); _dsvLines.push('🔴 ' + (g ? g.name : k.slice(3))); }
        else if (k.startsWith('ch:')) { const ch = client.channels.cache.get(k.slice(3)); _dchLines.push('🔴 ' + (ch ? '#' + (ch.name || k.slice(3)) : '#' + k.slice(3)) + ((ch && ch.guild) ? ' (' + ch.guild.name + ')' : '')); }
      }
      const _allGuilds = client.guilds.cache.map(g => (aiGlobalOff || aiDisabled.has('sv:' + g.id) ? '🔴' : '🟢') + ' ' + g.name + ' (' + g.memberCount + ' members)');
      const _aiEmbed = new EmbedBuilder()
        .setColor(aiGlobalOff ? 0xED4245 : 0x57F287)
        .setTitle('🤖 Panel Kontrol AI')
        .setTimestamp()
        .addFields(
          { name: '🌐 Status Global', value: aiGlobalOff ? '🔴 MATI (Global)' : '🟢 HIDUP (Global)', inline: true },
          { name: '🏠 Server Ini', value: (_guildId && aiDisabled.has('sv:' + _guildId)) ? '🔴 MATI' : '🟢 HIDUP', inline: true },
          { name: '💬 Channel Ini', value: aiDisabled.has('ch:' + _chId) ? '🔴 MATI' : '🟢 HIDUP', inline: true },
        );
      if (_allGuilds.length) _aiEmbed.addFields({ name: '📋 Server Bot (' + _allGuilds.length + ')', value: _allGuilds.slice(0, 15).join('\n').slice(0, 1024) || '—', inline: false });
      if (_dsvLines.length) _aiEmbed.addFields({ name: '🚫 Server Nonaktif', value: _dsvLines.slice(0, 10).join('\n').slice(0, 1024), inline: false });
      if (_dchLines.length) _aiEmbed.addFields({ name: '🚫 Channel Nonaktif', value: _dchLines.slice(0, 10).join('\n').slice(0, 1024), inline: false });
      if (!aiGlobalOff && !_dsvLines.length && !_dchLines.length) _aiEmbed.addFields({ name: '✅ Status', value: 'AI aktif di semua server & channel.', inline: false });
      const _svDisabled = _guildId && aiDisabled.has('sv:' + _guildId);
      const _chDisabled = aiDisabled.has('ch:' + _chId);
      const _aiRow1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ai_global_off').setLabel('🔇 Global OFF').setStyle(ButtonStyle.Danger).setDisabled(aiGlobalOff),
        new ButtonBuilder().setCustomId('ai_global_on').setLabel('🔊 Global ON').setStyle(ButtonStyle.Success).setDisabled(!aiGlobalOff),
        new ButtonBuilder().setCustomId('ai_sv_toggle').setLabel(_svDisabled ? '🟢 Server ON' : '🔴 Server OFF').setStyle(_svDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('ai_ch_toggle').setLabel(_chDisabled ? '🟢 Channel ON' : '🔴 Channel OFF').setStyle(_chDisabled ? ButtonStyle.Success : ButtonStyle.Danger),
      );
      const _aiRow2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ai_del').setLabel('🗑️ Tutup').setStyle(ButtonStyle.Secondary),
      );
      const _aiMsg = await message.reply({ embeds: [_aiEmbed], components: [_aiRow1, _aiRow2] }).catch(() => null);
      if (_aiMsg) _scanMsgMap.set(_aiMsg.id, [_aiMsg]);
      return;
    }

        // === !balance via mention — hanya owner ===
    if (message.author.id === OWNER_ID && question.trim().toLowerCase() === '!balance') {
      await message.channel.sendTyping().catch(() => {});
      try {
        const _balM = await getBalance();
        const _balEmbed = new EmbedBuilder()
          .setColor(EMBED_COLORS.balance)
          .setTitle('💰 Saldo Wallet Bot (Base Mainnet)')
          .addFields(
            { name: 'Alamat', value: '`' + _balM.address + '`', inline: false },
            { name: 'ETH', value: _balM.eth + ' ETH', inline: true },
            { name: 'USDC', value: _balM.usdc + ' USDC', inline: true }
          )
          .setURL('https://basescan.org/address/' + _balM.address);
        await message.reply({ embeds: [_balEmbed], components: [makeDeleteRow(message.author.id)] });
      } catch (e) { await message.reply('❌ Gagal cek saldo: ' + e.message).catch(() => {}); }
      return;
    }


    // === Cek AI disabled untuk channel/server ini ===
    if (aiGlobalOff || aiDisabled.has('ch:' + message.channel.id) || aiDisabled.has('sv:' + (message.guild?.id || ''))) {
      console.log('[bot] AI off, skip ' + message.channel.id);
      return;
    }

    // === send via mention — hanya owner ===
    if (message.author.id === OWNER_ID) {
      const _sendOptsM = parseSendCommand(question);
      if (_sendOptsM) {
        await message.channel.sendTyping().catch(() => {});
        const _lblM = _sendOptsM.amount + ' ' + _sendOptsM.token.toUpperCase();
        const _wM = await message.reply('⏳ Mengirim **' + _lblM + '** ke `' + _sendOptsM.to + '`...\n_Tunggu konfirmasi blockchain Base..._').catch(() => null);
        try {
          const _rM = await sendToken(_sendOptsM);
          const _sendEmbedOkM = new EmbedBuilder()
            .setColor(EMBED_COLORS.send)
            .setTitle('✅ Transfer Berhasil')
            .addFields(
              { name: 'Token', value: _rM.token, inline: true },
              { name: 'Nominal', value: _rM.amount + ' ' + _rM.token, inline: true },
              { name: 'Dari', value: '`' + _rM.from + '`', inline: false },
              { name: 'Ke', value: '`' + _rM.to + '`', inline: false },
              { name: 'Block', value: '#' + _rM.blockNumber, inline: true },
              { name: 'Basescan', value: '[Lihat TX](' + _rM.txUrl + ')', inline: true }
            );
          const _sendOptsOkM = { embeds: [_sendEmbedOkM], components: [makeDeleteRow(message.author.id)] };
          if (_wM) await _wM.edit(_sendOptsOkM).catch(() => {}); else await message.reply(_sendOptsOkM).catch(() => {});
        } catch (e) {
          const _sendEmbedErrM = new EmbedBuilder().setColor(0xED4245).setTitle('❌ Gagal Kirim').setDescription(e.message);
          const _sendErrOptsM = { embeds: [_sendEmbedErrM], components: [makeDeleteRow(message.author.id)] };
          if (_wM) await _wM.edit(_sendErrOptsM).catch(() => {}); else await message.reply(_sendErrOptsM).catch(() => {});
        }
        return;
      }
    }

    // === multisend via mention — hanya owner ===
    if (message.author.id === OWNER_ID) {
      const _msOptsM = parseMultisendCommand(question);
      if (_msOptsM) {
        await message.channel.sendTyping().catch(() => {});
        const _msLblM = _msOptsM.amount + ' ' + (/^0x[a-fA-F0-9]{40}$/i.test(_msOptsM.token) ? _msOptsM.token.slice(0,6)+'...'+_msOptsM.token.slice(-4) : _msOptsM.token.toUpperCase()) + ' × ' + _msOptsM.recipients.length + ' wallet';
        const _msWM = await message.reply('⏳ Multisend **' + _msLblM + '**...\n_Eksekusi kontrak Base Mainnet..._').catch(() => null);
        try {
          const _msRM = await executeMultisend(_msOptsM);
          const _msEmbedOkM = new EmbedBuilder()
            .setColor(EMBED_COLORS.send)
            .setTitle('✅ Multisend Berhasil')
            .addFields(
              { name: 'Token', value: _msRM.token, inline: true },
              { name: 'Per Wallet', value: _msRM.amountPerWallet + ' ' + _msRM.token, inline: true },
              { name: 'Total Kirim', value: _msRM.totalAmount + ' ' + _msRM.token, inline: true },
              { name: 'Jumlah Wallet', value: String(_msRM.recipients.length), inline: true },
              { name: 'Dari', value: '`' + _msRM.from + '`', inline: false },
              { name: 'Block', value: '#' + _msRM.blockNumber, inline: true },
              { name: 'Basescan', value: '[Lihat TX](' + _msRM.txUrl + ')', inline: true }
            );
          const _msOptsOkM = { embeds: [_msEmbedOkM], components: [makeDeleteRow(message.author.id)] };
          if (_msWM) await _msWM.edit(_msOptsOkM).catch(() => {}); else await message.reply(_msOptsOkM).catch(() => {});
        } catch (e) {
          const _msEmbedErrM = new EmbedBuilder().setColor(0xED4245).setTitle('❌ Gagal Multisend').setDescription(e.message);
          const _msErrOptsM = { embeds: [_msEmbedErrM], components: [makeDeleteRow(message.author.id)] };
          if (_msWM) await _msWM.edit(_msErrOptsM).catch(() => {}); else await message.reply(_msErrOptsM).catch(() => {});
        }
        return;
      }
    }


        // === Perintah !shuffle role @Role [jumlah] ===
    if (question.trim().toLowerCase().startsWith('!shuffle')) {
      const isAdmin = message.member?.permissions?.has('ManageRoles')
        || message.author.id === OWNER_ID;
      if (!isAdmin) {
        await message.reply('❌ Hanya admin/owner yang bisa pakai `!shuffle`.');
        return;
      }

      const parts = question.trim().split(/\s+/);

      // !shuffle info — cek wallet bot
      if (parts[1] === 'info') {
        if (!isShuffleConfigured()) {
          await message.reply('⚙️ Set `BOT_PRIVATE_KEY` dan `SHUFFLE_CONTRACT` di Railway env dulu.');
          return;
        }
        try {
          const info = await getWalletInfo();
          await message.reply(
            `🤖 **Wallet Bot (Base)**\n` +
            `• \`${info.address}\`\n` +
            `• Balance: ${info.balanceEth} ETH\n` +
            `• [Lihat di Basescan](${info.explorerUrl})`
          );
        } catch (e) {
          await message.reply(`❌ Error: ${e.message}`);
        }
        return;
      }

      // !shuffle help atau salah syntax
      if (parts[1] !== 'role') {
        await message.reply(
          '📖 **Cara pakai !shuffle:**\n' +
          '`!shuffle role @NamaRole` — undian 1 pemenang\n' +
          '`!shuffle role @NamaRole 3` — undian 3 pemenang\n' +
          '`!shuffle info` — cek wallet & saldo bot'
        );
        return;
      }

      // !shuffle role @Role [count]
      const roleMention = message.mentions.roles.first();
      if (!roleMention) {
        await message.reply('❌ Mention role dulu. Contoh: `!shuffle role @Member`');
        return;
      }
      const numWinners = Math.min(parseInt(parts[3]) || 1, 10);

      if (!isShuffleConfigured()) {
        await message.reply(
          '⚙️ Set `BOT_PRIVATE_KEY` dan `SHUFFLE_CONTRACT` di Railway env dulu.\n' +
          'Contract yang dipakai: `0xfABe5E941887b490eF6FaC127FD16553656f25aE` (Base)'
        );
        return;
      }

      const statusMsg = await message.reply(`⏳ Mengambil daftar member role **${roleMention.name}**...`);
      // Fetch member — retry otomatis jika kena rate limit opcode 8
      const doMemberFetch = () => Promise.race([
        message.guild.members.fetch({ withPresences: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 25000)),
      ]);
      try {
        await doMemberFetch();
      } catch (e) {
        if (e.message === 'timeout') {
          console.warn('[shuffle] guild.members.fetch timeout — pastikan Server Members Intent aktif di Discord Dev Portal');
        } else {
          const retryMatch = e.message && e.message.match(/Retry after ([d.]+) seconds/i);
          if (retryMatch) {
            const waitSec = Math.ceil(parseFloat(retryMatch[1])) + 1;
            console.warn('[shuffle] guild.members.fetch rate limited, retry in', waitSec, 's');
            await statusMsg.edit(`⏳ Discord rate limit — otomatis retry dalam **${waitSec} detik**...`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            try {
              await doMemberFetch();
            } catch (e2) {
              console.warn('[shuffle] guild.members.fetch retry error:', e2.message);
            }
          } else {
            console.warn('[shuffle] guild.members.fetch error:', e.message);
          }
        }
      }

      const members = message.guild.members.cache.filter(m =>
        m.roles.cache.has(roleMention.id) && !m.user.bot
      );

      if (members.size === 0) {
        await statusMsg.edit(`❌ Tidak ada member non-bot dengan role **${roleMention.name}**.`);
        return;
      }

      // Kumpulkan peserta — urutan dikirim ke contract v2 as-is
      // Randomness sepenuhnya dari entropy on-chain (blockhash + timestamp + caller)
      // Kumpulkan peserta — username string dikirim ke contract, memberMap untuk lookup Discord ID
      const memberMap = new Map(); // username string → GuildMember
      let participants = [...members.values()].map(m => {
        const name = m.user.username + (m.user.discriminator && m.user.discriminator !== '0' ? '#' + m.user.discriminator : '');
        memberMap.set(name, m);
        return name;
      });
      await statusMsg.edit(
        `⛓️ Memanggil smart contract di Base...\n` +
        `📋 **${members.size}** peserta | 🏆 **${numWinners}** pemenang`
      );

      try {
        const winners = [];
        const picked  = new Set();

        const BAR_ON  = '▰';
        const BAR_OFF = '▱';
        const SPIN    = ['🎲', '🎯', '🎰', '🏆', '✨', '🎊'];

        for (let i = 0; i < numWinners; i++) {
          const available = participants.filter((_, idx) => !picked.has(idx));
          if (!available.length) break;

          const posLabel = ['Pertama 🥇', 'Kedua 🥈', 'Ketiga 🥉'][i] || ('ke-' + (i + 1) + ' 🏅');

          // Animasi drum roll selama menunggu transaksi on-chain
          // - try/finally memastikan clearInterval selalu dipanggil walau TX gagal
          // - isEditing guard mencegah edit overlap jika Discord lambat merespons
          let barLen = 0;
          let spinIdx = 0;
          let isEditing = false;
          const animTimer = setInterval(async () => {
            if (isEditing) return;
            isEditing = true;
            barLen = (barLen + 1) % 11;
            spinIdx = (spinIdx + 1) % SPIN.length;
            const bar = BAR_ON.repeat(barLen) + BAR_OFF.repeat(10 - barLen);
            await statusMsg.edit(
              SPIN[spinIdx] + ' **Memilih Pemenang ' + posLabel + '...**\n' +
              '`[' + bar + ']`\n' +
              '*Menunggu konfirmasi on-chain...*'
            ).catch(e => { if (e.status !== 429) console.warn('[shuffle] anim edit err:', e.message); });
            isEditing = false;
          }, 1200);

          let result;
          try {
            result = await pickWinnerOnChain(available, message.guild.id, roleMention.name);
          } finally {
            clearInterval(animTimer);
          }

          const winnerMember = memberMap.get(result.winner);
          winners.push({ ...result, position: i + 1, memberId: winnerMember?.id });

          // Reveal pemenang sementara sebelum embed final
          const revealTag = winnerMember ? '<@' + winnerMember.id + '>' : '**' + result.winner + '**';
          await statusMsg.edit(
            '🎉 **Pemenang ' + posLabel + ':** ' + revealTag + '\n' +
            (i + 1 < numWinners ? '⏳ Memilih pemenang berikutnya...' : '✅ Semua pemenang telah dipilih!')
          );
          if (i + 1 < numWinners) await new Promise(r => setTimeout(r, 1500));

          const origIdx = participants.indexOf(result.winner);
          if (origIdx !== -1) picked.add(origIdx);
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines  = winners.map(w =>
          `${medals[w.position - 1] || '🏅'} ${w.memberId ? '<@' + w.memberId + '>' : '**' + w.winner + '**'} — [Verifikasi TX #${w.raffleId}](${w.txUrl})`
        );

        const embed = {
          color: 0xf5a623,
          title: `🎉 Hasil Undian On-Chain — ${roleMention.name}`,
          description: lines.join('\n'),
          fields: [
            { name: '👥 Total Peserta', value: `${members.size}`, inline: true },
            { name: '🏆 Pemenang',      value: `${winners.length}`, inline: true },
            { name: '⛓️ Network',       value: 'Base Mainnet', inline: true },
            {
              name: '🔍 Smart Contract',
              value: `[\`0xfABe...25aE\`](https://basescan.org/address/0xfABe5E941887b490eF6FaC127FD16553656f25aE)`,
              inline: false,
            },
            {
              name: '📋 Semua Peserta & Pemenang',
              value: `Tersimpan permanen on-chain — nama pemenang & daftar peserta bisa dibaca di: ${winners.map(w => `[TX #${w.raffleId}](${w.txUrl})`).join(' · ')}`,
              inline: false,
            },
          ],
          footer: {
            text: `Block #${winners.at(-1).blockNumber} • Dipilih secara transparan di blockchain Base`,
          },
          timestamp: new Date().toISOString(),
        };

        console.log(`[shuffle] ✅ Raffle selesai: role=${roleMention.name} peserta=${members.size} pemenang=${winners.length}`);
        const mentionStr = winners.map(w => w.memberId ? '<@' + w.memberId + '>' : '**' + w.winner + '**').join(' ');
        await statusMsg.edit({ content: `🎉 Selamat ${mentionStr}!`, embeds: [embed] });
      } catch (err) {
        console.error('[shuffle] Error:', err.message);
        await statusMsg.edit(
          `❌ **Gagal memanggil smart contract:**\n\`${err.message}\`\n\n` +
          `• Cek saldo ETH: \`!shuffle info\`\n` +
          `• Pastikan \`BOT_PRIVATE_KEY\` & \`SHUFFLE_CONTRACT\` sudah diset di Railway`
        );
      }
      return;
    }

    // === Deteksi konversi crypto (misal: "5k usdc to idr") ===
    var cryptoConv = await detectCryptoConversion(question);
    if (cryptoConv) {
      if (cryptoConv.notFound) {
        await message.reply({ embeds: [new EmbedBuilder().setColor(0xED4245).setTitle('❌ Token tidak ditemukan').setDescription('Token **' + cryptoConv.from.toUpperCase() + '** tidak ditemukan di CoinGecko. Coba cek simbol tokennya.')] });
        return;
      }
      await message.channel.sendTyping().catch(() => {});
      try {
        var convResult = await fetchCryptoConversion(cryptoConv);
        await sendEmbedReply(message, convResult, priceEmbedColor(convResult), null, [makeDeleteRow(message.author.id)]);
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi price query (misal: "price btc" atau "p eth") ===
    var priceQ = detectPriceQuery(question);
    if (priceQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var priceResultObj = await fetchCoinPrice(priceQ);
        var priceResult = priceResultObj.text;
        await sendEmbedReply(message, priceResult, priceEmbedColor(priceResult), null, [makeDeleteRow(message.author.id)], priceResultObj.thumbnail);
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Deteksi jumlah koin (misal: "1 btc", "0.12 btc", "1k btc") -> nilai USD & IDR ===
    var amountQ = await detectAmountQuery(question);
    if (amountQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var amountResultObj = await fetchAmountPrice(amountQ);
        var amountResult = amountResultObj.text;
        await sendEmbedReply(message, amountResult, priceEmbedColor(amountResult), null, [makeDeleteRow(message.author.id)], amountResultObj.thumbnail);
      } catch (e) {
        await message.reply('Gagal ambil harga: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Zerion portfolio: "balance 0xABC" dengan mention ===
    var balAddr2 = detectBalanceQuery(question);
    if (balAddr2) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var balResult2 = await fetchZerionPortfolio(balAddr2);
        await sendEmbedReply(message, balResult2, EMBED_COLORS.balance, null, [makeDeleteRow(message.author.id)]);
      } catch (e) {
        await message.reply('❌ Gagal ambil data Zerion: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Zerion: txs dengan mention ===
      const txsAddr2 = detectTxsQuery(question);
      if (txsAddr2) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const result = await fetchZerionTransactions(txsAddr2);
          await sendEmbedReply(message, result, EMBED_COLORS.zerion_txs, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Gagal ambil transaksi Zerion: ' + e.message).catch(() => {}); }
        return;
      }

      // === Zerion: positions dengan mention ===
      const posAddr2 = detectPositionsQuery(question);
      if (posAddr2) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const result = await fetchZerionPositions(posAddr2);
          await sendEmbedReply(message, result, EMBED_COLORS.zerion_pos, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Gagal ambil posisi Zerion: ' + e.message).catch(() => {}); }
        return;
      }

      // === Zerion: nft dengan mention ===
      const nftAddr2 = detectNFTQuery(question);
      if (nftAddr2) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const result = await fetchZerionNFTs(nftAddr2);
          await sendEmbedReply(message, result, EMBED_COLORS.zerion_nft, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Gagal ambil NFT Zerion: ' + e.message).catch(() => {}); }
        return;
      }

      // === Zerion: gas dengan mention ===
      if (detectGasQuery(question)) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const result = await fetchZerionGas();
          await sendEmbedReply(message, result, EMBED_COLORS.zerion_gas, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Gagal ambil gas price: ' + e.message).catch(() => {}); }
        return;
      }

      // === Zerion: ztoken dengan mention ===
      const ztokenQ2 = detectZTokenQuery(question);
      if (ztokenQ2) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const result = await fetchZerionToken(ztokenQ2);
          await sendEmbedReply(message, result, EMBED_COLORS.zerion_token, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Gagal ambil info token: ' + e.message).catch(() => {}); }
        return;
      }

      // === Zerion: pnl dengan mention ===
      const pnlAddr2 = detectPnLQuery(question);
      if (pnlAddr2) {
        await message.channel.sendTyping().catch(() => {});
        try {
          const result = await fetchZerionPnL(pnlAddr2);
          await sendEmbedReply(message, result, EMBED_COLORS.zerion_pnl, null, [makeDeleteRow(message.author.id)]);
        } catch (e) { await message.reply('❌ Gagal ambil PnL Zerion: ' + e.message).catch(() => {}); }
        return;
      }

      // === Twitter login: "twit login" di DM untuk dapatkan token memory.lol ===
    if (isDMOwner && question.toLowerCase() === 'twit login') {
      try {
        const codeResp = await axios.post(
          'https://github.com/login/device/code',
          'client_id=b8ab5a8c1a2745d514b7',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { device_code, user_code, verification_uri, expires_in, interval } = codeResp.data;
        await message.reply(
          '\uD83D\uDD12 **Login ke memory.lol untuk akses full history**\n\n'
          + '1. Buka: **' + verification_uri + '**\n'
          + '2. Masukkan kode: **' + user_code + '**\n'
          + '3. Klik Authorize\n'
          + '4. Balik ke sini dan ketik **twit token** (bot akan cek otomatis)\n\n'
          + '_(Kode berlaku ' + Math.round(expires_in / 60) + ' menit)_'
        );
        // Simpan device_code sementara di memory untuk polling
        if (!global._twitDeviceFlow) global._twitDeviceFlow = {};
        global._twitDeviceFlow[message.author.id] = { device_code, interval: interval || 5, expires: Date.now() + expires_in * 1000 };
        // [FIX] Auto-cleanup setelah masa berlaku habis agar tidak memory leak
        setTimeout(() => {
          if (global._twitDeviceFlow) delete global._twitDeviceFlow[message.author.id];
        }, (expires_in + 10) * 1000);
      } catch (e) {
        await message.reply('\u274C Gagal mulai login: ' + e.message);
      }
      return;
    }

    // === Twitter token poll: "twit token" setelah authorize ===
    if (isDMOwner && question.toLowerCase() === 'twit token') {
      const flow = global._twitDeviceFlow && global._twitDeviceFlow[message.author.id];
      if (!flow) {
        await message.reply('\u274C Tidak ada sesi login aktif. Ketik **twit login** terlebih dahulu.');
        return;
      }
      if (Date.now() > flow.expires) {
        await message.reply('\u23F0 Kode sudah kedaluwarsa. Ketik **twit login** untuk mulai ulang.');
        return;
      }
      try {
        const tokenResp = await axios.post(
          'https://github.com/login/oauth/access_token',
          'device_code=' + flow.device_code + '&client_id=b8ab5a8c1a2745d514b7&grant_type=urn:ietf:params:oauth:grant-type:device_code',
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, timeout: 10000 }
        );
        const { access_token, error } = tokenResp.data;
        if (error === 'authorization_pending') {
          await message.reply('\u23F3 Belum diauthorize. Selesaikan langkah di browser dulu, lalu ketik **twit token** lagi.');
          return;
        }
        if (!access_token) {
          await message.reply('\u274C Gagal ambil token: ' + (error || 'unknown error'));
          return;
        }
        // Coba autentikasi ke memory.lol
        const mlResp = await axios.post(
          'https://api.memory.lol/v1/login/status',
          'token=' + encodeURIComponent(access_token),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 10000 }
        ).catch(() => null);
        delete global._twitDeviceFlow[message.author.id];
        await message.reply(
          '\u2705 Token berhasil didapat!\n\n'
          + 'Set environment variable berikut di Railway/Fly.io/host kamu:\n'
          + '```\nMEMORYLOL_TOKEN=' + access_token + '\n```\n'
          + '\u26A0\uFE0F Jika akunmu **belum diapprove** oleh pemilik memory.lol, akses tetap terbatas 60 hari.\n'
          + 'Hubungi [@travisbrown](https://twitter.com/travisbrown) untuk minta full access.'
        );
      } catch (e) {
        await message.reply('\u274C Error: ' + e.message);
      }
      return;
    }

        // === CryptoRank dengan mention: "@bot cr BTC" | "@bot gainers" ===
    var crQ = detectCrQuery(question);
    if (crQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var crResult = await handleCrCommand(crQ.type, crQ.symbol);
        const _crColor = crQ.type === 'gainers' ? EMBED_COLORS.gainers
          : crQ.type === 'losers' ? EMBED_COLORS.losers
          : crQ.type === 'market' ? EMBED_COLORS.market : EMBED_COLORS.cr;
        await sendEmbedReply(message, crResult, _crColor, null, [makeDeleteRow(message.author.id)]);
      } catch (e) {
        await message.reply('Gagal ambil data CryptoRank: ' + e.message).catch(() => {});
      }
      return;
    }

        // === Twitter history dengan mention: "@bot twit monad" ===
    var twitQ = detectTwitterQuery(question);
    if (twitQ) {
      await message.channel.sendTyping().catch(() => {});
      try {
        var twitMsgs = await fetchTwitterHistory(twitQ.usernames);
        await sendEmbedReply(message, twitMsgs.join('\n'), EMBED_COLORS.twitter, null, [makeDeleteRow(message.author.id)]);
      } catch (e) {
        await message.reply('Gagal ambil data Twitter: ' + e.message).catch(() => {});
      }
      return;
    }

        // === scan <url|domain|ip> dengan mention: "@bot scan https://..." ===
    const _mentionScan = detectOsintScan(question);
    if (_mentionScan) {
      await message.channel.sendTyping().catch(() => {});
      try {
        const _mScanResult = await runOsintScan(_mentionScan.target, _mentionScan.type);
        await sendEmbedReply(message, _mScanResult, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
      } catch (e) {
        await message.reply('❌ OSINT scan gagal: ' + e.message).catch(() => {});
      }
      return;
    }

        // === recon endpoints <url> dengan mention ===
    if (/^recon\s+endpoints?\s+\S+/i.test(question)) {
      const _mEpUrl = question.split(/\s+/).slice(2).join(' ').trim();
      await message.channel.sendTyping().catch(() => {});
      try {
        const _mEpOut = await runEndpoints(_mEpUrl);
        await sendEmbedReply(message, _mEpOut, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
      } catch (e) { await message.reply('❌ endpoint scan gagal: ' + e.message).catch(() => {}); }
      return;
    }

        // === recon <domain> dengan mention ===
    if (/^recon\s+\S+/i.test(question)) {
      const _mReconDomain = question.split(/\s+/)[1];
      await message.channel.sendTyping().catch(() => {});
      try {
        const _mReconOut = await runRecon(_mReconDomain);
        await sendEmbedReply(message, _mReconOut, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
      } catch (e) { await message.reply('❌ recon gagal: ' + e.message).catch(() => {}); }
      return;
    }

        // === ports <ip> dengan mention ===
    if (/^ports\s+\d{1,3}(\.\d{1,3}){3}$/i.test(question)) {
      const _mPortsIp = question.split(/\s+/)[1];
      await message.channel.sendTyping().catch(() => {});
      try {
        await sendEmbedReply(message, await runPorts(_mPortsIp), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
      } catch (e) { await message.reply('❌ ports gagal: ' + e.message).catch(() => {}); }
      return;
    }

        // === whois <domain> dengan mention ===
    if (/^whois\s+\S+/i.test(question)) {
      const _mWhoisDomain = question.split(/\s+/)[1];
      await message.channel.sendTyping().catch(() => {});
      try {
        await sendEmbedReply(message, await runWhois(_mWhoisDomain), EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
      } catch (e) { await message.reply('❌ whois gagal: ' + e.message).catch(() => {}); }
      return;
    }

        // === leak <email> dengan mention ===
    if (/^leak\s+\S+@\S+/i.test(question)) {
      const _mLeakEmail = question.split(/\s+/)[1];
      await message.channel.sendTyping().catch(() => {});
      try {
        const _mLeakOut = await runLeakCheck(_mLeakEmail);
        await sendEmbedReply(message, _mLeakOut, EMBED_COLORS.osint, null, [makeDeleteRow(message.author.id)]);
      } catch (e) { await message.reply('❌ leak check gagal: ' + e.message).catch(() => {}); }
      return;
    }

        // === Chart command dengan mention: @bot C BTC / @bot C ETH 4h / @bot C ETH 4h 30 ===
    const chartM = question.match(/^c\s+([a-zA-Z]+)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartM) {
      await message.channel.sendTyping().catch(() => {});
      try {
        await handleChartCommand(message, chartM[1], chartM[2] || '4h', chartM[3]);
      } catch (e) {
        await message.reply('Gagal buat chart: ' + e.message).catch(() => {});
      }
      return;
    }

    // === LP Analysis via mention: @bot lp <CA> [modal] [range%] ===
    const _lpQueryM = detectLpQuery(question);
    if (_lpQueryM) {
      await message.channel.sendTyping().catch(() => {});
      const _lpTypingM = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
      try {
        const _lpResultM = await handleLpCommand(_lpQueryM);
        clearInterval(_lpTypingM);
        await sendEmbedReply(message, _lpResultM, EMBED_COLORS.lp, null, [makeDeleteRow(message.author.id)]);
      } catch (e) {
        clearInterval(_lpTypingM);
        await message.reply('❌ Gagal analisa LP: ' + e.message).catch(() => {});
      }
      return;
    }

    // === Mode edit file GitHub langsung ===
    const ghRef = parseGitHubFileRef(question);
    if (ghRef) {
      await message.channel.sendTyping().catch(() => {});
      const history = getHistoryForAI(historyKey, isDMOwner);
      if (message.author.id === OWNER_ID) {
        // Owner: commit langsung ke repo
        await handleGitHubEdit(message, ghRef, question, history, isDMOwner);
      } else {
        // User lain: ambil file, AI edit, kirim ke Discord saja — tidak commit
        await handleGitHubReadOnly(message, ghRef, question, history, isDMOwner);
      }
      return;
    }

    // [FIX #10b] Cek per-user cooldown sebelum trigger AI (hemat quota saat spam)
    const _cdSecs = _checkUserCooldown(message.author.id, isDMOwner);
    if (_cdSecs > 0) {
      await message.reply(`⏳ Tunggu **${_cdSecs} detik** sebelum kirim pertanyaan berikutnya.`).catch(() => {});
      return;
    }

    await message.channel.sendTyping().catch(() => {});

    // === Mode gambar (hanya kalau tidak ada file dilampirkan) ===
    if (fileAttachments.length === 0 && isImageRequest(question)) {
      const { imageBuffer, text } = await generateImage(question);
      if (imageBuffer) {
        await message.reply({
          content: (text || `Nih hasil gambarnya: "${question}"`).slice(0, 2000),
          files: [makeFile(imageBuffer, 'hasil.png')],
        });
        return;
      }
      // Kalau generate gambar gagal, jatuh ke mode teks biasa.
    }

    // ============================================================
    // Multi-turn: user bilang "perbaiki" tanpa lampirkan ulang file
    // → cek apakah ada file terakhir yang diingat bot untuk channel ini
    // ============================================================
    if (fileAttachments.length === 0 && _isEditInstruction(question)) {
      const _cached = _lastProcessedFile.get(message.channel.id);
      if (_cached && Date.now() - _cached.timestamp < _LAST_FILE_TTL) {
        await message.reply(
          `📂 Menggunakan file terakhir: **${_cached.att.name}** (${Math.round(_cached.content.length / 1024)}KB)...`
        ).catch(() => {});
        const _cachedHistory = getHistoryForAI(historyKey, isDMOwner);
        await processSingleFile(message, _cached.att, _cached.content, question, _cachedHistory, isDMOwner);
        return;
      }
    }

    // ============================================================
    // [FIX] Cek total ukuran file sebelum gabung ke satu prompt.
    // Kalau terlalu besar, proses satu per satu agar AI tidak truncate.
    // ============================================================
    if (fileAttachments.length > 0) {
      const totalSize = fileAttachments.reduce((sum, a) => sum + a.size, 0);

      // Download semua file dulu
      const loadedFiles = [];
      for (const att of fileAttachments) {
        try {
          const content = await downloadAttachmentText(att, isDMOwner);
          loadedFiles.push({ att, content });
        } catch (e) {
          await message.reply(`⚠️ Gagal membaca **${att.name}**: ${e.message}`).catch(() => {});
        }
      }

      if (loadedFiles.length === 0) return;

      // Simpan file pertama ke cache multi-turn (dipakai kalau user minta "perbaiki" tanpa re-attach)
      if (loadedFiles.length === 1) {
        _lastProcessedFile.set(message.channel.id, { att: loadedFiles[0].att, content: loadedFiles[0].content, timestamp: Date.now() });
        setTimeout(() => _lastProcessedFile.delete(message.channel.id), _LAST_FILE_TTL);
      }

      const history = getHistoryForAI(historyKey, isDMOwner);

      // Jika total file > 30KB ATAU ada lebih dari 1 file yang masing-masing > 15KB,
      // proses satu per satu untuk hindari context overflow
      // Owner tidak ada batas — proses gabung selalu
      const shouldSplitProcess = (totalSize > MAX_TOTAL_BYTES_COMBINED
        || (loadedFiles.length > 1 && loadedFiles.some((f) => f.att.size > 30 * 1024)));

      if (shouldSplitProcess) {
        // Mode split: proses tiap file terpisah
        await message.reply(
          `📂 File terlalu besar untuk diproses sekaligus (total ${Math.round(totalSize / 1024)}KB). Memproses **${loadedFiles.length} file satu per satu**...`
        ).catch(() => {});

        for (const { att, content } of loadedFiles) {
          await message.channel.sendTyping().catch(() => {});
          try {
            await processSingleFile(message, att, content, question, history, isDMOwner);
            // Simpan file terakhir agar multi-turn "perbaiki" bisa bekerja tanpa re-attach
            _lastProcessedFile.set(message.channel.id, { att, content, timestamp: Date.now() });
            setTimeout(() => _lastProcessedFile.delete(message.channel.id), _LAST_FILE_TTL);
          } catch (e) {
            console.error('[split-loop] processSingleFile error untuk', att.name, ':', e.message);
            await message.reply(
              '⚠️ Gagal memproses **' + att.name + '**: ' + e.message
            ).catch(() => {});
          }
        }

        // Simpan history — hanya nama file, bukan isi
        const fileNames = loadedFiles.map((f) => f.att.name).join(', ');
        await pushHistory(historyKey, `${question || 'cek file'} [File: ${fileNames}]`, '[File diproses satu per satu]', isDMOwner);
        return;
      }

      // Proses gabung (file kecil atau channel)
      const fileParts = [];
      const fileNames = [];
      const originalFileNames = [];

      for (const { att, content } of loadedFiles) {
        fileParts.push(`// === File: ${att.name} ===\n${content}`);
        fileNames.push(att.name);
        originalFileNames.push(att.name);
      }

      const instruction = question
        || 'Periksa semua file yang dilampirkan, identifikasi semua error/masalahnya, lalu perbaiki.';

      // [FIX BARU] Path "gabung" ini SEBELUMNYA selalu minta AI menulis ulang SELURUH isi
      // tiap file dalam satu balasan — kena limit maxOutputTokens (lib/ai.js) persis seperti
      // path processSingleFile/handleGitHubEdit, dan menghasilkan file_1.js/file_2.json generik
      // yang terpotong. Sekarang pakai SEARCH/REPLACE multi-file jika total ukuran melebihi
      // batas aman menulis ulang penuh.
      const useTargetedEdit = totalSize > fullRewriteSafeBytes(isDMOwner);

      const finalQuestion = useTargetedEdit
        ? buildMultiFileTargetedEditPrompt(instruction, loadedFiles)
        : `${instruction}\n\n${fileParts.join('\n\n')}\n\nBerikan versi LENGKAP tiap file yang sudah diperbaiki dalam code block terpisah untuk tiap file — jangan dipotong.`;
      const historyUserContent = `${instruction} [File: ${fileNames.join(', ')}]`;

      const { text, sources } = await askGemini(finalQuestion, history, isDMOwner);

      // [FIX] Deteksi hallusinasi sebelum proses respons
      if (containsHallucination(text)) {
        await message.reply(
          '⚠️ AI tidak dapat memproses file sebesar ini sekaligus. Coba kirim **satu file** saja agar hasilnya akurat.'
        );
        return;
      }

      await pushHistory(historyKey, historyUserContent, text, isDMOwner);

      if (useTargetedEdit) {
        const perFilePatches = parseMultiFileSearchReplace(text, fileNames);
        const anyPatches = Object.values(perFilePatches).some((arr) => arr.length > 0);
        if (!anyPatches) {
          const explanation = stripCodeBlocks(text).slice(0, 1700);
          await message.reply({
            content: (`⚠️ Total file (${Math.round(totalSize / 1024)}KB) terlalu besar untuk ditulis ulang penuh, dan AI tidak memberikan format patch yang bisa diproses. Coba minta perbaikan yang lebih spesifik per file.\n\n${explanation}`).slice(0, 2000),
            flags: MessageFlags.SuppressEmbeds,
          });
          return;
        }

        const resultFiles = [];
        const notes = [];
        for (const { att, content: origContent } of loadedFiles) {
          const patches = perFilePatches[att.name] || [];
          if (!patches.length) continue;
          const { content: patched, failed, appliedCount } = applySearchReplace(origContent, patches);
          if (appliedCount === 0) {
            notes.push(`⚠️ **${att.name}**: gagal terapkan perubahan (kode tidak cocok persis).`);
            continue;
          }
          resultFiles.push(makeFile(patched, att.name));
          notes.push(`✅ **${att.name}**: ${appliedCount}/${patches.length} perubahan diterapkan${failed.length ? ` (${failed.length} gagal)` : ''}.`);
        }

        if (resultFiles.length === 0) {
          await message.reply('⚠️ Gagal menerapkan perubahan ke semua file — potongan kode yang disebut AI tidak cocok persis dengan file asli. Coba minta perbaikan yang lebih spesifik.');
          return;
        }

        const explanation = stripCodeBlocks(text).slice(0, 500);
        await message.reply({
          content: (`${notes.join('\n')}\n${explanation}`).slice(0, 2000),
          files: resultFiles,
          flags: MessageFlags.SuppressEmbeds,
        });
        return;
      }

      const blocks = extractCodeBlocks(text);

      if (shouldSendAsFile(question, blocks, isDMOwner)) {
        await replyWithFiles(message, text, blocks, originalFileNames);
        return;
      }

      // Format sources sebagai footer teks di akhir embed jika ada
    const _srcLine = sources && sources.length
      ? '\n\n> 🔗 ' + sources.slice(0, 3)
          .map(s => typeof s === 'string' ? s : (s.url || s.title || '')).filter(Boolean)
          .join('  ·  ')
      : '';
    await sendEmbedReply(message, (text || '') + _srcLine, 0x5865F2, null);
      return;
    }

    // === Pertanyaan teks biasa (tanpa file) ===
    let finalQuestion = question;
    const historyUserContent = question;

    // === !read via mention: @bot read <CA> [chain] ===
      const _rcQueryM = detectReadContractQuery(question);
      if (_rcQueryM) {
        await message.channel.sendTyping().catch(() => {});
        const _rcTypingM = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
        try {
          const _rcResultM = await handleReadContractCommand(_rcQueryM);
          clearInterval(_rcTypingM);
          await sendEmbedReply(message, _rcResultM, EMBED_COLORS.read_contract, null, [makeDeleteRow(message.author.id)]);
        } catch (e) {
          clearInterval(_rcTypingM);
          await message.reply('\u274c Gagal baca contract: ' + e.message).catch(() => {});
        }
        return;
      }

          // === Token scam/analisis skill ===
    // Ketika scam analysis dijalankan, data on-chain sudah dikumpulkan oleh runScamAnalysis.
    // Langsung panggil askGemini dengan systemOverride (bypass runAgent + tools) agar AI mengikuti
    // instruksi SKILL_SYSTEM dengan tepat tanpa distraksi tool-calling tambahan.
    let scamSystemPrompt = null;
    if (isScamAnalysisRequest(question)) {
      // Extend typing selama proses pengambilan data on-chain (bisa >10 detik)
      const typingInterval = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
      try {
        const scamResult = await runScamAnalysis(question);
        finalQuestion = scamResult.fullPrompt;
        scamSystemPrompt = scamResult.skillSystem;
      } catch (e) {
        console.error('[bot] scamAnalysis error:', e.message);
        // fall through to normal AI
      } finally {
        clearInterval(typingInterval);
      }
    }

    // === GMGN Pre-fetch: jika ada Solana/EVM address, ambil data on-chain SEBELUM tanya AI ===
    // Pola ini mirip runScamAnalysis — data diambil duluan, AI hanya format + analisis.
    // Ini memastikan data tersedia bahkan jika runAgent gagal dan fallback ke askGemini.
    if (!scamSystemPrompt) {
      const isSolAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
      const isEvmAddr = (s) => /^0x[a-fA-F0-9]{40}$/.test(s);
      // Deteksi address dari teks pertanyaan
      const evmHit = question.match(/\b(0x[a-fA-F0-9]{40})\b/);
      const solCands = question.match(/\b([1-9A-HJ-NP-Za-km-z]{32,44})\b/g) || [];
      let detectedAddr = null;
      let detectedChain = null;
      if (evmHit) {
        detectedAddr = evmHit[1]; detectedChain = 'evm';
      } else {
        // Validasi base58: setiap kandidat, cek decode BigInt <= 32 bytes
        for (const cand of solCands) {
          const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
          let n = BigInt(0), valid = true;
          for (const c of cand) { const d = ALPHA.indexOf(c); if (d < 0) { valid = false; break; } n = n * 58n + BigInt(d); }
          if (valid) { const h = n.toString(16); if (h.length <= 64) { detectedAddr = cand; detectedChain = 'sol'; break; } }
        }
      }

      if (detectedAddr) {
        const typingGmgn = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
        try {
          const gmgnParsed = { type: 'token', chain: detectedChain === 'sol' ? 'sol' : 'eth', address: detectedAddr, autoDetect: detectedChain !== 'sol' };
          const gmgnData = await handleGmgnCommand(gmgnParsed);
          if (gmgnData && !gmgnData.startsWith('❌')) {
            finalQuestion = question +
              '\n\n[DATA ON-CHAIN TOKEN (sumber: GMGN) — gunakan data ini untuk analisis, jangan abaikan:]' +
              '\n' + gmgnData +
              '\n\n[Tugas: Analisis data di atas, jelaskan dengan bahasa yang mudah dipahami, berikan penilaian risiko, dan rekomendasimu. Format untuk Discord.]';
          }
        } catch (gmgnErr) {
          console.log('[bot] GMGN pre-fetch gagal:', gmgnErr.message?.slice(0, 100));
          // Tetap lanjut — agent loop masih bisa coba lewat tools
        } finally {
          clearInterval(typingGmgn);
        }
      }
    }

    const history = getHistoryForAI(historyKey, isDMOwner);

    let text, sources;
    if (scamSystemPrompt) {
      // Scam analysis: AI langsung tanpa tool loop — data sudah lengkap dari runScamAnalysis
      // [FIX #4] Scam analysis: pakai systemOverride agar semua provider (Groq/OpenAI/Gemini)
      // ikuti instruksi khusus. Data sudah ada di finalQuestion — tidak butuh browsing.
      // Fallback tanpa systemOverride agar tetap ada jawaban meski systemOverride menyebabkan error.
      const scamResp = await askGemini(finalQuestion, history, isDMOwner, [], scamSystemPrompt)
        .catch(async (err) => {
          console.error('[bot] askGemini scam gagal:', err.message?.slice(0, 100));
          return askGemini(finalQuestion, history, isDMOwner, [], null); // fallback tanpa custom system
        });
      text = scamResp.text;
      sources = scamResp.sources || [];
    } else {
      // Smart routing: runAgent hanya untuk request coding eksplisit, askAI untuk chat biasa
      // (runAgent kirim semua tool defs ke API → payload besar → 413 di Groq jika dipakai semua request)
      const _q = finalQuestion.toLowerCase();
      const _isCodingReq = (
        // Ada code block di pertanyaan
        finalQuestion.includes('```') ||
        // Minta jalankan / eksekusi kode
        /jalankan\s+(kode|script|program)|run\s+code|execute\s+code|eksekusi/i.test(finalQuestion) ||
        // Minta tulis kode dengan konteks bahasa pemrograman
        /\b(buat|tulis|bikin)\s+(kode|script|program|fungsi|function|class)\b/i.test(finalQuestion) ||
        // Debug / install package
        /\bdebug\s+kode\b|install\s+(package|library|pip|npm|library)/i.test(finalQuestion) ||
        // [FIX] GitHub URL → harus pakai readGitHubRepo tool di runAgent
        /github\.com\/[^\s]+\/[^\s]+/.test(finalQuestion) ||
        // [FIX] Kata kunci coding umum (sync dengan detectCategory agent.js)
        /\b(debug|bug|error|syntax|perbaiki|benerin|cek\s+error|refactor|algoritma|variabel|kode|code|script|program|fungsi|function|class|html|css)\b/i.test(finalQuestion) ||
        // DM owner selalu dapat full coding agent
        isDMOwner
      );
      let aiResp;
      if (_isCodingReq) {
        // Coding request: pakai runAgent dengan E2B + semua tools
        // [FIX] Typing keepalive — E2B bisa butuh 30+ detik, Discord timeout 10s
        const _codingTyping = setInterval(() => { message.channel.sendTyping().catch(() => {}); }, 8000);
        // [FIX] onToolCall progress feedback ke user
        const _onToolCall = async (toolName) => {
          try {
            const _labels = {
              executeCode: '⚙️ Menjalankan kode di sandbox...',
              writeFile: '📝 Menulis file...',
              readFile: '📖 Membaca file...',
              listFiles: '📂 Melihat struktur folder...',
              installPackage: '📦 Menginstall package...',
              readGitHubRepo: '🔍 Membaca repo GitHub...',
              analyzeTokenSecurity: '🔒 Menganalisis keamanan token...',
              getDexPrice: '📊 Mengambil data harga token...',
              getOnchainData: '🔗 Mengambil data on-chain...',
            };
            const label = _labels[toolName] || ('🔧 ' + toolName + '...');
            await message.channel.sendTyping().catch(() => {});
            console.log('[bot] tool:', toolName);
          } catch (_) {}
        };
        try {
          aiResp = await runAgent(finalQuestion, history, isDMOwner, _onToolCall, null, message.author.id);
        } finally {
          clearInterval(_codingTyping);
        }
        text = aiResp.text || aiResp;
        sources = [];
      } else {
        // Chat biasa (crypto, umum): pakai askAI — lebih ringan, tidak kirim tool defs ke API
        aiResp = await askAI(finalQuestion, history, isDMOwner);
        text = aiResp.text;
        sources = aiResp.sources || [];
      }
    }

    await pushHistory(historyKey, historyUserContent, text, isDMOwner);

    const blocks = extractCodeBlocks(text);

    if (shouldSendAsFile(question, blocks, isDMOwner)) {
      await replyWithFiles(message, text, blocks, []);
      return;
    }

    // Format sources sebagai footer teks di akhir embed jika ada
    const _srcLine = sources && sources.length
      ? '\n\n> 🔗 ' + sources.slice(0, 3)
          .map(s => typeof s === 'string' ? s : (s.url || s.title || '')).filter(Boolean)
          .join('  ·  ')
      : '';
    await sendEmbedReply(message, (text || '') + _srcLine, 0x5865F2, null);
  } catch (err) {
    // ⚠️ JANGAN log objek axios error mentah — err.config.headers berisi Authorization:
    // Bearer <API key> dan akan bocor ke log Railway (termasuk saat log diexport/dibagikan).
    console.error('[bot] Error di messageCreate:', safeErrStr(err));
    const _st = safeStack(err);
    if (_st) console.error(_st);
    await message.reply(friendlyError(err)).catch(() => {});
  }
});

// ============================================================
// LOGIN
// ============================================================

const token = (process.env.DISCORD_TOKEN || '').trim();
if (!token) {
  console.error('[bot] DISCORD_TOKEN belum di-set. Set env DISCORD_TOKEN dengan Bot Token dari Developer Portal.');
  process.exit(1);
}

// ============================================================
// TOMBOL DELETE — hanya user pengirim yang bisa klik
// ============================================================
const _interactionLock = new Set(); // [FIX] cegah double-process rapid clicks
client.on('interactionCreate', async (interaction) => {
  console.log('[btn] interactionCreate fired, type:', interaction.type, 'isButton:', interaction.isButton?.());
  try {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

    // ── Provider panel: toggle aktif/nonaktif ─────────────────────────────
    if (interaction.isButton() && interaction.customId.startsWith('provider_toggle_')) {
      if (_interactionLock.has(interaction.id)) return;
      _interactionLock.add(interaction.id);
      setTimeout(() => _interactionLock.delete(interaction.id), 5000);
      if (interaction.user.id !== OWNER_ID) {
        await interaction.reply({ content: '⛔ Hanya owner.', flags: MessageFlags.Ephemeral });
        return;
      }
      var _ptProvider = interaction.customId.replace('provider_toggle_', '');
      var _ptStatus = getAgentStatus();
      var _ptOrder = [..._ptStatus.order];
      if (_ptOrder.includes(_ptProvider)) {
        if (_ptOrder.length <= 1) {
          await interaction.reply({ content: '⚠️ Minimal 1 provider harus aktif!', flags: MessageFlags.Ephemeral });
          return;
        }
        _ptOrder = _ptOrder.filter(function(p) { return p !== _ptProvider; });
      } else {
        _ptOrder.push(_ptProvider);
      }
      setAgentOrder(_ptOrder);
      // [FIX] jangan await saveKey sebelum update() — saveKey di-debounce 3s
      // di data_store.js, kalau di-await duluan token interaksi keburu expired
      // (Discord butuh ack < 3s) → DiscordAPIError[10062] Unknown interaction.
      await interaction.update(makeProviderPanel());
      store.saveKey('provider_order', _ptOrder).catch(function(){});
      return;
    }

    // ── Provider panel: set prioritas utama ───────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId === 'provider_primary') {
      if (_interactionLock.has(interaction.id)) return;
      _interactionLock.add(interaction.id);
      setTimeout(() => _interactionLock.delete(interaction.id), 5000);
      if (interaction.user.id !== OWNER_ID) {
        await interaction.reply({ content: '⛔ Hanya owner.', flags: MessageFlags.Ephemeral });
        return;
      }
      var _ppPrimary = interaction.values[0];
      var _ppStatus = getAgentStatus();
      var _ppOrder = [..._ppStatus.order];
      if (!_ppOrder.includes(_ppPrimary)) _ppOrder.push(_ppPrimary);
      _ppOrder = [_ppPrimary, ..._ppOrder.filter(function(p) { return p !== _ppPrimary; })];
      setAgentOrder(_ppOrder);
      // [FIX] sama seperti provider_toggle di atas — update() dulu, baru saveKey di background.
      await interaction.update(makeProviderPanel());
      store.saveKey('provider_order', _ppOrder).catch(function(){});
      return;
    }
    console.log('[btn] customId:', interaction.customId, 'userId:', interaction.user?.id);

    // -- AI panel buttons --
    if (['ai_global_off','ai_global_on','ai_sv_toggle','ai_ch_toggle','ai_del'].includes(interaction.customId)) {
      if (interaction.user.id !== OWNER_ID) { await interaction.reply({ content: '⛔ Hanya owner.', flags: MessageFlags.Ephemeral }); return; }
      if (interaction.customId === 'ai_del') { await interaction.deferUpdate(); await interaction.message.delete().catch(() => {}); return; }
      const _gid2 = interaction.guildId, _cid2 = interaction.channelId;
      if (interaction.customId === 'ai_global_off') { aiGlobalOff = true; saveAiState(); }
      else if (interaction.customId === 'ai_global_on') { aiGlobalOff = false; saveAiState(); }
      else if (interaction.customId === 'ai_sv_toggle') { if (_gid2) { if (aiDisabled.has('sv:' + _gid2)) aiDisabled.delete('sv:' + _gid2); else aiDisabled.add('sv:' + _gid2); saveAiState(); } }
      else if (interaction.customId === 'ai_ch_toggle') { if (aiDisabled.has('ch:' + _cid2)) aiDisabled.delete('ch:' + _cid2); else aiDisabled.add('ch:' + _cid2); saveAiState(); }
      const _dsvB = [], _dchB = [];
      for (const k of aiDisabled) {
        if (k.startsWith('sv:')) { const g = client.guilds.cache.get(k.slice(3)); _dsvB.push('🔴 ' + (g ? g.name : k.slice(3))); }
        else if (k.startsWith('ch:')) { const ch = client.channels.cache.get(k.slice(3)); _dchB.push('🔴 ' + (ch ? '#' + (ch.name || k.slice(3)) : '#' + k.slice(3)) + ((ch && ch.guild) ? ' (' + ch.guild.name + ')' : '')); }
      }
      const _aGS = aiGlobalOff ? '🔴 MATI' : '🟢 HIDUP', _aSS = _gid2 && aiDisabled.has('sv:' + _gid2) ? '🔴 MATI' : '🟢 HIDUP', _aCS = aiDisabled.has('ch:' + _cid2) ? '🔴 MATI' : '🟢 HIDUP';
      const _allG3 = client.guilds.cache.map(g => (aiGlobalOff || aiDisabled.has('sv:' + g.id) ? '🔴' : '🟢') + ' ' + g.name + ' (' + g.memberCount + ')');
      const _aeB = new EmbedBuilder().setColor(aiGlobalOff ? 0xED4245 : 0x57F287).setTitle('🤖 Panel Kontrol AI').setTimestamp().addFields({ name: '🌐 Status Global', value: _aGS, inline: true }, { name: '🏠 Server Ini', value: _aSS, inline: true }, { name: '💬 Channel Ini', value: _aCS, inline: true });
      if (_allG3.length) _aeB.addFields({ name: '📋 Server Bot (' + _allG3.length + ')', value: _allG3.slice(0,15).join('\n').slice(0,1024), inline: false });
      if (_dsvB.length) _aeB.addFields({ name: '🚫 Server Nonaktif', value: _dsvB.slice(0,10).join('\n').slice(0,1024), inline: false });
      if (_dchB.length) _aeB.addFields({ name: '🚫 Channel Nonaktif', value: _dchB.slice(0,10).join('\n').slice(0,1024), inline: false });
      if (!aiGlobalOff && !_dsvB.length && !_dchB.length) _aeB.addFields({ name: '✅ Status', value: 'AI aktif di semua.', inline: false });
      const _svDB = _gid2 && aiDisabled.has('sv:' + _gid2), _chDB = aiDisabled.has('ch:' + _cid2);
      const _ar1B = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ai_global_off').setLabel('🔇 Global OFF').setStyle(ButtonStyle.Danger).setDisabled(aiGlobalOff), new ButtonBuilder().setCustomId('ai_global_on').setLabel('🔊 Global ON').setStyle(ButtonStyle.Success).setDisabled(!aiGlobalOff), new ButtonBuilder().setCustomId('ai_sv_toggle').setLabel(_svDB ? '🟢 Server ON' : '🔴 Server OFF').setStyle(_svDB ? ButtonStyle.Success : ButtonStyle.Danger), new ButtonBuilder().setCustomId('ai_ch_toggle').setLabel(_chDB ? '🟢 Channel ON' : '🔴 Channel OFF').setStyle(_chDB ? ButtonStyle.Success : ButtonStyle.Danger));
      const _ar2B = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ai_del').setLabel('🗑️ Tutup').setStyle(ButtonStyle.Secondary));
      await interaction.update({ embeds: [_aeB], components: [_ar1B, _ar2B] });
      return;
    }

    // -- Reactor panel buttons --
    if (interaction.customId.startsWith('reactor_')) {
      if (interaction.user.id !== OWNER_ID) { await interaction.reply({ content: '⛔ Hanya owner.', flags: MessageFlags.Ephemeral }); return; }

      if (interaction.customId === 'reactor_del') {
        await interaction.deferUpdate(); await interaction.message.delete().catch(() => {}); return;
      }

      if (interaction.customId === 'reactor_refresh') {
        await interaction.deferUpdate(); await interaction.editReply(makeReactorPanel()).catch(() => {}); return;
      }

      if (interaction.customId === 'reactor_restart_all') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targets = reactorClients.filter(r => !disabledReactors.has(r.label));
        let ok = 0;
        for (const r of targets) {
          try {
            if (r.rc.isReady()) r.rc.destroy();
            await new Promise(res => setTimeout(res, 1000));
            await r.rc.login(r.token);
            ok++;
          } catch (e) { console.warn('[reactor] restart gagal:', r.label, e.message); }
          await new Promise(res => setTimeout(res, 1500));
        }
        saveReactorStatus();
        await interaction.editReply({ content: '🔃 Restart selesai: **' + ok + '/' + targets.length + '** reactor berhasil.' });
        return;
      }

      if (interaction.customId === 'reactor_restart_offline') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const targets = reactorClients.filter(r => !r.rc.user && !disabledReactors.has(r.label));
        let ok = 0;
        for (const r of targets) {
          try {
            await r.rc.login(r.token); ok++;
          } catch (e) { console.warn('[reactor] restart offline gagal:', r.label, e.message); }
          await new Promise(res => setTimeout(res, 1500));
        }
        saveReactorStatus();
        await interaction.editReply({ content: '🔃 Restart offline selesai: **' + ok + '/' + targets.length + '** reactor dicoba.' });
        return;
      }

      if (interaction.customId.startsWith('reactor_toggle_')) {
        const _lbl = interaction.customId.replace('reactor_toggle_', '');
        const _r   = reactorClients.find(r => r.label === _lbl);
        if (!_r) { await interaction.reply({ content: '⚠️ Reactor **' + _lbl + '** tidak ditemukan.', flags: MessageFlags.Ephemeral }); return; }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        // Gunakan disabledReactors sebagai source of truth, bukan rc.user
        // Bug: setelah destroy(), rc.user tidak langsung null di selfbot client
        const _isDisabled = disabledReactors.has(_lbl);

        if (!_isDisabled) {
          // Matikan
          disabledReactors.add(_lbl);
          _r.rc.destroy();
          await new Promise(res => setTimeout(res, 2000));
          await store.saveKey('reactor_disabled', [...disabledReactors]).catch(() => {});
          saveReactorStatus();
          await interaction.editReply({ content: '⛔ **' + _lbl + '** dimatikan dan tidak akan auto-reconnect.' });
        } else {
          // Hidupkan
          disabledReactors.delete(_lbl);
          try {
            await _r.rc.login(_r.token);
            await store.saveKey('reactor_disabled', [...disabledReactors]).catch(() => {});
            saveReactorStatus();
            await interaction.editReply({ content: '✅ **' + _lbl + '** dihidupkan.' });
          } catch (e) {
            disabledReactors.add(_lbl); // rollback jika login gagal
            await store.saveKey('reactor_disabled', [...disabledReactors]).catch(() => {});
            await interaction.editReply({ content: '❌ Gagal login **' + _lbl + '**: ' + e.message });
          }
        }
        return;
      }
    }

    // Handle tombol Warzone
    if (interaction.customId.startsWith('warzone_')) {
      const parts   = interaction.customId.split('_');  // ['warzone','join','channelId'] dll
      const action  = parts[1]; // join | start | cancel | again
      const chId    = parts.slice(2).join('_');

      if (action === 'join') {
        if (warzoneGames.has(chId)) { await interaction.reply({ content: '⚔️ Game sudah berjalan, tidak bisa bergabung!', flags: MessageFlags.Ephemeral }); return; }
        const lb = warzoneLobbies.get(chId);
        if (!lb) { await interaction.reply({ content: '⚠️ Lobby sudah tidak aktif.', flags: MessageFlags.Ephemeral }); return; }
        if (lb.playerIds.has(interaction.user.id)) { await interaction.reply({ content: '✅ Kamu sudah ada di lobby!', flags: MessageFlags.Ephemeral }); return; }
        if (lb.players.length >= 20) { await interaction.reply({ content: '⚠️ Lobby penuh (maks 20 pemain)!', flags: MessageFlags.Ephemeral }); return; }
        lb.playerIds.add(interaction.user.id);
        lb.players.push(wz_makePlayer(interaction.user));
        await interaction.reply({ content: `⚔️ Kamu bergabung! (${lb.players.length}/20 pemain)`, flags: MessageFlags.Ephemeral });
        if (lb.lobbyMsg) {
          const mkJoinRow = () => new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`warzone_join_${chId}`).setLabel('⚔️ Gabung!').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`warzone_start_${chId}`).setLabel('▶️ Mulai (Host)').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`warzone_cancel_${chId}`).setLabel('❌ Batal').setStyle(ButtonStyle.Danger),
          );
          lb.lobbyMsg.edit({ embeds: [wz_lobbyEmbed(lb)], components: [mkJoinRow()] }).catch(() => {});
        }
        return;
      }

      if (action === 'start') {
        const lb = warzoneLobbies.get(chId);
        if (!lb) { await interaction.reply({ content: '⚠️ Lobby sudah tidak aktif.', flags: MessageFlags.Ephemeral }); return; }
        if (interaction.user.id !== lb.host) { await interaction.reply({ content: '⛔ Hanya host yang bisa memulai!', flags: MessageFlags.Ephemeral }); return; }
        if (lb.players.length < 2) { await interaction.reply({ content: '⚠️ Min 2 pemain diperlukan!', flags: MessageFlags.Ephemeral }); return; }
        clearTimeout(lb.timer); clearInterval(lb.updateIv);
        warzoneLobbies.delete(chId);
        await interaction.deferUpdate();
        if (lb.lobbyMsg) lb.lobbyMsg.edit({ embeds: [wz_lobbyEmbed(lb)], content: `▶️ _Dimulai oleh **${interaction.user.displayName || interaction.user.username}**!_`, components: [] }).catch(() => {});
        const ch = interaction.channel;
        await ch.send(`⚔️ **${interaction.user.displayName || interaction.user.username}** memulai game! **${lb.players.length} pejuang** siap!`).catch(() => {});
        await new Promise(r => setTimeout(r, 1200));
        wz_runGame(ch, lb.players).catch(e => console.error('[warzone] runGame error:', e));
        return;
      }

      if (action === 'cancel') {
        const lb = warzoneLobbies.get(chId);
        if (!lb) { await interaction.reply({ content: '⚠️ Lobby sudah tidak aktif.', flags: MessageFlags.Ephemeral }); return; }
        if (interaction.user.id !== lb.host) { await interaction.reply({ content: '⛔ Hanya host yang bisa membatalkan!', flags: MessageFlags.Ephemeral }); return; }
        clearTimeout(lb.timer); clearInterval(lb.updateIv);
        warzoneLobbies.delete(chId);
        await interaction.deferUpdate();
        if (lb.lobbyMsg) lb.lobbyMsg.edit({ content: '❌ **Lobby Warzone dibatalkan** oleh host.', components: [], flags: MessageFlags.SuppressEmbeds }).catch(() => {});
        return;
      }

      if (action === 'again') {
        await interaction.reply({ content: '⚔️ Ketik `!warzone` untuk membuka lobby baru!', flags: MessageFlags.Ephemeral });
        return;
      }

      return;
    }

        if (!interaction.customId.startsWith('del_')) return;

    const ownerId = interaction.customId.slice(4);
    console.log('[btn] ownerId:', ownerId, 'clickerId:', interaction.user.id);

    if (interaction.user.id !== ownerId) {
      console.log('[btn] bukan pemilik, tolak');
      await interaction.reply({
        content: '⛔ Hanya pengirim pesan asli yang bisa menghapus ini.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // deferUpdate = silent ACK ke Discord (paling cepat, tidak buat pesan baru)
    console.log('[btn] deferUpdate...');
    await interaction.deferUpdate();
    console.log('[btn] deferUpdate OK, deleting messages...');

    // Hapus SEMUA pesan scan (bisa 2-3 pesan), bukan hanya yang punya tombol delete
    // Map sekarang menyimpan Message object langsung — tidak perlu fetch by ID lagi
    const _allScanMsgs = _scanMsgMap.get(interaction.message.id);
    _scanMsgMap.delete(interaction.message.id); // cleanup Map sebelum delete

    if (_allScanMsgs && _allScanMsgs.length > 0) {
      console.log(`[btn] deleting ${_allScanMsgs.length} scan message(s) via stored references`);
      for (const _msg of _allScanMsgs) {
        await _msg.delete()
          .catch(e => console.warn('[btn] gagal hapus msg ' + _msg.id + ':', e.message));
      }
    } else {
      // Fallback: tidak ada di Map (bot restart?) — hapus hanya pesan tombol
      console.log('[btn] no map entry, deleting interaction message only');
      await interaction.message.delete()
        .catch(e => console.warn('[btn] gagal hapus interaction msg:', e.message));
    }
    console.log('[btn] message(s) deleted OK');
  } catch (err) {
    console.error('[btn] ERROR:', err.message, err.stack);
    // Coba reply jika belum di-acknowledge
    try {
      if (!interaction.replied && !interaction.deferred) {
        await interaction.reply({ content: '⚠️ Gagal hapus: ' + err.message, flags: MessageFlags.Ephemeral });
      }
    } catch (_) {}
  }
});


(async () => {
  try {
    const _d = await store.loadAll();
    if (_d.ai_state_bot) {
      if (_d.ai_state_bot.globalOff) aiGlobalOff = true;
      if (_d.ai_state_bot.disabled) _d.ai_state_bot.disabled.forEach(k => aiDisabled.add(k));
      console.log('[store] ai_state_bot: globalOff=' + aiGlobalOff + ', disabled=' + aiDisabled.size);
    }
    if (_d.provider_order) {
      setAgentOrder(_d.provider_order);
      console.log('[store] provider_order:', _d.provider_order.join(' → '));
    }
    // Muat settingan reactor yang dimatikan — tetap berlaku meski restart/redeploy
    if (Array.isArray(_d.reactor_disabled) && _d.reactor_disabled.length > 0) {
      _d.reactor_disabled.forEach(lbl => disabledReactors.add(lbl));
      console.log('[reactor] disabled dari Gist:', [...disabledReactors].join(', '));
    }
  } catch (e) {
    console.warn('[store] Gist load gagal, pakai local file:', e.message);
  }

  // Login reactor clients (skip yang ada di disabledReactors)
  for (const r of reactorClients) {
    if (disabledReactors.has(r.label)) {
      console.log('[' + r.label + '] Skip login — disabled via Gist.');
      continue;
    }
    try {
      await r.rc.login(r.token);
    } catch (e) {
      console.warn('[' + r.label + '] Login gagal:', e.message);
    }
    await new Promise(res => setTimeout(res, 1500)); // jeda antar login agar tidak rate-limit
  }

  // Login dengan retry tak terbatas untuk menangani Discord 5xx saat startup.
  // Hanya menyerah pada error non-5xx (misal 401 token invalid).
  async function loginWithRetry() {
    const MAX_DELAY_MS = 30000;
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        await client.login(token);
        if (attempt > 1) console.log('[bot] Login berhasil pada percobaan ke-' + attempt);
        return; // berhasil
      } catch (err) {
        const status = err?.status ?? err?.httpStatus ?? null;
        const is5xx = status !== null && status >= 500 && status < 600;

        // Log body Discord jika ada (membantu diagnosa penyebab 500)
        let body = '';
        try { body = err?.rawError ? JSON.stringify(err.rawError) : ''; } catch (_) {}

        if (!is5xx) {
          // Error non-5xx (401, 403, dll) — tidak akan berubah, berhenti.
          console.error('[bot] Login GAGAL permanen (HTTP ' + (status ?? '?') + '): ' + err.message + (body ? ' | body: ' + body : ''));
          throw err;
        }

        const delay = Math.min(3000 * attempt, MAX_DELAY_MS);
        console.warn('[bot] Login gagal percobaan ' + attempt + ' (HTTP ' + status + (body ? ', ' + body : '') + ') — retry dalam ' + delay / 1000 + 's...');
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }

  await loginWithRetry();
})();

