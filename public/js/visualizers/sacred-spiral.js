/**
 * Sacred Geometry — Change-Driven Spiral Visualizer
 *
 * Public config (read/written by the admin panel):
 *   watchField   — which smoothed field to monitor for change  (default: 'mean')
 *   sensitivity  — minimum per-frame Δ to count as "changing"  (default: 0.001)
 *   sparkField   — field driving radial spark length            (default: 'deviation')
 *   sparkScale   — exaggeration multiplier for spark length     (default: 1.0)
 *   palette      — colour palette name                          (default: 'aurora')
 */

// Harmonic colour palettes — each maps normalised intensity (0→1) to a hue
// and lightness range.  Low intensity = h0/l0; high intensity = h1/l1.
const SACRED_PALETTES = {
  aurora:   { h0: 160, h1: 280, s: 80, l0: 38, l1: 88 },  // teal → violet
  fire:     { h0:   0, h1:  55, s: 92, l0: 38, l1: 90 },  // red  → gold
  ocean:    { h0: 195, h1: 240, s: 78, l0: 36, l1: 82 },  // cyan → indigo
  solar:    { h0:  30, h1:  82, s: 88, l0: 45, l1: 95 },  // amber → lime
  void:     { h0: 255, h1: 330, s: 65, l0: 26, l1: 78 },  // indigo → rose
  prism:    { h0:   0, h1: 330, s: 82, l0: 46, l1: 88 },  // full spectrum
};
class SacredSpiralVisualizer {
  constructor() {
    this.watchField  = 'variance';
    this.sensitivity = 0.0043;
    this.sparkField  = 'deviation';
    this.sparkScale  = 1.0;
    this.palette     = 'prism';
    this.sparkStyle  = 'points';
    this.showRings   = false;

    this._angle      = 0;
    this._trail      = null;
    this._tc         = null;
    this._lastPt     = null;
    this._prevSmooth = {};
    this._changeMag  = 0;   // exposed so the admin panel can read it live
    this._sparkPeak  = 0.001; // running max of spark field — auto-calibrates scale
    this._sparkTip   = null;  // last computed spark tip position
    this._w = 0;
    this._h = 0;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  setup(ctx, state, engine) {
    this._w = engine.canvas.clientWidth;
    this._h = engine.canvas.clientHeight;
    // Seed prev so the very first frame doesn't fire a spurious large delta
    Object.assign(this._prevSmooth, state.smooth);
    this._initTrail(this._w, this._h);
  }

  teardown() {
    this._trail      = null;
    this._tc         = null;
    this._lastPt     = null;
    this._angle      = 0;
    this._changeMag  = 0;
    this._sparkPeak  = 0.001;
    this._prevSmooth = {};
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._initTrail(w, h);
  }

  clearTrail() {
    this._angle     = 0;
    this._lastPt    = null;
    this._sparkPeak = 0.001;
    this._initTrail(this._w, this._h);
  }

  _initTrail(w, h) {
    const c = document.createElement('canvas');
    c.width  = w;
    c.height = h;
    this._trail  = c;
    this._tc     = c.getContext('2d');
    this._lastPt = null;
  }

  // ── Spiral geometry ────────────────────────────────────────────────────────

  _ringSpacing() {
    // Tight rings: ~1.5% of shortest canvas dimension per revolution
    return Math.min(this._w, this._h) * 0.015;
  }

  _spiralPt(cx, cy, angle) {
    const r = 10 + (this._ringSpacing() * angle) / (Math.PI * 2);
    const a = angle - Math.PI / 2;   // start at top (12 o'clock)
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(ctx, state, dt) {
    const w = this._w, h = this._h;
    if (!w || !h || !this._trail) return;

    const cx = w * 0.5, cy = h * 0.5;
    const sm = state.smooth;

    // ── change detection ───────────────────────────────────────────────────
    const prevVal   = this._prevSmooth[this.watchField] ?? sm[this.watchField] ?? 0;
    this._changeMag = Math.abs((sm[this.watchField] ?? 0) - prevVal);
    const moving    = this._changeMag > this.sensitivity;

    // Always snapshot smooth for next frame
    const FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];
    for (const f of FIELDS) this._prevSmooth[f] = sm[f];

    if (moving) {
      // Advance by a fixed arc length so mark spacing stays constant at all radii.
      // Dividing by r means the angle step shrinks as the spiral widens —
      // each outer ring naturally takes longer to complete.
      const r          = 10 + (this._ringSpacing() * this._angle) / (Math.PI * 2);
      this._angle     += (2.0 / Math.max(r, 1)) * dt * 60;

      // Edge wrap: when tip hits the boundary, restart from centre without
      // clearing the trail so new rings layer silently over old ones.
      const maxSparkLen = this._ringSpacing() * 3 * this.sparkScale;
      const max        = Math.min(w, h) * 0.5 - maxSparkLen;
      if (r > max) {
        this._angle  = 0;
        this._lastPt = null;    // break the line — don't draw edge-to-centre
        // Pick a new random palette each time the spiral wraps
        const keys = Object.keys(SACRED_PALETTES);
        this.palette = keys[Math.floor(Math.random() * keys.length)];
      }

      this._appendPt(cx, cy, sm);
    }

    // ── compose frame ──────────────────────────────────────────────────────
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, w, h);

    this._drawSpiralGuide(ctx, cx, cy);
    ctx.drawImage(this._trail, 0, 0, w, h);

    const tip    = this._spiralPt(cx, cy, this._angle);
    const dotPos = (!this.showRings && this._sparkTip) ? this._sparkTip : tip;
    this._drawTip(ctx, dotPos.x, dotPos.y, moving);
  }

