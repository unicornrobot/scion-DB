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
app.get('/viz', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'viz.html')));

// Simple status endpoint so you can check the relay is up
app.get('/relay-status', (_req, res) => {
  res.json({
    publisherConnected,
    viewers: viewers.size,
    latestFields: Object.keys(latest),
  });
});

const server = http.createServer(app);

// ── WebSocket hub ────────────────────────────────────────────────────────────
const wss     = new WebSocketServer({ server, path: '/ws' });
const viewers = new Set();
const latest  = {};           // cached latest per field → sent as hello to new viewers
let   publisherConnected = false;

wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://x');
  const isPub  = PUB_SECRET && url.searchParams.get('pub') === PUB_SECRET;

  if (isPub) {
    // ── Publisher (local server.js) ────────────────────────────────────────
    publisherConnected = true;
    console.log('[relay] publisher connected');

    ws.on('message', (data) => {
      // Cache latest field values for viewers who connect mid-session
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'sample') latest[msg.field] = msg.value;
      } catch (_) {}

      // Fan out to every open viewer
      const str = data.toString();
      for (const v of viewers) {
        if (v.readyState === WebSocket.OPEN) v.send(str);
      }
    });

    ws.on('close', () => {
      publisherConnected = false;
      console.log('[relay] publisher disconnected');
    });

    ws.on('error', () => {});

  } else {
    // ── Viewer browser ─────────────────────────────────────────────────────
    viewers.add(ws);
    console.log(`[relay] viewer connected (${viewers.size} total)`);

    // Seed the client with whatever values we already know
    ws.send(JSON.stringify({ type: 'hello', latest }));

    ws.on('close', () => {
      viewers.delete(ws);
      console.log(`[relay] viewer left (${viewers.size} remaining)`);
    });

    ws.on('error', () => {});
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[relay] listening on port ${PORT}`);
  console.log(`[relay] publisher auth: ${PUB_SECRET ? 'enabled' : 'DISABLED'}`);
});
