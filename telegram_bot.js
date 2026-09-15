// telegram_bot.js
// Bot Telegram — port dari bot.js (Discord)
//
// POLA:
//   • AI chat   → DM ke bot, HANYA owner
//   • Semua fitur lain → grup + DM, tanpa perlu tag/mention
//
// SETUP:
//   1. pnpm add telegraf  (atau: npm install telegraf)
//   2. Set env:
//        TELEGRAM_BOT_TOKEN  — dari @BotFather
//        TELEGRAM_OWNER_ID   — Telegram user ID kamu (cek via @userinfobot)
//        OWNER_ID            — (opsional, fallback jika TELEGRAM_OWNER_ID kosong)
//   3. node telegram_bot.js
//
// ENV LAIN (sama persis dengan bot.js):
//   GROQ_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, CONDUIT_API_KEY
//   COINGECKO_API_KEY, COINMARKETCAP_API_KEY, CRYPTORANK_API_KEY
//   ETHERSCAN_API_KEY, BSCSCAN_API_KEY, ALCHEMY_BASE_RPC
//   ABUSEIPDB_API_KEY, VIRUSTOTAL_API_KEY, MEMORYLOL_TOKEN
//   GITHUB_TOKEN (untuk data_store Gist)
//   PRIVATE_KEY, WALLET_ADDRESS (untuk fitur send/shuffle)

'use strict';

const { Telegraf } = require('telegraf');
const store        = require('./data_store');
const path         = require('path');
const fs           = require('fs');
const axios        = require('axios');

// ── Lib imports (sama persis dengan bot.js) ───────────────────────────────────
const {
  isImageRequest, askAI, askGemini, generateImage,
  formatAnswer, friendlyError, extractCodeBlocks, stripCodeBlocks,
  EXT_MAP, getDefaultBranch, getGitHubFileContent,
  commitGitHubFile, validateSyntax, PROVIDERS, PROVIDER_ORDER,
} = require('./lib/ai');
const { runAgent, setAgentOrder, getAgentStatus }       = require('./lib/agent');
const { isScamAnalysisRequest, runScamAnalysis }        = require('./lib/tokenScamAnalysis');
const { detectBalanceQuery, fetchZerionPortfolio }      = require('./lib/zerion');
const { searchUsername }                                 = require('./lib/sherlock');
const {
  lookupIP, lookupDNS, lookupGitHub, lookupPhone, runEndpoints,
} = require('./lib/osintExtra');
const {
  analyzePhotoGPS, analyzePhotoFromURL, lookupGeoIP, lookupMaps, lookupTimezone,
} = require('./lib/geoPhoto');
const { pickWinnerOnChain, isShuffleConfigured, getWalletInfo } = require('./lib/shuffle');
const { parseSendCommand, sendToken, getBalance }       = require('./lib/send');
const { parseMultisendCommand, executeMultisend }       = require('./lib/multisend');
const { detectGmgnQuery, handleGmgnCommand }            = require('./lib/gmgn');
const { detectLpQuery, handleLpCommand }                = require('./lib/lp');
const { detectReadContractQuery, handleReadContractCommand } = require('./lib/readContract');
const { handleChartCommand, SYMBOL_MAP }                = require('./lib/chartAnalysis');

// ─────────────────────────────────────────────────────────────────────────────
// KONFIGURASI
// ─────────────────────────────────────────────────────────────────────────────

if (!process.env.TELEGRAM_BOT_TOKEN)
  throw new Error('[tgbot] TELEGRAM_BOT_TOKEN belum di-set!');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID  = String(process.env.TELEGRAM_OWNER_ID || process.env.OWNER_ID || '');

if (!OWNER_ID)
  throw new Error('[tgbot] TELEGRAM_OWNER_ID (atau OWNER_ID) belum di-set!');

const bot = new Telegraf(BOT_TOKEN);

// Username bot (diisi saat launch, untuk strip @mention di grup)
let BOT_USERNAME = '';
bot.telegram.getMe().then(me => {
  BOT_USERNAME = me.username || '';
  console.log('[tgbot] Username:', BOT_USERNAME);
}).catch(() => {});

// ─────────────────────────────────────────────────────────────────────────────
// AI HISTORY (per user)
// ─────────────────────────────────────────────────────────────────────────────

const AI_HISTORY_FILE = path.join(__dirname, 'data', 'tg_ai_history.json');
const MAX_HISTORY = 20;
let _aiHistory = {};

function _loadAiHistory() {
  try {
    if (fs.existsSync(AI_HISTORY_FILE))
      _aiHistory = JSON.parse(fs.readFileSync(AI_HISTORY_FILE, 'utf8'));
  } catch(e) { console.warn('[tgbot] gagal muat ai history:', e.message); }
}

function _saveAiHistory() {
  try {
    fs.mkdirSync(path.dirname(AI_HISTORY_FILE), { recursive: true });
    fs.writeFileSync(AI_HISTORY_FILE, JSON.stringify(_aiHistory), 'utf8');
  } catch(e) { console.warn('[tgbot] gagal simpan ai history:', e.message); }
}

function getHistory(userId) { return _aiHistory[String(userId)] || []; }

function addToHistory(userId, role, content) {
  const key = String(userId);
  if (!_aiHistory[key]) _aiHistory[key] = [];
  _aiHistory[key].push({ role, content });
  if (_aiHistory[key].length > MAX_HISTORY)
    _aiHistory[key] = _aiHistory[key].slice(-MAX_HISTORY);
  _saveAiHistory();
}

function clearHistory(userId) {
  _aiHistory[String(userId)] = [];
  _saveAiHistory();
}

_loadAiHistory();

// ─────────────────────────────────────────────────────────────────────────────
// AI STATE (on/off)
// ─────────────────────────────────────────────────────────────────────────────

const aiDisabled = new Set();
let aiGlobalOff  = false;
// Grup yang sudah di-enable AI oleh owner (default: semua grup OFF)
const aiEnabledGroups = new Set();
const AI_STATE_FILE = path.join(__dirname, 'data', 'tg_ai_state.json');

function saveAiState() {
  try {
    fs.mkdirSync(path.dirname(AI_STATE_FILE), { recursive: true });
    fs.writeFileSync(AI_STATE_FILE,
      JSON.stringify({
        globalOff: aiGlobalOff,
        disabled: [...aiDisabled],
        enabledGroups: [...aiEnabledGroups],
      }, null, 2), 'utf8');
  } catch(e) { console.warn('[tgbot] gagal simpan ai_state:', e.message); }
}

