import {
  analyze, parseNumber, expectedFill, estimateConsumption, daysBetween, DEFAULT_SETTINGS, MODEL,
} from './model.js';
import { renderLearningChart, renderErrorChart } from './charts.js';
import { icon } from './icons.js';
import { mountWheel } from './wheel.js';

const STORAGE_KEY = 'rollertank.v1';
const BUILD = '__BUILD__';
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ========================================================================== */
/* Formatierung                                                               */
/* ========================================================================== */

const nf = (v, min = 0, max = min) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: min, maximumFractionDigits: max });
const fL = (v) => nf(v, 1, 2);
const fKm = (v) => nf(Math.round(v));
const fOdo = (v) => nf(v, 0, 1);
const fC = (v) => nf(v, 2, 2);
const fEur = (v) => nf(v, 2, 2);
const inputNum = (v) => (v == null || !Number.isFinite(v) ? '' : String(v).replace('.', ','));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

function localISO(d = new Date()) {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
}
const todayISO = () => localISO();
const nowTime = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const isTime = (t) => typeof t === 'string' && /^\d{2}:\d{2}$/.test(t);

function toDate(iso) {
  return new Date(`${iso}T12:00:00`);
}

function fDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = toDate(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('de-DE', opts);
}

function relDate(iso) {
  const days = Math.round(daysBetween(iso, todayISO()));
  if (!Number.isFinite(days)) return '';
  if (days === 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days > 1 && days < 7) return `vor ${days} Tagen`;
  return `am ${fDate(iso, { day: 'numeric', month: 'short' })}`;
}

function fWhen(date, time, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return `${fDate(date, opts)}${isTime(time) ? `, ${time}` : ''}`;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

/* ========================================================================== */
/* Daten                                                                      */
/* ========================================================================== */

function cleanFill(f) {
  const out = {
    id: String(f.id || uid()),
    date: /^\d{4}-\d{2}-\d{2}$/.test(f.date) ? f.date : todayISO(),
    odometer: Number(f.odometer),
    liters: Number(f.liters),
    full: f.full !== false,
  };
  if (isTime(f.time)) out.time = f.time;
  if (Number.isFinite(Number(f.price)) && Number(f.price) > 0) out.price = Number(f.price);
  return out;
}

function cleanOil(e) {
  const out = {
    id: String(e.id || uid()),
    date: /^\d{4}-\d{2}-\d{2}$/.test(e.date) ? e.date : todayISO(),
    odometer: Number(e.odometer),
    liters: Number(e.liters),
    full: e.full !== false,
  };
  if (isTime(e.time)) out.time = e.time;
  return out;
}

function normalize(d = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  const fillUps = Array.isArray(d.fillUps)
    ? d.fillUps.map(cleanFill).filter((f) => Number.isFinite(f.odometer) && f.odometer >= 0 && Number.isFinite(f.liters) && f.liters > 0)
    : [];
  const oil = Array.isArray(d.oil)
    ? d.oil.map(cleanOil).filter((e) => Number.isFinite(e.odometer) && e.odometer >= 0 && Number.isFinite(e.liters) && e.liters >= 0)
    : [];
  const reading = d.reading && Number.isFinite(Number(d.reading.odometer))
    ? { odometer: Number(d.reading.odometer), date: d.reading.date || todayISO(), ...(isTime(d.reading.time) ? { time: d.reading.time } : {}) }
    : null;
  return {
    version: 1,
    settings,
    fillUps,
    oil,
    reading,
    demo: !!d.demo,
    ui: { installDismissed: !!(d.ui && d.ui.installDismissed) },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) {
    console.warn('Konnte Daten nicht laden', e);
  }
  return normalize();
}

let data = load();
let A = analyze(data);

function commit() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {
    toast('Speichern fehlgeschlagen', 'warning');
  }
  A = analyze(data);
}

/* ========================================================================== */
/* Navigation                                                                 */
/* ========================================================================== */

const TABS = [
  { id: 'tank', title: 'Tank', icon: 'gauge' },
  { id: 'history', title: 'Verlauf', icon: 'list' },
  { id: 'analysis', title: 'Analyse', icon: 'chart' },
  { id: 'settings', title: 'Einstellungen', icon: 'gear' },
];
let currentTab = 'tank';
let historyMode = 'fuel';

const $ = (sel, root = document) => root.querySelector(sel);
const navbar = $('#navbar');

function renderTabbar() {
  $('#tabbar').innerHTML = `<span class="tab-indicator" aria-hidden="true"></span>${TABS.map((t) => `
    <button class="tab" role="tab" data-tab-btn="${t.id}" aria-selected="${t.id === currentTab}">
      ${icon(t.icon)}<span>${t.title}</span>
    </button>`).join('')}`;
  $('#fab').innerHTML = icon('plus');
}

function fabTarget() {
  return currentTab === 'history' && historyMode === 'oil' ? 'oil' : 'fuel';
}

function renderNavbar() {
  const t = TABS.find((x) => x.id === currentTab);
  $('#navbar-title').textContent = t.title;
  $('#tabbar').style.setProperty('--tab-index', String(TABS.indexOf(t)));
  const fab = $('#fab');
  fab.hidden = currentTab === 'settings';
  fab.setAttribute('aria-label', fabTarget() === 'oil' ? 'Öl eintragen' : 'Tankung eintragen');
}

function switchTab(id) {
  if (!TABS.some((t) => t.id === id)) return;
  currentTab = id;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${id}`));
  document.querySelectorAll('[data-tab-btn]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tabBtn === id)));
  window.scrollTo(0, 0);
  lastScrollY = 0;
  renderNavbar();
  renderView();
  onScroll();
}

let lastScrollY = 0;
function onScroll() {
  const y = window.scrollY;
  navbar.classList.toggle('scrolled', y > 34);
  const bar = $('#tabbar-wrap');
  const dy = y - lastScrollY;
  const atBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 4;
  if (y < 60 || dy < -8 || atBottom) bar.classList.remove('compact');
  else if (dy > 8) bar.classList.add('compact');
  if (Math.abs(dy) > 8 || y < 60) lastScrollY = y;
}

function updateAmbient() {
  const lv = A.status ? A.status.level : null;
  const color = lv === 'reserve' ? 'var(--red)' : lv === 'low' ? 'var(--orange)' : lv === 'ok' ? 'var(--green)' : 'var(--teal)';
  document.documentElement.style.setProperty('--ambient-level', color);
}

function renderView() {
  updateAmbient();
  const el = $(`#view-${currentTab}`);
  if (currentTab === 'tank') {
    el.innerHTML = viewTank();
    animateTank(el);
  } else if (currentTab === 'history') {
    el.innerHTML = viewHistory();
  } else if (currentTab === 'analysis') {
    el.innerHTML = viewAnalysis();
    drawCharts();
  } else if (currentTab === 'settings') {
    el.innerHTML = viewSettings();
  }
}

/* ========================================================================== */
/* Ansicht: Tank                                                              */
/* ========================================================================== */

const LEVEL = {
  ok: { color: 'var(--green)', icon: 'check', text: 'Genug Sprit' },
  low: { color: 'var(--orange)', icon: 'drop', text: 'Bald tanken' },
  reserve: { color: 'var(--red)', icon: 'warning', text: 'Reserve – jetzt tanken' },
};

const G = { size: 240, r: 100, stroke: 20 };
const G_CIRC = 2 * Math.PI * G.r;
const G_ARC = G_CIRC * 0.75;

function gaugeSvg(reserveShare) {
  const c = G.size / 2;
  const angle = (135 + 270 * reserveShare) * (Math.PI / 180);
  const r1 = G.r - G.stroke / 2 - 1;
  const r2 = G.r + G.stroke / 2 + 1;
  const tick = `<line class="reserve-tick" x1="${c + r1 * Math.cos(angle)}" y1="${c + r1 * Math.sin(angle)}" x2="${c + r2 * Math.cos(angle)}" y2="${c + r2 * Math.sin(angle)}"/>`;
  const start = 135 * (Math.PI / 180);
  const lx = (a, rr) => c + rr * Math.cos(a);
  const ly = (a, rr) => c + rr * Math.sin(a);
  return `
  <svg viewBox="0 0 ${G.size} ${G.size}" aria-hidden="true">
    <defs>
      <linearGradient id="g-level" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0" style="stop-color: color-mix(in srgb, var(--level) 62%, white)"/>
        <stop offset="1" style="stop-color: var(--level)"/>
      </linearGradient>
      <filter id="g-glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
    </defs>
    <circle class="track" cx="${c}" cy="${c}" r="${G.r}" fill="none" stroke-width="${G.stroke}" stroke-linecap="round"
      stroke-dasharray="${G_ARC} ${G_CIRC}" transform="rotate(135 ${c} ${c})"/>
    <circle class="value glow" cx="${c}" cy="${c}" r="${G.r}" fill="none" stroke="var(--level)" stroke-width="${G.stroke}" stroke-linecap="round"
      stroke-dasharray="${G_ARC} ${G_CIRC}" stroke-dashoffset="${G_ARC}" transform="rotate(135 ${c} ${c})" filter="url(#g-glow)"/>
    <circle class="value" cx="${c}" cy="${c}" r="${G.r}" fill="none" stroke="url(#g-level)" stroke-width="${G.stroke}" stroke-linecap="round"
      stroke-dasharray="${G_ARC} ${G_CIRC}" stroke-dashoffset="${G_ARC}" transform="rotate(135 ${c} ${c})"/>
    ${tick}
    <text class="gauge-label" x="${lx(start, G.r)}" y="${ly(start, G.r) + 32}" text-anchor="middle">Leer</text>
    <text class="gauge-label" x="${lx(Math.PI / 4, G.r)}" y="${ly(Math.PI / 4, G.r) + 32}" text-anchor="middle">Voll</text>
  </svg>`;
}

let shown = { range: null, percent: null };

