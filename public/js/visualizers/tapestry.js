/**
 * Tapestry Visualizer — woven loom rows.
 *
 * Time advances downward row by row like a loom's weft. Each of the six data
 * fields is a coloured thread whose horizontal position is its value
 * normalised against its own recent min–max range. Threads wander left/right
 * as the signal moves, weaving a fabric that layers over itself on wrap.
 *
 * Public config (read/written by the admin panel):
 *   watchField    — field gating weave advancement          (default: 'deviation')
 *   sensitivity   — normalised activity threshold (0–1)     (default: 0.3)
 *   weaveSpeed    — row advance rate multiplier             (default: 1.0)
 *   rowHeight     — pixels per weave row                    (default: 3)
 *   palette       — thread colour set name                  (default: 'loom')
 *   threadOpacity — max alpha for thread strokes            (default: 0.7)
 *   showWeft      — faint full-width line per row           (default: true)
 *   threads       — { field: bool } which threads to weave  (default: all on)
 */

const TAPESTRY_FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];

// Each palette maps the six fields to a harmonic set of thread colours.
const TAPESTRY_PALETTES = {
  loom: {   // natural dyed wool
    min: '#b34a3f', max: '#c9973b', mean: '#3d5a80',
    delta: '#7d9b76', variance: '#e8dcc3', deviation: '#6e5544',
  },
  biolum: { // deep-sea
    min: '#0af0e0', max: '#20b2ff', mean: '#5ee6a0',
    delta: '#0a8f8f', variance: '#7fffd4', deviation: '#3a6ea5',
  },
  prism: {  // the chart/sparkline colour set
    min: '#4cc9f0', max: '#f72585', mean: '#ffd166',
    delta: '#06d6a0', variance: '#b388ff', deviation: '#ff8c42',
  },
  ember: {  // fire tones
    min: '#ff4d4d', max: '#ff9e2c', mean: '#ffd23f',
    delta: '#e63946', variance: '#ffb4a2', deviation: '#c1440e',
  },
};

class TapestryVisualizer {
  constructor() {
    this.watchField    = 'deviation';
    this.sensitivity   = 0.3;
    this.weaveSpeed    = 1.0;
    this.rowHeight     = 3;
    this.palette       = 'loom';
    this.threadOpacity = 0.7;
    this.showWeft      = true;
    this.threads       = Object.fromEntries(TAPESTRY_FIELDS.map(f => [f, true]));

    // change detection (same model as the other visualizers)
    this._prevSmooth = {};
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;      // exposed for the panel activity bar

    // weave state
    this._trail    = null;
    this._tc       = null;
    this._y        = 0;
    this._rowAccum = 0;        // fractional row progress
    this._prevX    = {};       // last drawn x per field (null = broken thread)
    this._range    = {};       // per-field running { lo, hi }

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
    this._trail      = null;
    this._tc         = null;
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;
    this._prevSmooth = {};
    this._prevX      = {};
    this._range      = {};
    this._y          = 0;
    this._rowAccum   = 0;
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._initTrail(w, h);
  }

  clearTrail() {
    this._y        = 0;
    this._rowAccum = 0;
    this._prevX    = {};
    this._range    = {};
    this._initTrail(this._w, this._h);
  }

