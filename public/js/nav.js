// Shared mode-switcher nav — drop `<div data-scion-nav data-page="chart|dashboard|viz"></div>`
// into any page's chrome. Renders the top pill-tabs into that mount, plus a
// fixed bottom tab bar (shown only on narrow viewports — see /css/shared.css)
// appended once to <body>. Styling lives in shared.css so both match
// whichever theme vars the host page defines.
(function () {
  const PAGES = [
    { id: 'chart',     label: 'Chart',      href: '/',          icon: '📈' },
    { id: 'dashboard', label: 'Dashboard',  href: '/dashboard', icon: '▦' },
    { id: 'viz',       label: 'Visualizer', href: '/viz',       icon: '✦' },
  ];

  function renderPills(mount) {
    const current = mount.dataset.page;
    mount.classList.add('scion-nav');
    mount.innerHTML = PAGES.map(p =>
      `<a href="${p.href}"${p.id === current ? ' class="active"' : ''}>${p.label}</a>`
    ).join('');
    if (window.ScionTheme) window.ScionTheme.mount(mount);
  }

  function renderTabbar(current) {
    if (document.querySelector('.scion-tabbar')) return;
    const bar = document.createElement('nav');
    bar.className = 'scion-tabbar';
    const inner = document.createElement('div');
    inner.className = 'scion-tabbar__inner';
    inner.innerHTML = PAGES.map(p =>
      `<a href="${p.href}"${p.id === current ? ' class="active"' : ''}>` +
        `<span class="icon">${p.icon}</span><span>${p.label}</span></a>`
    ).join('');
    bar.appendChild(inner);
    document.body.appendChild(bar);
    if (window.ScionTheme) window.ScionTheme.mount(inner);
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Embedded views (dashboard's live-pane iframe) show bare content only —
    // no nav chrome at any viewport size.
    if (new URLSearchParams(location.search).has('embed')) return;

    const mounts = document.querySelectorAll('[data-scion-nav]');
    mounts.forEach(renderPills);
    if (mounts.length) renderTabbar(mounts[0].dataset.page);
  });
})();
