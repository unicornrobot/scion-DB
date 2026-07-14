require('dotenv').config();

const path = require('path');
const fs   = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const osc = require('osc');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const OSC_HOST = process.env.OSC_HOST || '0.0.0.0';
const OSC_PORT = parseInt(process.env.OSC_PORT || '11046', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);

const INFLUX_URL = process.env.INFLUX_URL || 'http://127.0.0.1:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || '';
const INFLUX_ORG = process.env.INFLUX_ORG || '';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'scion';
const INFLUX_MEASUREMENT = process.env.INFLUX_MEASUREMENT || 'scion_stats';

const TRACKED_FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];

// ---------------------------------------------------------------------------
// Data directory — plant metadata, session meta, and snapshots.
// ---------------------------------------------------------------------------
const DATA_DIR   = path.join(__dirname, 'data');
const PLANT_FILE = path.join(DATA_DIR, 'current-plant.json');
const META_FILE  = path.join(DATA_DIR, 'meta.json');
const SNAP_DIR   = path.join(DATA_DIR, 'snapshots');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(SNAP_DIR, { recursive: true });

function readJSON(file, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// State: latest values accumulated across OSC messages, and recording state.
// ---------------------------------------------------------------------------
const latest = {
  ts: null,
  min: null,
  max: null,
  mean: null,
  delta: null,
  variance: null,
  deviation: null,
};

const recording = {
  active: false,
  session: null,
  startedAt: null,
  pointsWritten: 0,
  lastError: null,
};

// ---------------------------------------------------------------------------
// InfluxDB client (lazy-checked; missing creds only error when recording).
// ---------------------------------------------------------------------------
let influxClient = null;
let writeApi = null;
let queryApi = null;

function getInflux() {
  if (influxClient) return influxClient;
  if (!INFLUX_TOKEN || !INFLUX_ORG) {
    throw new Error(
      'InfluxDB not configured: set INFLUX_TOKEN and INFLUX_ORG in .env',
    );
  }
  influxClient = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
  return influxClient;
}

function getWriteApi() {
  if (writeApi) return writeApi;
  writeApi = getInflux().getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ms', {
    flushInterval: 1000,
    batchSize: 100,
  });
  return writeApi;
}

function getQueryApi() {
  if (queryApi) return queryApi;
  queryApi = getInflux().getQueryApi(INFLUX_ORG);
  return queryApi;
}

// Run a Flux query and return rows as plain objects.
function flux(query) {
  return new Promise((resolve, reject) => {
    const rows = [];
    getQueryApi().queryRows(query, {
      next(row, meta) {
        rows.push(meta.toObject(row));
      },
      error: reject,
      complete: () => resolve(rows),
    });
  });
}

