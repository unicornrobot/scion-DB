/**
 * Twin Threads Visualizer
 *
 * A disciplined 2-strand braid — unlike Tapestry's six equal parallel
 * threads, this is exactly two threads with a clear hierarchy between them.
 * Time advances rightward across a lane; on reaching the right edge the
 * thread wraps to the next lane down (breaking at the seam), same
 * wrap-without-clearing trail philosophy as Tapestry/Spiral.
 *
 *   Values (mean, min, max)      → the main thread's undulation + a
 *                                   translucent envelope band around it
 *   Variability (deviation       → a second thread that coils/braids
 *     primary; delta/variance      around the main one — tight fast coils
 *     secondary)                   = volatile, loose slow coils = calm
 *
 * Public config (read/written by the admin panel):
 *   watchField          — field gating advancement            (default: 'deviation')
 *   sensitivity         — normalised activity threshold (0–1) (default: 0.3)
 *   threadSpeed         — advance rate multiplier              (default: 1.0)
 *   threadThickness     — main thread stroke width, px          (default: 2.2)
 *   coilFrequencyScale  — multiplier on deviation→Hz mapping    (default: 1.0)
 *   coilRadius          — base coil amplitude, px                (default: 9)
 *   envelopeOpacity     — max alpha of the min–max band fill    (default: 0.16)
 *   showEnvelope        — draw the envelope band                (default: true)
 *   palette             — thread colour set name                (default: 'indigo')
 */

const TT_FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];

// Hue/lightness ramps, keyed by the main thread's normalised value (0→1).
// The coil reuses the same ramp at a boosted lightness — one thread family,
// the coil "glowing hotter" as volatility rises.
const TWIN_PALETTES = {
  silk:     { h0: 320, h1:  45, s: 65, l0: 55, l1: 88 }, // rose → gold
  flax:     { h0:  95, h1:  48, s: 45, l0: 32, l1: 78 }, // sage → wheat
  indigo:   { h0: 231, h1: 198, s: 72, l0: 20, l1: 74 }, // dye-vat blue → pale cyan
  copper:   { h0:  18, h1:  42, s: 68, l0: 30, l1: 76 }, // rust → amber
  gossamer: { h0: 255, h1: 190, s: 35, l0: 45, l1: 92 }, // pale violet → icy cyan
};