  // ── Trail appending ────────────────────────────────────────────────────────

  // Map normalised intensity (0–1) to an HSLA string from the current palette.
  _palColor(t, alpha) {
    const p = SACRED_PALETTES[this.palette] || SACRED_PALETTES.aurora;
    const h = p.h0 + t * (p.h1 - p.h0);
    const l = p.l0 + t * (p.l1 - p.l0);
    return `hsla(${h | 0},${p.s}%,${l | 0}%,${alpha.toFixed(2)})`;
  }

  _appendPt(cx, cy, sm) {
    const pos     = this._spiralPt(cx, cy, this._angle);
    const spacing = this._ringSpacing();

    // Normalise spark field against running peak (0–1)
    const rawSp = Math.abs(sm[this.sparkField] ?? 0);
    this._sparkPeak  = Math.max(this._sparkPeak * 0.999, rawSp, 0.001);
    const normalised = rawSp / this._sparkPeak;

    if (this._lastPt) {
      // Hold _lastPt fixed on sub-pixel moves so distance accumulates
      const dx = pos.x - this._lastPt.x, dy = pos.y - this._lastPt.y;
      if (dx * dx + dy * dy < 0.5) return;

      const tc = this._tc;

      // Arc segment — intensity drives colour and thickness
      if (this.showRings) {
        tc.beginPath();
        tc.moveTo(this._lastPt.x, this._lastPt.y);
        tc.lineTo(pos.x, pos.y);
        tc.strokeStyle = this._palColor(normalised, 0.55 + normalised * 0.35);
        tc.lineWidth   = 0.4 + normalised * 2.2;
        tc.lineJoin    = tc.lineCap = 'round';
        tc.stroke();
      }

      // Spark — line or point, both intensity-driven
      const spLen = normalised * spacing * 3 * this.sparkScale;
      if (spLen > 0.4) {
        const radA  = this._angle - Math.PI / 2;
        const tipX  = pos.x + Math.cos(radA) * spLen;
        const tipY  = pos.y + Math.sin(radA) * spLen;
        this._sparkTip = { x: tipX, y: tipY };
        const color = this._palColor(normalised, 0.3 + normalised * 0.65);
        if (this.sparkStyle === 'points') {
          tc.beginPath();
          tc.arc(tipX, tipY, 0.4 + normalised * 2.2, 0, Math.PI * 2);
          tc.fillStyle = color;
          tc.fill();
        } else {
          tc.beginPath();
          tc.moveTo(pos.x, pos.y);
          tc.lineTo(tipX, tipY);
          tc.strokeStyle = color;
          tc.lineWidth   = 0.3 + normalised * 1.8;
          tc.lineCap     = 'round';
          tc.stroke();
        }
      }
    }

    this._lastPt = pos;
  }

  // ── Pen-tip indicator ──────────────────────────────────────────────────────

  _drawTip(ctx, x, y, active) {
    const r  = active ? 10 : 4;
    const g  = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, this._palColor(1, active ? 0.9 : 0.3));
    g.addColorStop(1, this._palColor(0.5, 0));
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = active ? this._palColor(1, 1) : '#555e6e';
    ctx.fill();
  }

  // ── Spiral path guide ─────────────────────────────────────────────────────
  // Draws the complete Archimedean spiral track from centre to edge as a faint
  // ghost line, so the full path the dot follows is always visible.

  _drawSpiralGuide(ctx, cx, cy) {
    const spacing     = this._ringSpacing();
    const maxSparkLen = spacing * 3 * this.sparkScale;
    const maxR        = Math.min(this._w, this._h) * 0.5 - maxSparkLen;
    const maxAngle    = Math.max(0, (maxR - 10) * (Math.PI * 2) / spacing);

    // ~40 points per full revolution keeps the curve visually smooth
    const steps = Math.ceil(maxAngle * 40 / (Math.PI * 2));

    ctx.save();
    ctx.strokeStyle = '#4cc9f0';
    ctx.lineWidth   = 0.5;
    ctx.globalAlpha = 0.10;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();

    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * maxAngle;
      const r     = 10 + (spacing * angle) / (Math.PI * 2);
      const a     = angle - Math.PI / 2;
      const x     = cx + r * Math.cos(a);
      const y     = cy + r * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }

    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }
}

window.SacredSpiralVisualizer = SacredSpiralVisualizer;
