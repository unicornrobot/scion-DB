// Shared "Record" control — mountable in any page (Chart, Viz, Dashboard).
// Reuses the existing /api/record/start|stop endpoints and the `recording`/
// `hello` WS messages server.js already broadcasts to every connected
// client, so recording started from one view is immediately reflected —
// and controllable — from any other. Host pages feed WS messages in via
// .onMessage(msg) from their own existing socket; this module never opens
// a socket of its own.
(function () {
  const CSS = `
    .rw-title { font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px;
      color: var(--muted); font-weight: 700; margin-bottom: 8px; }
    .rw-name { width: 100%; }
    .rw-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; }
    .rw-row button { flex: 1; }
    .rw-status { font-size: 12px; color: var(--muted); margin-top: 8px; min-height: 16px; }
    .rw-status.active { color: var(--rec, #ef476f); }
  `;
  let injected = false;
  function injectStyle() {
    if (injected) return;
    const s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
    injected = true;
  }

  async function api(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || r.statusText);
    return data;
  }

  function create({ container, label = 'Record', onRecordingStopped, recPill }) {
    injectStyle();
    container.innerHTML = `
      <div class="rw-title">${label}</div>
      <input type="text" class="rw-name" placeholder="session name (optional)" />
      <div class="rw-row">
        <button type="button" class="rw-start">Record</button>
        <button type="button" class="rw-stop danger" disabled>Stop</button>
      </div>
      <div class="rw-status">Not recording.</div>
    `;

    const nameEl   = container.querySelector('.rw-name');
    const startBtn = container.querySelector('.rw-start');
    const stopBtn  = container.querySelector('.rw-stop');
    const statusEl = container.querySelector('.rw-status');

    let wasRecording = false;

    function render(rec) {
      const active = !!(rec && rec.active);
      startBtn.disabled = active;
      stopBtn.disabled  = !active;
      statusEl.classList.toggle('active', active);
      statusEl.textContent = active
        ? `● ${rec.session} · ${((Date.now() - rec.startedAt) / 1000 | 0)}s · ${rec.pointsWritten} pts`
        : 'Not recording.';

      if (recPill) {
        recPill.classList.toggle('rec', active);
        const lbl = recPill.querySelector('span:last-child');
        if (lbl) lbl.textContent = active ? 'recording' : 'idle';
      }

      if (wasRecording && !active && typeof onRecordingStopped === 'function') {
        onRecordingStopped(rec);
      }
      wasRecording = active;
    }

    startBtn.addEventListener('click', async () => {
      try {
        await api('/api/record/start', { session: nameEl.value.trim() || undefined });
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
      }
    });
    stopBtn.addEventListener('click', async () => {
      try {
        await api('/api/record/stop');
      } catch (err) {
        statusEl.textContent = 'Error: ' + err.message;
      }
    });

    // Elapsed-time tick + fallback status poll — same 1s cadence Chart's
    // original implementation used, so the counter keeps ticking even
    // between WS broadcasts.
    setInterval(async () => {
      try {
        const r = await fetch('/api/status').then(r => r.json());
        if (r.recording) render(r.recording);
      } catch (_) {}
    }, 1000);

    return {
      onMessage(msg) {
        if (msg.type === 'recording') render(msg.recording);
        else if (msg.type === 'hello' && msg.recording) render(msg.recording);
      },
    };
  }

  window.ScionRecWidget = { create };
})();
