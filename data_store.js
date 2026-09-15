// data_store.js — Persistent storage via GitHub Gist
// Data bertahan setelah Railway redeploy. Butuh env GITHUB_TOKEN.
const axios = require('axios');

const TOKEN = process.env.GITHUB_TOKEN;
const GIST_DESC = 'BP.AI Bot Data';
const GIST_FILE = 'bp_ai_data.json';

let _gistId = null;
let _cache = null;
let _cacheReady = null;
let _loadPromise = null;

// Debounce: tunda PATCH ke Gist sampai 3 detik setelah save terakhir
// Ini mencegah concurrent PATCH (403) saat banyak saveKey dipanggil berurutan
let _writeTimer = null;
let _writePromise = null;
let _writeResolvers = [];

const gh = TOKEN ? axios.create({
  baseURL: 'https://api.github.com',
  headers: {
    Authorization: 'token ' + TOKEN,
    Accept: 'application/vnd.github.v3+json',
    'User-Agent': 'BP.AI-Bot'
  },
  timeout: 15000
}) : null;

async function findOrCreate() {
  if (_gistId) return _gistId;
  if (!gh) throw new Error('GITHUB_TOKEN tidak di-set');
  const res = await gh.get('/gists?per_page=100');
  const found = (res.data || []).find(g => g.description === GIST_DESC);
  if (found) {
    _gistId = found.id;
    console.log('[store] Gist ditemukan:', _gistId);
    return _gistId;
  }
  const cr = await gh.post('/gists', {
    description: GIST_DESC,
    public: false,
    files: { [GIST_FILE]: { content: '{}' } }
  });
  _gistId = cr.data.id;
  console.log('[store] Gist baru dibuat:', _gistId);
  return _gistId;
}

async function loadAll() {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    if (!gh) {
      console.warn('[store] GITHUB_TOKEN tidak ada, skip Gist sync');
      _cache = {};
      return _cache;
    }
    try {
      const id = await findOrCreate();
      const res = await gh.get('/gists/' + id);
      const f = res.data.files && res.data.files[GIST_FILE];
      _cache = (f && f.content) ? JSON.parse(f.content) : {};
      const keys = Object.keys(_cache);
      console.log('[store] Data dimuat dari Gist. Keys:', keys.join(', ') || '(kosong)');
      // Log detail beberapa key penting
      if (_cache.watchlist)    console.log('[store] watchlist:', Array.isArray(_cache.watchlist.tokens) ? _cache.watchlist.tokens.length : 0, 'entry');
      if (_cache.watch_admins) console.log('[store] watch_admins:', (_cache.watch_admins.roles||[]).length, 'role,', (_cache.watch_admins.users||[]).length, 'user');
      if (_cache.ai_state)     console.log('[store] ai_state: globalOff=' + !!_cache.ai_state.globalOff + ', disabled=' + (Array.isArray(_cache.ai_state.disabled) ? _cache.ai_state.disabled.length : 0));
      if (_cache.ai_state_bot) console.log('[store] ai_state_bot: globalOff=' + !!_cache.ai_state_bot.globalOff + ', disabled=' + (Array.isArray(_cache.ai_state_bot.disabled) ? _cache.ai_state_bot.disabled.length : 0));
    } catch (e) {
      console.warn('[store] loadAll gagal:', e.message, '— mulai dengan cache kosong');
      _cache = {};
    }
    return _cache;
  })();
  _cacheReady = _loadPromise;
  return _loadPromise;
}

// _flushNow: langsung PATCH Gist dengan cache saat ini
// Dipanggil oleh debounce timer — tidak boleh dipanggil langsung dari luar
async function _flushNow() {
  const resolvers = _writeResolvers;
  _writeResolvers = [];
  _writeTimer = null;
  _writePromise = null;
  try {
    const id = await findOrCreate();
    await gh.patch('/gists/' + id, {
      files: { [GIST_FILE]: { content: JSON.stringify(_cache, null, 2) } }
    });
    resolvers.forEach(r => r.resolve());
  } catch (e) {
    const msg = e.response ? ('HTTP ' + e.response.status + ': ' + JSON.stringify(e.response.data).slice(0, 120)) : e.message;
    console.warn('[store] flush gagal:', msg);
    resolvers.forEach(r => r.reject(new Error(msg)));
  }
}

// saveKey: update cache langsung, tapi tunda PATCH ke Gist 3 detik
// Semua save yang datang dalam 3 detik digabung jadi 1 PATCH
async function saveKey(key, value) {
  if (!gh) return;

  // Tunggu cache siap
  if (_cacheReady) {
    await _cacheReady;
  } else {
    console.warn('[store] saveKey dipanggil sebelum loadAll() — inisialisasi otomatis');
    await loadAll();
  }

  // Update cache in-memory langsung
  _cache[key] = value;

  // Jadwalkan flush (debounce 3 detik)
  return new Promise((resolve, reject) => {
    _writeResolvers.push({ resolve, reject });
    if (_writeTimer) clearTimeout(_writeTimer);
    _writeTimer = setTimeout(() => _flushNow(), 3000);
  });
}

// loadKey: ambil satu key dari cache (memuat cache dulu kalau belum siap)
async function loadKey(key) {
  if (_cacheReady) {
    await _cacheReady;
  } else {
    await loadAll();
  }
  return _cache ? _cache[key] : undefined;
}

module.exports = { loadAll, saveKey, loadKey };
