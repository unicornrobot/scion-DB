// Shared mode-switcher nav — drop `<div data-scion-nav data-page="chart|dashboard|viz"></div>`
// into any page's chrome and this renders identical, self-highlighting tabs into it.
// Colors are inherited via each page's own --accent/--border/--fg/--muted variables,
// so the tabs automatically match whichever theme the host page already uses.
(function () {
  const PAGES = [
    { id: 'chart',     label: 'Chart',      href: '/' },
    { id: 'dashboard', label: 'Dashboard',  href: '/dashboard' },
    { id: 'viz',       label: 'Visualizer', href: '/viz' },
  ];

  const style = document.createElement('style');
  style.textContent = `
    .scion-nav { display: flex; gap: 6px; }
    .scion-nav a {
      padding: 5px 11px; border-radius: 6px;
      font: 12px/1 -apple-system,"Segoe UI",system-ui,sans-serif;
      text-decoration: none; white-space: nowrap;
      color: var(--muted); border: 1px solid var(--border);
      transition: color .15s, border-color .15s, background .15s;
    }
    .scion-nav a:hover { color: var(--fg); border-color: var(--muted); }
    .scion-nav a.active {
      background: var(--accent); border-color: var(--accent);
      color: #08161d; font-weight: 600;
    }
  `;
  document.head.appendChild(style);

  function render(mount) {
    const current = mount.dataset.page;
    mount.classList.add('scion-nav');
    mount.innerHTML = PAGES.map(p =>
      `<a href="${p.href}"${p.id === current ? ' class="active"' : ''}>${p.label}</a>`
    ).join('');
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-scion-nav]').forEach(render);
  });
})();
