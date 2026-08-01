// Shared dark/light theme for Chart / Viz / Dashboard.
//
// Applies data-theme="light"|"dark" on <html>, persisted to localStorage;
// falls back to the OS/browser's prefers-color-scheme when the user hasn't
// chosen explicitly, and keeps following it live until they do. Runs
// synchronously, before shared.css is linked, so the correct theme is
// already set by the time styles apply — no flash of the wrong theme.
//
// Dispatches `scion-theme-change` on <html> so pages that draw with an
// actual color value rather than a CSS var (Chart.js, canvas visualizers)
// can react and redraw.
(function () {
  const KEY = 'scion-theme';

  function preferredTheme() {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }

  function apply(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.dispatchEvent(
      new CustomEvent('scion-theme-change', { detail: { theme } })
    );
    document.querySelectorAll('.scion-theme-toggle').forEach(updateBtn);
  }

  function current() {
    return document.documentElement.getAttribute('data-theme') || 'dark';
  }

  function setTheme(theme) {
    try { localStorage.setItem(KEY, theme); } catch (_) {}
    apply(theme);
  }

  function toggle() {
    setTheme(current() === 'light' ? 'dark' : 'light');
  }

  function updateBtn(btn) {
    const light = current() === 'light';
    btn.textContent = light ? '☾' : '☀';
    btn.title = light ? 'Switch to dark mode' : 'Switch to light mode';
  }

  // Apply immediately (before shared.css is even requested by the browser).
  apply(preferredTheme());

  // Keep following the OS setting live, but only until the user picks one
  // explicitly for themselves.
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', (e) => {
    if (!localStorage.getItem(KEY)) apply(e.matches ? 'light' : 'dark');
  });

  window.ScionTheme = {
    toggle,
    setTheme,
    current,
    // Mounts a small icon toggle button into `container`. Called by nav.js
    // so the same control appears identically on every page.
    mount(container) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'scion-theme-toggle';
      btn.addEventListener('click', toggle);
      updateBtn(btn);
      container.appendChild(btn);
      return btn;
    },
  };
})();
