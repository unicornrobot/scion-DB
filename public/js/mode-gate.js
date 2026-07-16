// Hides admin-only elements when the page is served by the public relay
// (relay.js sets isRelay:true on its WS `hello`; server.js never does).
function gateForConsumer(ids) {
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
}
