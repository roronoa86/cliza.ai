// lib/osintExtra.js
// OSINT commands: !ip, !dns, !github, !archive, !phone
// Semua gratis, tanpa API key, Node.js murni + axios.

'use strict';

const axios = require('axios');

const AX = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; BP-AI-Bot/1.0)',
    'Accept': 'application/json',
  },
});

// ─────────────────────────────────────────────
// !ip <address> — Geolocation, ISP, ASN
// ─────────────────────────────────────────────
async function lookupIP(ip) {
  const clean = ip.trim().replace(/^https?:\/\//i, '').split('/')[0];

  // ip-api.com: gratis, no key, 45 req/menit
  const { data } = await AX.get(
    `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,proxy,hosting,mobile,query`
  );

  if (data.status !== 'success') {
    return `❌ IP tidak valid atau tidak ditemukan: \`${clean}\``;
  }

  const flag = countryFlag(data.countryCode);
  const tags = [];
  if (data.proxy)   tags.push('🔴 Proxy/VPN');
  if (data.hosting) tags.push('🟠 Hosting/Datacenter');
  if (data.mobile)  tags.push('📱 Mobile');
  if (!tags.length) tags.push('🟢 Residential');

  return [
    `🌐 **IP Lookup — \`${data.query}\`**`,
    ``,
    `${flag} **Lokasi**`,
    `> ${[data.city, data.regionName, data.country].filter(Boolean).join(', ')}`,
    `> Koordinat: \`${data.lat}, ${data.lon}\` | Timezone: \`${data.timezone}\``,
    `> ZIP: \`${data.zip || '-'}\``,
    ``,
    `🏢 **Jaringan**`,
    `> ISP: \`${data.isp}\``,
    `> Org: \`${data.org || '-'}\``,
    `> ASN: \`${data.as}\` (${data.asname || '-'})`,
    ``,
    `🔍 **Tipe**: ${tags.join(' · ')}`,
    ``,
    `🔗 [VirusTotal](https://www.virustotal.com/gui/ip-address/${data.query}) · [Shodan](https://www.shodan.io/host/${data.query}) · [AbuseIPDB](https://www.abuseipdb.com/check/${data.query})`,
  ].join('\n');
}

// ─────────────────────────────────────────────
// !dns <domain> — DNS records lengkap
// ─────────────────────────────────────────────
const DNS_TYPES = [
  { type: 'A',     num: 1,   label: 'A (IPv4)' },
  { type: 'AAAA',  num: 28,  label: 'AAAA (IPv6)' },
  { type: 'MX',    num: 15,  label: 'MX (Mail)' },
  { type: 'NS',    num: 2,   label: 'NS (Nameserver)' },
  { type: 'TXT',   num: 16,  label: 'TXT' },
  { type: 'CNAME', num: 5,   label: 'CNAME' },
  { type: 'SOA',   num: 6,   label: 'SOA' },
];

async function lookupDNS(domain) {
  const clean = domain.trim().replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();

  const results = await Promise.all(
    DNS_TYPES.map(async ({ num, label }) => {
      try {
        const { data } = await AX.get(
          `https://dns.google/resolve?name=${encodeURIComponent(clean)}&type=${num}`
        );
        if (!data.Answer?.length) return { label, records: [] };
        return {
          label,
          records: data.Answer.map(r => r.data),
        };
      } catch {
        return { label, records: [] };
      }
    })
  );

  const lines = [`🔍 **DNS Lookup — \`${clean}\`**`, ``];
  let found = 0;
  for (const { label, records } of results) {
    if (!records.length) continue;
    found++;
    lines.push(`**${label}**`);
    for (const r of records.slice(0, 5)) {
      // TXT bisa panjang, potong
      const val = r.length > 200 ? r.slice(0, 197) + '…' : r;
      lines.push(`> \`${val}\``);
    }
    lines.push('');
  }

  if (!found) {
    lines.push('❌ Tidak ada record DNS ditemukan untuk domain ini.');
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// !github <username> — GitHub OSINT
// ─────────────────────────────────────────────
async function lookupGitHub(username) {
  const clean = username.trim().replace(/^@/, '');

  // Fetch user + repos paralel
  const [userRes, reposRes] = await Promise.allSettled([
    AX.get(`https://api.github.com/users/${encodeURIComponent(clean)}`, {
      headers: { 'User-Agent': 'BP-AI-Bot', Accept: 'application/vnd.github.v3+json' },
    }),
    AX.get(`https://api.github.com/users/${encodeURIComponent(clean)}/repos?sort=updated&per_page=5`, {
      headers: { 'User-Agent': 'BP-AI-Bot', Accept: 'application/vnd.github.v3+json' },
    }),
  ]);

  if (userRes.status === 'rejected' || userRes.value?.data?.message === 'Not Found') {
    return `❌ GitHub user \`${clean}\` tidak ditemukan.`;
  }

  const u = userRes.value.data;
  const repos = reposRes.status === 'fulfilled' ? reposRes.value.data : [];

  const joined = u.created_at ? new Date(u.created_at).toLocaleDateString('id-ID', { year: 'numeric', month: 'long', day: 'numeric' }) : '-';
  const updated = u.updated_at ? new Date(u.updated_at).toLocaleDateString('id-ID', { year: 'numeric', month: 'long' }) : '-';

  const lines = [
    `👨‍💻 **GitHub OSINT — [@${u.login}](${u.html_url})**`,
    ``,
  ];

  if (u.name)    lines.push(`> **Nama**: ${u.name}`);
  if (u.bio)     lines.push(`> **Bio**: ${u.bio.slice(0, 150)}`);
  if (u.company) lines.push(`> **Perusahaan**: ${u.company}`);
  if (u.location)lines.push(`> **Lokasi**: ${u.location}`);
  if (u.email)   lines.push(`> **Email**: \`${u.email}\``);
  if (u.blog)    lines.push(`> **Website**: ${u.blog}`);
  if (u.twitter_username) lines.push(`> **Twitter**: [@${u.twitter_username}](https://twitter.com/${u.twitter_username})`);

  lines.push('');
  lines.push(`📊 **Statistik**`);
  lines.push(`> Repos: \`${u.public_repos}\` | Gists: \`${u.public_gists}\``);
  lines.push(`> Followers: \`${u.followers}\` | Following: \`${u.following}\``);
  lines.push(`> Bergabung: ${joined} | Update: ${updated}`);

  if (repos.length) {
    lines.push('');
    lines.push(`📁 **5 Repo Terbaru**`);
    for (const r of repos) {
      const star = r.stargazers_count ? ` ⭐${r.stargazers_count}` : '';
      const lang = r.language ? ` · ${r.language}` : '';
      lines.push(`> [${r.name}](${r.html_url})${star}${lang}`);
    }
  }

  lines.push('');
  lines.push(`🔗 [Profil GitHub](${u.html_url})`);

  return lines.join('\n');
}


// ─────────────────────────────────────────────
// !phone <number> — Phone OSINT (free, no key)
// ─────────────────────────────────────────────

// Prefix → { country, flag, type hint }
const PHONE_PREFIXES = [
  // Indonesia
  { prefix: '+62', country: 'Indonesia', flag: '🇮🇩', carriers: {
    '811':'Telkomsel','812':'Telkomsel','813':'Telkomsel','821':'Telkomsel','822':'Telkomsel','823':'Telkomsel','852':'Telkomsel','853':'Telkomsel',
    '814':'Indosat','815':'Indosat','816':'Indosat','855':'Indosat','856':'Indosat','857':'Indosat','858':'Indosat',
    '817':'XL Axiata','818':'XL Axiata','819':'XL Axiata','859':'XL Axiata','877':'XL Axiata','878':'XL Axiata',
    '831':'AXIS','832':'AXIS','833':'AXIS','838':'AXIS',
    '881':'Smartfren','882':'Smartfren','883':'Smartfren','884':'Smartfren','885':'Smartfren','886':'Smartfren','887':'Smartfren','888':'Smartfren','889':'Smartfren',
    '895':'3 (Tri)','896':'3 (Tri)','897':'3 (Tri)','898':'3 (Tri)','899':'3 (Tri)',
  }},
  // Malaysia
  { prefix: '+60', country: 'Malaysia', flag: '🇲🇾', carriers: {} },
  // Singapore
  { prefix: '+65', country: 'Singapura', flag: '🇸🇬', carriers: {} },
  // Philippines
  { prefix: '+63', country: 'Filipina', flag: '🇵🇭', carriers: {} },
  // Thailand
  { prefix: '+66', country: 'Thailand', flag: '🇹🇭', carriers: {} },
  // Vietnam
  { prefix: '+84', country: 'Vietnam', flag: '🇻🇳', carriers: {} },
  // US / Canada
  { prefix: '+1', country: 'Amerika Serikat / Kanada', flag: '🇺🇸', carriers: {} },
  // UK
  { prefix: '+44', country: 'Inggris', flag: '🇬🇧', carriers: {} },
  // India
  { prefix: '+91', country: 'India', flag: '🇮🇳', carriers: {} },
  // Australia
  { prefix: '+61', country: 'Australia', flag: '🇦🇺', carriers: {} },
  // Jepang
  { prefix: '+81', country: 'Jepang', flag: '🇯🇵', carriers: {} },
  // Korea
  { prefix: '+82', country: 'Korea Selatan', flag: '🇰🇷', carriers: {} },
  // China
  { prefix: '+86', country: 'China', flag: '🇨🇳', carriers: {} },
  // Saudi
  { prefix: '+966', country: 'Arab Saudi', flag: '🇸🇦', carriers: {} },
  // UAE
  { prefix: '+971', country: 'Uni Emirat Arab', flag: '🇦🇪', carriers: {} },
  // Pakistan
  { prefix: '+92', country: 'Pakistan', flag: '🇵🇰', carriers: {} },
  // Bangladesh
  { prefix: '+880', country: 'Bangladesh', flag: '🇧🇩', carriers: {} },
  // Brazil
  { prefix: '+55', country: 'Brasil', flag: '🇧🇷', carriers: {} },
  // Russia
  { prefix: '+7', country: 'Rusia', flag: '🇷🇺', carriers: {} },
  // Germany
  { prefix: '+49', country: 'Jerman', flag: '🇩🇪', carriers: {} },
  // France
  { prefix: '+33', country: 'Prancis', flag: '🇫🇷', carriers: {} },
  // Netherlands
  { prefix: '+31', country: 'Belanda', flag: '🇳🇱', carriers: {} },
  // Turkey
  { prefix: '+90', country: 'Turki', flag: '🇹🇷', carriers: {} },
  // Nigeria
  { prefix: '+234', country: 'Nigeria', flag: '🇳🇬', carriers: {} },
  // Egypt
  { prefix: '+20', country: 'Mesir', flag: '🇪🇬', carriers: {} },
];

function normalizePhone(raw) {
  // Hilangkan spasi, tanda hubung, tanda kurung
  let num = raw.trim().replace(/[\s\-().]/g, '');
  // Ubah awalan 0 jadi +62 jika tidak ada country code (asumsi Indonesia)
  if (num.startsWith('08') || num.startsWith('8')) {
    if (num.startsWith('0')) num = '+62' + num.slice(1);
    else num = '+62' + num;
  }
  if (!num.startsWith('+')) num = '+' + num;
  return num;
}

function detectPhoneInfo(normalized) {
  // Coba cocokkan dari prefix terpanjang
  const sorted = [...PHONE_PREFIXES].sort((a, b) => b.prefix.length - a.prefix.length);
  for (const p of sorted) {
    if (normalized.startsWith(p.prefix)) {
      const local = normalized.slice(p.prefix.length);
      // Detect carrier (Indonesia only)
      let carrier = '-';
      if (Object.keys(p.carriers).length) {
        for (const [pfx, name] of Object.entries(p.carriers)) {
          if (local.startsWith(pfx)) { carrier = name; break; }
        }
      }
      return { country: p.country, flag: p.flag, carrier, local };
    }
  }
  return { country: 'Tidak dikenal', flag: '🌍', carrier: '-', local: normalized };
}

async function lookupPhone(rawNumber) {
  const normalized = normalizePhone(rawNumber);
  const { country, flag, carrier, local } = detectPhoneInfo(normalized);

  // Encode untuk link
  const encoded = encodeURIComponent(normalized);
  const digitsOnly = normalized.replace(/\D/g, '');

  // Google: cari jejak digital nomor ini
  const googleDork = `"${normalized}" OR "${digitsOnly}"`;
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(googleDork)}`;

  const lines = [
    `📞 **Phone OSINT — \`${normalized}\`**`,
    ``,
    `${flag} **Informasi Nomor**`,
    `> **Negara**: ${country}`,
    `> **Format Internasional**: \`${normalized}\``,
    `> **Nomor Lokal**: \`0${local}\``,
    `> **Carrier (estimasi)**: ${carrier}`,
    ``,
    `🔍 **Investigasi — klik untuk cek:**`,
    ``,
    `> 📖 [Truecaller](https://www.truecaller.com/search/id/${digitsOnly}) — Identitas & laporan spam`,
    `> 📱 [GetContact](https://www.getcontact.com/en/search#${digitsOnly}) — Nama kontak & tag`,
    `> 🔎 [NumLookup](https://www.numlookupapi.com/${digitsOnly}) — Carrier & validity`,
    `> 🌐 [Google Search](${googleUrl}) — Jejak digital nomor`,
    `> 📊 [Sync.me](https://sync.me/search/?number=${encoded}) — Social media terkait`,
    `> 🕵️ [SpyDialer](https://www.spydialer.com/default.aspx?pn=${digitsOnly}) — Voicemail lookup (US)`,
    ``,
    `⚠️ _Data carrier adalah estimasi dari prefix. Untuk hasil akurat klik link di atas._`,
  ];

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// Util: country code → flag emoji
// ─────────────────────────────────────────────
function countryFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  return String.fromCodePoint(
    ...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)
  );
}

