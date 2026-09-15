'use strict';
const axios = require('axios');

const SYMBOL_MAP = {
  btc:'BTCUSDT',bitcoin:'BTCUSDT',eth:'ETHUSDT',ethereum:'ETHUSDT',
  bnb:'BNBUSDT',sol:'SOLUSDT',solana:'SOLUSDT',xrp:'XRPUSDT',ripple:'XRPUSDT',
  ada:'ADAUSDT',cardano:'ADAUSDT',doge:'DOGEUSDT',dogecoin:'DOGEUSDT',
  avax:'AVAXUSDT',avalanche:'AVAXUSDT',dot:'DOTUSDT',polkadot:'DOTUSDT',
  link:'LINKUSDT',chainlink:'LINKUSDT',ltc:'LTCUSDT',litecoin:'LTCUSDT',
  uni:'UNIUSDT',atom:'ATOMUSDT',cosmos:'ATOMUSDT',near:'NEARUSDT',
  arb:'ARBUSDT',op:'OPUSDT',inj:'INJUSDT',sui:'SUIUSDT',
  ton:'TONUSDT',pepe:'PEPEUSDT',trx:'TRXUSDT',tron:'TRXUSDT',
  xlm:'XLMUSDT',stellar:'XLMUSDT',apt:'APTUSDT',shib:'SHIBUSDT',
  matic:'MATICUSDT',polygon:'MATICUSDT',fil:'FILUSDT',
};
const KRAKEN_MAP = {
  'BTCUSDT':'XBTUSD','ETHUSDT':'ETHUSD','SOLUSDT':'SOLUSD',
  'XRPUSDT':'XRPUSD','ADAUSDT':'ADAUSD','DOGEUSDT':'DOGEUSD',
  'AVAXUSDT':'AVAXUSD','LINKUSDT':'LINKUSD','DOTUSDT':'DOTUSD',
  'LTCUSDT':'LTCUSD','UNIUSDT':'UNIUSD','ATOMUSDT':'ATOMUSD',
  'NEARUSDT':'NEARUSD','ARBUSDT':'ARBUSD','OPUSDT':'OPUSD',
  'INJUSDT':'INJUSD','SUIUSDT':'SUIUSD','TRXUSDT':'TRXUSD',
  'XLMUSDT':'XLMUSD','APTUSDT':'APTUSD','MATICUSDT':'MATICUSD',
  'FILUSDT':'FILUSD','BNBUSDT':'BNBUSD',
};
const KRAKEN_INTERVAL = {
  '1m':1,'5m':5,'15m':15,'30m':30,'1h':60,'2h':60,
  '4h':240,'6h':240,'8h':240,'12h':240,'1d':1440,'3d':1440,'1w':10080,'1M':21600,
};
const OKX_INTERVAL = {
  '1m':'1m','5m':'5m','15m':'15m','30m':'30m',
  '1h':'1H','2h':'2H','4h':'4H','6h':'6H','8h':'8H','12h':'12H',
  '1d':'1D','3d':'3D','1w':'1W','1M':'1M',
};
const BYBIT_INTERVAL = {
  '1m':'1','5m':'5','15m':'15','30m':'30',
  '1h':'60','2h':'120','4h':'240','6h':'360','8h':'480','12h':'720',
  '1d':'D','3d':'D','1w':'W','1M':'M',
};
const MEXC_INTERVAL = {
  '1m':'1m','5m':'5m','15m':'15m','30m':'30m',
  '1h':'60m','2h':'60m','4h':'4h','6h':'4h','8h':'4h','12h':'4h',
  '1d':'1d','3d':'1d','1w':'1w','1M':'1M',
};
const BITGET_GRANULARITY = {
  '1m':'1min','5m':'5min','15m':'15min','30m':'30min',
  '1h':'1h','2h':'2h','4h':'4h','6h':'6h','8h':'6h','12h':'12h',
  '1d':'1day','3d':'3day','1w':'1week','1M':'1week',
};
const KUCOIN_TYPE = {
  '1m':'1min','5m':'5min','15m':'15min','30m':'30min',
  '1h':'1hour','2h':'2hour','4h':'4hour','6h':'6hour','8h':'8hour','12h':'12hour',
  '1d':'1day','3d':'1day','1w':'1week','1M':'1week',
};
const VALID_INTERVALS = ['1m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d','3d','1w','1M'];

// ─── Non-Crypto Maps ────────────────────────────────────────────────────────

// Komoditas: simbol → Yahoo Finance ticker (futures)
const COMMODITY_MAP = {
  xau:'GC=F',  gold:'GC=F',  emas:'GC=F',
  xag:'SI=F',  silver:'SI=F', perak:'SI=F',
  oil:'CL=F',  crude:'CL=F', minyak:'CL=F', wti:'CL=F',
  brent:'BZ=F',
  gas:'NG=F',  naturalgas:'NG=F',
  copper:'HG=F', tembaga:'HG=F',
  platinum:'PL=F',
  palladium:'PA=F',
  corn:'ZC=F', wheat:'ZW=F', soybean:'ZS=F',
};

// Forex: simbol → Yahoo Finance ticker (format XXXYYY=X)
const FOREX_MAP = {
  eurusd:'EURUSD=X', gbpusd:'GBPUSD=X', usdjpy:'USDJPY=X',
  usdchf:'USDCHF=X', audusd:'AUDUSD=X', nzdusd:'NZDUSD=X',
  usdcad:'USDCAD=X', usdsgd:'USDSGD=X', usdidr:'USDIDR=X',
  gbpjpy:'GBPJPY=X', eurjpy:'EURJPY=X', eurgbp:'EURGBP=X',
  audnzd:'AUDNZD=X', audjpy:'AUDJPY=X', cadjpy:'CADJPY=X',
  gbpaud:'GBPAUD=X', gbpcad:'GBPCAD=X', gbpchf:'GBPCHF=X',
  euraud:'EURAUD=X', eurcad:'EURCAD=X', eurchf:'EURCHF=X',
  xauusd:'XAUUSD=X', xagusd:'XAGUSD=X',
};

