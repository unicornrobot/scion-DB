/**
 * Isobar / Weather Front Visualizer
 *
 * A scrolling weather-map strip. Time flows left (oldest) to right (newest),
 * over a fixed-size logical column buffer that's redrawn fully every frame
 * — unlike the trail-canvas visualizers, semi-transparent nested contour
 * bands need to stay visually consistent frame to frame, which re-baking
 * into a shifted trail canvas can't guarantee.
 *
 *   Values (mean, min, max)           → nested contour bands + a crisp
 *                                        mean-line stroke ("the isobar")
 *   Variability (deviation primary;   → an overlaid turbulent particle
 *     delta/variance secondary)         field riding the front
 *
 * This is the first visualizer in this codebase to actually consume the
 * shared `state.history` ring buffers (every other one reads only the
 * instantaneous EMA scalar `state.smooth`) — each column bake averages
 * exactly the slice of history that arrived since the previous bake, a
 * genuine windowed read.
 *
 * Public config (read/written by the admin panel):
 *   watchField            — field driving turbulence (primary) (default: 'deviation')
 *   sensitivity           — normalised activity threshold      (default: 0.3)
 *   secondaryMix          — delta/variance's influence on      (default: 0.25)
 *                           turbulence (0–1, multiplicative only)
 *   scrollSpeed           — columns/sec                        (default: 6)
 *   bandCount             — nested contour ribbons per side     (default: 5)
 *   bandSpread            — multiplier on min/max-derived width (default: 1.0)
 *   showBands             — draw the contour ribbons            (default: true)
 *   particleDensityScale  — multiplier on particle target       (default: 1.0)
 *   showParticles         — draw the turbulence particle field  (default: true)
 *   palette               — colour palette name                 (default: 'squall')
 */

const ISOBAR_FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];

// Hue/lightness ramps, meteorological rather than aurora-adjacent in character.
const ISOBAR_PALETTES = {
  squall:   { h0: 200, h1: 225, s: 35, l0: 18, l1: 68 }, // storm slate-blue
  ridge:    { h0:  48, h1:  38, s: 55, l0: 22, l1: 82 }, // high-pressure gold/cream
  frontal:  { h0: 190, h1: 255, s: 55, l0: 15, l1: 70 }, // cold-front teal → indigo
  monsoon:  { h0: 150, h1: 100, s: 40, l0: 16, l1: 62 }, // humid tropical green-grey
  overcast: { h0: 210, h1: 210, s:  8, l0: 20, l1: 85 }, // flat fog/overcast, near-monochrome
};