// ─────────────────────────────────────────────
// recon endpoints <url> — Extract API endpoints
// Fetch HTML + JS files → regex → kategorikan
// ─────────────────────────────────────────────

// Pattern API/route yang menarik
const API_PATH_RE = /\/(api|v[0-9]+|graphql|gql|rest|auth|oauth|user|users|admin|data|json|ws|socket|rpc|webhook|internal|private|public|config|health|status|metrics|upload|download|search|query|token|refresh|login|logout|register|account|profile|payment|pay|order|cart|checkout|product|item|post|feed|notification|message|chat|stream)/i;

async function safeFetch(url) {
  try {
    const { data } = await AX.get(url, {
      timeout: 10000,
      maxContentLength: 3 * 1024 * 1024, // 3MB max
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch { return null; }
}

function extractUrlsFromContent(content, origin) {
  const abs = new Set();
  const rel = new Set();

  // Absolute URLs
  const absRe = /https?:\/\/[^\s"'<>`)\]\\,;{}]+/g;
  let m;
  while ((m = absRe.exec(content)) !== null) {
    abs.add(m[0].replace(/[.,:;!)}'"`\\]+$/, ''));
  }

  // Relative paths — minimal 2 segmen atau mengandung API pattern
  const relRe = /["'`](\/[a-zA-Z0-9_\-][a-zA-Z0-9_\-./]*(?:\?[^\s"'`<>]*)?)/g;
  while ((m = relRe.exec(content)) !== null) {
    const path = m[1];
    if (path.length > 1 && path.length < 120 && !path.includes('..')) {
      rel.add(path);
    }
  }

  return { abs, rel };
}

async function runEndpoints(rawUrl) {
  // Normalize
  let targetUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return '❌ URL tidak valid.'; }

  const origin = parsed.origin;
  const hostname = parsed.hostname;

  const lines = [];
  const p = s => lines.push(s);

  p(`🔌 **Endpoint Extractor — \`${hostname}\`**`);
  p(`> Target: <${targetUrl}>`);
  p('');

  // 1. Fetch halaman utama
  const html = await safeFetch(targetUrl);
  if (!html) {
    p('❌ Tidak bisa mengakses URL ini (timeout / blocked / HTTPS error)');
    return lines.join('\n');
  }

  // 2. Temukan script src
  const scriptSrcs = [];
  const scriptRe = /<script[^>]+src=["']([^"']+)["']/gi;
  let sm;
  while ((sm = scriptRe.exec(html)) !== null && scriptSrcs.length < 6) {
    const src = sm[1];
    if (src.includes('analytics') || src.includes('gtag') || src.includes('facebook')) continue;
    const full = src.startsWith('http') ? src
               : src.startsWith('//') ? 'https:' + src
               : origin + (src.startsWith('/') ? src : '/' + src);
    scriptSrcs.push(full);
  }

  // 3. Fetch semua JS secara paralel
  const jsContents = await Promise.all(scriptSrcs.map(safeFetch));
  const allSources = [html, ...jsContents.filter(Boolean)];

  // 4. Ekstrak semua URLs
  const absAll  = new Set();
  const relAll  = new Set();
  for (const src of allSources) {
    const { abs, rel } = extractUrlsFromContent(src, origin);
    abs.forEach(u => absAll.add(u));
    rel.forEach(p => relAll.add(p));
  }

  // 5. Kategorikan
  const apiEndpoints = new Set();
  const internalPaths = new Set();
  const externalDomains = new Set();

  for (const url of absAll) {
    try {
      const u = new URL(url);
      if (u.hostname === hostname || u.hostname.endsWith('.' + hostname)) {
        const path = u.pathname + (u.search || '');
        if (API_PATH_RE.test(path)) apiEndpoints.add(path);
        else internalPaths.add(path);
      } else {
        // Filter noise — skip CDN font/image/tracker umum
        if (!/fonts\.google|gstatic|cloudflare\.com\/cdn-cgi|google-analytics|googletagmanager|doubleclick|facebook\.net|twitter\.com\/i\/adsct/i.test(u.hostname)) {
          externalDomains.add(u.hostname);
        }
      }
    } catch {}
  }

  // Relative paths → tambahkan yang belum tercakup
  for (const path of relAll) {
    if (API_PATH_RE.test(path)) apiEndpoints.add(path);
    else if (path.split('/').length >= 3) internalPaths.add(path); // minimal 2 segmen
  }

  // 6. Format output
  const totalSources = allSources.length;
  const totalFound   = absAll.size + relAll.size;

  p(`📊 **Hasil Scan**`);
  p(`• Sumber dipindai : HTML + ${scriptSrcs.length} JS file`);
  p(`• Total URL/path  : ${totalFound}`);
  p('');

  if (scriptSrcs.length) {
    p(`**📦 JS Files yang Dipindai**`);
    scriptSrcs.forEach(s => {
      const short = s.replace(origin, '').slice(0, 80);
      p(`> \`${short || s.slice(0, 80)}\``);
    });
    p('');
  }

  // Helper: dump list ke code block, di-chunk per 30 baris
  // agar splitMessage tidak memotong di tengah code block Discord
  function dumpCodeBlocks(label, items) {
    if (!items.length) return;
    const CHUNK = 30;
    for (let i = 0; i < items.length; i += CHUNK) {
      const header = i === 0 ? label : `${label} _(lanjutan ${Math.floor(i/CHUNK)+1})_`;
      p(header);
      p('```');
      items.slice(i, i + CHUNK).forEach(ep => p(ep));
      p('```');
    }
  }

  if (apiEndpoints.size) {
    dumpCodeBlocks(`**🎯 API / Core Endpoints (${apiEndpoints.size} ditemukan)**`, [...apiEndpoints].sort());
  } else {
    p('_Tidak ada API endpoint eksplisit ditemukan (mungkin SPA dengan routing dinamis)_');
    p('');
  }

  if (internalPaths.size) {
    const sorted = [...internalPaths].filter(ep => ep !== '/' && ep.length > 1).sort();
    if (sorted.length) dumpCodeBlocks(`**📁 Internal Paths (${sorted.length})**`, sorted);
  }

  if (externalDomains.size) {
    const sorted = [...externalDomains].sort();
    p(`**🌐 External Domains (${sorted.length})**`);
    for (let i = 0; i < sorted.length; i += 30) {
      p(`> ${sorted.slice(i, i + 30).join(' · ')}`);
    }
    p('');
  }

  if (apiEndpoints.size === 0 && internalPaths.size === 0 && externalDomains.size === 0) {
    p('⚠️ Tidak ada data yang berhasil diekstrak — kemungkinan konten di-render client-side (React/Vue/Angular) atau site memblokir scraping.');
  }

  p(`_Sumber: ${totalSources} file · Tools: regex HTML+JS extractor_`);

  return lines.join('\n');
}

module.exports = { lookupIP, lookupDNS, lookupGitHub, lookupPhone, runEndpoints };