// Escape a string for safe interpolation inside Flux double-quoted literals.
function fluxStr(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function flushAndCloseWriteApi() {
  if (!writeApi) return;
  try {
    await writeApi.close();
  } catch (err) {
    console.error('[influx] close error:', err.message);
  } finally {
    writeApi = null;
  }
}

// ---------------------------------------------------------------------------
// Express HTTP server + WebSocket upgrade.
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '20mb' }));  // snapshots are base64-encoded PNGs
app.use(express.static(path.join(__dirname, 'public')));
app.use('/snapshots', express.static(SNAP_DIR));
app.get('/viz',       (_req, res) => res.sendFile(path.join(__dirname, 'public', 'viz.html')));
app.get('/dashboard', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ── Current plant profile ──────────────────────────────────────────────────

app.get('/api/plant', (_req, res) => {
  res.json(readJSON(PLANT_FILE, {}));
});

app.post('/api/plant', (req, res) => {
  const { name = '', species = '', notes = '', url = '' } = req.body || {};
  const plant = { name, species, notes, url };
  writeJSON(PLANT_FILE, plant);
  res.json({ ok: true, plant });
});

// ── Session metadata (plant info + snapshot flag) ──────────────────────────

app.get('/api/sessions/:name/meta', (req, res) => {
  const meta = readJSON(META_FILE, {});
  res.json(meta[req.params.name] || {});
});

app.post('/api/sessions/:name/meta', (req, res) => {
  const meta = readJSON(META_FILE, {});
  meta[req.params.name] = { ...(meta[req.params.name] || {}), ...req.body };
  writeJSON(META_FILE, meta);
  res.json({ ok: true, meta: meta[req.params.name] });
});

// ── Snapshot upload (base64 PNG from the visualiser canvas) ───────────────

app.post('/api/sessions/:name/snapshot', (req, res) => {
  const { dataUrl } = req.body || {};
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) {
    return res.status(400).json({ error: 'invalid dataUrl' });
  }
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const safe   = req.params.name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const file   = path.join(SNAP_DIR, `${safe}.png`);
  try {
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    // Mark session as having a snapshot in meta.json
    const meta = readJSON(META_FILE, {});
    meta[req.params.name] = { ...(meta[req.params.name] || {}), hasSnapshot: true };
    writeJSON(META_FILE, meta);
    res.json({ ok: true, url: `/snapshots/${safe}.png` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/status', (_req, res) => {
  res.json({
    osc: { host: OSC_HOST, port: OSC_PORT },
    influx: {
      url: INFLUX_URL,
      org: INFLUX_ORG || null,
      bucket: INFLUX_BUCKET,
      configured: Boolean(INFLUX_TOKEN && INFLUX_ORG),
    },
    latest,
    recording,
  });
});

const RANGE_LOOKBACK = '-365d';

function sessionBaseQuery(bucket, measurement, extra = '') {
  return `
    from(bucket: "${fluxStr(bucket)}")
      |> range(start: ${RANGE_LOOKBACK})
      |> filter(fn: (r) => r._measurement == "${fluxStr(measurement)}" and r._field == "value")
      |> group(columns: ["session"])
      ${extra}
  `;
}

// List recorded sessions — three fast grouped queries instead of one slow reduce.
app.get('/api/sessions', async (_req, res) => {
  try {
    const [firstRows, lastRows, countRows] = await Promise.all([
      flux(sessionBaseQuery(INFLUX_BUCKET, INFLUX_MEASUREMENT, '|> first()')),
      flux(sessionBaseQuery(INFLUX_BUCKET, INFLUX_MEASUREMENT, '|> last()')),
      flux(sessionBaseQuery(INFLUX_BUCKET, INFLUX_MEASUREMENT, '|> count()')),
    ]);

    const startMap = {};
    for (const r of firstRows) if (r.session) startMap[r.session] = new Date(r._time).getTime();
    const endMap = {};
    for (const r of lastRows)  if (r.session) endMap[r.session]   = new Date(r._time).getTime();
    const countMap = {};
    for (const r of countRows) if (r.session) countMap[r.session] = Number(r._value);

    const meta = readJSON(META_FILE, {});
    const sessions = Object.keys(startMap)
      .map((s) => ({
        session: s,
        startMs: startMap[s],
        endMs:   endMap[s]   ?? startMap[s],
        points:  countMap[s] ?? 0,
        ...(meta[s] || {}),
      }))
      .sort((a, b) => b.endMs - a.endMs);

    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch a single session as { field: [{x,y}, ...] }.
// Query params: every (Flux duration, e.g. "100ms"), maxPoints (default 2000).
app.get('/api/sessions/:name', async (req, res) => {
  const name = req.params.name;
  const maxPoints = Math.max(100, Math.min(20000, parseInt(req.query.maxPoints || '2000', 10)));
  try {
    // Three fast queries to find range + point count without a slow full-scan reduce.
    function sessionMeta(agg) {
      return `
        from(bucket: "${fluxStr(INFLUX_BUCKET)}")
          |> range(start: ${RANGE_LOOKBACK})
          |> filter(fn: (r) => r._measurement == "${fluxStr(INFLUX_MEASUREMENT)}"
                            and r._field == "value"
                            and r.session == "${fluxStr(name)}")
          |> group()
          |> ${agg}()
      `;
    }
    const [firstRows, lastRows, countRows] = await Promise.all([
      flux(sessionMeta('first')),
      flux(sessionMeta('last')),
      flux(sessionMeta('count')),
    ]);

    if (!firstRows.length) {
      return res.status(404).json({ error: 'session not found or empty' });
    }
    const startMs = new Date(firstRows[0]._time).getTime();
    const endMs   = new Date(lastRows[0]._time).getTime();
    const totalPoints = Number(countRows[0]?._value ?? 0);
    const perField = totalPoints / TRACKED_FIELDS.length;

    let every = req.query.every;
    if (!every) {
      if (perField <= maxPoints) {
        every = null; // No downsampling needed.
      } else {
        const rangeMs = Math.max(1, endMs - startMs);
        const everyMs = Math.max(1, Math.ceil(rangeMs / maxPoints));
        every = `${everyMs}ms`;
      }
    }

    const aggregate = every
      ? `|> aggregateWindow(every: ${every}, fn: mean, createEmpty: false)`
      : '';

    const dataQuery = `
      from(bucket: "${fluxStr(INFLUX_BUCKET)}")
        |> range(start: time(v: ${startMs * 1_000_000}), stop: time(v: ${(endMs + 1) * 1_000_000}))
        |> filter(fn: (r) => r._measurement == "${fluxStr(INFLUX_MEASUREMENT)}")
        |> filter(fn: (r) => r.session == "${fluxStr(name)}")
        |> filter(fn: (r) => r._field == "value")
        ${aggregate}
        |> keep(columns: ["_time", "_value", "field"])
    `;
    const rows = await flux(dataQuery);

    const series = Object.fromEntries(TRACKED_FIELDS.map((f) => [f, []]));
    for (const r of rows) {
      const f = r.field;
      if (!series[f]) continue;
      series[f].push({
        x: new Date(r._time).getTime(),
        y: Number(r._value),
      });
    }
    for (const f of TRACKED_FIELDS) {
      series[f].sort((a, b) => a.x - b.x);
    }

    res.json({
      session: name,
      startMs,
      endMs,
      every: every || null,
      points: rows.length,
      series,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/record/start', (req, res) => {
  if (recording.active) {
    return res.status(409).json({ error: 'already recording', recording });
  }
  const session =
    (req.body && typeof req.body.session === 'string' && req.body.session.trim()) ||
    `session-${new Date().toISOString().replace(/[:.]/g, '-')}`;

  try {
    getWriteApi();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  recording.active = true;
  recording.session = session;
  recording.startedAt = Date.now();
  recording.pointsWritten = 0;
  recording.lastError = null;

  // Snapshot current plant profile into this session's metadata so the
  // dashboard can display it even after the plant profile changes.
  const plant = readJSON(PLANT_FILE, {});
  if (plant.name || plant.species) {
    const sessionMeta = readJSON(META_FILE, {});
    sessionMeta[session] = { ...(sessionMeta[session] || {}), plant, recordedAt: Date.now() };
    writeJSON(META_FILE, sessionMeta);
  }

  console.log(`[record] start session=${session}`);
  broadcast({ type: 'recording', recording });
  res.json({ ok: true, recording });
});

app.delete('/api/sessions/:name', async (req, res) => {
  const name = req.params.name;

  // 1. Delete all InfluxDB points tagged with this session
  if (INFLUX_TOKEN && INFLUX_ORG) {
    try {
      const url = new URL(`${INFLUX_URL}/api/v2/delete`);
      url.searchParams.set('org',    INFLUX_ORG);
      url.searchParams.set('bucket', INFLUX_BUCKET);

      const body = JSON.stringify({
        start:     '1970-01-01T00:00:00Z',
        stop:      '2099-01-01T00:00:00Z',
        predicate: `session="${fluxStr(name)}"`,
      });

      const mod = url.protocol === 'https:' ? require('https') : require('http');
      await new Promise((resolve, reject) => {
        const r = mod.request(url, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${INFLUX_TOKEN}`,
            'Content-Type':  'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        }, (resp) => {
          resp.resume(); // drain
          if (resp.statusCode >= 400) {
            reject(new Error(`InfluxDB delete returned ${resp.statusCode}`));
          } else {
            resolve();
          }
        });
        r.on('error', reject);
        r.write(body);
        r.end();
      });
    } catch (err) {
      console.error('[influx] delete error:', err.message);
      return res.status(500).json({ error: `InfluxDB delete failed: ${err.message}` });
    }
  }

  // 2. Remove from meta.json
  try {
    const meta = readJSON(META_FILE, {});
    delete meta[name];
    writeJSON(META_FILE, meta);
  } catch (_) {}

  // 3. Remove snapshot if present
  const safe = name.replace(/[^a-zA-Z0-9_\-]/g, '_');
  const snapFile = path.join(SNAP_DIR, `${safe}.png`);
  try { fs.unlinkSync(snapFile); } catch (_) {}

  console.log(`[record] deleted session=${name}`);
  res.json({ ok: true });
});

app.post('/api/record/stop', async (_req, res) => {
  if (!recording.active) {
    return res.status(409).json({ error: 'not recording', recording });
  }
  const stopped = { ...recording };
  recording.active = false;
  recording.session = null;
  recording.startedAt = null;
  try {
    if (writeApi) await writeApi.flush();
  } catch (err) {
    console.error('[influx] flush error on stop:', err.message);
  }
  console.log(`[record] stop session=${stopped.session} points=${stopped.pointsWritten}`);
  broadcast({ type: 'recording', recording });
  res.json({ ok: true, recorded: stopped });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', latest, recording }));

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      broadcastAudio(data, ws);
    } else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'audioStart' || msg.type === 'audioStop') {
          const str = data.toString();
          for (const client of wss.clients) {
            if (client !== ws && client.readyState === 1) client.send(str);
          }
          if (relayWs && relayWs.readyState === 1) relayWs.send(str);
        }
      } catch (_) {}
    }
  });
});

// ---------------------------------------------------------------------------
// Cloud relay publisher (optional).
// Set RELAY_URL + PUB_SECRET in .env to forward every sample to the relay.
// ---------------------------------------------------------------------------
const RELAY_URL    = process.env.RELAY_URL    || '';
const PUB_SECRET   = process.env.PUB_SECRET   || '';
let   relayWs      = null;
let   relayRetryTimer = null;

function connectRelay() {
  if (!RELAY_URL || !PUB_SECRET) return;
  const { WebSocket: WS } = require('ws');
  const url = `${RELAY_URL}?pub=${encodeURIComponent(PUB_SECRET)}`;
  const ws  = new WS(url);

  ws.on('open', () => {
    relayWs = ws;
    console.log('[relay] connected to', RELAY_URL);

    // Ping the relay every 20 s so Railway's proxy never sees an idle connection
    const hb = setInterval(() => {
      if (ws.readyState === ws.OPEN) ws.ping();
      else clearInterval(hb);
    }, 20000);

    ws.on('close', () => clearInterval(hb));
  });

  ws.on('close', () => {
    relayWs = null;
    console.log('[relay] disconnected — retrying in 5 s');
    relayRetryTimer = setTimeout(connectRelay, 5000);
  });
  ws.on('error', () => ws.terminate());
}

connectRelay();

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
  if (relayWs && relayWs.readyState === 1) relayWs.send(msg);
}

function broadcastAudio(data, senderWs) {
  for (const client of wss.clients) {
    if (client !== senderWs && client.readyState === 1) client.send(data, { binary: true });
  }
  if (relayWs && relayWs.readyState === 1) relayWs.send(data, { binary: true });
}

// ---------------------------------------------------------------------------
// OSC UDP listener.
// ---------------------------------------------------------------------------
const udp = new osc.UDPPort({
  localAddress: OSC_HOST,
  localPort: OSC_PORT,
  metadata: false,
});

udp.on('ready', () => {
  console.log(`[osc] listening on udp://${OSC_HOST}:${OSC_PORT}`);
});

udp.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[osc] UDP port ${OSC_PORT} is already in use. Stop the other listener ` +
        `or set OSC_PORT in .env to a free port.`,
    );
  } else {
    console.error('[osc] error:', err.message);
  }
});

function fieldFromAddress(address) {
  if (!address || address[0] !== '/') return null;
  const name = address.slice(1).toLowerCase();
  return TRACKED_FIELDS.includes(name) ? name : null;
}

udp.on('message', (oscMsg) => {
  const field = fieldFromAddress(oscMsg.address);
  if (!field) return;
  const raw = Array.isArray(oscMsg.args) ? oscMsg.args[0] : oscMsg.args;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(value)) return;

  const now = Date.now();
  latest[field] = value;
  latest.ts = now;

  broadcast({ type: 'sample', field, value, ts: now });

  if (recording.active) {
    try {
      const point = new Point(INFLUX_MEASUREMENT)
        .tag('session', recording.session)
        .tag('field', field)
        .floatField('value', value)
        .timestamp(now);
      getWriteApi().writePoint(point);
      recording.pointsWritten += 1;
    } catch (err) {
      recording.lastError = err.message;
      console.error('[influx] write error:', err.message);
    }
  }
});

udp.open();

// ---------------------------------------------------------------------------
// Start HTTP server + graceful shutdown.
// ---------------------------------------------------------------------------
server.listen(HTTP_PORT, () => {
  // Print every non-loopback IPv4 so the phone URL is immediately visible.
  const { networkInterfaces } = require('os');
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .map(i => `  http://${i.address}:${HTTP_PORT}`);
  console.log(`[http] listening on port ${HTTP_PORT}`);
  if (addrs.length) {
    console.log('[http] open on this device or from your phone:');
    addrs.forEach(a => console.log(a));
  } else {
    console.log(`[http] http://127.0.0.1:${HTTP_PORT} (no LAN interfaces found yet)`);
  }
  if (!INFLUX_TOKEN || !INFLUX_ORG) {
    console.warn(
      '[influx] not configured — recording is disabled until INFLUX_TOKEN ' +
        'and INFLUX_ORG are set in .env',
    );
  } else {
    console.log(`[influx] target ${INFLUX_URL} org=${INFLUX_ORG} bucket=${INFLUX_BUCKET}`);
  }
});

async function shutdown(signal) {
  console.log(`\n[${signal}] shutting down...`);
  try {
    udp.close();
  } catch (_) {}
  await flushAndCloseWriteApi();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
