// Kleine, abhängigkeitsfreie SVG-Diagramme mit Tipp-/Hover-Tooltip.
// Farben kommen ausschließlich aus CSS-Variablen (--series-1/2, --grid, …),
// damit Hell- und Dunkelmodus automatisch passen.

const nf = (v, d = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

function niceTicks(min, max, count = 4) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step * 1e-6; v += step) ticks.push(Number(v.toFixed(10)));
  const digits = step >= 1 ? 0 : step >= 0.1 && Math.abs(step * 10 - Math.round(step * 10)) < 1e-9 ? 1 : 2;
  return { lo, hi, step, ticks, digits };
}

function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' });
}

/** Säule mit 4px-Rundung oben, eckig an der Grundlinie. */
function barPath(x, y, w, h) {
  const r = Math.min(4, w / 2, h);
  if (h <= 0) return '';
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/**
 * Verdrahtet Tooltip + Fadenkreuz. `slots` = [{x, rows:[{key, value, label}], title}]
 */
function bindInteraction(container, slots, { crosshair = true, onFocus } = {}) {
  const svg = container.querySelector('svg');
  const overlay = container.querySelector('.hit');
  const tip = container.querySelector('.chart-tip');
  const line = container.querySelector('.crosshair');
  let active = -1;

  function show(idx) {
    if (idx < 0 || idx >= slots.length) return;
    active = idx;
    const s = slots[idx];
    tip.replaceChildren();
    tip.append(el('div', 'tip-title', s.title));
    for (const r of s.rows) {
      const row = el('div', 'tip-row');
      if (r.key) row.append(el('span', `tip-key tip-key-${r.key}`));
      row.append(el('strong', null, r.value));
      row.append(el('span', 'tip-label', r.label));
      tip.append(row);
    }
    tip.hidden = false;
    const rect = container.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / Number(svg.getAttribute('width'));
    const px = s.x * scale;
    const tw = tip.offsetWidth;
    let left = px - tw / 2;
    left = Math.max(4, Math.min(rect.width - tw - 4, left));
    tip.style.left = `${left}px`;
    if (line && crosshair) {
      line.setAttribute('x1', s.x);
      line.setAttribute('x2', s.x);
      line.style.opacity = '1';
    }
    container.querySelectorAll('[data-slot]').forEach((n) => {
      n.classList.toggle('is-active', Number(n.dataset.slot) === idx);
    });
    if (onFocus) onFocus(idx);
  }

  function hide() {
    active = -1;
    tip.hidden = true;
    if (line) line.style.opacity = '0';
    container.querySelectorAll('[data-slot].is-active').forEach((n) => n.classList.remove('is-active'));
  }

  function nearest(clientX) {
    const svgRect = svg.getBoundingClientRect();
    const scale = svgRect.width / Number(svg.getAttribute('width'));
    const x = (clientX - svgRect.left) / scale;
    let best = 0;
    let bd = Infinity;
    slots.forEach((s, i) => {
      const d = Math.abs(s.x - x);
      if (d < bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  overlay.addEventListener('pointerdown', (e) => show(nearest(e.clientX)));
  overlay.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' || e.buttons) show(nearest(e.clientX));
  });
  overlay.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  overlay.addEventListener('focus', () => show(active >= 0 ? active : slots.length - 1));
  overlay.addEventListener('blur', hide);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      show(Math.max(0, (active < 0 ? slots.length : active) - 1));
      e.preventDefault();
    } else if (e.key === 'ArrowRight') {
      show(Math.min(slots.length - 1, active + 1));
      e.preventDefault();
    } else if (e.key === 'Escape') hide();
  });
  // Tipp außerhalb schließt den Tooltip (Touch).
  const outside = (e) => {
    if (!container.isConnected) {
      document.removeEventListener('pointerdown', outside, true);
      return;
    }
    if (!container.contains(e.target)) hide();
  };
  document.addEventListener('pointerdown', outside, true);
}

function frame(W, H) {
  return `<svg class="chart-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" focusable="false">`;
}

/* ------------------------------------------------------------------ */
/* Lernkurve: gemessener Verbrauch je Tankfüllung + Modellschätzung     */
/* ------------------------------------------------------------------ */

