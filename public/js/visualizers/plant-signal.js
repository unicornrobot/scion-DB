/**
 * Plant Signal Visualizer
 *
 * Generates an organic, curved plant (stem, branches, leaves) and renders
 * electrical action-potential pulses travelling through the whole vascular
 * network, driven by live OSC data from the Pocket Scion biosensor.
 *
 * A pulse is born at the root and keeps its energy as it climbs an edge; at
 * every junction it splits into all child branches (slightly attenuated) so the
 * signal reaches every stem, twig and leaf. Edges and leaves a pulse touches
 * light up and slowly fade, so activity ripples visibly across the plant.
 *
 * Public config (read/written by the admin panel):
 *   watchField  — field that triggers new pulses           (default: 'deviation')
 *   sensitivity — normalised activity threshold            (default: 0.3)
 *   palette     — pulse colour theme                       (default: 'electric')
 *   pulseSpeed  — speed multiplier for travelling pulses   (default: 1.0)
 *   showVeins   — draw the plant structure background      (default: true)
 */

// t=0 → dim leading-edge colour, t=1 → bright core colour (hue blends h0→h1).
const PLANT_PALETTES = {
  electric: { h0:  88, h1: 130, s: 100, l0: 55, l1: 100 }, // acid-green → white
  biolum:   { h0: 168, h1: 198, s:  90, l0: 50, l1:  92 }, // teal → pale-blue
  fire:     { h0:   8, h1:  52, s: 100, l0: 50, l1:  96 }, // red-orange → yellow
  neural:   { h0: 262, h1: 300, s:  88, l0: 55, l1:  94 }, // purple → pink-white
};

class PlantSignalVisualizer {

