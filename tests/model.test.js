import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNumber, buildSegments, estimateConsumption, backtest, analyze, expectedFill, DEFAULT_SETTINGS,
} from '../site/js/model.js';

const S = { ...DEFAULT_SETTINGS };
let id = 0;
const fill = (date, odometer, liters, full = true, price) => ({ id: `f${++id}`, date, odometer, liters, full, price });

test('parseNumber versteht deutsche Eingaben', () => {
  assert.equal(parseNumber('4,3'), 4.3);
  assert.equal(parseNumber('4.3'), 4.3);
  assert.equal(parseNumber('12.345'), 12345);
  assert.equal(parseNumber('12.345,6'), 12345.6);
  assert.equal(parseNumber(' 7 '), 7);
  assert.ok(Number.isNaN(parseNumber('')));
  assert.ok(Number.isNaN(parseNumber('abc')));
});

test('Voll-zu-Voll-Strecken inkl. Teilbetankung', () => {
  const segs = buildSegments([
    fill('2026-01-01', 1000, 6, true),
    fill('2026-01-05', 1100, 1.5, false),
    fill('2026-01-09', 1200, 4.5, true),
    fill('2026-01-15', 1350, 4.5, true),
  ]);
  assert.equal(segs.length, 2);
  assert.equal(segs[0].km, 200);
  assert.equal(segs[0].liters, 6);
  assert.equal(segs[0].partials, 1);
  assert.equal(segs[0].consumption, 3);
  assert.equal(segs[1].km, 150);
  assert.equal(segs[1].consumption, 3);
});

test('Teilbetankung vor der ersten Volltankung wird ignoriert', () => {
  const segs = buildSegments([
    fill('2026-01-01', 900, 2, false),
    fill('2026-01-02', 1000, 5, true),
    fill('2026-01-09', 1100, 2.5, true),
  ]);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].consumption, 2.5);
});

test('ohne Daten gilt der Startwert, Sicherheit 0', () => {
  const e = estimateConsumption([], S);
  assert.equal(e.mean, S.priorConsumption);
  assert.equal(e.confidence, 0);
  assert.equal(e.label, 'Startwert');
});

test('Schätzung nähert sich dem echten Verbrauch und wird sicherer', () => {
  const fills = [fill('2026-01-01', 1000, 7)];
  let odo = 1000;
  const confidences = [];
  const widths = [];
  const noise = [0.1, -0.08, 0.05, -0.1, 0.07, -0.03, 0.09, -0.06, 0.02, -0.04];
  for (let i = 0; i < 10; i += 1) {
    odo += 150;
    const liters = 150 * (2.4 + noise[i]) / 100;
    fills.push(fill(`2026-01-${String(2 + i * 2).padStart(2, '0')}`, odo, liters));
    const e = estimateConsumption(buildSegments(fills), S);
    confidences.push(e.confidence);
    widths.push(e.high - e.low);
  }
  const final = estimateConsumption(buildSegments(fills), S);
  assert.ok(Math.abs(final.mean - 2.4) < 0.08, `mean ${final.mean}`);
  assert.ok(confidences[9] > confidences[0], 'Sicherheit steigt');
  assert.ok(widths[9] < widths[0], 'Intervall wird schmaler');
  assert.ok(final.low < 2.4 && final.high > 2.4);
});

test('Ausreißer werden erkannt und abgewertet', () => {
  const fills = [fill('2026-01-01', 1000, 7)];
  let odo = 1000;
  for (let i = 0; i < 6; i += 1) {
    odo += 150;
    fills.push(fill(`2026-02-0${i + 1}`, odo, i === 3 ? 1.2 : 4.5));
  }
  const segs = buildSegments(fills);
  const e = estimateConsumption(segs, S);
  const flagged = e.items.filter((it) => it.outlier);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].id, segs[3].id);
  assert.ok(Math.abs(e.mean - 3.0) < 0.15, `mean ${e.mean}`);
});

