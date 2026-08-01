// Shared fullscreen toggle — real Fullscreen API with iOS vendor-prefix
// fallback. Extracted from viz.html's original implementation so Chart and
// Dashboard can use the exact same behavior instead of ad-hoc CSS hacks.
function initFullscreen(btnEl, opts = {}) {
  const fsEl = opts.target || document.documentElement;

  const _requestFS = (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen ||
                      fsEl.mozRequestFullScreen || fsEl.msRequestFullscreen);
  const _exitFS    = (document.exitFullscreen || document.webkitExitFullscreen ||
                      document.mozCancelFullScreen || document.msExitFullscreen);
  const _isFS      = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const fsSupported = !!_requestFS;

  function applyFsIcon() {
    btnEl.textContent = _isFS() ? '⊡' : '⛶';
    btnEl.title       = _isFS() ? 'Exit fullscreen (F / Esc)' : 'Fullscreen (F)';
  }

  function toggle() {
    if (!fsSupported) return;
    if (_isFS()) {
      _exitFS.call(document);
    } else {
      _requestFS.call(fsEl).catch(() => {});
    }
  }

  btnEl.addEventListener('click', toggle);

  ['fullscreenchange', 'webkitfullscreenchange', 'mozfullscreenchange'].forEach(ev =>
    document.addEventListener(ev, () => {
      applyFsIcon();
      if (typeof opts.onChange === 'function') opts.onChange(_isFS());
    }));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'F' || e.key === 'f') {
      const t = e.target.tagName;
      if (t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT') toggle();
    }
  });

  // Hide the button entirely if the API isn't available (e.g. older iOS).
  if (!fsSupported) btnEl.style.display = 'none';
  applyFsIcon();

  return { toggle, isFullscreen: _isFS };
}