function animateTank(el) {
  const st = A.status;
  if (!st) return;
  const values = [...el.querySelectorAll('.gauge .value')];
  const num = el.querySelector('[data-count]');
  const meters = [...el.querySelectorAll('.meter > span')];
  const targetOffset = G_ARC * (1 - st.percent);
  values.forEach((value) => {
    const from = shown.percent == null ? 0 : shown.percent;
    value.style.transition = 'none';
    value.setAttribute('stroke-dashoffset', String(G_ARC * (1 - from)));
    value.getBoundingClientRect();
    value.style.transition = '';
    requestAnimationFrame(() => value.setAttribute('stroke-dashoffset', String(targetOffset)));
  });
  meters.forEach((meter) => {
    const w = meter.style.width;
    meter.style.width = '0%';
    requestAnimationFrame(() => requestAnimationFrame(() => { meter.style.width = w; }));
  });
  if (num) {
    const to = Math.round(st.range);
    const from = shown.range == null ? 0 : shown.range;
    if (reduceMotion || from === to) {
      num.textContent = fKm(to);
    } else {
      const t0 = performance.now();
      const dur = 1000;
      const step = (t) => {
        const p = Math.min(1, (t - t0) / dur);
        const e = 1 - (1 - p) ** 3;
        num.textContent = fKm(from + (to - from) * e);
        if (p < 1 && num.isConnected) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    }
  }
  shown = { range: Math.round(st.range), percent: st.percent };
}

function demoBanner() {
  if (!data.demo) return '';
  return `
  <div class="card banner">${icon('wand')}
    <p><b>Beispieldaten aktiv</b><br><span>So sieht die App nach ein paar Wochen aus. Bereit für deine eigenen Daten?</span>
      <span class="banner-actions"><button data-action="demo-clear">Beispieldaten entfernen</button></span>
    </p>
  </div>`;
}

function isIOS() {
  return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

function installBanner() {
  if (data.ui.installDismissed || isStandalone() || !isIOS()) return '';
  return `
  <div class="card banner">${icon('share')}
    <p><b>Als App installieren</b><br><span>Tippe in Safari auf „Teilen“ und dann auf „Zum Home-Bildschirm“. Dann startet Roller Tank wie eine echte App – auch offline.</span></p>
    <button class="x" data-action="dismiss-install" aria-label="Hinweis schließen">${icon('close')}</button>
  </div>`;
}

function welcome() {
  return `
  <section class="card welcome">
    <div class="welcome-art">${icon('scooter')}</div>
    <h2>Willkommen!</h2>
    <p>Roller Tank lernt mit jeder Tankung, wie weit du mit deinem ${esc(A.settings.vehicleName)} kommst.</p>
    <ol class="steps">
      <li><div class="step-num">1</div><div><b>Volltanken</b><br><span>Tank bis zum Rand füllen und den km-Stand eintragen.</span></div></li>
      <li><div class="step-num">2</div><div><b>Fahren</b><br><span>Die App schätzt laufend, wie viel noch im Tank ist.</span></div></li>
      <li><div class="step-num">3</div><div><b>Wieder volltanken</b><br><span>Liter + km-Stand eintragen – jetzt kennt die App deinen echten Verbrauch und wird mit jeder Tankung genauer.</span></div></li>
    </ol>
    <button class="btn btn-primary btn-block" data-action="add-fill">${icon('fuel')} Erste Tankung eintragen</button>
    <button class="btn btn-plain btn-block" data-action="demo-load" style="margin-top:6px">Mit Beispieldaten ausprobieren</button>
  </section>`;
}

function viewTank() {
  const s = A.settings;
  let h = `<h1 class="large-title">Tank</h1>
    <p class="subtitle">${esc(s.vehicleName)}${s.vehicleModel ? ` · ${esc(s.vehicleModel)}` : ''} · ${nf(s.tankCapacity, 0, 1)} L Tank</p>`;
  h += demoBanner() + installBanner();
  if (!A.fillUps.length) return h + welcome();

  const st = A.status;
  if (!st) {
    return `${h}
    <section class="card welcome">
      <div class="welcome-art">${icon('fuel')}</div>
      <h2>Einmal volltanken</h2>
      <p>Bisher gibt es nur Teilbetankungen. Sobald du einmal bis zum Rand volltankst, weiß die App, wie viel im Tank ist.</p>
      <button class="btn btn-primary btn-block" data-action="add-fill">${icon('fuel')} Volltankung eintragen</button>
    </section>`;
  }

  const e = A.estimate;
  const lv = LEVEL[st.level];
  const cap = s.tankCapacity;
  const reserveShare = Math.min(1, s.reserveLiters / cap);

  h += `
  <section class="card hero" style="--level:${lv.color}">
    <span class="status-pill">${icon(lv.icon)}${lv.text}</span>
    <div class="gauge">
      ${gaugeSvg(reserveShare)}
      <div class="gauge-center">
        <div class="gauge-eyebrow">Reichweite</div>
        <div class="gauge-number"><span data-count>${fKm(st.range)}</span><small>km</small></div>
        <div class="gauge-range">meist ${fKm(st.rangeLow)}–${fKm(st.rangeHigh)} km</div>
      </div>
    </div>
    <div class="hero-stats">
      <div><div class="hero-stat-value">${nf(st.fuel, 1, 1)} L</div><div class="hero-stat-label">im Tank</div></div>
      <div><div class="hero-stat-value">${Math.round(st.percent * 100)} %</div><div class="hero-stat-label">Füllstand</div></div>
      <div><div class="hero-stat-value">${fKm(st.kmSinceFull)} km</div><div class="hero-stat-label">seit Volltanken</div></div>
    </div>
  </section>
  <div class="stand">${icon('clock', 'mini')}<span>km-Stand ${fOdo(st.odometer)} · ${relDate(st.odometerDate)}${isTime(timeAtOdometer(st.odometer)) ? `, ${timeAtOdometer(st.odometer)}` : ''}</span>
    <button data-action="reading">Aktualisieren</button></div>

  <div class="actions">
    <button class="btn btn-primary" data-action="add-fill">${icon('fuel')}Tanken</button>
    <button class="btn btn-tinted" data-action="reading">${icon('gauge')}km-Stand</button>
  </div>`;

  // Empfehlung
  const toRefuel = Math.max(0, st.refuelAt - st.odometer);
  const days = A.perDay ? toRefuel / A.perDay : null;
  if (st.level === 'reserve') {
    h += `
    <div class="card advice" style="--level:var(--red)">
      <div class="advice-icon">${icon('warning')}</div>
      <div><div class="advice-title">Reserve erreicht</div>
        <div class="advice-value">Jetzt tanken</div>
        <div class="advice-sub">Rechnerisch noch ca. ${fKm(st.range)} km, bevor der Tank leer ist.</div></div>
    </div>`;
  } else {
    const rounded = Math.floor(st.refuelAt / 5) * 5;
    h += `
    <div class="card advice" style="--level:${lv.color}">
      <div class="advice-icon">${icon('fuel')}</div>
      <div><div class="advice-title">Spätestens tanken bei</div>
        <div class="advice-value">km ${fOdo(rounded)}</div>
        <div class="advice-sub">in ca. ${fKm(toRefuel)} km${days != null ? ` · etwa ${days < 1.5 ? 'morgen' : `in ${fKm(days)} Tagen`}` : ''} – mit Puffer bis zur Reserve (${nf(s.reserveLiters, 1, 1)} L)</div></div>
    </div>`;
  }

  h += oilCard();

  // Modell-Karte
  const pct = Math.round(e.confidence * 100);
  const halfWidth = (st.fullRangeHigh - st.fullRangeLow) / 2;
  h += `
  <div class="card model-card pressable" role="button" tabindex="0" data-action="goto" data-tab="analysis">
    <div class="model-head">
      <div class="tile-icon">${icon('sparkles')}</div>
      <div><div class="model-title">Lernendes Modell</div>
        <div class="model-sub">${e.label} · ${e.n} ${e.n === 1 ? 'Messung' : 'Messungen'}</div></div>
      <div class="model-pct">${pct} %</div>
      ${icon('chevron', 'chev')}
    </div>
    <div class="meter" aria-hidden="true"><span style="width:${Math.max(3, pct)}%"></span></div>
    <div class="model-foot">${e.n
      ? `Eine volle Tankfüllung reicht für <strong>${fKm(st.fullRange)} km</strong> (± ${fKm(halfWidth)} km).`
      : `Noch rechnet die App mit dem Startwert ${fC(e.mean)} L/100 km. Nach der nächsten Volltankung kennt sie deinen echten Verbrauch.`}</div>
  </div>`;

  // Kacheln
  const lastFill = A.fillUps[A.fillUps.length - 1];
  const lastSeg = A.segmentById.get(lastFill.id);
  const tiles = [];
  tiles.push(tile('drop', 'bg-blue', 'Verbrauch', `${fC(e.mean)} <small>L/100 km</small>`, e.n ? `meist ${fC(e.low)}–${fC(e.high)}` : 'Startwert'));
  tiles.push(tile('road', 'bg-green', 'Volle Tankfüllung', `${fKm(st.fullRange)} <small>km</small>`, `bei ${nf(cap, 0, 1)} L Tankinhalt`));
  tiles.push(tile('fuel', 'bg-orange', 'Letzte Tankung', `${fL(lastFill.liters)} <small>L</small>`,
    lastSeg ? `für ${fKm(lastSeg.km)} km · ${relDate(lastFill.date)}` : `${lastFill.full ? 'Startpunkt' : 'Teilbetankung'} · ${relDate(lastFill.date)}`));
  if (A.stats.costPer100 != null) {
    tiles.push(tile('euro', 'bg-teal', 'Spritkosten', `${fEur(A.stats.costPer100)} <small>€/100 km</small>`, `Ø ${nf(A.stats.pricePerLiter, 2, 3)} € pro Liter`));
  } else if (A.perDay) {
    tiles.push(tile('calendar', 'bg-teal', 'Fahrprofil', `${fKm(A.perDay)} <small>km/Tag</small>`, 'im Durchschnitt'));
  } else {
    tiles.push(tile('list', 'bg-teal', 'Tankungen', `${A.fillUps.length}`, `seit ${fDate(A.fillUps[0].date, { month: 'short', year: 'numeric' })}`));
  }
  h += `<div class="tiles">${tiles.join('')}</div>`;
  return h;
}

const OIL_STATE = {
  ok: { color: 'var(--green)', text: 'Alles im grünen Bereich' },
  soon: { color: 'var(--orange)', text: 'Bald nachfüllen' },
  check: { color: 'var(--orange)', text: 'Kontrolle fällig' },
  refill: { color: 'var(--red)', text: 'Jetzt nachfüllen!' },
};

function oilCard() {
  const o = A.oil;
  const s = A.settings;
  if (!o.status) {
    return `
    <div class="card oil-card">
      <div class="model-head"><div class="tile-icon bg-brown">${icon('oil')}</div>
        <div><div class="model-title">2-Takt-Öl</div><div class="model-sub">Noch nicht erfasst</div></div></div>
      <div class="model-foot oil-intro">Fülle den Öltank einmal bis zur Markierung auf und trag es ein. Dann behält die App den Ölstand im Blick und erinnert dich alle ${fKm(s.oilCheckInterval)} km ans Kontrollieren.</div>
      <button class="btn btn-tinted btn-block btn-sm" data-action="add-oil">${icon('oil')}Öl eintragen</button>
    </div>`;
  }
  const st = o.status;
  const lv = OIL_STATE[st.state];
  let foot;
  if (st.state === 'refill') {
    foot = `Geschätzt nur noch <strong>${nf(st.level, 2, 2)} L</strong> im Öltank. Bitte nachfüllen – ohne Öl droht ein Kolbenfresser.`;
  } else if (st.state === 'check') {
    foot = `Seit dem letzten Eintrag <strong>${fKm(st.kmSinceEvent)} km</strong> gefahren – kurz in den Öltank schauen.`;
  } else {
    foot = `Nachfüllen spätestens bei <strong>km ${fOdo(Math.floor(st.refillAt / 10) * 10)}</strong> · nächste Kontrolle in ${fKm(Math.max(0, st.kmToCheck))} km`;
  }
  return `
  <div class="card oil-card" style="--level:${lv.color}">
    <div class="model-head"><div class="tile-icon bg-brown">${icon('oil')}</div>
      <div><div class="model-title">2-Takt-Öl</div><div class="model-sub">${lv.text}</div></div>
      <div class="model-pct">${nf(st.level, 1, 1)}<small> L</small></div></div>
    <div class="meter level" aria-hidden="true"><span style="width:${Math.max(3, Math.round(st.percent * 100))}%"></span></div>
    <div class="model-foot">${foot}</div>
    <button class="btn btn-tinted btn-block btn-sm" data-action="add-oil" style="margin-top:14px">${icon('oil')}Öl eintragen</button>
  </div>`;
}

function tile(ic, bg, label, value, sub) {
  return `<div class="card tile">
    <div class="tile-head"><span class="tile-icon ${bg}">${icon(ic)}</span>${label}</div>
    <div class="tile-value">${value}</div>
    <div class="tile-sub">${sub}</div>
  </div>`;
}

/* ========================================================================== */
/* Ansicht: Verlauf                                                           */
/* ========================================================================== */

function segmented() {
  return `<div class="segmented" id="history-seg" data-active="${historyMode}" role="tablist" aria-label="Verlauf anzeigen">
    <span class="seg-thumb" aria-hidden="true"></span>
    <button role="tab" data-action="history-mode" data-mode="fuel" aria-selected="${historyMode === 'fuel'}">Benzin</button>
    <button role="tab" data-action="history-mode" data-mode="oil" aria-selected="${historyMode === 'oil'}">2-Takt-Öl</button>
  </div>`;
}

function viewHistory() {
  if (historyMode === 'oil') return viewOilHistory();
  const n = A.fillUps.length;
  let h = `<h1 class="large-title">Verlauf</h1>
    <p class="subtitle">${n} ${n === 1 ? 'Tankung' : 'Tankungen'}${A.stats.totalKm ? ` · ${fKm(A.stats.totalKm)} km ausgewertet` : ''}</p>${segmented()}`;
  if (!n) {
    return `${h}<section class="card welcome">
      <div class="welcome-art">${icon('list')}</div>
      <h2>Noch leer</h2>
      <p>Hier erscheinen alle Tankungen mit dem Verbrauch der jeweiligen Tankfüllung.</p>
      <button class="btn btn-primary btn-block" data-action="add-fill">${icon('fuel')} Tankung eintragen</button>
    </section>`;
  }

  const lastOdo = A.fillUps[n - 1].odometer;
  if (data.reading && data.reading.odometer > lastOdo) {
    h += `<div class="month-header"><span>Aktuell</span></div>
    <div class="list"><button class="row" data-action="reading" style="--inset:58px">
      <span class="row-icon round bg-indigo">${icon('gauge')}</span>
      <span class="row-main"><span class="row-title">km ${fOdo(data.reading.odometer)}</span>
        <span class="row-sub">km-Stand abgelesen · ${relDate(data.reading.date)}${isTime(data.reading.time) ? `, ${data.reading.time}` : ''}</span></span>
      <span class="row-detail"><span>+${fKm(data.reading.odometer - lastOdo)} km</span></span>
      ${icon('chevron', 'chev')}
    </button></div>`;
  }

  const firstFullId = (A.fillUps.find((f) => f.full) || {}).id;
  const groups = new Map();
  [...A.fillUps].reverse().forEach((f) => {
    const key = f.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  });

  for (const [key, list] of groups) {
    const liters = list.reduce((a, f) => a + f.liters, 0);
    const month = toDate(`${key}-15`).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    h += `<div class="month-header"><span>${month}</span><span>${fL(liters)} L</span></div><div class="list">`;
    for (const f of list) {
      const seg = A.segmentById.get(f.id);
      const badges = [];
      if (!f.full) badges.push('<span class="badge">Teil</span>');
      if (f.id === firstFullId) badges.push('<span class="badge blue">Start</span>');
      if (seg && seg.outlier) badges.push('<span class="badge orange">Ausreißer</span>');
      const detail = seg
        ? `<strong>${fC(seg.consumption)}</strong><span>L/100 km</span>`
        : `<span>${f.full ? (f.id === firstFullId ? 'Startpunkt' : '–') : 'wird mitgezählt'}</span>`;
      h += `
      <button class="row" data-action="edit-fill" data-id="${esc(f.id)}" style="--inset:58px">
        <span class="row-icon round ${f.full ? 'bg-blue' : 'bg-gray'}">${icon(f.full ? 'drop' : 'dropHalf')}</span>
        <span class="row-main">
          <span class="row-title"><b>${fL(f.liters)} L</b>${badges.join('')}${f.price ? `<span class="row-price">· ${fEur(f.price)} €</span>` : ''}</span>
          <span class="row-sub">${fWhen(f.date, f.time)} · km ${fOdo(f.odometer)}${seg ? ` · ${fKm(seg.km)} km` : ''}</span>
        </span>
        <span class="row-detail">${detail}</span>
        ${icon('chevron', 'chev')}
      </button>`;
    }
    h += '</div>';
  }
  h += `<p class="section-footer">Tippe auf eine Tankung, um sie zu bearbeiten oder zu löschen. Der Verbrauch wird immer von Volltankung zu Volltankung gemessen.</p>`;
  return h;
}

function viewOilHistory() {
  const o = A.oil;
  const n = o.events.length;
  let h = `<h1 class="large-title">Verlauf</h1>
    <p class="subtitle">${n} ${n === 1 ? 'Öl-Eintrag' : 'Öl-Einträge'}${o.ratioLearned ? ` · ca. ${fKm(o.mlPer100)} ml/100 km` : ''}</p>${segmented()}`;
  if (!n) {
    return `${h}<section class="card welcome">
      <div class="welcome-art oil">${icon('oil')}</div>
      <h2>Noch kein Öl</h2>
      <p>Trag ein, wenn du 2-Takt-Öl nachfüllst oder den Ölstand kontrollierst. Die App lernt daraus deinen Ölverbrauch.</p>
      <button class="btn btn-primary btn-block" data-action="add-oil">${icon('oil')} Öl eintragen</button>
    </section>`;
  }
  const segById = new Map(o.segments.map((sg) => [sg.id, sg]));
  const firstFullId = (o.events.find((e) => e.full) || {}).id;
  h += '<div class="list" style="margin-top:8px">';
  for (const e of [...o.events].reverse()) {
    const seg = segById.get(e.id);
    const checkOnly = e.liters === 0 && !e.full;
    const badges = [];
    if (!e.full && !checkOnly) badges.push('<span class="badge">Teil</span>');
    if (e.id === firstFullId) badges.push('<span class="badge blue">Start</span>');
    const detail = seg
      ? `<strong>${fKm(seg.consumption)}</strong><span>ml/100 km</span>`
      : `<span>${checkOnly ? 'kontrolliert' : e.id === firstFullId ? 'Startpunkt' : ''}</span>`;
    h += `
    <button class="row" data-action="edit-oil" data-id="${esc(e.id)}" style="--inset:58px">
      <span class="row-icon round ${checkOnly ? 'bg-gray' : 'bg-brown'}">${icon(checkOnly ? 'check' : 'oil')}</span>
      <span class="row-main">
        <span class="row-title"><b>${checkOnly ? 'Kontrolliert' : `${nf(e.liters, 2, 2)} L`}</b>${badges.join('')}</span>
        <span class="row-sub">${fWhen(e.date, e.time)} · km ${fOdo(e.odometer)}${seg ? ` · ${fKm(seg.km)} km` : ''}</span>
      </span>
      <span class="row-detail">${detail}</span>
      ${icon('chevron', 'chev')}
    </button>`;
  }
  h += `</div><p class="section-footer">Der Ölverbrauch wird von „bis zur Markierung“ zu „bis zur Markierung“ gemessen – genau wie beim Benzin.</p>`;
  return h;
}

/* ========================================================================== */
/* Ansicht: Analyse                                                           */
/* ========================================================================== */

const INSIGHT_BG = { blue: 'bg-blue', green: 'bg-green', orange: 'bg-orange', red: 'bg-red' };

function viewAnalysis() {
  const e = A.estimate;
  const s = A.settings;
  const fullRange = (s.tankCapacity / e.mean) * 100;
  const fullLow = (s.tankCapacity / e.high) * 100;
  const fullHigh = (s.tankCapacity / e.low) * 100;
  let h = `<h1 class="large-title">Analyse</h1>
    <p class="subtitle">${e.n ? `${e.n} ${e.n === 1 ? 'Messung' : 'Messungen'} · Modell: ${e.label} (${Math.round(e.confidence * 100)} %)` : 'Noch keine Messung – Startwert aktiv'}</p>
  <div class="kpis">
    <div class="card kpi"><div class="kpi-label">Ø Verbrauch</div>
      <div class="kpi-value">${fC(e.mean)}<small> L/100 km</small></div>
      <div class="kpi-sub">meist ${fC(e.low)}–${fC(e.high)}</div></div>
    <div class="card kpi"><div class="kpi-label">Reichweite pro Tank</div>
      <div class="kpi-value">${fKm(fullRange)}<small> km</small></div>
      <div class="kpi-sub">meist ${fKm(fullLow)}–${fKm(fullHigh)} km</div></div>
  </div>`;

  // Lernkurve
  h += `<section class="card chart-card">
    <h3>Lernkurve</h3>
    <p class="chart-desc">Jeder Punkt ist eine gemessene Tankfüllung. Die Linie zeigt, was das Modell daraus gelernt hat – das Band ist die Unsicherheit und wird mit jeder Tankung schmaler.</p>`;
  if (A.history.length) {
    const hasOutlier = A.history.some((r) => A.segmentById.get(r.id)?.outlier);
    h += `<div class="legend">
        <span><i class="lg-dot"></i>Gemessen</span>
        <span><i class="lg-line"></i>Modell</span>
        <span><i class="lg-band"></i>Unsicherheit (80 %)</span>
        ${hasOutlier ? '<span><i class="lg-dot hollow"></i>Ausreißer</span>' : ''}
      </div>
      <div class="chart" id="chart-learning"></div>
      <details class="values"><summary>Werte als Tabelle</summary><div class="table-wrap">
        <table class="data"><thead><tr><th>#</th><th>Datum</th><th>km</th><th>Liter</th><th>L/100</th><th>Modell</th></tr></thead><tbody>
        ${A.history.map((r, i) => `<tr><td>${i + 1}</td><td>${fDate(r.date, { day: '2-digit', month: '2-digit' })}</td><td>${fKm(r.km)}</td><td>${fL(r.liters)}</td><td>${fC(r.consumption)}</td><td>${fC(r.estimateAfter)}</td></tr>`).join('')}
        </tbody></table></div></details>`;
  } else {
    h += `<div class="chart-empty">${icon('sparkles')}Ab der zweiten Volltankung erscheint hier deine Lernkurve.</div>`;
  }
  h += '</section>';

  // Prognosefehler
  h += `<section class="card chart-card">
    <h3>Prognosefehler (Liter)</h3>
    <p class="chart-desc">Wie weit lag die Vorhersage der getankten Liter jeweils daneben? Je kleiner die Säulen, desto besser kennt die App deinen Roller.</p>`;
  if (A.history.length >= 2) {
    h += `<div class="chart" id="chart-error"></div>
      <details class="values"><summary>Werte als Tabelle</summary><div class="table-wrap">
        <table class="data"><thead><tr><th>#</th><th>Erwartet</th><th>Getankt</th><th>Abweichung</th></tr></thead><tbody>
        ${A.history.map((r, i) => `<tr><td>${i + 1}</td><td>${fL(r.predictedLiters)} L</td><td>${fL(r.liters)} L</td><td>${r.error >= 0 ? '+' : '−'}${nf(Math.abs(r.error), 2, 2)} L</td></tr>`).join('')}
        </tbody></table></div></details>`;
  } else {
    h += `<div class="chart-empty">${icon('target')}Ab zwei Messungen siehst du hier, wie die Prognosen immer genauer werden.</div>`;
  }
  h += '</section>';

  // Erkenntnisse
  if (A.insights.length) {
    h += `<h2 class="section-header big">Erkenntnisse</h2><div class="insights">`;
    for (const it of A.insights) {
      h += `<div class="card insight"><span class="insight-icon ${INSIGHT_BG[it.tone] || 'bg-blue'}">${icon(it.icon)}</span>
        <div><div class="insight-title">${esc(it.title)}</div><div class="insight-text">${esc(it.text)}</div></div></div>`;
    }
    h += '</div>';
  }

  // 2-Takt-Öl
  const o = A.oil;
  h += `<h2 class="section-header big">2-Takt-Öl</h2>
  <div class="kpis">
    <div class="card kpi"><div class="kpi-label">Ölverbrauch</div>
      <div class="kpi-value">${fKm(o.mlPer100)}<small> ml/100 km</small></div>
      <div class="kpi-sub">≈ ${nf(o.litersPer1000, 2, 2)} L pro 1.000 km</div></div>
    <div class="card kpi"><div class="kpi-label">Öltank reicht für</div>
      <div class="kpi-value">${fKm(o.tankRange)}<small> km</small></div>
      <div class="kpi-sub">Mischung ≈ 1:${fKm(o.ratio)}</div></div>
  </div>
  <p class="section-footer">${o.ratioLearned
    ? `Gelernt aus ${o.estimate.n} ${o.estimate.n === 1 ? 'Messung' : 'Messungen'} (Modellsicherheit ${Math.round(o.estimate.confidence * 100)} %).`
    : `Noch geschätzt aus deinem Benzinverbrauch und einem Mischverhältnis von 1:${fKm(s.oilRatio)}. Sobald du zweimal bis zur Markierung aufgefüllt und eingetragen hast, lernt die App deinen echten Ölverbrauch.`}</p>`;

  // Statistik
  const st = A.stats;
  const rows = [];
  if (st.totalKm) rows.push(['road', 'bg-green', 'Ausgewertete Strecke', `${fKm(st.totalKm)} km`]);
  if (st.totalLiters) rows.push(['drop', 'bg-blue', 'Getankt (ausgewertet)', `${fL(st.totalLiters)} L`]);
  if (st.avgKmPerTank) rows.push(['fuel', 'bg-orange', 'Ø km pro Tankfüllung', `${fKm(st.avgKmPerTank)} km`]);
  if (st.best && A.segments.length >= 2) rows.push(['arrowDown', 'bg-green', 'Sparsamste Füllung', `${fC(st.best.consumption)} L/100 km`]);
  if (st.worst && A.segments.length >= 2) rows.push(['arrowUp', 'bg-orange', 'Durstigste Füllung', `${fC(st.worst.consumption)} L/100 km`]);
  if (A.perDay) rows.push(['calendar', 'bg-teal', 'Ø pro Tag', `${fKm(A.perDay)} km`]);
  if (st.totalCost != null) rows.push(['euro', 'bg-teal', 'Ausgaben (erfasst)', `${fEur(st.totalCost)} €`]);
  if (st.pricePerLiter != null) rows.push(['euro', 'bg-indigo', 'Ø Preis pro Liter', `${nf(st.pricePerLiter, 3, 3)} €`]);
  if (rows.length) {
    h += `<div class="section-header">Statistik</div><div class="list">${rows.map(([ic, bg, label, val]) => `
      <div class="row" style="--inset:58px"><span class="row-icon ${bg}">${icon(ic)}</span>
        <span class="row-main">${label}</span><span class="row-detail">${val}</span></div>`).join('')}</div>`;
  }

  // Erklärung
  h += `<div class="section-header">Hintergrund</div>
  <details class="card explain">
    <summary><span class="row-icon bg-indigo">${icon('sparkles')}</span>So lernt die App${icon('chevron', 'chev')}</summary>
    <ol>
      <li><b>Voll-zu-Voll-Messung:</b> Wenn du volltankst, entspricht die getankte Menge genau dem, was seit der letzten Volltankung verbraucht wurde. Teilbetankungen dazwischen werden mitgezählt.</li>
      <li><b>Gewichtung:</b> Längere Strecken zählen mehr (kleiner Messfehler), neuere Tankungen zählen mehr (Wetter, Jahreszeit, Fahrweise). Nach ${MODEL.HALF_LIFE} Tankungen zählt eine Messung nur noch halb.</li>
      <li><b>Ausreißer:</b> Tankungen, die stark aus der Reihe fallen (z. B. nicht ganz voll getankt), werden automatisch erkannt und schwächer gewichtet.</li>
      <li><b>Startwert:</b> Am Anfang rechnet die App mit ${fC(s.priorConsumption)} L/100 km. Dieser Wert verliert mit jeder echten Messung an Einfluss – aktuell noch ${Math.round(e.priorShare * 100)} %.</li>
      <li><b>Unsicherheit:</b> Aus der Streuung deiner Messungen ergibt sich der Bereich, in dem die Reichweite mit 80 % Wahrscheinlichkeit liegt. Mehr Daten → schmalerer Bereich → präzisere Prognose.</li>
    </ol>
  </details>`;
  return h;
}

function drawCharts() {
  const learning = $('#chart-learning');
  const outlierIds = new Set(A.estimate.items.filter((it) => it.outlier).map((it) => it.id));
  if (learning) {
    const start = estimateConsumption([], A.settings);
    renderLearningChart(learning, { start, rows: A.history, outlierIds, width: learning.clientWidth });
  }
  const err = $('#chart-error');
  if (err) renderErrorChart(err, { rows: A.history, width: err.clientWidth });
}

/* ========================================================================== */
/* Ansicht: Einstellungen                                                     */
/* ========================================================================== */

function viewSettings() {
  const s = A.settings;
  return `<h1 class="large-title">Einstellungen</h1>
  <p class="subtitle">Fahrzeug, Lernmodell und Daten</p>
  <div class="section-header">Fahrzeug</div>
  <div class="list">
    <div class="field"><label for="s-name">Name</label><input id="s-name" type="text" data-setting="vehicleName" value="${esc(s.vehicleName)}" autocomplete="off" enterkeyhint="done"></div>
    <div class="field"><label for="s-model">Typ</label><input id="s-model" type="text" data-setting="vehicleModel" value="${esc(s.vehicleModel)}" autocomplete="off" enterkeyhint="done"></div>
    <div class="field"><label for="s-cap">Tankinhalt</label><input id="s-cap" type="text" inputmode="decimal" data-setting="tankCapacity" data-num="1,30" value="${inputNum(s.tankCapacity)}"><span class="unit">L</span></div>
    <div class="field"><label for="s-res">Reserve-Warnung</label><input id="s-res" type="text" inputmode="decimal" data-setting="reserveLiters" data-num="0,10" value="${inputNum(s.reserveLiters)}"><span class="unit">L</span></div>
  </div>
  <p class="section-footer">Der Tankinhalt ist die Basis aller Berechnungen. Passt beim Volltanken mehr hinein als eingestellt, weist dich die Analyse darauf hin.</p>

  <div class="section-header">2-Takt-Öl</div>
  <div class="list">
    <div class="field"><label for="s-oilcap">Öltank</label><input id="s-oilcap" type="text" inputmode="decimal" data-setting="oilCapacity" data-num="0.2,5" value="${inputNum(s.oilCapacity)}"><span class="unit">L</span></div>
    <div class="field"><label for="s-oilres">Nachfüllen ab</label><input id="s-oilres" type="text" inputmode="decimal" data-setting="oilReserve" data-num="0,2" value="${inputNum(s.oilReserve)}"><span class="unit">L</span></div>
    <div class="field"><label for="s-oilchk">Kontrolle alle</label><input id="s-oilchk" type="text" inputmode="decimal" data-setting="oilCheckInterval" data-num="50,5000" value="${inputNum(s.oilCheckInterval)}"><span class="unit">km</span></div>
    <div class="field"><label for="s-oilratio">Mischung 1 :</label><input id="s-oilratio" type="text" inputmode="decimal" data-setting="oilRatio" data-num="10,200" value="${inputNum(s.oilRatio)}"></div>
  </div>
  <p class="section-footer">Honda Bali: ca. 1,2 L Öltank, die Ölpumpe mischt ungefähr 1:40 bis 1:50. Das Mischverhältnis ist nur der Startwert – nach zweimal Auffüllen bis zur Markierung lernt die App deinen echten Ölverbrauch.</p>

  <div class="section-header">Lernmodell</div>
  <div class="list">
    <div class="field"><label for="s-prior">Startwert</label><input id="s-prior" type="text" inputmode="decimal" data-setting="priorConsumption" data-num="0.5,15" value="${inputNum(s.priorConsumption)}"><span class="unit">L/100 km</span></div>
  </div>
  <p class="section-footer">Nur am Anfang wichtig: Solange es kaum Messungen gibt, rechnet die App mit diesem Verbrauch. Danach übernimmt dein echter Verbrauch.</p>

  <div class="section-header">Daten</div>
  <div class="list">
    <button class="row action" data-action="export" style="--inset:58px"><span class="row-icon bg-blue">${icon('share')}</span><span class="row-main">Backup exportieren</span>${icon('chevron', 'chev')}</button>
    <button class="row action" data-action="import" style="--inset:58px"><span class="row-icon bg-green">${icon('download')}</span><span class="row-main">Backup importieren</span>${icon('chevron', 'chev')}</button>
    ${data.fillUps.length ? '' : `<button class="row action" data-action="demo-load" style="--inset:58px"><span class="row-icon bg-purple">${icon('wand')}</span><span class="row-main">Beispieldaten laden</span>${icon('chevron', 'chev')}</button>`}
    <button class="row danger" data-action="reset" style="--inset:58px"><span class="row-icon bg-red">${icon('trash')}</span><span class="row-main">Alle Daten löschen</span></button>
  </div>
  <p class="section-footer">Deine Daten bleiben ausschließlich auf diesem Gerät. Exportiere ab und zu ein Backup, z. B. in die Dateien-App oder iCloud Drive.</p>

  <div class="section-header">Als App installieren</div>
  <div class="card explain" style="padding:14px 16px">
    <ol style="margin:0">
      <li>Diese Seite in <b>Safari</b> öffnen.</li>
      <li>Unten auf <b>Teilen</b> tippen (Quadrat mit Pfeil).</li>
      <li><b>„Zum Home-Bildschirm“</b> wählen – fertig. Die App funktioniert dann auch offline.</li>
    </ol>
  </div>
  <p class="version">Roller Tank · Version ${esc(BUILD.startsWith('__') ? 'dev' : BUILD)}</p>`;
}

function onSettingChange(input) {
  const key = input.dataset.setting;
  let value;
  if (input.dataset.num) {
    const [lo, hi] = input.dataset.num.split(',').map(Number);
    value = parseNumber(input.value);
    if (!Number.isFinite(value) || value < lo || value > hi) {
      input.value = inputNum(data.settings[key]);
      toast(`Bitte einen Wert zwischen ${nf(lo, 0, 1)} und ${nf(hi, 0, 1)} eingeben`, 'warning');
      return;
    }
    if (key === 'oilReserve' && value >= data.settings.oilCapacity) {
      input.value = inputNum(data.settings[key]);
      toast('Muss kleiner als der Öltank sein', 'warning');
      return;
    }
    if (key === 'reserveLiters' && value >= data.settings.tankCapacity) {
      input.value = inputNum(data.settings[key]);
      toast('Reserve muss kleiner als der Tank sein', 'warning');
      return;
    }
    input.value = inputNum(value);
  } else {
    value = input.value.trim().slice(0, 40);
    if (!value && key === 'vehicleName') value = DEFAULT_SETTINGS.vehicleName;
    input.value = value;
  }
  data.settings = { ...data.settings, [key]: value };
  commit();
  toast('Gespeichert');
}

/* ========================================================================== */
/* Sheets                                                                     */
/* ========================================================================== */

const sheet = $('#sheet');
const backdrop = $('#backdrop');
let sheetCtx = null;
let lastFocus = null;

function openSheet(opts) {
  sheetCtx = opts;
  lastFocus = document.activeElement;
  sheet.innerHTML = `
    <div class="sheet-head">
      ${opts.left === false ? '<span></span>' : `<button class="glass-btn" data-sheet="left" aria-label="${esc(opts.left || 'Abbrechen')}">${icon('close')}</button>`}
      <div class="sheet-title" id="sheet-title">${esc(opts.title)}</div>
      ${opts.right ? `<button class="glass-btn prominent" data-sheet="right" aria-label="${esc(opts.right)}">${icon('check')}</button>` : '<span></span>'}
    </div>
    <div class="sheet-body">${opts.body}</div>`;
  sheet.setAttribute('aria-labelledby', 'sheet-title');
  document.body.classList.add('locked');
  sheet.style.transform = '';
  sheet.getBoundingClientRect();
  sheet.classList.add('open');
  backdrop.classList.add('open');
  if (opts.onOpen) opts.onOpen(sheet);
}

function closeSheet() {
  if (!sheetCtx) return;
  const ctx = sheetCtx;
  sheetCtx = null;
  if (document.activeElement && sheet.contains(document.activeElement)) document.activeElement.blur();
  sheet.classList.remove('open');
  backdrop.classList.remove('open');
  sheet.style.transform = '';
  document.body.classList.remove('locked');
  if (ctx.onClose) ctx.onClose();
  if (lastFocus && lastFocus.focus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
}

function setSaveEnabled(on) {
  const b = sheet.querySelector('[data-sheet="right"]');
  if (b) b.disabled = !on;
}

sheet.addEventListener('click', (e) => {
  const b = e.target.closest('[data-sheet]');
  if (b && sheetCtx) {
    if (b.dataset.sheet === 'left') (sheetCtx.onLeft || closeSheet)();
    else if (sheetCtx.onRight) sheetCtx.onRight();
    return;
  }
  const a = e.target.closest('[data-sheet-action]');
  if (a && sheetCtx && sheetCtx.onAction) sheetCtx.onAction(a.dataset.sheetAction);
});
backdrop.addEventListener('click', () => closeSheet());

// Herunterziehen zum Schließen
(() => {
  let startY = null;
  let dy = 0;
  sheet.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.sheet-head') || e.target.closest('button')) return;
    startY = e.clientY;
    dy = 0;
    sheet.classList.add('dragging');
    sheet.setPointerCapture(e.pointerId);
  });
  sheet.addEventListener('pointermove', (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (startY == null) return;
    startY = null;
    sheet.classList.remove('dragging');
    if (dy > 110) closeSheet();
    else sheet.style.transform = '';
  };
  sheet.addEventListener('pointerup', end);
  sheet.addEventListener('pointercancel', end);
})();

/* ---------- Gemeinsame Bausteine: Zeitpunkt + Scroll-Räder ---------- */

const fmtKmWheel = (v) => nf(v, 0, 0);
const fmtL2 = (v) => nf(v, 2, 2);
const fmtEurWheel = (v) => (v === 0 ? '–' : nf(v, 2, 2));
const round2 = (v) => Math.round(v * 100) / 100;

function knownOdometer() {
  const odos = [...data.fillUps.map((f) => f.odometer), ...data.oil.map((e) => e.odometer)];
  if (data.reading) odos.push(data.reading.odometer);
  return odos.length ? Math.max(...odos) : null;
}

function timeAtOdometer(odo) {
  if (data.reading && data.reading.odometer === odo) return data.reading.time;
  const hit = data.fillUps.find((f) => f.odometer === odo) || data.oil.find((e) => e.odometer === odo);
  return hit ? hit.time : undefined;
}

function whenField(prefix, date, time) {
  return `<div class="field"><label class="field-label" for="${prefix}-date">Datum</label>
      <div class="dt-pills"><input id="${prefix}-date" type="date" value="${esc(date)}"></div></div>
    <div class="field"><label class="field-label" for="${prefix}-time">Uhrzeit</label>
      <div class="dt-pills"><input id="${prefix}-time" type="time" value="${esc(time || '')}"></div></div>`;
}

function pickerHtml(cols, single = false) {
  return `<div class="card picker${single ? ' single' : ''}" style="--cols:${cols.map((c) => `${c.fr || 1}fr`).join(' ')}">
    <div class="picker-head">${cols.map((c) => `<div class="picker-label">${c.label}</div>`).join('')}</div>
    <div class="picker-body"><div class="picker-band" aria-hidden="true"></div>
      ${cols.map((c) => `<div class="picker-col"><div data-wheel="${c.key}"></div><span class="picker-unit">${c.unit}</span></div>`).join('')}
    </div>
    <p class="picker-hint">Wischen zum Einstellen · Mitte antippen zum Eintippen</p>
  </div>`;
}

/** Bündelt schnelle Änderungen beim Drehen, damit die Vorschau flüssig bleibt. */
function debounced(fn, ms = 70) {
  let t = null;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

/* ---------- Tankung erfassen / bearbeiten ---------- */

function openFillSheet(existing) {
  const isEdit = !!existing;
  const others = data.fillUps.filter((f) => !existing || f.id !== existing.id);
  const lastOdo = others.reduce((m, f) => Math.max(m, f.odometer), -Infinity);
  const cap = data.settings.tankCapacity;
  const ppl = A.stats.pricePerLiter;
  const baseA = analyze({ ...data, fillUps: others, reading: null });
  const expected = (odo) => (Number.isFinite(odo) ? expectedFill(baseA.fillUps, baseA.settings, baseA.estimate, odo) : null);

  const startOdo = isEdit ? existing.odometer : knownOdometer();
  const exStart = expected(startOdo);
  const startLiters = isEdit ? existing.liters : exStart && exStart.liters > 0.05 ? round2(exStart.liters) : round2(cap * 0.6);
  const startPrice = isEdit ? existing.price || 0 : ppl ? round2(startLiters * ppl) : 0;

  const body = `
    <div class="list">${whenField('f', isEdit ? existing.date : todayISO(), isEdit ? existing.time : nowTime())}</div>
    ${pickerHtml([
      { key: 'odo', label: 'km-Stand', unit: 'km', fr: 1.3 },
      { key: 'liters', label: 'Getankt', unit: 'L' },
      { key: 'price', label: 'Betrag', unit: '€' },
    ])}
    <div class="list" style="margin-top:14px">
      <label class="field"><span class="field-label">Vollgetankt</span><span class="switch"><input id="f-full" type="checkbox" ${!existing || existing.full ? 'checked' : ''}><span></span></span></label>
    </div>
    <p class="section-footer">Für eine exakte Messung bis zum Rand volltanken. Teilbetankungen werden bis zur nächsten Volltankung mitgerechnet. Liter und Betrag folgen automatisch der Prognose, bis du sie selbst drehst.</p>
    <div class="preview" id="f-preview" aria-live="polite"></div>
    ${isEdit ? `<button class="btn btn-danger btn-block" data-sheet-action="delete" style="margin-top:28px">${icon('trash')}Tankung löschen</button>` : ''}`;

  const w = {};
  const touched = { liters: isEdit, price: isEdit || !ppl };

  const read = () => ({
    date: $('#f-date').value || todayISO(),
    time: $('#f-time').value,
    odometer: w.odo.value,
    liters: w.liters.value,
    full: $('#f-full').checked,
    price: w.price.value,
  });

  const evaluate = () => {
    const v = read();
    const msgs = [];
    let ok = Number.isFinite(v.odometer) && v.odometer >= 0 && Number.isFinite(v.liters) && v.liters > 0;
    if (Number.isFinite(v.odometer) && others.some((f) => Math.abs(f.odometer - v.odometer) < 0.05)) {
      msgs.push(['err', 'Für diesen km-Stand gibt es schon eine Tankung.']);
      ok = false;
    }
    if (Number.isFinite(v.liters) && v.liters > cap * 1.15) {
      msgs.push(['warn', `Mehr als der eingestellte Tankinhalt (${nf(cap, 0, 1)} L) – stimmt die Menge?`]);
    }
    if (Number.isFinite(v.odometer) && Number.isFinite(lastOdo)) {
      if (v.odometer < lastOdo) msgs.push(['warn', `Liegt vor deiner letzten Tankung (km ${fOdo(lastOdo)}) und wird chronologisch einsortiert.`]);
      else if (v.odometer - lastOdo > 1000) msgs.push(['warn', 'Über 1.000 km seit der letzten Tankung – stimmt der km-Stand?']);
    }

    let pv = '';
    if (Number.isFinite(v.odometer)) {
      const ex = expected(v.odometer);
      if (!ex) {
        pv += `<div class="pv-row"><span class="row-icon bg-blue">${icon('sparkles')}</span><div>${v.full
          ? '<b>Startpunkt.</b> <span>Ab der nächsten Volltankung misst die App deinen Verbrauch.</span>'
          : '<span>Tipp: Für den Start einmal <b>volltanken</b> – sonst weiß die App nicht, wie viel im Tank ist.</span>'}</div></div>`;
      } else if (ex.kmSinceFull > 0) {
        pv += `<div class="pv-row"><span class="row-icon bg-green">${icon('road')}</span><div><b>${fKm(ex.kmSinceFull)} km</b> <span>seit der letzten Volltankung</span></div></div>`;
        pv += `<div class="pv-row"><span class="row-icon bg-indigo">${icon('sparkles')}</span><div><span>Prognose:</span> <b>ca. ${fL(ex.liters)} L</b> <span>passen rein (${fL(ex.litersLow)}–${fL(ex.litersHigh)} L)</span></div></div>`;
        if (ok && v.full) {
          const candidate = { id: '__new__', date: v.date, odometer: v.odometer, liters: v.liters, full: true };
          const testA = analyze({ ...data, fillUps: [...others, candidate], reading: null });
          const seg = testA.segmentById.get('__new__');
          if (seg) {
            const diff = v.liters - ex.liters;
            pv += `<div class="pv-row"><span class="row-icon bg-orange">${icon('gauge')}</span><div><b>${fC(seg.consumption)} L/100 km</b> <span>auf dieser Tankfüllung · ${diff >= 0 ? '+' : '−'}${nf(Math.abs(diff), 2, 2)} L ggü. Prognose</span></div></div>`;
          }
        }
      } else {
        pv += `<div class="pv-row"><span class="row-icon bg-blue">${icon('gauge')}</span><div><span>Dreh den <b>km-Stand</b> auf den aktuellen Tacho-Wert.</span></div></div>`;
      }
    }
    pv += msgs.map(([cls, text]) => `<div class="pv-msg ${cls}">${esc(text)}</div>`).join('');
    $('#f-preview').innerHTML = pv;
    setSaveEnabled(ok);
    return ok;
  };

  // Liter folgen der Prognose, Betrag folgt den Litern – solange nicht selbst gedreht.
  const follow = () => {
    if (!touched.liters) {
      const ex = expected(w.odo.value);
      if (ex && ex.kmSinceFull > 0) w.liters.set(round2(Math.min(cap * 1.4, ex.liters)));
    }
    if (!touched.price && ppl && Number.isFinite(w.liters.value)) w.price.set(round2(w.liters.value * ppl));
  };
  const update = debounced(() => {
    follow();
    evaluate();
  });

  const save = () => {
    if (!evaluate()) return;
    const v = read();
    const entry = cleanFill({
      id: existing ? existing.id : uid(),
      date: v.date,
      time: v.time,
      odometer: v.odometer,
      liters: v.liters,
      full: v.full,
      price: Number.isFinite(v.price) && v.price > 0 ? v.price : undefined,
    });
    const before = A;
    data.fillUps = [...others, entry];
    if (data.reading && data.reading.odometer <= entry.odometer) data.reading = null;
    commit();
    closeSheet();
    renderView();
    const seg = A.segmentById.get(entry.id);
    const isNewest = A.fillUps[A.fillUps.length - 1].id === entry.id;
    if (!isEdit && seg && isNewest) {
      setTimeout(() => openResultSheet(entry, before), 380);
    } else {
      toast(isEdit ? 'Änderung gespeichert' : 'Tankung gespeichert');
    }
  };

  openSheet({
    title: isEdit ? 'Tankung' : 'Tanken',
    right: 'Sichern',
    body,
    onRight: save,
    onAction: async (a) => {
      if (a !== 'delete') return;
      const yes = await confirmAction({ message: 'Diese Tankung wird gelöscht. Die Analyse wird neu berechnet.', confirmLabel: 'Tankung löschen' });
      if (!yes) return;
      data.fillUps = others;
      commit();
      closeSheet();
      renderView();
      toast('Tankung gelöscht');
    },
    onOpen: (root) => {
      w.odo = mountWheel(root.querySelector('[data-wheel="odo"]'), {
        value: startOdo,
        min: 0,
        max: 999999,
        step: 1,
        span: { below: 1500, above: 3000 },
        format: fmtKmWheel,
        parse: parseNumber,
        label: 'km-Stand',
        speed: 1.3,
        dragAccel: 0.6,
        placeholder: 'Tacho-km',
        onChange: update,
      });
      w.liters = mountWheel(root.querySelector('[data-wheel="liters"]'), {
        value: startLiters,
        min: 0,
        max: Math.ceil(cap * 1.4),
        step: 0.01,
        format: fmtL2,
        parse: parseNumber,
        label: 'Getankte Liter',
        speed: 3,
        dragAccel: 2,
        onChange: (val, { user }) => {
          if (user) touched.liters = true;
          update();
        },
      });
      w.price = mountWheel(root.querySelector('[data-wheel="price"]'), {
        value: startPrice,
        min: 0,
        max: 60,
        step: 0.01,
        format: fmtEurWheel,
        parse: parseNumber,
        label: 'Betrag in Euro',
        speed: 3.5,
        dragAccel: 2.2,
        onChange: (val, { user }) => {
          if (user) touched.price = true;
          update();
        },
      });
      root.querySelectorAll('#f-date, #f-time').forEach((i) => i.addEventListener('input', evaluate));
      root.querySelector('#f-full').addEventListener('change', evaluate);
      evaluate();
      if (startOdo == null) w.odo.focusInput();
    },
  });
}

/* ---------- 2-Takt-Öl eintragen ---------- */

function openOilSheet(existing) {
  const isEdit = !!existing;
  const others = data.oil.filter((e) => !existing || e.id !== existing.id);
  const cap = A.settings.oilCapacity;
  const base = A.oil.estimate;
  const est = { mean: base.mean / 1000, low: base.low / 1000, high: base.high / 1000 };
  const expected = (odo) => (Number.isFinite(odo) ? expectedFill(others, { tankCapacity: cap }, est, odo) : null);

  const startOdo = isEdit ? existing.odometer : knownOdometer();
  const exStart = expected(startOdo);
  const startLiters = isEdit ? existing.liters : exStart ? round2(exStart.liters) : 0.3;

  const body = `
    <div class="list">${whenField('o', isEdit ? existing.date : todayISO(), isEdit ? existing.time : nowTime())}</div>
    ${pickerHtml([
      { key: 'odo', label: 'km-Stand', unit: 'km', fr: 1.25 },
      { key: 'liters', label: 'Nachgefüllt', unit: 'L' },
    ])}
    <div class="list" style="margin-top:14px">
      <label class="field"><span class="field-label">Bis zur Markierung</span><span class="switch"><input id="o-full" type="checkbox" ${!existing || existing.full ? 'checked' : ''}><span></span></span></label>
    </div>
    <p class="section-footer">Nur kontrolliert und nichts nachgefüllt? Auf <b>0,00</b> drehen und „Bis zur Markierung“ ausschalten – dann startet die Kontroll-Erinnerung neu. 100 ml = 0,10 L.</p>
    <div class="preview" id="o-preview" aria-live="polite"></div>
    ${isEdit ? `<button class="btn btn-danger btn-block" data-sheet-action="delete" style="margin-top:28px">${icon('trash')}Eintrag löschen</button>` : ''}`;

  const w = {};
  const touched = { liters: isEdit };

  const read = () => ({
    date: $('#o-date').value || todayISO(),
    time: $('#o-time').value,
    odometer: w.odo.value,
    liters: w.liters.value,
    full: $('#o-full').checked,
  });

  const evaluate = () => {
    const v = read();
    const msgs = [];
    let ok = Number.isFinite(v.odometer) && v.odometer >= 0 && Number.isFinite(v.liters) && v.liters >= 0;
    if (Number.isFinite(v.odometer) && others.some((e) => Math.abs(e.odometer - v.odometer) < 0.05)) {
      msgs.push(['err', 'Für diesen km-Stand gibt es schon einen Öl-Eintrag.']);
      ok = false;
    }
    if (Number.isFinite(v.liters) && v.liters > cap * 1.1) {
      msgs.push(['warn', `Mehr als der Öltank fasst (${nf(cap, 1, 1)} L) – stimmt die Menge? 100 ml = 0,10 L.`]);
    }
    let pv = '';
    if (Number.isFinite(v.odometer)) {
      const ex = expected(v.odometer);
      if (!ex) {
        pv += `<div class="pv-row"><span class="row-icon bg-brown">${icon('oil')}</span><div>${v.full
          ? '<b>Startpunkt.</b> <span>Ab jetzt behält die App den Ölstand im Blick.</span>'
          : '<span>Tipp: Für den Start einmal <b>bis zur Markierung</b> auffüllen – sonst kennt die App den Ölstand nicht.</span>'}</div></div>`;
      } else if (ex.kmSinceFull > 0) {
        pv += `<div class="pv-row"><span class="row-icon bg-green">${icon('road')}</span><div><b>${fKm(ex.kmSinceFull)} km</b> <span>seit dem letzten Auffüllen</span></div></div>`;
        pv += `<div class="pv-row"><span class="row-icon bg-indigo">${icon('sparkles')}</span><div><span>Prognose:</span> <b>ca. ${nf(ex.liters, 2, 2)} L</b> <span>passen rein (${nf(ex.litersLow, 2, 2)}–${nf(ex.litersHigh, 2, 2)} L)</span></div></div>`;
        if (ok && v.full && v.liters > 0) {
          const ml = (v.liters / ex.kmSinceFull) * 100000;
          const ratio = (A.estimate.mean * 1000) / ml;
          pv += `<div class="pv-row"><span class="row-icon bg-brown">${icon('oil')}</span><div><b>${fKm(ml)} ml/100 km</b> <span>seit dem letzten Auffüllen · Mischung ≈ 1:${fKm(ratio)}</span></div></div>`;
        }
      }
    }
    pv += msgs.map(([cls, text]) => `<div class="pv-msg ${cls}">${esc(text)}</div>`).join('');
    $('#o-preview').innerHTML = pv;
    setSaveEnabled(ok);
    return ok;
  };

  const update = debounced(() => {
    if (!touched.liters) {
      const ex = expected(w.odo.value);
      if (ex) w.liters.set(round2(Math.min(cap + 0.6, ex.liters)));
    }
    evaluate();
  });

  openSheet({
    title: isEdit ? 'Öl-Eintrag' : '2-Takt-Öl',
    right: 'Sichern',
    body,
    onRight: () => {
      if (!evaluate()) return;
      const v = read();
      const entry = cleanOil({ id: existing ? existing.id : uid(), ...v });
      const before = knownOdometer();
      data.oil = [...others, entry];
      // Der km-Stand beim Ölnachfüllen ist gleichzeitig eine Tacho-Ablesung.
      if (before == null || entry.odometer > before) {
        data.reading = { odometer: entry.odometer, date: entry.date, ...(entry.time ? { time: entry.time } : {}) };
      }
      commit();
      closeSheet();
      renderView();
      toast(entry.liters === 0 && !entry.full ? 'Kontrolle eingetragen' : 'Öl eingetragen');
    },
    onAction: async (a) => {
      if (a !== 'delete') return;
      const yes = await confirmAction({ message: 'Dieser Öl-Eintrag wird gelöscht.', confirmLabel: 'Eintrag löschen' });
      if (!yes) return;
      data.oil = others;
      commit();
      closeSheet();
      renderView();
      toast('Eintrag gelöscht');
    },
    onOpen: (root) => {
      w.odo = mountWheel(root.querySelector('[data-wheel="odo"]'), {
        value: startOdo,
        min: 0,
        max: 999999,
        step: 1,
        span: { below: 1500, above: 3000 },
        format: fmtKmWheel,
        parse: parseNumber,
        label: 'km-Stand',
        speed: 1.3,
        dragAccel: 0.6,
        placeholder: 'Tacho-km',
        onChange: update,
      });
      w.liters = mountWheel(root.querySelector('[data-wheel="liters"]'), {
        value: startLiters,
        min: 0,
        max: round2(cap + 0.6),
        step: 0.01,
        format: fmtL2,
        parse: parseNumber,
        label: 'Nachgefüllte Liter',
        speed: 1.6,
        dragAccel: 1,
        onChange: (val, { user }) => {
          if (user) touched.liters = true;
          update();
        },
      });
      root.querySelectorAll('#o-date, #o-time').forEach((i) => i.addEventListener('input', evaluate));
      root.querySelector('#o-full').addEventListener('change', evaluate);
      evaluate();
      if (startOdo == null) w.odo.focusInput();
    },
  });
}

/* ---------- Ergebnis nach dem Tanken ---------- */

function openResultSheet(entry, before) {
  const row = A.history.find((r) => r.id === entry.id);
  const seg = A.segmentById.get(entry.id);
  if (!row || !seg) return;
  const rel = row.relError;
  const verdict = rel < 0.05 ? 'Volltreffer!' : rel < 0.12 ? 'Gut geschätzt' : 'Wieder etwas gelernt';
  const e = A.estimate;
  const cap = A.settings.tankCapacity;
  const oldRange = (cap / before.estimate.mean) * 100;
  const newRange = (cap / e.mean) * 100;
  const confDelta = Math.round((e.confidence - before.estimate.confidence) * 100);
  const sign = (x) => (x >= 0 ? '+' : '−');

  const body = `
  <div class="result">
    <div class="result-check">${icon('check')}</div>
    <h2>${verdict}</h2>
    <p>${fL(seg.liters)} L für ${fKm(seg.km)} km · ${fC(seg.consumption)} L/100 km</p>
    <div class="compare">
      <div class="card"><div class="kpi-label">Prognose</div><div class="kpi-value">${fL(row.predictedLiters)}<small> L</small></div></div>
      <div class="card"><div class="kpi-label">Getankt</div><div class="kpi-value">${fL(row.liters)}<small> L</small></div></div>
    </div>
    <div class="list">
      <div class="row" style="--inset:58px"><span class="row-icon bg-orange">${icon('target')}</span><span class="row-main">Abweichung</span>
        <span class="row-detail">${sign(row.error)}${nf(Math.abs(row.error), 2, 2)} L (${Math.round(rel * 100)} %)</span></div>
      <div class="row" style="--inset:58px"><span class="row-icon bg-blue">${icon('drop')}</span><span class="row-main">Ø Verbrauch</span>
        <span class="row-detail">${fC(before.estimate.mean)} → <b style="color:var(--label)">${fC(e.mean)}</b></span></div>
      <div class="row" style="--inset:58px"><span class="row-icon bg-green">${icon('road')}</span><span class="row-main">Reichweite pro Tank</span>
        <span class="row-detail">${fKm(oldRange)} → <b style="color:var(--label)">${fKm(newRange)} km</b></span></div>
      <div class="row" style="--inset:58px"><span class="row-icon bg-indigo">${icon('sparkles')}</span><span class="row-main">Modellsicherheit</span>
        <span class="row-detail"><b style="color:var(--label)">${Math.round(e.confidence * 100)} %</b>${confDelta ? ` (${sign(confDelta)}${Math.abs(confDelta)})` : ''}</span></div>
    </div>
    <p class="section-footer" style="text-align:left">Das Modell hat diese Tankfüllung eingerechnet. Je mehr Volltankungen, desto genauer werden Reichweite und Tankstand.</p>
    <button class="btn btn-primary btn-block" data-sheet-action="close" style="margin-top:20px">Fertig</button>
  </div>`;

  openSheet({
    title: 'Tankung gespeichert',
    left: false,
    right: 'Fertig',
    body,
    onRight: closeSheet,
    onAction: (a) => a === 'close' && closeSheet(),
  });
}

/* ---------- km-Stand ablesen ---------- */

function openReadingSheet() {
  const last = A.fillUps[A.fillUps.length - 1];
  if (!last) {
    openFillSheet();
    return;
  }
  const start = Math.max(last.odometer, knownOdometer() ?? last.odometer);
  const body = `
    <div class="list">${whenField('r', todayISO(), nowTime())}</div>
    ${pickerHtml([{ key: 'odo', label: 'km-Stand', unit: 'km' }], true)}
    <p class="section-footer">Einfach den Tacho ablesen und das Rad drehen – die App rechnet aus, wie viel noch im Tank ist und wie weit du noch kommst.</p>
    <div class="preview" id="r-preview" aria-live="polite"></div>`;

  let wheel = null;
  const evaluate = () => {
    const odo = wheel.value;
    const date = $('#r-date').value || todayISO();
    const ok = Number.isFinite(odo) && odo > last.odometer;
    let pv = '';
    if (Number.isFinite(odo) && odo <= last.odometer) {
      pv = `<div class="pv-row"><span class="row-icon bg-blue">${icon('gauge')}</span><div><span>Dreh auf den aktuellen Tacho-Stand – er muss über <b>km ${fOdo(last.odometer)}</b> (letzte Tankung) liegen.</span></div></div>`;
    } else if (ok) {
      const t = analyze({ ...data, reading: { odometer: odo, date } });
      if (t.status) {
        const lv = LEVEL[t.status.level];
        pv = `<div class="pv-row"><span class="row-icon" style="background-color:${lv.color}">${icon('gauge')}</span><div><b>noch ca. ${fKm(t.status.range)} km</b> <span>Reichweite (${fKm(t.status.rangeLow)}–${fKm(t.status.rangeHigh)})</span></div></div>
          <div class="pv-row"><span class="row-icon bg-blue">${icon('drop')}</span><div><b>${nf(t.status.fuel, 1, 1)} L</b> <span>im Tank · ${Math.round(t.status.percent * 100)} %</span></div></div>`;
      }
      if (odo - last.odometer > 1500) pv += '<div class="pv-msg warn">Über 1.500 km seit der letzten Tankung – stimmt der km-Stand?</div>';
    }
    $('#r-preview').innerHTML = pv;
    setSaveEnabled(ok);
    return ok;
  };

  openSheet({
    title: 'km-Stand',
    right: 'Sichern',
    body,
    onRight: () => {
      if (!evaluate()) return;
      const time = $('#r-time').value;
      data.reading = { odometer: wheel.value, date: $('#r-date').value || todayISO(), ...(isTime(time) ? { time } : {}) };
      commit();
      closeSheet();
      renderView();
      toast('km-Stand aktualisiert');
    },
    onOpen: (root) => {
      wheel = mountWheel(root.querySelector('[data-wheel="odo"]'), {
        value: start,
        min: last.odometer,
        max: 999999,
        step: 1,
        span: { below: 2000, above: 3000 },
        format: fmtKmWheel,
        parse: parseNumber,
        label: 'km-Stand',
        speed: 1.3,
        dragAccel: 0.6,
        onChange: debounced(evaluate),
      });
      root.querySelectorAll('#r-date, #r-time').forEach((i) => i.addEventListener('input', evaluate));
      evaluate();
    },
  });
}

/* ---------- Aktionsblatt (Bestätigung) ---------- */

function confirmAction({ message, confirmLabel, destructive = true }) {
  return new Promise((resolve) => {
    const bd = document.createElement('div');
    bd.className = 'backdrop as-backdrop';
    const as = document.createElement('div');
    as.className = 'action-sheet';
    as.setAttribute('role', 'alertdialog');
    as.innerHTML = `<div class="as-group"><div class="as-msg"></div><button class="${destructive ? 'destructive' : ''}" data-r="1"></button>
      <button class="cancel" data-r="0">Abbrechen</button></div>`;
    as.querySelector('.as-msg').textContent = message;
    as.querySelector('[data-r="1"]').textContent = confirmLabel;
    document.body.append(bd, as);
    requestAnimationFrame(() => {
      bd.classList.add('open');
      as.classList.add('open');
    });
    const done = (r) => {
      bd.classList.remove('open');
      as.classList.remove('open');
      setTimeout(() => {
        bd.remove();
        as.remove();
      }, 400);
      resolve(r);
    };
    bd.addEventListener('click', () => done(false));
    as.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (b) done(b.dataset.r === '1');
    });
    as.querySelector('.cancel').focus({ preventScroll: true });
  });
}

/* ---------- Toast ---------- */

let toastTimer = null;
function toast(text, ic = 'check') {
  const t = $('#toast');
  t.innerHTML = `${icon(ic)}<span></span>`;
  t.querySelector('span').textContent = text;
  if (ic === 'warning') t.querySelector('.ico').style.color = 'var(--orange)';
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ========================================================================== */
/* Daten: Export, Import, Beispieldaten                                        */
/* ========================================================================== */

async function exportData() {
  const payload = JSON.stringify({ app: 'RollerTank', exportedAt: new Date().toISOString(), ...data }, null, 2);
  const name = `rollertank-backup-${todayISO()}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Roller Tank Backup' });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('Backup erstellt');
}

async function importData(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!parsed || !Array.isArray(parsed.fillUps)) throw new Error('format');
    const next = normalize(parsed);
    const ok = data.fillUps.length
      ? await confirmAction({
        message: `Backup mit ${next.fillUps.length} Tankungen laden? Die aktuellen Daten werden ersetzt.`,
        confirmLabel: 'Daten ersetzen',
      })
      : true;
    if (!ok) return;
    data = next;
    commit();
    renderView();
    toast(`${next.fillUps.length} Tankungen importiert`);
  } catch (e) {
    toast('Datei konnte nicht gelesen werden', 'warning');
  }
}

function demoData() {
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return localISO(d);
  };
  const fills = [];
  let odo = 8640;
  let offset = -80;
  const price = () => 1.82 + rnd() * 0.14;
  const time = () => `${String(7 + Math.floor(rnd() * 12)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
  fills.push({ id: uid(), date: day(offset), odometer: odo, liters: 4.6, full: true, price: Math.round(4.6 * 1.86 * 100) / 100 });
  for (let i = 0; i < 11; i += 1) {
    const km = Math.round(118 + rnd() * 58);
    const c = 2.62 + (rnd() - 0.5) * 0.36 + (i >= 8 ? 0.22 : 0);
    let liters = (km * c) / 100;
    const days = 5 + Math.round(rnd() * 3);
    if (i === 5) {
      // Teilbetankung unterwegs
      const part = 1.5;
      const partOdo = odo + Math.round(km * 0.55);
      fills.push({ id: uid(), date: day(offset + 3), time: time(), odometer: partOdo, liters: part, full: false, price: Math.round(part * price() * 100) / 100 });
      liters -= part;
    }
    if (i === 7) liters *= 0.62; // nicht ganz voll getankt → Ausreißer
    odo += km;
    offset += days;
    liters = Math.round(liters * 100) / 100;
    fills.push({ id: uid(), date: day(Math.min(offset, -3)), time: time(), odometer: odo, liters, full: true, price: Math.round(liters * price() * 100) / 100 });
  }
  // 2-Takt-Öl: ca. 60 ml/100 km (Pumpe ≈ 1:45), dazwischen eine Kontrolle
  const dateAt = (o) => {
    const near = fills.reduce((a, f) => (Math.abs(f.odometer - o) < Math.abs(a.odometer - o) ? f : a));
    return near.date;
  };
  const o0 = fills[0].odometer;
  const oil = [
    { id: uid(), date: dateAt(o0), odometer: o0, liters: 0.3, full: true },
    { id: uid(), date: dateAt(o0 + 548), odometer: o0 + 548, liters: 0.34, full: true },
    { id: uid(), date: dateAt(o0 + 1121), odometer: o0 + 1121, liters: 0.36, full: true },
    { id: uid(), date: dateAt(o0 + 1451), odometer: o0 + 1451, liters: 0, full: false },
  ];
  return normalize({
    settings: data.settings,
    fillUps: fills,
    oil,
    reading: { odometer: odo + 46, date: todayISO(), time: nowTime() },
    demo: true,
    ui: data.ui,
  });
}

/* ========================================================================== */
/* Ereignisse                                                                 */
/* ========================================================================== */

async function handleAction(el) {
  const a = el.dataset.action;
  switch (a) {
    case 'add-fill':
      openFillSheet();
      break;
    case 'edit-fill': {
      const f = data.fillUps.find((x) => x.id === el.dataset.id);
      if (f) openFillSheet(f);
      break;
    }
    case 'reading':
      openReadingSheet();
      break;
    case 'add-oil':
      openOilSheet();
      break;
    case 'edit-oil': {
      const e = data.oil.find((x) => x.id === el.dataset.id);
      if (e) openOilSheet(e);
      break;
    }
    case 'history-mode': {
      const prev = historyMode;
      historyMode = el.dataset.mode === 'oil' ? 'oil' : 'fuel';
      if (prev === historyMode) break;
      renderNavbar();
      renderView();
      // Kapsel vom alten zum neuen Segment gleiten lassen
      const seg = $('#history-seg');
      if (seg) {
        seg.dataset.active = prev;
        seg.getBoundingClientRect();
        seg.dataset.active = historyMode;
      }
      break;
    }
    case 'fab':
      if (fabTarget() === 'oil') openOilSheet();
      else openFillSheet();
      break;
    case 'goto':
      switchTab(el.dataset.tab);
      break;
    case 'dismiss-install':
      data.ui.installDismissed = true;
      commit();
      renderView();
      break;
    case 'demo-load':
      data = demoData();
      commit();
      shown = { range: null, percent: null };
      switchTab('tank');
      toast('Beispieldaten geladen');
      break;
    case 'demo-clear':
      data = normalize({ settings: data.settings, ui: data.ui });
      commit();
      renderView();
      toast('Beispieldaten entfernt');
      break;
    case 'export':
      exportData();
      break;
    case 'import':
      $('#import-file').click();
      break;
    case 'reset': {
      const ok = await confirmAction({
        message: 'Alle Tankungen und Einstellungen werden von diesem Gerät gelöscht. Das kann nicht rückgängig gemacht werden.',
        confirmLabel: 'Alles löschen',
      });
      if (!ok) return;
      data = normalize({ ui: data.ui });
      commit();
      shown = { range: null, percent: null };
      renderView();
      toast('Alle Daten gelöscht');
      break;
    }
    default:
  }
}

document.addEventListener('click', (e) => {
  const tabBtn = e.target.closest('[data-tab-btn]');
  if (tabBtn) {
    if (tabBtn.dataset.tabBtn === currentTab) window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    else switchTab(tabBtn.dataset.tabBtn);
    return;
  }
  const el = e.target.closest('[data-action]');
  if (el) handleAction(el);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheetCtx) closeSheet();
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[role="button"][data-action]')) {
    e.preventDefault();
    handleAction(e.target);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.matches('[data-setting]')) onSettingChange(e.target);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-setting]')) e.target.blur();
});

$('#import-file').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) importData(f);
  e.target.value = '';
});

window.addEventListener('scroll', onScroll, { passive: true });

let resizeTimer = null;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentTab === 'analysis') drawCharts();
  }, 150);
});

// Wenn die App aus dem Hintergrund zurückkommt: relative Datumsangaben auffrischen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !sheetCtx && currentTab !== 'settings') renderView();
});

window.addEventListener('storage', (e) => {
  if (e.key === STORAGE_KEY) {
    data = load();
    A = analyze(data);
    renderView();
  }
});

/* ========================================================================== */
/* Start                                                                      */
/* ========================================================================== */

renderTabbar();
switchTab('tank');

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}