function loadAiState() {
  try {
    if (!fs.existsSync(AI_STATE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(AI_STATE_FILE, 'utf8'));
    if (obj.globalOff) aiGlobalOff = true;
    if (Array.isArray(obj.disabled)) obj.disabled.forEach(k => aiDisabled.add(k));
    if (Array.isArray(obj.enabledGroups)) obj.enabledGroups.forEach(k => aiEnabledGroups.add(k));
  } catch(e) { console.warn('[tgbot] gagal muat ai_state:', e.message); }
}

loadAiState();

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

const isDM    = ctx => ctx.chat.type === 'private';
const isOwner = ctx => String(ctx.from.id) === OWNER_ID;

async function typing(ctx) {
  await ctx.sendChatAction('typing').catch(() => {});
}

// Discord markdown → Telegram HTML
function tgFmt(text) {
  if (!text) return '';
  // Normalize Discord angle-bracket links [text](<url>) → [text](url)
  // HARUS sebelum HTML-escape agar < dan > tidak jadi &lt;&gt;
  text = text.replace(/\[([^\]]+)\]\(<(https?:\/\/[^>]+)>\)/g, '[$1]($2)');
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/\*(.+?)\*/gs, '<i>$1</i>')
    .replace(/```[\w]*\n?([\s\S]*?)```/g, '<pre>$1</pre>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .trim();
}

// Kirim pesan panjang dalam beberapa bagian (max 4096 Telegram)
async function sendLong(ctx, text) {
  const MAX = 4000;
  const formatted = tgFmt(text);
  const parts = [];
  let rem = formatted;
  while (rem.length > 0) {
    parts.push(rem.slice(0, MAX));
    rem = rem.slice(MAX);
  }
  for (let i = 0; i < parts.length; i++) {
    const prefix = i > 0 ? `<i>(lanjutan ${i + 1}/${parts.length})</i>\n` : '';
    await ctx.reply(prefix + parts[i], { parse_mode: 'HTML' })
      .catch(async () => {
        // fallback tanpa HTML jika gagal parse
        await ctx.reply((prefix + parts[i]).replace(/<[^>]+>/g, '')).catch(() => {});
      });
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 500));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER: bungkus ctx Telegraf agar kompatibel dengan handleChartCommand
// handleChartCommand(message, symbol, tf, N) — memanggil message.reply() + message.channel.send()
// ─────────────────────────────────────────────────────────────────────────────

function makeTgAdapter(ctx) {
  const chatId = ctx.chat.id;

  async function _send(opts) {
    try {
      if (typeof opts === 'string') {
        await ctx.reply(tgFmt(opts), { parse_mode: 'HTML' }).catch(() => ctx.reply(opts.slice(0, 4096)));
        return;
      }
      const text  = opts.content || opts.text || '';
      const files = opts.files  || [];

      if (files.length > 0) {
        // AttachmentBuilder dari discord.js menyimpan buffer di .attachment
        const f   = files[0];
        const buf = (f && f.attachment) ? f.attachment : (Buffer.isBuffer(f) ? f : null);
        const caption = tgFmt(text).slice(0, 1024);

        if (buf) {
          await ctx.replyWithPhoto(
            { source: buf },
            { caption, parse_mode: 'HTML' }
          ).catch(async () => {
            await ctx.reply(tgFmt(text).slice(0, 4096), { parse_mode: 'HTML' }).catch(() => {});
          });
        } else {
          await ctx.reply(tgFmt(text).slice(0, 4096), { parse_mode: 'HTML' }).catch(() => {});
        }
      } else if (text) {
        await sendLong(ctx, text);
      }
    } catch(e) {
      console.warn('[tgbot] adapter._send error:', e.message);
    }
  }

  return {
    author  : { id: String(ctx.from.id) },
    guild   : ctx.chat.type !== 'private' ? { id: String(chatId), name: ctx.chat.title } : null,
    content : ctx.message?.text || '',
    attachments: new Map(),
    channel : {
      sendTyping: () => bot.telegram.sendChatAction(chatId, 'upload_photo').catch(() => {}),
      send      : _send,
    },
    mentions: { users: { has: () => false } },
    reply   : _send,
    fetchReference: () => Promise.resolve(null),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COINS & PRICE (port dari bot.js)
// ─────────────────────────────────────────────────────────────────────────────

const COIN_ID_MAP = {
  btc:'bitcoin',bitcoin:'bitcoin',eth:'ethereum',ethereum:'ethereum',
  usdc:'usd-coin',usdt:'tether',tether:'tether',bnb:'binancecoin',
  sol:'solana',solana:'solana',xrp:'ripple',ripple:'ripple',
  ada:'cardano',cardano:'cardano',doge:'dogecoin',dogecoin:'dogecoin',
  dot:'polkadot',polkadot:'polkadot',avax:'avalanche-2',avalanche:'avalanche-2',
  matic:'matic-network',polygon:'matic-network',link:'chainlink',chainlink:'chainlink',
  ltc:'litecoin',litecoin:'litecoin',shib:'shiba-inu',
  atom:'cosmos',cosmos:'cosmos',near:'near',apt:'aptos',aptos:'aptos',
  arb:'arbitrum',arbitrum:'arbitrum',op:'optimism',optimism:'optimism',
  inj:'injective-protocol',sui:'sui',ton:'the-open-network',
  pepe:'pepe',trx:'tron',tron:'tron',xlm:'stellar',stellar:'stellar',
  icp:'internet-computer',fil:'filecoin',filecoin:'filecoin',
};

const SUPPORTED_VS = new Set([
  'idr','usd','eur','gbp','jpy','krw','cny','sgd','aud','myr',
  'thb','php','inr','vnd','brl','try','rub','cad','chf','hkd',
  'btc','eth','bnb','sats',
]);

const _dynCoinId  = {};
const _dynDexCache = {};

let _usdIdrRateCache = { rate: null, ts: 0 };
async function getUsdToIdrRate() {
  const now = Date.now();
  if (_usdIdrRateCache.rate && now - _usdIdrRateCache.ts < 30 * 60 * 1000)
    return _usdIdrRateCache.rate;
  try {
    const r = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 6000 });
    const rate = r.data?.rates?.IDR;
    if (typeof rate === 'number' && rate > 0) {
      _usdIdrRateCache = { rate, ts: now };
      return rate;
    }
  } catch(e) { console.warn('[fx]', e.message); }
  return _usdIdrRateCache.rate || null;
}

async function resolveDexPrice(symbol) {
  const lower = symbol.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(_dynDexCache, lower)) return _dynDexCache[lower];
  try {
    const r = await axios.get('https://api.dexscreener.com/latest/dex/search',
      { params: { q: symbol }, timeout: 7000 });
    const pairs = (r.data?.pairs || [])
      .filter(p => p.baseToken?.symbol?.toLowerCase() === lower && p.priceUsd)
      .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = pairs[0] || null;
    _dynDexCache[lower] = best
      ? { priceUsd: parseFloat(best.priceUsd), pair: best.baseToken.symbol + '/' + (best.quoteToken?.symbol || '?'),
          dex: best.dexId || 'dex', chain: best.chainId || '', imageUrl: best.info?.imageUrl || null }
      : null;
    return _dynDexCache[lower];
  } catch(e) {
    _dynDexCache[lower] = null;
    return null;
  }
}