// Saham Indonesia populer: alias → Yahoo Finance ticker (.JK)
const STOCK_ID_MAP = {
  // Perbankan
  bbca:'BBCA.JK', bca:'BBCA.JK',
  bbri:'BBRI.JK', bri:'BBRI.JK',
  bmri:'BMRI.JK', mandiri:'BMRI.JK',
  bbni:'BBNI.JK', bni:'BBNI.JK',
  bbtn:'BBTN.JK', btn:'BBTN.JK',
  bjbr:'BJBR.JK', bnga:'BNGA.JK',
  // Telekomunikasi
  tlkm:'TLKM.JK', telkom:'TLKM.JK',
  excl:'EXCL.JK',
  isat:'ISAT.JK', indosat:'ISAT.JK',
  // Energi & Tambang
  adro:'ADRO.JK', adaro:'ADRO.JK',
  ptba:'PTBA.JK', itmg:'ITMG.JK',
  antm:'ANTM.JK', aneka:'ANTM.JK',
  pgas:'PGAS.JK', medc:'MEDC.JK', inco:'INCO.JK',
  // Otomotif & Industri
  asii:'ASII.JK', astra:'ASII.JK',
  smgr:'SMGR.JK', semen:'SMGR.JK',
  intp:'INTP.JK',
  // Consumer & Retail
  icbp:'ICBP.JK', indf:'INDF.JK',
  unvr:'UNVR.JK', unilever:'UNVR.JK',
  hmsp:'HMSP.JK', ggrm:'GGRM.JK',
  klbf:'KLBF.JK', kalbe:'KLBF.JK',
  sido:'SIDO.JK', cpin:'CPIN.JK',
  // Properti
  pwon:'PWON.JK', bsde:'BSDE.JK',
  ctra:'CTRA.JK', ciputra:'CTRA.JK',
  lpkr:'LPKR.JK', dmas:'DMAS.JK',
  // Teknologi & Startup
  goto:'GOTO.JK', buka:'BUKA.JK', bukalapak:'BUKA.JK',
  emtk:'EMTK.JK', bren:'BREN.JK',
  // Infrastruktur
  jsmr:'JSMR.JK', wika:'WIKA.JK', wskt:'WSKT.JK',
  // Retail
  mapi:'MAPI.JK', aces:'ACES.JK',
  amrt:'AMRT.JK', alfamart:'AMRT.JK', rals:'RALS.JK',
};

// Yahoo Finance interval mapping
const YAHOO_INTERVAL = {
  '1m':'1m','5m':'5m','15m':'15m','30m':'30m',
  '1h':'60m','2h':'60m','4h':'60m','6h':'60m','8h':'60m','12h':'60m',
  '1d':'1d','3d':'1d','1w':'1wk','1M':'1mo',
};

// Durasi interval dalam detik
const INTERVAL_SECS_MAP = {
  '1m':60,'5m':300,'15m':900,'30m':1800,
  '1h':3600,'2h':7200,'4h':14400,'6h':21600,'8h':28800,'12h':43200,
  '1d':86400,'3d':259200,'1w':604800,'1M':2592000,
};

// Deteksi jenis market dari simbol
function detectMarket(symbol) {
  const s = symbol.toLowerCase().trim();
  if (COMMODITY_MAP[s]) return 'commodity';
  if (FOREX_MAP[s]) return 'forex';
  // Format pasangan forex: 6 huruf, berakhiran pasangan mata uang umum
  if (/^[a-z]{6}$/.test(s) && !SYMBOL_MAP[s] &&
    (s.slice(3)==='usd'||s.slice(3)==='jpy'||s.slice(3)==='eur'||
     s.slice(3)==='gbp'||s.slice(3)==='aud'||s.slice(3)==='cad'||
     s.slice(3)==='chf'||s.slice(3)==='nzd'||s.slice(3)==='idr'||s.slice(3)==='sgd')) return 'forex';
  if (STOCK_ID_MAP[s]) return 'stock';
  if (s.endsWith('.jk')) return 'stock';
  if (SYMBOL_MAP[s]) return 'crypto';
  if (/usdt$|busd$|btc$|eth$|bnb$/i.test(symbol)) return 'crypto';
  // Default → coba Yahoo Finance sebagai saham US
  return 'stock';
}



// ─── Data Fetching ──────────────────────────────────────────────────────────

async function fetchMEXC(pair, interval, limit) {
  const iv = MEXC_INTERVAL[interval] || '4h';
  const url = 'https://api.mexc.com/api/v3/klines?symbol='+pair+'&interval='+iv+'&limit='+Math.min(limit,1000);
  const { data } = await axios.get(url, { timeout: 8000 });
  if (!Array.isArray(data) || !data.length) throw new Error('MEXC: data kosong untuk '+pair);
  return data.map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
}

async function fetchOKX(pair, interval, limit) {
  const instId = pair.replace(/^(.+?)(USDT|BUSD|BTC|ETH|BNB)$/, '$1-$2');
  const bar = OKX_INTERVAL[interval] || '4H';
  // OKX max 300/request — paginate dengan /history-candles jika perlu lebih
  let all = [];
  let before = '';
  const pageSize = 300;
  const maxPages = Math.ceil(limit / pageSize);
  for (let p = 0; p < maxPages && all.length < limit; p++) {
    const base = p === 0
      ? 'https://www.okx.com/api/v5/market/candles'
      : 'https://www.okx.com/api/v5/market/history-candles';
    const params = 'instId='+instId+'&bar='+bar+'&limit='+pageSize+(before?'&before='+before:'');
    const { data } = await axios.get(base+'?'+params, { timeout: 8000 });
    const chunk = data && data.data;
    if (!chunk || !chunk.length) break;
    all = [...chunk, ...all]; // prepend: chunk sudah newest-first, kita balik di akhir
    before = chunk[chunk.length - 1][0]; // timestamp candle terlama sebagai cursor
    if (chunk.length < pageSize) break;   // sudah habis
  }
  if (!all.length) throw new Error('OKX: data kosong untuk '+instId);
  // all sudah newest-first dari tiap chunk yang di-prepend; sort ascending by timestamp
  all.sort((a, b) => +a[0] - +b[0]);
  return all.slice(-limit).map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
}

async function fetchBybit(pair, interval, limit) {
  const bi = BYBIT_INTERVAL[interval] || '240';
  const url = 'https://api.bybit.com/v5/market/kline?category=spot&symbol='+pair+'&interval='+bi+'&limit='+Math.min(limit,1000);
  const { data } = await axios.get(url, { timeout: 8000 });
  if (data.retCode !== 0) throw new Error('Bybit: '+data.retMsg);
  if (!data.result || !data.result.list || !data.result.list.length) throw new Error('Bybit: data kosong untuk '+pair);
  return data.result.list.slice().reverse().map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
}

async function fetchBitget(pair, interval, limit) {
  const gran = BITGET_GRANULARITY[interval] || '4h';
  const url = 'https://api.bitget.com/api/v2/spot/market/candles?symbol='+pair+'&granularity='+gran+'&limit='+Math.min(limit,1000);
  const { data } = await axios.get(url, { timeout: 8000 });
  if (data.code !== '00000') throw new Error('Bitget: '+data.msg);
  if (!data.data || !data.data.length) throw new Error('Bitget: data kosong untuk '+pair);
  return data.data.slice().reverse().map(k => ({ t:+k[0], o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[5] }));
}

