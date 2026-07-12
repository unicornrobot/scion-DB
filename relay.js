/**
 * Scion cloud relay
 *
 * Serves the viz frontend and acts as a WebSocket fan-out hub:
 *   - One publisher connection (local server.js, authenticated with PUB_SECRET)
 *   - Any number of viewer browser connections
 *
 * Environment variables:
 *   PORT        — HTTP port (Railway sets this automatically)
 *   PUB_SECRET  — shared secret; local server connects with ?pub=<secret>
 */

require('dotenv').config();

const path       = require('path');
const http       = require('http');
const express    = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const PORT       = process.env.PORT       || 3001;
const PUB_SECRET = process.env.PUB_SECRET || '';

if (!PUB_SECRET) {
  console.warn('[relay] WARNING: PUB_SECRET is not set — publisher auth is disabled');
}

// ── HTTP / static files ──────────────────────────────────────────────────────
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/viz',       (_req, res) => res.sendFile(path.join(__dirname, 'public', 'viz.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/relay-status', (_req, res) => {
  res.json({
    publisherConnected,
    viewers: viewers.size,
    latest,
  });
});

// Wipe the cached latest values (e.g. after a bad data burst)
app.post('/relay-reset', (req, res) => {
  const secret = req.headers['x-pub-secret'] || '';
  if (secret !== PUB_SECRET) return res.status(401).json({ error: 'unauthorized' });
  for (const k of Object.keys(latest)) delete latest[k];
  console.log('[relay] latest cache cleared');
  res.json({ ok: true });
});

const server = http.createServer(app);

// ── WebSocket hub ────────────────────────────────────────────────────────────
const wss        = new WebSocketServer({ server, path: '/ws' });
const viewers    = new Set();
const latest     = {};
let   publisherConnected = false;
let   publisherWs        = null;

wss.on('connection', (ws, req) => {
  const url   = new URL(req.url, 'http://x');
  const isPub = PUB_SECRET && url.searchParams.get('pub') === PUB_SECRET;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  if (isPub) {
    // ── Publisher (local server.js) ────────────────────────────────────────
    // If a stale publisher socket is still open, kill it before registering
    // the new one — prevents its delayed close from wiping the fresh state.
    if (publisherWs && publisherWs !== ws) {
      console.log('[relay] replacing stale publisher');
      publisherWs.terminate();
    }
    publisherConnected = true;
    publisherWs        = ws;
    console.log('[relay] publisher connected');

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'sample' && Number.isFinite(msg.value)) {
          latest[msg.field] = msg.value;
        }
      } catch (_) {}

      const str = data.toString();
      for (const v of viewers) {
        if (v.readyState === WebSocket.OPEN) v.send(str);
      }
    });

    ws.on('close', () => {
      // Only clear state if this is still the active publisher socket.
      // A stale socket closing after a reconnect must not overwrite the new one.
      if (publisherWs === ws) {
        publisherConnected = false;
        publisherWs        = null;
      }
      console.log('[relay] publisher disconnected');
    });

    ws.on('error', () => {});

  } else {
    // ── Viewer browser ─────────────────────────────────────────────────────
    viewers.add(ws);
    console.log(`[relay] viewer connected (${viewers.size} total)`);

    ws.send(JSON.stringify({ type: 'hello', latest }));

    ws.on('close', () => {
      viewers.delete(ws);
      console.log(`[relay] viewer left (${viewers.size} remaining)`);
    });

    ws.on('error', () => {});
  }
});

// ── Heartbeat — ping every socket every 20 s; terminate any that don't pong ──
// This forces a clean close+reconnect rather than leaving a silent dead socket.
setInterval(() => {
  // Publisher
  if (publisherWs) {
    if (!publisherWs.isAlive) {
      console.log('[relay] publisher heartbeat timeout — terminating');
      publisherConnected = false;
      publisherWs.terminate();
      publisherWs = null;
    } else {
      publisherWs.isAlive = false;
      publisherWs.ping();
    }
  }
  // Viewers
  for (const v of viewers) {
    if (!v.isAlive) { v.terminate(); viewers.delete(v); continue; }
    v.isAlive = false;
    v.ping();
  }
}, 20000);

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  console.log(`[relay] publisher auth: ${PUB_SECRET ? 'enabled' : 'DISABLED'}`);
});
