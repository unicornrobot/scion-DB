/**
 * OrganicGrowthVisualizer
 *
 * A generative plant that grows upward from the bottom of the canvas.
 * Two immortal trunk stems always exist; mortal branch stems sprout from them.
 * All visual parameters are driven by the six Pocket Scion data fields via
 * EMA-smoothed values in state.smooth.
 *
 * Data mapping:
 *   mean       → stem growth speed
 *   delta      → branching rate + directional turbulence
 *   variance   → colour saturation + hue shift (green → teal)
 *   deviation  → particle emission (spores/seeds)
 *   min / max  → minimum / maximum active stem count
 */
class OrganicGrowthVisualizer {

  constructor() {
    this._stems     = [];
    this._particles = [];
    this.W = 0;
    this.H = 0;
    this._ctx = null;
    this._state = null;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  static _norm(v, lo, hi) { return Math.max(0, Math.min(1, (v - lo) / (hi - lo))); }
  static _lerp(a, b, t)   { return a + (b - a) * t; }

  /** Derive the per-frame rendering parameters from smoothed data. */
  _params(state) {
    const s    = state.smooth;
    const live = state.isLive;
    const N    = OrganicGrowthVisualizer._norm;
    const L    = OrganicGrowthVisualizer._lerp;

    if (live) {
      return {
        stemSpeed:    L(20,  90,   N(s.mean,      50, 150)),
        turbulence:   L(0.005, 0.09, N(s.delta,   0,  30)),
        branchProb:   L(0.08, 0.55,  N(s.delta,   0,  30)),
        saturation:   L(25,  88,   N(s.variance,   0, 100)),
        stemHue:      120 + L(0, 40, N(s.variance, 0, 100)),
        minStems:     Math.round(L(2,  8,  N(s.min, 50, 150))),
        maxStems:     Math.round(L(4, 18,  N(s.max, 50, 150))),
        initialWidth: L(2.5, 6.0, N(s.mean,       50, 150)),
        lightness:    45,
      };
    }
    // Idle (no live data) — slow, desaturated drift
    return {
      stemSpeed:    25,
      turbulence:   0.015,
      branchProb:   0.12,
      saturation:   30,
      stemHue:      120 + Math.sin(Date.now() / 8000) * 15,
      minStems:     2,
      maxStems:     5,
      initialWidth: 3.5,
      lightness:    38,
    };
  }

  // ── Stem factories ───────────────────────────────────────────────────────

  _makeStem(x, y, angle, width, hue, isTrunk = false) {
    return {
      x, y,
      angle,                              // radians; -PI/2 = straight up
      speed:       isTrunk ? 35 : 30,     // will be overridden each frame
      length:      0,
      maxLength:   isTrunk ? Infinity : 180 + Math.random() * 320,
      width,
      widthDecay:  isTrunk ? 0.9993 : 0.9985,
      hue,
      alpha:       1,
      segments:    [],
      lastSegAt:   0,
      branchCooldown: 1 + Math.random() * 2,
      dead:        false,
      isTrunk,
      born:        Date.now(),
    };
  }

  _spawnTrunk(xFrac) {
    const x     = this.W * xFrac;
    const y     = this.H + 4;
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * 0.15;
    const hue   = 120 + Math.random() * 15;
    this._stems.push(this._makeStem(x, y, angle, 7, hue, true));
  }

  _spawnBranch(parent, p) {
    const side  = Math.random() < 0.5 ? 1 : -1;
    const angle = parent.angle + side * (0.3 + Math.random() * 0.5);
    const width = Math.max(0.8, parent.width * 0.55);
    const hue   = parent.hue + (Math.random() - 0.5) * 20;
    return this._makeStem(parent.x, parent.y, angle, width, hue);
  }

  // ── VizEngine interface ──────────────────────────────────────────────────

  setup(ctx, state, engine) {
    this._ctx   = ctx;
    this._state = state;
    this.W = ctx.canvas.clientWidth;
    this.H = ctx.canvas.clientHeight;

    this._stems     = [];
    this._particles = [];

    // Solid black fill on first setup
    ctx.fillStyle = '#0e1014';
    ctx.fillRect(0, 0, this.W, this.H);

    // Two trunk stems always present
    this._spawnTrunk(0.35);
    this._spawnTrunk(0.65);
  }

  onResize(w, h) {
    this.W = w;
    this.H = h;
    // Ensure we always have at least 2 trunk stems after resize
    if (this._stems.filter(s => s.isTrunk).length < 2) {
      this._spawnTrunk(0.35);
      this._spawnTrunk(0.65);
    }
  }

  teardown() {
    this._stems     = [];
    this._particles = [];
  }

  onSample(field, value, ts) {
    // Emit spore particles only on deviation samples
    if (field !== 'deviation') return;
    if (!this._state.isLive) return;

    const tops = this._stems
      .filter(s => !s.dead)
      .sort((a, b) => a.y - b.y)   // smallest y = highest on screen
      .slice(0, 3);

    const count = Math.ceil(value * 0.8);
    for (const stem of tops) {
      for (let i = 0; i < count && this._particles.length < 400; i++) {
        this._particles.push({
          x:     stem.x,
          y:     stem.y,
          vx:    (Math.random() - 0.5) * 40,
          vy:    Math.random() * -60 - 20,
          life:  1,
          decay: 0.3 + Math.random() * 0.5,
          size:  1 + Math.random() * 3,
          hue:   stem.hue + (Math.random() - 0.5) * 30,
        });
      }
    }
  }

  render(ctx, state, dt) {
    const p  = this._params(state);
    const W  = this.W;
    const H  = this.H;

    // ── 1. Persistence fade (never clearRect — this creates the trail effect)
    ctx.globalAlpha = 1;
    ctx.fillStyle   = 'rgba(14,16,20,0.045)';
    ctx.fillRect(0, 0, W, H);

    // ── 2. Grow and draw stems
    const liveStemsBeforePrune = this._stems.filter(s => !s.dead);

    // Ensure minimum trunk count (trunks occasionally wander off-screen)
    const trunks = this._stems.filter(s => s.isTrunk && !s.dead);
    if (trunks.length < 2) this._spawnTrunk(Math.random() < 0.5 ? 0.35 : 0.65);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const deadList = [];

    for (const stem of this._stems) {
      if (stem.dead) continue;

      // Update speed from data each frame
      stem.speed = p.stemSpeed;

      const growDist = stem.speed * dt;
      stem.branchCooldown -= dt;

      // Direction: drift toward vertical + random turbulence
      const targetAngle = -Math.PI / 2;
      stem.angle += (targetAngle - stem.angle) * 0.04 * dt * 60;
      stem.angle += (Math.random() - 0.5) * p.turbulence * 2;
      // Clamp to ±75° from vertical
      stem.angle = Math.max(-Math.PI * 0.85, Math.min(-Math.PI * 0.15, stem.angle));

      const prevX = stem.x;
      const prevY = stem.y;
      stem.x += Math.cos(stem.angle) * growDist;
      stem.y += Math.sin(stem.angle) * growDist;
      stem.length += growDist;
      stem.width  *= Math.pow(stem.widthDecay, dt * 60);

      // Petal / leaf at segment intervals
      if (stem.length - stem.lastSegAt > 18) {
        stem.segments.push({ x: stem.x, y: stem.y });
        stem.lastSegAt = stem.length;
        this._drawLeaf(ctx, stem, p);
      }

      // Draw stem segment
      if (stem.width > 0.3) {
        ctx.beginPath();
        ctx.moveTo(prevX, prevY);
        ctx.lineTo(stem.x, stem.y);
        ctx.strokeStyle = `hsla(${stem.hue},${p.saturation}%,${p.lightness}%,${stem.alpha})`;
        ctx.lineWidth   = stem.width;
        ctx.stroke();
      }

      // Death conditions
      if ((!stem.isTrunk && stem.length > stem.maxLength) || stem.y < -30) {
        stem.dead = true;
        deadList.push(stem);
        continue;
      }

      // Branching
      if (stem.branchCooldown <= 0 && Math.random() < p.branchProb * dt) {
        const child = this._spawnBranch(stem, p);
        child.hue   = p.stemHue + (Math.random() - 0.5) * 20;
        this._stems.push(child);
        stem.branchCooldown = 1.5 + Math.random() * 2;
      }
    }

    // Prune to maxStems (never remove trunks)
    const liveNow = this._stems.filter(s => !s.dead);
    if (liveNow.length > p.maxStems) {
      const mortal = liveNow
        .filter(s => !s.isTrunk)
        .sort((a, b) => a.born - b.born); // oldest first
      const excess = liveNow.length - p.maxStems;
      for (let i = 0; i < excess && i < mortal.length; i++) {
        mortal[i].dead = true;
      }
    }

    // Periodically remove dead stems to prevent unbounded array growth
    if (this._stems.length > 200) {
      this._stems = this._stems.filter(s => !s.dead || s.isTrunk);
    }

    // ── 3. Particles
    ctx.globalAlpha = 1;
    for (let i = this._particles.length - 1; i >= 0; i--) {
      const q = this._particles[i];
      q.vy   -= 30  * dt;
      q.vx   += (Math.random() - 0.5) * 20 * dt;
      q.x    += q.vx * dt;
      q.y    += q.vy * dt;
      q.life -= q.decay * dt;

      if (q.life <= 0) { this._particles.splice(i, 1); continue; }

      ctx.beginPath();
      ctx.arc(q.x, q.y, q.size, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${q.hue},70%,65%,${q.life * 0.6})`;
      ctx.fill();
    }
  }

  _drawLeaf(ctx, stem, p) {
    if (stem.width < 1) return; // too thin for a visible leaf
    const lw  = stem.width * 3.5;
    const lh  = stem.width * 1.8;
    const ang = stem.angle + 0.5;

    ctx.save();
    ctx.translate(stem.x, stem.y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.ellipse(0, 0, lw, lh, 0, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${stem.hue + 20},${p.saturation + 10}%,35%,0.35)`;
    ctx.fill();
    ctx.restore();
  }
}

window.OrganicGrowthVisualizer = OrganicGrowthVisualizer;
