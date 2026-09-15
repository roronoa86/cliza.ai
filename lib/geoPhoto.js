// lib/geoPhoto.js
// OSINT geo tools — pure Node.js, tanpa package tambahan.
// - analyzePhotoGPS(attachment)   → EXIF GPS dari Discord attachment
// - analyzePhotoFromURL(url)      → EXIF GPS dari URL foto (ala ExifLooter)
// - lookupGeoIP(ip)               → Koordinat + maps dari IP
// - lookupMaps(coordStr)          → Koordinat → Google Maps / OSM / Street View
// - lookupTimezone(lokasi)        → Timezone dari nama lokasi
// Reverse geocode: Nominatim (OpenStreetMap, gratis, no key)
// Timezone: timeapi.io (gratis, no key)

'use strict';

const axios = require('axios');

const AX = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'BP-AI-Bot/1.0 (Discord OSINT)' },
});

// ═══════════════════════════════════════════════════════════
// EXIF GPS PARSER — pure Node.js
// ═══════════════════════════════════════════════════════════

function readUInt16(buf, offset, le) { return le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset); }
function readUInt32(buf, offset, le) { return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset); }

function readRational(buf, offset, le) {
  const num = readUInt32(buf, offset, le);
  const den = readUInt32(buf, offset + 4, le);
  return den === 0 ? 0 : num / den;
}

function parseIFD(buf, ifdOffset, tiffStart, le) {
  const result = new Map();
  if (tiffStart + ifdOffset + 2 > buf.length) return result;
  const entryCount = readUInt16(buf, tiffStart + ifdOffset, le);
  const base = tiffStart + ifdOffset + 2;
  for (let i = 0; i < entryCount; i++) {
    const eb = base + i * 12;
    if (eb + 12 > buf.length) break;
    const tag   = readUInt16(buf, eb,     le);
    const type  = readUInt16(buf, eb + 2, le);
    const count = readUInt32(buf, eb + 4, le);
    const voff  = eb + 8;
    let value;
    if (type === 2) {
      const so = count <= 4 ? voff : tiffStart + readUInt32(buf, voff, le);
      value = buf.slice(so, so + count).toString('ascii').replace(/\0/g, '').trim();
    } else if (type === 3) {
      value = count === 1 ? readUInt16(buf, voff, le) : null;
    } else if (type === 5) {
      const ro = tiffStart + readUInt32(buf, voff, le);
      value = count === 3
        ? [readRational(buf, ro, le), readRational(buf, ro + 8, le), readRational(buf, ro + 16, le)]
        : count === 1 ? readRational(buf, ro, le) : null;
    } else if (type === 1) {
      value = count === 1 ? buf[voff] : null;
    } else {
      value = readUInt32(buf, voff, le);
    }
    result.set(tag, value);
  }
  return result;
}

function dmsToDecimal([deg, min, sec]) { return deg + min / 60 + sec / 3600; }

function extractGPS(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] !== 0xFF || buffer[1] !== 0xD8) return null;
  let pos = 2;
  while (pos < buffer.length - 4) {
    if (buffer[pos] !== 0xFF) break;
    const marker = buffer[pos + 1];
    if (pos + 4 > buffer.length) break;
    const segLen = buffer.readUInt16BE(pos + 2);
    if (marker === 0xE1 && pos + 10 <= buffer.length &&
        buffer.slice(pos + 4, pos + 10).toString('ascii') === 'Exif\0\0') {
      const tiffStart = pos + 10;
      if (tiffStart + 8 > buffer.length) return null;
      const bom = buffer.slice(tiffStart, tiffStart + 2).toString('ascii');
      const le  = bom === 'II';
      const ifd0Offset = readUInt32(buffer, tiffStart + 4, le);
      const ifd0 = parseIFD(buffer, ifd0Offset, tiffStart, le);
      const gpsPtr = ifd0.get(0x8825);
      if (!gpsPtr) return null;
      const gpsIFD = parseIFD(buffer, gpsPtr, tiffStart, le);
      const latArr = gpsIFD.get(0x0002);
      const lonArr = gpsIFD.get(0x0004);
      if (!Array.isArray(latArr) || !Array.isArray(lonArr)) return null;
      const latRef = gpsIFD.get(0x0001) || 'N';
      const lonRef = gpsIFD.get(0x0003) || 'E';
      const altVal = gpsIFD.get(0x0006);
      const altRef = gpsIFD.get(0x0005);
      let lat = dmsToDecimal(latArr);
      let lon = dmsToDecimal(lonArr);
      if (latRef === 'S') lat = -lat;
      if (lonRef === 'W') lon = -lon;
      const alt = typeof altVal === 'number' ? (altRef === 1 ? -altVal : altVal) : null;
      return { lat, lon, alt };
    }
    pos += 2 + segLen;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

async function reverseGeocode(lat, lon) {
  try {
    const { data } = await AX.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon, format: 'json', zoom: 18, addressdetails: 1 },
    });
    return data;
  } catch { return null; }
}

