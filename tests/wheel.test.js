import test from 'node:test';
import assert from 'node:assert/strict';
import { projectFlick, boost, PHYSICS } from '../site/js/wheel.js';

// Geschwindigkeiten in Zeilen pro Sekunde (1 Zeile = 34 px = 1 km)
test('langsames Wischen bleibt präzise', () => {
  const f = projectFlick(100, 5, 10000);
  assert.ok(Math.abs(f.target - 100) <= 3, `target ${f.target}`);
  assert.ok(boost(5) < 1.2);
});

test('ein kräftiger Wischer läuft weit', () => {
  const f = projectFlick(100, 80, 10000); // ≈ 2.700 px/s Fingergeschwindigkeit
  assert.ok(f.target - 100 >= 70, `nur ${f.target - 100} Zeilen`);
  assert.ok(f.duration <= 2.4);
});

test('3 kräftige Wischer schaffen über 200 km (mit verkettetem Schwung)', () => {
  let pos = 0;
  let carried = 0;
  for (let i = 0; i < 3; i += 1) {
    const f = projectFlick(pos, 65, 100000, carried);
    // nach ca. 40 % der Laufzeit kommt der nächste Wischer
    const t = 0.4;
    pos += (f.target - pos) * (1 - (1 - t) ** 3);
    carried = f.velocity * (1 - t) ** 2;
  }
  assert.ok(pos >= 200, `nur ${Math.round(pos)} km`);
});

test('Ziel ist ganzzahlig und bleibt im Bereich', () => {
  const up = projectFlick(5, 200, 50);
  assert.equal(up.target, 49);
  const down = projectFlick(5, -200, 50);
  assert.equal(down.target, 0);
  assert.ok(Number.isInteger(projectFlick(10.4, 30, 1000).target));
});

test('Gegenrichtung übernimmt keinen Schwung', () => {
  const a = projectFlick(500, -40, 10000);
  const b = projectFlick(500, -40, 10000, 300);
  assert.equal(a.target, b.target);
  assert.ok(PHYSICS.BOOST_MAX >= 3);
});