test('neuere Tankungen zählen mehr (Anpassung an Trend)', () => {
  const fills = [fill('2026-01-01', 1000, 7)];
  let odo = 1000;
  for (let i = 0; i < 12; i += 1) {
    odo += 150;
    const c = i < 6 ? 2.5 : 3.2;
    fills.push(fill(`2026-03-${String(i + 1).padStart(2, '0')}`, odo, (150 * c) / 100));
  }
  const e = estimateConsumption(buildSegments(fills), S);
  assert.ok(e.mean > 2.85, `mean ${e.mean} sollte näher an 3,2 liegen`);
});

test('Backtest: Prognosefehler sinkt mit mehr Daten', () => {
  const fills = [fill('2026-01-01', 1000, 7)];
  let odo = 1000;
  for (let i = 0; i < 8; i += 1) {
    odo += 140;
    fills.push(fill(`2026-04-${String(i + 1).padStart(2, '0')}`, odo, (140 * 2.2) / 100));
  }
  const rows = backtest(buildSegments(fills), S);
  assert.equal(rows.length, 8);
  assert.ok(rows[7].absError < rows[0].absError);
  assert.ok(Math.abs(rows[0].predictedConsumption - S.priorConsumption) < 1e-9);
});

test('Analyse: Tankinhalt und Reichweite', () => {
  const data = {
    settings: S,
    fillUps: [
      fill('2026-05-01', 2000, 6.5),
      fill('2026-05-08', 2150, 4.5),
      fill('2026-05-15', 2300, 4.5),
      fill('2026-05-22', 2450, 4.5),
    ],
    reading: { odometer: 2520, date: '2026-05-24' },
  };
  const a = analyze(data);
  assert.ok(a.status);
  assert.equal(a.status.odometer, 2520);
  assert.equal(a.status.kmSinceFull, 70);
  const c = a.estimate.mean;
  assert.ok(Math.abs(a.status.fuel - (7 - (c * 70) / 100)) < 1e-9);
  assert.ok(Math.abs(a.status.range - ((7 * 100) / c - 70)) < 1e-6);
  assert.ok(a.status.rangeLow < a.status.range && a.status.range < a.status.rangeHigh);
  assert.ok(a.status.refuelAt > 2520);
  assert.ok(a.perDay > 0);
});

test('Ablesung kleiner als letzte Tankung wird ignoriert', () => {
  const a = analyze({
    settings: S,
    fillUps: [fill('2026-05-01', 2000, 6), fill('2026-05-08', 2150, 4.5)],
    reading: { odometer: 2100, date: '2026-05-05' },
  });
  assert.equal(a.status.odometer, 2150);
  assert.equal(a.status.fuel, 7);
});

test('Teilbetankung erhöht den Tankinhalt (max. Tankgröße)', () => {
  const fills = [fill('2026-05-01', 2000, 6), fill('2026-05-03', 2100, 1, false)];
  const a = analyze({ settings: S, fillUps: fills });
  const expected = Math.min(7, 7 - (a.estimate.mean * 100) / 100 + 1);
  assert.ok(Math.abs(a.status.fuel - expected) < 1e-9);
});

test('expectedFill sagt die Literzahl vorher', () => {
  const fills = [fill('2026-05-01', 2000, 6), fill('2026-05-08', 2150, 4.5)];
  const a = analyze({ settings: S, fillUps: fills });
  const ex = expectedFill(a.fillUps, a.settings, a.estimate, 2300);
  assert.ok(Math.abs(ex.liters - (a.estimate.mean * 150) / 100) < 1e-9);
  assert.ok(ex.litersLow < ex.liters && ex.liters < ex.litersHigh);
});

test('ohne Volltankung kein Status', () => {
  const a = analyze({ settings: S, fillUps: [fill('2026-05-01', 2000, 3, false)] });
  assert.equal(a.status, null);
});