function countryFlag(code) {
  if (!code || code.length !== 2) return '🌍';
  return String.fromCodePoint(...[...code.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
}

function mapsLinks(lat, lon) {
  return {
    gmaps:   `https://www.google.com/maps?q=${lat},${lon}`,
    osm:     `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}&zoom=16`,
    street:  `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat},${lon}`,
    waze:    `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`,
  };
}

function formatGPSResult(label, lat, lon, alt, geo) {
  const latStr = `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lonStr = `${Math.abs(lon).toFixed(6)}° ${lon >= 0 ? 'E' : 'W'}`;
  const altStr = alt !== null ? `${alt.toFixed(1)} m` : '-';
  const addr   = geo?.display_name || 'Tidak diketahui';
  const cc     = geo?.address?.country_code?.toUpperCase() || '';
  const flag   = countryFlag(cc);
  const { gmaps, osm, street, waze } = mapsLinks(lat, lon);
  return [
    label,
    ``,
    `🌐 **Koordinat**`,
    `> Latitude:  \`${latStr}\` (\`${lat.toFixed(6)}\`)`,
    `> Longitude: \`${lonStr}\` (\`${lon.toFixed(6)}\`)`,
    alt !== null ? `> Altitude:  \`${altStr}\`` : null,
    ``,
    `${flag} **Lokasi**`,
    `> ${addr.length > 220 ? addr.slice(0, 217) + '…' : addr}`,
    ``,
    `🔗 [Google Maps](${gmaps}) · [OSM](${osm}) · [Street View](${street}) · [Waze](${waze})`,
  ].filter(l => l !== null).join('\n');
}

// ═══════════════════════════════════════════════════════════
// 1. analyzePhotoGPS — dari Discord attachment
// ═══════════════════════════════════════════════════════════
async function analyzePhotoGPS(attachment) {
  const name = attachment.name || 'foto';
  const { data } = await AX.get(attachment.url, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(data);
  const gps = extractGPS(buffer);
  if (!gps) return _noGpsMsg(name);
  const geo = await reverseGeocode(gps.lat, gps.lon);
  return formatGPSResult(`📍 **GPS dari Foto — \`${name}\`**`, gps.lat, gps.lon, gps.alt, geo)
    + '\n\n⚠️ _Data GPS dari EXIF foto — akurasi tergantung sinyal GPS saat foto diambil._';
}

// ═══════════════════════════════════════════════════════════
// 2. analyzePhotoFromURL — dari URL foto (ala ExifLooter)
// ═══════════════════════════════════════════════════════════
async function analyzePhotoFromURL(url) {
  // Validasi URL
  let cleanUrl;
  try {
    cleanUrl = new URL(url.trim()).toString();
  } catch {
    return '❌ URL tidak valid. Contoh: `!geo-photo https://example.com/foto.jpg`';
  }

  // Download binary
  let buffer;
  try {
    const { data } = await AX.get(cleanUrl, {
      responseType: 'arraybuffer',
      timeout: 20000,
      maxContentLength: 20 * 1024 * 1024, // maks 20MB
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*,*/*',
      },
    });
    buffer = Buffer.from(data);
  } catch (e) {
    return `❌ Gagal download foto dari URL: ${e.message}`;
  }

  // Ambil nama file dari URL
  const urlPath = cleanUrl.split('?')[0];
  const name = urlPath.split('/').pop() || 'foto';

  const gps = extractGPS(buffer);
  if (!gps) return _noGpsMsg(name);

  const geo = await reverseGeocode(gps.lat, gps.lon);
  return formatGPSResult(`📍 **GPS dari URL Foto — \`${name}\`**`, gps.lat, gps.lon, gps.alt, geo)
    + `\n> URL: \`${cleanUrl.slice(0, 80)}${cleanUrl.length > 80 ? '…' : ''}\``
    + '\n\n⚠️ _Data GPS dari EXIF foto — foto yang diupload ke WA/IG biasanya sudah di-strip metadata._';
}

function _noGpsMsg(name) {
  return [
    `📸 **GPS dari Foto — \`${name}\`**`,
    ``,
    `❌ Tidak ada data GPS di metadata foto ini.`,
    ``,
    `**Kemungkinan penyebab:**`,
    `> • GPS dimatikan saat foto diambil`,
    `> • Foto sudah di-strip metadata (WhatsApp, Instagram, Telegram hapus EXIF)`,
    `> • Format bukan JPEG (PNG, WebP, HEIC tidak ada EXIF GPS)`,
    `> • Screenshot — tidak punya metadata kamera`,
    ``,
    `💡 **Tips:** Gunakan foto JPG langsung dari camera roll yang belum di-share.`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// 3. lookupGeoIP — IP → koordinat GPS + maps
// ═══════════════════════════════════════════════════════════
async function lookupGeoIP(ip) {
  const clean = ip.trim().replace(/^https?:\/\//i, '').split('/')[0];
  const { data } = await AX.get(
    `http://ip-api.com/json/${encodeURIComponent(clean)}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting,mobile,query`
  );
  if (data.status !== 'success') return `❌ IP tidak valid atau tidak dikenali: \`${clean}\``;

  const flag    = countryFlag(data.countryCode);
  const tags    = [];
  if (data.proxy)   tags.push('🔴 Proxy/VPN');
  if (data.hosting) tags.push('🟠 Hosting/Datacenter');
  if (data.mobile)  tags.push('📱 Mobile');
  if (!tags.length) tags.push('🟢 Residential');

  const { gmaps, osm, street } = mapsLinks(data.lat, data.lon);

  return [
    `🌐 **GeoIP — \`${data.query}\`**`,
    ``,
    `${flag} **Lokasi**`,
    `> ${[data.city, data.regionName, data.country].filter(Boolean).join(', ')}`,
    `> ZIP: \`${data.zip || '-'}\` | Timezone: \`${data.timezone}\``,
    ``,
    `📍 **Koordinat GPS**`,
    `> Latitude:  \`${data.lat}\``,
    `> Longitude: \`${data.lon}\``,
    ``,
    `🏢 **Jaringan**`,
    `> ISP: \`${data.isp}\``,
    `> Org: \`${data.org || '-'}\``,
    `> ASN: \`${data.as}\``,
    ``,
    `🔍 **Tipe**: ${tags.join(' · ')}`,
    ``,
    `🔗 [Google Maps](${gmaps}) · [OSM](${osm}) · [Street View](${street})`,
    `🔗 [VirusTotal](https://www.virustotal.com/gui/ip-address/${data.query}) · [AbuseIPDB](https://www.abuseipdb.com/check/${data.query})`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// 4. lookupMaps — koordinat → link maps semua platform
// ═══════════════════════════════════════════════════════════
async function lookupMaps(coordStr) {
  // Parse berbagai format: "lat,lon" / "lat lon" / "-6.2,106.8" / "S 6.2, E 106.8"
  const clean = coordStr.trim().replace(/[°'"NSEW]/gi, ' ').replace(/,/g, ' ');
  const parts = clean.split(/\s+/).filter(Boolean);
  const nums  = parts.map(Number).filter(n => !isNaN(n));
  if (nums.length < 2) {
    return '❌ Format koordinat tidak dikenali.\nContoh: `!maps -6.2088, 106.8456` atau `!maps -6.2088 106.8456`';
  }
  const [lat, lon] = nums;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return `❌ Koordinat di luar batas: lat harus -90..90, lon harus -180..180.`;
  }

  const { gmaps, osm, street, waze } = mapsLinks(lat, lon);
  const geo = await reverseGeocode(lat, lon);
  const addr = geo?.display_name || '-';
  const cc   = geo?.address?.country_code?.toUpperCase() || '';

  return [
    `🗺️ **Maps — \`${lat}, ${lon}\`**`,
    ``,
    `${countryFlag(cc)} **Lokasi**: ${addr.length > 200 ? addr.slice(0,197)+'…' : addr}`,
    ``,
    `**Buka di:**`,
    `> 🔵 [Google Maps](${gmaps})`,
    `> 🟢 [OpenStreetMap](${osm})`,
    `> 🟡 [Waze](${waze})`,
    `> 🟠 [Street View](${street})`,
    `> 🔴 [Apple Maps](https://maps.apple.com/?ll=${lat},${lon}&z=16)`,
    `> ⚫ [Bing Maps](https://www.bing.com/maps?cp=${lat}~${lon}&lvl=16)`,
    `> 🟣 [What3Words](https://what3words.com/navigate?coordinates=${lat},${lon})`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════
// 5. lookupTimezone — nama lokasi → timezone + waktu sekarang
// ═══════════════════════════════════════════════════════════
async function lookupTimezone(lokasi) {
  // Step 1: forward geocode
  const { data: places } = await AX.get('https://nominatim.openstreetmap.org/search', {
    params: { q: lokasi, format: 'json', limit: 1, addressdetails: 1 },
  });

  if (!places?.length) {
    return `❌ Lokasi tidak ditemukan: \`${lokasi}\`\nCoba nama kota atau negara dalam bahasa Inggris.`;
  }

  const place = places[0];
  const lat   = parseFloat(place.lat);
  const lon   = parseFloat(place.lon);
  const addr  = place.display_name;
  const cc    = place.address?.country_code?.toUpperCase() || '';

  // Step 2: timezone dari koordinat (timeapi.io — gratis, no key)
  let tzData;
  try {
    const { data } = await AX.get('https://www.timeapi.io/api/TimeZone/coordinate', {
      params: { latitude: lat, longitude: lon },
    });
    tzData = data;
  } catch {
    tzData = null;
  }

  const tz        = tzData?.timeZone || '-';
  const localTime = tzData?.currentLocalTime
    ? tzData.currentLocalTime.replace('T', ' ').slice(0, 19)
    : '-';
  const offsetSec = tzData?.currentUtcOffset?.seconds ?? null;
  const offsetH   = offsetSec !== null
    ? `UTC${offsetSec >= 0 ? '+' : ''}${offsetSec / 3600}`
    : '-';
  const dstActive = tzData?.isDayLightSavingActive ? '🌞 DST aktif' : '—';

  return [
    `🕐 **Timezone — ${lokasi}**`,
    ``,
    `${countryFlag(cc)} **Lokasi**: ${addr.length > 200 ? addr.slice(0,197)+'…' : addr}`,
    ``,
    `⏰ **Timezone**: \`${tz}\``,
    `> UTC Offset: \`${offsetH}\``,
    `> Waktu lokal: \`${localTime}\``,
    `> DST: ${dstActive}`,
    ``,
    `📍 Koordinat: \`${lat.toFixed(4)}, ${lon.toFixed(4)}\``,
    `🔗 [Google Maps](https://www.google.com/maps?q=${lat},${lon})`,
  ].join('\n');
}

module.exports = {
  analyzePhotoGPS,
  analyzePhotoFromURL,
  lookupGeoIP,
  lookupMaps,
  lookupTimezone,
};
