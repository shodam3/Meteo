'use strict';
const APP_VERSION = 18;
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
  hum: { n: 'Vlhkost', u: '%', dec: 0, kind: 'hla', chart: 'line' },
  press: { n: 'Tlak', u: 'hPa', dec: 1, kind: 'hla', chart: 'line' },
  wind: { n: 'Vítr', u: 'km/h', dec: 1, kind: 'hla', chart: 'bar', zero: true, noMin: true },
  gust: { n: 'Nárazy', u: 'km/h', dec: 1, kind: 'hla', chart: 'bar', zero: true, noMin: true },
  rain: { n: 'Srážky', u: 'mm', dec: 1, kind: 'sum', chart: 'bar', zero: true },
  solar: { n: 'Záření', u: 'W/m²', dec: 0, kind: 'max', chart: 'line', zero: true },
  uv: { n: 'UV', u: '', dec: 1, kind: 'max', chart: 'bar', zero: true }
};

// ---------- nastavení a stav ----------
let cfg = Object.assign({ station: '', wuKey: '', ghToken: '', ghRepo: 'meteo-data', ghOwner: '' }, LS.get('meteo.cfg', {}));
const saved = LS.get('meteo.view', {});
const st = {
  scale: ['day', 'week', 'month', 'year'].includes(saved.scale) ? saved.scale : 'week',
  v: VARS[saved.v] ? saved.v : 'temp',
  mode: ['max', 'min', 'avg'].includes(saved.mode) ? saved.mode : 'avg',
  charts: saved.charts || {},
  anchor: today(),
  cmp: null,
  sel: null
};
const saveView = () => LS.set('meteo.view', { scale: st.scale, v: st.v, mode: st.mode, charts: st.charts });
const chartType = () => st.charts[st.v] || VARS[st.v].chart;
// u větru a nárazů WU jako minimum posílá okamžité hodnoty (téměř vždy 0), volba Min se proto nenabízí
const curMode = () => VARS[st.v].noMin && st.mode === 'min' ? 'avg' : st.mode;

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
  async clear() { const db = await this.open(); this.mem.clear(); if (db) return this.tx('readwrite', s => s.clear()); }
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
  return j.observations || j.summaries || [];
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
      if (g && Array.isArray(g.records)) {
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
  const p = rain5load(d).finally(() => r5inflight.delete(d)); r5inflight.set(d, p); return p;
}
const EXT = { temp: ['tempHigh', 'tempLow'], dew: ['dewptHigh', 'dewptLow'], hum: ['humidityHigh', 'humidityLow'], press: ['pressureMax', 'pressureMin'], wind: ['windspeedHigh', null], gust: ['windgustHigh', null], solar: ['solarRadiationHigh', null], uv: ['uvHigh', null] };
async function rain5load(d) {
  const key = 'day5/' + d, e = await idb.get(key);
  if (e && (e.final || Date.now() - e.fetchedAt < STALE)) return e;
  setBusy(1);
  try {
    const obs = await wuGet('history/all', { date: d.replace(/-/g, '') });
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
        const h = g(fh); if (h != null && (x.hi == null || h > x.hi)) { x.hi = h; x.hiT = hm; }
        if (fl) { const l = g(fl); if (l != null && (x.lo == null || l < x.lo)) { x.lo = l; x.loT = hm; } }
      }
      if (x.hi != null) ext[v] = x;
    }
    const final = Date.now() > addDays(parseYmd(d), 1).getTime() + 3600e3;
    const res = { final, fetchedAt: Date.now(), hours, ext };
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
const MODEL = Object.fromEntries(MODELS.map(m => [m.k, m]));
let fcModels = LS.get('meteo.fcmodels', ['aladin', 'icon', 'ecmwf', 'yr']).filter(k => MODEL[k]);
let fcOn = LS.get('meteo.fcon', null) || fcModels.slice();
const fcMem = new Map(), fcInflight = new Map();
const fcStat = () => LS.get('meteo.fcstat', {});
const setFcStat = (k, v) => { const x = fcStat(); x[k] = v; LS.set('meteo.fcstat', x); };
const avg2 = (a, b) => a == null ? (b ?? null) : b == null ? a : (a + b) / 2;
const maxDay = () => st.scale === 'day' ? addDays(today(), 2) : today();

