/**
 * Core Sample Visualizer
 *
 * Renders the recording as a geological cross-section: a strip of sediment
 * layers depositing continuously over time, one layer per "tick" of the
 * deposition clock. Two data groups get two distinct, simultaneously legible
 * visual channels so they can be read against each other at a glance:
 *
 *   Values (mean, min, max)            → each layer's hue + thickness
 *   Variability (deviation primary;    → each layer's grain/speckle texture
 *     delta & variance secondary)
 *
 * Unlike the other visualizers' change-detection gate (moving vs. not),
 * deposition here never stops — it only speeds up when the watched field is
 * active. A long calm stretch still lays down thin, smooth layers rather
 * than leaving a gap, so the final image has no silent holes.
 *
 * Public config (read/written by the admin panel):
 *   watchField      — field driving the deposition-rate boost   (default: 'deviation')
 *   sensitivity     — normalised activity threshold (0–1)       (default: 0.3)
 *   depositionRate  — multiplier on base layers/sec             (default: 1.0)
 *   orientation     — 'vertical' | 'horizontal'                 (default: 'vertical')
 *   thicknessScale  — multiplier on layer thickness             (default: 1.0)
 *   grainDensity    — multiplier on speckle count                (default: 1.0)
 *   grainOpacity    — multiplier on speckle alpha                (default: 0.6)
 *   showBoundary    — draw a wavy accent line per layer edge     (default: true)
 *   palette         — colour palette name                        (default: 'sediment')
 */

const CORE_FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];

// Hue/lightness ramps, keyed by mean's normalised position (0→1). Moderate
// lightness range (vs. the glow-on-black visualizers) so layers read as
// solid rock rather than luminous trails.
const CORE_PALETTES = {
  sediment: { h0: 42,  h1: 14,  s: 48, l0: 68, l1: 30 }, // sand → rust
  basalt:   { h0: 220, h1: 255, s: 18, l0: 55, l1: 16 }, // slate-grey → indigo-black
  coral:    { h0: 350, h1: 8,   s: 62, l0: 72, l1: 42 }, // pale pink → deep coral-red
  amber:    { h0: 48,  h1: 28,  s: 70, l0: 66, l1: 34 }, // pale gold → burnt amber
  slate:    { h0: 200, h1: 210, s: 12, l0: 62, l1: 24 }, // pale blue-grey → deep slate
};

class CoreSampleVisualizer {
  constructor() {
    // ── Public config ──────────────────────────────────────────────────────
    this.watchField     = 'deviation';
    this.sensitivity    = 0.3;
    this.depositionRate = 1.0;
    this.orientation    = 'vertical';   // 'vertical' | 'horizontal'
    this.thicknessScale = 1.0;
    this.grainDensity   = 1.0;
    this.grainOpacity   = 0.6;
    this.showBoundary   = true;
    this.palette        = 'sediment';

    // ── Internal tuning constants (not panel-exposed) ──────────────────────
    this._BASE_RATE          = 1.5;    // layers/sec at rest
    this._ACTIVE_MULT        = 3.0;    // rate multiplier once boosted
    this._LAYER_MIN_PX       = 3;
    this._LAYER_MAX_PX       = 34;
    this._GRAIN_BASE_DENSITY = 0.0007;
    this._GRIT_W = { deviation: 0.70, delta: 0.15, variance: 0.15 };

    // ── Change detection (same EMA/peak pattern as the other visualizers,
    // repurposed as a deposition-rate multiplier instead of an on/off gate) ─
    this._prevSmooth = {};
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;    // exposed to the panel activity bar

    // ── Deposition / trail state ───────────────────────────────────────────
    this._trail = null;
    this._tc    = null;
    this._head  = 0;          // position along the time axis, px
    this._depositAccum = 0;   // fractional layer progress

    // ── Self-calibrating normalisation ──────────────────────────────────────
    this._meanRange    = null;   // { lo, hi } running range for mean → hue/lightness
    this._rangePeak    = 0.0001; // decaying peak of |max-min| → thickness
    this._devPeak      = 0.0001;
    this._deltaPeak    = 0.0001;
    this._variancePeak = 0.0001;

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
    this._head  = 0;
    this._depositAccum = 0;
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;
    this._prevSmooth = {};
    this._meanRange    = null;
    this._rangePeak    = 0.0001;
    this._devPeak      = 0.0001;
    this._deltaPeak    = 0.0001;
    this._variancePeak = 0.0001;
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._initTrail(w, h);
  }

  // Bound to the panel's "Clear core & reset" button, and fired automatically
  // when orientation changes (mixing a vertical trail's data with a
  // horizontal one mid-image would garble it).
  clearTrail() {
    this._head = 0;
    this._depositAccum = 0;
    this._meanRange    = null;
    this._rangePeak    = 0.0001;
    this._devPeak      = 0.0001;
    this._deltaPeak    = 0.0001;
    this._variancePeak = 0.0001;
    this._initTrail(this._w, this._h);
  }