export function renderLearningChart(container, { start, rows, outlierIds, width }) {
  const W = Math.max(260, Math.round(width || container.clientWidth || 320));
  const H = 220;
  const m = { l: 34, r: 46, t: 14, b: 30 };
  const pts = [
    { i: 0, model: start.mean, low: start.low, high: start.high, measured: null, date: null },
    ...rows.map((r, k) => ({
      i: k + 1,
      model: r.estimateAfter,
      low: r.lowAfter,
      high: r.highAfter,
      measured: r.consumption,
      date: r.date,
      row: r,
      outlier: outlierIds.has(r.id),
    })),
  ];
  const vals = pts.flatMap((p) => [p.low, p.high, p.measured].filter((v) => v != null));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const pad = (max - min) * 0.06 || 0.2;
  const t = niceTicks(Math.max(0, min - pad), max + pad, 4);
  const n = pts.length - 1;
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const x = (i) => m.l + (n ? (i * iw) / n : iw / 2);
  const y = (v) => m.t + ((t.hi - v) / (t.hi - t.lo)) * ih;

  let s = frame(W, H);
  s += `<title>Lernkurve: gemessener Verbrauch je Tankfüllung und Modellschätzung</title>`;
  for (const v of t.ticks) {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r + 8}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="tick" x="${m.l - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${nf(v, t.digits)}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 6));
  pts.forEach((p) => {
    if (p.i === 0) {
      s += `<text class="tick" x="${x(0)}" y="${H - 8}" text-anchor="start">Start</text>`;
    } else if (p.i % every === 0 || p.i === n) {
      if (p.i === n || n - p.i >= every) {
        s += `<text class="tick" x="${x(p.i)}" y="${H - 8}" text-anchor="middle">${p.i}</text>`;
      }
    }
  });

  // Unsicherheitsband
  const upper = pts.map((p) => `${x(p.i)},${y(p.high)}`);
  const lower = pts.map((p) => `${x(p.i)},${y(p.low)}`).reverse();
  s += `<path class="band" d="M${upper.join('L')}L${lower.join('L')}Z"/>`;
  // Modelllinie
  s += `<path class="model-line" d="M${pts.map((p) => `${x(p.i)},${y(p.model)}`).join('L')}"/>`;
  s += `<line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}"/>`;
  // Messpunkte
  pts.forEach((p, k) => {
    if (p.measured == null) {
      s += `<circle class="model-dot" data-slot="${k}" cx="${x(p.i)}" cy="${y(p.model)}" r="4"/>`;
      return;
    }
    s += `<circle class="measure-dot${p.outlier ? ' is-outlier' : ''}" data-slot="${k}" cx="${x(p.i)}" cy="${y(p.measured)}" r="4.5"/>`;
  });
  // Endbeschriftung an der Modelllinie
  const last = pts[pts.length - 1];
  s += `<circle class="model-end" cx="${x(last.i)}" cy="${y(last.model)}" r="4"/>`;
  s += `<text class="end-label" x="${x(last.i) + 9}" y="${y(last.model)}" dominant-baseline="middle">${nf(last.model, 2)}</text>`;
  s += `<rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent" tabindex="0" aria-label="Werte einzeln ansehen (Pfeiltasten)"/>`;
  s += '</svg><div class="chart-tip" hidden></div>';
  container.innerHTML = s;

  const slots = pts.map((p) => {
    const rowsOut = [];
    if (p.measured != null) {
      rowsOut.push({ key: 'measure', value: `${nf(p.measured, 2)} L/100 km`, label: p.outlier ? 'gemessen · Ausreißer' : 'gemessen' });
    }
    rowsOut.push({ key: 'model', value: `${nf(p.model, 2)} L/100 km`, label: p.i === 0 ? 'Startwert' : 'Modell' });
    rowsOut.push({ key: 'band', value: `${nf(p.low, 2)}–${nf(p.high, 2)}`, label: 'Bereich (80 %)' });
    const title = p.i === 0 ? 'Vor der ersten Messung' : `Tankfüllung ${p.i} · ${shortDate(p.date)} · ${nf(p.row.km, 0)} km`;
    return { x: x(p.i), title, rows: rowsOut };
  });
  bindInteraction(container, slots);
}

/* ------------------------------------------------------------------ */
/* Prognosefehler je Tankfüllung                                        */
/* ------------------------------------------------------------------ */

export function renderErrorChart(container, { rows, width }) {
  const W = Math.max(260, Math.round(width || container.clientWidth || 320));
  const H = 180;
  const m = { l: 34, r: 12, t: 22, b: 30 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const n = rows.length;
  const maxV = Math.max(0.2, ...rows.map((r) => r.absError));
  const t = niceTicks(0, maxV * 1.05, 3);
  const slot = iw / n;
  const bw = Math.max(4, Math.min(24, slot - 2));
  const y = (v) => m.t + ((t.hi - v) / (t.hi - t.lo)) * ih;
  const xc = (k) => m.l + slot * k + slot / 2;

  let s = frame(W, H);
  s += `<title>Prognosefehler je Tankfüllung in Litern</title>`;
  for (const v of t.ticks) {
    s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text class="tick" x="${m.l - 8}" y="${y(v)}" text-anchor="end" dominant-baseline="middle">${nf(v, t.digits)}</text>`;
  }
  const every = Math.max(1, Math.ceil(n / 8));
  rows.forEach((r, k) => {
    const h = y(0) - y(r.absError);
    s += `<path class="bar" data-slot="${k}" d="${barPath(xc(k) - bw / 2, y(r.absError), bw, Math.max(h, 1.5))}"/>`;
    if ((k + 1) % every === 0 || k === n - 1 || k === 0) {
      if (k === n - 1 || n - 1 - k >= every || (k === 0 && n - 1 >= every)) {
        s += `<text class="tick" x="${xc(k)}" y="${H - 8}" text-anchor="middle">${k + 1}</text>`;
      }
    }
  });
  // Beschriftung der letzten Säule – über die Nachbarsäule gehoben, damit nichts überlappt.
  const lastRow = rows[n - 1];
  const neighbourTop = n > 1 ? y(rows[n - 2].absError) : Infinity;
  const labelY = Math.max(m.t - 4, Math.min(y(lastRow.absError), neighbourTop) - 7);
  s += `<text class="end-label" x="${xc(n - 1) + bw / 2}" y="${labelY}" text-anchor="end">${nf(lastRow.absError, 2)} L</text>`;
  s += `<rect class="hit" x="0" y="0" width="${W}" height="${H}" fill="transparent" tabindex="0" aria-label="Werte einzeln ansehen (Pfeiltasten)"/>`;
  s += '</svg><div class="chart-tip" hidden></div>';
  container.innerHTML = s;

  const slots = rows.map((r, k) => ({
    x: xc(k),
    title: `Tankfüllung ${k + 1} · ${shortDate(r.date)}`,
    rows: [
      { key: 'error', value: `${r.error >= 0 ? '+' : '−'}${nf(Math.abs(r.error), 2)} L`, label: 'Abweichung' },
      { value: `${nf(r.predictedLiters, 2)} L`, label: 'erwartet' },
      { value: `${nf(r.liters, 2)} L`, label: 'getankt' },
    ],
  }));
  bindInteraction(container, slots, { crosshair: false });
}