class IsobarVisualizer {
  constructor() {
    // ── Public config ──────────────────────────────────────────────────────
    this.watchField           = 'deviation';
    this.sensitivity          = 0.3;
    this.secondaryMix         = 0.25;
    this.scrollSpeed          = 6;      // columns/sec
    this.bandCount            = 5;
    this.bandSpread           = 1.0;
    this.showBands            = true;
    this.particleDensityScale = 1.0;
    this.showParticles        = true;
    this.palette              = 'squall';

    // ── Column buffers — logical time-slices, independent of canvas pixel
    // width, so onResize() never needs to reallocate them ──────────────────
    this._COLS    = 480;
    this._bufMean = null;
    this._bufMin  = null;
    this._bufMax  = null;
    this._bufDev  = null;
    this._bufHead   = 0;   // next write slot, mod COLS
    this._bufFilled = 0;   // how many columns hold real data (caps at COLS)
    this._colAccum  = 0;   // fractional column progress
    this._lastHistoryHead = 0;
    this._meanRange = null;   // { lo, hi }, expand-instant/contract-slow

    // ── Change detection (same EMA/peak pattern as the other visualizers) ──
    this._prevSmooth = {};
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;    // exposed to the panel activity bar

    // ── Secondary-signal running peaks (self-calibrating normalisation) ───
    this._secPeak = { delta: 0.0001, variance: 0.0001 };

    // ── Turbulence particles ────────────────────────────────────────────────
    this._particles = [];
    this._MAX_PARTICLES = 360;   // hard cap regardless of particleDensityScale

    this._w = 0;
    this._h = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  setup(ctx, state, engine) {
    this._w = engine.canvas.clientWidth;
    this._h = engine.canvas.clientHeight;
    this._bufMean = new Float32Array(this._COLS);
    this._bufMin  = new Float32Array(this._COLS);
    this._bufMax  = new Float32Array(this._COLS);
    this._bufDev  = new Float32Array(this._COLS);
    this._bufHead = 0;
    this._bufFilled = 0;
    this._meanRange = null;
    this._particles = [];
    Object.assign(this._prevSmooth, state.smooth);

    // Backfill from whatever's already in the shared history ring buffers —
    // switching to Isobar mid-session shows recent history immediately
    // instead of a blank strip.
    this._backfillFromHistory(state);
    this._lastHistoryHead = state.historyHead;
  }

  teardown() {
    this._bufMean = this._bufMin = this._bufMax = this._bufDev = null;
    this._bufHead = 0;
    this._bufFilled = 0;
    this._colAccum = 0;
    this._meanRange = null;
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;
    this._prevSmooth = {};
    this._secPeak = { delta: 0.0001, variance: 0.0001 };
    this._particles = [];
  }

  // Buffers are resolution-independent — resizing only changes how logical
  // columns map to pixels, computed fresh every frame in _colAt().
  onResize(w, h) {
    this._w = w;
    this._h = h;
  }

  // Bound to the panel's reset button.
  clearTrail() {
    if (this._bufMean) this._bufMean.fill(0);
    if (this._bufMin)  this._bufMin.fill(0);
    if (this._bufMax)  this._bufMax.fill(0);
    if (this._bufDev)  this._bufDev.fill(0);
    this._bufHead = 0;
    this._bufFilled = 0;
    this._meanRange = null;
    this._particles = [];
  }

  // ── History → column buffer ─────────────────────────────────────────────

  // One-shot walk of whatever's already in the shared ring buffer (oldest to
  // newest among the currently-populated slots), baking each individually.
  _backfillFromHistory(state) {
    const total = Math.min(state.historyHead, 60);
    if (total <= 0) return;
    const startIdx = state.historyHead >= 60 ? state.historyHead % 60 : 0;
    for (let i = 0; i < total; i++) {
      const idx = (startIdx + i) % 60;
      this._pushColumn(
        state.history.mean[idx],
        state.history.min[idx],
        state.history.max[idx],
        state.history.deviation[idx]
      );
    }
  }

  // Averages exactly the slice of the ring buffer that arrived since the
  // last bake — a genuine windowed read, not a single scalar peek. If the
  // strip is scrolling faster than samples arrive, holds the last known
  // raw sample instead of fabricating motion.
  _bakeColumn(state) {
    const head = state.historyHead;
    const prevHead = this._lastHistoryHead;
    const n = Math.min(head - prevHead, 60);
    this._lastHistoryHead = head;

    let meanV, minV, maxV, devV;
    if (n <= 0) {
      const idx = ((head - 1) % 60 + 60) % 60;
      meanV = state.history.mean[idx];
      minV  = state.history.min[idx];
      maxV  = state.history.max[idx];
      devV  = state.history.deviation[idx];
    } else {
      let sm = 0, so = 0, sx = 0, sd = 0;
      for (let j = 0; j < n; j++) {
        const idx = (prevHead + j) % 60;
        sm += state.history.mean[idx];
        so += state.history.min[idx];
        sx += state.history.max[idx];
        sd += state.history.deviation[idx];
      }
      meanV = sm / n; minV = so / n; maxV = sx / n; devV = sd / n;
    }

    this._pushColumn(meanV, minV, maxV, devV);
  }

  _pushColumn(meanV, minV, maxV, devV) {
    const idx = this._bufHead % this._COLS;
    this._bufMean[idx] = meanV;
    this._bufMin[idx]  = minV;
    this._bufMax[idx]  = maxV;
    this._bufDev[idx]  = devV;
    this._bufHead++;
    this._bufFilled = Math.min(this._bufFilled + 1, this._COLS);
    this._updateMeanRange(meanV);
  }

  // Expand instantly, contract slowly (~0.5%/column) — same idiom as
  // TapestryVisualizer._normX.
  _updateMeanRange(v) {
    let r = this._meanRange;
    if (!r) r = this._meanRange = { lo: v, hi: v };
    if (v < r.lo) r.lo = v; else r.lo += (v - r.lo) * 0.005;
    if (v > r.hi) r.hi = v; else r.hi += (v - r.hi) * 0.005;
  }

  // ── Change detection / turbulence ────────────────────────────────────────

  _updateChangeDetection(state) {
    const sm = state.smooth;
    const prev = this._prevSmooth[this.watchField] ?? sm[this.watchField] ?? 0;
    const changeMag = Math.abs((sm[this.watchField] ?? 0) - prev);
    this._changeEma  = this._changeEma * 0.85 + changeMag * 0.15;
    this._changePeak = Math.max(this._changePeak * 0.99, this._changeEma, 0.0001);
    this._normChange = this._changeEma / this._changePeak;
    for (const f of ISOBAR_FIELDS) this._prevSmooth[f] = sm[f];
  }

  // deviation (via _normChange, primary) multiplicatively boosted by
  // delta/variance (secondary) — never overridden by them, since the three
  // are mathematically related in this data model, not independent axes.
  _turbulence(state) {
    const sm = state.smooth;
    const deltaAbs = Math.abs(sm.delta ?? 0);
    const varAbs   = Math.abs(sm.variance ?? 0);
    this._secPeak.delta    = Math.max(this._secPeak.delta    * 0.995, deltaAbs, 0.0001);
    this._secPeak.variance = Math.max(this._secPeak.variance * 0.995, varAbs,   0.0001);
    const nDelta = Math.min(deltaAbs / this._secPeak.delta,    1);
    const nVar   = Math.min(varAbs   / this._secPeak.variance, 1);
    return Math.max(0, Math.min(1,
      this._normChange * (1 + this.secondaryMix * (0.6 * nDelta + 0.4 * nVar))
    ));
  }

  // ── Geometry / colour ────────────────────────────────────────────────────

  _palette() {
    return ISOBAR_PALETTES[this.palette] || ISOBAR_PALETTES.squall;
  }

  _palColor(t, alpha) {
    const p = this._palette();
    const h = p.h0 + t * (p.h1 - p.h0);
    const l = p.l0 + t * (p.l1 - p.l0);
    return `hsla(${h | 0},${p.s}%,${l | 0}%,${alpha.toFixed(2)})`;
  }

  // Maps logical column k (0 = oldest currently-populated, _bufFilled-1 =
  // newest) to on-screen geometry. Right-aligned while _bufFilled < COLS,
  // so the strip visibly fills up from blank paper rather than stretching.
  // Reads only from buffers/_w/_h — never `state` or `engine` directly.
  _colAt(k) {
    const bufIdx = ((this._bufHead - this._bufFilled + k) % this._COLS + this._COLS) % this._COLS;
    const logicalCol = this._COLS - this._bufFilled + k;
    const x = (logicalCol / (this._COLS - 1)) * this._w;

    const meanV = this._bufMean[bufIdx];
    const minV  = this._bufMin[bufIdx];
    const maxV  = this._bufMax[bufIdx];

    const r = this._meanRange;
    const lo = r ? r.lo : meanV, hi = r ? r.hi : meanV;
    const span = Math.max(hi - lo, 1e-6);
    const marginY = this._h * 0.08;
    const innerH  = this._h - marginY * 2;
    const pxPerUnit = innerH / span;

    const meanY = marginY + (1 - (meanV - lo) / span) * innerH;   // high value → up
    const maxSpread = this._h * 0.4;
    const hiPx = Math.max(0, Math.min((maxV - meanV) * pxPerUnit * this.bandSpread, maxSpread));
    const loPx = Math.max(0, Math.min((meanV - minV) * pxPerUnit * this.bandSpread, maxSpread));

    return { x, meanY, hiPx, loPx };
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  // Nested, non-overlapping ribbons fanning above/below a crisp mean-line
  // stroke, flat `source-over` compositing (deliberately non-additive/
  // non-glow — the one choice that makes this read as a weather map rather
  // than joining the other visualizers' glow aesthetic).
  _drawContours(ctx) {
    const n = this._bufFilled;
    if (n < 2) return;

    const pts = [];
    for (let k = 0; k < n; k++) pts.push(this._colAt(k));

    if (this.showBands) {
      for (let band = this.bandCount; band >= 1; band--) {
        const outer = band / this.bandCount;
        const inner = (band - 1) / this.bandCount;
        const color = this._palColor(1 - inner, 0.30);

        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const p = pts[k], y = p.meanY - p.hiPx * outer;
          k === 0 ? ctx.moveTo(p.x, y) : ctx.lineTo(p.x, y);
        }
        for (let k = n - 1; k >= 0; k--) {
          const p = pts[k];
          ctx.lineTo(p.x, p.meanY - p.hiPx * inner);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();

        ctx.beginPath();
        for (let k = 0; k < n; k++) {
          const p = pts[k], y = p.meanY + p.loPx * outer;
          k === 0 ? ctx.moveTo(p.x, y) : ctx.lineTo(p.x, y);
        }
        for (let k = n - 1; k >= 0; k--) {
          const p = pts[k];
          ctx.lineTo(p.x, p.meanY + p.loPx * inner);
        }
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      }
    }

    // The mean line itself — literally "the isobar" — always drawn on top,
    // regardless of showBands.
    ctx.beginPath();
    for (let k = 0; k < n; k++) {
      const p = pts[k];
      k === 0 ? ctx.moveTo(p.x, p.meanY) : ctx.lineTo(p.x, p.meanY);
    }
    ctx.strokeStyle = this._palColor(1, 0.9);
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  // Always leftward-drifting so particles visually "ride the front" that's
  // scrolling the same direction; vertical jitter (not horizontal reversal)
  // carries the turbulence, since a particle drifting backwards against the
  // scroll would look wrong regardless of how calm the signal is.
  _spawnParticle(atFront) {
    const n = this._bufFilled;
    const x = atFront ? this._w : Math.random() * this._w;
    let y = this._h / 2;
    if (n > 0) {
      const k = atFront ? n - 1 : Math.min(n - 1, Math.floor((x / Math.max(this._w, 1)) * n));
      const p = this._colAt(k);
      const localSpread = (p.hiPx + p.loPx) / 2;
      y = p.meanY + (Math.random() - 0.5) * 2 * (localSpread * 2.2 + 10);
    }
    return { x, y, vx: -4, vy: 0 };
  }

  _stepParticles(dt, turbulence) {
    const target = Math.min(this._MAX_PARTICLES,
      Math.round((15 + turbulence * 345) * this.particleDensityScale));

    while (this._particles.length < target) this._particles.push(this._spawnParticle(false));
    while (this._particles.length > target) this._particles.pop();

    const speed  = 4 + turbulence * 66;    // calm drift → frantic
    const jitter = 5 + turbulence * 215;   // vertical wobble amplitude

    for (const p of this._particles) {
      const targetVx = -speed * (0.8 + Math.random() * 0.4);
      const targetVy = (Math.random() - 0.5) * jitter;
      p.vx += (targetVx - p.vx) * 0.2;
      p.vy += (targetVy - p.vy) * 0.2;
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      if (p.x < 0) Object.assign(p, this._spawnParticle(true));
    }
  }

  // Small sparse dots additively blended don't wash out the flat contour
  // bands the way a large glow shape would, and the additive blend on tiny
  // points gives a genuine sparkle quality — "energy in the storm" — while
  // staying tied to the active palette rather than an unrelated grey.
  _drawParticles(ctx) {
    const p = this._palette();
    const t = 0.92;
    const h = p.h0 + t * (p.h1 - p.h0);
    const l = Math.min(97, p.l0 + t * (p.l1 - p.l0) + 10);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const particle of this._particles) {
      const alpha = 0.25 + Math.random() * 0.3;
      ctx.beginPath();
      ctx.arc(particle.x, particle.y, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${h | 0},${p.s}%,${l | 0}%,${alpha.toFixed(2)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // Pulsing marker at the front's current position — matches the other
  // visualizers' live/idle indicator convention (Spiral's _drawTip,
  // Tapestry's _drawShuttle).
  _drawEdgeMarker(ctx, live, turbulence) {
    const x = this._w - 14;
    const y = this._bufFilled > 0 ? this._colAt(this._bufFilled - 1).meanY : this._h / 2;
    const r = live ? 4 + turbulence * 4 : 3;
    const color = live ? 'rgba(255,255,255,' : 'rgba(120,130,140,';

    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
    g.addColorStop(0, color + (live ? '0.8)' : '0.3)'));
    g.addColorStop(1, color + '0)');
    ctx.beginPath();
    ctx.arc(x, y, r * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = color + '1)';
    ctx.fill();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(ctx, state, dt) {
    const w = this._w, h = this._h;
    if (!w || !h || !this._bufMean) return;

    const safeDt = Math.min(dt, 0.1);
    this._updateChangeDetection(state);
    const turbulence = this._turbulence(state);

    // A strip-chart recorder keeps feeding regardless of activity level —
    // gating column advance on turbulence (like Tapestry gates row-weaving
    // on activity) would misrepresent "no news" as "no scrolling."
    // Sensitivity/turbulence only ever affects the particle layer.
    if (state.isLive) {
      this._colAccum += this.scrollSpeed * safeDt;
      while (this._colAccum >= 1) {
        this._colAccum -= 1;
        this._bakeColumn(state);
      }
    }

    ctx.fillStyle = window.scionCanvasBg;
    ctx.fillRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight);

    this._drawContours(ctx);

    if (this.showParticles) {
      this._stepParticles(safeDt, turbulence);
      this._drawParticles(ctx);
    }

    this._drawEdgeMarker(ctx, state.isLive, turbulence);
  }
}

window.IsobarVisualizer = IsobarVisualizer;