  constructor() {
    // ── Public config ──────────────────────────────────────────────────────
    this.watchField  = 'deviation';
    this.sensitivity = 0.3;
    this.palette     = 'electric';
    this.pulseSpeed  = 1.0;   // 0.2 – 3.0
    this.showVeins   = true;

    // ── Plant graph ────────────────────────────────────────────────────────
    // nodes[i] = { x, y }
    // edges[i] = { fromIdx, toIdx, x1,y1, cx,cy (bezier ctrl), x2,y2, width, depth, glow }
    // leaves[i]= { x, y, angle, size, nodeIdx, glow }
    this._nodes      = [];
    this._edges      = [];
    this._leaves     = [];
    this._childEdges = {};   // nodeIdx → [edgeIdx, …]
    this._leafByNode = {};   // nodeIdx → [leafIdx, …]
    this._rootEdges  = [];   // edges leaving node 0

    // ── Static rendered plant (offscreen) ──────────────────────────────────
    this._plantCanvas = null;

    // ── Active pulses ──────────────────────────────────────────────────────
    // pulse = { edgeIdx, t (0-1), speed, intensity, hue }
    this._pulses     = [];
    this._MAX_PULSES = 500;
    this._spawnCooldown = 0;

    // ── Canvas dims ────────────────────────────────────────────────────────
    this._w = 0;
    this._h = 0;

    // ── Change detection (same EMA/peak as SacredSpiralVisualizer) ─────────
    this._changeMag  = 0;
    this._changeEma  = 0;
    this._changePeak = 0.0001;
    this._normChange = 0;
    this._prevSmooth = {};
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  setup(ctx, state, engine) {
    this._w = engine.canvas.clientWidth;
    this._h = engine.canvas.clientHeight;
    Object.assign(this._prevSmooth, state.smooth);
    this._buildPlant();
  }

  teardown() {
    this._pulses      = [];
    this._plantCanvas = null;
    this._nodes       = [];
    this._edges       = [];
    this._leaves      = [];
    this._childEdges  = {};
    this._leafByNode  = {};
    this._changeEma   = 0;
    this._normChange  = 0;
    this._changePeak  = 0.0001;
    this._prevSmooth  = {};
  }

  onResize(w, h) {
    this._w = w;
    this._h = h;
    this._pulses = [];
    this._buildPlant();
  }

  // ── Plant generation ───────────────────────────────────────────────────────

  _buildPlant() {
    this._nodes      = [];
    this._edges      = [];
    this._leaves     = [];
    this._childEdges = {};
    this._leafByNode = {};

    this._generateTree();
    this._buildLookups();
    this._renderPlantCanvas();
  }

  _addNode(x, y) {
    const idx = this._nodes.length;
    this._nodes.push({ x, y });
    return idx;
  }

  // bow = perpendicular curve as a fraction of segment length (signed)
  // droop = extra downward pull on the control point (px), for gravity sag
  _addEdge(fromIdx, toIdx, width, depth, bow = 0, droop = 0) {
    const f = this._nodes[fromIdx];
    const t = this._nodes[toIdx];
    const dx = t.x - f.x, dy = t.y - f.y;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (f.x + t.x) / 2, my = (f.y + t.y) / 2;
    const px = -dy / len, py = dx / len;          // perpendicular unit
    this._edges.push({
      fromIdx, toIdx,
      x1: f.x, y1: f.y,
      cx: mx + px * bow * len,
      cy: my + py * bow * len + droop,
      x2: t.x, y2: t.y,
      len, width, depth,
      glow: 0,
    });
  }

  _addLeaf(x, y, angle, size, nodeIdx) {
    this._leaves.push({ x, y, angle, size, nodeIdx, glow: 0 });
  }

  // Point on an edge's quadratic bezier at parameter t (0–1)
  _edgePoint(e, t) {
    const mt = 1 - t;
    const a = mt * mt, b = 2 * mt * t, c = t * t;
    return {
      x: a * e.x1 + b * e.cx + c * e.x2,
      y: a * e.y1 + b * e.cy + c * e.y2,
    };
  }

  _buildLookups() {
    this._childEdges = {};
    for (let i = 0; i < this._edges.length; i++) {
      const fi = this._edges[i].fromIdx;
      (this._childEdges[fi] = this._childEdges[fi] || []).push(i);
    }
    this._rootEdges = this._childEdges[0] || [];

    this._leafByNode = {};
    for (let i = 0; i < this._leaves.length; i++) {
      const ni = this._leaves[i].nodeIdx;
      (this._leafByNode[ni] = this._leafByNode[ni] || []).push(i);
    }
  }

  _generateTree() {
    const w = this._w, h = this._h;
    const baseX  = w * 0.5;
    const baseY  = h * 0.96;
    const stemH  = h * 0.80;
    const SEGS   = 7;
    const segLen = stemH / SEGS;
    const sw0    = Math.min(w, h) * 0.015;   // stem base width

    const root = this._addNode(baseX, baseY);

    let cx = baseX, cy = baseY;
    let angle = -Math.PI / 2;
    let prevIdx = root;
    let side = Math.random() < 0.5 ? 1 : -1;

    for (let i = 0; i < SEGS; i++) {
      const t = i / SEGS;
      // Gentle serpentine sway of the main stem
      angle += Math.sin(i * 1.1 + 0.5) * 0.07 + (Math.random() - 0.5) * 0.04;
      const nx = cx + Math.cos(angle) * segLen;
      const ny = cy + Math.sin(angle) * segLen;
      const nIdx = this._addNode(nx, ny);

      const width = sw0 * (1 - t * 0.70);
      const bow   = Math.sin(i * 1.3) * 0.12;        // alternating S-curve
      this._addEdge(prevIdx, nIdx, width, 0, bow, 0);

      // Side branches from each interior node
      if (i >= 1) {
        side = -side;
        const bAng = angle + side * (0.45 + Math.random() * 0.30);
        const bLen = stemH * (0.30 + (1 - t) * 0.28) * (0.7 + Math.random() * 0.3);
        this._growBranch(nIdx, nx, ny, bAng, bLen, width * 0.62, 1);

        // Opposing branch — denser through the middle of the plant
        if (i >= 1 && i <= SEGS - 2 && Math.random() < 0.7) {
          const bAng2 = angle - side * (0.50 + Math.random() * 0.30);
          this._growBranch(nIdx, nx, ny, bAng2, bLen * 0.78, width * 0.5, 1);
        }
      }

      prevIdx = nIdx;
      cx = nx; cy = ny;
    }

    // Crown leaf at the very top of the stem
    this._addLeaf(cx, cy, angle, sw0 * 3.0, prevIdx);
  }

  _growBranch(parentIdx, x, y, angle, totalLen, width, depth) {
    if (totalLen < 16 || width < 0.5 || depth > 4) {
      this._addLeaf(x, y, angle, 6 + Math.random() * 5, parentIdx);
      return;
    }

    const segs   = depth <= 1 ? 4 : 3;
    const segLen = totalLen / segs;
    let cx = x, cy = y, a = angle;
    let prevIdx = parentIdx;

    for (let i = 0; i < segs; i++) {
      // Gravity: nudge the travel direction downward, stronger toward the tip
      // and deeper in the tree, so branches arch and droop like a real plant.
      const grav = 0.05 + depth * 0.025 + (i / segs) * 0.06;
      let dx = Math.cos(a), dy = Math.sin(a);
      dy += grav;
      const m = Math.hypot(dx, dy) || 1;
      dx /= m; dy /= m;
      a = Math.atan2(dy, dx);

      const nx = cx + dx * segLen;
      const ny = cy + dy * segLen;
      const nIdx = this._addNode(nx, ny);

      const ew  = Math.max(0.4, width * (1 - (i / segs) * 0.5));
      const bow = (Math.random() - 0.5) * 0.30;
      this._addEdge(prevIdx, nIdx, ew, depth, bow, grav * segLen * 0.35);

      // Sub-branches
      if (depth < 3 && i > 0 && Math.random() < 0.5) {
        const subSide = Math.random() < 0.5 ? 1 : -1;
        const subAng  = a + subSide * (0.40 + Math.random() * 0.35);
        this._growBranch(
          nIdx, nx, ny, subAng,
          totalLen * (0.40 + Math.random() * 0.22),
          ew * 0.55, depth + 1
        );
      }

      prevIdx = nIdx;
      cx = nx; cy = ny;
    }

    // Leaf at the branch tip
    const leafSize = 6 + (4 - Math.min(depth, 4)) * 3.5 + Math.random() * 6;
    this._addLeaf(cx, cy, a, leafSize, prevIdx);
  }

  // ── Static plant canvas (dark structure, drawn once) ───────────────────────

  _renderPlantCanvas() {
    const w = this._w, h = this._h;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Deepest branches first so the trunk overlaps them
    const sorted = [...this._edges].sort((a, b) => b.depth - a.depth);
    for (const e of sorted) {
      const t     = e.depth / 4;
      const alpha = (0.6 - t * 0.18).toFixed(2);
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.quadraticCurveTo(e.cx, e.cy, e.x2, e.y2);
      ctx.strokeStyle = `rgba(34, ${Math.round(60 + t * 24)}, 28, ${alpha})`;
      ctx.lineWidth   = e.width;
      ctx.stroke();
    }

    for (const leaf of this._leaves) {
      this._traceLeaf(ctx, leaf);
      ctx.fillStyle   = 'rgba(24, 54, 19, 0.72)';
      ctx.strokeStyle = 'rgba(38, 74, 26, 0.45)';
      ctx.lineWidth   = 0.6;
      ctx.fill();
      ctx.stroke();
    }

    this._plantCanvas = c;
  }

  // Trace a curved, slightly asymmetric leaf blade as a path (no fill/stroke).
  _traceLeaf(ctx, leaf) {
    const s = leaf.size;
    ctx.save();
    ctx.translate(leaf.x, leaf.y);
    ctx.rotate(leaf.angle - Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    // one side fuller than the other for a natural look
    ctx.bezierCurveTo( s * 0.52, -s * 0.28,  s * 0.42, -s * 0.78, 0, -s);
    ctx.bezierCurveTo(-s * 0.42, -s * 0.78, -s * 0.52, -s * 0.28, 0, 0);
    ctx.restore();
  }

  // ── Signal system ──────────────────────────────────────────────────────────

  _trySpawnPulses(dt, activity) {
    this._spawnCooldown -= dt;
    if (this._spawnCooldown > 0) return;
    if (activity < 0.04) return;
    if (!this._rootEdges.length) return;
    if (this._pulses.length >= this._MAX_PULSES) return;

    const p   = PLANT_PALETTES[this.palette] || PLANT_PALETTES.electric;
    const hue = p.h0 + activity * (p.h1 - p.h0);

    for (const eIdx of this._rootEdges) {
      this._pulses.push({
        edgeIdx:   eIdx,
        t:         0,
        speed:     3.0 + activity * 5.0,   // edge-lengths per second
        intensity: 0.55 + activity * 0.45,
        hue,
      });
    }

    // Stronger signal → much shorter gap between pulse trains
    this._spawnCooldown = 0.10 + (1 - activity) * 0.55;
  }

  _stepPulses(dt) {
    const ATTEN = 0.93;   // intensity kept across each junction
    const add   = [];

    for (let i = this._pulses.length - 1; i >= 0; i--) {
      const p = this._pulses[i];
      const e = this._edges[p.edgeIdx];
      p.t += p.speed * this.pulseSpeed * dt;

      // Light the edge it is travelling along
      if (p.intensity > e.glow) e.glow = p.intensity;

      if (p.t < 1) continue;

      // Reached the far node — propagate or bloom
      const toNode   = e.toIdx;
      const children = this._childEdges[toNode];
      const carry    = (p.t - 1);
      const t0       = carry > 0 && carry < 1 ? carry : 0;

      if (children && children.length) {
        if (p.intensity > 0.05) {
          for (const ci of children) {
            if (this._pulses.length + add.length >= this._MAX_PULSES) break;
            add.push({
              edgeIdx:   ci,
              t:         t0,
              speed:     p.speed * 0.97,
              intensity: p.intensity * ATTEN,
              hue:       p.hue,
            });
          }
        }
      } else {
        // Leaf tip — make the leaf flare
        const leafIdxs = this._leafByNode[toNode];
        if (leafIdxs) {
          for (const li of leafIdxs) {
            const g = p.intensity * 1.3;
            if (g > this._leaves[li].glow) this._leaves[li].glow = Math.min(1, g);
          }
        }
      }

      this._pulses.splice(i, 1);
    }

    if (add.length) this._pulses.push(...add);
  }

  // Exponentially fade edge & leaf glow so activity ripples and recedes.
  _decayGlow(dt) {
    const k = Math.pow(0.92, dt * 60);
    for (const e of this._edges) {
      if (e.glow > 0.004) e.glow *= k; else e.glow = 0;
    }
    for (const l of this._leaves) {
      if (l.glow > 0.004) l.glow *= k; else l.glow = 0;
    }
  }

  // ── Drawing ─────────────────────────────────────────────────────────────────

  _drawGlowEdges(ctx) {
    const p = PLANT_PALETTES[this.palette] || PLANT_PALETTES.electric;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const e of this._edges) {
      if (e.glow < 0.02) continue;
      const g   = e.glow;
      const hue = p.h0 + g * (p.h1 - p.h0);
      const l   = p.l0 + g * (p.l1 - p.l0);
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.quadraticCurveTo(e.cx, e.cy, e.x2, e.y2);
      ctx.strokeStyle = `hsla(${hue | 0},${p.s}%,${l | 0}%,${(g * 0.9).toFixed(2)})`;
      ctx.lineWidth   = e.width * 0.8 + g * 2.2;
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawGlowLeaves(ctx) {
    const p = PLANT_PALETTES[this.palette] || PLANT_PALETTES.electric;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const leaf of this._leaves) {
      if (leaf.glow < 0.02) continue;
      const g = leaf.glow;
      this._traceLeaf(ctx, leaf);
      ctx.fillStyle = `hsla(${(p.h0 + g * (p.h1 - p.h0)) | 0},${p.s}%,${(p.l0 + g * (p.l1 - p.l0)) | 0}%,${(g * 0.7).toFixed(2)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawPulses(ctx) {
    if (!this._pulses.length) return;
    const p = PLANT_PALETTES[this.palette] || PLANT_PALETTES.electric;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const pulse of this._pulses) {
      const e   = this._edges[pulse.edgeIdx];
      const pt  = this._edgePoint(e, Math.min(pulse.t, 1));
      const int = pulse.intensity;
      const hue = pulse.hue;

      // Radial glow halo
      const glowR = 3 + int * 9;
      const grd = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, glowR);
      grd.addColorStop(0,   `hsla(${hue},${p.s}%,${p.l1}%,${(int * 0.85).toFixed(2)})`);
      grd.addColorStop(0.5, `hsla(${hue},${p.s}%,${p.l0}%,${(int * 0.30).toFixed(2)})`);
      grd.addColorStop(1,   `hsla(${hue},${p.s}%,${p.l0}%,0)`);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      // Bright white-hot core
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 1.3 + int * 1.3, 0, Math.PI * 2);
      ctx.fillStyle = `hsla(${hue},45%,98%,${(int * 0.95).toFixed(2)})`;
      ctx.fill();
    }
    ctx.restore();
  }

  _drawSensor(ctx, live, normChange) {
    const bx = this._w * 0.5;
    const by = this._h * 0.96;
    const breathe = (Math.sin(Date.now() * 0.0028) + 1) * 0.5;
    const radius  = 7 + breathe * 4;
    const alpha   = live ? (0.35 + normChange * 0.5) : 0.15;
    const p = PLANT_PALETTES[this.palette] || PLANT_PALETTES.electric;

    const grd = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
    grd.addColorStop(0, `hsla(${p.h1},${p.s}%,${p.l1}%,${alpha.toFixed(2)})`);
    grd.addColorStop(1, `hsla(${p.h0},${p.s}%,${p.l0}%,0)`);
    ctx.beginPath();
    ctx.arc(bx, by, radius, 0, Math.PI * 2);
    ctx.fillStyle = grd;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(bx, by, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = live
      ? `hsla(${p.h1},${p.s}%,92%,${(0.7 + normChange * 0.3).toFixed(2)})`
      : '#3a4a38';
    ctx.fill();
  }

  // ── Change detection (same EMA/peak pattern as SacredSpiralVisualizer) ─────

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
    const w = this._w, h = this._h;
    if (!w || !h || !this._plantCanvas) return;

    const safeDt = Math.min(dt, 0.1);

    // Background
    ctx.fillStyle = '#060c06';
    ctx.fillRect(0, 0, w, h);

    // Static dark plant structure
    if (this.showVeins) ctx.drawImage(this._plantCanvas, 0, 0);

    // Data → pulses
    this._updateChangeDetection(state);
    const activity = this._normChange > this.sensitivity ? this._normChange : 0;

    this._trySpawnPulses(safeDt, activity);
    this._stepPulses(safeDt);
    this._decayGlow(safeDt);

    // Layered glow: lit veins → lit leaves → travelling pulse heads
    this._drawGlowEdges(ctx);
    this._drawGlowLeaves(ctx);
    this._drawPulses(ctx);

    // Electrode attachment point
    this._drawSensor(ctx, state.isLive, this._normChange);
  }
}

window.PlantSignalVisualizer = PlantSignalVisualizer;
