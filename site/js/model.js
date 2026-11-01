/**
 * Analyse-Engine für den Roller-Tank-Tracker.
 *
 * Idee: Jede Strecke zwischen zwei Volltankungen ("Voll-zu-Voll"-Methode) ist eine
 * Messung des Verbrauchs. Die Engine kombiniert diese Messungen mit einem
 * Startwert (Prior) zu einer Schätzung, die mit jeder Tankung genauer wird:
 *
 *  - Längere Strecken zählen mehr (weniger Messfehler beim Volltanken).
 *  - Neuere Tankungen zählen mehr (Jahreszeit, Fahrweise, Reifendruck ändern sich).
 *  - Ausreißer (z. B. nicht ganz voll getankt) werden erkannt und abgewertet.
 *  - Die Streuung der Messungen ergibt ein Unsicherheitsband, das schmaler wird,
 *    je mehr Daten vorliegen.
 *
 * Alle Funktionen sind rein (keine DOM-/Storage-Zugriffe) und werden in
 * tests/model.test.js geprüft.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  vehicleName: 'Honda Bali 50',
  vehicleModel: 'AF32',
  tankCapacity: 7, // Liter
  reserveLiters: 1, // ab dieser Restmenge wird gewarnt
  priorConsumption: 3.0, // L/100 km – typischer Startwert für 50er-2-Takter
});

export const MODEL = Object.freeze({
  HALF_LIFE: 8, // nach 8 Tankungen zählt eine Messung nur noch halb
  PRIOR_KM: 50, // der Startwert zählt wie 50 gefahrene Kilometer
  PRIOR_SD_REL: 0.12, // angenommene Streuung ohne Daten: ±12 %
  PRIOR_COUNT: 1, // so viele "virtuelle" Tankungen stecken im Startwert
  MAX_SEGMENT_KM: 400, // sehr lange Strecken nicht übergewichten
  Z80: 1.2816, // 80-%-Intervall
});

const DAY_MS = 86400000;

/* ------------------------------------------------------------------ */
/* Hilfsfunktionen                                                      */
/* ------------------------------------------------------------------ */

