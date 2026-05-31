/**
 * Sacred Geometry — Change-Driven Spiral Visualizer
 *
 * An Archimedean spiral drawn outward from the centre.  It only advances
 * while the watched field is actively changing frame-to-frame; when the
 * signal is still the drawing freezes completely.
 *
 * When the spiral tip reaches the canvas boundary it wraps silently back
 * to the centre, leaving all prior rings intact and layering new ones on top.
 *
 * Public config (read/written by the admin panel):
 *   watchField   — which smoothed field to monitor for change  (default: 'mean')
 *   sensitivity  — minimum per-frame Δ to count as "changing"  (default: 0.02)
 *   sparkField   — field driving radial spark length            (default: 'deviation')
 */
class SacredSpiralVisualizer {
  constructor() {
    this.watchField  = 'mean';
    this.sensitivity = 0.02;
    this.sparkField  = 'deviation';

    this._angle      = 0;
    this._trail      = null;
    this._tc         = null;
    this._lastPt     = null;
    this._prevSmooth = {};
    this._changeMag  = 0;   // exposed so the admin panel can read it live
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
    this._prevSmooth = {};
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._initTrail(w, h);
  }

  clearTrail() {
    this._angle  = 0;
    this._lastPt = null;
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
      this._angle += 0.06 * dt * 60;

      // Edge wrap: when tip hits the boundary, restart from centre without
      // clearing the trail so new rings layer silently over old ones.
      const r   = 10 + (this._ringSpacing() * this._angle) / (Math.PI * 2);
      const max = Math.min(w, h) * 0.46;
      if (r > max) {
        this._angle  = 0;
        this._lastPt = null;    // break the line — don't draw edge-to-centre
      }

      this._appendPt(cx, cy, sm);
    }

    // ── compose frame ──────────────────────────────────────────────────────
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, w, h);

    this._drawGuides(ctx, cx, cy);
    ctx.drawImage(this._trail, 0, 0, w, h);

    const tip = this._spiralPt(cx, cy, this._angle);
    this._drawTip(ctx, tip.x, tip.y, moving);
  }

  // ── Trail appending ────────────────────────────────────────────────────────

  _appendPt(cx, cy, sm) {
    const pos     = this._spiralPt(cx, cy, this._angle);
    const spacing = this._ringSpacing();
    const ringIdx = Math.floor(this._angle / (Math.PI * 2));
    const hue     = (ringIdx * 30 + this._angle * 1.5) % 360;

    if (this._lastPt) {
      // Hold _lastPt fixed on sub-pixel moves so distance accumulates
      const dx = pos.x - this._lastPt.x, dy = pos.y - this._lastPt.y;
      if (dx * dx + dy * dy < 0.5) return;

      const tc = this._tc;

      // Arc segment
      tc.beginPath();
      tc.moveTo(this._lastPt.x, this._lastPt.y);
      tc.lineTo(pos.x, pos.y);
      tc.strokeStyle = `hsla(${hue},62%,54%,0.80)`;
      tc.lineWidth   = 1.1;
      tc.lineJoin    = tc.lineCap = 'round';
      tc.stroke();

      // Spark: radial line scaled by sparkField, normalised to ring spacing
      const radA  = this._angle - Math.PI / 2;
      const rx    = Math.cos(radA), ry = Math.sin(radA);
      const rawSp = Math.abs(sm[this.sparkField] ?? 0);
      // Normalise against sensitivity × 50 so sparks scale intuitively
      const spLen = Math.min(rawSp / Math.max(this.sensitivity * 50, 0.001) * spacing * 0.8, spacing * 1.1);

      if (spLen > 0.6) {
        const alpha = 0.3 + (spLen / (spacing * 1.1)) * 0.6;
        tc.beginPath();
        tc.moveTo(pos.x, pos.y);
        tc.lineTo(pos.x + rx * spLen, pos.y + ry * spLen);
        tc.strokeStyle = `hsla(${(hue + 55) % 360},92%,82%,${alpha.toFixed(2)})`;
        tc.lineWidth   = 0.65;
        tc.lineCap     = 'round';
        tc.stroke();
      }
    }

    this._lastPt = pos;
  }

  // ── Pen-tip indicator ──────────────────────────────────────────────────────

  _drawTip(ctx, x, y, active) {
    const hue = (this._angle * 18) % 360;
    const r   = active ? 10 : 4;
    const g   = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `hsla(${hue},90%,88%,${active ? 0.9 : 0.3})`);
    g.addColorStop(1, `hsla(${hue},80%,60%,0)`);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = active ? `hsl(${hue},95%,92%)` : '#555e6e';
    ctx.fill();
  }

  // ── Sacred geometry scaffold ───────────────────────────────────────────────

  _drawGuides(ctx, cx, cy) {
    const R = Math.min(this._w, this._h) * 0.44;
    const r = R / 3;

    ctx.save();
    ctx.strokeStyle = '#4cc9f0';
    ctx.lineWidth   = 0.5;

    ctx.globalAlpha = 0.07;
    this._circle(ctx, cx, cy, r);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
      this._circle(ctx, cx + r * Math.cos(a), cy + r * Math.sin(a), r);
    }

    ctx.globalAlpha = 0.04;
    this._ngon(ctx, cx, cy, r,                6, -Math.PI / 6);
    this._ngon(ctx, cx, cy, r * Math.sqrt(3), 6,  0);
    this._ngon(ctx, cx, cy, R * 0.55,         3, -Math.PI / 2);
    this._ngon(ctx, cx, cy, R * 0.55,         3,  Math.PI / 2);

    ctx.globalAlpha = 0.03;
    this._circle(ctx, cx, cy, R);
    this._circle(ctx, cx, cy, R * 0.618);
    this._circle(ctx, cx, cy, R * 0.382);

    ctx.globalAlpha = 0.025;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 6;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    });
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        ctx.beginPath();
        ctx.moveTo(pts[i][0], pts[i][1]);
        ctx.lineTo(pts[j][0], pts[j][1]);
        ctx.stroke();
      }
    }

    ctx.restore();
  }

  _circle(ctx, x, y, r) {
    ctx.beginPath(); ctx.arc(x, y, Math.max(r, 0.5), 0, Math.PI * 2); ctx.stroke();
  }

  _ngon(ctx, x, y, r, n, rot = 0) {
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = rot + (i / n) * Math.PI * 2;
      i === 0
        ? ctx.moveTo(x + r * Math.cos(a), y + r * Math.sin(a))
        : ctx.lineTo(x + r * Math.cos(a), y + r * Math.sin(a));
    }
    ctx.stroke();
  }
}

window.SacredSpiralVisualizer = SacredSpiralVisualizer;