  _initTrail(w, h) {
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    this._trail = c;
    this._tc    = c.getContext('2d');
    this._head  = 0;
  }

  // ── Sizing ─────────────────────────────────────────────────────────────────

  // Keeps layer thickness/grain proportionate whether rendered into a tiny
  // gallery thumbnail or a large desktop canvas — same idea as Spiral's
  // _sizeScale(), referenced against a 900px "reference" dimension since
  // Core Sample has no natural unit (like Spiral's ring spacing) of its own.
  _sizeScale() {
    return Math.max(0.35, Math.min(this._w, this._h) / 900);
  }

  // Length of the axis layers accrete along (the OTHER dimension is the
  // full-width/full-height "cross" extent every layer spans).
  _axisExtent() {
    return this.orientation === 'horizontal' ? this._w : this._h;
  }

  // ── Change detection ─────────────────────────────────────────────────────
  // Same EMA/peak formula as the other visualizers (see PhysarumVisualizer),
  // but the result is used as a continuous rate multiplier, never a gate.
  _updateChangeDetection(state) {
    const sm = state.smooth;
    const prevVal   = this._prevSmooth[this.watchField] ?? sm[this.watchField] ?? 0;
    const changeMag = Math.abs((sm[this.watchField] ?? 0) - prevVal);
    this._changeEma  = this._changeEma * 0.85 + changeMag * 0.15;
    this._changePeak = Math.max(this._changePeak * 0.99, this._changeEma, 0.0001);
    this._normChange = this._changeEma / this._changePeak;
    for (const f of CORE_FIELDS) this._prevSmooth[f] = sm[f];
  }

  // Running {lo,hi} for `mean` — expands instantly, contracts slowly
  // (~0.5%/layer), same idiom as TapestryVisualizer._normX.
  _normMean(value) {
    let r = this._meanRange;
    if (!r) r = this._meanRange = { lo: value, hi: value };
    if (value < r.lo) r.lo = value; else r.lo += (value - r.lo) * 0.005;
    if (value > r.hi) r.hi = value; else r.hi += (value - r.hi) * 0.005;
    const span = r.hi - r.lo;
    return span > 0 ? Math.max(0, Math.min(1, (value - r.lo) / span)) : 0.5;
  }

  _palette() {
    return CORE_PALETTES[this.palette] || CORE_PALETTES.sediment;
  }

  // ── Deposition ────────────────────────────────────────────────────────────

  _depositLayer(state) {
    const sm = state.smooth;
    // Raw values capture sample-to-sample texture the EMA flattens out;
    // fall back to smoothed only until the first real sample arrives.
    const meanRaw  = state.mean  != null ? state.mean  : sm.mean;
    const minRaw   = state.min   != null ? state.min   : sm.min;
    const maxRaw   = state.max   != null ? state.max   : sm.max;
    const devRaw   = Math.abs(state.deviation != null ? state.deviation : sm.deviation);
    const deltaRaw = Math.abs(state.delta     != null ? state.delta     : sm.delta);
    const varRaw   = Math.abs(state.variance  != null ? state.variance  : sm.variance);

    const t = this._normMean(meanRaw);

    const rangeVal = Math.abs(maxRaw - minRaw);
    this._rangePeak = Math.max(this._rangePeak * 0.995, rangeVal, 0.0001);
    const normRange = Math.min(rangeVal / this._rangePeak, 1);
    const thick = (this._LAYER_MIN_PX + Math.pow(normRange, 0.6) * (this._LAYER_MAX_PX - this._LAYER_MIN_PX))
      * this.thicknessScale * this._sizeScale();

    // Variability: deviation is the primary driver, delta/variance only ever
    // apply subtle secondary weighting — never three equal independent axes,
    // since the three are mathematically related in this data model.
    this._devPeak      = Math.max(this._devPeak      * 0.995, devRaw,   0.0001);
    this._deltaPeak    = Math.max(this._deltaPeak    * 0.995, deltaRaw, 0.0001);
    this._variancePeak = Math.max(this._variancePeak * 0.995, varRaw,   0.0001);
    const nDev   = Math.min(devRaw   / this._devPeak,      1);
    const nDelta = Math.min(deltaRaw / this._deltaPeak,    1);
    const nVar   = Math.min(varRaw   / this._variancePeak, 1);
    const grit = Math.max(0, Math.min(1,
      this._GRIT_W.deviation * nDev + this._GRIT_W.delta * nDelta + this._GRIT_W.variance * nVar
    ));

    this._drawBand(t, thick, grit);
  }