async function fetchKuCoin(pair, interval, limit) {
  const instId = pair.replace(/^(.+?)(USDT|BUSD|BTC|ETH|BNB)$/, '$1-$2');
  const type = KUCOIN_TYPE[interval] || '4hour';
  // Hitung startAt dinamis agar tidak overfetch; KuCoin max 1500/req
  const INTERVAL_SECS = {
    '1min':60,'5min':300,'15min':900,'30min':1800,
    '1hour':3600,'2hour':7200,'4hour':14400,'6hour':21600,'8hour':28800,'12hour':43200,
    '1day':86400,'1week':604800,
  };
  const secPerCandle = INTERVAL_SECS[type] || 14400;
  const endAt   = Math.floor(Date.now()/1000);
  const startAt = endAt - (limit + 10) * secPerCandle;
  const url = 'https://api.kucoin.com/api/v1/market/candles?type='+type+'&symbol='+instId+'&startAt='+startAt+'&endAt='+endAt;
  const { data } = await axios.get(url, { timeout: 8000 });
  if (data.code !== '200000') throw new Error('KuCoin: '+data.msg);
  if (!data.data || !data.data.length) throw new Error('KuCoin: data kosong untuk '+instId);
  // KuCoin: ts(s), open, close, high, low, vol — newest first → reverse dan slice
  return data.data.slice().reverse().slice(-limit).map(k => ({ t:+k[0]*1000, o:+k[1], h:+k[3], l:+k[4], c:+k[2], v:+k[5] }));
}

async function fetchKraken(pair, interval, limit) {
  const kPair = KRAKEN_MAP[pair];
  if (!kPair) throw new Error('Pair '+pair+' tidak tersedia di Kraken');
  const kInterval = KRAKEN_INTERVAL[interval] || 240;
  const url = 'https://api.kraken.com/0/public/OHLC?pair='+kPair+'&interval='+kInterval;
  const { data } = await axios.get(url, { timeout: 8000 });
  if (data.error && data.error.length) throw new Error('Kraken: '+data.error[0]);
  const key = Object.keys(data.result).find(k => k !== 'last');
  return data.result[key].slice(-limit).map(k => ({ t:+k[0]*1000, o:+k[1], h:+k[2], l:+k[3], c:+k[4], v:+k[6] }));
}

// Fallback chain: MEXC → OKX → Bybit → Bitget → KuCoin → Kraken
async function fetchOHLCV(pair, interval, limit) {
  const sources = [
    { name:'MEXC',   fn: () => fetchMEXC(pair, interval, limit) },
    { name:'OKX',    fn: () => fetchOKX(pair, interval, limit) },
    { name:'Bybit',  fn: () => fetchBybit(pair, interval, limit) },
    { name:'Bitget', fn: () => fetchBitget(pair, interval, limit) },
    { name:'KuCoin', fn: () => fetchKuCoin(pair, interval, limit) },
    { name:'Kraken', fn: () => fetchKraken(pair, interval, limit) },
  ];
  let lastErr;
  for (const src of sources) {
    try {
      const result = await src.fn();
      if (result && result.length >= 10) {
        console.log('[chart] Sumber: '+src.name+' ('+result.length+' candle)');
        return result;
      }
    } catch(e) {
      const s = e.response && e.response.status;
      console.log('[chart] '+src.name+' gagal'+(s?' HTTP '+s:'')+': '+e.message.slice(0,60)+' → coba berikutnya...');
      lastErr = e;
    }
  }
  throw lastErr || new Error('Semua sumber data gagal untuk '+pair);
}

// Fetch data dari Yahoo Finance (saham, forex, komoditas)
async function fetchYahooFinance(ticker, interval, limit) {
  const yInterval = YAHOO_INTERVAL[interval] || '1d';
  const secs = INTERVAL_SECS_MAP[interval] || 86400;
  const now = Math.floor(Date.now() / 1000);
  // Buffer 3x untuk kompensasi weekend & market closed
  const period1 = now - Math.ceil(secs * limit * 3);
  const period2 = now;
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker)
    + '?interval=' + yInterval + '&period1=' + period1 + '&period2=' + period2 + '&events=history';
  const { data } = await axios.get(url, {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
  });
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  if (!result) {
    const err = data && data.chart && data.chart.error;
    throw new Error('Yahoo Finance: ' + (err && err.description ? err.description : 'tidak ada data untuk ' + ticker));
  }
  const timestamps = result.timestamp;
  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  if (!timestamps || !timestamps.length || !quote) throw new Error('Yahoo Finance: data kosong untuk ' + ticker);
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open[i], h = quote.high[i], l = quote.low[i], c = quote.close[i], v = quote.volume[i];
    if (o == null || h == null || l == null || c == null) continue;
    // Skip candle non-trading: volume=0 ATAU range < 0.05% (pre/post market futures)
    if (v === 0) continue;
    if (c > 0 && (h - l) / c < 0.0005) continue;
    candles.push({ t: timestamps[i] * 1000, o, h, l, c, v: v || 0 });
  }
  if (candles.length < 5) throw new Error('Yahoo Finance: data tidak cukup untuk ' + ticker);
  console.log('[chart] Yahoo Finance: ' + ticker + ' (' + candles.length + ' candle)');
  return candles;
}


// ─── Indicators ─────────────────────────────────────────────────────────────

function calcSMA(arr, p) {
  return arr.map((_, i) => i < p-1 ? null : arr.slice(i-p+1, i+1).reduce((a,b)=>a+b,0)/p);
}
function calcEMA(arr, p) {
  const k = 2/(p+1); let e = null; const r = [];
  for (let i = 0; i < arr.length; i++) {
    if (i < p-1) { r.push(null); continue; }
    e = e === null ? arr.slice(0,p).reduce((a,b)=>a+b,0)/p : arr[i]*k+e*(1-k);
    r.push(e);
  }
  return r;
}
function calcRSI(closes, p) {
  p = p || 14;
  const out = new Array(p).fill(null);
  let ag = 0, al = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i]-closes[i-1]; d>0?ag+=d:al-=d; }
  ag /= p; al /= p;
  out.push(al===0 ? 100 : 100-100/(1+ag/al));
  for (let i = p+1; i < closes.length; i++) {
    const d=closes[i]-closes[i-1], g=d>0?d:0, l=d<0?-d:0;
    ag=(ag*(p-1)+g)/p; al=(al*(p-1)+l)/p;
    out.push(al===0?100:100-100/(1+ag/al));
  }
  return out;
}
function calcBB(closes, p, m) {
  p=p||20; m=m||2;
  return calcSMA(closes,p).map((mid,i) => {
    if(mid===null) return {upper:null,mid:null,lower:null};
    const s=Math.sqrt(closes.slice(i-p+1,i+1).reduce((a,v)=>a+Math.pow(v-mid,2),0)/p);
    return {upper:mid+m*s, mid, lower:mid-m*s};
  });
}
function calcMACD(closes) {
  const e12=calcEMA(closes,12), e26=calcEMA(closes,26);
  const ml=e12.map((v,i)=>v!==null&&e26[i]!==null?v-e26[i]:null);
  // Signal EMA: hanya hitung dari nilai non-null untuk hindari kontaminasi zero di awal
  const firstNonNull=ml.findIndex(v=>v!==null);
  const mlClean=firstNonNull<0?ml:ml.slice(firstNonNull);
  const slClean=calcEMA(mlClean,9);
  const sl=firstNonNull<0?ml.map(()=>null):[...ml.slice(0,firstNonNull).map(()=>null),...slClean];
  return ml.map((v,i)=>({macd:v,signal:sl[i],hist:v!==null&&sl[i]!==null?v-sl[i]:null}));
}

