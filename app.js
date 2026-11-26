'use strict';
const APP_VERSION = 64;
let rainSrc = '';
/* Meteostanice – grafy z Weather Underground, data se ukládají v telefonu a volitelně do soukromého repozitáře na GitHubu. */

// ---------- pomocné funkce ----------
const $ = id => document.getElementById(id);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const ymOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const compact = d => ymd(d).replace(/-/g, '');
const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
const dayDiff = (a, b) => Math.round((b - a) / 864e5);
const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DOW = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
const DOWL = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const MON = ['led', 'úno', 'bře', 'dub', 'kvě', 'čvn', 'čvc', 'srp', 'zář', 'říj', 'lis', 'pro'];
const MONL = ['Leden', 'Únor', 'Březen', 'Duben', 'Květen', 'Červen', 'Červenec', 'Srpen', 'Září', 'Říjen', 'Listopad', 'Prosinec'];

function fmt(v, dec = 1) {
  if (v == null || !isFinite(v)) return '–';
  let r = Number(v.toFixed(dec));
  if (r === 0) r = 0; // bez „−0“
  return r.toLocaleString('cs-CZ', { minimumFractionDigits: dec, maximumFractionDigits: dec }).replace('-', '−');
}
const num = x => (x === null || x === undefined || x === '' || isNaN(x)) ? null : Number(x);
const r2 = x => x == null ? null : Math.round(x * 100) / 100;

const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } },
  del(k) { try { localStorage.removeItem(k); } catch { } }
};

// ---------- veličiny ----------
// kind: 'hla' = max/min/průměr, 'max' = jen maximum (záření, UV), 'sum' = součet (srážky)
const VARS = {
  temp: { n: 'Teplota', u: '°C', dec: 1, kind: 'hla', chart: 'line' },
  dew: { n: 'Rosný bod', u: '°C', dec: 1, kind: 'hla', chart: 'line' },
  hum: { n: 'Vlhkost', u: '%', dec: 0, kind: 'hla', chart: 'line', cap: 100 },
  press: { n: 'Tlak', u: 'hPa', dec: 1, kind: 'hla', chart: 'line' },
  wind: { n: 'Vítr', u: 'km/h', dec: 1, kind: 'hla', chart: 'bar', zero: true, noMin: true },
  gust: { n: 'Nárazy', u: 'km/h', dec: 1, kind: 'hla', chart: 'bar', zero: true, noMin: true },
  rain: { n: 'Srážky', u: 'mm', dec: 1, kind: 'sum', chart: 'bar', zero: true },
  solar: { n: 'Záření', u: 'W/m²', dec: 0, kind: 'max', chart: 'bar', zero: true, barOnly: true },
  uv: { n: 'UV', u: '', dec: 1, kind: 'max', chart: 'bar', zero: true, barOnly: true }
};

// ---------- nastavení a stav ----------
let cfg = Object.assign({ station: '', wuKey: '', ghToken: '', ghRepo: 'meteo-data', ghOwner: '', ecoApp: '', ecoKey: '', ecoMac: '', ecoAlt: 500, ecoFrom: '2026-11-26' }, LS.get('meteo.cfg', {}));
const saved = LS.get('meteo.view', {});
const st = {
  scale: ['day', 'week', 'month', 'year'].includes(saved.scale) ? saved.scale : 'week',
  v: VARS[saved.v] ? saved.v : 'temp',
  mode: ['max', 'min', 'avg'].includes(saved.mode) ? saved.mode : 'avg',
  modes: saved.modes || {},
  charts: saved.charts || {},
  anchor: today(),
  cmp: null,
  sel: null
};
const saveView = () => LS.set('meteo.view', { scale: st.scale, v: st.v, mode: st.mode, modes: st.modes, charts: st.charts });
const chartType = () => VARS[st.v].barOnly ? 'bar' : (st.charts[st.v] || VARS[st.v].chart);
// u větru a nárazů WU jako minimum posílá okamžité hodnoty (téměř vždy 0), volba Min se proto nenabízí
// volba Max / Min / Průměr se pamatuje pro každou veličinu zvlášť
const curMode = () => { const m = st.modes[st.v] || st.mode; return VARS[st.v].noMin && m === 'min' ? 'avg' : m; };

// ---------- úložiště v telefonu (IndexedDB) ----------
const idb = {
  mem: new Map(), dbp: null,
  open() {
    if (this.dbp) return this.dbp;
    this.dbp = new Promise(res => {
      try {
        const r = indexedDB.open('meteo', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => res(r.result);
        r.onerror = () => res(null);
      } catch { res(null); }
    });
    return this.dbp;
  },
  async tx(mode, fn) {
    const db = await this.open();
    if (!db) return fn(null);
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode); const q = fn(t.objectStore('kv'));
      t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
    });
  },
  async get(k) { const db = await this.open(); if (!db) return this.mem.get(k); return this.tx('readonly', s => s.get(k)); },
  async set(k, v) { const db = await this.open(); if (!db) { this.mem.set(k, v); return; } return this.tx('readwrite', s => s.put(v, k)); },
  async clear() { const db = await this.open(); this.mem.clear(); if (db) return this.tx('readwrite', s => s.clear()); },
  async del(k) { const db = await this.open(); this.mem.delete(k); if (db) return this.tx('readwrite', s => s.delete(k)); }
};

// ---------- hlášky ----------
let pending = 0;
function setBusy(d) { pending = Math.max(0, pending + d); $('busy').hidden = pending === 0; }
function showErr(t) { const e = $('err'); e.textContent = t; e.hidden = !t; }
let noteTimer = null;
function note(t) {
  const s = $('status'); if (s.classList.contains('warn')) return;
  s.dataset.note = t; renderStatus();
  clearTimeout(noteTimer); noteTimer = setTimeout(() => { delete s.dataset.note; renderStatus(); }, 8000);
}

// ---------- Weather Underground ----------
const WU = 'https://api.weather.com/v2/pws/';
const lim = { ts: [] };
async function limiter() {
  for (;;) {
    const now = Date.now(); lim.ts = lim.ts.filter(t => now - t < 60000);
    if (lim.ts.length < 25) break;
    await sleep(60000 - (now - lim.ts[0]) + 100);
  }
  const q = LS.get('meteo.quota', { d: '', n: 0 }); const d = ymd(today());
  if (q.d !== d) { q.d = d; q.n = 0; }
  if (q.n >= 1400) throw new Error('Dnes už aplikace vyčerpala bezpečný počet dotazů na Weather Underground (1400). Zítra to bude opět v pořádku.');
  q.n++; LS.set('meteo.quota', q); lim.ts.push(Date.now());
}
// ---------- Ecowitt: absolutní tlak, z něj tlak přepočtený na hladinu moře ----------
const ECO = 'https://api.ecowitt.net/api/v3/device/';
const ecoReady = () => !!(cfg.ecoApp && cfg.ecoKey && cfg.ecoMac);
async function ecoGet(path, params = {}) {
  const q = new URLSearchParams({ application_key: cfg.ecoApp, api_key: cfg.ecoKey, mac: cfg.ecoMac, temp_unitid: 1, pressure_unitid: 3, ...params });
  let r;
  const ac = new AbortController(), to = setTimeout(() => ac.abort(), 15000);
  try { r = await fetch(ECO + path + '?' + q, { cache: 'no-store', signal: ac.signal }); }
  catch { throw new Error(ac.signal.aborted ? 'Ecowitt neodpověděl do 15 s.' : 'Nepodařilo se spojit s Ecowitt.'); }
  finally { clearTimeout(to); }
  if (!r.ok) throw new Error('Ecowitt vrátil chybu ' + r.status);
  const j = await r.json();
  if (j.code !== 0) throw new Error('Ecowitt: ' + (j.msg || 'chyba ' + j.code));
  return j.data || {};
}
// přepočet na hladinu moře podle DWD: výška stanice, teplota a vlhkost vzduchu
function mslp(pAbs, t, rh) {
  if (pAbs == null) return null;
  const h = Number(cfg.ecoAlt) || 0, tc = t == null ? 10 : t;
  const E = rh == null ? 0 : 6.112 * Math.exp(17.62 * tc / (243.12 + tc)) * rh / 100;
  return Math.round(pAbs * Math.exp(9.80665 * h / (287.05 * (tc + 273.15 + 0.12 * E + 0.0065 * h / 2))) * 10) / 10;
}
const ecoVal = x => x == null ? null : num(x.value);
// pětiminutový tlak z Ecowittu za jeden den: minuty od půlnoci a přepočtený tlak
const ecoInflight = new Map();
// záloha dat z Ecowittu na GitHubu: eco/RRRR/MM/RRRR-MM-DD.json (měřené hodnoty, přepočtený tlak se dopočítá)
const ecoPath = d => `eco/${d.slice(0, 4)}/${d.slice(5, 7)}/${d}.json`;
function ecoUpload(d, e) {
  if (!gh.ready() || !e || !e.t.length) return;
  const path = ecoPath(d), last = LS.get('meteo.up', {});
  if (!e.final && last[path] && Date.now() - last[path] < 30 * 60e3) return;
  const doc = { stanice: cfg.ecoMac, den: d, final: e.final, stazeno: new Date(e.fetchedAt).toISOString(), jednotky: { tlak: 'hPa', teplota: '°C', vlhkost: '%' },
    sloupce: ['minuta', 'tlak_absolutni', 'tlak_relativni', 'teplota', 'vlhkost'], radky: e.t.map((t, i) => [t, e.abs[i], e.rel[i], e.te[i], e.hu[i]]) };
  upChain = upChain.then(async () => {
    try {
      await gh.putFile(path, doc, `${e.final ? 'Ecowitt' : 'Průběžná data Ecowitt'} ${d}`);
      const l = LS.get('meteo.up', {}); l[path] = Date.now(); LS.set('meteo.up', l);
      if (e.final) { const c = await idb.get('eco5/' + d); if (c) { c.ghDone = true; await idb.set('eco5/' + d, c); } }
    } catch (err) { note('GitHub (Ecowitt): ' + err.message); }
  });
}
const ecoCalc = e => ({ ...e, p: e.t.map((_, i) => mslp(e.abs[i], e.te[i], e.hu[i])) });
function ecoDay(d) {
  if (!ecoReady() || d < cfg.ecoFrom || d > ymd(today())) return Promise.resolve(null);
  if (ecoInflight.has(d)) return ecoInflight.get(d);
  const p = (async () => {
    const key = 'eco5/' + d, isToday = d === ymd(today());
    let e = await idb.get(key);
    if (e && !e.abs) e = null; // starší tvar bez měřených hodnot
    if (!e && gh.ready()) {
      try {
        const g = await gh.getFile(ecoPath(d));
        if (g && g.final && Array.isArray(g.radky)) {
          e = { t: g.radky.map(r => r[0]), abs: g.radky.map(r => r[1]), rel: g.radky.map(r => r[2]), te: g.radky.map(r => r[3]), hu: g.radky.map(r => r[4]), final: true, ghDone: true, fetchedAt: Date.parse(g.stazeno) || Date.now() };
          await idb.set(key, e);
        }
      } catch (err) { note('GitHub (Ecowitt): ' + err.message); }
    }
    if (e && (e.final || Date.now() - e.fetchedAt < (isToday ? 4 * 60e3 : STALE))) { if (e.final && !e.ghDone) ecoUpload(d, e); return ecoCalc(e); }
    try {
      const x = await ecoGet('history', { start_date: d + ' 00:00:00', end_date: d + ' 23:59:59', cycle_type: '5min', call_back: 'outdoor,pressure' });
      const L = o => (o && o.list) || {}, pa = L(x.pressure && x.pressure.absolute), pr = L(x.pressure && x.pressure.relative), te = L(x.outdoor && x.outdoor.temperature), hu = L(x.outdoor && x.outdoor.humidity);
      const n = { t: [], abs: [], rel: [], te: [], hu: [] };
      for (const ts of Object.keys(pa).sort((a, b) => a - b)) {
        const dt = new Date(Number(ts) * 1000); if (ymd(dt) !== d || num(pa[ts]) == null) continue;
        n.t.push(dt.getHours() * 60 + dt.getMinutes()); n.abs.push(num(pa[ts])); n.rel.push(num(pr[ts])); n.te.push(num(te[ts])); n.hu.push(num(hu[ts]));
      }
      const res = { ...n, final: Date.now() > addDays(parseYmd(d), 1).getTime() + 3600e3, fetchedAt: Date.now() };
      await idb.set(key, res); ecoUpload(d, res);
      return ecoCalc(res);
    } catch (err) { note('Tlak z Ecowittu: ' + err.message); return e ? ecoCalc(e) : null; }
  })().finally(() => ecoInflight.delete(d));
  ecoInflight.set(d, p); return p;
}
// souhrn tlaku z Ecowittu po hodinách nebo za celý den: [max, min, průměr]
function ecoAgg(eco, h) {
  const xs = eco.p.filter((v, i) => h == null || Math.floor(eco.t[i] / 60) === h);
  if (!xs.length) return null;
  return [Math.max(...xs), Math.min(...xs), r2(xs.reduce((a, b) => a + b, 0) / xs.length)];
}
// tlak v hodinových a denních záznamech nahradí přepočtem z Ecowittu
async function ecoPatch(h, d) {
  if (!ecoReady()) return;
  const days = [...new Set([...h, ...d].map(r => r.d))].filter(x => x >= cfg.ecoFrom && x <= ymd(today()));
  for (const day of days) {
    // od začátku Ecowittu se tlak z WU nepoužívá; jen v první den zůstává tlak z WU do prvního měření z Ecowittu
    const eco = await ecoDay(day), none = [null, null, null];
    const cutH = day === cfg.ecoFrom ? (eco && eco.t.length ? Math.floor(eco.t[0] / 60) : 24) : 0;
    const wuH = h.filter(r => r.d === day && r.h < cutH && r.press && r.press[0] != null);
    for (const r of h) if (r.d === day && r.h >= cutH) r.press = (eco && ecoAgg(eco, r.h)) || none;
    for (const r of d) if (r.d === day) {
      if (cutH >= 24) continue;
      const e = eco && ecoAgg(eco);
      if (!cutH) { r.press = e || none; continue; }
      if (!wuH.length) { if (e) r.press = e; continue; }
      const his = wuH.map(x => x.press[0]).concat(e ? [e[0]] : []), los = wuH.map(x => x.press[1]).concat(e ? [e[1]] : []);
      const avs = wuH.map(x => x.press[2]).concat(e ? eco.p : []);
      r.press = [Math.max(...his), Math.min(...los), r2(avs.reduce((a, b) => a + b, 0) / avs.length)];
    }
  }
}
// v podrobných datech dne nahradí tlak hodnotou z Ecowittu (nejbližší měření do 6 minut)
async function ecoFine(d, res) {
  if (!res || !res.fine || !ecoReady() || d < cfg.ecoFrom) return res;
  // tlak má vlastní časovou řadu z Ecowittu; jen v první den se před prvním měřením z Ecowittu ponechá tlak z WU
  const eco = await ecoDay(d);
  if (d === cfg.ecoFrom && !(eco && eco.t.length)) return res;
  const tp = [], pp = [];
  if (d === cfg.ecoFrom) res.fine.t.forEach((t, i) => { if (t < eco.t[0] && res.fine.v.press[i] != null) { tp.push(t); pp.push(res.fine.v.press[i]); } });
  if (eco) { tp.push(...eco.t); pp.push(...eco.p); }
  let x = null; tp.forEach((t, i) => { const v = pp[i], hm = Math.floor(t / 60) + ':' + pad(t % 60); if (!x) x = { hi: v, hiT: hm, lo: v, loT: hm }; if (v > x.hi) { x.hi = v; x.hiT = hm; } if (v < x.lo) { x.lo = v; x.loT = hm; } });
  const ext = { ...(res.ext || {}) }; if (x) ext.press = x; else delete ext.press;
  return { ...res, fine: { ...res.fine, tp, v: { ...res.fine.v, press: pp } }, ext };
}

