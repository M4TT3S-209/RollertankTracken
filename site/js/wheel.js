// Scroll-Rad (Picker) im iOS-Stil.
//
// Nutzt das native Schwung-Scrollen des Systems (schnelles Wischen läuft weit,
// am Ende rastet es per CSS-Scroll-Snap genau auf einem Wert ein). Die Walzen-
// Optik entsteht per 3D-Transform der sichtbaren Zeilen. Ein Tipp auf den Wert
// in der Mitte öffnet die Tastatur, ein Tipp auf einen anderen Wert springt hin.

export const ROW = 34; // Zeilenhöhe in px
const SIDE = 3; // Zeilen ober- und unterhalb der Mitte
const STEP_DEG = 19; // Winkel pro Zeile auf der Walze
const RADIUS = ROW / ((STEP_DEG * Math.PI) / 180);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/* ---------- Haptik: kurzes Ticken pro Raste ---------- */

let hapticLabel = null;
let lastHaptic = 0;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function tick() {
  const now = performance.now();
  if (now - lastHaptic < 32) return;
  lastHaptic = now;
  try {
    if (navigator.vibrate) {
      navigator.vibrate(3);
      return;
    }
    if (!isIOS) return;
    // iOS 18+: Umschalten eines <input switch> löst ein leichtes Haptik-Feedback aus.
    if (!hapticLabel) {
      hapticLabel = document.createElement('label');
      hapticLabel.setAttribute('aria-hidden', 'true');
      hapticLabel.style.cssText = 'position:fixed;left:-20px;top:-20px;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.setAttribute('switch', '');
      input.tabIndex = -1;
      hapticLabel.append(input);
      document.body.append(hapticLabel);
    }
    hapticLabel.click();
  } catch (e) {
    /* Haptik ist nur ein Extra */
  }
}

/**
 * @param {HTMLElement} host
 * @param {object} o
 *   value      Startwert (null → Eingabefeld statt Rad, z. B. allererster km-Stand)
 *   min, max   Grenzen (Werte, nicht Zeilen)
 *   step       Schrittweite (1 km, 0.01 L …)
 *   span       {below, above}: Rad wird um den Wert herum aufgebaut (statt min/max fix)
 *   format     v → Anzeige-Text
 *   parse      Text → Zahl
 *   label      Bezeichnung für Screenreader
 *   placeholder Text im Eingabefeld
 *   onChange   (value, {user}) → void
 */