export function parseNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (value == null) return NaN;
  let s = String(value).trim().replace(/\s/g, '');
  if (!s) return NaN;
  // "12.345,6" (de) → 12345.6 ; "4,3" → 4.3 ; "4.3" → 4.3
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.')
      ? s.replace(/\./g, '').replace(',', '.')
      : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "12.345" als Tausendertrennzeichen interpretieren
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function daysBetween(a, b) {
  const da = Date.parse(a);
  const db = Date.parse(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return NaN;
  return (db - da) / DAY_MS;
}

export function sortFillUps(fillUps) {
  return [...fillUps].sort(
    (a, b) => a.odometer - b.odometer || String(a.date).localeCompare(String(b.date)),
  );
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ */
/* Segmente (Voll-zu-Voll)                                              */
/* ------------------------------------------------------------------ */

/**
 * Baut aus den Tankungen die Messstrecken. Eine Strecke beginnt bei einer
 * Volltankung und endet bei der nächsten Volltankung; Teilbetankungen dazwischen
 * werden zu den Litern addiert.
 */
export function buildSegments(fillUps) {
  const sorted = sortFillUps(fillUps);
  const segments = [];
  let anchor = null;
  let liters = 0;
  let partials = 0;

  for (const f of sorted) {
    if (!anchor) {
      if (f.full) anchor = f;
      continue;
    }
    liters += f.liters;
    if (!f.full) {
      partials += 1;
      continue;
    }
    const km = f.odometer - anchor.odometer;
    if (km > 0 && liters > 0) {
      segments.push({
        id: f.id,
        fromId: anchor.id,
        startOdometer: anchor.odometer,
        endOdometer: f.odometer,
        startDate: anchor.date,
        date: f.date,
        km,
        liters,
        lastLiters: f.liters,
        consumption: (liters / km) * 100,
        partials,
        days: daysBetween(anchor.date, f.date),
      });
    }
    anchor = f;
    liters = 0;
    partials = 0;
  }
  return segments;
}

/* ------------------------------------------------------------------ */
/* Schätzung                                                            */
/* ------------------------------------------------------------------ */

/**
 * Schätzt den Verbrauch aus den Messstrecken.
 * Rückgabe: mean (L/100 km), sd (Streuung einer einzelnen Tankfüllung),
 * predSd (Unsicherheit für die nächste Tankfüllung), Intervallgrenzen,
 * Gewichte je Strecke, effektive Anzahl Messungen und eine Modellsicherheit 0..1.
 */
export function estimateConsumption(segments, settings = DEFAULT_SETTINGS) {
  const mu0 = settings.priorConsumption > 0 ? settings.priorConsumption : DEFAULT_SETTINGS.priorConsumption;
  const sd0 = mu0 * MODEL.PRIOR_SD_REL;
  const n = segments.length;

  // Robuste Ausreißererkennung (Median + MAD), erst ab 4 Messungen sinnvoll.
  const cs = segments.map((s) => s.consumption);
  const med = median(cs);
  const mad = median(cs.map((c) => Math.abs(c - med)));
  const scale = Math.max(1.4826 * mad, 0.08 * (med || mu0), 0.1);

  const items = segments.map((s, i) => {
    const age = n - 1 - i;
    const recency = Math.pow(0.5, age / MODEL.HALF_LIFE);
    const z = n >= 4 ? Math.abs(s.consumption - med) / scale : 0;
    const outlierFactor = z > 3.5 ? 0.15 : z > 2.5 ? 0.5 : 1;
    const kmWeight = Math.min(s.km, MODEL.MAX_SEGMENT_KM) / 100;
    return {
      id: s.id,
      consumption: s.consumption,
      recency,
      outlier: outlierFactor < 1,
      z,
      wMean: kmWeight * recency * outlierFactor, // Gewicht für den Mittelwert (km-basiert)
      wCount: recency * outlierFactor, // Gewicht für die Streuung (zählt Tankungen)
    };
  });

  const w0 = MODEL.PRIOR_KM / 100;
  const sumW = items.reduce((a, it) => a + it.wMean, 0);
  const mean = (w0 * mu0 + items.reduce((a, it) => a + it.wMean * it.consumption, 0)) / (w0 + sumW);

  const nu0 = MODEL.PRIOR_COUNT;
  const sumV = items.reduce((a, it) => a + it.wCount, 0);
  const sumV2 = items.reduce((a, it) => a + it.wCount * it.wCount, 0);
  const ss = items.reduce((a, it) => a + it.wCount * (it.consumption - mean) ** 2, 0);
  const sd = Math.sqrt((nu0 * sd0 * sd0 + ss) / (nu0 + sumV));
  const nEff = sumV2 > 0 ? (sumV * sumV) / sumV2 : 0;
  const se = sd / Math.sqrt(1 + nEff);
  const predSd = Math.sqrt(sd * sd + se * se);

  const low = Math.max(mean * 0.3, mean - MODEL.Z80 * predSd);
  const high = mean + MODEL.Z80 * predSd;

  // Modellsicherheit: wie viele Daten × wie konstant sind sie.
  const rel = predSd / mean;
  const dataFactor = 1 - Math.exp(-sumV / 3);
  const precisionFactor = clamp((0.3 - rel) / (0.3 - 0.04), 0.15, 1);
  const confidence = n === 0 ? 0 : clamp(dataFactor * precisionFactor, 0, 1);

  return {
    mean,
    sd,
    se,
    predSd,
    low,
    high,
    rel,
    n,
    nEff,
    confidence,
    label: confidenceLabel(n, confidence),
    priorShare: w0 / (w0 + sumW),
    items,
    prior: mu0,
  };
}

export function confidenceLabel(n, confidence) {
  if (n === 0) return 'Startwert';
  if (confidence < 0.3) return 'Lernt noch';
  if (confidence < 0.55) return 'Erste Prognosen';
  if (confidence < 0.8) return 'Wird genauer';
  return 'Präzise';
}

/* ------------------------------------------------------------------ */
/* Rückblick: Wie gut waren die Prognosen?                              */
/* ------------------------------------------------------------------ */

/**
 * Für jede Strecke: Welche Literzahl hätte das Modell mit dem Wissen *davor*
 * vorhergesagt – und wie weit lag es daneben? Zusätzlich die Modellschätzung
 * *nach* jeder Strecke (für die Lernkurve).
 */
export function backtest(segments, settings = DEFAULT_SETTINGS) {
  const rows = [];
  let before = estimateConsumption([], settings);
  for (let i = 0; i < segments.length; i += 1) {
    const s = segments[i];
    const after = estimateConsumption(segments.slice(0, i + 1), settings);
    const predictedLiters = (before.mean * s.km) / 100;
    const error = s.liters - predictedLiters;
    rows.push({
      id: s.id,
      date: s.date,
      km: s.km,
      liters: s.liters,
      consumption: s.consumption,
      predictedConsumption: before.mean,
      predictedLiters,
      error,
      absError: Math.abs(error),
      relError: Math.abs(error) / s.liters,
      estimateAfter: after.mean,
      lowAfter: after.low,
      highAfter: after.high,
      confidenceAfter: after.confidence,
    });
    before = after;
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Aktueller Tankinhalt & Reichweite                                    */
/* ------------------------------------------------------------------ */

/**
 * Simuliert den Tankinhalt ab der letzten Volltankung bis zu einem km-Stand.
 * Gibt null zurück, wenn es noch keine Volltankung gibt.
 */
export function fuelAt(fillUps, settings, consumption, odometer) {
  const sorted = sortFillUps(fillUps);
  let lastFull = -1;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].full && sorted[i].odometer <= odometer) {
      lastFull = i;
      break;
    }
  }
  if (lastFull < 0) return null;
  const cap = settings.tankCapacity;
  let fuel = cap;
  let odo = sorted[lastFull].odometer;
  for (const f of sorted.slice(lastFull + 1)) {
    if (f.odometer > odometer) break;
    fuel = Math.max(0, fuel - (consumption * (f.odometer - odo)) / 100);
    fuel = Math.min(cap, fuel + f.liters);
    odo = f.odometer;
  }
  fuel = Math.max(0, fuel - (consumption * (odometer - odo)) / 100);
  return { fuel, anchor: sorted[lastFull], kmSinceFull: odometer - sorted[lastFull].odometer };
}

/** Letzter bekannter km-Stand (aus Tankungen oder separater Ablesung). */
export function latestOdometer(fillUps, reading) {
  const sorted = sortFillUps(fillUps);
  const last = sorted[sorted.length - 1];
  let odometer = last ? last.odometer : null;
  let date = last ? last.date : null;
  let source = 'fill';
  if (reading && Number.isFinite(reading.odometer) && (odometer == null || reading.odometer > odometer)) {
    odometer = reading.odometer;
    date = reading.date;
    source = 'reading';
  }
  return odometer == null ? null : { odometer, date, source };
}

/** Durchschnittlich gefahrene Kilometer pro Tag. */
export function kmPerDay(fillUps, reading) {
  const points = sortFillUps(fillUps).map((f) => ({ odometer: f.odometer, date: f.date }));
  if (reading && Number.isFinite(reading.odometer)) points.push({ odometer: reading.odometer, date: reading.date });
  points.sort((a, b) => a.odometer - b.odometer);
  if (points.length < 2) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const days = daysBetween(first.date, last.date);
  const km = last.odometer - first.odometer;
  if (!(days >= 3) || !(km > 0)) return null;
  return km / days;
}

export function currentStatus(fillUps, settings, estimate, reading) {
  const latest = latestOdometer(fillUps, reading);
  if (!latest) return null;
  const odometer = latest.odometer;
  const mid = fuelAt(fillUps, settings, estimate.mean, odometer);
  if (!mid) return null;
  const pessimistic = fuelAt(fillUps, settings, estimate.high, odometer);
  const optimistic = fuelAt(fillUps, settings, estimate.low, odometer);

  const cap = settings.tankCapacity;
  const reserve = Math.min(settings.reserveLiters, cap);
  const fuel = mid.fuel;
  const range = (fuel / estimate.mean) * 100;
  const rangeLow = (pessimistic.fuel / estimate.high) * 100;
  const rangeHigh = (optimistic.fuel / estimate.low) * 100;
  const kmToReserve = Math.max(0, ((fuel - reserve) / estimate.mean) * 100);
  const kmToReserveSafe = Math.max(0, ((pessimistic.fuel - reserve) / estimate.high) * 100);

  let level = 'ok';
  if (fuel <= reserve + 1e-9) level = 'reserve';
  else if (fuel / cap < 0.35) level = 'low';

  return {
    odometer,
    odometerDate: latest.date,
    odometerSource: latest.source,
    anchor: mid.anchor,
    kmSinceFull: mid.kmSinceFull,
    fuel,
    fuelLow: pessimistic.fuel,
    fuelHigh: optimistic.fuel,
    percent: clamp(fuel / cap, 0, 1),
    range,
    rangeLow,
    rangeHigh,
    kmToReserve,
    refuelAt: odometer + kmToReserveSafe,
    emptyAt: odometer + range,
    level,
    fullRange: (cap / estimate.mean) * 100,
    fullRangeLow: (cap / estimate.high) * 100,
    fullRangeHigh: (cap / estimate.low) * 100,
  };
}

/**
 * Prognose für ein Tankformular: Wie viele Liter werden bei km-Stand X
 * voraussichtlich in den Tank passen?
 */
export function expectedFill(fillUps, settings, estimate, odometer) {
  const mid = fuelAt(fillUps, settings, estimate.mean, odometer);
  if (!mid) return null;
  const lo = fuelAt(fillUps, settings, estimate.low, odometer);
  const hi = fuelAt(fillUps, settings, estimate.high, odometer);
  const cap = settings.tankCapacity;
  return {
    liters: cap - mid.fuel,
    litersLow: cap - lo.fuel,
    litersHigh: cap - hi.fuel,
    kmSinceFull: mid.kmSinceFull,
    fuelLeft: mid.fuel,
  };
}

/* ------------------------------------------------------------------ */
/* Gesamtanalyse                                                        */
/* ------------------------------------------------------------------ */

const fmt = (v, d = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

export function analyze(data) {
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  const fillUps = (data.fillUps || []).filter(
    (f) => Number.isFinite(f.odometer) && Number.isFinite(f.liters) && f.liters >= 0,
  );
  const segments = buildSegments(fillUps);
  const estimate = estimateConsumption(segments, settings);
  const history = backtest(segments, settings);
  const status = currentStatus(fillUps, settings, estimate, data.reading);
  const perDay = kmPerDay(fillUps, data.reading);

  const outlierIds = new Set(estimate.items.filter((it) => it.outlier).map((it) => it.id));
  const segmentById = new Map(segments.map((s) => [s.id, { ...s, outlier: outlierIds.has(s.id) }]));

  // Statistiken
  const totalKm = segments.reduce((a, s) => a + s.km, 0);
  const totalLiters = segments.reduce((a, s) => a + s.liters, 0);
  const priced = fillUps.filter((f) => Number.isFinite(f.price) && f.price > 0);
  const pricedLiters = priced.reduce((a, f) => a + f.liters, 0);
  const totalCost = priced.reduce((a, f) => a + f.price, 0);
  const pricePerLiter = pricedLiters > 0 ? totalCost / pricedLiters : null;
  const costPer100 = pricePerLiter != null ? (pricePerLiter * estimate.mean) : null;

  // Restmenge beim Tanken (nur echte Voll-zu-Voll ohne Teilbetankung)
  // Ausreißer fließen nicht in Bestwerte, Trend und Tankverhalten ein.
  const regular = segments.filter((s) => !outlierIds.has(s.id));
  const cleanSegs = regular.filter((s) => s.partials === 0);
  const leftovers = cleanSegs.map((s) => settings.tankCapacity - s.liters);
  const avgLeftover = leftovers.length ? leftovers.reduce((a, b) => a + b, 0) / leftovers.length : null;
  const maxFill = fillUps.reduce((m, f) => Math.max(m, f.liters), 0);

  // Lernfortschritt: Fehler früher vs. zuletzt
  let learning = null;
  if (history.length >= 4) {
    const half = Math.floor(history.length / 2);
    const early = history.slice(0, half);
    const late = history.slice(-Math.min(3, history.length - half));
    const avg = (rows) => rows.reduce((a, r) => a + r.absError, 0) / rows.length;
    learning = { earlyError: avg(early), lateError: avg(late) };
  }

  // Trend: letzte 3 Messungen gegenüber dem Rest
  let trend = null;
  if (regular.length >= 6) {
    const recent = regular.slice(-3);
    const older = regular.slice(0, -3);
    const ratio = (list) => (list.reduce((a, s) => a + s.liters, 0) / list.reduce((a, s) => a + s.km, 0)) * 100;
    const r = ratio(recent);
    const o = ratio(older);
    trend = { recent: r, older: o, change: (r - o) / o };
  }

  const best = regular.length ? regular.reduce((a, s) => (s.consumption < a.consumption ? s : a)) : null;
  const worst = regular.length ? regular.reduce((a, s) => (s.consumption > a.consumption ? s : a)) : null;
  const avgKmPerTank = segments.length ? totalKm / segments.length : null;

  const insights = buildInsights({
    settings, segments, estimate, status, perDay, avgLeftover, maxFill, learning, trend, history, outlierIds,
  });

  return {
    settings,
    fillUps: sortFillUps(fillUps),
    segments,
    segmentById,
    estimate,
    history,
    status,
    perDay,
    stats: {
      totalKm,
      totalLiters,
      totalCost: priced.length ? totalCost : null,
      pricePerLiter,
      costPer100,
      avgLeftover,
      maxFill,
      best,
      worst,
      avgKmPerTank,
      fillCount: fillUps.length,
    },
    learning,
    trend,
    insights,
  };
}

function buildInsights(ctx) {
  const { settings, segments, estimate, status, perDay, avgLeftover, maxFill, learning, trend, history, outlierIds } = ctx;
  const out = [];
  const cap = settings.tankCapacity;

  if (segments.length) {
    const last = segments[segments.length - 1];
    out.push({
      icon: 'gauge',
      tone: 'blue',
      title: 'Letzte Tankfüllung',
      text: `${fmt(last.liters)} L haben für ${fmt(last.km, 0)} km gereicht – das sind ${fmt(last.consumption, 2)} L/100 km.`,
    });
    const lastRow = history[history.length - 1];
    if (lastRow) {
      const diff = lastRow.error;
      const sign = diff >= 0 ? '+' : '−';
      out.push({
        icon: 'target',
        tone: lastRow.relError < 0.06 ? 'green' : lastRow.relError < 0.15 ? 'blue' : 'orange',
        title: 'Prognose-Check',
        text: `Erwartet waren ${fmt(lastRow.predictedLiters)} L, getankt hast du ${fmt(lastRow.liters)} L (${sign}${fmt(Math.abs(diff), 2)} L). Das Modell hat daraus gelernt.`,
      });
    }
  }

  if (learning && learning.earlyError > 0) {
    const better = learning.lateError < learning.earlyError;
    const pct = Math.round(Math.abs(1 - learning.lateError / learning.earlyError) * 100);
    out.push({
      icon: 'sparkles',
      tone: better ? 'green' : 'orange',
      title: better ? 'Das Modell wird besser' : 'Mehr Streuung als früher',
      text: better
        ? `Die Prognosen liegen zuletzt im Schnitt ${fmt(learning.lateError, 2)} L daneben – ${pct} % genauer als am Anfang (${fmt(learning.earlyError, 2)} L).`
        : `Zuletzt lagen die Prognosen ${fmt(learning.lateError, 2)} L daneben (anfangs ${fmt(learning.earlyError, 2)} L). Dein Verbrauch schwankt gerade stärker.`,
    });
  }

  if (trend && Math.abs(trend.change) >= 0.07) {
    const up = trend.change > 0;
    out.push({
      icon: up ? 'arrowUp' : 'arrowDown',
      tone: up ? 'orange' : 'green',
      title: up ? 'Verbrauch gestiegen' : 'Verbrauch gesunken',
      text: up
        ? `Die letzten 3 Tankfüllungen: ${fmt(trend.recent, 2)} L/100 km statt ${fmt(trend.older, 2)} (+${Math.round(trend.change * 100)} %). Kälte, Reifendruck, Gegenwind oder mehr Vollgas? Die Prognose passt sich automatisch an.`
        : `Die letzten 3 Tankfüllungen: ${fmt(trend.recent, 2)} L/100 km statt ${fmt(trend.older, 2)} (${Math.round(trend.change * 100)} %). Sparsam unterwegs!`,
    });
  }

  if (avgLeftover != null && segments.length >= 2) {
    const leftKm = (avgLeftover / estimate.mean) * 100;
    out.push({
      icon: 'drop',
      tone: avgLeftover < settings.reserveLiters ? 'orange' : 'blue',
      title: 'Dein Tankverhalten',
      text: `Du tankst meist bei noch ca. ${fmt(avgLeftover)} L im Tank – das wären noch rund ${fmt(leftKm, 0)} km gewesen.`,
    });
  }

  if (perDay && status) {
    const days = status.range / perDay;
    out.push({
      icon: 'calendar',
      tone: 'blue',
      title: 'Fahrprofil',
      text: `Du fährst im Schnitt ${fmt(perDay, 0)} km pro Tag. Eine volle Tankfüllung hält damit etwa ${fmt(status.fullRange / perDay, 0)} Tage, der aktuelle Rest noch ca. ${fmt(Math.max(0, days), 0)} Tage.`,
    });
  }

  if (outlierIds.size) {
    out.push({
      icon: 'warning',
      tone: 'orange',
      title: 'Ausreißer erkannt',
      text: `${outlierIds.size === 1 ? 'Eine Tankung weicht' : `${outlierIds.size} Tankungen weichen`} stark ab (evtl. nicht ganz voll getankt) und ${outlierIds.size === 1 ? 'wird' : 'werden'} schwächer gewichtet.`,
    });
  }

  if (maxFill > cap * 1.02) {
    out.push({
      icon: 'warning',
      tone: 'orange',
      title: 'Tankgröße prüfen',
      text: `Einmal passten ${fmt(maxFill)} L hinein, eingestellt sind ${fmt(cap)} L. Ist der Tank größer? Passe das in den Einstellungen an.`,
    });
  }

  if (!segments.length) {
    out.push({
      icon: 'sparkles',
      tone: 'blue',
      title: 'Noch im Lernmodus',
      text: `Bis zur ersten Messung rechnet die App mit ${fmt(estimate.prior)} L/100 km. Nach der nächsten Volltankung kennt sie deinen echten Verbrauch.`,
    });
  }

  return out;
}