// ---------- ruční opravy dat (soubor opravy.json v úložišti dat) ----------
// srazky: [{ den: 'RRRR-MM-DD', od: 'HH:MM', mm: 0.3, pozn }] – od daného času se z denního úhrnu odečte mm (nejméně na 0)
let opravy = LS.get('meteo.opravy', { srazky: [] });
function opravSrazky(list) {
  const os = opravy && opravy.srazky; if (!os || !os.length || !Array.isArray(list)) return list;
  for (const o of list) {
    const t = String(o.obsTimeLocal || ''), m = o.metric; if (!m || m.precipTotal == null) continue;
    const den = t.slice(0, 10), cas = t.slice(11, 16) || '23:59';
    let sub = 0; for (const k of os) if (k.den === den && cas >= (k.od || '00:00')) sub += k.mm;
    if (sub) m.precipTotal = Math.max(0, Math.round((m.precipTotal - sub) * 100) / 100);
  }
  return list;
}
async function nactiOpravy() {
  if (!gh.ready()) return;
  try {
    const o = await gh.getFile('opravy.json'); if (!o) return;
    const novy = JSON.stringify(o), stary = JSON.stringify(opravy);
    if (novy === stary) return;
    // dotčené dny a měsíce se musí znovu načíst z WU, aby se oprava projevila
    const dny = new Set([...(o.srazky || []), ...((opravy && opravy.srazky) || [])].map(k => k.den));
    for (const d of dny) { await idb.del('day5d/' + d); await idb.del('hourly/' + d.slice(0, 7)); await idb.del('daily/' + d.slice(0, 7)); }
    opravy = o; LS.set('meteo.opravy', o); LS.set('meteo.opravyTs', Date.now());
  } catch (err) { note('Opravy dat: ' + err.message); }
}
async function wuGet(path, params = {}) {
  if (!cfg.station || !cfg.wuKey) throw new Error('Nejprve v nastavení zadejte ID stanice a přístupový klíč k Weather Underground.');
  await limiter();
  const q = new URLSearchParams({ stationId: cfg.station, format: 'json', units: 'm', numericPrecision: 'decimal', ...params, apiKey: cfg.wuKey });
  let r;
  try { r = await fetch(WU + path + '?' + q, { cache: 'no-store' }); }
  catch { throw new Error('Nepodařilo se spojit s Weather Underground. Jste připojen k internetu?'); }
  if (r.status === 204) return [];
  if (r.status === 401) throw new Error('Weather Underground odmítl přístupový klíč. Zkontrolujte ho v nastavení.');
  if (r.status === 429) throw new Error('Weather Underground hlásí příliš mnoho dotazů. Zkuste to za chvíli.');
  if (!r.ok) {
    let detail = '';
    try { const b = await r.text(); try { const j = JSON.parse(b); detail = (j.errors || []).map(e => (e.error && (e.error.code + ' ' + e.error.message)) || '').filter(Boolean).join('; '); } catch { detail = b.slice(0, 160); } } catch { }
    const shown = Object.entries(params).map(([k, v]) => k + '=' + v).join(' ');
    const e = new Error(`Weather Underground vrátil chybu ${r.status} (${path}${shown ? ' ' + shown : ''})${detail ? ': ' + detail : ''}`);
    e.status = r.status; throw e;
  }
  const t = await r.text(); if (!t.trim()) return [];
  const j = JSON.parse(t);
  return opravSrazky(j.observations || j.summaries || []);
}

// převod záznamu z WU do vlastního tvaru
function norm(o, daily) {
  const m = o.metric || {};
  const loc = String(o.obsTimeLocal || o.date || '');
  const hl = (a, b, c) => [num(m[a]), num(m[b]), num(m[c])];
  const pmax = num(m.pressureMax), pmin = num(m.pressureMin);
  const r = {
    d: loc.slice(0, 10),
    temp: hl('tempHigh', 'tempLow', 'tempAvg'),
    dew: hl('dewptHigh', 'dewptLow', 'dewptAvg'),
    hum: [num(o.humidityHigh), num(o.humidityLow), num(o.humidityAvg)],
    press: [pmax, pmin, pmax != null && pmin != null ? r2((pmax + pmin) / 2) : (pmax ?? pmin)],
    wind: hl('windspeedHigh', 'windspeedLow', 'windspeedAvg'),
    gust: hl('windgustHigh', 'windgustLow', 'windgustAvg'),
    rc: num(m.precipTotal),
    solar: num(o.solarRadiationHigh),
    uv: num(o.uvHigh),
    dir: num(o.winddirAvg)
  };
  if (!daily) r.h = Number(loc.slice(11, 13));
  return r;
}
function dedupe(recs, keyf) {
  const m = new Map();
  for (const r of recs) if (/^\d{4}-\d\d-\d\d$/.test(r.d) && (r.h === undefined || (r.h >= 0 && r.h < 24))) m.set(keyf(r), r);
  return [...m.values()].sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : (a.h || 0) - (b.h || 0));
}
// precipTotal je u WU denní úhrn od půlnoci; hodinové srážky = rozdíl proti předchozí hodině
function finHourly(recs) {
  const out = dedupe(recs, r => r.d + '|' + r.h);
  let day = null, prev = null;
  for (const r of out) {
    if (r.d !== day) { day = r.d; prev = null; }
    const c = r.rc;
    r.rain = c == null ? null : r2(prev == null ? c : (c >= prev ? c - prev : c));
    if (c != null) prev = c;
  }
  return out;
}
function finDaily(recs) {
  const out = dedupe(recs, r => r.d);
  for (const r of out) r.rain = r.rc;
  return out;
}

// Způsob dotazu na historii: WU u některých klíčů odmítá rozsah dat (chyba 400), proto se zkouší postupně
// rozsah bez „date“, rozsah s „date“, týdenní úseky a nakonec jednotlivé dny. Funkční způsob se zapamatuje.
const HMODES = ['range', 'range+date', 'week', 'day'];
const HMODE_NAMES = { range: 'celý měsíc jedním dotazem', 'range+date': 'celý měsíc jedním dotazem (varianta 2)', week: 'po týdnech', day: 'po jednotlivých dnech' };
async function histWith(mode, kind, first, end) {
  const p = 'history/' + kind;
  if (mode === 'range') return wuGet(p, { startDate: compact(first), endDate: compact(end) });
  if (mode === 'range+date') return wuGet(p, { date: compact(first), startDate: compact(first), endDate: compact(end) });
  const out = [];
  for (let d = first; d <= end;) {
    const e = mode === 'week' ? (addDays(d, 6) < end ? addDays(d, 6) : end) : d;
    const r = mode === 'week' ? await wuGet(p, { startDate: compact(d), endDate: compact(e) }) : await wuGet(p, { date: compact(d) });
    out.push(...r); d = addDays(e, 1);
  }
  return out;
}
async function wuHistory(kind, first, end) {
  const key = 'meteo.hmode.' + kind;
  let i = Math.max(0, HMODES.indexOf(LS.get(key, 'range'))), lastErr = null;
  for (; i < HMODES.length; i++) {
    try { const r = await histWith(HMODES[i], kind, first, end); LS.set(key, HMODES[i]); return r; }
    catch (e) { lastErr = e; if (e.status !== 400) throw e; }
  }
  throw lastErr;
}

async function fetchMonthWU(kind, ymStr) {
  const [y, m] = ymStr.split('-').map(Number);
  const first = new Date(y, m - 1, 1), last = new Date(y, m, 0), t = today();
  const end = last > t ? t : last;
  let recs = [], err1 = null;
  try { recs = (await wuHistory(kind, first, end)).map(o => norm(o, kind === 'daily')); }
  catch (err) { err1 = err; if (/klíč|limit|dotaz/.test(err.message)) throw err; }
  if (dayDiff(end, t) <= 7) {
    try {
      const x = await wuGet(kind === 'hourly' ? 'observations/hourly/7day' : 'dailysummary/7day');
      recs = recs.concat(x.map(o => norm(o, kind === 'daily')).filter(r => r.d.startsWith(ymStr)));
    } catch (err) { if (err1 || !recs.length) throw err1 || err; }
  } else if (err1) throw err1;
  return kind === 'hourly' ? finHourly(recs) : finDaily(recs);
}

// ---------- GitHub ----------
const b64enc = s => { const b = new TextEncoder().encode(s); let bin = ''; for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(bin); };
const b64dec = s => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));
const gh = {
  shas: {},
  ready() { return !!(cfg.ghToken && cfg.ghOwner && cfg.ghRepo); },
  async api(path, opt = {}) {
    let r;
    try {
      r = await fetch('https://api.github.com' + path, {
        ...opt, cache: 'no-store',
        headers: { Authorization: 'Bearer ' + cfg.ghToken, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      });
    } catch { throw new Error('nepodařilo se spojit s GitHubem'); }
    if (r.status === 404) return null;
    if (r.status === 401) throw new Error('GitHub odmítl přístupový klíč (neplatný nebo mu vypršela platnost)');
    if (r.status === 403) throw new Error('klíč nemá oprávnění k repozitáři (potřebuje Contents: Read and write)');
    if (!r.ok) { const t = await r.text(); const e = new Error('GitHub ' + r.status + ': ' + t.slice(0, 120)); e.status = r.status; throw e; }
    return r.json();
  },
  cpath(p) { return `/repos/${encodeURIComponent(cfg.ghOwner)}/${encodeURIComponent(cfg.ghRepo)}/contents/` + p.split('/').map(encodeURIComponent).join('/'); },
  async getFile(p) {
    const r = await this.api(this.cpath(p)); if (!r) return null;
    this.shas[p] = r.sha;
    if (r.content == null || r.content === '') return null;
    return JSON.parse(b64dec(r.content));
  },
  async putFile(p, obj, message, retry = true) {
    let sha = this.shas[p];
    if (sha === undefined) { const r = await this.api(this.cpath(p)); sha = r ? r.sha : null; }
    const body = { message, content: b64enc(JSON.stringify(obj)) }; if (sha) body.sha = sha;
    try {
      const r = await this.api(this.cpath(p), { method: 'PUT', body: JSON.stringify(body) });
      this.shas[p] = r && r.content ? r.content.sha : undefined;
    } catch (e) {
      if (retry && (e.status === 409 || e.status === 422)) { delete this.shas[p]; return this.putFile(p, obj, message, false); }
      throw e;
    }
  },
  async verify() {
    const u = await this.api('/user'); if (!u) throw new Error('klíč nefunguje');
    cfg.ghOwner = u.login;
    const r = await this.api(`/repos/${encodeURIComponent(cfg.ghOwner)}/${encodeURIComponent(cfg.ghRepo)}`);
    if (!r) throw new Error(`repozitář ${cfg.ghOwner}/${cfg.ghRepo} nenalezen, nebo k němu klíč nemá přístup`);
    if (!r.private) throw new Error(`repozitář ${r.full_name} je veřejný. Data by viděl kdokoli, nastavte ho jako soukromý (Private).`);
    return r.full_name;
  }
};
const ghPath = (kind, m) => `data/${kind}/${m}.json`;
let upChain = Promise.resolve();
function queueUpload(key, e) {
  if (!gh.ready()) return;
  const path = ghPath(e.kind, e.month);
  const last = LS.get('meteo.up', {});
  if (!e.final && last[path] && Date.now() - last[path] < 30 * 60e3) return;
  upChain = upChain.then(async () => {
    try {
      await gh.putFile(path, e, `${e.final ? 'Data' : 'Průběžná data'} ${e.kind === 'hourly' ? 'hodinová' : 'denní'} ${e.month}`);
      const l = LS.get('meteo.up', {}); l[path] = Date.now(); LS.set('meteo.up', l);
      if (e.final) { const c = await idb.get(key); if (c) { c.ghDone = true; await idb.set(key, c); } }
    } catch (err) { note('GitHub: ' + err.message); }
  });
}

// ---------- načítání dat po měsících ----------
const STALE = 10 * 60e3;
const inflight = new Map();
function monthState(ymStr) {
  const [y, m] = ymStr.split('-').map(Number);
  const first = new Date(y, m - 1, 1), next = new Date(y, m, 1);
  if (first > today()) return 'future';
  return Date.now() > next.getTime() + 6 * 3600e3 ? 'past' : 'current';
}
function getMonth(kind, ymStr) {
  const k = kind + '/' + ymStr;
  if (inflight.has(k)) return inflight.get(k);
  const p = loadMonth(kind, ymStr).finally(() => inflight.delete(k));
  inflight.set(k, p); return p;
}
async function loadMonth(kind, ymStr) {
  const state = monthState(ymStr); if (state === 'future') return [];
  const key = kind + '/' + ymStr;
  let e = await idb.get(key);
  const fresh = x => x && (x.final || Date.now() - x.fetchedAt < STALE);
  if (fresh(e)) { if (e.final && !e.ghDone) queueUpload(key, e); return e.records; }
  if (!e && gh.ready()) {
    try {
      const g = await gh.getFile(ghPath(kind, ymStr));
      // kopie z GitHubu starší než změna oprav pro tento měsíc se nepoužije, měsíc se stáhne znovu z WU
      const opTs = LS.get('meteo.opravyTs', 0), dotcen = ((opravy && opravy.srazky) || []).some(k => k.den.startsWith(ymStr));
      if (g && Array.isArray(g.records) && !(dotcen && (g.fetchedAt || 0) < opTs)) {
        g.ghDone = !!g.final; await idb.set(key, g); e = g;
        if (fresh(g)) return g.records;
      }
    } catch (err) { note('GitHub: ' + err.message); }
  }
  setBusy(1);
  try {
    const recs = await fetchMonthWU(kind, ymStr);
    const ne = { v: 1, kind, month: ymStr, final: state === 'past', fetchedAt: Date.now(), records: recs };
    await idb.set(key, ne); queueUpload(key, ne);
    return recs;
  } catch (err) {
    if (e) { note(err.message); return e.records; }
    throw err;
  } finally { setBusy(-1); }
}
// Přesné hodinové srážky z podrobných měření (history/all, jen po dnech). Hodinová data WU totiž udávají
// úhrn od půlnoci k okamžiku, který neleží přesně na konci hodiny, takže se déšť posouvá mezi hodinami.
const r5inflight = new Map();
const rain5 = async d => { const x = await dayDetail(d); return x ? x.hours : null; };
// podrobná měření dne: hodinové srážky a přesné časy maxim a minim
function dayDetail(d) {
  if (r5inflight.has(d)) return r5inflight.get(d);
  const p = rain5load(d).then(res => ecoFine(d, res)).finally(() => r5inflight.delete(d)); r5inflight.set(d, p); return p;
}
const EXT = { temp: ['tempHigh', 'tempLow'], dew: ['dewptHigh', 'dewptLow'], hum: ['humidityHigh', 'humidityLow'], press: ['pressureMax', 'pressureMin'], wind: ['windspeedHigh', null], gust: ['windgustHigh', null], solar: ['solarRadiationHigh', null], uv: ['uvHigh', null] };
async function rain5load(d) {
  const key = 'day5d/' + d, e = await idb.get(key), isToday = d === ymd(today());
  // dnešní podrobná data se stahují při každém obnovení (každých 5 minut)
  if (e && (e.final || Date.now() - e.fetchedAt < (isToday ? 4 * 60e3 : STALE))) return e;
  setBusy(1);
  try {
    // u dneška bývá historie neúplná, proto se doplní měřeními za posledních 24 hodin
    let obs = [];
    // u dneška stačí měření za posledních 24 hodin (jeden dotaz), historie dne se použije jen jako záloha
    if (!isToday) obs = await wuGet('history/all', { date: d.replace(/-/g, '') });
    if (isToday) {
      let x = [];
      try { x = await wuGet('observations/all/1day'); } catch (err) { x = await wuGet('history/all', { date: d.replace(/-/g, '') }); }
      const seen = new Map(); for (const o of obs.concat(x)) { const t = String(o.obsTimeLocal || ''); if (t.startsWith(d)) seen.set(t, o); }
      obs = [...seen.values()].sort((a, b) => String(a.obsTimeLocal) < String(b.obsTimeLocal) ? -1 : 1);
    }
    const pts = obs.map(o => ({ t: String(o.obsTimeLocal || ''), c: num((o.metric || {}).precipTotal) }))
      .filter(x => x.t.startsWith(d) && x.c != null);
    let hours = null;
    if (pts.length) {
      const end = new Array(24).fill(null); let last = -1;
      for (const x of pts) { const h = Number(x.t.slice(11, 13)); if (!(h >= 0 && h < 24)) continue; end[h] = end[h] == null ? x.c : Math.max(end[h], x.c); if (h > last) last = h; }
      hours = new Array(24).fill(null); let prev = 0;
      for (let h = 0; h <= last; h++) {
        if (end[h] == null) { hours[h] = 0; continue; }
        hours[h] = r2(Math.max(0, end[h] - prev)); prev = Math.max(prev, end[h]);
      }
    }
    const ext = {};
    for (const [v, [fh, fl]] of Object.entries(EXT)) {
      const x = {};
      for (const o of obs) {
        const t = String(o.obsTimeLocal || ''); if (!t.startsWith(d)) continue;
        const m = o.metric || {}, g = f => num(m[f] ?? o[f]), hm = t.slice(11, 16).replace(/^0(\d)/, '$1');
        const h = g(fh) ?? g(fh.replace(/High$|Max$/, '')); if (h != null && (x.hi == null || h > x.hi)) { x.hi = h; x.hiT = hm; }
        if (fl) { const l = g(fl) ?? g(fl.replace(/Low$|Min$/, '')); if (l != null && (x.lo == null || l < x.lo)) { x.lo = l; x.loT = hm; } }
      }
      if (x.hi != null) ext[v] = x;
    }
    // jemná řada pro čárový graf dne: minuty od půlnoci a hodnoty (průměr za interval, u nárazů, záření a UV maximum, u srážek úhrn od půlnoci)
    const FINE = { temp: ['tempAvg', 'temp'], dew: ['dewptAvg', 'dewpt'], hum: ['humidityAvg', 'humidity'], wind: ['windspeedAvg', 'windSpeed'], gust: ['windgustHigh', 'windGust'], solar: ['solarRadiationHigh', 'solarRadiation'], uv: ['uvHigh', 'uv'], rain: ['precipTotal'], dir: ['winddirAvg', 'winddir'] };
    const fine = { t: [], v: Object.fromEntries([...Object.keys(FINE), 'press'].map(k => [k, []])) };
    for (const o of obs) {
      const t = String(o.obsTimeLocal || ''); if (!t.startsWith(d)) continue;
      const mi = Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)); if (!(mi >= 0 && mi < 1440)) continue;
      const m = o.metric || {}, g = f => num(m[f] ?? o[f]);
      fine.t.push(mi);
      for (const [k, fs] of Object.entries(FINE)) { let v = null; for (const f of fs) { v = g(f); if (v != null) break; } fine.v[k].push(v); }
      const pmx = g('pressureMax'), pmn = g('pressureMin');
      fine.v.press.push(pmx != null && pmn != null ? (pmx + pmn) / 2 : (pmx ?? pmn ?? g('pressure')));
    }
    const final = Date.now() > addDays(parseYmd(d), 1).getTime() + 3600e3;
    const res = { final, fetchedAt: Date.now(), hours, ext, fine };
    await idb.set(key, res);
    return res;
  } catch (err) { note('Podrobná měření: ' + err.message); return e || null; }
  finally { setBusy(-1); }
}
async function applyRain5(hourly) {
  const td = ymd(today()), days = [...new Set(hourly.map(r => r.d))].filter(d => d <= td);
  const res = await Promise.all(days.map(d => rain5(d)));
  const m = new Map(days.map((d, i) => [d, res[i]]));
  let used = 0;
  for (const r of hourly) { const hs = m.get(r.d); if (hs && hs[r.h] != null) { r.rain = hs[r.h]; used++; } }
  const okDays = res.filter(Boolean).length;
  rainSrc = okDays ? `Srážky po hodinách spočteny z podrobných měření (${okDays} ${okDays === 1 ? 'den' : okDays < 5 ? 'dny' : 'dní'}, ${used} hodin).` : 'Podrobná měření nejsou k dispozici, srážky po hodinách jsou z hodinových dat WU.';
  return hourly;
}