class TwinThreadsVisualizer {
  constructor() {
    // ── Public config ──────────────────────────────────────────────────────
    this.watchField         = 'deviation';
    this.sensitivity        = 0.3;
    this.threadSpeed        = 1.0;
    this.palette            = 'indigo';
    this.threadThickness    = 2.2;
    this.envelopeOpacity    = 0.16;
    this.showEnvelope       = true;
    this.coilRadius         = 9;
    this.coilThickness      = 1.4;   // internal tuning — not panel-exposed in v1
    this.coilOpacity        = 0.85;  // internal tuning — not panel-exposed in v1
    this.coilFrequencyScale = 1.0;

    // ── Internal tuning constants (not panel-exposed) ──────────────────────
    this._coilHzMin = 0.12;
    this._coilHzMax = 2.4;
    this._pxPerSec  = 40;    // base advance speed at threadSpeed 1.0
    this._stepWidth = 5;     // px per advance step

    // ── Change detection (same EMA/peak pattern as the other visualizers) ──
    this._prevSmooth = {};
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;    // exposed to the panel activity bar

    // ── Secondary-signal running peaks (self-calibrating normalisation) ───
    this._devPeak      = 0.0001;
    this._deltaPeak    = 0.0001;
    this._varPeak      = 0.0001;
    this._normDeviation = 0;

    // ── Value range + weave/lane state ──────────────────────────────────────
    this._range        = null;   // { lo, hi } shared by mean/min/max
    this._trail        = null;
    this._tc            = null;
    this._x             = 0;      // px advanced within the current lane
    this._xAccum        = 0;      // fractional step progress
    this._laneY         = 0;
    this._laneHeight    = 0;
    this._prevMain      = null;   // last drawn main-thread point (null = broken seam)
    this._coilPhase     = 0;
    this._coilPhaseLast = null;   // last drawn coil point, for phase continuity

    this._w = 0;
    this._h = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  setup(ctx, state, engine) {
    this._w = engine.canvas.clientWidth;
    this._h = engine.canvas.clientHeight;
    Object.assign(this._prevSmooth, state.smooth);
    this._initTrail(this._w, this._h);
  }

  teardown() {
    this._trail = null;
    this._tc    = null;
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;
    this._prevSmooth = {};
    this._devPeak       = 0.0001;
    this._deltaPeak     = 0.0001;
    this._varPeak       = 0.0001;
    this._normDeviation = 0;
    this._range        = null;
    this._x             = 0;
    this._xAccum        = 0;
    this._laneY         = 0;
    this._prevMain      = null;
    this._coilPhase     = 0;
    this._coilPhaseLast = null;
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._initTrail(w, h);   // full reset — old pixel positions are meaningless at a new size
  }

  clearTrail() {
    this._x             = 0;
    this._xAccum        = 0;
    this._laneY         = 0;
    this._prevMain       = null;
    this._coilPhase      = 0;
    this._coilPhaseLast  = null;
    this._range          = null;
    this._changeEma      = 0;
    this._changePeak     = 0.0001;
    this._devPeak        = 0.0001;
    this._deltaPeak      = 0.0001;
    this._varPeak        = 0.0001;
    this._initTrail(this._w, this._h);
  }

  _initTrail(w, h) {
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    this._trail = c;
    this._tc    = c.getContext('2d');
    this._laneHeight = Math.max(48, h * 0.16);
    this._x        = 0;
    this._laneY    = 0;
    this._prevMain = null;
  }

  // ── Change detection ─────────────────────────────────────────────────────
  // Shared by render() and a future replay() — see sacred-spiral.js's own
  // _detectMovement()/_advanceAndDraw() split for the precedent.
  _detectMovement(sm) {
    const prevVal   = this._prevSmooth[this.watchField] ?? sm[this.watchField] ?? 0;
    const changeMag = Math.abs((sm[this.watchField] ?? 0) - prevVal);
    this._changeEma  = this._changeEma * 0.85 + changeMag * 0.15;
    this._changePeak = Math.max(this._changePeak * 0.99, this._changeEma, 0.0001);
    this._normChange = this._changeEma / this._changePeak;
    const moving = this._normChange > this.sensitivity;
    for (const f of TT_FIELDS) this._prevSmooth[f] = sm[f];
    return moving;
  }

  // ── Advance ────────────────────────────────────────────────────────────────
  // Also factored out (not inlined in render()) so a future replay() can
  // call it directly with a reconstructed per-event dt.
  _maybeAdvance(dt, state) {
    const moving = this._detectMovement(state.smooth);
    if (moving && state.isLive) {
      this._xAccum += this.threadSpeed * this._pxPerSec * dt;
      while (this._xAccum >= this._stepWidth) {
        this._xAccum -= this._stepWidth;
        this._advanceStep(state);
      }
    }
    return moving;
  }

  // Running {lo,hi} shared by mean/min/max — expands instantly, contracts
  // slowly (~0.4%/step), same idiom as TapestryVisualizer._normX. Sharing
  // one range (rather than one per field) guarantees min ≤ mean ≤ max nests
  // visually, since all three are normalised against the same span.
  _updateRange(minRaw, maxRaw) {
    let r = this._range;
    if (!r) r = this._range = { lo: minRaw, hi: maxRaw };
    if (minRaw < r.lo) r.lo = minRaw; else r.lo += (minRaw - r.lo) * 0.004;
    if (maxRaw > r.hi) r.hi = maxRaw; else r.hi += (maxRaw - r.hi) * 0.004;
  }

  _toT(value) {
    const r = this._range;
    if (!r) return 0.5;
    const span = r.hi - r.lo;
    return span > 0 ? Math.max(0, Math.min(1, (value - r.lo) / span)) : 0.5;
  }

  _valueToY(value) {
    const pad = this._laneHeight * 0.18;
    const innerH = this._laneHeight - pad * 2;
    return this._laneY + pad + (1 - this._toT(value)) * innerH;   // invert: high value → up
  }

  _advanceStep(state) {
    const sm = state.smooth;
    // Main path uses the SMOOTHED mean (deliberately calmer/more disciplined
    // than Tapestry's raw-value jaggedness); the envelope uses raw min/max
    // (the sensor's own instantaneous per-tick aggregate), falling back to
    // smoothed only until the first real sample arrives.
    const meanRaw = sm.mean;
    const minRaw  = state.min != null ? state.min : sm.min;
    const maxRaw  = state.max != null ? state.max : sm.max;
    this._updateRange(minRaw, maxRaw);

    const x1 = this._x + this._stepWidth;
    const newMain = {
      x: x1,
      y: this._valueToY(meanRaw),
      yMin: this._valueToY(minRaw),
      yMax: this._valueToY(maxRaw),
      t: this._toT(meanRaw),
    };

    if (this._prevMain) {
      this._drawEnvelopeQuad(this._prevMain, newMain);
      this._drawBraidSegment(this._prevMain, newMain, state);
    }

    this._prevMain = newMain;
    this._x = x1;
    if (this._x >= this._w) this._wrapLane();
  }

  _wrapLane() {
    this._x = 0;
    this._prevMain = null;    // break the thread at the seam
    this._laneY += this._laneHeight;
    if (this._laneY + this._laneHeight > this._h) this._laneY = 0;
  }

  // ── Colour ─────────────────────────────────────────────────────────────────

  _palette() {
    return TWIN_PALETTES[this.palette] || TWIN_PALETTES.indigo;
  }

  _palColor(t, alpha) {
    const p = this._palette();
    const h = p.h0 + t * (p.h1 - p.h0);
    const l = p.l0 + t * (p.l1 - p.l0);
    return `hsla(${h | 0},${p.s}%,${l | 0}%,${alpha.toFixed(2)})`;
  }

  // Coil colour rides the same ramp as the main thread, boosted lighter so
  // it reads as "glowing hotter" rather than a mismatched second palette.
  _coilColor(t, alpha) {
    const p = this._palette();
    const h = p.h0 + t * (p.h1 - p.h0);
    const l = Math.min(96, p.l0 + t * (p.l1 - p.l0) + 14);
    return `hsla(${h | 0},${p.s}%,${l | 0}%,${alpha.toFixed(2)})`;
  }

  // ── Value axis: main thread + envelope ──────────────────────────────────

  _drawEnvelopeQuad(A, B) {
    if (!this.showEnvelope) return;
    const tc = this._tc;
    tc.beginPath();
    tc.moveTo(A.x, A.yMax);
    tc.lineTo(B.x, B.yMax);
    tc.lineTo(B.x, B.yMin);
    tc.lineTo(A.x, A.yMin);
    tc.closePath();
    tc.fillStyle = this._palColor(B.t, this.envelopeOpacity);
    tc.fill();
  }

  _strokeSeg(tc, p0, p1, color, width) {
    tc.beginPath();
    tc.moveTo(p0.x, p0.y);
    tc.lineTo(p1.x, p1.y);
    tc.strokeStyle = color;
    tc.lineWidth   = width;
    tc.lineCap     = 'round';
    tc.stroke();
  }

  // ── Variability axis: coiling second thread ─────────────────────────────
  // A point-sampled polyline offset perpendicular to the main path's local
  // tangent by radius·sin(phase) — z-order flips on the sign of the sine so
  // the coil alternately draws in front of/behind the main thread, which is
  // what actually reads as "wrapping around" rather than a squiggle beside
  // a line.
  _drawBraidSegment(A, B, state) {
    const tc = this._tc;
    const sm = state.smooth;

    // Deviation = primary driver of coil frequency, self-calibrated the same
    // way Spiral auto-calibrates its spark scale.
    const devSm = Math.abs(sm.deviation);
    this._devPeak = Math.max(this._devPeak * 0.995, devSm, 0.0001);
    const devNorm = Math.min(devSm / this._devPeak, 1);

    // Delta + variance = subtle secondary modulation only — never
    // independent axes, since the three are mathematically related here.
    const deltaSm = Math.abs(sm.delta);
    this._deltaPeak = Math.max(this._deltaPeak * 0.995, deltaSm, 0.0001);
    const deltaNorm = Math.min(deltaSm / this._deltaPeak, 1);
    const varSm = Math.abs(sm.variance);
    this._varPeak = Math.max(this._varPeak * 0.995, varSm, 0.0001);
    const varNorm = Math.min(varSm / this._varPeak, 1);
    const secondaryNorm = (deltaNorm + varNorm) * 0.5;

    this._normDeviation = devNorm;

    const coilHz = this._coilHzMin +
      Math.pow(devNorm, 0.8) * (this._coilHzMax - this._coilHzMin) * this.coilFrequencyScale;

    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len, ty = dy / len;
    const px = -ty, py = tx;   // unit tangent → perpendicular

    const stepDuration = this._stepWidth / Math.max(0.001, this.threadSpeed * this._pxPerSec);
    const cycles = coilHz * stepDuration;
    const subN   = Math.max(2, Math.min(32, Math.round(cycles * 12) + 2));

    const radius = this.coilRadius    * (0.85 + secondaryNorm * 0.30);   // secondary: ±15%
    const width  = this.coilThickness * (0.80 + secondaryNorm * 0.40);   // secondary: ±20%
    const alpha  = this.coilOpacity   * (0.75 + secondaryNorm * 0.25);   // secondary: ±12.5%

    // Main thread is always fully opaque — it's the crisp, disciplined
    // "value" line; the translucent envelope band is what carries opacity.
    const mainColor = this._palColor(B.t, 1);
    const coilColor = this._coilColor(devNorm, alpha);

    let prevMain = A;
    let prevCoil = this._coilPhaseLast ?? A;
    let phase = this._coilPhase;

    for (let i = 1; i <= subN; i++) {
      const u = i / subN;
      phase += (coilHz * 2 * Math.PI * stepDuration) / subN;
      const mp = { x: A.x + dx * u, y: A.y + dy * u };
      const s  = Math.sin(phase);
      const cp = { x: mp.x + px * radius * s, y: mp.y + py * radius * s };

      if (s >= 0) {
        this._strokeSeg(tc, prevMain, mp, mainColor, this.threadThickness);
        this._strokeSeg(tc, prevCoil, cp, coilColor, width);
      } else {
        this._strokeSeg(tc, prevCoil, cp, coilColor, width);
        this._strokeSeg(tc, prevMain, mp, mainColor, this.threadThickness);
      }

      prevMain = mp;
      prevCoil = cp;
    }

    this._coilPhase = phase;
    this._coilPhaseLast = prevCoil;
  }

  // ── Shuttle indicator — glowing marker at the current advance point ────
  // Rotated adaptation of TapestryVisualizer._drawShuttle: a vertical guide
  // spanning the current lane (vs. tapestry's horizontal row guide), with
  // the glow dot at the main thread's current y rather than a fixed row y.

  _drawShuttle(ctx, active) {
    const x  = this._x;
    const y0 = this._laneY, y1 = this._laneY + this._laneHeight;
    const dotY = this._prevMain ? this._prevMain.y : (y0 + y1) / 2;
    const r = active ? 5 : 3;
    const color = active ? 'rgba(232,220,195,' : 'rgba(90,98,110,';

    ctx.strokeStyle = color + (active ? '0.15)' : '0.08)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y1);
    ctx.stroke();

    const g = ctx.createRadialGradient(x, dotY, 0, x, dotY, r * 2.5);
    g.addColorStop(0, color + (active ? '0.9)' : '0.4)'));
    g.addColorStop(1, color + '0)');
    ctx.beginPath();
    ctx.arc(x, dotY, r * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, dotY, 2, 0, Math.PI * 2);
    ctx.fillStyle = color + '1)';
    ctx.fill();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(ctx, state, dt) {
    const w = this._w, h = this._h;
    if (!w || !h || !this._trail) return;

    const moving = this._maybeAdvance(dt, state);

    // Clears at the canvas's actual CURRENT size, not the cached w/h — same
    // convention as every other visualizer.
    ctx.fillStyle = window.scionCanvasBg;
    ctx.fillRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight);
    ctx.drawImage(this._trail, 0, 0, w, h);
    this._drawShuttle(ctx, moving);
  }
}

window.TwinThreadsVisualizer = TwinThreadsVisualizer;