export function mountWheel(host, o) {
  const step = o.step || 1;
  const toTick = (v) => Math.round(v / step);
  const fromTick = (t) => Number((t * step).toFixed(6));
  const absMin = o.min != null ? toTick(o.min) : 0;
  const absMax = o.max != null ? toTick(o.max) : Infinity;

  let tMin = 0;
  let tMax = 0;
  let curIdx = -1;
  let items = [];
  let styled = [];
  let raf = 0;
  let current = o.value == null ? null : clamp(toTick(o.value), absMin, absMax);

  host.classList.add('wheel');
  host.innerHTML = `
    <div class="wheel-scroll" tabindex="0" role="spinbutton" aria-label="${o.label || ''}"><div class="wheel-items"></div></div>
    <input class="wheel-input" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" aria-label="${o.label || ''} eintippen" placeholder="${o.placeholder || ''}">`;
  const scroller = host.querySelector('.wheel-scroll');
  const list = host.querySelector('.wheel-items');
  const input = host.querySelector('.wheel-input');

  function range(center) {
    if (o.span) {
      tMin = Math.max(absMin, center - toTick(o.span.below));
      tMax = Math.min(absMax, center + toTick(o.span.above));
    } else {
      tMin = absMin;
      tMax = absMax;
    }
  }

  function build() {
    range(current);
    const n = tMax - tMin + 1;
    const parts = new Array(n);
    for (let i = 0; i < n; i += 1) parts[i] = `<div class="wheel-item" data-i="${i}">${o.format(fromTick(tMin + i))}</div>`;
    list.innerHTML = parts.join('');
    items = list.children;
    styled = [];
    scroller.setAttribute('aria-valuemin', String(fromTick(tMin)));
    scroller.setAttribute('aria-valuemax', String(fromTick(tMax)));
  }

  function jumpTo(t, smooth = false) {
    const idx = clamp(t - tMin, 0, tMax - tMin);
    if (smooth) {
      scroller.scrollTo({ top: idx * ROW, behavior: 'smooth' });
      return;
    }
    curIdx = idx; // programmatisch: kein onChange auslösen
    scroller.scrollTop = idx * ROW;
    paint();
  }

  function paint() {
    raf = 0;
    if (!items.length) return;
    const c = scroller.scrollTop / ROW;
    const from = Math.max(0, Math.floor(c) - SIDE - 1);
    const to = Math.min(items.length - 1, Math.ceil(c) + SIDE + 1);
    for (const i of styled) {
      if (i < from || i > to) {
        items[i].style.transform = '';
        items[i].style.opacity = '';
      }
    }
    styled = [];
    for (let i = from; i <= to; i += 1) {
      const d = i - c;
      const deg = clamp(d * STEP_DEG, -88, 88);
      const rad = (deg * Math.PI) / 180;
      const shift = RADIUS * Math.sin(rad) - d * ROW; // auf die Walze „biegen“
      items[i].style.transform = `translateY(${shift.toFixed(2)}px) perspective(380px) rotateX(${(-deg).toFixed(2)}deg)`;
      items[i].style.opacity = String(Math.max(0.1, Math.cos(rad) ** 1.4).toFixed(3));
      styled.push(i);
    }
    const idx = clamp(Math.round(c), 0, items.length - 1);
    if (idx !== curIdx) {
      curIdx = idx;
      current = tMin + idx;
      scroller.setAttribute('aria-valuenow', String(fromTick(current)));
      scroller.setAttribute('aria-valuetext', o.format(fromTick(current)));
      tick();
      if (o.onChange) o.onChange(fromTick(current), { user: true });
    }
  }

  function showInput() {
    input.value = current == null ? '' : o.format(fromTick(current)).replace(/\./g, '').replace(/^–$/, '');
    host.classList.add('editing');
    input.focus({ preventScroll: true });
    input.select();
  }

  function commitInput() {
    if (!host.classList.contains('editing')) return;
    const v = o.parse(input.value);
    if (Number.isFinite(v)) {
      const t = clamp(toTick(v), absMin, absMax);
      const rebuild = current == null || t < tMin || t > tMax;
      current = t;
      if (rebuild) build();
      host.classList.remove('editing', 'empty');
      jumpTo(t);
      if (o.onChange) o.onChange(fromTick(t), { user: true });
    } else if (current != null) {
      host.classList.remove('editing');
    }
  }

  scroller.addEventListener('scroll', () => {
    if (!raf) raf = requestAnimationFrame(paint);
  }, { passive: true });

  list.addEventListener('click', (e) => {
    const item = e.target.closest('.wheel-item');
    if (!item) return;
    const i = Number(item.dataset.i);
    if (i === curIdx) showInput();
    else jumpTo(tMin + i, true);
  });

  scroller.addEventListener('keydown', (e) => {
    const delta = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
    if (delta) {
      e.preventDefault();
      jumpTo(tMin + clamp(curIdx + delta, 0, items.length - 1), true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      showInput();
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape' && current != null) {
      host.classList.remove('editing');
    }
  });
  input.addEventListener('blur', commitInput);
  input.addEventListener('change', commitInput);

  if (current == null) {
    host.classList.add('empty', 'editing');
  } else {
    build();
    // erst nach dem Einfügen ins Layout positionieren
    requestAnimationFrame(() => jumpTo(current));
    jumpTo(current);
  }

  return {
    get value() {
      return current == null ? null : fromTick(current);
    },
    /** programmatisch setzen (z. B. Liter folgen der Prognose) – löst kein onChange aus */
    set(v) {
      if (!Number.isFinite(v)) return;
      const t = clamp(toTick(v), absMin, absMax);
      if (t === current && current != null) return;
      const rebuild = current == null || t < tMin || t > tMax;
      current = t;
      if (rebuild) {
        build();
        host.classList.remove('editing', 'empty');
      }
      jumpTo(t);
    },
    focusInput: showInput,
    el: host,
  };
}