// ─── Swing Point Detection ───────────────────────────────────────────────────

function detectSwings(ohlcv, win) {
  win = win || 4;
  const highs = [], lows = [];
  for (let i = win; i < ohlcv.length - win; i++) {
    const slice = ohlcv.slice(i-win, i+win+1);
    const maxH = Math.max(...slice.map(c=>c.h));
    const minL = Math.min(...slice.map(c=>c.l));
    if (ohlcv[i].h >= maxH) highs.push({ i, price:ohlcv[i].h, t:ohlcv[i].t });
    if (ohlcv[i].l <= minL) lows.push({ i, price:ohlcv[i].l, t:ohlcv[i].t });
  }
  return { highs, lows };
}

// ─── Support & Resistance ────────────────────────────────────────────────────

function calcSupportResistance(ohlcv) {
  // Window adaptive: lebih besar = lebih sedikit noise swing, lebih representatif
  const swWin = Math.max(4, Math.min(20, Math.floor(ohlcv.length / 40)));
  const { highs, lows } = detectSwings(ohlcv, swWin);
  function cluster(pts, tol) {
    tol = tol || 0.008;
    const groups = [];
    for (const p of pts) {
      const g = groups.find(g => Math.abs(g.price-p.price)/g.price < tol);
      if (g) { g.count++; g.price=(g.price*(g.count-1)+p.price)/g.count; }
      else groups.push({ price:p.price, count:1 });
    }
    return groups.sort((a,b)=>b.count-a.count);
  }
  const lastClose = ohlcv[ohlcv.length-1].c;
  // Urutkan by kedekatan harga (terdekat ke current price duluan)
  const resistances = cluster(highs).filter(g=>g.price>lastClose)
    .sort((a,b)=>a.price-b.price).slice(0,3);   // ascending: R terdekat dulu
  const supports    = cluster(lows ).filter(g=>g.price<lastClose)
    .sort((a,b)=>b.price-a.price).slice(0,3);   // descending: S terdekat dulu
  return { resistances, supports };
}

// ─── Fibonacci Retracement ───────────────────────────────────────────────────

function calcFibonacci(ohlcv) {
  // Gunakan lookback yang proporsional — min 80, max 300 candle agar swing range representatif
  const lookback = Math.min(ohlcv.length, Math.max(80, Math.floor(ohlcv.length * 0.4)));
  const look = ohlcv.slice(-lookback);
  const swHigh = Math.max(...look.map(c=>c.h));
  const swLow  = Math.min(...look.map(c=>c.l));
  const range  = swHigh - swLow;
  const last   = ohlcv[ohlcv.length-1].c;
  const isUp   = last > (swHigh+swLow)/2;
  return [0.236, 0.382, 0.5, 0.618, 0.786].map(r => ({
    ratio: r,
    price: isUp ? swHigh - range*r : swLow + range*r,
    label: 'Fib '+(r*100).toFixed(1)+'%',
  }));
}

// ─── Candlestick Patterns ────────────────────────────────────────────────────

function detectCandlePatterns(ohlcv) {
  const out=[], n=ohlcv.length; if(n<3) return out;
  const body=c=>Math.abs(c.c-c.o), rng=c=>c.h-c.l;
  const isBull=c=>c.c>c.o, isBear=c=>c.c<c.o;
  const uw=c=>c.h-Math.max(c.o,c.c), lw=c=>Math.min(c.o,c.c)-c.l;
  const last=ohlcv[n-1],prev=ohlcv[n-2],prev2=ohlcv[n-3];
  const bd=body(last),r=rng(last);
  if(r>0&&bd/r<0.1)                                     out.push({label:'Doji',emoji:'🔸',desc:'Ketidakpastian — potensi pembalikan'});
  else if(lw(last)>bd*2&&uw(last)<bd*0.5&&isBull(last)) out.push({label:'Hammer',emoji:'🔨',desc:'Pembalikan bullish — tekanan jual melemah'});
  else if(uw(last)>bd*2&&lw(last)<bd*0.5&&isBear(last)) out.push({label:'Shooting Star',emoji:'⭐',desc:'Pembalikan bearish — tekanan beli melemah'});
  else if(isBull(last)&&bd/r>0.85)                      out.push({label:'Marubozu Bullish',emoji:'🟩',desc:'Momentum beli sangat dominan'});
  else if(isBear(last)&&bd/r>0.85)                      out.push({label:'Marubozu Bearish',emoji:'🟥',desc:'Momentum jual sangat dominan'});
  if(isBear(prev)&&isBull(last)&&last.c>prev.o&&last.o<prev.c)    out.push({label:'Bullish Engulfing',emoji:'📗',desc:'Candle hijau menelan merah — reversal naik'});
  else if(isBull(prev)&&isBear(last)&&last.c<prev.o&&last.o>prev.c) out.push({label:'Bearish Engulfing',emoji:'📕',desc:'Candle merah menelan hijau — reversal turun'});
  if(isBear(prev2)&&body(prev)<body(prev2)*0.3&&isBull(last)&&last.c>(prev2.o+prev2.c)/2) out.push({label:'Morning Star',emoji:'🌟',desc:'Reversal bullish 3 candle'});
  else if(isBull(prev2)&&body(prev)<body(prev2)*0.3&&isBear(last)&&last.c<(prev2.o+prev2.c)/2) out.push({label:'Evening Star',emoji:'🌆',desc:'Reversal bearish 3 candle'});
  if(isBull(prev2)&&isBull(prev)&&isBull(last)&&prev.c>prev2.c&&last.c>prev.c) out.push({label:'Three White Soldiers',emoji:'💚',desc:'3 candle hijau kuat'});
  if(isBear(prev2)&&isBear(prev)&&isBear(last)&&prev.c<prev2.c&&last.c<prev.c) out.push({label:'Three Black Crows',emoji:'🖤',desc:'3 candle merah kuat'});
  return out;
}

// ─── Complex Technical Patterns ─────────────────────────────────────────────

