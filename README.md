# Scion DB

Live OSC data recorder, visualiser, and cloud relay for the **Pocket Scion** device.
The Pocket SCÍON is a portable, battery-powered biofeedback instrument developed by Instruō in collaboration with ecologist and musician Tarun Nayar (Modern Biology).  It captures electrical signals from living organisms, such as plants, fungi, or human skin, and translates them into evolving soundscapes and musical notes.

The Pocket Scion streams real-time statistical analysis of the signal as OSC UDP messages — six fields (`/min`, `/max`, `/mean`, `/delta`, `/variance`, `/deviation`) at up to 30 Hz. This application receives those messages, displays them as a live chart and generative geometry visualiser, records sessions to InfluxDB, and optionally relays the live data stream to any browser on the internet.

**[► View live](https://web-production-cb3c4.up.railway.app/viz)**

---

## Screenshots

<table>
  <tr>
    <td><img src="screenshots/Screenshot%202026-05-31%20182854.png" alt="Aurora palette — rings and lines mode" width="360"/></td>
    <td><img src="screenshots/Screenshot%202026-06-01%20090928.png" alt="Solar palette — points mode with prominent spikes" width="360"/></td>
  </tr>
  <tr>
    <td><img src="screenshots/Screenshot%202026-06-02%20181533.png" alt="Prism palette — lines mode, multiple layered rings" width="360"/></td>
    <td><img src="screenshots/Screenshot%202026-06-02%20190508.png" alt="Solar palette — points only, rings hidden" width="360"/></td>
  </tr>
</table>

---

## Architecture

```
Pocket Scion (UDP/OSC)
        │
        ▼
  server.js  ──── WebSocket /ws ────▶  Local browsers
  (local)                               localhost:3000
        │
        │  WebSocket (publisher)
        ▼
  relay.js  ─────────────────────────▶  Remote browsers worldwide
  (Railway)      WebSocket /ws           your-relay.up.railway.app/viz
```

---

## Features

- **Live chart** — rolling time-series of all six fields with toggleable series, spike filtering, and configurable time window
- **Three live visualisers** — switchable from the sidebar:
  - **Spiral** — change-driven Archimedean spiral with radial spark lines scaled to data amplitude
  - **Plant Signal** — a generative curved plant with electrical action-potential pulses travelling from the root out through every branch and leaf
  - **Mycelium** — a Physarum (slime-mould) agent simulation that self-organises into glowing flow networks
- **Session recording** — writes to InfluxDB v2 with per-session tagging; playback in the chart view
- **Cloud relay** — thin WebSocket fan-out server; deploy once to Railway, share a URL with anyone

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 18 or newer | |
| npm | 9 or newer | bundled with Node |
| InfluxDB v2 | 2.x | optional — only needed for recording |
| A Railway account | — | optional — only needed for cloud relay |

---

## Local setup (Linux)

### 1. Install Node.js

```bash
# Using NodeSource (recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node -v   # should print v20.x.x or newer
npm -v
```

### 2. Clone and install dependencies

```bash
git clone https://github.com/YOUR_USERNAME/scion-DB.git
cd scion-DB
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
nano .env          # or use any editor
```

At minimum set `OSC_PORT` to match what your Pocket Scion device is sending to. All other values have sensible defaults. Leave `RELAY_URL` and `PUB_SECRET` blank until you set up the cloud relay.

### 4. Start

```bash
npm start
```

Open **http://localhost:3000** for the live chart, or **http://localhost:3000/viz** for the geometry visualiser.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `OSC_HOST` | `0.0.0.0` | UDP bind address for incoming OSC |
| `OSC_PORT` | `11046` | UDP port the Pocket Scion sends to |
| `HTTP_PORT` | `3000` | HTTP / WebSocket server port |
| `INFLUX_URL` | `http://127.0.0.1:8086` | InfluxDB v2 base URL |
| `INFLUX_TOKEN` | — | InfluxDB API token (required to record) |
| `INFLUX_ORG` | — | InfluxDB organisation name |
| `INFLUX_BUCKET` | `scion` | Bucket to write into |
| `INFLUX_MEASUREMENT` | `scion_stats` | Measurement name |
| `RELAY_URL` | — | `wss://` URL of your deployed relay (optional) |
| `PUB_SECRET` | — | Shared secret authenticating the publisher to the relay |

---

## InfluxDB setup (optional)

Recording sessions to InfluxDB is optional. The live chart and visualiser work without it.

### Install InfluxDB v2 on Linux

```bash
# Download and install
wget https://dl.influxdata.com/influxdb/releases/influxdb2-2.7.6_linux_amd64.tar.gz
tar xvzf influxdb2-2.7.6_linux_amd64.tar.gz
sudo cp influxdb2-2.7.6/usr/bin/influx* /usr/local/bin/

# Or via apt
curl https://repos.influxdata.com/influxdb.key | sudo apt-key add -
echo "deb https://repos.influxdata.com/ubuntu focal stable" | sudo tee /etc/apt/sources.list.d/influxdb.list
sudo apt-get update && sudo apt-get install influxdb2
sudo systemctl start influxdb
```

### Initial InfluxDB configuration

Navigate to **http://localhost:8086** and complete the setup wizard, or use the CLI:

```bash
influx setup \
  --username admin \
  --password yourpassword \
  --org your-org \
  --bucket scion \
  --force
```

Then create an API token with write access to the `scion` bucket and copy it into `INFLUX_TOKEN` in your `.env`.

### Data schema

Each recorded sample is written as:

```
measurement: scion_stats
tags:        session=<name>  field=<min|max|mean|delta|variance|deviation>
fields:      value=<float>
timestamp:   milliseconds
```

Example Flux query to retrieve a session:

```flux
from(bucket: "scion")
  |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "scion_stats")
  |> filter(fn: (r) => r.session == "my-session")
  |> pivot(rowKey:["_time"], columnKey:["field"], valueColumn:"_value")
```

---

## Cloud relay setup

The relay allows anyone to watch the live data stream in their browser without needing access to your local machine. `relay.js` is a thin WebSocket fan-out server — your local `server.js` connects to it as a publisher; viewers connect as subscribers.

### 1. Deploy relay.js to Railway

1. Push the repo to GitHub (the `Procfile` tells Railway to run `node relay.js`)
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select this repository
4. In **Variables**, add:
   ```
   PUB_SECRET = your-chosen-secret
   ```
   Railway sets `PORT` automatically — do not add it manually.
5. Go to **Settings → Networking → Generate Domain**
   You will get a URL like `https://scion-relay-production.up.railway.app`

### 2. Configure your local `.env`

```
RELAY_URL=wss://scion-relay-production.up.railway.app/ws
PUB_SECRET="your-chosen-secret"
```

The value of `PUB_SECRET` must be identical on both sides. Use quotes consistently — if you type `"my-secret"` (with quotes) in Railway's dashboard, use `PUB_SECRET="my-secret"` in your `.env` as well.

### 3. Restart your local server

```bash
npm start
```

You should see `[relay] connected to wss://...` in the terminal.

### 4. Share the URL

Send `https://your-relay.up.railway.app/viz` to anyone — they will see the Spiral visualiser receiving your live data.

### Relay diagnostics

| Endpoint | Method | Description |
|---|---|---|
| `/relay-status` | GET | Publisher connection state, viewer count, cached field values |
| `/relay-reset` | POST | Clears cached latest values. Requires `x-pub-secret` header |

```bash
# Check status
curl https://your-relay.up.railway.app/relay-status

# Clear stale cached values
curl -X POST https://your-relay.up.railway.app/relay-reset \
  -H "x-pub-secret: your-chosen-secret"
```

---

## Visualisers

Pick a visualiser from the **Visualizer** dropdown in the sidebar. Each has its own settings panel below the picker, and all settings persist in `localStorage`.

All three share the same change-detection model: an EMA of the watched field's per-frame change is normalised against a self-calibrating running peak, giving a scale-independent **activity** value (0–1) that is compared against the **Sensitivity** threshold. This adapts automatically as the signal's range shifts between sessions.

### Spiral (default at `/viz`)

An Archimedean spiral drawn outward from the centre. The spiral only advances while the watched field is actively changing; when the signal is still, the drawing freezes. When the spiral reaches the canvas edge it wraps back to the centre, layering new rings over old ones. The palette randomises on each edge wrap.

| Setting | Description |
|---|---|
| Watch field | Which of the six fields gates spiral movement |
| Sensitivity | Normalised activity threshold required to trigger movement |
| Palette | Colour range mapped from low → high intensity |
| Show rings | Toggle the arc path of the spiral |
| Spark style | Lines or dots at each data point |
| Point style | Fill or stroke (points style only) |
| Spark scale | Exaggeration multiplier for spark length |
| Spark field | Which field drives spark size |
| Clear trail | Wipe the canvas and restart from centre |

### Plant Signal

A generative plant — a curved, gravity-drooping stem with branching twigs and leaves — grown procedurally each time. When the watched field is active, electrical action-potential pulses are born at the root electrode and travel up the vascular network, splitting at every junction so the signal reaches every branch and leaf. Edges and leaves the signal touches light up and slowly fade, so activity ripples visibly across the whole plant. Stronger signals fire faster, denser pulse trains.

| Setting | Description |
|---|---|
| Watch field | Which field triggers new pulses |
| Sensitivity | Normalised activity threshold for firing |
| Pulse speed | Speed multiplier for travelling pulses |
| Palette | Pulse colour theme (Electric / Biolum / Fire / Neural) |
| Show plant | Toggle the dark plant structure behind the pulses |
| Regrow plant | Generate a fresh random plant structure |

### Mycelium

A multi-agent Physarum (slime-mould) chemotaxis simulation. Agents deposit a chemical trail and steer toward the strongest gradient, self-organising into branching flow networks reminiscent of mycelium or root systems. The trail diffuses and decays every frame; live data drives agent speed and deposit strength, so the network densifies when the signal is active and thins as it goes quiet.

| Setting | Description |
|---|---|
| Watch field | Which field drives overall activity |
| Sensitivity | Normalised activity threshold |
| Palette | Trail colour range (Biolum / Mycelium / Aurora / Void / Prism) |
| Decay | Per-frame trail fade rate — low accumulates, high stays ephemeral |
| Agents | Agent count (Low 400 / Medium 1200 / High 2400) |
| Clear & reset | Wipe the trail and re-scatter agents |

---

## Live chart (`/`)

- **Series toggles** — enable/disable individual fields; state persists across reloads
- **Window** — rolling time window in seconds
- **Record / Stop** — writes current session to InfluxDB
- **Playback** — click any recorded session to replay it in the chart

---

## REST API

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/status` | — | Latest values, OSC config, recording state |
| POST | `/api/record/start` | `{ "session": "name" }` | 409 if already recording |
| POST | `/api/record/stop` | — | Flushes pending InfluxDB writes |
| GET | `/api/sessions` | — | List of recorded sessions |
| GET | `/api/sessions/:name` | — | Session data as `{ field: [{x,y}] }` |

WebSocket at `/ws` pushes:

```json
{ "type": "sample",    "field": "mean", "value": 0.42, "ts": 1717286400000 }
{ "type": "hello",     "latest": { ... }, "recording": { ... } }
{ "type": "recording", "recording": { "active": true, "session": "...", ... } }
```

---

## Smoke testing without the device

Send synthetic OSC data using the bundled generator:

```bash
# Terminal 1 — start the server
npm start

# Terminal 2 — send synthetic OSC at 10 Hz
npm run synth
```

If the default OSC port is already in use:

```bash
OSC_PORT=11047 npm start
PORT=11047 npm run synth
```

---

## Running as a service on Linux

To keep the server running after you close the terminal, use `systemd`:

```ini
# /etc/systemd/system/scion.service
[Unit]
Description=Scion DB
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/scion-DB
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/path/to/scion-DB/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now scion
sudo systemctl status scion
```