async function getRange(kind, s, e) {
  const months = [];
  for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d < e; d = addMonths(d, 1)) months.push(ymOf(d));
  const arrs = await Promise.all(months.map(m => getMonth(kind, m)));
  const S = ymd(s), E = ymd(e);
  return arrs.flat().filter(r => r.d >= S && r.d < E);
}

// ---------- předpovědi modelů (Open-Meteo a yr.no) ----------
const FC_VARS = ['temp', 'rain', 'wind', 'gust', 'press'];
const MODELS = [
  { k: 'aladin', n: 'ALADIN', full: 'ALADIN – ČHMÚ, Česko', om: 'chmi_aladin_seamless', c: '#7C3AED' },
  { k: 'icon', n: 'ICON', full: 'ICON – DWD, Německo', om: 'dwd_icon_seamless', c: '#BE185D' },
  { k: 'icond2', n: 'ICON-D2', full: 'ICON-D2 2 km – DWD, Německo', om: 'dwd_icon_d2_native', c: '#DB2777' },
  { k: 'ecmwf', n: 'ECMWF', full: 'ECMWF IFS 9 km – Evropské centrum', om: 'ecmwf_ifs', c: '#C2410C' },
  { k: 'yr', n: 'yr.no', full: 'yr.no – MET Norway', yr: true, c: '#2563EB' },
  { k: 'aifs', n: 'ECMWF AI', full: 'ECMWF AIFS – umělá inteligence', om: 'ecmwf_aifs025_single', c: '#EA580C' },
  { k: 'aicon', n: 'ICON AI', full: 'AICON – DWD, umělá inteligence', om: 'dwd_aicon_global_native', c: '#EC4899' },
  { k: 'gfs', n: 'GFS', full: 'GFS – NOAA, USA', om: 'ncep_gfs_seamless', c: '#4338CA' },
  { k: 'aigfs', n: 'GFS AI', full: 'AIGFS – NOAA, umělá inteligence', om: 'ncep_aigfs025', c: '#6366F1' },
  { k: 'mf', n: 'Météo-France', full: 'ARPEGE/AROME – Météo-France', om: 'meteofrance_seamless', c: '#1E3A8A' },
  { k: 'ukmo', n: 'UKMO', full: 'UK Met Office – Velká Británie', om: 'ukmo_seamless', c: '#4D7C0F' },
  { k: 'gem', n: 'GEM', full: 'GEM – Kanada', om: 'cmc_gem_seamless', c: '#B91C1C' },
  { k: 'jma', n: 'JMA', full: 'JMA – Japonsko', om: 'jma_seamless', c: '#A16207' },
  { k: 'cma', n: 'CMA', full: 'CMA GRAPES – Čína', om: 'cma_grapes_global', c: '#9F1239' },
  { k: 'meteoswiss', n: 'MeteoSwiss', full: 'ICON CH2 – MeteoSwiss, Švýcarsko', om: 'meteoswiss_icon_ch2', c: '#DC2626' },
  { k: 'geosphere', n: 'GeoSphere', full: 'C-LAEF – GeoSphere, Rakousko', om: 'geosphere_claef_austria', c: '#0F766E' },
  { k: 'knmi', n: 'KNMI', full: 'Harmonie Evropa – KNMI, Nizozemsko', om: 'knmi_harmonie_arome_europe', c: '#D97706' },
  { k: 'dmi', n: 'DMI', full: 'Harmonie Evropa – DMI, Dánsko', om: 'dmi_harmonie_arome_europe', c: '#57534E' }

];
const VAR_ORDER = ['temp', 'rain', 'wind', 'gust', 'press', 'hum', 'dew', 'solar', 'uv'];
const MODEL = Object.fromEntries(MODELS.map(m => [m.k, m]));
let fcModels = LS.get('meteo.fcmodels', ['aladin', 'icon', 'ecmwf', 'yr']).filter(k => MODEL[k]);
let fcOn = LS.get('meteo.fcon', null) || fcModels.slice();
const fcMem = new Map(), fcInflight = new Map();
const fcStat = () => LS.get('meteo.fcstat', {});
const setFcStat = (k, v) => { const x = fcStat(); x[k] = v; LS.set('meteo.fcstat', x); };
const avg2 = (a, b) => a == null ? (b ?? null) : b == null ? a : (a + b) / 2;
const maxDay = () => st.scale === 'day' ? addDays(today(), 2) : today();

