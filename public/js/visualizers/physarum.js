/**
 * Physarum Visualizer
 *
 * Multi-agent chemotaxis simulation (Jones 2010 / Physarum polycephalum).
 * Agents deposit a chemical trail, sense ahead-left / ahead / ahead-right,
 * and steer toward the strongest gradient — self-organising into flow networks
 * that look like mycelium, root systems, or neural webs.
 *
 * Public config (read/written by the admin panel):
 *   watchField  — which smoothed field drives activity      (default: 'variance')
 *   sensitivity — normalised threshold for "active"         (default: 0.3)
 *   palette     — colour palette name                       (default: 'biolum')
 *   agentCount  — number of agents                          (default: 1200)
 *   decayRate   — per-frame trail fade rate                 (default: 0.005)
 */

const PHYSARUM_PALETTES = {
  biolum:   { h0: 175, h1: 200, s: 90, l0:  6, l1: 78 },  // deep blue → teal
  mycelium: { h0:  30, h1:  85, s: 88, l0:  6, l1: 80 },  // amber → lime
  aurora:   { h0: 160, h1: 280, s: 80, l0:  6, l1: 78 },  // teal → violet
  void:     { h0: 255, h1: 330, s: 65, l0:  6, l1: 72 },  // indigo → rose
  prism:    { h0:   0, h1: 330, s: 82, l0:  6, l1: 80 },  // full spectrum
};

class PhysarumVisualizer {
  constructor() {
    // ── Public config ──────────────────────────────────────────────────────
    this.watchField  = 'variance';
    this.sensitivity = 0.3;
    this.palette     = 'biolum';
    this.agentCount  = 1200;
    this.decayRate   = 0.005;

    // ── Grid / render buffers ──────────────────────────────────────────────
    this._trail     = null;  // Float32Array  gw × gh  — chemical concentration
    this._trailB    = null;  // Float32Array            — ping-pong diffusion target
    this._lut       = null;  // Uint8Array  256 × 4    — RGBA colour lookup table
    this._lutPal    = null;  // palette name the LUT was built for
    this._offscreen = null;  // HTMLCanvasElement at grid resolution
    this._octx      = null;
    this._imageData = null;
    this._w = 0; this._h = 0;
    this._gw = 0; this._gh = 0;
    this._SCALE = 0.5;       // grid is 0.5× canvas CSS-pixel dimensions

    // ── Agent sensor/rotation constants ────────────────────────────────────
    this._SA = Math.PI / 4;  // sensor angle offset  (45°)
    this._SD = 9;            // sensor look-ahead distance (cells)
    this._RA = Math.PI / 4;  // rotation amount per step  (45°)

    // ── Agents ────────────────────────────────────────────────────────────
    this._agents = [];

    // ── Change detection (same EMA/peak pattern as SacredSpiralVisualizer) ─
    this._changeMag  = 0;
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;    // 0–1, exposed to the panel activity bar
    this._prevSmooth = {};
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  setup(ctx, state, engine) {
    this._w = engine.canvas.clientWidth;
    this._h = engine.canvas.clientHeight;
    Object.assign(this._prevSmooth, state.smooth);
    this._initGrid(this._w, this._h);
    this._buildLut();
    this._initAgents();
  }

  teardown() {
    this._trail     = null;
    this._trailB    = null;
    this._agents    = [];
    this._offscreen = null;
    this._octx      = null;
    this._imageData = null;
    this._changeEma  = 0;
    this._normChange = 0;
    this._changePeak = 0.0001;
    this._prevSmooth = {};
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._initGrid(w, h);
    this._buildLut();
    this._initAgents();
  }

  clearTrail() {
    if (this._trail)  this._trail.fill(0);
    if (this._trailB) this._trailB.fill(0);
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._initAgents();
  }

  // ── Initialisation helpers ─────────────────────────────────────────────────

  _initGrid(w, h) {
    this._gw = Math.max(1, Math.round(w * this._SCALE));
    this._gh = Math.max(1, Math.round(h * this._SCALE));
    this._trail  = new Float32Array(this._gw * this._gh);
    this._trailB = new Float32Array(this._gw * this._gh);
    this._offscreen        = document.createElement('canvas');
    this._offscreen.width  = this._gw;
    this._offscreen.height = this._gh;
    this._octx      = this._offscreen.getContext('2d');
    this._imageData = this._octx.createImageData(this._gw, this._gh);
  }

  _initAgents() {
    if (!this._gw || !this._gh) return;
    const gw = this._gw, gh = this._gh;
    this._agents = [];
    for (let i = 0; i < this.agentCount; i++) {
      this._agents.push({
        x:     Math.random() * gw,
        y:     Math.random() * gh,
        angle: Math.random() * Math.PI * 2,
      });
    }
  }

  // ── Colour LUT ─────────────────────────────────────────────────────────────

  _buildLut() {
    const p = PHYSARUM_PALETTES[this.palette] || PHYSARUM_PALETTES.biolum;
    this._lut = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const t = i / 255;
      const h = p.h0 + t * (p.h1 - p.h0);
      const s = p.s / 100;
      const l = (p.l0 + t * (p.l1 - p.l0)) / 100;
      const [r, g, b] = this._hslToRgb(h, s, l);
      this._lut[i * 4]     = r;
      this._lut[i * 4 + 1] = g;
      this._lut[i * 4 + 2] = b;
      this._lut[i * 4 + 3] = 255;
    }
    this._lutPal = this.palette;
  }

