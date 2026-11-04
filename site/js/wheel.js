// Scroll-Rad (Picker) im iOS-Stil – mit eigener Wisch-Physik.
//
// Warum eigene Physik? Natives Scrollen mit Einrasten (CSS-Scroll-Snap) bremst
// auf iOS nach jedem Wischer fast sofort ab – für 200 km müsste man ewig wischen.
// Hier gilt:
//   • langsames Ziehen bewegt das Rad 1:1 (präzise),
//   • schnelle Wischer werden verstärkt (bis zu 4,5×),
//   • mehrere Wischer hintereinander addieren ihren Schwung (wie bei iOS-Listen),
//   • am Ende läuft das Rad weich aus und landet exakt auf einem Wert.
// Gerendert werden nur die sichtbaren Zeilen – der Wertebereich kann beliebig groß sein.

export const ROW = 34; // Zeilenhöhe in px
const SIDE = 3; // sichtbare Zeilen ober- und unterhalb der Mitte
const STEP_DEG = 19; // Winkel pro Zeile auf der Walze
const RADIUS = ROW / ((STEP_DEG * Math.PI) / 180);

// Physik (Einheit: Zeilen bzw. Zeilen pro Sekunde)
export const PHYSICS = Object.freeze({
  LAMBDA: 2.4, // Abbremsrate – Wurfweite ohne Verstärkung = v / LAMBDA
  BOOST_REF: 18, // ab dieser Geschwindigkeit greift die Verstärkung spürbar
  BOOST_EXP: 1.3,
  BOOST_MAX: 4.5,
  CHAIN: 0.9, // so viel Restschwung wird beim nächsten Wischer übernommen
  MIN_FLICK: 1.5, // darunter: nur einrasten
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Verstärkung abhängig von der Wischgeschwindigkeit (Zeilen/s). */
export function boost(speed) {
  return Math.min(PHYSICS.BOOST_MAX, 1 + (Math.abs(speed) / PHYSICS.BOOST_REF) ** PHYSICS.BOOST_EXP);
}

/** Wohin läuft ein Wischer aus? Gibt Zielzeile (ganzzahlig, im Bereich) und Dauer zurück. */
export function projectFlick(pos, velocity, count, carried = 0) {
  let v = velocity * boost(velocity);
  if (carried && Math.sign(carried) === Math.sign(v)) v += carried * PHYSICS.CHAIN;
  const target = clamp(Math.round(pos + v / PHYSICS.LAMBDA), 0, count - 1);
  const dist = target - pos;
  const duration = Math.abs(v) > 0.01 ? clamp(Math.abs((3 * dist) / v), 0.28, 2.4) : 0.3;
  return { target, duration, velocity: v };
}

/* ---------- Haptik: kurzes Ticken pro Raste ---------- */

let hapticLabel = null;
let lastHaptic = 0;
const isIOS = typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

function tick() {
  const now = performance.now();
  if (now - lastHaptic < 35) return;
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
 *   value       Startwert (null → Eingabefeld statt Rad, z. B. allererster km-Stand)
 *   min, max    Grenzen (Werte)
 *   step        Schrittweite (1 km, 0.01 L …)
 *   format      v → Anzeige-Text
 *   parse       Text → Zahl
 *   label       Bezeichnung für Screenreader
 *   placeholder Text im Eingabefeld
 *   onChange    (value, {user}) → void
 */
export function mountWheel(host, o) {
  const step = o.step || 1;
  const toTick = (v) => Math.round(v / step);
  const fromTick = (t) => Number((t * step).toFixed(6));
  const tMin = toTick(o.min ?? 0);
  const tMax = toTick(o.max ?? 999999);
  const count = tMax - tMin + 1;

  let pos = 0; // aktuelle Position in Zeilen (Kommazahl während der Bewegung)
  let idx = -1; // eingerastete Zeile
  let hasValue = o.value != null;
  let anim = null; // laufende Animation
  let carried = 0; // Restschwung für verkettete Wischer
  let carriedAt = 0;

  host.classList.add('wheel');
  host.innerHTML = `
    <div class="wheel-view" tabindex="0" role="spinbutton" aria-label="${o.label || ''}"
      aria-valuemin="${fromTick(tMin)}" aria-valuemax="${fromTick(tMax)}">
      ${'<div class="wheel-item"></div>'.repeat(SIDE * 2 + 3)}
    </div>
    <input class="wheel-input" type="text" inputmode="decimal" autocomplete="off" enterkeyhint="done" aria-label="${o.label || ''} eintippen" placeholder="${o.placeholder || ''}">`;
  const view = host.querySelector('.wheel-view');
  const input = host.querySelector('.wheel-input');
  const pool = [...view.querySelectorAll('.wheel-item')];
  const shownText = new Array(pool.length).fill(null);

  /* ---------- Zeichnen ---------- */

  function render() {
    const base = Math.floor(pos) - SIDE - 1;
    for (let k = 0; k < pool.length; k += 1) {
      const i = base + k;
      const el = pool[k];
      const d = i - pos;
      if (i < 0 || i >= count || Math.abs(d) > SIDE + 0.9) {
        el.style.visibility = 'hidden';
        continue;
      }
      const text = o.format(fromTick(tMin + i));
      if (shownText[k] !== text) {
        el.textContent = text;
        shownText[k] = text;
      }
      const deg = clamp(d * STEP_DEG, -88, 88);
      const rad = (deg * Math.PI) / 180;
      el.style.visibility = 'visible';
      el.style.transform = `translateY(${(RADIUS * Math.sin(rad)).toFixed(2)}px) perspective(380px) rotateX(${(-deg).toFixed(2)}deg)`;
      el.style.opacity = Math.max(0.08, Math.cos(rad) ** 1.4).toFixed(3);
    }
    const now = clamp(Math.round(pos), 0, count - 1);
    if (now !== idx) {
      const first = idx === -1;
      idx = now;
      view.setAttribute('aria-valuenow', String(fromTick(tMin + idx)));
      view.setAttribute('aria-valuetext', o.format(fromTick(tMin + idx)));
      if (!first && !silent) {
        tick();
        if (o.onChange) o.onChange(fromTick(tMin + idx), { user: true });
      }
    }
  }

  let silent = false;
  function place(p, quiet = false) {
    pos = p;
    silent = quiet;
    render();
    silent = false;
  }

  /* ---------- Animation ---------- */

  function stopAnim() {
    if (!anim) return;
    cancelAnimationFrame(anim.raf);
    // Restschwung merken (für den nächsten Wischer)
    const t = Math.min(1, (performance.now() - anim.t0) / anim.dur);
    carried = anim.v0 * (1 - t) ** 2;
    carriedAt = performance.now();
    anim = null;
  }

  function animateTo(target, dur, v0 = 0) {
    stopAnim();
    const from = pos;
    const dist = target - from;
    if (Math.abs(dist) < 1e-3) {
      place(target);
      return;
    }
    const a = { t0: performance.now(), dur: dur * 1000, v0, raf: 0 };
    const stepFn = (now) => {
      const t = Math.min(1, (now - a.t0) / a.dur);
      const e = 1 - (1 - t) ** 3; // ease-out: schnell los, weich auslaufen
      place(from + dist * e);
      if (t < 1) a.raf = requestAnimationFrame(stepFn);
      else {
        anim = null;
        carried = 0;
      }
    };
    anim = a;
    a.raf = requestAnimationFrame(stepFn);
  }

  const snap = () => animateTo(clamp(Math.round(pos), 0, count - 1), 0.28);

  /* ---------- Ziehen & Wischen ---------- */

  let drag = null;

  view.addEventListener('pointerdown', (e) => {
    if (!hasValue) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const wasMoving = !!anim;
    stopAnim();
    drag = { id: e.pointerId, y0: e.clientY, p0: pos, t0: performance.now(), moved: false, wasMoving, samples: [{ t: performance.now(), p: pos }] };
    view.setPointerCapture(e.pointerId);
  });

  view.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (Math.abs(dy) > 4) drag.moved = true;
    let p = drag.p0 - dy / ROW;
    // Gummiband an den Enden
    if (p < 0) p = -((-p) ** 0.7) * 0.6;
    else if (p > count - 1) p = count - 1 + ((p - (count - 1)) ** 0.7) * 0.6;
    place(p);
    const now = performance.now();
    drag.samples.push({ t: now, p });
    while (drag.samples.length > 2 && now - drag.samples[0].t > 100) drag.samples.shift();
  });

  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    const now = performance.now();

    if (!d.moved && now - d.t0 < 350) {
      if (d.wasMoving) {
        snap(); // Tippen stoppt das laufende Rad
        return;
      }
      // Tippen: auf die Mitte → Tastatur, sonst zu der angetippten Zeile springen
      const rect = view.getBoundingClientRect();
      const off = clamp((e.clientY - (rect.top + rect.height / 2)) / RADIUS, -0.99, 0.99);
      const rows = Math.round(((Math.asin(off) * 180) / Math.PI) / STEP_DEG);
      if (rows === 0) showInput();
      else animateTo(clamp(idx + rows, 0, count - 1), 0.32);
      return;
    }

    // Geschwindigkeit kurz vor dem Loslassen (letzte ~50 ms, wie iOS)
    const s = d.samples;
    let v = 0;
    const last = s[s.length - 1];
    if (s.length >= 2 && now - last.t < 80) {
      let first = s[s.length - 2];
      for (let i = s.length - 2; i >= 0 && last.t - s[i].t <= 50; i -= 1) first = s[i];
      if (last.t - first.t > 4) v = ((last.p - first.p) / (last.t - first.t)) * 1000;
    }
    host.dataset.flickV = v.toFixed(1); // hilft beim Testen
    if (pos < 0 || pos > count - 1 || Math.abs(v) < PHYSICS.MIN_FLICK) {
      snap();
      return;
    }
    const keep = now - carriedAt < 600 ? carried : 0;
    const f = projectFlick(pos, v, count, keep);
    animateTo(f.target, f.duration, f.velocity);
  };
  view.addEventListener('pointerup', endDrag);
  view.addEventListener('pointercancel', endDrag);

  // Mausrad / Trackpad (Desktop)
  let wheelTimer = 0;
  view.addEventListener('wheel', (e) => {
    if (!hasValue) return;
    e.preventDefault();
    stopAnim();
    const unit = e.deltaMode === 1 ? ROW : e.deltaMode === 2 ? ROW * 7 : 1;
    place(clamp(pos + (e.deltaY * unit) / ROW / 1.4, 0, count - 1));
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(snap, 120);
  }, { passive: false });

  view.addEventListener('keydown', (e) => {
    const delta = { ArrowUp: -1, ArrowDown: 1, PageUp: -10, PageDown: 10 }[e.key];
    if (delta) {
      e.preventDefault();
      animateTo(clamp(idx + delta, 0, count - 1), 0.2);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      showInput();
    }
  });

  /* ---------- Eintippen ---------- */

  function showInput() {
    stopAnim();
    input.value = hasValue ? o.format(fromTick(tMin + idx)).replace(/\./g, '').replace(/^–$/, '') : '';
    host.classList.add('editing');
    input.focus({ preventScroll: true });
    input.select();
  }

  function commitInput() {
    if (!host.classList.contains('editing')) return;
    const v = o.parse(input.value);
    if (Number.isFinite(v)) {
      const i = clamp(toTick(v), tMin, tMax) - tMin;
      hasValue = true;
      host.classList.remove('editing', 'empty');
      place(i, true);
      idx = i;
      if (o.onChange) o.onChange(fromTick(tMin + i), { user: true });
    } else if (hasValue) {
      host.classList.remove('editing');
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape' && hasValue) {
      host.classList.remove('editing');
    }
  });
  input.addEventListener('blur', commitInput);
  input.addEventListener('change', commitInput);

  /* ---------- Start ---------- */

  if (hasValue) {
    place(clamp(toTick(o.value), tMin, tMax) - tMin, true);
  } else {
    host.classList.add('empty', 'editing');
  }

  return {
    get value() {
      return hasValue ? fromTick(tMin + idx) : null;
    },
    /** programmatisch setzen (z. B. Liter folgen der Prognose) – löst kein onChange aus */
    set(v) {
      if (!Number.isFinite(v) || drag) return;
      const i = clamp(toTick(v), tMin, tMax) - tMin;
      if (hasValue && i === idx && !anim) return;
      stopAnim();
      carried = 0;
      hasValue = true;
      host.classList.remove('editing', 'empty');
      place(i, true);
    },
    focusInput: showInput,
    el: host,
  };
}