async function omFetch(id) {
  const q = new URLSearchParams({ latitude: cfg.lat, longitude: cfg.lon, hourly: 'temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,pressure_msl,wind_direction_10m', models: id, timezone: 'Europe/Prague', forecast_days: '3', wind_speed_unit: 'kmh' });
  let r; try { r = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { cache: 'no-store' }); } catch { throw new Error('nepodařilo se spojit s Open-Meteo'); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).reason || ''; } catch { } throw new Error('Open-Meteo ' + r.status + (m ? ': ' + m : '')); }
  const H = (await r.json()).hourly || {}, t = H.time || [];
  const T = H.temperature_2m || [], P = H.precipitation || [], W = H.wind_speed_10m || [], G = H.wind_gusts_10m || [], PR = H.pressure_msl || [], WD = H.wind_direction_10m || [];
  // hodnoty k okamžiku → průměr začátku a konce hodiny; srážky a nárazy jsou za předchozí hodinu → bere se konec hodiny
  return t.map((x, i) => [x.slice(0, 10), Number(x.slice(11, 13)), avg2(T[i], T[i + 1]), P[i + 1] ?? null, avg2(W[i], W[i + 1]), G[i + 1] ?? null, avg2(PR[i], PR[i + 1]),
    T[i] ?? null, P[i] ?? null, W[i] ?? null, G[i] ?? null, PR[i] ?? null, WD[i] ?? null]);
}
async function yrFetch() {
  const u = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${Number(cfg.lat).toFixed(4)}&lon=${Number(cfg.lon).toFixed(4)}`;
  let r; try { r = await fetch(u); } catch { throw new Error('nepodařilo se spojit s yr.no'); }
  if (!r.ok) throw new Error('yr.no ' + r.status);
  const ts = ((await r.json()).properties || {}).timeseries || [];
  const t0 = today(), N = 73, idx = d => Math.round((d - t0) / 3600e3);
  const inst = { t: new Array(N).fill(null), w: new Array(N).fill(null), g: new Array(N).fill(null), p: new Array(N).fill(null) }, rain = new Array(N).fill(null), sym = new Array(N).fill(null);
  for (const e of ts) {
    const d = new Date(e.time), i = idx(d); if (i < 0 || i >= N) continue;
    const det = ((e.data || {}).instant || {}).details || {};
    inst.t[i] = num(det.air_temperature); inst.p[i] = num(det.air_pressure_at_sea_level);
    inst.w[i] = det.wind_speed != null ? det.wind_speed * 3.6 : null; inst.g[i] = det.wind_speed_of_gust != null ? det.wind_speed_of_gust * 3.6 : null;
    const n1 = ((e.data || {}).next_1_hours || {}).details, n6 = ((e.data || {}).next_6_hours || {}).details;
    const s1 = (((e.data || {}).next_1_hours || {}).summary || {}).symbol_code, s6 = (((e.data || {}).next_6_hours || {}).summary || {}).symbol_code;
    if (s1) sym[i] = s1; else if (s6) for (let k = 0; k < 6 && i + k < N; k++) if (!sym[i + k]) sym[i + k] = s6;
    if (n1 && n1.precipitation_amount != null) rain[i] = n1.precipitation_amount;
    else if (n6 && n6.precipitation_amount != null) for (let k = 0; k < 6 && i + k < N; k++) if (rain[i + k] == null) rain[i + k] = n6.precipitation_amount / 6;
  }
  // doplnění mezer (mimo první dva dny dává yr.no hodnoty po 6 hodinách)
  for (const a of Object.values(inst)) {
    let last = -1;
    for (let i = 0; i < N; i++) if (a[i] != null) { if (last >= 0 && i - last > 1 && i - last <= 6) for (let k = last + 1; k < i; k++) a[k] = a[last] + (a[i] - a[last]) * (k - last) / (i - last); last = i; }
  }
  const out = [];
  for (let i = 0; i < N - 1; i++) {
    const d = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate(), i);
    const g = inst.g[i] == null ? inst.g[i + 1] : inst.g[i + 1] == null ? inst.g[i] : Math.max(inst.g[i], inst.g[i + 1]);
    out.push([ymd(d), d.getHours(), avg2(inst.t[i], inst.t[i + 1]), rain[i] != null ? r2(rain[i]) : null, avg2(inst.w[i], inst.w[i + 1]), g, avg2(inst.p[i], inst.p[i + 1]),
      inst.t[i], i > 0 && rain[i - 1] != null ? r2(rain[i - 1]) : null, inst.w[i], inst.g[i], inst.p[i], sym[i]]);
  }
  return out;
}
function fcGet(k) {
  if (fcInflight.has(k)) return fcInflight.get(k);
  const p = fcLoad(k).finally(() => fcInflight.delete(k)); fcInflight.set(k, p); return p;
}
async function fcLoad(k) {
  const m = MODEL[k], ttl = m.yr ? 3 * 3600e3 : 3600e3, loc = cfg.lat + ',' + cfg.lon, day = ymd(today());
  const c = fcMem.get(k) || LS.get('meteo.fc4.' + k, null);
  if (c && c.loc === loc && c.day === day && Date.now() - c.at < ttl) { fcMem.set(k, c); return c; }
  try {
    const rows = m.yr ? await yrFetch() : await omFetch(m.om);
    const has = rows.some(x => x[2] != null);
    const e = { at: Date.now(), loc, day, rows: has ? rows : [] };
    fcMem.set(k, e); LS.set('meteo.fc4.' + k, e); setFcStat(k, has ? 'ok' : 'nodata');
    return e;
  } catch (err) {
    setFcStat(k, 'err'); note(m.n + ': ' + err.message);
    if (c) return c; throw err;
  }
}
// ikony počasí (yr.no) nad grafem dne: dnes až pozítří, vždy, nezávisle na tlačítkách modelů
function iconsWanted() {
  if (st.scale !== 'day' || st.cmp || cfg.lat == null) return false;
  const dd = dayDiff(today(), st.anchor); return dd >= 0 && dd <= 2;
}
function iconRow() {
  if (!iconsWanted() || !model || !model.icons || !model.icons.rows) return null;
  const d = ymd(st.anchor), mp = new Map(model.icons.rows.filter(x => x[0] === d).map(x => [x[1], x[12]]));
  const row = Array.from({ length: 24 }, (_, h) => mp.get(h) || null);
  return row.some(Boolean) ? row : null;
}
// šipky směru větru nad grafem dne (vítr a nárazy): naměřený směr, pro hodiny bez měření předpověď ALADIN
function windRow() {
  if (st.scale !== 'day' || st.cmp || !model) return null;
  const d = ymd(st.anchor), row = new Array(24).fill(null);
  const F = model.A && model.A.fine;
  if (F && F.v.dir) {
    const acc = Array.from({ length: 24 }, () => ({ x: 0, y: 0, sp: 0, n: 0 }));
    F.t.forEach((t, i) => {
      const dir = F.v.dir[i], sp = F.v.wind ? F.v.wind[i] : null; if (dir == null) return;
      const a = acc[Math.floor(t / 60)], w = sp != null ? Math.max(sp, 0.1) : 1;
      a.x += Math.sin(dir * Math.PI / 180) * w; a.y += Math.cos(dir * Math.PI / 180) * w; a.sp += sp || 0; a.n++;
    });
    acc.forEach((a, h) => { if (a.n) row[h] = { deg: (Math.atan2(a.x, a.y) * 180 / Math.PI + 360) % 360, calm: a.sp / a.n < 1, bf: beaufort(a.sp / a.n) }; });
  } else if (model.A) for (const r of model.A.h || []) if (r.d === d && r.dir != null) { const av = r.wind ? r.wind[2] : null; row[r.h] = { deg: r.dir, calm: av != null && av < 1, bf: beaufort(av) }; }
  const dd = dayDiff(today(), st.anchor), nowH = new Date().getHours();
  if (model.windFc && model.windFc.rows && dd >= 0) {
    const mp = new Map(model.windFc.rows.filter(x => x[0] === d).map(x => [x[1], x]));
    for (let h = 0; h < 24; h++) {
      if (row[h] || (dd === 0 && h < nowH)) continue;
      const x = mp.get(h); if (x && x[12] != null) row[h] = { deg: x[12], calm: x[9] != null && x[9] < 1 };
    }
  }
  return row.some(Boolean) ? row : null;
}
// stupeň Beaufortovy stupnice z průměrné rychlosti větru v km/h (meze podle WMO v m/s)
const BFT = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
function beaufort(kmh) { if (kmh == null) return null; const ms = kmh / 3.6; let b = 0; while (b < 12 && ms >= BFT[b]) b++; return b; }
const bftSvg = (a, cx, cy) => a && a.bf != null ? `<text x="${Math.round(cx * 10) / 10}" y="${cy}" text-anchor="middle" font-size="9" font-weight="600" fill="#4B5563">${a.bf}</text>` : '';
// šipka míří tam, kam vítr fouká (směr větru udává, odkud fouká)
function arrowSvg(a, cx, cy) {
  const f1 = v => Math.round(v * 10) / 10;
  if (!a) return '';
  if (a.calm) return `<line x1="${f1(cx - 3.5)}" y1="${f1(cy)}" x2="${f1(cx + 3.5)}" y2="${f1(cy)}" stroke="#1F2937" stroke-width="1.5" stroke-linecap="round"/>`;
  return `<g transform="translate(${f1(cx)},${f1(cy)}) rotate(${Math.round(a.deg + 180)})"><line x1="0" y1="6" x2="0" y2="-2" stroke="#1F2937" stroke-width="1.4" stroke-linecap="round"/><path d="M0 -7 L3.2 -1.2 L-3.2 -1.2 Z" fill="#1F2937"/></g>`;
}
const iconSvg = (code, x, y, sz) => code && /^[a-z_]+$/.test(code) ? `<image href="ikony/${code}.svg" x="${Math.round(x * 10) / 10}" y="${y}" width="${sz}" height="${sz}"/>` : '';
function fcApplicable() {
  if (st.scale !== 'day' || st.cmp || !FC_VARS.includes(st.v) || cfg.lat == null) return false;
  const dd = dayDiff(today(), st.anchor); return dd >= 0 && dd <= 2;
}
async function loadForecasts() {
  if (!fcApplicable()) return {};
  const keys = fcModels.filter(k => fcOn.includes(k));
  const res = await Promise.allSettled(keys.map(fcGet));
  const out = {}; keys.forEach((k, i) => { if (res[i].status === 'fulfilled') out[k] = res[i].value; });
  return out;
}
// doplní předpovědi zapnutých modelů, které v načtených datech chybí (např. po přepnutí z veličiny bez předpovědí)
async function fillFc() {
  if (!model || !fcApplicable()) return;
  const m0 = model, miss = fcModels.filter(k => fcOn.includes(k) && !(m0.fc || {})[k]);
  if (!miss.length) return;
  const res = await Promise.allSettled(miss.map(fcGet));
  if (model !== m0) return;
  const add = {}; miss.forEach((k, i) => { if (res[i].status === 'fulfilled') add[k] = res[i].value; });
  if (!Object.keys(add).length) return;
  model.fc = { ...(model.fc || {}), ...add };
  if (fcApplicable()) draw();
}
const FCI = { temp: 2, rain: 3, wind: 4, gust: 5, press: 6 };
const FCI0 = { temp: 7, rain: 8, wind: 9, gust: 10, press: 11 };
// předpovědi pro jemný graf dne: body v celých hodinách 0–24 h (u srážek průběžný úhrn od půlnoci)
function fcFine(fc, dayStr, v) {
  const out = [], next = ymd(addDays(parseYmd(dayStr), 1));
  for (const k of fcModels) {
    if (!fcOn.includes(k) || !fc[k] || !fc[k].rows.length) continue;
    const mp = new Map(fc[k].rows.map(x => [x[0] + '|' + x[1], x]));
    const pts = []; let cum = 0, any = false;
    for (let h = 0; h <= 24; h++) {
      const x = h < 24 ? mp.get(dayStr + '|' + h) : mp.get(next + '|0');
      let val = x ? x[FCI0[v]] : null;
      if (v === 'rain') { if (h === 0) val = 0; else if (val != null) { cum += val; val = r2(cum); } }
      if (val != null) { pts.push([h * 60, val]); if (h > 0 || v !== 'rain') any = true; }
    }
    if (any) out.push({ k, n: MODEL[k].n, color: MODEL[k].c, pts });
  }
  return out;
}
function fcSeries(fc, Bk, v) {
  const out = [];
  for (const k of fcModels) {
    if (!fcOn.includes(k) || !fc[k] || !fc[k].rows.length) continue;
    const mp = new Map(fc[k].rows.map(x => [x[0] + '|' + x[1], x]));
    const vals = Bk.map(b => { const x = mp.get(b.d + '|' + b.h); return x && x[FCI[v]] != null ? x[FCI[v]] : null; });
    if (vals.some(x => x != null)) out.push({ k, n: MODEL[k].n, color: MODEL[k].c, vals });
  }
  return out;
}

// ---------- období ----------
function periodOf(scale, a) {
  let s, e;
  if (scale === 'day') { s = a; e = addDays(a, 1); }
  else if (scale === 'week') { s = addDays(a, -((a.getDay() + 6) % 7)); e = addDays(s, 7); }
  else if (scale === 'month') { s = new Date(a.getFullYear(), a.getMonth(), 1); e = addMonths(s, 1); }
  else { s = new Date(a.getFullYear(), 0, 1); e = new Date(a.getFullYear() + 1, 0, 1); }
  return { s, e, scale };
}
function clampDay(y, m, d) { return new Date(y, m, Math.min(d, new Date(y, m + 1, 0).getDate())); }
function shift(scale, a, n) {
  if (scale === 'day') return addDays(a, n);
  if (scale === 'week') return addDays(a, 7 * n);
  if (scale === 'month') { const t = new Date(a.getFullYear(), a.getMonth() + n, 1); return clampDay(t.getFullYear(), t.getMonth(), a.getDate()); }
  return clampDay(a.getFullYear() + n, a.getMonth(), a.getDate());
}
const yearAgo = a => clampDay(a.getFullYear() - 1, a.getMonth(), a.getDate());
function isoWeek(d) {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const w1 = new Date(t.getFullYear(), 0, 4);
  return 1 + Math.round((dayDiff(w1, t) - 3 + ((w1.getDay() + 6) % 7)) / 7);
}
function periodLabel(p) {
  const s = p.s, e = addDays(p.e, -1), t = today();
  if (p.scale === 'day') {
    const dd = dayDiff(s, t);
    return { t: `${DOWL[s.getDay()]} ${s.getDate()}. ${s.getMonth() + 1}. ${s.getFullYear()}`, s: dd === 0 ? 'dnes' : dd === 1 ? 'včera' : dd === -1 ? 'zítra · předpověď' : dd === -2 ? 'pozítří · předpověď' : '' };
  }
  if (p.scale === 'week') {
    const a = s.getFullYear() !== e.getFullYear() ? `${s.getDate()}. ${s.getMonth() + 1}. ${s.getFullYear()}`
      : s.getMonth() !== e.getMonth() ? `${s.getDate()}. ${s.getMonth() + 1}.` : `${s.getDate()}.`;
    return { t: `${a}–${e.getDate()}. ${e.getMonth() + 1}. ${e.getFullYear()}`, s: `${isoWeek(s)}. týden` };
  }
  if (p.scale === 'month') return { t: `${MONL[s.getMonth()]} ${s.getFullYear()}`, s: t >= s && t < p.e ? `zatím do ${t.getDate()}. ${t.getMonth() + 1}.` : '' };
  return { t: String(s.getFullYear()), s: t >= s && t < p.e ? `zatím do ${t.getDate()}. ${t.getMonth() + 1}.` : '' };
}

// ---------- výpočty ----------
function agg(recs, v) {
  const V = VARS[v];
  let hi = null, lo = null, hiAt = null, loAt = null, s = 0, n = 0, sum = null;
  for (const r of recs) {
    const x = r[v]; if (x == null) continue;
    if (V.kind === 'hla') {
      const [h, l, a] = x;
      if (h != null && (hi == null || h > hi)) { hi = h; hiAt = r; }
      if (l != null && (lo == null || l < lo)) { lo = l; loAt = r; }
      if (a != null) { s += a; n++; }
    } else {
      if (hi == null || x > hi) { hi = x; hiAt = r; }
      if (lo == null || x < lo) { lo = x; loAt = r; }
      s += x; n++; sum = (sum || 0) + x;
    }
  }
  return { hi, lo, hiAt, loAt, avg: n ? s / n : null, sum: sum == null ? null : r2(sum) };
}
function buildBuckets(scale, type, p) {
  const B = [], s = p.s;
  if (scale === 'day') for (let h = 0; h < 24; h++) B.push({ k: 'h', d: ymd(s), h });
  else if (scale === 'week' && type === 'line') for (let i = 0; i < 168; i++) B.push({ k: 'h', d: ymd(addDays(s, Math.floor(i / 24))), h: i % 24 });
  else if (scale === 'year' && type === 'bar') for (let m = 0; m < 12; m++) B.push({ k: 'm', m: `${s.getFullYear()}-${pad(m + 1)}` });
  else if (scale === 'year') {
    // roční čárový graf po týdnech (pondělí–neděle, první a poslední týden oříznuté na daný rok)
    let d = s;
    while (d < p.e) {
      let e = addDays(d, 7 - ((d.getDay() + 6) % 7)); if (e > p.e) e = p.e;
      B.push({ k: 'w', d: ymd(d), e: ymd(addDays(e, -1)) }); d = e;
    }
  }
  else for (let d = s; d < p.e; d = addDays(d, 1)) B.push({ k: 'd', d: ymd(d) });
  return B;
}
function fillBuckets(B, hourly, daily) {
  const hm = new Map(hourly.map(r => [r.d + '|' + r.h, r]));
  const dm = new Map(daily.map(r => [r.d, r]));
  for (const b of B) {
    if (b.k === 'h') { const r = hm.get(b.d + '|' + b.h); b.recs = r ? [r] : []; }
    else if (b.k === 'd') { const r = dm.get(b.d); b.recs = r ? [r] : []; }
    else if (b.k === 'w') b.recs = daily.filter(r => r.d >= b.d && r.d <= b.e);
    else b.recs = daily.filter(r => r.d.startsWith(b.m));
  }
}
function bucketVals(B, v, mode) {
  const V = VARS[v];
  return B.map(b => {
    const a = agg(b.recs, v);
    const val = V.kind === 'sum' ? a.sum : mode === 'max' ? a.hi : mode === 'min' ? a.lo : a.avg;
    return { val, hi: a.hi, lo: a.lo, avg: a.avg };
  });
}
function fmtAt(r, scale) {
  if (!r) return '';
  const d = parseYmd(r.d), ds = `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}.`;
  if (r.h != null && (scale === 'day' || scale === 'week')) return scale === 'day' ? `v ${r.h}:00–${r.h + 1}:00` : `${ds} ${r.h}:00`;
  return scale === 'year' ? `${d.getDate()}. ${d.getMonth() + 1}.` : ds;
}
function summary(v, scale, hourly, daily) {
  const V = VARS[v], items = [];
  const fine = (scale === 'day' || scale === 'week') ? hourly : daily;
  if (v === 'rain') {
    const tot = agg(daily, 'rain').sum;
    if (scale === 'day') {
      const a = agg(hourly, 'rain'), wet = hourly.filter(r => r.rain >= 0.1).length;
      items.push({ id: 'tot', l: 'Úhrn', val: tot, cls: 'cold' },
        { id: 'wet', l: 'Hodin se srážkami', val: hourly.length ? wet : null, dec: 0, u: '', n: hourly.length ? 'z ' + hourly.length : '' },
        { id: 'mx', l: 'Nejvíce za hodinu', val: a.hi, at: a.hiAt });
    } else {
      const a = agg(daily, 'rain'), wet = daily.filter(r => r.rain >= 0.1).length;
      items.push({ id: 'tot', l: 'Úhrn', val: tot, cls: 'cold', n: daily.length ? `za ${daily.length} ${daily.length === 1 ? 'den' : daily.length < 5 ? 'dny' : 'dní'}` : '' },
        { id: 'wet', l: 'Dny se srážkami', val: daily.length ? wet : null, dec: 0, u: '', n: daily.length ? 'z ' + daily.length : '' },
        { id: 'mx', l: 'Nejvíce za den', val: a.hi, at: a.hiAt });
    }
  } else {
    const a = agg(fine, v);
    items.push({ id: 'max', l: 'Maximum', val: a.hi, at: a.hiAt, cls: 'warm' });
    if (V.kind === 'hla' && v !== 'wind' && v !== 'gust') items.push({ id: 'min', l: 'Minimum', val: a.lo, at: a.loAt, cls: 'cold' });
    items.push({ id: 'avg', l: V.kind === 'max' ? (fine === hourly ? 'Průměr hod. maxim' : 'Průměr denních maxim') : 'Průměr', val: a.avg });
    if (v === 'temp' && scale !== 'day') {
      const fr = daily.filter(r => r.temp && r.temp[1] != null && r.temp[1] < 0).length;
      items.push({ id: 'frost', l: 'Dny s mrazem', val: daily.length ? fr : null, dec: 0, u: '', n: daily.length ? 'z ' + daily.length : '' });
    }
  }
  for (const i of items) { if (i.u === undefined) i.u = V.u; if (i.dec === undefined) i.dec = V.dec; }
  return items;
}
// u srovnání se porovnává jen stejně dlouhý úsek, pokud jedno z období ještě běží (počítáno v hodinách od začátku)
function elapsedCut(p) {
  const t = today(); if (t < p.s || t >= p.e) return Infinity;
  return dayDiff(p.s, t) * 24 + new Date().getHours() + 1;
}
// první sloupec (bod) grafu, který už leží za srovnávaným úsekem
function cutIndex(Bk, p, cut) {
  if (!isFinite(cut)) return null;
  const i = Bk.findIndex(b => (b.k === 'm' ? dayDiff(p.s, parseYmd(b.m + '-01')) * 24 : b.k === 'w' ? dayDiff(p.s, parseYmd(b.e)) * 24 + 24 : dayDiff(p.s, parseYmd(b.d)) * 24 + (b.k === 'h' ? b.h : 0)) >= cut);
  return i < 0 ? null : i;
}
function cutRecs(X, cut) {
  if (!isFinite(cut)) return X;
  const f = r => dayDiff(X.p.s, parseYmd(r.d)) * 24 + (r.h != null ? r.h : 0) < cut;
  return { p: X.p, h: X.h.filter(f), d: X.d.filter(f) };
}

// ---------- graf ----------
// rozsah osy: zaokrouhlení na celé dílky; když je krajní hodnota blíž k okraji než 8 % rozsahu, přidá se další celý dílek
function nice(mn, mx, zero, cap) {
  if (cap != null) { mx = cap; mn = Math.min(mn, cap - 10); } // pevná horní mez (vlhkost 100 %)
  if (zero) mn = Math.min(0, mn);
  if (mx - mn < 1e-9) { mn -= 1; mx += 1; if (zero && mn < 0) { mx -= mn; mn = 0; } }
  const span = mx - mn, raw = span / 4, mag = 10 ** Math.floor(Math.log10(raw));
  // zkusí několik kroků a vybere nejužší osu, která má u krajních hodnot aspoň 5 % volného místa a 4–9 popisků
  let best = null;
  for (const e of [mag / 10, mag, mag * 10]) for (const q of (e >= 1 ? [1, 2, 5] : [1, 2, 2.5, 5])) { // krok 25, 250… se nepoužívá
    const step = q * e; if (step < raw / 3 || step > raw * 3) continue;
    let lo = Math.floor(mn / step + 1e-9) * step, hi = Math.ceil(mx / step - 1e-9) * step;
    for (let k = 0; k < 3; k++) {
      const pad = (hi - lo) * 0.05;
      if (cap == null && hi - mx < pad) hi += step;
      if (!(zero && lo >= 0) && mn - lo < pad) lo -= step;
    }
    if (cap != null) hi = Math.min(hi, cap);
    const nt = Math.round((hi - lo) / step) + 1;
    if (nt < 4 || nt > 9) continue;
    const r = hi - lo;
    // při stejně široké ose vyhraje krok s počtem popisků nejblíž 6
    if (!best || r < best.r - 1e-9 || (Math.abs(r - best.r) < 1e-9 && Math.abs(nt - 6) < Math.abs(best.nt - 6))) best = { lo, hi, step, r, nt };
  }
  if (!best) { // záloha: původní postup
    const step = [1, 2, 2.5, 5, 10].map(q => q * mag).find(q => q >= raw - 1e-12);
    let lo = Math.floor(mn / step + 1e-9) * step, hi = Math.ceil(mx / step - 1e-9) * step;
    if (hi - mx < span * 0.08) hi += step;
    if (cap != null) hi = Math.min(hi, cap);
    if (!(zero && lo >= 0) && mn - lo < span * 0.08) lo -= step;
    best = { lo, hi, step };
  }
  const { lo, hi, step } = best;
  const ticks = []; for (let t = lo; t <= hi + step / 1000; t += step) ticks.push(Math.round(t / step) * step);
  return { lo, hi, step, ticks };
}
function drawChart(el, o) {
  const W = Math.max(260, Math.floor(el.clientWidth || 340)), H = 230;
  const all = [];
  for (const s of o.series) {
    for (const v of s.vals) if (v != null) all.push(v);
    if (s.band) for (const b of s.band) if (b) { if (b[0] != null) all.push(b[0]); if (b[1] != null) all.push(b[1]); }
  }
  // měřítko osy se počítá ze všech hodnot (max, min i průměr), aby se při přepínání neměnilo
  if (o.fc) for (const f of o.fc) for (const v of f.vals) if (v != null) all.push(v);
  if (o.tail) all.push(o.tail.v);
  const hasData = all.length > 0;
  if (o.extra) for (const v of o.extra) if (v != null) all.push(v);
  if (!hasData) { el.innerHTML = `<div class="empty">${o.emptyMsg || 'Pro toto období nejsou žádná data.'}</div>`; return null; }
  let mn = all[0], mx = all[0]; for (const v of all) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const sc = nice(mn, mx, o.zero, o.cap);
  const tdec = sc.step < 1 ? (sc.step < 0.1 ? 2 : 1) : (sc.step % 1 ? 1 : 0);
  // levý okraj jen tak široký, aby se vešly popisky osy
  const L = Math.max(20, Math.max(...sc.ticks.map(t => fmt(t, tdec).length)) * 5.6 + 6), R = 4, Bm = 22, n = o.n, slot = (W - L - R) / n;
  let lab = null, T = 12, txt = null; const ISZ = (W - 40) / 24 >= 18 ? 19 : 15, IR = o.arrows ? (o.bft ? 29 : 18) : o.icons ? ISZ + 3 : 0; // větší ikony jen na širokém displeji
  if (o.type === 'bar' && o.series.length === 1) {
    txt = o.series[0].vals.map(v => v == null ? '' : fmt(v, o.dec));
    const tw = Math.max(...txt.map(t => t.length)) * 5.6;
    if (slot >= tw + 2) lab = 'h'; else if (slot >= 9.5) lab = 'r';
  }
  T += IR;
  const plotH = H - T - Bm;
  const y = v => T + (sc.hi - v) / (sc.hi - sc.lo) * plotH;
  // u sloupců s popisky se osa nahoře prodlužuje o celé dílky, dokud se nad nejvyšší sloupec nevejde jeho hodnota
  if (lab) for (let k = 0; k < 12; k++) {
    const vals = o.series[0].vals;
    const fits = vals.every((v, i) => v == null || Number(v.toFixed(o.dec)) === 0 || Math.min(y(v), y(sc.lo) - 1) - 3 - (lab === 'h' ? 9 : txt[i].length * 5.4) >= T);
    if (fits) break;
    sc.hi += sc.step;
    if (o.cap == null || sc.hi <= o.cap) sc.ticks.push(Math.round(sc.hi / sc.step) * sc.step);
  }
  const xc = i => L + slot * (i + 0.5);
  const f1 = x => Math.round(x * 10) / 10;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Graf')}">`;
  s += `<defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34E89E"/><stop offset="0.55" stop-color="#3EE6F2"/><stop offset="1" stop-color="#38BDF8"/></linearGradient>`
    + `<linearGradient id="gB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FDBA74"/><stop offset="1" stop-color="#EA580C"/></linearGradient>`
    + `<linearGradient id="gL" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - Bm}"><stop offset="0" stop-color="#14C07C"/><stop offset="0.55" stop-color="#10BCD3"/><stop offset="1" stop-color="#1D8FE0"/></linearGradient>`
    + FADE_DEFS + (o.tempColor ? tempGrad(y) : '') + `</defs>`;
  if (o.type === 'bar') for (let i = 0; i < n; i += 2) s += `<rect x="${f1(L + slot * i)}" y="${T}" width="${f1(slot)}" height="${f1(plotH)}" fill="#F5F6F8"/>`;
  s += '<g font-size="10" fill="#4B5563" font-family="inherit">';
  for (const t of sc.ticks) {
    const yy = f1(y(t));
    s += `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="${t === 0 && sc.lo < 0 ? '#9CA3AF' : '#E5E7EB'}" stroke-width="1"/>`;
    s += `<text x="${L - 3}" y="${yy + 3.5}" text-anchor="end">${fmt(t, tdec)}</text>`;
  }
  for (let i = 0; i < n; i++) {
    if (o.xGrid && o.xGrid(i)) s += `<line x1="${f1(L + slot * i)}" y1="${T}" x2="${f1(L + slot * i)}" y2="${T + plotH}" stroke="#E5E7EB" stroke-dasharray="2 3"/>`;
    const lb = o.xLabel ? o.xLabel(i) : ''; if (lb) s += `<text x="${f1(o.xEdge ? L + slot * i : xc(i))}" y="${H - 6}" text-anchor="middle" font-size="11">${esc(lb)}</text>`;
  }
  s += '</g>';
  if (o.icons && n === 24) o.icons.forEach((c, h) => { s += iconSvg(c, L + slot * (h + 0.5) - ISZ / 2, T - IR + 1, ISZ); });
  if (o.arrows && n === 24) o.arrows.forEach((a, h) => { s += arrowSvg(a, L + slot * (h + 0.5), T - IR + 8.5) + (o.bft ? bftSvg(a, L + slot * (h + 0.5), T - IR + 26) : ''); });
  const base = y(sc.lo);
  if (o.type === 'bar') {
    const two = o.series.length > 1, w = Math.max(1, slot * (two ? 0.4 : 0.78));
    o.series.forEach((se, k) => {
      se.vals.forEach((v, i) => {
        if (v == null) return;
        const top = Math.min(y(v), base - 1);
        const x = two ? (k === 0 ? xc(i) - w - 0.5 : xc(i) + 0.5) : xc(i) - w / 2;
        const ww = !two && o.partial && o.partial.i === i ? Math.max(1, w * o.partial.frac) : w;
        s += `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(ww)}" height="${f1(base - top)}" rx="${Math.min(2, w / 3)}" fill="url(#g${k === 0 ? 'A' : 'B'})"/>`;
      });
    });
    if (lab) {
      s += '<g font-size="9" font-weight="600" fill="#A21CAF" font-family="inherit">';
      o.series[0].vals.forEach((v, i) => {
        if (v == null || Number(v.toFixed(o.dec)) === 0) return; const top = f1(Math.min(y(v), base - 1) - 3);
        const lx = o.partial && o.partial.i === i ? xc(i) - slot * 0.39 + slot * 0.39 * o.partial.frac : xc(i);
        s += lab === 'h' ? `<text x="${f1(lx)}" y="${top}" text-anchor="middle">${txt[i]}</text>`
          : `<text transform="translate(${f1(lx + 3)},${top}) rotate(-90)">${txt[i]}</text>`;
      });
      s += '</g>';
    }
  } else {
    if (o.now != null) {
      const xn = f1(L + slot * o.now);
      s += `<line x1="${xn}" y1="${T}" x2="${xn}" y2="${T + plotH}" stroke="#111827" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.45"/>`;
    }
    if (o.fc) for (const f of o.fc) {
      let d = '', run = 0;
      f.vals.forEach((v, i) => { if (v == null) { run = 0; return; } d += (run ? 'L' : 'M') + f1(xc(i)) + ' ' + f1(y(v)); run++; });
      if (d) s += `<path d="${d}" fill="none" stroke="${f.color}" stroke-opacity="0.9" stroke-width="1.5" stroke-dasharray="4 3" stroke-linejoin="round"/>`;
    }
    // druhé období se kreslí jako první, aby bylo v pozadí
    o.series.map((se, k) => [se, k]).reverse().forEach(([se, k]) => {
      const col = k === 0 ? (o.tempColor ? 'url(#gT)' : 'url(#gL)') : '#C2410C';
      if (se.band) {
        let seg = [];
        const flush = () => {
          if (seg.length > 1) s += `<polygon fill="${o.tempColor ? '#94A3B8' : 'url(#gA)'}" fill-opacity="${o.tempColor ? 0.2 : 0.22}" points="${seg.map(([x, h]) => f1(x) + ',' + f1(y(h))).join(' ')} ${seg.slice().reverse().map(([x, , l]) => f1(x) + ',' + f1(y(l))).join(' ')}"/>`;
          seg = [];
        };
        let lastB = -1; se.band.forEach((b, i) => { if (b && b[0] != null && b[1] != null) lastB = i; });
        se.band.forEach((b, i) => {
          if (b && b[0] != null && b[1] != null) {
            seg.push([xc(i), b[0], b[1]]);
            // podkres se zúží k aktuálnímu měření
            if (k === 0 && i === lastB && o.tail && o.tail.x > i + 0.5) seg.push([L + slot * o.tail.x, o.tail.v, o.tail.v]);
          } else flush();
        }); flush();
      }
      let d = '', run = 0, lastI = -1;
      se.vals.forEach((v, i) => {
        if (v == null) { if (run === 1) s += `<circle cx="${f1(xc(lastI))}" cy="${f1(y(se.vals[lastI]))}" r="2.2" fill="${col}"/>`; run = 0; return; }
        d += (run ? 'L' : 'M') + f1(xc(i)) + ' ' + f1(y(v)); run++; lastI = i;
      });
      if (run === 1) s += `<circle cx="${f1(xc(lastI))}" cy="${f1(y(se.vals[lastI]))}" r="2.2" fill="${col}"/>`;
      // dokreslení k aktuálnímu měření (probíhající hodina ještě nemá hodinový záznam)
      if (k === 0 && o.tail && lastI >= 0 && o.tail.x > lastI + 0.5) d += (d ? 'L' : 'M') + f1(L + slot * o.tail.x) + ' ' + f1(y(o.tail.v));
      // plocha pod čarou slábnoucí k ose (týdenní graf)
      if (k === 0 && o.area && d) {
        const base = f1(y(sc.lo));
        for (const part of d.split('M').filter(Boolean)) {
          const pts = part.split('L'); if (pts.length < 2) continue;
          const x0 = pts[0].split(' ')[0], x1 = pts[pts.length - 1].split(' ')[0];
          s += `<path d="M${part}L${x1} ${base}L${x0} ${base}Z" ${o.tempColor ? 'fill="url(#gT)" mask="url(#mF)"' : 'fill="url(#gF)"'} stroke="none"/>`;
        }
      }
      if (d) s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${o.thin ? 1.3 : n > 100 ? 1.8 : 2.4}" stroke-linejoin="round" stroke-linecap="round"${k ? ' stroke-opacity="0.85"' : ''}/>`;
    });
  }
  // část za srovnávaným úsekem (souhrn ji nezapočítává) je ztlumená
  { const DX = o.dimFrom != null && o.dimFrom < n ? L + slot * o.dimFrom : null; if (DX != null) s += `<rect x="${f1(DX)}" y="${T}" width="${f1(W - R - DX)}" height="${f1(plotH)}" fill="#fff" fill-opacity="0.72"/><line x1="${f1(DX)}" y1="${T}" x2="${f1(DX)}" y2="${T + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="3 3"/>`; }
  if (o.sel != null && o.sel < n) {
    s += `<line x1="${f1(xc(o.sel))}" y1="${T}" x2="${f1(xc(o.sel))}" y2="${T + plotH}" stroke="#111827" stroke-width="1" stroke-opacity="0.5"/>`;
    if (o.type === 'line' && o.fc) for (const f of o.fc) { const v = f.vals[o.sel]; if (v != null) s += `<circle cx="${f1(xc(o.sel))}" cy="${f1(y(v))}" r="3" fill="#fff" stroke="${f.color}" stroke-width="1.5"/>`; }
    if (o.type === 'line') o.series.forEach((se, k) => { const v = se.vals[o.sel]; if (v != null) s += `<circle cx="${f1(xc(o.sel))}" cy="${f1(y(v))}" r="4" fill="#fff" stroke="${k ? '#C2410C' : '#10A9C4'}" stroke-width="2"/>`; });
  }
  s += '</svg>';
  el.innerHTML = s;
  return { L, slot, n };
}
// vyhlazení čáry monotónní kubickou křivkou (nepřekmitává přes naměřené hodnoty)
function monoPath(P) {
  const f1 = x => Math.round(x * 10) / 10, n = P.length;
  if (!n) return '';
  let d = `M${f1(P[0][0])} ${f1(P[0][1])}`;
  if (n === 1) return d + `L${f1(P[0][0] + 0.1)} ${f1(P[0][1])}`;
  const dx = [], m = [], t = new Array(n);
  for (let i = 0; i < n - 1; i++) { dx[i] = P[i + 1][0] - P[i][0] || 1e-6; m[i] = (P[i + 1][1] - P[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = a * a + b * b;
    if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += `C${f1(P[i][0] + h)} ${f1(P[i][1] + t[i] * h)} ${f1(P[i + 1][0] - h)} ${f1(P[i + 1][1] - t[i + 1] * h)} ${f1(P[i + 1][0])} ${f1(P[i + 1][1])}`;
  }
  return d;
}
// rozdělení na souvislé úseky (mezera v měření delší než 20 minut čáru přeruší)
function segments(pts, gap = 20) {
  const out = []; let cur = [];
  // poslední aktuální měření se ke křivce připojí vždy, i po delší mezeře
  pts.forEach((p, i) => { if (cur.length && p[0] - cur[cur.length - 1][0] > gap && !(pts.live && i === pts.length - 1)) { out.push(cur); cur = []; } cur.push(p); });
  if (cur.length) out.push(cur);
  return out;
}
function nearestPt(pts, min, maxDist = 15) {
  if (!pts || !pts.length) return null;
  let best = null, bd = Infinity;
  for (const p of pts) { const d = Math.abs(p[0] - min); if (d < bd) { bd = d; best = p; } }
  return bd <= maxDist ? best : null;
}
// barevná stupnice teploty: pořadí barev podle Windy, sytost a jas jako ostatní grafy (pevná, nezávislá na rozsahu osy)
const TEMP_SCALE = [[-20, '#8B5CF6'], [-15, '#38C6E0'], [-10, '#22B8C9'], [-5, '#1AA3B8'], [0, '#1D8FE0'], [5, '#14C07C'], [10, '#7CC21A'], [15, '#C2C412'], [20, '#F2C200'], [25, '#F7931E'], [30, '#F0521D'], [35, '#D9341A'], [40, '#A8211A']];
function tempGrad(y) {
  const y1 = y(40), y2 = y(-20);
  return `<linearGradient id="gT" gradientUnits="userSpaceOnUse" x1="0" y1="${y1}" x2="0" y2="${y2}">` + TEMP_SCALE.slice().reverse().map(([t, c]) => `<stop offset="${((y(t) - y1) / (y2 - y1)).toFixed(4)}" stop-color="${c}"/>`).join('') + '</linearGradient>';
}
// plocha pod čarou slábnoucí k ose (obecná barva a maska pro barvu teploty)
const FADE_DEFS = `<linearGradient id="gF" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#14C07C" stop-opacity="0.5"/><stop offset="0.5" stop-color="#10BCD3" stop-opacity="0.22"/><stop offset="1" stop-color="#1D8FE0" stop-opacity="0.02"/></linearGradient>`
  + `<linearGradient id="gMf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.6"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.28"/><stop offset="1" stop-color="#fff" stop-opacity="0.03"/></linearGradient><mask id="mF" maskContentUnits="objectBoundingBox"><rect width="1" height="1" fill="url(#gMf)"/></mask>`;
const hhmm = mi => `${Math.floor(mi / 60)}:${pad(Math.round(mi % 60))}`;
function drawFine(el, o) {
  const W = Math.max(260, Math.floor(el.clientWidth || 340)), H = 230, R = 4, Bm = 22; let T = 10;
  const all = [];
  for (const s2 of [o.a, o.b]) if (s2) for (const p of s2) all.push(p[1]);
  for (const f of o.fc || []) for (const p of f.pts) all.push(p[1]);
  if (!all.length) { el.innerHTML = `<div class="empty">${o.emptyMsg || 'Pro tento den nejsou žádná data.'}</div>`; return null; }
  let mn = all[0], mx = all[0]; for (const v of all) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const ISZ = (W - 40) / 24 >= 18 ? 19 : 15, IR = o.arrows ? (o.bft ? 29 : 18) : o.icons ? ISZ + 3 : 0; T += IR; // větší ikony jen na širokém displeji
  const sc = nice(mn, mx, o.zero, o.cap), plotH = H - T - Bm;
  const tdec = sc.step < 1 ? (sc.step < 0.1 ? 2 : 1) : (sc.step % 1 ? 1 : 0);
  const L = Math.max(20, Math.max(...sc.ticks.map(t => fmt(t, tdec).length)) * 5.6 + 6), slot = (W - L - R) / 24;
  const x = mi => L + slot * mi / 60, y = v => T + (sc.hi - v) / (sc.hi - sc.lo) * plotH, f1 = v => Math.round(v * 10) / 10;
  const px = pts => pts.map(p => [x(p[0]), y(p[1])]);
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Graf')}">`;
  s += `<defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34E89E"/><stop offset="0.55" stop-color="#3EE6F2"/><stop offset="1" stop-color="#38BDF8"/></linearGradient>`
    + `<linearGradient id="gL" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - Bm}"><stop offset="0" stop-color="#14C07C"/><stop offset="0.55" stop-color="#10BCD3"/><stop offset="1" stop-color="#1D8FE0"/></linearGradient>`
    + `<linearGradient id="gW" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - Bm}"><stop offset="0" stop-color="#34E89E"/><stop offset="0.55" stop-color="#3EE6F2"/><stop offset="1" stop-color="#38BDF8"/></linearGradient>`
    + FADE_DEFS
    + tempGrad(y)
    + `</defs>`;
  s += '<g font-size="10" fill="#4B5563" font-family="inherit">';
  for (const t of sc.ticks) {
    const yy = f1(y(t));
    s += `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="${t === 0 && sc.lo < 0 ? '#9CA3AF' : '#E5E7EB'}" stroke-width="1"/><text x="${L - 3}" y="${yy + 3.5}" text-anchor="end">${fmt(t, tdec)}</text>`;
  }
  for (let h = 0; h < 24; h++) {
    if (h % 6 === 0 && h > 0) s += `<line x1="${f1(x(h * 60))}" y1="${T}" x2="${f1(x(h * 60))}" y2="${T + plotH}" stroke="#E5E7EB" stroke-dasharray="2 3"/>`;
    if (h % 3 === 0) s += `<text x="${f1(x(h * 60))}" y="${H - 6}" text-anchor="middle" font-size="11">${h}h</text>`;
  }
  s += '</g>';
  if (o.icons) o.icons.forEach((c, h) => { s += iconSvg(c, L + slot * (h + 0.5) - ISZ / 2, T - IR + 1, ISZ); });
  if (o.arrows) o.arrows.forEach((a, h) => { s += arrowSvg(a, L + slot * (h + 0.5), T - IR + 8.5) + (o.bft ? bftSvg(a, L + slot * (h + 0.5), T - IR + 26) : ''); });
  if (o.now != null) s += `<line x1="${f1(x(o.now))}" y1="${T}" x2="${f1(x(o.now))}" y2="${T + plotH}" stroke="#111827" stroke-width="1" stroke-dasharray="3 3" stroke-opacity="0.45"/>`;
  for (const f of o.fc || []) s += `<path d="${monoPath(px(f.pts))}" fill="none" stroke="${f.color}" stroke-opacity="0.9" stroke-width="1.5" stroke-dasharray="4 3"/>`;
  if (o.b) for (const sg of segments(o.b)) s += `<path d="${monoPath(px(sg))}" fill="none" stroke="#C2410C" stroke-opacity="0.85" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  if (o.a) for (const sg of segments(o.a)) {
    const d = monoPath(px(sg));
    // podkres od čáry dolů k ose
    const base = f1(y(sc.lo)), x0 = f1(x(sg[0][0])), x1 = f1(x(sg[sg.length - 1][0]));
    const TT = st.v === 'temp'; // plocha slábne směrem k ose, u teploty barva podle hodnoty
    const fill = TT ? 'fill="url(#gT)" mask="url(#mF)"' : 'fill="url(#gF)"';
    s += `<path d="${d}L${x1} ${base}L${x0} ${base}Z" ${fill} stroke="none"/>`
      + `<path d="${d}" fill="none" stroke="url(#${TT ? 'gT' : 'gL'})" stroke-width="${o.thin ? 1.3 : 2.4}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  // část za srovnávaným úsekem (souhrn ji nezapočítává) je ztlumená
  { const DX = o.dimFromMin != null ? x(o.dimFromMin) : null; if (DX != null) s += `<rect x="${f1(DX)}" y="${T}" width="${f1(W - R - DX)}" height="${f1(plotH)}" fill="#fff" fill-opacity="0.72"/><line x1="${f1(DX)}" y1="${T}" x2="${f1(DX)}" y2="${T + plotH}" stroke="#6B7280" stroke-width="1" stroke-dasharray="3 3"/>`; }
  if (o.sel != null) {
    s += `<line x1="${f1(x(o.sel))}" y1="${T}" x2="${f1(x(o.sel))}" y2="${T + plotH}" stroke="#111827" stroke-width="1" stroke-opacity="0.5"/>`;
    const pa = nearestPt(o.a, o.sel), pb = nearestPt(o.b, o.sel);
    if (pb) s += `<circle cx="${f1(x(pb[0]))}" cy="${f1(y(pb[1]))}" r="3.5" fill="#fff" stroke="#C2410C" stroke-width="2"/>`;
    if (pa) s += `<circle cx="${f1(x(pa[0]))}" cy="${f1(y(pa[1]))}" r="4" fill="#fff" stroke="#10A9C4" stroke-width="2"/>`;
    for (const f of o.fc || []) { const q = nearestPt(f.pts, o.sel, 30); if (q) s += `<circle cx="${f1(x(q[0]))}" cy="${f1(y(q[1]))}" r="3" fill="#fff" stroke="${f.color}" stroke-width="1.5"/>`; }
  }
  s += '</svg>';
  el.innerHTML = s;
  return { L, slot, n: 24, fine: true };
}

function xAxis(scale, type, B) {
  const D = i => B[i] && B[i].d ? parseYmd(B[i].d) : null;
  // u hodin je popisek na hranici hodiny (14h = 14:00), bod hodinové hodnoty leží uprostřed hodiny
  if (scale === 'day') return { lab: i => i % 3 === 0 ? i + 'h' : '', grid: i => i % 6 === 0 && i > 0, edge: true };
  if (scale === 'week' && type === 'line') return { lab: i => i % 24 === 12 && D(i) ? DOW[D(i).getDay()] : '', grid: i => i % 24 === 0 && i > 0 };
  if (scale === 'week') return { lab: i => D(i) ? DOW[D(i).getDay()] : '', grid: () => false };
  if (scale === 'month') return { lab: i => [0, 4, 9, 14, 19, 24, 29].includes(i) ? (i + 1) + '.' : '', grid: () => false };
  if (type === 'bar') return { lab: i => MON[i] || '', grid: () => false };
  if (B[0] && B[0].k === 'w') {
    const has = (i, day) => { const b = B[i]; if (!b) return null; for (let d = parseYmd(b.d); ymd(d) <= b.e; d = addDays(d, 1)) if (d.getDate() === day) return d; return null; };
    return { lab: i => { const d = has(i, 15); return d ? MON[d.getMonth()] : ''; }, grid: i => i > 0 && !!has(i, 1) };
  }
  return { lab: i => D(i) && D(i).getDate() === 15 ? MON[D(i).getMonth()] : '', grid: i => i > 0 && D(i) && D(i).getDate() === 1 };
}
function bucketName(b, scale) {
  if (!b) return '';
  if (b.k === 'h') { const d = parseYmd(b.d); return (scale === 'day' ? '' : `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. `) + `${b.h}:00–${b.h + 1}:00`; }
  if (b.k === 'd') { const d = parseYmd(b.d); return `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`; }
  if (b.k === 'w') { const a = parseYmd(b.d), e = parseYmd(b.e); return `${isoWeek(a)}. týden · ${a.getDate()}. ${a.getMonth() + 1}.–${e.getDate()}. ${e.getMonth() + 1}. ${e.getFullYear()}`; }
  const [y, m] = b.m.split('-'); return MONL[+m - 1] + ' ' + y;
}

// ---------- vykreslení ----------
let model = null, current = null, cur = null, seq = 0;
const fmtU = (v, V, dec) => fmt(v, dec ?? V.dec) + (V.u ? ' ' + V.u : '');

function renderControls() {
  $('vars').innerHTML = VAR_ORDER.map(k => [k, VARS[k]]).map(([k, V]) => `<button class="chip${k === st.v ? ' on' : ''}" data-v="${k}" aria-pressed="${k === st.v}">${V.n}</button>`).join('');
  for (const b of $('scales').children) { const on = b.dataset.s === st.scale; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  for (const b of $('types').children) { const on = b.dataset.t === chartType(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  const V = VARS[st.v];
  $('modes').style.visibility = V.kind === 'sum' || (st.scale === 'day' && chartType() === 'line') ? 'hidden' : '';
  $('types').style.visibility = V.barOnly ? 'hidden' : '';
  for (const b of $('modes').children) { const on = b.dataset.m === curMode(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); b.hidden = b.dataset.m === 'min' && !!V.noMin; }
  $('modes').className = 'seg small ' + (V.noMin ? 's2m' : 's3');
  const t = today();
  const navHtml = (which, anchor) => {
    const p = periodOf(st.scale, anchor), lb = periodLabel(p);
    const nextDis = periodOf(st.scale, shift(st.scale, anchor, 1)).s > (which === 'a' ? maxDay() : t);
    const boxed = st.cmp ? ` boxed${which === 'b' ? ' b' : ''}` : '';
    const leg = st.cmp ? `<span class="leg${which === 'b' ? ' b' : ''}"></span>` : '';
    return `<div class="nav${boxed}">
<button class="iconbtn" data-nav="${which}" data-d="-1" aria-label="Předchozí období"><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg></button>
<button class="mid pick" data-pick="${which}" aria-label="Vybrat období"><span class="t">${leg}${esc(lb.t)}<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="margin-left:6px;vertical-align:middle;opacity:.6"><path d="M6 9l6 6 6-6"/></svg></span><span class="s">${esc(lb.s)}</span></button>
<button class="iconbtn" data-nav="${which}" data-d="1" aria-label="Následující období"${nextDis ? ' disabled' : ''}><svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg></button>
</div>`;
  };
  $('navs').innerHTML = navHtml('a', st.anchor) + (st.cmp ? '<div style="height:8px"></div>' + navHtml('b', st.cmp) : '');
  $('btnCmp').textContent = st.cmp ? 'Zrušit srovnání' : 'Srovnat s…';
  $('btnCmp').classList.toggle('dark', !!st.cmp);
  $('sumTitle').textContent = st.cmp ? 'Srovnání' : { day: 'Souhrn za den', week: 'Souhrn za týden', month: 'Souhrn za měsíc', year: 'Souhrn za rok' }[st.scale];
}

async function refresh() {
  const my = ++seq;
  renderControls();
  const pA = periodOf(st.scale, st.anchor), pB = st.cmp ? periodOf(st.scale, st.cmp) : null;
  const needH = st.scale === 'day' || st.scale === 'week';
  const load = async p => {
    const wantDet = st.scale === 'day' && p.s <= today();
    const [h, d, det] = await Promise.all([needH ? getRange('hourly', p.s, p.e).then(x => st.v === 'rain' ? applyRain5(x) : x) : [], getRange('daily', p.s, p.e),
      wantDet ? dayDetail(ymd(p.s)).catch(() => null) : null]);
    await ecoPatch(h, d);
    return { p, h, d, ext: det && det.ext ? det.ext : null, fine: det && det.fine && det.fine.t.length ? det.fine : null };
  };
  setBusy(1);
  // když načítání trvá, nenechávat v grafu data předchozího období
  const ph = setTimeout(() => {
    if (my !== seq) return;
    model = null; current = null;
    $('chart').innerHTML = '<div class="empty">Načítám data…<br>Starší období se stahují z Weather Underground, může to chvíli trvat.</div>';
    $('summary').innerHTML = ''; $('info').innerHTML = '';
  }, 250);
  try {
    const fcP = loadForecasts().catch(() => ({}));
    const icP = iconsWanted() ? fcGet('yr').catch(() => null) : Promise.resolve(null);
    const wdP = iconsWanted() && (st.v === 'wind' || st.v === 'gust') ? fcGet('aladin').catch(() => null) : Promise.resolve(null);
    const [A, B] = await Promise.all([load(pA), pB ? load(pB) : null]);
    clearTimeout(ph);
    if (my !== seq) return;
    model = { A, B, fc: {} }; showErr(''); draw();
    const fc = await fcP;
    if (my !== seq || !model) return;
    const ic = await icP, wd = await wdP;
    if (my !== seq || !model) return;
    model.fc = { ...(model.fc || {}), ...fc }; model.icons = ic; model.windFc = wd;
    if (Object.keys(fc).length || ic || wd) draw();
  } catch (err) {
    if (my !== seq) return;
    model = null; current = null; showErr(err.message);
    $('chart').innerHTML = '<div class="empty">Data se nepodařilo načíst.</div>'; $('summary').innerHTML = ''; $('info').innerHTML = '';
  } finally { clearTimeout(ph); setBusy(-1); }
}

function extraVals(a, b) {
  if (VARS[st.v].kind === 'sum') return null;
  const out = [], noMin = VARS[st.v].noMin;
  for (const X of [a, b]) if (X) for (const x of X.vals) out.push(x.hi, noMin ? x.avg : x.lo);
  return out;
}
// záření a UV: WU posílá za hodinu jen maximum, proto se max / min / průměr hodiny počítají z měření po 5 minutách
function fineHours(X, src) {
  if (!src || !src.fine) return;
  const vv = src.fine.v[st.v] || [], by = Array.from({ length: 24 }, () => []);
  ((st.v === 'press' && src.fine.tp) || src.fine.t).forEach((t, i) => { if (vv[i] != null) by[Math.floor(t / 60)].push(vv[i]); });
  const mode = curMode();
  by.forEach((xs, h) => {
    if (!xs.length || !X.vals[h]) return;
    const hi = Math.max(...xs), lo = Math.min(...xs), avg = xs.reduce((p, q) => p + q, 0) / xs.length;
    X.vals[h] = { val: mode === 'max' ? hi : mode === 'min' ? lo : avg, hi, lo, avg };
  });
}
// sloupec probíhající hodiny z podrobných měření a aktuálního měření (hodinový záznam WU se objevuje se zpožděním)
function liveHour(a) {
  if (dayDiff(today(), st.anchor) !== 0 || !model.A.fine) return;
  const F = model.A.fine, vv = F.v[st.v] || [], pts = [];
  ((st.v === 'press' && F.tp) || F.t).forEach((t, i) => { if (vv[i] != null) pts.push([t, vv[i]]); });
  // probíhající hodina se počítá jen z pětiminutových dat, bez okamžitého měření
  if (!pts.length) return;
  const h = Math.floor(pts[pts.length - 1][0] / 60), inH = pts.filter(p => Math.floor(p[0] / 60) === h);
  if (!inH.length || !a.vals[h]) return;
  let v;
  if (st.v === 'rain') {
    const before = pts.filter(p => p[0] < h * 60), c0 = before.length ? before[before.length - 1][1] : 0;
    const sum = r2(Math.max(0, inH[inH.length - 1][1] - c0)); v = { val: sum, hi: sum, lo: sum, avg: sum };
  } else {
    const xs = inH.map(p => p[1]), hi = Math.max(...xs), lo = Math.min(...xs), avg = xs.reduce((p, q) => p + q, 0) / xs.length;
    const mode = curMode(); v = { val: mode === 'max' ? hi : mode === 'min' ? lo : avg, hi, lo, avg };
  }
  a.vals[h] = v;
}
function chartOpts(a, b) {
  const type = chartType(), V = VARS[st.v];
  const n = Math.max(a.Bk.length, b ? b.Bk.length : 0);
  const padTo = arr => { const r = arr.slice(); while (r.length < n) r.push(null); return r; };
  const ax = xAxis(st.scale, type, b && b.Bk.length > a.Bk.length ? b.Bk : a.Bk);
  const series = [{ vals: padTo(a.vals.map(x => x.val)), band: !b && type === 'line' && V.kind === 'hla' && st.scale !== 'week' ? padTo(a.vals.map(x => x.hi == null ? null : [x.hi, V.noMin ? x.avg : x.lo])) : null }];
  if (b) series.push({ vals: padTo(b.vals.map(x => x.val)) });
  const wv = st.v === 'wind' || st.v === 'gust';
  const o = { type, n, series, icons: st.scale === 'day' && !b && !wv ? iconRow() : null, arrows: st.scale === 'day' && !b && wv ? windRow() : null, bft: st.v === 'wind', thin: st.v === 'wind' || st.v === 'gust', cap: V.cap, xEdge: !!ax.edge, extra: extraVals(a, b), zero: !!V.zero, dec: V.dec, xLabel: ax.lab, xGrid: ax.grid, sel: st.sel, aria: `${V.n}, ${periodLabel(model.A.p).t}` };
  if (!b && type === 'line') { o.area = st.scale === 'week'; o.tempColor = st.v === 'temp'; }
  const cutAB = b ? Math.min(elapsedCut(model.A.p), elapsedCut(model.B.p)) : Infinity;
  if (b && isFinite(cutAB)) { const lb = b.Bk.length > a.Bk.length ? [b.Bk, model.B.p] : [a.Bk, model.A.p]; o.dimFrom = cutIndex(lb[0], lb[1], cutAB); }
  const future = st.scale === 'day' && !b && st.anchor > today();
  // čárový graf dne z podrobných měření
  if (st.scale === 'day' && type === 'line' && (model.A.fine || future || (b && model.B && model.B.fine))) {
    const toPts = (X, isToday) => {
      if (!X || !X.fine) return null;
      const vv = X.fine.v[st.v] || [], pts = [];
      ((st.v === 'press' && X.fine.tp) || X.fine.t).forEach((t, i) => { if (vv[i] != null) pts.push([t, vv[i]]); });
      if (isToday && cur && String(cur.obsTimeLocal || '').startsWith(ymd(today()))) {
        const m = cur.metric || {}, cv = num({ temp: m.temp, dew: m.dewpt, hum: cur.humidity, press: m.pressure, wind: m.windSpeed, gust: m.windGust, solar: cur.solarRadiation, uv: cur.uv, rain: m.precipTotal }[st.v]);
        const ct = String(cur.obsTimeLocal).slice(11, 16).split(':').map(Number), mi = ct[0] * 60 + ct[1];
        if (cv != null && (!pts.length || mi > pts[pts.length - 1][0] + 2)) { pts.push([mi, cv]); pts.live = true; }
      }
      return pts.length ? pts : null;
    };
    const isT = dayDiff(today(), st.anchor) === 0;
    const isWind = st.v === 'wind' || st.v === 'gust';
    const fo = { fine: true, icons: isWind ? null : iconRow(), arrows: isWind ? windRow() : null, bft: st.v === 'wind', thin: st.v === 'wind' || st.v === 'gust', cap: V.cap, a: toPts(model.A, isT), b: b ? toPts(model.B, false) : null, zero: !!V.zero, dec: V.dec, sel: st.sel, aria: `${V.n}, ${periodLabel(model.A.p).t}` };
    if (b && isFinite(cutAB) && cutAB < 24) fo.dimFromMin = cutAB * 60;
    if (fcApplicable()) fo.fc = fcFine(model.fc || {}, ymd(st.anchor), st.v);
    if (isT && !b) { const nw = new Date(); fo.now = nw.getHours() * 60 + nw.getMinutes(); }
    if (future) fo.emptyMsg = !FC_VARS.includes(st.v) ? 'Předpověď pro tuto veličinu není k dispozici.'
      : !fcModels.length ? 'Nejsou vybrané žádné modely předpovědi (nastavení).'
      : !fcModels.some(k => fcOn.includes(k)) ? 'Zapněte některý model pod grafem.'
      : cfg.lat == null ? 'Čekám na polohu stanice…' : 'Načítám předpověď…';
    return fo;
  }
  // sloupec probíhající hodiny je úzký podle uplynulé části hodiny
  if (st.scale === 'day' && type === 'bar' && !b && dayDiff(today(), st.anchor) === 0) {
    let mi = null;
    if (cur && String(cur.obsTimeLocal || '').startsWith(ymd(today()))) { const ct = String(cur.obsTimeLocal).slice(11, 16).split(':').map(Number); mi = ct[0] * 60 + ct[1]; }
    if (mi == null) { const nw = new Date(); mi = nw.getHours() * 60 + nw.getMinutes(); }
    o.partial = { i: Math.floor(mi / 60), frac: Math.max(0.08, (mi % 60) / 60) };
  }
  // probíhající den (týden, měsíc) nebo měsíc (rok) má sloupec široký podle uplynulé části
  if (st.scale !== 'day' && type === 'bar' && !b) {
    const t = today(), nw = new Date(), dayFrac = (nw.getHours() * 60 + nw.getMinutes()) / 1440;
    const i = a.Bk.findIndex(k => k.k === 'd' ? k.d === ymd(t) : k.k === 'm' && k.m === ymd(t).slice(0, 7));
    if (i >= 0) {
      const dim = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
      o.partial = { i, frac: Math.max(0.08, a.Bk[i].k === 'm' ? (t.getDate() - 1 + dayFrac) / dim : dayFrac) };
    }
  }
  if (fcApplicable() && type === 'line') {
    o.fc = fcSeries(model.fc || {}, a.Bk, st.v);
    if (dayDiff(today(), st.anchor) === 0) { const nw = new Date(); o.now = nw.getHours() + nw.getMinutes() / 60; }
  }
  if (st.scale === 'day' && !b && type === 'line' && dayDiff(today(), st.anchor) === 0 && cur && cur.obsTimeLocal && String(cur.obsTimeLocal).startsWith(ymd(today()))) {
    const m = cur.metric || {}, cv = { temp: m.temp, dew: m.dewpt, hum: cur.humidity, press: m.pressure, wind: m.windSpeed, gust: m.windGust, solar: cur.solarRadiation, uv: cur.uv }[st.v];
    const ct = String(cur.obsTimeLocal).slice(11, 16).split(':').map(Number);
    if (num(cv) != null) o.tail = { x: ct[0] + ct[1] / 60, v: num(cv) };
  }
  if (future) o.emptyMsg = !FC_VARS.includes(st.v) ? 'Předpověď pro tuto veličinu není k dispozici.'
    : type !== 'line' ? 'Předpověď se zobrazuje jen v čárovém grafu.'
    : !fcModels.length ? 'Nejsou vybrané žádné modely předpovědi (nastavení).'
    : !fcModels.some(k => fcOn.includes(k)) ? 'Zapněte některý model pod grafem.'
    : cfg.lat == null ? 'Čekám na polohu stanice…' : 'Načítám předpověď…';
  return o;
}
function draw() {
  if (!model) return;
  const { A, B } = model;
  const mk = X => { const Bk = buildBuckets(st.scale, chartType(), X.p); fillBuckets(Bk, X.h, X.d); return { Bk, vals: bucketVals(Bk, st.v, curMode()) }; };
  const a = mk(A), b = B ? mk(B) : null;
  if (st.scale === 'day' && chartType() === 'bar' && VARS[st.v].kind === 'max') { fineHours(a, A); if (b) fineHours(b, B); }
  if (!B && st.scale === 'day' && chartType() === 'bar') liveHour(a);
  if (st.sel != null && !(st.scale === 'day' && chartType() === 'line') && st.sel >= Math.max(a.Bk.length, b ? b.Bk.length : 0)) st.sel = null;
  const o = chartOpts(a, b);
  current = { a, b, fc: o.fc || null, fineO: o.fine ? o : null, geo: o.fine ? drawFine($('chart'), o) : drawChart($('chart'), o) };
  renderFcBar(); renderInfo(); renderSummary();
}
// při posouvání prstem se překresluje jen graf a řádek s hodnotami
function drawGraphOnly() {
  if (!current || !model) return;
  const o = chartOpts(current.a, current.b);
  current.fc = o.fc || null; current.fineO = o.fine ? o : null; current.geo = o.fine ? drawFine($('chart'), o) : drawChart($('chart'), o);
  renderInfo();
}
function renderFcBar() {
  const el = $('fcbar');
  if (!fcApplicable() || chartType() !== 'line' || !fcModels.length) { el.hidden = true; el.innerHTML = ''; return; }
  const stt = fcStat();
  el.hidden = false;
  el.innerHTML = '<span class="fcl">Předpověď:</span>' + fcModels.map(k => {
    const m = MODEL[k], on = fcOn.includes(k), bad = stt[k] === 'nodata';
    return `<button class="fcb${on && !bad ? ' on' : ''}${bad ? ' bad' : ''}" data-fc="${k}" aria-pressed="${on}" style="--c:${m.c}"${bad ? ' title="Pro vaši polohu nemá data"' : ''}>${esc(m.n)}${bad ? ' ✕' : ''}</button>`;
  }).join('');
}
function fcTableHtml(fc, Bk, v, title) {
  const V = VARS[v], rows = fcSeries(fc, Bk, v);
  if (!rows.length) return '';
  const cols = v === 'rain' ? [['Úhrn', x => x.sum]] : V.noMin ? [['Maximum', x => x.hi], ['Průměr', x => x.avg]] : [['Maximum', x => x.hi], ['Minimum', x => x.lo], ['Průměr', x => x.avg]];
  const st2 = vals => { const a = vals.filter(x => x != null); if (!a.length) return {}; return { hi: Math.max(...a), lo: Math.min(...a), avg: a.reduce((p, q) => p + q, 0) / a.length, sum: a.reduce((p, q) => p + q, 0) }; };
  return `<h2 style="margin:0 0 8px">${esc(title)}</h2><table class="cmp fct"><thead><tr><th>model</th>${cols.map(c => `<th>${c[0]}</th>`).join('')}</tr></thead><tbody>`
    + rows.map(r => { const x = st2(r.vals); return `<tr><td style="color:${r.color};font-weight:700">${esc(r.n)}</td>${cols.map(c => `<td>${fmt(c[1](x), V.dec)}${V.u ? ' ' + esc(V.u) : ''}</td>`).join('')}</tr>`; }).join('')
    + '</tbody></table>';
}

function renderInfo() {
  const el = $('info'), c = current, V = VARS[st.v];
  if (!c || !c.geo || st.sel == null) { el.innerHTML = '<span class="hint">Podržte prst na grafu a posouváním zobrazíte hodnoty · rychlým přejetím do strany změníte období</span>'; return; }
  if (c.geo.fine) {
    const fo = c.fineO, pa = nearestPt(fo.a, st.sel), pb = nearestPt(fo.b, st.sel);
    const val = p => p ? fmtU(p[1], V) : 'bez dat';
    let t = `<div class="il a"><b>${hhmm(pa ? pa[0] : st.sel)}</b> · ${val(pa)}${V.kind === 'sum' ? ' od půlnoci' : ''}</div>`;
    if (fo.b) t += `<div class="il b"><b>${esc(periodLabel(model.B.p).t)}</b> · ${val(pb)}</div>`;
    const fcs = (fo.fc || []).map(f => { const q = nearestPt(f.pts, st.sel, 30); return q ? { f, q } : null; }).filter(Boolean);
    if (fcs.length) t += `<div class="muted" style="font-size:12px;margin-top:2px">Předpověď ${hhmm(fcs[0].q[0])}: ${fcs.map(({ f, q }) => `<span style="color:${f.color};font-weight:600">${esc(f.n)}</span> ${fmt(q[1], V.dec)}`).join(' · ')}</div>`;
    el.innerHTML = `<div>${t}</div>`;
    return;
  }
  const i = st.sel;
  const line = (X, cls) => {
    const bk = X.Bk[i]; if (!bk) return '';
    const v = X.vals[i];
    let t = `<b>${esc(bucketName(bk, st.scale))}</b>: ${v.val == null ? 'bez dat' : fmtU(v.val, V)}`;
    if (!st.cmp && V.kind === 'hla' && v.hi != null) t += ` <span class="muted">(max ${fmt(v.hi, V.dec)}${V.noMin ? '' : ' · min ' + fmt(v.lo, V.dec)} · prům. ${fmt(v.avg, V.dec)})</span>`;
    return `<div class="il ${cls}">${t}</div>`;
  };
  const bk = c.a.Bk[i];
  const drill = bk && (bk.k === 'd' || bk.k === 'm') ? `<button class="drill" id="btnDrill">${bk.k === 'd' ? 'Den' : 'Měsíc'} ›</button>` : '';
  const fcl = c.fc && c.fc.length ? `<div class="muted" style="font-size:12px;margin-top:2px">${c.fc.filter(f => f.vals[i] != null).map(f => `<span style="color:${f.color};font-weight:600">${esc(f.n)}</span> ${fmt(f.vals[i], V.dec)}`).join(' · ')}</div>` : '';
  el.innerHTML = `<div>${line(c.a, 'a')}${c.b ? line(c.b, 'b') : ''}${fcl}</div>${drill}`;
  if (drill) $('btnDrill').onclick = () => {
    const toDate = x => x.k === 'd' ? parseYmd(x.d) : parseYmd(x.m + '-01');
    const bb = c.b && c.b.Bk[i];
    st.scale = bk.k === 'd' ? 'day' : 'month';
    st.anchor = toDate(bk);
    if (st.cmp) st.cmp = bb ? toDate(bb) : yearAgo(st.anchor);
    st.sel = null; saveView(); refresh();
  };
}

function renderSummary() {
  const el = $('summary'), V = VARS[st.v];
  if (!model) { el.innerHTML = ''; return; }
  const { A, B } = model;
  const fcCard = $('fcCard'), dd = dayDiff(today(), st.anchor);
  const fcHtml = fcApplicable() && chartType() === 'line' && current ? fcTableHtml(model.fc || {}, current.a.Bk, st.v, 'Předpověď na celý den') : '';
  $('btnCmp').hidden = st.scale === 'day' && dd > 0 && !B;
  if (!B && st.scale === 'day' && dd > 0) {
    fcCard.hidden = true;
    $('sumTitle').textContent = 'Předpověď na celý den';
    el.innerHTML = fcHtml ? fcHtml.replace(/^<h2[^>]*>.*?<\/h2>/, '') : '<p class="note">Předpověď je k dispozici pro teplotu, srážky, vítr, nárazy a tlak v čárovém grafu.</p>';
    return;
  }
  fcCard.hidden = !fcHtml || !!B; fcCard.innerHTML = fcHtml;
  if (!B) {
    const items = summary(st.v, st.scale, A.h, A.d);
    const ex = A.ext && A.ext[st.v];
    if (ex && st.scale === 'day') for (const it of items) {
      // podrobná měření se použijí, jen když nejsou zjevně neúplná (extrém musí být aspoň takový jako z hodinových dat)
      if (it.id === 'max' && ex.hi != null && (it.val == null || ex.hi >= it.val - 0.3)) { it.val = ex.hi; it.atText = 'v ' + ex.hiT; }
      if (it.id === 'min' && ex.lo != null && (it.val == null || ex.lo <= it.val + 0.3)) { it.val = ex.lo; it.atText = 'v ' + ex.loT; }
    }
    if (!A.d.length && !A.h.length) { el.innerHTML = '<p class="note">Pro toto období nejsou žádná data.</p>'; return; }
    const src = st.v === 'rain' && (st.scale === 'day' || st.scale === 'week') && rainSrc ? `<p class="note" style="margin:10px 0 0">${esc(rainSrc)}</p>` : '';
    el.innerHTML = '<div class="tiles">' + items.map(it => `<div class="st"><span class="l">${esc(it.l)}</span><span class="v ${it.cls || ''}">${fmt(it.val, it.dec)}${it.val != null && it.u ? ' ' + esc(it.u) : ''}</span><span class="n">${esc(it.atText || (it.at ? fmtAt(it.at, st.scale) : (it.n || '')))}</span></div>`).join('') + '</div>' + src;
    return;
  }
  const cut = Math.min(elapsedCut(A.p), elapsedCut(B.p));
  const a = cutRecs(A, cut), b = cutRecs(B, cut);
  const ia = summary(st.v, st.scale, a.h, a.d), ib = summary(st.v, st.scale, b.h, b.d);
  const yA = periodLabel(A.p).t, yB = periodLabel(B.p).t;
  let note = '';
  if (isFinite(cut)) note = st.scale === 'day' ? `Srovnáno za stejnou dobu: 0:00–${cut}:00.` : `Srovnáno za stejný úsek: prvních ${Math.ceil(cut / 24)} ${Math.ceil(cut / 24) === 1 ? 'den' : Math.ceil(cut / 24) < 5 ? 'dny' : 'dní'}.`;
  const short = t => t.length > 14 ? t.replace(/^\S+ /, '') : t;
  el.innerHTML = (note ? `<p class="note">${esc(note)}</p>` : '') +
    `<table class="cmp"><thead><tr><th></th><th class="a">${esc(short(yA))}</th><th class="b">${esc(short(yB))}</th><th>rozdíl</th></tr></thead><tbody>` +
    ia.map((it, k) => {
      const jb = ib[k], d = it.val != null && jb && jb.val != null ? it.val - jb.val : null;
      const ds = d == null ? '–' : (d > 0 ? '+' : '') + fmt(d, it.dec);
      return `<tr><td>${esc(it.l)}</td><td>${fmt(it.val, it.dec)}</td><td>${fmt(jb ? jb.val : null, it.dec)}</td><td>${ds}</td></tr>`;
    }).join('') + `</tbody></table><p class="note" style="margin:8px 0 0">Jednotky: ${esc(V.u || 'index UV')}</p>`;
}

const DIRS = ['S', 'SV', 'V', 'JV', 'J', 'JZ', 'Z', 'SZ'];
function renderCurrent() {
  if (!cur) { $('now').innerHTML = ''; return; }
  const m = cur.metric || {};
  const tiles = [
    ['Teplota', fmt(num(m.temp), 1), '°C'], ['Vlhkost', fmt(num(cur.humidity), 0), '%'],
    ['Tlak', fmt(num(m.pressure), 1), 'hPa'], ['Srážky dnes', fmt(num(m.precipTotal), 1), 'mm'],
    ['Vítr', fmt(num(m.windSpeed), 1), 'km/h' + (num(cur.winddir) != null ? ' · ' + DIRS[Math.round(cur.winddir / 45) % 8] : '')],
    ['Nárazy', fmt(num(m.windGust), 1), 'km/h'], ['Záření', fmt(num(cur.solarRadiation), 0), 'W/m²'], ['UV', fmt(num(cur.uv), 1), '']
  ];

  $('now').innerHTML = tiles.map(([l, v, u]) => `<div class="tile"><span class="l">${l}</span><span class="v">${v}</span><span class="u">${u || '&nbsp;'}</span></div>`).join('');
  const nb = cur.neighborhood ? cur.neighborhood + ' · ' : '';
  void nb;
  renderStatus();
}
function renderStatus() {
  const s = $('status');
  let txt = '', warn = false;
  if (cur && cur.epoch) {
    const age = Date.now() - cur.epoch * 1000, hm = String(cur.obsTimeLocal || '').slice(11, 16);
    if (age > 30 * 60e3) { warn = true; txt = `Stanice neposílá data od ${String(cur.obsTimeLocal || '').slice(0, 16)}.`; }
    else txt = `Poslední měření ${hm}`;
  }
  if (!warn && s.dataset.note) txt = s.dataset.note;
  const t = today(), dt = `${DOWL[t.getDay()]} ${t.getDate()}. ${t.getMonth() + 1}. ${t.getFullYear()}`;
  // aktuální datum pod nadpisem, ve stavovém řádku jen čas měření
  $('stationName').innerHTML = `<span class="today">${esc(dt.charAt(0).toUpperCase() + dt.slice(1))}</span>`;
  s.textContent = txt; s.classList.toggle('warn', warn);
}
// poloha stanice pro předpovědi; vrací true, když byla zjištěna poprvé
function setCoords(o) {
  const la = num(o.lat), lo = num(o.lon);
  if (la == null || lo == null || (cfg.lat === la && cfg.lon === lo)) return false;
  const first = cfg.lat == null; cfg.lat = la; cfg.lon = lo; LS.set('meteo.cfg', cfg);
  return first;
}
async function loadCurrent() {
  try {
    const o = (await wuGet('observations/current'))[0];
    if (o) {
      if (ecoReady()) {
        o.metric = o.metric || {}; o.metric.pressure = null;
        try {
          const x = await ecoGet('real_time', { call_back: 'outdoor,pressure' });
          o.metric.pressure = mslp(ecoVal(x.pressure && x.pressure.absolute), ecoVal(x.outdoor && x.outdoor.temperature), ecoVal(x.outdoor && x.outdoor.humidity));
        } catch (err) { note('Tlak z Ecowittu: ' + err.message); }
      }
      cur = o; renderCurrent();
      // konec křivky dneška se posune k novému okamžitému měření
      if (model && st.scale === 'day' && !st.cmp && dayDiff(today(), st.anchor) === 0) draw();
      if (setCoords(o) && st.scale === 'day') refresh();
    }
  }
  catch (err) { note(err.message); }
}

// ---------- panely (nastavení, výběr období); systémové tlačítko Zpět je zavře ----------
function openSheet(id) {
  $(id).hidden = false;
  try { history.pushState({ sheet: id }, ''); } catch { }
}
function closeSheet(id) {
  if ($(id).hidden) return;
  $(id).hidden = true;
  try { if (history.state && history.state.sheet === id) history.back(); } catch { }
}
window.addEventListener('popstate', () => { for (const id of ['settings', 'picker']) $(id).hidden = true; });

// ---------- výběr období rolovacími kolečky ----------
const ROW = 40;
function weeksInYear(y) { return isoWeek(new Date(y, 11, 28)); }
function isoMonday(y, w) { const j4 = new Date(y, 0, 4); return addDays(j4, -((j4.getDay() + 6) % 7) + 7 * (w - 1)); }
function isoYear(d) { return addDays(d, 3 - ((d.getDay() + 6) % 7)).getFullYear(); }
function makeWheel(el, items, idx, onSettle) {
  const w = { el, items, idx, onSettle };
  const render = () => {
    el.innerHTML = '<div class="wpad"></div>' + w.items.map((it, i) => `<div class="witem${i === w.idx ? ' on' : ''}" data-i="${i}">${esc(it.l)}</div>`).join('') + '<div class="wpad"></div>';
    el.scrollTop = w.idx * ROW;
  };
  let t = null;
  el.onscroll = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const i = Math.max(0, Math.min(w.items.length - 1, Math.round(el.scrollTop / ROW)));
      if (Math.abs(el.scrollTop - i * ROW) > 1) el.scrollTo({ top: i * ROW, behavior: 'smooth' });
      if (i !== w.idx) { w.idx = i; for (const c of el.querySelectorAll('.witem')) c.classList.toggle('on', Number(c.dataset.i) === i); w.onSettle && w.onSettle(); }
    }, 110);
  };
  el.onclick = e => { const c = e.target.closest('.witem'); if (c) el.scrollTo({ top: Number(c.dataset.i) * ROW, behavior: 'smooth' }); };
  w.set = (items, idx) => { w.items = items; w.idx = Math.max(0, Math.min(items.length - 1, idx)); render(); };
  w.val = () => w.items[w.idx].v;
  render(); return w;
}
function openPicker(which) {
  const a = which === 'b' ? st.cmp : st.anchor, t = today(), ty = t.getFullYear(), sc = st.scale;
  const years = []; for (let y = 2000; y <= ty; y++) years.push({ v: y, l: String(y) });
  const box = $('pkWheels'); box.innerHTML = '';
  const col = cls => { const d = document.createElement('div'); d.className = 'wheel ' + (cls || ''); box.appendChild(d); return d; };
  $('pkTitle').textContent = which === 'b' ? 'Srovnávané období' : (st.cmp ? 'První období' : 'Vybrat období');
  let get;
  if (sc === 'year') {
    const wy = makeWheel(col(), years, a.getFullYear() - 2000);
    get = () => new Date(wy.val(), 0, 1);
  } else if (sc === 'month') {
    const wm = makeWheel(col('wide'), MONL.map((m, i) => ({ v: i, l: m })), a.getMonth());
    const wy = makeWheel(col(), years, a.getFullYear() - 2000);
    get = () => new Date(wy.val(), wm.val(), 1);
  } else if (sc === 'week') {
    const iy = isoYear(a);
    const weekItems = y => { const r = []; for (let w = 1; w <= weeksInYear(y); w++) { const m = isoMonday(y, w), e = addDays(m, 6); r.push({ v: w, l: `${w}. týden · ${m.getDate()}. ${m.getMonth() + 1}.–${e.getDate()}. ${e.getMonth() + 1}.` }); } return r; };
    let wy;
    const ww = makeWheel(col('wide'), weekItems(iy), isoWeek(a) - 1);
    wy = makeWheel(col(), years, Math.min(iy, ty) - 2000, () => ww.set(weekItems(wy.val()), ww.idx));
    get = () => isoMonday(wy.val(), ww.val());
  } else {
    const dayItems = (y, m) => { const r = []; const n = new Date(y, m + 1, 0).getDate(); for (let d = 1; d <= n; d++) r.push({ v: d, l: `${d}. ${DOW[new Date(y, m, d).getDay()]}` }); return r; };
    let wm, wy;
    const wd = makeWheel(col(), dayItems(a.getFullYear(), a.getMonth()), a.getDate() - 1);
    const upd = () => wd.set(dayItems(wy.val(), wm.val()), wd.idx);
    wm = makeWheel(col('wide'), MONL.map((m, i) => ({ v: i, l: m })), a.getMonth(), () => upd());
    wy = makeWheel(col(), years, a.getFullYear() - 2000, () => upd());
    get = () => clampDay(wy.val(), wm.val(), wd.val());
  }
  $('pkToday').onclick = () => {
    if (which === 'b') st.cmp = today(); else st.anchor = today();
    closeSheet('picker'); st.sel = null; refresh();
  };
  $('pkOk').onclick = () => {
    let d = get(); const mx = which === 'b' ? t : maxDay(); if (d > mx) d = mx;
    if (which === 'b') st.cmp = d; else st.anchor = d;
    closeSheet('picker'); st.sel = null; refresh();
  };
  openSheet('picker');
  // po zobrazení znovu nastavit polohy koleček (skryté prvky nemají rozměry)
  for (const w of box.querySelectorAll('.wheel')) { const on = w.querySelector('.witem.on'); if (on) w.scrollTop = Number(on.dataset.i) * ROW; }
}

// ---------- ovládání ----------
function navigate(which, d) {
  if (which === 'a' || which === 'both') st.anchor = shift(st.scale, st.anchor, d);
  if (st.cmp && (which === 'b' || which === 'both')) st.cmp = shift(st.scale, st.cmp, d);
  const t = today();
  if (periodOf(st.scale, st.anchor).s > maxDay()) st.anchor = maxDay();
  if (st.cmp && periodOf(st.scale, st.cmp).s > t) st.cmp = t;
  st.sel = null; refresh();
}
const zoomed = () => !!(window.visualViewport && window.visualViewport.scale > 1.02);
function bindUI() {
  $('vars').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    st.v = b.dataset.v; st.sel = null; saveView();
    if ((st.v === 'rain' && (st.scale === 'day' || st.scale === 'week')) || ((st.v === 'wind' || st.v === 'gust') && iconsWanted() && !(model && model.windFc))) refresh(); else { renderControls(); draw(); fillFc(); }
  });
  $('scales').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b || b.dataset.s === st.scale) return; st.scale = b.dataset.s; st.sel = null; saveView(); refresh(); });
  $('types').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; st.charts[st.v] = b.dataset.t; st.sel = null; saveView(); renderControls(); draw(); });
  $('modes').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; st.modes[st.v] = b.dataset.m; saveView(); renderControls(); draw(); });
  $('navs').addEventListener('click', e => {
    const pk = e.target.closest('[data-pick]'); if (pk) { openPicker(pk.dataset.pick); return; }
    const b = e.target.closest('[data-nav]'); if (!b || b.disabled) return; navigate(b.dataset.nav, Number(b.dataset.d));
  });
  $('pkCancel').onclick = () => { closeSheet('picker'); };
  $('picker').addEventListener('click', e => { if (e.target === $('picker')) closeSheet('picker'); });
  $('btnCmp').onclick = () => { st.cmp = st.cmp ? null : yearAgo(st.anchor > today() ? today() : st.anchor); if (st.cmp && st.anchor > today()) st.anchor = today(); st.sel = null; refresh(); };
  $('fcbar').addEventListener('click', async e => {
    const b = e.target.closest('[data-fc]'); if (!b) return;
    const k = b.dataset.fc;
    fcOn = fcOn.includes(k) ? fcOn.filter(x => x !== k) : fcOn.concat(k); LS.set('meteo.fcon', fcOn);
    if (fcOn.includes(k) && model && !(model.fc || {})[k]) {
      draw();
      try { const e2 = await fcGet(k); if (model) { model.fc = { ...(model.fc || {}), [k]: e2 }; } } catch { }
    }
    draw();
  });
  $('fcModels').addEventListener('change', e => {
    const c = e.target.closest('input[data-m]'); if (!c) return;
    const k = c.dataset.m;
    fcModels = MODELS.map(m => m.k).filter(x => x === k ? c.checked : fcModels.includes(x)); LS.set('meteo.fcmodels', fcModels);
    if (c.checked && !fcOn.includes(k)) { fcOn = fcOn.concat(k); LS.set('meteo.fcon', fcOn); }
    refresh();
  });
  // graf: podržení prstu = svislá čára s hodnotami, kterou lze posouvat; rychlé přejetí do strany = jiné období; klepnutí = skrýt čáru
  const ch = $('chart'); let press = null, lastTouch = 0;
  const selectAt = x => {
    if (!current || !current.geo) return;
    const r = ch.getBoundingClientRect(), g = current.geo;
    if (g.fine) {
      let mi = Math.max(0, Math.min(1439, (x - r.left - g.L) / g.slot * 60));
      const fo = current.fineO, p = nearestPt(fo && fo.a, mi) || nearestPt(fo && fo.b, mi);
      mi = p ? p[0] : Math.round(mi / 5) * 5;
      if (mi !== st.sel) { st.sel = mi; drawGraphOnly(); }
      return;
    }
    const i = Math.max(0, Math.min(g.n - 1, Math.floor((x - r.left - g.L) / g.slot)));
    if (i !== st.sel) { st.sel = i; drawGraphOnly(); }
  };
  const begin = (x, y) => {
    press = { x, y, lx: x, t: Date.now(), scrub: false, moved: false };
    if (zoomed()) return; // při přiblížené stránce se svislá čára nezobrazuje, prst jen posouvá obraz
    press.timer = setTimeout(() => { if (!press || press.moved) return; press.scrub = true; ch.classList.add('scrub'); try { navigator.vibrate && navigator.vibrate(8); } catch { } selectAt(press.lx); }, 280);
  };
  const move = (x, y, ev) => {
    if (!press) return; press.lx = x;
    if (press.scrub) { if (ev && ev.cancelable) ev.preventDefault(); selectAt(x); return; }
    if (Math.abs(x - press.x) > 10 || Math.abs(y - press.y) > 10) { press.moved = true; clearTimeout(press.timer); }
  };
  const end = (x, y) => {
    if (!press) return; clearTimeout(press.timer); ch.classList.remove('scrub');
    const p = press; press = null;
    if (p.scrub) return; // čára zůstane na posledním místě
    const dx = x - p.x, dy = y - p.y, dt = Date.now() - p.t;
    if (!zoomed() && Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 800) { navigate('both', dx > 0 ? -1 : 1); return; }
    if (!p.moved && st.sel != null) { st.sel = null; drawGraphOnly(); }
  };
  ch.addEventListener('touchstart', e => { lastTouch = Date.now(); const t = e.touches[0]; if (e.touches.length === 1) begin(t.clientX, t.clientY); else { clearTimeout(press && press.timer); press = null; } }, { passive: true });
  ch.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY, e); }, { passive: false });
  ch.addEventListener('touchend', e => { lastTouch = Date.now(); const t = e.changedTouches[0]; end(t.clientX, t.clientY); });
  ch.addEventListener('touchcancel', () => { if (press) clearTimeout(press.timer); press = null; ch.classList.remove('scrub'); });
  ch.addEventListener('contextmenu', e => e.preventDefault());
  // přiblížená stránka: graf se dá posouvat všemi směry a přejetí do strany nemění období
  const updZoom = () => { ch.style.touchAction = zoomed() ? 'pan-x pan-y pinch-zoom' : ''; };
  if (window.visualViewport) window.visualViewport.addEventListener('resize', updZoom);
  ch.addEventListener('touchend', updZoom);
  // myš (počítač)
  ch.addEventListener('mousedown', e => { if (e.button === 0 && Date.now() - lastTouch > 1000) begin(e.clientX, e.clientY); });
  window.addEventListener('mousemove', e => { if (press) move(e.clientX, e.clientY, null); });
  window.addEventListener('mouseup', e => { if (press) end(e.clientX, e.clientY); });
  let rt = null; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(draw, 150); });

  // nastavení
  const open = () => {
    $('fEcoApp').value = cfg.ecoApp || ''; $('fEcoKey').value = cfg.ecoKey || ''; $('fEcoMac').value = cfg.ecoMac || ''; $('fEcoAlt').value = cfg.ecoAlt ?? 500;
    $('fStation').value = cfg.station; $('fWuKey').value = cfg.wuKey; $('fRepo').value = cfg.ghRepo || 'meteo-data'; $('fGhToken').value = cfg.ghToken;
    const q = LS.get('meteo.quota', { d: '', n: 0 });
    const hm = k => HMODE_NAMES[LS.get('meteo.hmode.' + k, '')] || 'zatím nezjištěno';
    $('quota').textContent = `Dotazů na Weather Underground dnes: ${q.d === ymd(today()) ? q.n : 0} (bezpečný limit 1400).\nStahování historie – hodinová data: ${hm('hourly')}, denní souhrny: ${hm('daily')}.\nVerze aplikace: ${APP_VERSION}`;
    const stt = fcStat(), lbl = { ok: '', nodata: ' · pro vaši polohu nemá data', err: ' · poslední načtení selhalo' };
    $('fcModels').innerHTML = MODELS.map(m => `<label class="chk"><input type="checkbox" data-m="${m.k}"${fcModels.includes(m.k) ? ' checked' : ''}><span class="sw" style="background:${m.c}"></span><span>${esc(m.full)}<small>${lbl[stt[m.k]] || ''}</small></span></label>`).join('');
    $('setMsg').textContent = ''; $('setMsg').className = 'msg'; openSheet('settings');
  };
  $('btnSettings').onclick = open;
  $('btnClose').onclick = () => { closeSheet('settings'); };
  $('btnBack').onclick = () => { closeSheet('settings'); };
  $('settings').addEventListener('click', e => { if (e.target === $('settings')) closeSheet('settings'); });
  // kopírování klíče do schránky (z pole typu heslo prohlížeče kopírovat nedovolí)
  $('settings').addEventListener('click', async e => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    e.preventDefault();
    const v = $(b.dataset.copy).value; if (!v) return;
    let ok = false;
    try { await navigator.clipboard.writeText(v); ok = true; } catch { }
    if (!ok) {
      try { const t = document.createElement('textarea'); t.value = v; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove(); } catch { }
    }
    const old = b.textContent; b.textContent = ok ? 'Zkopírováno' : 'Nepodařilo se'; setTimeout(() => { b.textContent = old; }, 1500);
  });
  $('btnShow').onclick = () => { for (const id of ['fWuKey', 'fGhToken', 'fEcoApp', 'fEcoKey']) $(id).type = $(id).type === 'password' ? 'text' : 'password'; };
  $('btnSave').onclick = async () => {
    const msg = $('setMsg'); msg.className = 'msg'; msg.textContent = 'Ověřuji…';
    const stationChanged = cfg.station !== $('fStation').value.trim().toUpperCase();
    cfg = { ...cfg, station: $('fStation').value.trim().toUpperCase(), wuKey: $('fWuKey').value.trim(), ghRepo: $('fRepo').value.trim() || 'meteo-data', ghToken: $('fGhToken').value.trim(),
      ecoApp: $('fEcoApp').value.trim(), ecoKey: $('fEcoKey').value.trim(), ecoMac: $('fEcoMac').value.trim().toUpperCase(), ecoAlt: Number(String($('fEcoAlt').value).replace(',', '.')) || 0 };
    if (!cfg.ghToken) cfg.ghOwner = '';
    LS.set('meteo.cfg', cfg);
    const lines = []; let ok = true;
    try {
      const o = (await wuGet('observations/current'))[0];
      if (!o) throw new Error('Stanice nevrátila žádná aktuální data. Zkontrolujte ID stanice.');
      cur = o; setCoords(o); lines.push(`✓ Weather Underground: stanice ${cfg.station}${o.neighborhood ? ' (' + o.neighborhood + ')' : ''} funguje.`);
    } catch (err) { ok = false; lines.push('✗ ' + err.message); }
    if (cfg.ghToken) {
      try { const n = await gh.verify(); lines.push(`✓ GitHub: data se budou ukládat do soukromého repozitáře ${n}.`); }
      catch (err) { ok = false; cfg.ghOwner = ''; lines.push('✗ GitHub: ' + err.message); }
    } else lines.push('GitHub není nastavený, data se ukládají jen v tomto telefonu.');
    if (ecoReady()) {
      try {
        const x = await ecoGet('real_time', { call_back: 'outdoor,pressure' });
        const pa = ecoVal(x.pressure && x.pressure.absolute); if (pa == null) throw new Error('nevrátil absolutní tlak (zkontrolujte MAC adresu)');
        const v = mslp(pa, ecoVal(x.outdoor && x.outdoor.temperature), ecoVal(x.outdoor && x.outdoor.humidity));
        lines.push(`✓ Ecowitt: absolutní tlak ${fmt(pa, 1)} hPa, přepočteno na hladinu moře ${fmt(v, 1)} hPa (výška ${fmt(cfg.ecoAlt, 0)} m).`);
        if (cur) { cur.metric = cur.metric || {}; cur.metric.pressure = v; }
      } catch (err) { ok = false; lines.push('✗ Ecowitt: ' + err.message); }
    }
    LS.set('meteo.cfg', cfg);
    if (stationChanged) { await idb.clear(); LS.del('meteo.hmode.hourly'); LS.del('meteo.hmode.daily'); }
    msg.textContent = lines.join('\n'); msg.className = 'msg ' + (ok ? 'ok' : 'bad');
    renderCurrent();
    if (ok) setTimeout(() => { closeSheet('settings'); }, 1200);
    refresh();
  };
  $('btnClear').onclick = async () => {
    if (!confirm('Smazat data uložená v tomto telefonu? Data na Weather Underground a na GitHubu zůstanou.')) return;
    await idb.clear(); LS.del('meteo.up'); $('setMsg').className = 'msg ok'; $('setMsg').textContent = 'Data v telefonu smazána.'; refresh();
  };
}

// ---------- start a automatická obnova ----------
let lastTick = 0;
function tick() {
  if (!cfg.station || !cfg.wuKey) return;
  lastTick = Date.now(); loadCurrent();
  const t = today(), inP = a => { if (!a) return false; const p = periodOf(st.scale, a); return t >= p.s && t < p.e; };
  if (inP(st.anchor) || inP(st.cmp)) refresh();
}
function start() {
  bindUI(); renderControls(); renderStatus();
  setInterval(() => { if (document.visibilityState === 'visible') tick(); }, 5 * 60e3);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastTick > 4 * 60e3) tick(); });
  if (!cfg.station || !cfg.wuKey) {
    $('chart').innerHTML = '<div class="empty">Začněte zadáním ID stanice a klíče v nastavení (ozubené kolečko vpravo nahoře).</div>';
    $('btnSettings').click(); return;
  }
  renderStatus();
  LS.del('meteo.diag'); lastTick = Date.now();
  Promise.race([nactiOpravy(), new Promise(r => setTimeout(r, 4000))]).finally(() => { loadCurrent(); refresh(); });
}
if (typeof window !== 'undefined' && !window.__METEO_TEST__) start();