async function resolveCoinId(symbol) {
  const lower = symbol.toLowerCase();
  if (COIN_ID_MAP[lower]) return COIN_ID_MAP[lower];
  if (Object.prototype.hasOwnProperty.call(_dynCoinId, lower)) return _dynCoinId[lower];
  try {
    const cgKey = process.env.COINGECKO_API_KEY || '';
    const h = { Accept: 'application/json' };
    if (cgKey) h['x-cg-demo-api-key'] = cgKey;
    const r = await axios.get('https://api.coingecko.com/api/v3/search',
      { params: { query: symbol }, headers: h, timeout: 7000 });
    const coins = r.data?.coins || [];
    const exact = coins.find(c => c.symbol?.toLowerCase() === lower);
    const match = exact || coins[0] || null;
    _dynCoinId[lower] = match ? match.id : null;
    return _dynCoinId[lower];
  } catch(e) {
    _dynCoinId[lower] = null;
    return null;
  }
}

function fmtMcap(n) {
  if (!n) return 'N/A';
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3)  return '$' + (n / 1e3).toFixed(2) + 'K';
  return '$' + n.toFixed(2);
}

function parseConvAmount(raw) {
  const s = raw.toLowerCase().replace(/,/g, '.');
  let mult = 1;
  let v = s;
  if (s.endsWith('k')) { mult = 1e3; v = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; v = s.slice(0, -1); }
  else if (s.endsWith('b')) { mult = 1e9; v = s.slice(0, -1); }
  return parseFloat(v) * mult;
}