  _initTrail(w, h) {
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    this._trail = c;
    this._tc    = c.getContext('2d');
    this._prevX = {};
    this._y     = 0;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(ctx, state, dt) {
    const w = this._w, h = this._h;
    if (!w || !h || !this._trail) return;

    const sm = state.smooth;

    // ── change detection (EMA of per-frame change ÷ decaying running peak) ──
    const prevVal   = this._prevSmooth[this.watchField] ?? sm[this.watchField] ?? 0;
    const changeMag = Math.abs((sm[this.watchField] ?? 0) - prevVal);
    this._changeEma  = this._changeEma * 0.85 + changeMag * 0.15;
    this._changePeak = Math.max(this._changePeak * 0.99, this._changeEma, 0.0001);
    this._normChange = this._changeEma / this._changePeak;
    const moving     = this._normChange > this.sensitivity;

    for (const f of TAPESTRY_FIELDS) this._prevSmooth[f] = sm[f];

    // ── weave rows while the signal is active ────────────────────────────────
    if (moving && state.isLive) {
      // Base rate: ~8 rows/sec at weaveSpeed 1.0
      this._rowAccum += this.weaveSpeed * 8 * dt;
      while (this._rowAccum >= 1) {
        this._rowAccum -= 1;
        this._weaveRow(state);
      }
    }

    // ── compose frame ────────────────────────────────────────────────────────
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(this._trail, 0, 0, w, h);
    this._drawShuttle(ctx, moving);
  }

  // ── Weaving ────────────────────────────────────────────────────────────────

  // Normalise a field's current value against its decaying running range.
  _normX(field, value) {
    if (!Number.isFinite(value)) return null;
    let r = this._range[field];
    if (!r) r = this._range[field] = { lo: value, hi: value };

    // Expand instantly, contract slowly (~0.5%/row toward current value) so
    // the thread re-calibrates as the session's range drifts.
    if (value < r.lo) r.lo = value; else r.lo += (value - r.lo) * 0.005;
    if (value > r.hi) r.hi = value; else r.hi += (value - r.hi) * 0.005;

    const span = r.hi - r.lo;
    if (span <= 0) return 0.5;
    return (value - r.lo) / span;
  }

  _weaveRow(state) {
    const tc = this._tc;
    const w  = this._w, h = this._h;
    const y  = this._y;
    const margin = w * 0.04;                    // keep threads off the edges
    const innerW = w - margin * 2;
    const activity = Math.min(this._normChange, 1);
    const pal = TAPESTRY_PALETTES[this.palette] || TAPESTRY_PALETTES.loom;

    // Faint weft line — the horizontal fabric texture
    if (this.showWeft) {
      tc.strokeStyle = 'rgba(200,205,215,0.03)';
      tc.lineWidth   = 1;
      tc.beginPath();
      tc.moveTo(0, y);
      tc.lineTo(w, y);
      tc.stroke();
    }

    for (const f of TAPESTRY_FIELDS) {
      if (!this.threads[f]) { this._prevX[f] = null; continue; }

      // Use raw values (not EMA) so threads capture sample-to-sample texture
      const raw = state[f] != null ? state[f] : state.smooth[f];
      const t   = this._normX(f, raw);
      if (t === null) { this._prevX[f] = null; continue; }

      const x = margin + t * innerW;
      const prevX = this._prevX[f];

      if (prevX != null) {
        const prevY = y - this.rowHeight;
        const alpha = this.threadOpacity * (0.35 + activity * 0.65);
        const width = 0.8 + activity * 0.6;

        // Wavy control point — small random sideways bow gives a fibrous feel
        const cxp = (prevX + x) / 2 + (Math.random() - 0.5) * this.rowHeight * 2;
        const cyp = (prevY + y) / 2;

        // Main thread stroke + two fainter parallel fibers
        for (let i = 0; i < 3; i++) {
          const off = i === 0 ? 0 : (i === 1 ? 0.7 : -0.7);
          tc.beginPath();
          tc.moveTo(prevX + off, prevY);
          tc.quadraticCurveTo(cxp + off, cyp, x + off, y);
          tc.strokeStyle = this._hexA(pal[f], i === 0 ? alpha : alpha * 0.35);
          tc.lineWidth   = i === 0 ? width : width * 0.6;
          tc.lineCap     = 'round';
          tc.stroke();
        }
      }

      this._prevX[f] = x;
    }

    // Advance — wrap to top without clearing so fabric layers like the Spiral
    this._y += this.rowHeight;
    if (this._y > h) {
      this._y = 0;
      this._prevX = {};   // break threads across the wrap seam
    }
  }

  _hexA(hex, alpha) {
    const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    return hex + a.toString(16).padStart(2, '0');
  }

  // ── Shuttle indicator — glowing marker at the current weave row ────────────

  _drawShuttle(ctx, active) {
    const y = this._y;
    const w = this._w;
    const r = active ? 5 : 3;
    const color = active ? 'rgba(232,220,195,' : 'rgba(90,98,110,';

    // Row guide line
    ctx.strokeStyle = color + (active ? '0.15)' : '0.08)');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();

    // Shuttle dot at the right edge
    const g = ctx.createRadialGradient(w - 14, y, 0, w - 14, y, r * 2.5);
    g.addColorStop(0, color + (active ? '0.9)' : '0.4)'));
    g.addColorStop(1, color + '0)');
    ctx.beginPath();
    ctx.arc(w - 14, y, r * 2.5, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(w - 14, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = color + '1)';
    ctx.fill();
  }
}

window.TapestryVisualizer = TapestryVisualizer;
