/**
 * VizEngine — lightweight plugin host for canvas visualizers.
 *
 * Usage:
 *   const engine = new VizEngine(canvas);
 *   engine.register('myViz', new MyVisualizer());
 *   engine.activate('myViz');
 *
 * Plugin interface (all methods optional, duck-typed):
 *   setup(ctx, state, engine)   — called once on activation
 *   render(ctx, state, dt)      — called every RAF frame; dt in seconds
 *   onSample(field, value, ts)  — called on each WebSocket sample message
 *   onResize(w, h)              — called when canvas logical size changes
 *   teardown()                  — called before switching to another visualizer
 */
class VizEngine {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');

    this._registry   = new Map();
    this._active     = null;
    this._rafId      = null;
    this._lastFrame  = 0;
    this._ws         = null;
    this._reconnectDelay = 500;

    /** Set to a function(connected: bool) to receive connection state changes. */
    this.onConnectionChange = null;

    this.state = {
      // Raw latest values (null until first sample arrives)
      min: null, max: null, mean: null,
      delta: null, variance: null, deviation: null,

      // EMA-smoothed values — pre-seeded at sensible midpoints so visualizers
      // get reasonable values immediately, even before the first data arrives.
      smooth: { min: 100, max: 100, mean: 100, delta: 5, variance: 10, deviation: 2 },

      // Per-field timestamp of last update (ms, null = never received)
      ts: { min: null, max: null, mean: null, delta: null, variance: null, deviation: null },

      // Per-field ring buffers (length 60, shared write pointer)
      history: Object.fromEntries(
        ['min', 'max', 'mean', 'delta', 'variance', 'deviation']
          .map(f => [f, new Float32Array(60)])
      ),
      historyHead: 0,

      // True when any field was updated within the last 3 seconds
      isLive: false,
      lastSampleTs: null,
    };

    this._setupResize();
    this._connect();
    this._startLoop();
  }

  // ── Plugin management ────────────────────────────────────────────────────

  register(name, viz) {
    this._registry.set(name, viz);
  }

  activate(name) {
    if (!this._registry.has(name)) {
      console.warn(`[VizEngine] unknown visualizer "${name}"`);
      return;
    }
    this._active?.teardown?.();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0); // reset any leftover transform
    this._active = this._registry.get(name);
    this._applyDPR(); // re-applies ctx.scale(dpr,dpr) after transform reset
    this._active?.setup?.(this.ctx, this.state, this);
  }

  // ── Render loop ──────────────────────────────────────────────────────────

  _startLoop() {
    const tick = (now) => {
      this._rafId = requestAnimationFrame(tick);
      const dt = Math.min((now - this._lastFrame) / 1000, 0.1); // cap at 100 ms
      this._lastFrame = now;

      this.state.isLive =
        this.state.lastSampleTs !== null &&
        (performance.now() - this.state.lastSampleTs) < 3000;

      this._active?.render?.(this.ctx, this.state, dt);
    };
    requestAnimationFrame(tick);
  }

  // ── Canvas / DPR ─────────────────────────────────────────────────────────

  _setupResize() {
    new ResizeObserver(() => this._applyDPR()).observe(this.canvas);
  }

  _applyDPR() {
    const dpr = window.devicePixelRatio || 1;
    const W   = Math.floor(this.canvas.clientWidth  * dpr);
    const H   = Math.floor(this.canvas.clientHeight * dpr);
    const changed = this.canvas.width !== W || this.canvas.height !== H;
    if (changed) {
      this.canvas.width  = W;
      this.canvas.height = H;
    }
    // Always (re)apply the DPR transform absolutely. Setting canvas.width above
    // resets the transform to identity, and activate() also resets it — using
    // setTransform (not cumulative scale) makes this safe to call any time and
    // guarantees a visualizer switched-to after boot is scaled correctly.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (changed) {
      this._active?.onResize?.(this.canvas.clientWidth, this.canvas.clientHeight);
    }
  }

  // ── WebSocket ────────────────────────────────────────────────────────────

  _connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws    = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
      this._reconnectDelay = 500;
      this.onConnectionChange?.(true);
    };

    ws.onclose = () => {
      this.onConnectionChange?.(false);
      setTimeout(() => this._connect(), this._reconnectDelay);
      this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, 10000);
    };

    ws.onerror = () => ws.close();

    ws.onmessage = (e) => {
      try { this._applyMessage(JSON.parse(e.data)); } catch (_) {}
    };

    this._ws = ws;
  }

  _applyMessage(msg) {
    if (msg.type === 'sample') {
      const f = msg.field;
      if (!(f in this.state.smooth)) return;

      this.state[f]        = msg.value;
      this.state.ts[f]     = msg.ts;
      this.state.lastSampleTs = performance.now(); // use perf.now for isLive check

      // EMA smooth (α = 0.12 ≈ 8-sample window at 10 Hz)
      this.state.smooth[f] += 0.12 * (msg.value - this.state.smooth[f]);

      // Ring buffer
      const idx = this.state.historyHead % 60;
      this.state.history[f][idx] = msg.value;
      this.state.historyHead++;

      // Let the active visualizer react to new data (must NOT draw here)
      this._active?.onSample?.(f, msg.value, msg.ts);

    } else if (msg.type === 'hello' && msg.latest) {
      // Seed smooth values from server's known-latest on first connect
      for (const f of Object.keys(this.state.smooth)) {
        if (msg.latest[f] != null) {
          this.state[f]         = msg.latest[f];
          this.state.smooth[f]  = msg.latest[f];
        }
      }
    }
  }

  destroy() {
    cancelAnimationFrame(this._rafId);
    this._ws?.close();
    this._active?.teardown?.();
  }
}

window.VizEngine = VizEngine;
