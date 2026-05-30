require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const osc = require('osc');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const OSC_HOST = process.env.OSC_HOST || '0.0.0.0';
const OSC_PORT = parseInt(process.env.OSC_PORT || '11045', 10);
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);

const INFLUX_URL = process.env.INFLUX_URL || 'http://127.0.0.1:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || '';
const INFLUX_ORG = process.env.INFLUX_ORG || '';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'scion';
const INFLUX_MEASUREMENT = process.env.INFLUX_MEASUREMENT || 'scion_stats';

const TRACKED_FIELDS = ['min', 'max', 'mean', 'delta', 'variance', 'deviation'];

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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/viz', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'viz.html')));

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

    const sessions = Object.keys(startMap)
      .map((s) => ({
        session: s,
        startMs: startMap[s],
        endMs:   endMap[s]   ?? startMap[s],
        points:  countMap[s] ?? 0,
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
  console.log(`[record] start session=${session}`);
  broadcast({ type: 'recording', recording });
  res.json({ ok: true, recording });
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
});

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
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
  console.log(`[http] listening on http://127.0.0.1:${HTTP_PORT}`);
  console.log(`[http] open the URL above to view the live chart`);
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