  _drawBand(t, thick, grit) {
    const horizontal = this.orientation === 'horizontal';
    const cross = horizontal ? this._h : this._w;

    // Wrap over old pixels without clearing (same trail philosophy as
    // Sacred Spiral / Tapestry) once the next layer would overflow.
    if (this._head + thick > this._axisExtent()) this._head = 0;

    const rect = horizontal
      ? { x: this._head, y: 0, w: thick, h: cross }
      : { x: 0, y: this._head, w: cross, h: thick };

    const pal = this._palette();
    const h = pal.h0 + t * (pal.h1 - pal.h0);
    const l = pal.l0 + t * (pal.l1 - pal.l0);

    this._tc.fillStyle = `hsl(${h | 0},${pal.s}%,${Math.max(0, Math.min(100, l)) | 0}%)`;
    this._tc.fillRect(rect.x, rect.y, rect.w, rect.h);

    this._drawGrain(rect, grit, h, l, pal);
    if (this.showBoundary) this._drawBoundary(rect, grit, horizontal);

    this._head += thick;
  }

  // Scattered speckles drawn once per layer (not once per frame) — cheap
  // even at a few dozen extra draw calls, since it never has to be redone.
  // Hue/lightness are jittered around the layer's OWN blended values (not
  // the palette's low end) so grain reads as texture on that band, not a
  // wash of the palette's starting colour.
  _drawGrain(rect, grit, h, l, pal) {
    const tc = this._tc;
    const sizeScale = this._sizeScale();
    const count = Math.round(
      this._GRAIN_BASE_DENSITY * (rect.w * rect.h) * Math.pow(grit, 0.8) * this.grainDensity
    );
    for (let i = 0; i < count; i++) {
      const gx = rect.x + Math.random() * rect.w;
      const gy = rect.y + Math.random() * rect.h;
      const r  = (0.4 + Math.random() * 0.8) * sizeScale * (0.6 + grit * 0.8);
      const dl = Math.max(0, Math.min(100, l + (Math.random() - 0.5) * (6 + grit * 10)));
      const alpha = (0.05 + grit * 0.35) * this.grainOpacity;
      tc.beginPath();
      tc.arc(gx, gy, r, 0, Math.PI * 2);
      tc.fillStyle = `hsla(${h | 0},${pal.s * 0.9}%,${dl | 0}%,${alpha.toFixed(2)})`;
      tc.fill();
    }
  }

  // Thin wavy accent along the layer's leading edge — extra geological
  // authenticity, also grit-driven, also drawn once.
  _drawBoundary(rect, grit, horizontal) {
    const tc = this._tc;
    const amp = (0.5 + grit * 3) * this._sizeScale();
    const steps = 10;
    tc.beginPath();
    if (horizontal) {
      const x = rect.x + rect.w;
      tc.moveTo(x, 0);
      for (let i = 1; i <= steps; i++) {
        tc.lineTo(x + Math.sin(i * 1.7) * amp, (i / steps) * rect.h);
      }
    } else {
      const y = rect.y + rect.h;
      tc.moveTo(0, y);
      for (let i = 1; i <= steps; i++) {
        tc.lineTo((i / steps) * rect.w, y + Math.sin(i * 1.7) * amp);
      }
    }
    tc.strokeStyle = `rgba(0,0,0,${(0.08 + grit * 0.18).toFixed(2)})`;
    tc.lineWidth = 0.75 * this._sizeScale();
    tc.stroke();
  }

  // ── Live head indicator ──────────────────────────────────────────────────

  _drawHead(ctx, boosted) {
    const horizontal = this.orientation === 'horizontal';
    const color = boosted ? 'rgba(255,220,180,' : 'rgba(140,150,160,';
    ctx.strokeStyle = color + (boosted ? '0.25)' : '0.12)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (horizontal) {
      ctx.moveTo(this._head, 0);
      ctx.lineTo(this._head, this._h);
    } else {
      ctx.moveTo(0, this._head);
      ctx.lineTo(this._w, this._head);
    }
    ctx.stroke();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(ctx, state, dt) {
    const w = this._w, h = this._h;
    if (!w || !h || !this._trail) return;

    this._updateChangeDetection(state);
    const boosted = this._normChange > this.sensitivity;

    // Deposition never gates on activity, only its RATE — but it does still
    // require a live connection, so a session that never received any data
    // doesn't lay down meaningless layers before the first real sample.
    if (state.isLive) {
      const rate = (boosted ? this._BASE_RATE * this._ACTIVE_MULT : this._BASE_RATE) * this.depositionRate;
      this._depositAccum += rate * dt;
      while (this._depositAccum >= 1) {
        this._depositAccum -= 1;
        this._depositLayer(state);
      }
    }

    // Clears at the canvas's actual CURRENT size, not the cached w/h (which
    // briefly lag behind right after an embedding iframe's own container
    // settles) — same convention as every other visualizer.
    ctx.fillStyle = window.scionCanvasBg;
    ctx.fillRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight);
    ctx.drawImage(this._trail, 0, 0, w, h);
    this._drawHead(ctx, boosted);
  }
}

window.CoreSampleVisualizer = CoreSampleVisualizer;
