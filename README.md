# scion-DB

Live graphing + InfluxDB recorder for OSC stats from a Pocket Scion device.

The Pocket Scion sends OSC messages to `udp://127.0.0.1:11045` with addresses
`/min`, `/max`, `/mean`, `/delta`, `/variance`, `/deviation`. This app listens
for those messages, broadcasts them over WebSocket to a browser chart, and
optionally writes them to a local InfluxDB v2 bucket on Record / Stop.

## Setup

```bash
npm install
cp .env.example .env       # then fill in INFLUX_TOKEN / INFLUX_ORG
npm start
```

Open <http://127.0.0.1:3000>.

## Ports on this machine

When this project was scaffolded the local ports were:

| Port  | Service                                 |
|-------|-----------------------------------------|
| 8086  | InfluxDB v2.9.1 (this is the one we use) |
| 11045 | UDP — OSC port specified by the brief    |

If `OSC_PORT` is already bound by another process you'll see `EADDRINUSE` at
startup — either stop the other listener, or set `OSC_PORT` in `.env` and tell
Pocket Scion to send to the new port.

## InfluxDB

Uses InfluxDB v2's client library. Required env vars before recording works:

- `INFLUX_URL` (default `http://127.0.0.1:8086`)
- `INFLUX_TOKEN`
- `INFLUX_ORG`
- `INFLUX_BUCKET` (default `scion`)

Each recorded sample is written as:

```
measurement: scion_stats        (configurable via INFLUX_MEASUREMENT)
tags:        session=<name>, field=<min|max|mean|delta|variance|deviation>
fields:      value=<float>
time:        ms
```

Query a session in the Influx UI / Flux:

```flux
from(bucket: "scion")
  |> range(start: -1h)
  |> filter(fn: (r) => r._measurement == "scion_stats")
  |> filter(fn: (r) => r.session == "my-session-name")
  |> pivot(rowKey:["_time"], columnKey:["field"], valueColumn:"_value")
```

## Smoke-testing without the real device

In a second terminal:

```bash
OSC_PORT=11046 npm start              # avoid clash with the real source
PORT=11046 npm run synth              # synthetic OSC at 10 Hz
```

Or, if 11045 is free, just run `npm run synth` with defaults.

## REST API

| Method | Path                | Body                       | Notes                          |
|--------|---------------------|----------------------------|--------------------------------|
| GET    | `/api/status`       | —                          | Latest values + recording state |
| POST   | `/api/record/start` | `{ "session": "name?" }`   | 409 if already recording        |
| POST   | `/api/record/stop`  | —                          | Flushes pending writes          |

WebSocket at `/ws` pushes `{ type:"sample", field, value, ts }` per OSC message.