test('Kosten pro 100 km', () => {
  const a = analyze({
    settings: S,
    fillUps: [fill('2026-05-01', 2000, 6, true, 11.4), fill('2026-05-08', 2200, 6, true, 11.4)],
  });
  assert.ok(Math.abs(a.stats.pricePerLiter - 1.9) < 1e-9);
  assert.ok(a.stats.costPer100 > 0);
});

/* ---------------- 2-Takt-Öl ---------------- */

const oilEv = (date, odometer, liters, full = true) => ({ id: `o${++id}`, date, odometer, liters, full });

test('Öl: ohne Einträge kein Status, Startwert aus Benzinverbrauch und 1:50', () => {
  const a = analyze({ settings: S, fillUps: [fill('2026-05-01', 2000, 6)], oil: [] });
  assert.equal(a.oil.status, null);
  assert.ok(Math.abs(a.oil.mlPer100 - (a.estimate.mean * 1000) / 50) < 1e-9);
  assert.equal(a.oil.ratioLearned, false);
});

test('Öl: Füllstand sinkt mit gefahrenen km, Kontrolle nach Intervall fällig', () => {
  const data = {
    settings: S,
    fillUps: [fill('2026-05-01', 2000, 6), fill('2026-05-08', 2150, 4.5)],
    oil: [oilEv('2026-05-01', 2000, 0.2)],
    reading: { odometer: 2550, date: '2026-05-20' },
  };
  const a = analyze(data);
  const o = a.oil;
  assert.ok(o.status);
  assert.equal(o.status.kmSinceEvent, 550);
  const used = (o.mlPer100 / 1000) * 5.5;
  assert.ok(Math.abs(o.status.level - (1.2 - used)) < 1e-9);
  assert.equal(o.status.state, 'check');
  assert.ok(o.status.refillAt > 2550);
});

test('Öl: lernt den echten Verbrauch und das Mischverhältnis', () => {
  const oil = [oilEv('2026-01-01', 1000, 0.5)];
  let odo = 1000;
  for (let i = 0; i < 6; i += 1) {
    odo += 500;
    oil.push(oilEv(`2026-0${i + 2}-01`, odo, 0.4)); // 80 ml/100 km
  }
  const a = analyze({ settings: S, fillUps: [fill('2026-01-01', 1000, 6), fill('2026-01-08', 1150, 4.5)], oil });
  assert.ok(Math.abs(a.oil.mlPer100 - 80) < 4, `ml ${a.oil.mlPer100}`);
  assert.equal(a.oil.ratioLearned, true);
  assert.ok(Math.abs(a.oil.tankRange - 1500) < 90, `range ${a.oil.tankRange}`);
});

test('Öl: „nur kontrolliert“ (0 L, nicht voll) setzt das Prüf-Intervall zurück, ändert den Füllstand nicht', () => {
  const base = {
    settings: S,
    fillUps: [fill('2026-05-01', 2000, 6)],
    oil: [oilEv('2026-05-01', 2000, 0.3)],
    reading: { odometer: 2600, date: '2026-05-20' },
  };
  const before = analyze(base).oil.status;
  const after = analyze({ ...base, oil: [...base.oil, oilEv('2026-05-20', 2600, 0, false)] }).oil.status;
  assert.equal(before.state, 'check');
  assert.notEqual(after.state, 'check');
  assert.ok(Math.abs(after.level - before.level) < 1e-9);
});

test('Öl: Reserve erreicht → nachfüllen', () => {
  const a = analyze({
    settings: S,
    fillUps: [fill('2026-05-01', 2000, 6)],
    oil: [oilEv('2026-05-01', 2000, 0.3), oilEv('2026-06-01', 3400, 0, false)],
    reading: { odometer: 3500, date: '2026-06-03' },
  });
  assert.equal(a.oil.status.state, 'refill');
  assert.ok(a.insights.some((i) => i.title === '2-Takt-Öl nachfüllen'));
});
