// Synthetic OSC sender for smoke-testing without the real Pocket Scion device.
// Usage: PORT=11045 node tools/synth-osc.js
const osc = require('osc');

const PORT = parseInt(process.env.PORT || '11045', 10);
const HOST = process.env.HOST || '127.0.0.1';
const RATE_HZ = parseFloat(process.env.RATE_HZ || '10');

const udp = new osc.UDPPort({
  localAddress: '0.0.0.0',
  localPort: 0,
  remoteAddress: HOST,
  remotePort: PORT,
  metadata: false,
});

udp.on('ready', () => {
  console.log(`[synth] sending OSC to ${HOST}:${PORT} at ${RATE_HZ} Hz`);
  let t = 0;
  setInterval(() => {
    t += 1 / RATE_HZ;
    const base = Math.sin(t * 0.7) * 50 + 100;
    const noise = () => (Math.random() - 0.5) * 8;
    const samples = Array.from({ length: 50 }, () => base + noise());
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    const delta = max - min;
    const variance =
      samples.reduce((s, v) => s + (v - mean) ** 2, 0) / samples.length;
    const deviation = Math.sqrt(variance);

    const send = (addr, v) =>
      udp.send({ address: addr, args: [{ type: 'f', value: v }] });
    send('/min', min);
    send('/max', max);
    send('/mean', mean);
    send('/delta', delta);
    send('/variance', variance);
    send('/deviation', deviation);
  }, 1000 / RATE_HZ);
});

udp.on('error', (err) => console.error('[synth] error:', err.message));
udp.open();