  // h 0–360, s 0–1, l 0–1  →  [r, g, b] 0–255
  _hslToRgb(h, s, l) {
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => Math.round(
      (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255
    );
    return [f(0), f(8), f(4)];
  }

  // ── Simulation ─────────────────────────────────────────────────────────────

  // Sample the trail at a point `sensorDist` cells ahead of (x, y) along `angle`.
  _senseAt(x, y, angle) {
    const gw = this._gw, gh = this._gh;
    const sx = (((x + Math.cos(angle) * this._SD) | 0) % gw + gw) % gw;
    const sy = (((y + Math.sin(angle) * this._SD) | 0) % gh + gh) % gh;
    return this._trail[sy * gw + sx];
  }

  // Move all agents one step: sense → steer → advance → deposit.
  _stepAgents(activity, dt) {
    const gw = this._gw, gh = this._gh;
    const SA = this._SA, RA = this._RA;
    // Speed scales with data activity; dt normalises to 60 fps baseline.
    const speed   = (0.5 + activity * 2.0) * dt * 60;
    // Deposit per step: low at baseline, saturates near 1 at peak activity.
    const deposit = (0.12 + activity * 0.88) * 0.01;
    // Random jitter grows with activity, preventing agents from locking into ruts.
    const noise   = 0.05 + activity * 0.2;

    for (const a of this._agents) {
      const fwd   = this._senseAt(a.x, a.y, a.angle);
      const left  = this._senseAt(a.x, a.y, a.angle - SA);
      const right = this._senseAt(a.x, a.y, a.angle + SA);

      if (fwd >= left && fwd >= right) {
        // Forward is strongest — continue straight with gentle jitter.
        a.angle += (Math.random() - 0.5) * noise;
      } else if (left > right) {
        a.angle -= RA + (Math.random() - 0.5) * noise;
      } else if (right > left) {
        a.angle += RA + (Math.random() - 0.5) * noise;
      } else {
        // Exact tie — random turn to break symmetry.
        a.angle += (Math.random() < 0.5 ? -1 : 1) * RA;
      }

      // Advance and wrap at grid boundary.
      a.x = ((a.x + Math.cos(a.angle) * speed) % gw + gw) % gw;
      a.y = ((a.y + Math.sin(a.angle) * speed) % gh + gh) % gh;

      // Deposit chemical at the agent's new position.
      const ix  = a.x | 0;
      const iy  = a.y | 0;
      const idx = iy * gw + ix;
      const v   = this._trail[idx] + deposit;
      this._trail[idx] = v > 1 ? 1 : v;
    }
  }

  // One-pass box-blur diffusion + exponential decay (ping-pong buffers).
  _diffuseDecay() {
    const gw = this._gw, gh = this._gh;
    const src  = this._trail, dst = this._trailB;
    const keep = 1 - this.decayRate;

    for (let y = 0; y < gh; y++) {
      const ym = y === 0 ? gh - 1 : y - 1;
      const yp = y === gh - 1 ? 0 : y + 1;
      for (let x = 0; x < gw; x++) {
        const xm = x === 0 ? gw - 1 : x - 1;
        const xp = x === gw - 1 ? 0 : x + 1;
        const v  = (src[y * gw + x]  +
                    src[y * gw + xm] + src[y * gw + xp] +
                    src[ym * gw + x] + src[yp * gw + x]) * 0.2 * keep;
        // Floor to zero below a tiny threshold to prevent denormal floats
        // and avoid permanent dim haze when the network goes quiet.
        dst[y * gw + x] = v < 0.0005 ? 0 : v;
      }
    }

    this._trail  = dst;
    this._trailB = src;
  }

  // Map trail concentrations (0–1) to RGBA pixels via the precomputed LUT.
  _buildImageData() {
    const data  = this._imageData.data;
    const trail = this._trail;
    const lut   = this._lut;
    const n     = this._gw * this._gh;
    for (let i = 0; i < n; i++) {
      const ci = (trail[i] * 255 + 0.5) | 0;
      const li = (ci > 255 ? 255 : ci) * 4;
      data[i * 4]     = lut[li];
      data[i * 4 + 1] = lut[li + 1];
      data[i * 4 + 2] = lut[li + 2];
      data[i * 4 + 3] = 255;
    }
  }

  // ── Change detection ───────────────────────────────────────────────────────

  _updateChangeDetection(state) {
    const sm   = state.smooth;
    const prev = this._prevSmooth[this.watchField] ?? sm[this.watchField] ?? 0;
    this._changeMag  = Math.abs((sm[this.watchField] ?? 0) - prev);
    this._changeEma  = this._changeEma  * 0.85 + this._changeMag * 0.15;
    this._changePeak = Math.max(this._changePeak * 0.99, this._changeEma, 0.0001);
    this._normChange = this._changeEma / this._changePeak;

    const FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];
    for (const f of FIELDS) this._prevSmooth[f] = sm[f];
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  render(ctx, state, dt) {
    if (!this._trail || !this._gw) return;

    // Rebuild colour LUT only when palette has changed.
    if (this._lutPal !== this.palette) this._buildLut();

    this._updateChangeDetection(state);

    // Above the sensitivity threshold → data-scaled activity.
    // Below it → small baseline so the network stays alive and slowly breathes.
    const activity = this._normChange > this.sensitivity
      ? this._normChange
      : 0.04;

    // Cap dt so a tab re-focus doesn't produce a huge single jump.
    const safeDt = Math.min(dt, 0.1);

    this._diffuseDecay();
    this._stepAgents(activity, safeDt);
    this._buildImageData();

    // Blit at grid resolution, scale up to canvas — natural upscale blur
    // gives the strands a soft, glowing appearance for free.
    this._octx.putImageData(this._imageData, 0, 0);
    ctx.drawImage(this._offscreen, 0, 0, this._w, this._h);
  }
}

window.PhysarumVisualizer = PhysarumVisualizer;