async function omFetch(id) {
  const q = new URLSearchParams({ latitude: cfg.lat, longitude: cfg.lon, hourly: 'temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,pressure_msl', models: id, timezone: 'Europe/Prague', forecast_days: '3', wind_speed_unit: 'kmh' });
  let r; try { r = await fetch('https://api.open-meteo.com/v1/forecast?' + q, { cache: 'no-store' }); } catch { throw new Error('nepodařilo se spojit s Open-Meteo'); }
  if (!r.ok) { let m = ''; try { m = (await r.json()).reason || ''; } catch { } throw new Error('Open-Meteo ' + r.status + (m ? ': ' + m : '')); }
  const H = (await r.json()).hourly || {}, t = H.time || [];
  const T = H.temperature_2m || [], P = H.precipitation || [], W = H.wind_speed_10m || [], G = H.wind_gusts_10m || [], PR = H.pressure_msl || [];
  // hodnoty k okamžiku → průměr začátku a konce hodiny; srážky a nárazy jsou za předchozí hodinu → bere se konec hodiny
  return t.map((x, i) => [x.slice(0, 10), Number(x.slice(11, 13)), avg2(T[i], T[i + 1]), P[i + 1] ?? null, avg2(W[i], W[i + 1]), G[i + 1] ?? null, avg2(PR[i], PR[i + 1])]);
}
async function yrFetch() {
  const u = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${Number(cfg.lat).toFixed(4)}&lon=${Number(cfg.lon).toFixed(4)}`;
  let r; try { r = await fetch(u); } catch { throw new Error('nepodařilo se spojit s yr.no'); }
  if (!r.ok) throw new Error('yr.no ' + r.status);
  const ts = ((await r.json()).properties || {}).timeseries || [];
  const t0 = today(), N = 73, idx = d => Math.round((d - t0) / 3600e3);
  const inst = { t: new Array(N).fill(null), w: new Array(N).fill(null), g: new Array(N).fill(null), p: new Array(N).fill(null) }, rain = new Array(N).fill(null);
  for (const e of ts) {
    const d = new Date(e.time), i = idx(d); if (i < 0 || i >= N) continue;
    const det = ((e.data || {}).instant || {}).details || {};
    inst.t[i] = num(det.air_temperature); inst.p[i] = num(det.air_pressure_at_sea_level);
    inst.w[i] = det.wind_speed != null ? det.wind_speed * 3.6 : null; inst.g[i] = det.wind_speed_of_gust != null ? det.wind_speed_of_gust * 3.6 : null;
    const n1 = ((e.data || {}).next_1_hours || {}).details, n6 = ((e.data || {}).next_6_hours || {}).details;
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
    out.push([ymd(d), d.getHours(), avg2(inst.t[i], inst.t[i + 1]), rain[i] != null ? r2(rain[i]) : null, avg2(inst.w[i], inst.w[i + 1]), g, avg2(inst.p[i], inst.p[i + 1])]);
  }
  return out;
}
function fcGet(k) {
  if (fcInflight.has(k)) return fcInflight.get(k);
  const p = fcLoad(k).finally(() => fcInflight.delete(k)); fcInflight.set(k, p); return p;
}
async function fcLoad(k) {
  const m = MODEL[k], ttl = m.yr ? 3 * 3600e3 : 3600e3, loc = cfg.lat + ',' + cfg.lon, day = ymd(today());
  const c = fcMem.get(k) || LS.get('meteo.fc.' + k, null);
  if (c && c.loc === loc && c.day === day && Date.now() - c.at < ttl) { fcMem.set(k, c); return c; }
  try {
    const rows = m.yr ? await yrFetch() : await omFetch(m.om);
    const has = rows.some(x => x[2] != null);
    const e = { at: Date.now(), loc, day, rows: has ? rows : [] };
    fcMem.set(k, e); LS.set('meteo.fc.' + k, e); setFcStat(k, has ? 'ok' : 'nodata');
    return e;
  } catch (err) {
    setFcStat(k, 'err'); note(m.n + ': ' + err.message);
    if (c) return c; throw err;
  }
}
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
const FCI = { temp: 2, rain: 3, wind: 4, gust: 5, press: 6 };
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
  else for (let d = s; d < p.e; d = addDays(d, 1)) B.push({ k: 'd', d: ymd(d) });
  return B;
}
function fillBuckets(B, hourly, daily) {
  const hm = new Map(hourly.map(r => [r.d + '|' + r.h, r]));
  const dm = new Map(daily.map(r => [r.d, r]));
  for (const b of B) {
    if (b.k === 'h') { const r = hm.get(b.d + '|' + b.h); b.recs = r ? [r] : []; }
    else if (b.k === 'd') { const r = dm.get(b.d); b.recs = r ? [r] : []; }
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
function cutRecs(X, cut) {
  if (!isFinite(cut)) return X;
  const f = r => dayDiff(X.p.s, parseYmd(r.d)) * 24 + (r.h != null ? r.h : 0) < cut;
  return { p: X.p, h: X.h.filter(f), d: X.d.filter(f) };
}

// ---------- graf ----------
function nice(mn, mx, zero) {
  if (zero) mn = Math.min(0, mn);
  if (mx - mn < 1e-9) { mn -= 1; mx += 1; if (zero && mn < 0) { mx -= mn; mn = 0; } }
  const raw = (mx - mn) / 4, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(s => s * mag).find(s => s >= raw - 1e-12);
  const lo = Math.floor(mn / step + 1e-9) * step, hi = Math.ceil(mx / step - 1e-9) * step;
  const ticks = []; for (let t = lo; t <= hi + step / 1000; t += step) ticks.push(Math.round(t / step) * step);
  return { lo, hi: hi > lo ? hi : lo + step, step, ticks };
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
  const hasData = all.length > 0;
  if (o.extra) for (const v of o.extra) if (v != null) all.push(v);
  if (!hasData) { el.innerHTML = `<div class="empty">${o.emptyMsg || 'Pro toto období nejsou žádná data.'}</div>`; return null; }
  let mn = all[0], mx = all[0]; for (const v of all) { if (v < mn) mn = v; if (v > mx) mx = v; }
  const sc = nice(mn, mx, o.zero);
  const L = 36, R = 6, Bm = 22, n = o.n, slot = (W - L - R) / n;
  const tdec = sc.step < 1 ? (sc.step < 0.1 ? 2 : 1) : (sc.step % 1 ? 1 : 0);
  let lab = null, T = 12, txt = null;
  if (o.type === 'bar' && o.series.length === 1) {
    txt = o.series[0].vals.map(v => v == null ? '' : fmt(v, o.dec));
    const tw = Math.max(...txt.map(t => t.length)) * 5.6;
    if (slot >= tw + 2) { lab = 'h'; T = 20; } else if (slot >= 9.5) { lab = 'r'; T = 14 + tw; }
  }
  const plotH = H - T - Bm;
  const y = v => T + (sc.hi - v) / (sc.hi - sc.lo) * plotH;
  const xc = i => L + slot * (i + 0.5);
  const f1 = x => Math.round(x * 10) / 10;
  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(o.aria || 'Graf')}">`;
  s += `<defs><linearGradient id="gA" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#34E89E"/><stop offset="0.55" stop-color="#3EE6F2"/><stop offset="1" stop-color="#38BDF8"/></linearGradient>`
    + `<linearGradient id="gB" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FDBA74"/><stop offset="1" stop-color="#EA580C"/></linearGradient>`
    + `<linearGradient id="gL" gradientUnits="userSpaceOnUse" x1="0" y1="${T}" x2="0" y2="${H - Bm}"><stop offset="0" stop-color="#14C07C"/><stop offset="0.55" stop-color="#10BCD3"/><stop offset="1" stop-color="#1D8FE0"/></linearGradient></defs>`;
  if (o.type === 'bar') for (let i = 0; i < n; i += 2) s += `<rect x="${f1(L + slot * i)}" y="${T}" width="${f1(slot)}" height="${f1(plotH)}" fill="#F5F6F8"/>`;
  s += '<g font-size="10" fill="#4B5563" font-family="inherit">';
  for (const t of sc.ticks) {
    const yy = f1(y(t));
    s += `<line x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}" stroke="${t === 0 && sc.lo < 0 ? '#9CA3AF' : '#E5E7EB'}" stroke-width="1"/>`;
    s += `<text x="${L - 4}" y="${yy + 3.5}" text-anchor="end">${fmt(t, tdec)}</text>`;
  }
  for (let i = 0; i < n; i++) {
    if (o.xGrid && o.xGrid(i)) s += `<line x1="${f1(L + slot * i)}" y1="${T}" x2="${f1(L + slot * i)}" y2="${T + plotH}" stroke="#E5E7EB" stroke-dasharray="2 3"/>`;
    const lb = o.xLabel ? o.xLabel(i) : ''; if (lb) s += `<text x="${f1(xc(i))}" y="${H - 6}" text-anchor="middle" font-size="11">${esc(lb)}</text>`;
  }
  s += '</g>';
  const base = y(sc.lo);
  if (o.type === 'bar') {
    const two = o.series.length > 1, w = Math.max(1, slot * (two ? 0.4 : 0.78));
    o.series.forEach((se, k) => {
      se.vals.forEach((v, i) => {
        if (v == null) return;
        const top = Math.min(y(v), base - 1);
        const x = two ? (k === 0 ? xc(i) - w - 0.5 : xc(i) + 0.5) : xc(i) - w / 2;
        s += `<rect x="${f1(x)}" y="${f1(top)}" width="${f1(w)}" height="${f1(base - top)}" rx="${Math.min(2, w / 3)}" fill="url(#g${k === 0 ? 'A' : 'B'})"/>`;
      });
    });
    if (lab) {
      s += '<g font-size="9" font-weight="600" fill="#A21CAF" font-family="inherit">';
      o.series[0].vals.forEach((v, i) => {
        if (v == null || Number(v.toFixed(o.dec)) === 0) return; const top = f1(Math.min(y(v), base - 1) - 3);
        s += lab === 'h' ? `<text x="${f1(xc(i))}" y="${top}" text-anchor="middle">${txt[i]}</text>`
          : `<text transform="translate(${f1(xc(i) + 3)},${top}) rotate(-90)">${txt[i]}</text>`;
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
    o.series.forEach((se, k) => {
      const col = k === 0 ? 'url(#gL)' : '#C2410C';
      if (se.band) {
        let seg = [];
        const flush = () => {
          if (seg.length > 1) s += `<polygon fill="url(#gA)" fill-opacity="0.22" points="${seg.map(([i, h]) => f1(xc(i)) + ',' + f1(y(h))).join(' ')} ${seg.slice().reverse().map(([i, , l]) => f1(xc(i)) + ',' + f1(y(l))).join(' ')}"/>`;
          seg = [];
        };
        se.band.forEach((b, i) => { if (b && b[0] != null && b[1] != null) seg.push([i, b[0], b[1]]); else flush(); }); flush();
      }
      let d = '', run = 0, lastI = -1;
      se.vals.forEach((v, i) => {
        if (v == null) { if (run === 1) s += `<circle cx="${f1(xc(lastI))}" cy="${f1(y(se.vals[lastI]))}" r="2.2" fill="${col}"/>`; run = 0; return; }
        d += (run ? 'L' : 'M') + f1(xc(i)) + ' ' + f1(y(v)); run++; lastI = i;
      });
      if (run === 1) s += `<circle cx="${f1(xc(lastI))}" cy="${f1(y(se.vals[lastI]))}" r="2.2" fill="${col}"/>`;
      if (d) s += `<path d="${d}" fill="none" stroke="${col}" stroke-width="${n > 100 ? 1.8 : 2.4}" stroke-linejoin="round" stroke-linecap="round"${k ? ' stroke-dasharray="6 4"' : ''}/>`;
    });
  }
  if (o.sel != null && o.sel < n) {
    s += `<line x1="${f1(xc(o.sel))}" y1="${T}" x2="${f1(xc(o.sel))}" y2="${T + plotH}" stroke="#111827" stroke-width="1" stroke-opacity="0.5"/>`;
    if (o.type === 'line' && o.fc) for (const f of o.fc) { const v = f.vals[o.sel]; if (v != null) s += `<circle cx="${f1(xc(o.sel))}" cy="${f1(y(v))}" r="3" fill="#fff" stroke="${f.color}" stroke-width="1.5"/>`; }
    if (o.type === 'line') o.series.forEach((se, k) => { const v = se.vals[o.sel]; if (v != null) s += `<circle cx="${f1(xc(o.sel))}" cy="${f1(y(v))}" r="4" fill="#fff" stroke="${k ? '#C2410C' : '#10A9C4'}" stroke-width="2"/>`; });
  }
  s += '</svg>';
  el.innerHTML = s;
  return { L, slot, n };
}
function xAxis(scale, type, B) {
  const D = i => B[i] && B[i].d ? parseYmd(B[i].d) : null;
  if (scale === 'day') return { lab: i => i % 3 === 0 ? i + 'h' : '', grid: i => i % 6 === 0 && i > 0 };
  if (scale === 'week' && type === 'line') return { lab: i => i % 24 === 12 && D(i) ? DOW[D(i).getDay()] : '', grid: i => i % 24 === 0 && i > 0 };
  if (scale === 'week') return { lab: i => D(i) ? DOW[D(i).getDay()] : '', grid: () => false };
  if (scale === 'month') return { lab: i => [0, 4, 9, 14, 19, 24, 29].includes(i) ? (i + 1) + '.' : '', grid: () => false };
  if (type === 'bar') return { lab: i => MON[i] || '', grid: () => false };
  return { lab: i => D(i) && D(i).getDate() === 15 ? MON[D(i).getMonth()] : '', grid: i => i > 0 && D(i) && D(i).getDate() === 1 };
}
function bucketName(b, scale) {
  if (!b) return '';
  if (b.k === 'h') { const d = parseYmd(b.d); return (scale === 'day' ? '' : `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. `) + `${b.h}:00–${b.h + 1}:00`; }
  if (b.k === 'd') { const d = parseYmd(b.d); return `${DOW[d.getDay()]} ${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()}`; }
  const [y, m] = b.m.split('-'); return MONL[+m - 1] + ' ' + y;
}

// ---------- vykreslení ----------
let model = null, current = null, cur = null, seq = 0;
const fmtU = (v, V, dec) => fmt(v, dec ?? V.dec) + (V.u ? ' ' + V.u : '');

function renderControls() {
  $('vars').innerHTML = Object.entries(VARS).map(([k, V]) => `<button class="chip${k === st.v ? ' on' : ''}" data-v="${k}" aria-pressed="${k === st.v}">${V.n}</button>`).join('');
  for (const b of $('scales').children) { const on = b.dataset.s === st.scale; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  for (const b of $('types').children) { const on = b.dataset.t === chartType(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); }
  const V = VARS[st.v];
  $('modes').style.visibility = V.kind === 'sum' ? 'hidden' : '';
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
    return { p, h, d, ext: det && det.ext ? det.ext : null };
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
    const [A, B] = await Promise.all([load(pA), pB ? load(pB) : null]);
    if (my !== seq) return;
    model = { A, B, fc: {} }; showErr(''); draw();
    const fc = await fcP;
    if (my !== seq || !model) return;
    model.fc = fc; if (Object.keys(fc).length) draw();
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
function chartOpts(a, b) {
  const type = chartType(), V = VARS[st.v];
  const n = Math.max(a.Bk.length, b ? b.Bk.length : 0);
  const padTo = arr => { const r = arr.slice(); while (r.length < n) r.push(null); return r; };
  const ax = xAxis(st.scale, type, b && b.Bk.length > a.Bk.length ? b.Bk : a.Bk);
  const series = [{ vals: padTo(a.vals.map(x => x.val)), band: !b && type === 'line' && V.kind === 'hla' ? padTo(a.vals.map(x => x.hi == null ? null : [x.hi, V.noMin ? x.avg : x.lo])) : null }];
  if (b) series.push({ vals: padTo(b.vals.map(x => x.val)) });
  const o = { type, n, series, extra: extraVals(a, b), zero: !!V.zero, dec: V.dec, xLabel: ax.lab, xGrid: ax.grid, sel: st.sel, aria: `${V.n}, ${periodLabel(model.A.p).t}` };
  const future = st.scale === 'day' && !b && st.anchor > today();
  if (fcApplicable() && type === 'line') {
    o.fc = fcSeries(model.fc || {}, a.Bk, st.v);
    if (dayDiff(today(), st.anchor) === 0) { const nw = new Date(); o.now = nw.getHours() + nw.getMinutes() / 60; }
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
  if (st.sel != null && st.sel >= Math.max(a.Bk.length, b ? b.Bk.length : 0)) st.sel = null;
  const o = chartOpts(a, b);
  current = { a, b, fc: o.fc || null, geo: drawChart($('chart'), o) };
  renderFcBar(); renderInfo(); renderSummary();
}
// při posouvání prstem se překresluje jen graf a řádek s hodnotami
function drawGraphOnly() {
  if (!current || !model) return;
  const o = chartOpts(current.a, current.b);
  current.fc = o.fc || null; current.geo = drawChart($('chart'), o);
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
      if (it.id === 'max' && ex.hi != null) { it.val = ex.hi; it.atText = 'v ' + ex.hiT; }
      if (it.id === 'min' && ex.lo != null) { it.val = ex.lo; it.atText = 'v ' + ex.loT; }
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
    ['Tlak', fmt(num(m.pressure), 1), 'hPa'], ['Vítr', fmt(num(m.windSpeed), 1), 'km/h' + (num(cur.winddir) != null ? ' · ' + DIRS[Math.round(cur.winddir / 45) % 8] : '')],
    ['Nárazy', fmt(num(m.windGust), 1), 'km/h'], ['Srážky dnes', fmt(num(m.precipTotal), 1), 'mm'],
    ['Záření', fmt(num(cur.solarRadiation), 0), 'W/m²'], ['UV', fmt(num(cur.uv), 1), '']
  ];
  $('now').innerHTML = tiles.map(([l, v, u]) => `<div class="tile"><span class="l">${l}</span><span class="v">${v}</span><span class="u">${u || '&nbsp;'}</span></div>`).join('');
  const nb = cur.neighborhood ? cur.neighborhood + ' · ' : '';
  $('stationName').textContent = nb + cfg.station;
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
  s.innerHTML = `<span class="today">${esc(dt.charAt(0).toUpperCase() + dt.slice(1))}</span>` + (txt ? ' · ' + esc(txt) : ''); s.classList.toggle('warn', warn);
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
      cur = o; renderCurrent();
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
function bindUI() {
  $('vars').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    st.v = b.dataset.v; st.sel = null; saveView();
    if (st.v === 'rain' && (st.scale === 'day' || st.scale === 'week')) refresh(); else { renderControls(); draw(); }
  });
  $('scales').addEventListener('click', e => { const b = e.target.closest('[data-s]'); if (!b || b.dataset.s === st.scale) return; st.scale = b.dataset.s; st.sel = null; saveView(); refresh(); });
  $('types').addEventListener('click', e => { const b = e.target.closest('[data-t]'); if (!b) return; st.charts[st.v] = b.dataset.t; st.sel = null; saveView(); renderControls(); draw(); });
  $('modes').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (!b) return; st.mode = b.dataset.m; saveView(); renderControls(); draw(); });
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
    const i = Math.max(0, Math.min(g.n - 1, Math.floor((x - r.left - g.L) / g.slot)));
    if (i !== st.sel) { st.sel = i; drawGraphOnly(); }
  };
  const begin = (x, y) => {
    press = { x, y, lx: x, t: Date.now(), scrub: false, moved: false };
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
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy) && dt < 800) { navigate('both', dx > 0 ? -1 : 1); return; }
    if (!p.moved && st.sel != null) { st.sel = null; drawGraphOnly(); }
  };
  ch.addEventListener('touchstart', e => { lastTouch = Date.now(); const t = e.touches[0]; if (e.touches.length === 1) begin(t.clientX, t.clientY); else { clearTimeout(press && press.timer); press = null; } }, { passive: true });
  ch.addEventListener('touchmove', e => { const t = e.touches[0]; move(t.clientX, t.clientY, e); }, { passive: false });
  ch.addEventListener('touchend', e => { lastTouch = Date.now(); const t = e.changedTouches[0]; end(t.clientX, t.clientY); });
  ch.addEventListener('touchcancel', () => { if (press) clearTimeout(press.timer); press = null; ch.classList.remove('scrub'); });
  ch.addEventListener('contextmenu', e => e.preventDefault());
  // myš (počítač)
  ch.addEventListener('mousedown', e => { if (e.button === 0 && Date.now() - lastTouch > 1000) begin(e.clientX, e.clientY); });
  window.addEventListener('mousemove', e => { if (press) move(e.clientX, e.clientY, null); });
  window.addEventListener('mouseup', e => { if (press) end(e.clientX, e.clientY); });
  let rt = null; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(draw, 150); });

  // nastavení
  const open = () => {
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
  $('btnShow').onclick = () => { for (const id of ['fWuKey', 'fGhToken']) $(id).type = $(id).type === 'password' ? 'text' : 'password'; };
  $('btnSave').onclick = async () => {
    const msg = $('setMsg'); msg.className = 'msg'; msg.textContent = 'Ověřuji…';
    const stationChanged = cfg.station !== $('fStation').value.trim().toUpperCase();
    cfg = { ...cfg, station: $('fStation').value.trim().toUpperCase(), wuKey: $('fWuKey').value.trim(), ghRepo: $('fRepo').value.trim() || 'meteo-data', ghToken: $('fGhToken').value.trim() };
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
  $('stationName').textContent = cfg.station;
  lastTick = Date.now(); loadCurrent(); refresh();
}
if (typeof window !== 'undefined' && !window.__METEO_TEST__) start();