function detectComplexPatterns(ohlcv) {
  const patterns = [];
  if (ohlcv.length < 20) return patterns;
  const { highs, lows } = detectSwings(ohlcv, 3);

  if (highs.length >= 2) {
    const h1=highs[highs.length-2], h2=highs[highs.length-1];
    if (h2.i > h1.i+4) {
      const diff=Math.abs(h1.price-h2.price)/h1.price;
      const trough=Math.min(...ohlcv.slice(h1.i,h2.i).map(c=>c.l));
      const pb=(h1.price-trough)/h1.price;
      if (diff<0.025&&pb>0.03) patterns.push({label:'Double Top',emoji:'🔴⛰️⛰️',desc:'Dua puncak sejajar — sinyal reversal bearish',type:'bearish'});
    }
  }
  if (lows.length >= 2) {
    const l1=lows[lows.length-2], l2=lows[lows.length-1];
    if (l2.i > l1.i+4) {
      const diff=Math.abs(l1.price-l2.price)/l1.price;
      const peak=Math.max(...ohlcv.slice(l1.i,l2.i).map(c=>c.h));
      const rally=(peak-l1.price)/l1.price;
      if (diff<0.025&&rally>0.03) patterns.push({label:'Double Bottom',emoji:'🟢🏔️🏔️',desc:'Dua lembah sejajar — sinyal reversal bullish',type:'bullish'});
    }
  }
  if (highs.length >= 3) {
    const [ls,head,rs]=highs.slice(-3);
    if (head.price>ls.price&&head.price>rs.price) {
      const sd=Math.abs(ls.price-rs.price)/ls.price;
      const ha=(head.price-Math.max(ls.price,rs.price))/head.price;
      if (sd<0.04&&ha>0.015) patterns.push({label:'Head & Shoulders',emoji:'🧠',desc:'Kepala lebih tinggi dari bahu — reversal bearish kuat',type:'bearish'});
    }
  }
  if (lows.length >= 3) {
    const [ls,head,rs]=lows.slice(-3);
    if (head.price<ls.price&&head.price<rs.price) {
      const sd=Math.abs(ls.price-rs.price)/ls.price;
      const hb=(Math.min(ls.price,rs.price)-head.price)/Math.min(ls.price,rs.price);
      if (sd<0.04&&hb>0.015) patterns.push({label:'Inverse H&S',emoji:'🧠',desc:'Kepala lebih rendah dari bahu — reversal bullish kuat',type:'bullish'});
    }
  }
  if (highs.length >= 2 && lows.length >= 2) {
    const rH=highs.slice(-3), rL=lows.slice(-3);
    if (rH.length>=2&&rL.length>=2) {
      const highTrend=rH[rH.length-1].price-rH[0].price;
      const lowTrend=rL[rL.length-1].price-rL[0].price;
      const base=rH[0].price, tol=base*0.004;
      if (highTrend<-tol&&lowTrend>tol)               patterns.push({label:'Symmetrical Triangle',emoji:'🔺',desc:'Konvergen — potensi breakout besar',type:'neutral'});
      else if (Math.abs(highTrend)<tol&&lowTrend>tol) patterns.push({label:'Ascending Triangle',emoji:'📐',desc:'Resistensi flat + support naik — bullish bias',type:'bullish'});
      else if (highTrend<-tol&&Math.abs(lowTrend)<tol) patterns.push({label:'Descending Triangle',emoji:'📐',desc:'Support flat + resistensi turun — bearish bias',type:'bearish'});
    }
  }
  return patterns;
}

// ─── Analysis ────────────────────────────────────────────────────────────────

function analyzeAll(ohlcv, closes, rsi, macdData, sma20, sma50, bb) {
  const last=closes[closes.length-1];
  const lastRSI=rsi.filter(v=>v!==null).pop();
  const lastMACD=macdData[macdData.length-1], prevMACD=macdData[macdData.length-2];
  const lastBB=bb[bb.length-1];
  const s20v=sma20.filter(v=>v!==null), s50v=sma50.filter(v=>v!==null);
  const lS20=s20v[s20v.length-1], lS50=s50v[s50v.length-1];
  const pS20=s20v[s20v.length-2], pS50=s50v[s50v.length-2];
  const signals=[]; let bull=0, bear=0;
  if(lS20&&lS50){
    if(lS20>lS50){signals.push('📈 EMA13>EMA21 → **Uptrend**');bull++;}
    else{signals.push('📉 EMA13<EMA21 → **Downtrend**');bear++;}
    if(pS20&&pS50){
      if(pS20<=pS50&&lS20>lS50){signals.push('✨ **EMA Bullish Crossover** (EMA13 ↑ EMA21)! → sinyal beli kuat');bull+=2;}
      else if(pS20>=pS50&&lS20<lS50){signals.push('💀 **EMA Bearish Crossover** (EMA13 ↓ EMA21)! → sinyal jual kuat');bear+=2;}
    }
    if(last>lS20){signals.push('✅ Harga di atas EMA13');bull++;}else{signals.push('⚠️ Harga di bawah EMA13');bear++;}
    if(last>lS50){signals.push('✅ Harga di atas EMA21');bull++;}else{signals.push('⚠️ Harga di bawah EMA21');bear++;}
  }
  if(lastRSI!==undefined){
    const rs=lastRSI.toFixed(1);
    if(lastRSI>=70){signals.push('🔴 RSI '+rs+' → **Overbought**');bear++;}
    else if(lastRSI<=30){signals.push('🟢 RSI '+rs+' → **Oversold**');bull++;}
    else if(lastRSI>=55){signals.push('🟡 RSI '+rs+' → Agak bullish');bull+=0.5;}
    else if(lastRSI<=45){signals.push('🟡 RSI '+rs+' → Agak bearish');bear+=0.5;}
    else signals.push('🟡 RSI '+rs+' → Netral');
  }
  if(lastMACD&&lastMACD.macd!==null&&lastMACD.signal!==null){
    if(lastMACD.macd>lastMACD.signal){
      signals.push('🟢 MACD → **Bullish momentum**');bull++;
      if(prevMACD&&prevMACD.macd!==null&&prevMACD.signal!==null&&prevMACD.macd<=prevMACD.signal){signals.push('⚡ **MACD Bullish Crossover**!');bull++;}
    }else{
      signals.push('🔴 MACD → **Bearish momentum**');bear++;
      if(prevMACD&&prevMACD.macd!==null&&prevMACD.signal!==null&&prevMACD.macd>=prevMACD.signal){signals.push('⚡ **MACD Bearish Crossover**!');bear++;}
    }
  }
  if(lastBB&&lastBB.upper&&lastBB.lower&&lastBB.mid){
    const w=((lastBB.upper-lastBB.lower)/lastBB.mid*100).toFixed(1);
    if(last>lastBB.upper){signals.push('⚠️ Harga menyentuh BB Upper ('+w+'%) — Overbought, waspada reversal');bear+=0.5;}
    else if(last<lastBB.lower){signals.push('🟢 Harga menyentuh BB Lower ('+w+'%) — Oversold, potensi rebound');bull+=0.5;}
    else {
      const bbPos = ((last-lastBB.lower)/(lastBB.upper-lastBB.lower)*100);
      if (bbPos > 80) {
        signals.push('📊 Dalam BB — posisi '+bbPos.toFixed(0)+'% ⚠️ mendekati upper — waspada reversal');
        bear += 0.3;
      } else if (bbPos < 20) {
        signals.push('📊 Dalam BB — posisi '+bbPos.toFixed(0)+'% 🟢 mendekati lower — potensi rebound');
        bull += 0.3;
      } else {
        signals.push('📊 Dalam BB — posisi '+bbPos.toFixed(0)+'% dari lower ke upper');
      }
    }
    if(parseFloat(w)<2) signals.push('🔔 BB Squeeze — potensi breakout besar');
    else if(parseFloat(w)<4) signals.push('📏 BB Menyempit — mulai waspada breakout');
  }
  let sentiment;
  if(bull>bear+2) sentiment='🟢 **BULLISH KUAT**';
  else if(bull>bear) sentiment='🟡 **BULLISH LEMAH**';
  else if(bear>bull+2) sentiment='🔴 **BEARISH KUAT**';
  else if(bear>bull) sentiment='🟠 **BEARISH LEMAH**';
  else sentiment='⚖️ **NETRAL**';
  return {signals,sentiment,lastRSI,lastMACD,bullScore:bull,bearScore:bear};
}