async function handlePriceQuery(ctx, sym) {
  try {
    const cgKey = process.env.COINGECKO_API_KEY || '';
    const h = { Accept: 'application/json' };
    if (cgKey) h['x-cg-demo-api-key'] = cgKey;
    const lower = sym.toLowerCase();
    let coinId = COIN_ID_MAP[lower] || await resolveCoinId(lower);

    if (!coinId) {
      const dex = await resolveDexPrice(sym);
      if (dex) {
        const idr = await getUsdToIdrRate();
        const idrStr = idr ? ' | Rp ' + Math.round(dex.priceUsd * idr).toLocaleString('id-ID') : '';
        await ctx.reply(
          `📊 <b>${sym.toUpperCase()}</b> (via DexScreener)\n` +
          `💵 $${dex.priceUsd.toFixed(6)}${idrStr}\n` +
          `🔀 ${dex.dex} / ${dex.chain}`,
          { parse_mode: 'HTML' }
        );
      } else {
        await ctx.reply(`❌ Token <b>${sym.toUpperCase()}</b> tidak ditemukan.`, { parse_mode: 'HTML' });
      }
      return;
    }

    const r = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,idr,btc&include_24hr_change=true&include_market_cap=true&precision=8`,
      { headers: h, timeout: 8000 }
    );
    const d = r.data[coinId];
    if (!d) { await ctx.reply(`❌ Tidak ada data harga untuk ${sym.toUpperCase()}.`); return; }

    const pct24h = d.usd_24h_change?.toFixed(2);
    const pctEmoji = (!pct24h || parseFloat(pct24h) >= 0) ? '📈' : '📉';
    const pctStr = pct24h ? ` (${parseFloat(pct24h) >= 0 ? '+' : ''}${pct24h}%)` : '';
    const idrStr = d.idr ? `\n🇮🇩 Rp ${Math.round(d.idr).toLocaleString('id-ID')}` : '';
    const mcapStr = d.usd_market_cap ? `\n💰 Market Cap: ${fmtMcap(d.usd_market_cap)}` : '';
    const btcStr = d.btc ? `\n₿ ${d.btc.toFixed(8)} BTC` : '';

    const priceUsd = d.usd;
    const priceFormatted = priceUsd >= 1
      ? '$' + priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
      : '$' + priceUsd.toPrecision(4);

    await ctx.reply(
      `${pctEmoji} <b>${sym.toUpperCase()}</b>${pctStr}\n` +
      `💵 ${priceFormatted}${idrStr}${btcStr}${mcapStr}\n` +
      `<i>via CoinGecko</i>`,
      { parse_mode: 'HTML' }
    );
  } catch(e) {
    await ctx.reply(`❌ Gagal ambil harga ${sym.toUpperCase()}: ${e.message}`);
  }
}

async function handleConversion(ctx, rawAmt, fromSym, toSym) {
  try {
    const amount = parseConvAmount(rawAmt);
    if (isNaN(amount) || amount <= 0) { await ctx.reply('❌ Jumlah tidak valid.'); return; }

    const lower = fromSym.toLowerCase();
    const toLower = toSym.toLowerCase();
    let coinId = COIN_ID_MAP[lower] || await resolveCoinId(lower);

    let priceUsd;
    if (!coinId) {
      const dex = await resolveDexPrice(fromSym);
      if (!dex) { await ctx.reply(`❌ Token **${fromSym.toUpperCase()}** tidak ditemukan.`); return; }
      priceUsd = dex.priceUsd;
    } else {
      const cgKey = process.env.COINGECKO_API_KEY || '';
      const h = { Accept: 'application/json' };
      if (cgKey) h['x-cg-demo-api-key'] = cgKey;
      const r = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,idr,btc&precision=8`,
        { headers: h, timeout: 8000 }
      );
      priceUsd = r.data[coinId]?.usd;
    }

    if (!priceUsd) { await ctx.reply('❌ Gagal mendapatkan harga.'); return; }

    let resultStr;
    if (SUPPORTED_VS.has(toLower)) {
      if (toLower === 'idr') {
        const idr = await getUsdToIdrRate();
        const val = amount * priceUsd * (idr || 1);
        resultStr = 'Rp ' + Math.round(val).toLocaleString('id-ID');
      } else if (toLower === 'usd') {
        const val = amount * priceUsd;
        resultStr = '$' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
      } else if (toLower === 'btc') {
        const r2 = await axios.get(
          'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&precision=8',
          { timeout: 6000 }
        );
        const btcUsd = r2.data?.bitcoin?.usd || 1;
        resultStr = (amount * priceUsd / btcUsd).toFixed(8) + ' BTC';
      } else {
        resultStr = (amount * priceUsd).toFixed(6) + ' ' + toSym.toUpperCase();
      }
    } else {
      // Token-to-token
      const toCoinId = COIN_ID_MAP[toLower] || await resolveCoinId(toLower);
      if (!toCoinId) { await ctx.reply(`❌ Token tujuan ${toSym.toUpperCase()} tidak ditemukan.`); return; }
      const cgKey = process.env.COINGECKO_API_KEY || '';
      const h = { Accept: 'application/json' };
      if (cgKey) h['x-cg-demo-api-key'] = cgKey;
      const r2 = await axios.get(
        `https://api.coingecko.com/api/v3/simple/price?ids=${toCoinId}&vs_currencies=usd&precision=8`,
        { headers: h, timeout: 8000 }
      );
      const toUsd = r2.data[toCoinId]?.usd;
      if (!toUsd) { await ctx.reply('❌ Gagal konversi.'); return; }
      const converted = (amount * priceUsd) / toUsd;
      resultStr = converted.toFixed(6) + ' ' + toSym.toUpperCase();
    }

    await ctx.reply(
      `💱 <b>${amount.toLocaleString()} ${fromSym.toUpperCase()} = ${resultStr}</b>`,
      { parse_mode: 'HTML' }
    );
  } catch(e) {
    await ctx.reply('❌ Konversi gagal: ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CRYPTORANK (port dari bot.js — fungsi-fungsi sudah return text string)
// ─────────────────────────────────────────────────────────────────────────────

const _crCache = { currencies: null, cachedAt: 0 };
const CR_CACHE_TTL = 5 * 60 * 1000;

async function crFetchCurrencies() {
  const now = Date.now();
  if (_crCache.currencies && now - _crCache.cachedAt < CR_CACHE_TTL) return _crCache.currencies;
  const key = process.env.CRYPTORANK_API_KEY;
  if (!key) throw new Error('CRYPTORANK_API_KEY belum diset.');
  const r = await axios.get('https://api.cryptorank.io/v1/currencies',
    { params: { api_key: key, limit: 500 }, timeout: 12000 });
  _crCache.currencies = r.data?.data || [];
  _crCache.cachedAt = now;
  return _crCache.currencies;
}

function crFmt(n) {
  if (n == null) return 'N/A';
  if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (Math.abs(n) >= 1)   return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  if (/^losers$/i.test(text))  return { type: 'losers' };
  if (/^market$/i.test(text))  return { type: 'market' };
  return null;
}

async function handleCrCommand(type, symbol) {
  const coins = type !== 'market' ? await crFetchCurrencies() : null;

  if (type === 'token') {
    const coin = coins.find(c => c.symbol?.toUpperCase() === symbol) ||
                 coins.find(c => c.slug?.toLowerCase() === symbol.toLowerCase());
    if (!coin) return `❌ Token **${symbol}** tidak ditemukan di CryptoRank.`;
    const v = coin.values?.USD || {};
    return [
      `📊 **${coin.name} (${coin.symbol})** — Rank #${coin.rank}`,
      `💵 Harga    : **${crFmt(v.price)}**`,
      `📈 24h      : ${crPct(v.percentChange24h)}`,
      `📅 7d       : ${crPct(v.percentChange7d)}`,
      `📅 30d      : ${crPct(v.percentChange30d)}`,
      `📅 3 bulan  : ${crPct(v.percentChange3m)}`,
      `📅 6 bulan  : ${crPct(v.percentChange6m)}`,
      `💰 Mkt Cap  : ${crFmt(v.marketCap)}`,
      `🔄 Vol 24h  : ${crFmt(v.volume24h)}`,
      `_(via CryptoRank)_`,
    ].join('\n');
  }

  if (type === 'gainers') {
    const top = [...coins]
      .filter(c => c.values?.USD?.percentChange24h != null && (c.values?.USD?.marketCap || 0) > 1e6)
      .sort((a, b) => b.values.USD.percentChange24h - a.values.USD.percentChange24h)
      .slice(0, 10);
    return '🚀 **Top 10 Gainers 24h** _(via CryptoRank)_\n\n' +
      top.map((c, i) => `${i + 1}. **${c.symbol}** ${crPct(c.values.USD.percentChange24h)} — ${crFmt(c.values.USD.price)}`).join('\n');
  }

  if (type === 'losers') {
    const top = [...coins]
      .filter(c => c.values?.USD?.percentChange24h != null && (c.values?.USD?.marketCap || 0) > 1e6)
      .sort((a, b) => a.values.USD.percentChange24h - b.values.USD.percentChange24h)
      .slice(0, 10);
    return '📉 **Top 10 Losers 24h** _(via CryptoRank)_\n\n' +
      top.map((c, i) => `${i + 1}. **${c.symbol}** ${crPct(c.values.USD.percentChange24h)} — ${crFmt(c.values.USD.price)}`).join('\n');
  }

  if (type === 'market') {
    const key = process.env.CRYPTORANK_API_KEY;
    if (!key) throw new Error('CRYPTORANK_API_KEY belum diset.');
    const r = await axios.get('https://api.cryptorank.io/v1/global',
      { params: { api_key: key }, timeout: 8000 });
    const d = r.data?.data || {};
    const v = d.values?.USD || {};
    return [
      '🌍 **Global Market Overview** _(via CryptoRank)_',
      `💰 Total Market Cap : **${crFmt(v.totalMarketCap)}**`,
      `🔄 Volume 24h       : ${crFmt(v.totalVolume24h)}`,
      `₿  BTC Dominance   : **${(d.btcDominance || 0).toFixed(2)}%**`,
      `Ξ  ETH Dominance   : **${(d.ethDominance || 0).toFixed(2)}%**`,
      `🪙 Active Coins     : ${(d.activeCurrencies || 0).toLocaleString()}`,
      `📊 Active Markets   : ${(d.activeMarkets || 0).toLocaleString()}`,
    ].join('\n');
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TWITTER HISTORY (port dari bot.js)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchTwitterHistory(usernames) {
  const mlToken = process.env.MEMORYLOL_TOKEN;

  async function _fetchOne(uname) {
    const url = 'https://api.memory.lol/v1/tw/' + encodeURIComponent(uname);
    try {
      const r = mlToken
        ? await axios.post(url, 'token=' + encodeURIComponent(mlToken),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 12000 })
        : await axios.get(url, { timeout: 10000 });
      return r.data?.accounts || [];
    } catch(_) { return []; }
  }

  async function _wayback(uname) {
    try {
      const r = await axios.get('https://web.archive.org/cdx/search/cdx', {
        params: { url: 'twitter.com/' + uname, output: 'json', fl: 'timestamp',
          filter: 'statuscode:200', limit: 1, from: '20060101' }, timeout: 7000 });
      const rows = r.data;
      if (Array.isArray(rows) && rows.length >= 2) {
        const ts = rows[1][0];
        return ts.slice(0,4) + '-' + ts.slice(4,6) + '-' + ts.slice(6,8);
      }
    } catch(_) {}
    return null;
  }

  const [accountsArr, wbDates] = await Promise.all([
    Promise.all(usernames.map(u => _fetchOne(u))),
    Promise.all(usernames.slice(0, 3).map(u => _wayback(u))),
  ]);

  const wbEarliest = {};
  usernames.slice(0, 3).forEach((u, i) => { if (wbDates[i]) wbEarliest[u.toLowerCase()] = wbDates[i]; });

  const seenIds = new Set();
  const accounts = [];
  for (const accs of accountsArr) {
    for (const acc of accs) {
      const id = acc.id_str || String(acc.id);
      if (!seenIds.has(id)) { seenIds.add(id); accounts.push(acc); }
    }
  }

  if (accounts.length === 0) {
    let msg = `❌ Tidak ada data history Twitter untuk **@${usernames.join(', @')}**\n_(tidak dikenal di memory.lol)_`;
    for (const [u, date] of Object.entries(wbEarliest))
      msg += `\n\n🗄️ **Wayback**: @${u} pertama diarsipkan ~**${date}**`;
    return [msg];
  }

  const header = `🐦 **Twitter/X Username History** — **@${usernames.join(', @')}**\n${mlToken ? '_(akses penuh)_' : '_(akses publik — 60 hari)_'}\n`;
  const blocks = [];

  for (const acc of accounts) {
    const accId = acc.id_str || String(acc.id);
    const screenNames = acc['screen_names'] || acc['screen-names'] || {};
    const entries = Object.keys(screenNames).map(sn => {
      const dates = screenNames[sn];
      if (!dates || (Array.isArray(dates) && dates.length === 0)) return { sn, label: '_(tanggal tidak diketahui)_' };
      if (Array.isArray(dates) && dates.length === 1) return { sn, label: 'terlihat: ' + dates[0] };
      if (Array.isArray(dates) && dates.length >= 2)
        return { sn, label: dates[0] + ' → ' + dates[dates.length - 1] };
      return { sn, label: String(dates) };
    });
    const nameList = entries.map(e => `  • **@${e.sn}** — ${e.label}`).join('\n');
    let block = `🆔 ID: ${accId}\n${nameList}`;
    for (const [u, date] of Object.entries(wbEarliest)) {
      if (Object.keys(screenNames).some(sn => sn.toLowerCase() === u))
        block += `\n  🗄️ Wayback: @${u} diarsipkan pertama ~**${date}**`;
    }
    blocks.push(block);
  }

  const messages = [];
  let cur = header + '\n';
  for (const block of blocks) {
    const add = block + '\n\n';
    if (cur.length + add.length > 3500) { messages.push(cur.trimEnd()); cur = add; }
    else { cur += add; }
  }
  if (cur.trim()) messages.push(cur.trimEnd());
  return messages.length ? messages : [header + '_(tidak ada data)_'];
}

// ─────────────────────────────────────────────────────────────────────────────
// OSINT SCAN (port dari bot.js — URLhaus, ThreatFox, URLscan)
// ─────────────────────────────────────────────────────────────────────────────

function detectOsintScan(text) {
  const m = text.match(/^scan\s+(.+)$/i);
  if (!m) return null;
  const clean = m[1].trim()
    .replace(/hxxps?/gi, s => s.replace(/hxxp/i, 'http'))
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

  if (type === 'url' || type === 'domain') {
    tasks.push(
      axios.post('https://urlhaus-api.abuse.ch/v1/url/',
        'url=' + encodeURIComponent(type === 'url' ? target : 'http://' + target),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 8000 }
      ).then(r => { results.urlhaus = r.data; }).catch(() => { results.urlhaus = { error: true }; })
    );
  }

  tasks.push(
    axios.post('https://threatfox-api.abuse.ch/api/v1/',
      { query: 'search_ioc', search_term: target },
      { headers: { 'Content-Type': 'application/json' }, timeout: 8000 }
    ).then(r => { results.threatfox = r.data; }).catch(() => { results.threatfox = { error: true }; })
  );

  const usQ = type === 'ip' ? `page.ip:"${target}"` : type === 'url' ? `page.url:"${target}"` : `page.domain:"${target}"`;
  tasks.push(
    axios.get('https://urlscan.io/api/v1/search/', { params: { q: usQ, size: 5 }, timeout: 8000 })
      .then(r => { results.urlscan = r.data; }).catch(() => { results.urlscan = { error: true }; })
  );

  if (type === 'ip' && process.env.ABUSEIPDB_API_KEY) {
    tasks.push(
      axios.get('https://api.abuseipdb.com/api/v2/check', {
        params: { ipAddress: target, maxAgeInDays: 90 },
        headers: { Key: process.env.ABUSEIPDB_API_KEY, Accept: 'application/json' }, timeout: 8000
      }).then(r => { results.abuseipdb = r.data; }).catch(() => { results.abuseipdb = { error: true }; })
    );
  }

  await Promise.all(tasks);

  let danger = 0;
  const lines = [];
  const typeEmoji = { url: '🔗', domain: '🌐', ip: '🖥️' }[type];
  lines.push(`${typeEmoji} **OSINT Scan — ${type.toUpperCase()}**\n\`${target}\`\n`);

  if (results.urlhaus && !results.urlhaus.error) {
    if (results.urlhaus.query_status === 'is_listed') {
      danger = Math.max(danger, 2);
      lines.push('🚨 **URLhaus:** Terdeteksi malware/phishing');
      if (results.urlhaus.threat) lines.push('   └ Threat: ' + results.urlhaus.threat);
    } else {
      lines.push('✅ **URLhaus:** Tidak ada di database malware');
    }
  }

  if (results.threatfox && !results.threatfox.error) {
    if (results.threatfox.query_status === 'ok' && results.threatfox.data?.length > 0) {
      danger = Math.max(danger, 2);
      const d = results.threatfox.data[0];
      lines.push('🚨 **ThreatFox:** IOC dikenal berbahaya!');
      if (d.malware_printable) lines.push('   └ Malware: ' + d.malware_printable);
    } else {
      lines.push('✅ **ThreatFox:** Tidak ada di database IOC');
    }
  }

  if (results.urlscan && !results.urlscan.error) {
    const total = results.urlscan.total || 0;
    if (total > 0) {
      const malicious = results.urlscan.results?.[0]?.verdicts?.overall?.malicious;
      if (malicious) { danger = Math.max(danger, 2); lines.push(`🚨 **URLscan.io:** Ditandai berbahaya (${total} scan)`); }
      else { lines.push(`✅ **URLscan.io:** ${total} scan, tidak ada flag bahaya`); }
    } else {
      lines.push('✅ **URLscan.io:** Belum pernah di-scan');
    }
  }

  if (results.abuseipdb?.data) {
    const score = results.abuseipdb.data.abuseConfidenceScore || 0;
    const icon = score >= 80 ? '🚨' : score >= 25 ? '⚠️' : '✅';
    lines.push(`${icon} **AbuseIPDB:** Score ${score}%`);
    if (results.abuseipdb.data.isp) lines.push('   └ ' + results.abuseipdb.data.isp);
  }

  const verdict = danger >= 2 ? '🚨 **BERBAHAYA**' : danger === 1 ? '⚠️ **MENCURIGAKAN**' : '✅ **BERSIH**';
  lines.push('\n🔍 Kesimpulan: ' + verdict);

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// ADDRESS DETECTION
// ─────────────────────────────────────────────────────────────────────────────

const EVM_CA_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_CA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isEvmAddress(s) { return EVM_CA_RE.test(s); }
function isSolAddress(s) { return SOL_CA_RE.test(s) && !EVM_CA_RE.test(s); }

// ─────────────────────────────────────────────────────────────────────────────
// COMMAND TEXT
// ─────────────────────────────────────────────────────────────────────────────

const COMMAND_TEXT = `📖 <b>CLIZA.AI — Daftar Command (Telegram)</b>

⚡ <b>Langsung ketik — tanpa prefix, tanpa tag!</b>

💰 <b>HARGA &amp; MARKET</b>
<pre>
price [COIN]           Harga kripto real-time
p [COIN]               Singkatan price
[jml] [COIN] to [COIN] Konversi (contoh: 5 ETH to USDT)
gainers                Top gainer hari ini
losers                 Top loser hari ini
market                 Overview market kripto
</pre>

📊 <b>CHART TEKNIKAL</b>
<pre>
c [simbol]             Chart 4h default
c [simbol] [tf]        Timeframe: 1m 5m 15m 30m 1h 2h 4h 6h 1d 1w
c ETH 1h 50            Custom candle count
Kripto: BTC ETH SOL   Saham IDX: BBCA TLKM
Forex: EURUSD GBPJPY  Komoditas: XAU XAG OIL
</pre>

📈 <b>CRYPTO DATA</b>
<pre>
cr [COIN]              Data CryptoRank
</pre>

🔍 <b>OSINT (owner only)</b>
<pre>
!ip &lt;address&gt;          IP Geolocation
!dns &lt;domain&gt;          DNS Lookup
!github &lt;username&gt;     GitHub OSINT
!phone &lt;nomor&gt;         Phone OSINT
!geophoto              GPS EXIF dari foto (attach foto)
!geoip &lt;ip&gt;            Koordinat dari IP
!maps &lt;koordinat&gt;      Semua link maps
!timezone &lt;lokasi&gt;     Timezone dari kota/negara
</pre>

🔍 <b>OSINT (semua user)</b>
<pre>
scan &lt;url|domain|ip&gt;   Safety check
sherlock &lt;username&gt;    Cari akun sosmed
recon &lt;domain&gt;         Recon domain
whois &lt;domain&gt;         Info registrar
leak &lt;email&gt;           Cek infostealer
</pre>

🔑 <b>TOKEN ANALYSIS</b>
<pre>
[CA EVM/SOL]           Paste address → auto analisis scam
scan &lt;CA&gt;              Scam analysis via command
</pre>

💧 <b>LP ANALYSIS</b>
<pre>
lp &lt;CA&gt; [modal] [range%]      Analisa Liquidity Pool
lp pnl &lt;CA&gt; &lt;entry&gt; &lt;modal&gt;  P&amp;L LP dengan detail
lp rebalance &lt;CA&gt;             Saran range optimal
lp pos &lt;wallet&gt;               Posisi LP aktif
</pre>

💼 <b>PORTFOLIO &amp; TWITTER</b>
<pre>
balance [0x.../ENS]    Portfolio wallet via Zerion
twit [username]        Riwayat username Twitter/X
</pre>

🔬 <b>TOKEN SCANNER (semua user)</b>
<pre>
!base &lt;CA&gt;             Base Network token scanner
!sol &lt;CA&gt;              Solana token scanner (pump.fun)
</pre>

⚙️ <b>UTILITAS (owner only)</b>
<pre>
!balance               Saldo wallet bot
!provider              Status AI provider
!setkey [provider]     Set AI provider utama
!ai off                Matikan AI di grup ini (tag pun tidak direspons)
!ai on                 Nyalakan kembali AI di grup ini
!clearhistory          Hapus riwayat AI
</pre>

💬 <b>AI CHAT</b>
• DM ke bot (owner): langsung balas semua pesan
• Grup: tag/mention bot → <code>@BotName pertanyaanmu</code>
• Command tidak perlu tag, cukup ketik langsung`;

// ─────────────────────────────────────────────────────────────────────────────
// MAIN MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

bot.on('message', async (ctx) => {
  try {
    if (ctx.from?.is_bot) return;

    // Strip @mention dari awal teks — command jalan tanpa perlu tag
    // mis. "@M_B_GBOT c eth 1d" → "c eth 1d"
    // wasMentioned = true → trigger AI di grup
    let text = (ctx.message.text || ctx.message.caption || '').trim();
    let wasMentioned = false;
    if (BOT_USERNAME) {
      const prefix = '@' + BOT_USERNAME;
      if (text.toLowerCase().startsWith(prefix.toLowerCase())) {
        wasMentioned = true;
        text = text.slice(prefix.length).trim();
      }
    }
    // Di DM selalu dianggap "mention"
    if (isDM(ctx)) wasMentioned = true;

    const fromId  = String(ctx.from.id);
    const chatId  = String(ctx.chat.id);
    const priv    = isDM(ctx);
    const owner   = isOwner(ctx);
    const rawLow  = text.toLowerCase();
    const words   = text.split(/\s+/);

    if (!text && !ctx.message.photo && !ctx.message.document && !ctx.message.voice) return;

    // ── /start & /command ──────────────────────────────────────────────────
    if (rawLow === '/start' || rawLow === '!command' || rawLow === '/command' || rawLow === '/help') {
      await ctx.reply(COMMAND_TEXT, { parse_mode: 'HTML' });
      return;
    }

    // ──────────────────────────────────────────────────────────────────────
    // OWNER-ONLY COMMANDS
    // ──────────────────────────────────────────────────────────────────────
    if (owner) {

      // !balance
      if (rawLow === '!balance') {
        await typing(ctx);
        try {
          const bal = await getBalance();
          await ctx.reply(
            `💰 <b>Saldo Wallet Bot</b>\n<pre>Alamat : ${bal.address}\nETH    : ${bal.eth} ETH\nUSDC   : ${bal.usdc} USDC</pre>\n🔗 <a href="https://basescan.org/address/${bal.address}">Basescan</a>`,
            { parse_mode: 'HTML' }
          );
        } catch(e) { await ctx.reply('❌ Gagal cek saldo: ' + e.message); }
        return;
      }

      // !provider
      if (rawLow === '!provider' || rawLow === '!providerstatus') {
        const st = getAgentStatus();
        const lines = ['⚙️ <b>Status AI Provider</b>\n'];
        (st.order || []).forEach((p, i) => lines.push(`${i+1}. <b>${p.toUpperCase()}</b> — ${st.keyCount?.[p] || 0} key`));
        await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
        return;
      }

      // !setkey <provider>
      if (rawLow.startsWith('!setkey ')) {
        const prov = words[1]?.toLowerCase();
        if (!prov) { await ctx.reply('❌ Format: !setkey <provider>'); return; }
        const st = getAgentStatus();
        let order = [...(st.order || [])];
        if (!order.includes(prov)) order.push(prov);
        order = [prov, ...order.filter(p => p !== prov)];
        setAgentOrder(order);
        await store.saveKey('provider_order', order).catch(() => {});
        await ctx.reply(`✅ Provider utama → <b>${prov.toUpperCase()}</b>\nUrutan: <code>${order.join(' → ')}</code>`, { parse_mode: 'HTML' });
        return;
      }

      // !ai on / !ai off — owner only
      // Di DM: toggle global. Di grup: hapus/tambah ke denylist
      // Default grup: AI aktif saat bot di-tag; !ai off menonaktifkan sepenuhnya
      if (rawLow === '!ai on') {
        if (priv) {
          aiGlobalOff = false;
          saveAiState();
          await ctx.reply('🔊 AI dinyalakan secara global.');
        } else {
          aiDisabled.delete('ch:' + chatId);
          saveAiState();
          await ctx.reply('🔊 AI dinyalakan untuk grup ini.\nTag bot (@' + BOT_USERNAME + ' ...) untuk mengobrol dengan AI.');
        }
        return;
      }
      if (rawLow === '!ai off') {
        if (priv) {
          aiGlobalOff = true;
          saveAiState();
          await ctx.reply('🔇 AI dimatikan secara global.');
        } else {
          aiDisabled.add('ch:' + chatId);
          saveAiState();
          await ctx.reply('🔇 AI dimatikan untuk grup ini (tag bot pun tidak akan direspons).');
        }
        return;
      }

      // !clearhistory
      if (rawLow === '!clearhistory') {
        clearHistory(fromId);
        await ctx.reply('🗑️ Riwayat chat AI dihapus.');
        return;
      }

      // !ip
      if (/^!ip\s+\S+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupIP(words[1])); }
        catch(e) { await ctx.reply('❌ IP lookup gagal: ' + e.message); }
        return;
      }

      // !dns
      if (/^!dns\s+\S+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupDNS(words[1])); }
        catch(e) { await ctx.reply('❌ DNS lookup gagal: ' + e.message); }
        return;
      }

      // !github
      if (/^!github\s+\S+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupGitHub(words[1])); }
        catch(e) { await ctx.reply('❌ GitHub lookup gagal: ' + e.message); }
        return;
      }

      // !phone
      if (/^!phone\s+\S+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupPhone(words[1])); }
        catch(e) { await ctx.reply('❌ Phone lookup gagal: ' + e.message); }
        return;
      }

      // !geophoto (foto di-attach bersama command)
      if (/^!geophoto/i.test(text)) {
        const photo = ctx.message.photo || (ctx.message.document ? [ctx.message.document] : null);
        if (!photo) { await ctx.reply('📸 Lampirkan foto bersama command !geophoto'); return; }
        await typing(ctx);
        try {
          const fileId = ctx.message.photo
            ? ctx.message.photo[ctx.message.photo.length - 1].file_id
            : ctx.message.document.file_id;
          const fileLink = await ctx.telegram.getFileLink(fileId);
          const result = await analyzePhotoFromURL(fileLink.href);
          await sendLong(ctx, result);
        } catch(e) { await ctx.reply('❌ Gagal baca GPS foto: ' + e.message); }
        return;
      }

      // !geoip
      if (/^!geoip\s+\S+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupGeoIP(words[1])); }
        catch(e) { await ctx.reply('❌ GeoIP gagal: ' + e.message); }
        return;
      }

      // !maps
      if (/^!maps\s+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupMaps(text.slice(text.indexOf(' ') + 1).trim())); }
        catch(e) { await ctx.reply('❌ Maps gagal: ' + e.message); }
        return;
      }

      // !timezone
      if (/^!timezone\s+/i.test(text)) {
        await typing(ctx);
        try { await sendLong(ctx, await lookupTimezone(text.slice(text.indexOf(' ') + 1).trim())); }
        catch(e) { await ctx.reply('❌ Timezone gagal: ' + e.message); }
        return;
      }

    }

    // ──────────────────────────────────────────────────────────────────────
    // PUBLIC COMMANDS (semua user, grup + DM)
    // ──────────────────────────────────────────────────────────────────────

    // ── Chart: c [simbol] [tf] [N] ─────────────────────────────────────────
    const chartMatch = text.match(/^c\s+([a-zA-Z0-9]+(?:\.[jJ][kK])?)(?:\s+(1m|5m|15m|30m|1h|2h|4h|6h|1d|1w))?(?:\s+(\d+))?$/i);
    if (chartMatch) {
      await ctx.sendChatAction('upload_photo').catch(() => {});
      const adapter = makeTgAdapter(ctx);
      try { await handleChartCommand(adapter, chartMatch[1], chartMatch[2] || '4h', chartMatch[3]); }
      catch(e) { await ctx.reply('⚠️ Gagal buat chart: ' + e.message); }
      return;
    }

    // ── Price ──────────────────────────────────────────────────────────────
    if (/^(?:price|p)\s+\S+/i.test(text)) {
      await typing(ctx);
      await handlePriceQuery(ctx, words.slice(1).join(' '));
      return;
    }

    // ── CryptoRank (cr, gainers, losers, market) ───────────────────────────
    const crQ = detectCrQuery(text);
    if (crQ) {
      await typing(ctx);
      try {
        const result = await handleCrCommand(crQ.type, crQ.symbol);
        if (result) await sendLong(ctx, result);
      } catch(e) { await ctx.reply('❌ CryptoRank error: ' + e.message); }
      return;
    }

    // ── LP Analysis ────────────────────────────────────────────────────────
    const lpQ = detectLpQuery(text);
    if (lpQ) {
      await typing(ctx);
      try { await sendLong(ctx, await handleLpCommand(lpQ)); }
      catch(e) { await ctx.reply('❌ LP error: ' + e.message); }
      return;
    }

    // ── GMGN ───────────────────────────────────────────────────────────────
    const gmgnQ = detectGmgnQuery(text);
    if (gmgnQ) {
      await typing(ctx);
      try { await sendLong(ctx, await handleGmgnCommand(gmgnQ)); }
      catch(e) { await ctx.reply('❌ GMGN error: ' + e.message); }
      return;
    }

    // ── Read contract ──────────────────────────────────────────────────────
    const readQ = detectReadContractQuery(text);
    if (readQ) {
      await typing(ctx);
      try { await sendLong(ctx, await handleReadContractCommand(readQ)); }
      catch(e) { await ctx.reply('❌ Read contract error: ' + e.message); }
      return;
    }

    // ── Balance / portfolio ────────────────────────────────────────────────
    const balQ = detectBalanceQuery(text);
    if (balQ) {
      await typing(ctx);
      try { await sendLong(ctx, await fetchZerionPortfolio(balQ)); }
      catch(e) { await ctx.reply('❌ Gagal ambil portfolio: ' + e.message); }
      return;
    }

    // ── Sherlock ───────────────────────────────────────────────────────────
    if (/^sherlock\s+\S+/i.test(text)) {
      await typing(ctx);
      try { await sendLong(ctx, await searchUsername(words[1])); }
      catch(e) { await ctx.reply('❌ Sherlock error: ' + e.message); }
      return;
    }

    // ── Twitter / Twit ─────────────────────────────────────────────────────
    if (/^twit\s+\S+/i.test(text)) {
      await typing(ctx);
      try {
        const usernames = words.slice(1).join('').split(',').map(u => u.trim()).filter(Boolean);
        const msgs = await fetchTwitterHistory(usernames);
        for (const m of msgs) await sendLong(ctx, m);
      } catch(e) { await ctx.reply('❌ Twit error: ' + e.message); }
      return;
    }

    // ── OSINT Scan (URL/domain/IP safety) ─────────────────────────────────
    const osintQ = detectOsintScan(text);
    if (osintQ && !isScamAnalysisRequest(text)) {
      await typing(ctx);
      try { await sendLong(ctx, await runOsintScan(osintQ.target, osintQ.type)); }
      catch(e) { await ctx.reply('❌ OSINT scan error: ' + e.message); }
      return;
    }

    // ── scan + token CA / isScamAnalysis ──────────────────────────────────
    if (/^scan\s+\S+/i.test(text) && isScamAnalysisRequest(text)) {
      await typing(ctx);
      try {
        const { fullPrompt } = await runScamAnalysis(text);
        if (fullPrompt) {
          const { text: aiResult } = await askAI(fullPrompt, [], true);
          await sendLong(ctx, aiResult);
        }
      } catch(e) { await ctx.reply('❌ Scam analysis error: ' + e.message); }
      return;
    }

    // ── recon ──────────────────────────────────────────────────────────────
    if (/^recon\s+\S+/i.test(text)) {
      await typing(ctx);
      try {
        const { runRecon } = require('./lib/osintExtra');
        await sendLong(ctx, await runRecon(words[1]));
      } catch(e) { await ctx.reply('❌ Recon gagal: ' + e.message); }
      return;
    }

    // ── whois ──────────────────────────────────────────────────────────────
    if (/^whois\s+\S+/i.test(text)) {
      await typing(ctx);
      try {
        const { runWhois } = require('./lib/osintExtra');
        await sendLong(ctx, await runWhois(words[1]));
      } catch(e) { await ctx.reply('❌ Whois gagal: ' + e.message); }
      return;
    }

    // ── leak ───────────────────────────────────────────────────────────────
    if (/^leak\s+\S+@\S+/i.test(text)) {
      await typing(ctx);
      try {
        const { runLeakCheck } = require('./lib/osintExtra');
        await sendLong(ctx, await runLeakCheck(words[1]));
      } catch(e) { await ctx.reply('❌ Leak check gagal: ' + e.message); }
      return;
    }

    // ── ports ──────────────────────────────────────────────────────────────
    if (/^ports\s+\d{1,3}(\.\d{1,3}){3}$/i.test(text)) {
      await typing(ctx);
      try {
        const { runPorts } = require('./lib/osintExtra');
        await sendLong(ctx, await runPorts(words[1]));
      } catch(e) { await ctx.reply('❌ Ports scan gagal: ' + e.message); }
      return;
    }

    // ── endpoints ──────────────────────────────────────────────────────────
    if (/^endpoints\s+https?:\/\//i.test(text)) {
      await typing(ctx);
      try { await sendLong(ctx, await runEndpoints(words[1])); }
      catch(e) { await ctx.reply('❌ Endpoint scan gagal: ' + e.message); }
      return;
    }

    // ── !base <CA> — Base Network token scanner (semua user) ──────────────
    if (/^!base\s+0x[0-9a-fA-F]{40}/i.test(text)) {
      const caMatch = text.match(/0x[0-9a-fA-F]{40}/i);
      if (caMatch) {
        await ctx.sendChatAction('typing').catch(() => {});
        try {
          const { runBaseScanner } = require('./lib/baseScanner');
          const result = await runBaseScanner(caMatch[0]);
          await sendLong(ctx, result);
        } catch(e) { await ctx.reply('❌ Gagal scan token Base: ' + e.message); }
        return;
      }
    }

    // ── !sol <CA> — Solana token scanner (semua user) ──────────────────────
    if (/^!sol\s+[1-9A-HJ-NP-Za-km-z]{32,44}/i.test(text)) {
      const solMatch = text.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/);
      if (solMatch) {
        await ctx.sendChatAction('typing').catch(() => {});
        try {
          const { runSolScanner } = require('./lib/solScanner');
          const result = await runSolScanner(solMatch[0]);
          await sendLong(ctx, result);
        } catch(e) { await ctx.reply('❌ Gagal scan token SOL: ' + e.message); }
        return;
      }
    }

    // ── Paste CA (EVM/SOL) → auto token scam analysis ─────────────────────
    if (words.length === 1 && (isEvmAddress(words[0]) || isSolAddress(words[0]))) {
      await typing(ctx);
      try {
        if (isScamAnalysisRequest(words[0])) {
          const { fullPrompt } = await runScamAnalysis(words[0]);
          if (fullPrompt) {
            const { text: aiResult } = await askAI(fullPrompt, [], true);
            await sendLong(ctx, aiResult);
          }
        }
      } catch(e) { await ctx.reply('❌ Token analysis error: ' + e.message); }
      return;
    }

    // ── Konversi: "5 ETH to USDT" ─────────────────────────────────────────
    const convMatch = text.match(/^([\d.,]+[kmb]?)\s+([a-zA-Z]+)\s+(?:to|ke)\s+([a-zA-Z]+)$/i);
    if (convMatch) {
      await typing(ctx);
      await handleConversion(ctx, convMatch[1], convMatch[2], convMatch[3]);
      return;
    }

    // ──────────────────────────────────────────────────────────────────────
    // AI CHAT
    //   • DM + owner  : selalu aktif (kecuali !ai off global)
    //   • Grup        : HANYA saat bot di-tag/mention (@BotName ...)
    //                   + grup tidak di-disable (!ai off)
    // ──────────────────────────────────────────────────────────────────────
    const aiDisabledHere = aiGlobalOff || aiDisabled.has('ch:' + chatId);
    const aiEnabledHere  = !aiDisabledHere && wasMentioned && (priv ? owner : true);

    if (aiEnabledHere) {
      if (!text) return; // mention tanpa teks (misal hanya foto) — skip
      await typing(ctx);
      // History per-user di DM, per-grup di grup
      const histKey = priv ? fromId : 'grp:' + chatId;
      const history = getHistory(histKey);
      try {
        const { text: aiReply } = await askAI(text, history, true);
        addToHistory(histKey, 'user', text);
        addToHistory(histKey, 'assistant', aiReply);
        await sendLong(ctx, aiReply);
      } catch(e) { await ctx.reply('❌ AI error: ' + e.message); }
      return;
    }

    // ── Tidak ada command yang cocok → diam
    // Command jalan tanpa tag; AI hanya saat di-tag

  } catch(e) {
    console.error('[tgbot] handler error:', e);
    try { await ctx.reply('❌ Error internal: ' + e.message); } catch(_) {}
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// LAUNCH
// ─────────────────────────────────────────────────────────────────────────────

console.log('[tgbot] Starting Telegram bot...');
console.log('[tgbot] Owner ID:', OWNER_ID);

async function launchBot(attempt = 1) {
  try {
    // Hapus webhook & drop pending updates sebelum polling
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch({ allowedUpdates: ['message', 'callback_query'] });
    console.log('[tgbot] ✅ Bot berjalan!');
  } catch(e) {
    console.error(`[tgbot] Gagal start (attempt ${attempt}):`, e.message);
    if (e.message && e.message.includes('409') && attempt < 5) {
      // Telegram long-poll timeout = 30s → tunggu 35s agar sesi lama pasti mati
      const delay = 35000;
      console.log(`[tgbot] Sesi lama masih aktif, retry dalam ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
      return launchBot(attempt + 1);
    }
    process.exit(1);
  }
}

launchBot();

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