// ─── Normalize Helper ────────────────────────────────────────────────────────

function norm(v, srcMin, srcMax, dstMin, dstMax) {
  if (v === null || v === undefined || srcMax === srcMin) return null;
  return dstMin + (v - srcMin) / (srcMax - srcMin) * (dstMax - dstMin);
}

// ─── Build Combined Chart (1 image: candlestick + RSI + MACD panels) ────────

async function buildChart(pair, ohlcv, sma20, sma50, bb, rsi, macdData, interval, candlePatterns, complexPatterns, displayN) {
  const n   = Math.min(displayN || 60, ohlcv.length);
  // Filter candle yang terlalu kecil relatif terhadap total chart range (< 0.5% dari visible range)
  // Ini mencegah candle low-volatility tampil sebagai garis dash karena skala Y
  const rawSl  = ohlcv.slice(-n);
  const rawPriceMin = Math.min(...rawSl.map(c=>c.l));
  const rawPriceMax = Math.max(...rawSl.map(c=>c.h));
  const rawRange = rawPriceMax - rawPriceMin || 1;
  // Filter candle tiny — indikator ikut difilter by index yang sama agar tidak geser
  const keepIdx = rawSl.reduce((acc,c,i) => { if((c.h-c.l)/rawRange >= 0.003) acc.push(i); return acc; }, []);
  const sl    = keepIdx.map(i => rawSl[i]);
  const s20raw = sma20.slice(-n), s50raw = sma50.slice(-n), bbsRaw = bb.slice(-n);
  const rsiRaw = rsi.slice(-n), mdRaw = macdData.slice(-n);
  const s20   = keepIdx.map(i => s20raw[i]);
  const s50   = keepIdx.map(i => s50raw[i]);
  const bbs   = keepIdx.map(i => bbsRaw[i]);
  const rsiSl = keepIdx.map(i => rsiRaw[i]);
  const md    = keepIdx.map(i => mdRaw[i]);

  // Y-axis zones (unified 0–100 scale, y-axis hidden)
  // Price:  38 – 100
  // RSI:    17 – 35
  // MACD:   0  – 14
  // Separators at y=36 and y=15
  const priceMin = Math.min(...sl.map(c=>c.l)) * 0.998;
  const priceMax = Math.max(...sl.map(c=>c.h)) * 1.002;
  const pN = v => norm(v, priceMin, priceMax, 38, 100);
  const rN = v => norm(v, 0, 100, 17, 35);

  const macdVals = md.flatMap(m=>[m.hist,m.macd,m.signal]).filter(v=>v!==null);
  const mMin = Math.min(...macdVals), mMax = Math.max(...macdVals);
  const mN = v => norm(v, mMin, mMax, 1, 14);

  const { resistances, supports } = calcSupportResistance(ohlcv);
  const fibs = calcFibonacci(ohlcv);

  const lastRSI = rsiSl.filter(v=>v!==null).pop() || 50;
  const lastM   = md[md.length-1];
  const isBull  = lastM && lastM.macd !== null && lastM.signal !== null && lastM.macd > lastM.signal;

  function fmtS(v) {
    if (v >= 1000) return v.toLocaleString('en-US', {maximumFractionDigits:0});
    if (v >= 1)   return v.toFixed(3);
    return v.toPrecision(4);
  }

  const annotations = {
    // Panel separator lines
    sep1: { type:'line', yMin:36, yMax:36, borderColor:'rgba(255,255,255,0.18)', borderWidth:1.5 },
    sep2: { type:'line', yMin:15, yMax:15, borderColor:'rgba(255,255,255,0.18)', borderWidth:1.5 },
    // Panel title labels
    lblPrice: { type:'line', yMin:99.5, yMax:99.5, borderColor:'transparent', borderWidth:0,
      label:{display:true,content:'EMA13 · EMA21 · BB · S&R · Fib',position:'start',color:'rgba(180,180,180,0.55)',font:{size:8},backgroundColor:'rgba(0,0,0,0)'}},
    lblRSI: { type:'line', yMin:34.5, yMax:34.5, borderColor:'transparent', borderWidth:0,
      label:{display:true,content:'RSI(14) = '+lastRSI.toFixed(1)+(lastRSI>=70?' ⚠ Overbought':lastRSI<=30?' ⚠ Oversold':''),position:'start',color:'rgba(206,147,216,0.85)',font:{size:8},backgroundColor:'rgba(0,0,0,0)'}},
    lblMACD: { type:'line', yMin:14, yMax:14, borderColor:'transparent', borderWidth:0,
      label:{display:true,content:'MACD(12,26,9) '+(isBull?'▲ Bullish':'▼ Bearish'),position:'start',color:isBull?'rgba(38,166,154,0.85)':'rgba(239,83,80,0.85)',font:{size:8},backgroundColor:'rgba(0,0,0,0)'}},
    // RSI zones
    rsiOB:  { type:'line', yMin:rN(70), yMax:rN(70), borderColor:'rgba(239,83,80,0.35)',  borderWidth:1, borderDash:[4,4] },
    rsiMid: { type:'line', yMin:rN(50), yMax:rN(50), borderColor:'rgba(255,255,255,0.1)', borderWidth:1 },
    rsiOS:  { type:'line', yMin:rN(30), yMax:rN(30), borderColor:'rgba(38,166,154,0.35)', borderWidth:1, borderDash:[4,4] },
    rsiOBBox: { type:'box', yMin:rN(70), yMax:rN(100), backgroundColor:'rgba(239,83,80,0.06)',   borderWidth:0 },
    rsiOSBox: { type:'box', yMin:rN(0),  yMax:rN(30),  backgroundColor:'rgba(38,166,154,0.06)',  borderWidth:0 },
    // MACD zero line
    macd0: { type:'line', yMin:mN(0), yMax:mN(0), borderColor:'rgba(255,255,255,0.2)', borderWidth:1 },
  };

  // S&R annotation lines
  resistances.slice(0,2).forEach((r,i) => {
    annotations['r'+i] = { type:'line', yMin:pN(r.price), yMax:pN(r.price),
      borderColor:'rgba(239,83,80,0.75)', borderWidth:1.5, borderDash:[5,4],
      label:{display:true,content:'R $'+fmtS(r.price),position:'end',color:'rgba(239,83,80,0.9)',backgroundColor:'rgba(0,0,0,0.5)',font:{size:8}} };
  });
  supports.slice(0,2).forEach((s,i) => {
    annotations['s'+i] = { type:'line', yMin:pN(s.price), yMax:pN(s.price),
      borderColor:'rgba(38,166,154,0.75)', borderWidth:1.5, borderDash:[5,4],
      label:{display:true,content:'S $'+fmtS(s.price),position:'end',color:'rgba(38,166,154,0.9)',backgroundColor:'rgba(0,0,0,0.5)',font:{size:8}} };
  });

  // Fibonacci lines (38.2, 50, 61.8 only)
  fibs.filter(f=>[0.382,0.5,0.618].includes(f.ratio)).forEach((f,i) => {
    annotations['fib'+i] = { type:'line', yMin:pN(f.price), yMax:pN(f.price),
      borderColor:'rgba(255,213,79,0.45)', borderWidth:1, borderDash:[3,5],
      label:{display:true,content:f.label+' $'+fmtS(f.price),position:'start',color:'rgba(255,213,79,0.7)',backgroundColor:'rgba(0,0,0,0.35)',font:{size:8}} };
  });

  const histColors = md.map(m => m&&m.hist!==null ? (m.hist>=0?'rgba(38,166,154,0.65)':'rgba(239,83,80,0.65)') : 'transparent');

  const allPat = [...(complexPatterns||[]),...(candlePatterns||[])];
  const patStr = allPat.length>0 ? ' | '+allPat.slice(0,2).map(p=>p.emoji+p.label).join(', ') : '';

  const cfg = {
    type:'candlestick',
    data:{
      datasets:[
        // Price panel
        { label:pair,
          data:sl.map(c=>({x:c.t, o:pN(c.o), h:pN(c.h), l:pN(c.l), c:pN(c.c)})),
          color:{up:'rgba(38,166,154,1)',down:'rgba(239,83,80,1)',unchanged:'#888'},
          borderColor:{up:'rgba(38,166,154,1)',down:'rgba(239,83,80,1)',unchanged:'#888'} },
        { type:'line', label:'EMA13', data:sl.map((c,i)=>({x:c.t,y:pN(sma20[i])})),
          borderColor:'#4FC3F7', borderWidth:1.5, pointRadius:0, fill:false },
        { type:'line', label:'EMA21', data:sl.map((c,i)=>({x:c.t,y:pN(sma50[i])})),
          borderColor:'#FFD54F', borderWidth:1.5, pointRadius:0, fill:false },
        { type:'line', label:'BB Upper', data:sl.map((c,i)=>({x:c.t,y:pN(bbs[i].upper)})),
          borderColor:'rgba(206,147,216,0.55)', borderWidth:1, pointRadius:0, fill:false },
        { type:'line', label:'BB Lower', data:sl.map((c,i)=>({x:c.t,y:pN(bbs[i].lower)})),
          borderColor:'rgba(206,147,216,0.55)', borderWidth:1, pointRadius:0, fill:false },
        // RSI panel
        { type:'line', label:'RSI(14)', data:sl.map((c,i)=>({x:c.t,y:rN(rsiSl[i])})),
          borderColor:'rgba(206,147,216,0.9)', borderWidth:1.6, pointRadius:0, fill:false },
        // MACD panel
        { type:'bar', label:'Hist', data:sl.map((c,i)=>({x:c.t,y:md[i]&&md[i].hist!==null?mN(md[i].hist):null})),
          backgroundColor:histColors, order:3 },
        { type:'line', label:'MACD', data:sl.map((c,i)=>({x:c.t,y:md[i]&&md[i].macd!==null?mN(md[i].macd):null})),
          borderColor:'#4FC3F7', borderWidth:1.2, pointRadius:0, fill:false, order:2 },
        { type:'line', label:'Signal', data:sl.map((c,i)=>({x:c.t,y:md[i]&&md[i].signal!==null?mN(md[i].signal):null})),
          borderColor:'#FFD54F', borderWidth:1.2, pointRadius:0, fill:false, order:1 },
      ],
    },
    options:{
      plugins:{
        legend:{ display:false },
        title:{ display:true, text:pair+' | '+interval.toUpperCase()+(patStr?patStr:''),
          color:'#EEE', font:{size:13,weight:'bold'} },
        annotation:{ annotations },
      },
      scales:{
        x:{ type:'timeseries', ticks:{color:'#888',maxTicksLimit:10,font:{size:9}}, grid:{color:'#1F1F1F'} },
        y:{ min:0, max:100, display:false, grid:{display:false} },
      },
    },
  };

  const body = { version:4, width:900, height:650, backgroundColor:'#161A1E', format:'png', chart:cfg };
  try {
    const resp = await axios.post('https://api.quickchart.io/chart', body, {
      responseType:'arraybuffer', timeout:20000,
      headers:{'Content-Type':'application/json'},
    });
    return Buffer.from(resp.data);
  } catch(e) {
    if (e.response) {
      const errH = e.response.headers && e.response.headers['x-quickchart-error'];
      const errB = Buffer.isBuffer(e.response.data) ? e.response.data.toString('utf8') : String(e.response.data);
      console.error('[chart] QuickChart error ('+e.response.status+'):', errH||errB.slice(0,200));
    }
    throw e;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtPrice(v) {
  if(v>=1000) return '$'+v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  if(v>=1)    return '$'+v.toFixed(4);
  return '$'+v.toPrecision(5);
}

// ─── Main Handler ────────────────────────────────────────────────────────────

async function handleChartCommand(message, symbol, interval, candles) {
  try {
    interval = (interval || '4h').toLowerCase();
    if (!VALID_INTERVALS.includes(interval)) interval = '4h';
    const displayN = Math.min(Math.max(parseInt(candles) || 60, 10), 1000);
    const chartN = Math.min(displayN, 500);

    const symLow = symbol.toLowerCase().trim();
    const market = detectMarket(symbol);

    let pair, displayLabel, dataSource, tvSymbol;

    if (market === 'commodity') {
      pair = COMMODITY_MAP[symLow];
      displayLabel = symbol.toUpperCase();
      dataSource = 'Yahoo Finance (Futures)';
      tvSymbol = pair.replace('=F', '');
    } else if (market === 'forex') {
      pair = FOREX_MAP[symLow] || (symbol.toUpperCase() + '=X');
      displayLabel = symbol.toUpperCase().replace('=X', '');
      dataSource = 'Yahoo Finance (Forex)';
      tvSymbol = 'FX:' + displayLabel;
    } else if (market === 'stock') {
      pair = STOCK_ID_MAP[symLow] || (symLow.endsWith('.jk') ? symbol.toUpperCase() : symbol.toUpperCase());
      displayLabel = pair;
      const isIDX = pair.toUpperCase().endsWith('.JK');
      dataSource = isIDX ? 'Yahoo Finance (IDX)' : 'Yahoo Finance';
      tvSymbol = isIDX ? 'IDX:' + pair.replace(/\.JK$/i, '') : 'NASDAQ:' + pair;
    } else {
      // crypto
      pair = SYMBOL_MAP[symLow] || (symbol.toUpperCase() + 'USDT');
      displayLabel = pair;
      dataSource = 'MEXC/OKX/Bybit/Bitget/KuCoin/Kraken';
      tvSymbol = 'BINANCE:' + pair;
    }

    let ohlcv;
    try {
      if (market === 'crypto') {
        ohlcv = await fetchOHLCV(pair, interval, displayN + 70);
      } else {
        ohlcv = await fetchYahooFinance(pair, interval, displayN + 70);
        if (ohlcv.length > displayN + 70) ohlcv = ohlcv.slice(-(displayN + 70));
      }
    } catch (e) {
      const s = e.response && e.response.status;
      await message.reply(
        (s === 400 || (e.message && e.message.includes('tidak tersedia')))
          ? '\u26a0\ufe0f **' + displayLabel + '** tidak ditemukan. Pastikan ticker benar (contoh: BBCA, AAPL, EURUSD, XAU).'
          : '\u26a0\ufe0f Gagal ambil data **' + displayLabel + '**: ' + e.message
      ).catch(() => {});
      return;
    }
    if (!ohlcv || ohlcv.length < 30) {
      await message.reply('\u26a0\ufe0f Data tidak cukup untuk **' + displayLabel + '** \u2014 coba timeframe lebih besar (1d atau 1w).').catch(() => {});
      return;
    }

    const closes = ohlcv.map(c => c.c);
    const sma20 = calcEMA(closes, 13), sma50 = calcEMA(closes, 21);
    const rsi = calcRSI(closes, 14), macdData = calcMACD(closes), bb = calcBB(closes, 20, 2);

    const analysis       = analyzeAll(ohlcv, closes, rsi, macdData, sma20, sma50, bb);
    const candlePatterns  = detectCandlePatterns(ohlcv);
    const complexPatterns = detectComplexPatterns(ohlcv);
    const { resistances, supports } = calcSupportResistance(ohlcv);
    const fibs = calcFibonacci(ohlcv);

    const lastClose = closes[closes.length - 1], prevClose = closes[closes.length - 2] || closes[closes.length - 1];
    const pct = ((lastClose - prevClose) / prevClose * 100).toFixed(2);
    const chgStr = (pct >= 0 ? '+' : '') + pct + '%', chgEmoji = pct >= 0 ? '\ud83d\udcc8' : '\ud83d\udcc9';

    const mktEmoji = market === 'commodity' ? '\ud83c\udfc5' : market === 'forex' ? '\ud83d\udcb1' : market === 'stock' ? '\ud83c\udfe2' : '\ud83d\udcca';

    const actualN = Math.min(displayN, ohlcv.length);
    const chartNActual = Math.min(chartN, ohlcv.length);

    const { AttachmentBuilder, EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');

    // Warna embed berdasarkan sentimen
    const embedColor =
      analysis.sentiment.includes('BULLISH KUAT')  ? 0x00C853 :
      analysis.sentiment.includes('BULLISH LEMAH') ? 0x76FF03 :
      analysis.sentiment.includes('BEARISH KUAT')  ? 0xD50000 :
      analysis.sentiment.includes('BEARISH LEMAH') ? 0xFF6D00 : 0x9E9E9E;

    // ── Embed 1: Chart image (tampil di atas) ─────────────────────────────────
    const chartEmbed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(mktEmoji + ' ' + displayLabel + '  ·  ' + interval.toUpperCase() + '  ·  ' + chgEmoji + ' ' + chgStr);

    // ── Embed 2: Keterangan analisis (tampil di bawah chart) ──────────────────
    const infoEmbed = new EmbedBuilder()
      .setColor(embedColor)
      .setDescription(
        '💰 Harga: **' + fmtPrice(lastClose) + '**\n' +
        'Sentimen: ' + analysis.sentiment + '  _(Bull ' + analysis.bullScore + ' · Bear ' + analysis.bearScore + ')_'
      )
      .setFooter({ text: 'Data: ' + dataSource + '  ·  ' + actualN + ' candle  ·  chart: ' + chartNActual })
      .setTimestamp();

    if (complexPatterns.length > 0) {
      infoEmbed.addFields({
        name: '🔬 Pola Teknikal Kompleks',
        value: complexPatterns.map(p => p.emoji + ' **' + p.label + '** — ' + p.desc).join('\n').slice(0, 1024),
      });
    }
    if (candlePatterns.length > 0) {
      infoEmbed.addFields({
        name: '🕯️ Pola Candlestick',
        value: candlePatterns.map(p => p.emoji + ' ' + p.label + ' — ' + p.desc).join('\n').slice(0, 1024),
      });
    }

    // Sinyal indikator — bagi 2 field kalau banyak
    const signalLines = analysis.signals.map(s => '• ' + s);
    const half = Math.ceil(signalLines.length / 2);
    infoEmbed.addFields({ name: '🔍 Sinyal Indikator', value: signalLines.slice(0, half).join('\n').slice(0, 1024) || '—' });
    if (signalLines.length > half) {
      infoEmbed.addFields({ name: '​', value: signalLines.slice(half).join('\n').slice(0, 1024) });
    }

    if (resistances.length || supports.length) {
      const srLines = [
        ...resistances.map(r => '🔺 R: **' + fmtPrice(r.price) + '**'),
        ...supports.map(s => '🛡️ S: **' + fmtPrice(s.price) + '**'),
      ];
      infoEmbed.addFields({ name: '📐 Support & Resistance', value: srLines.join('\n').slice(0, 1024) });
    }

    const keyFibs = fibs.filter(f => [0.382, 0.5, 0.618].includes(f.ratio));
    if (keyFibs.length) {
      infoEmbed.addFields({
        name: '🌀 Fibonacci Retracement',
        value: keyFibs.map(f => f.label + ': **' + fmtPrice(f.price) + '**').join('\n'),
      });
    }

    // Build chart → masuk ke embed pertama sebagai image utama
    let file = null;
    try {
      const buf = await buildChart(displayLabel, ohlcv, sma20, sma50, bb, rsi, macdData, interval, candlePatterns, complexPatterns, chartN);
      file = new AttachmentBuilder(buf, { name: 'chart.png' });
      chartEmbed.setImage('attachment://chart.png');
    } catch (e) {
      console.error('[chart] buildChart gagal (' + (e.response && e.response.status || e.message) + ')');
      infoEmbed.addFields({ name: '📊 Chart', value: '[Lihat di TradingView](https://www.tradingview.com/chart/?symbol=' + tvSymbol + ')' });
    }

    const deleteBtn = new ButtonBuilder()
      .setCustomId('del_' + message.author.id)
      .setLabel('Hapus')
      .setEmoji('🗑️')
      .setStyle(ButtonStyle.Danger);
    const row = new ActionRowBuilder().addComponents(deleteBtn);

    // Kirim 2 embed sekaligus: chart di atas, keterangan di bawah
    const opts = { embeds: [chartEmbed, infoEmbed], components: [row] };
    if (file) opts.files = [file];
    await message.reply(opts).catch(async () => {
      await message.channel.send(opts).catch(() => {});
    });

  } catch (e) {
    console.error('[chart] unexpected:', e.message);
    await message.reply('\u26a0\ufe0f Error: ' + e.message).catch(() => {});
  }
}

module.exports = { handleChartCommand, SYMBOL_MAP };
