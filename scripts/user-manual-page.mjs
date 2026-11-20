// The user manual's interactive layer, inlined into user-manual.html by user-manual-html.mjs on
// top of the guides' own styles and script (entities.html). Plain CSS and ES5-style JS, no
// dependencies; everything works without storage (a private window, a blocked or file:// page).

export const MANUAL_CSS = String.raw`
:root {
  --role-operator: #3a4cc0; --role-operator-tint: #eceffd;
  --role-provider: #0a7569; --role-provider-tint: #e2f3f0;
  --role-consumer: #8a3f9e; --role-consumer-tint: #f5e9f8;
  --role-server: #586575; --role-server-tint: #edf0f4;
  --spot: #d4237a; --spot-ink: #ffffff; --flash: #fff4c2;
  --shot-shadow: 0 1px 2px rgba(21, 32, 43, .08), 0 8px 24px rgba(21, 32, 43, .08);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --role-operator: #95a3f7; --role-operator-tint: #1b2142;
    --role-provider: #52cfbd; --role-provider-tint: #0d2925;
    --role-consumer: #e3a3f2; --role-consumer-tint: #2c1733;
    --role-server: #9ba8b6; --role-server-tint: #1c2530;
    --spot: #ff6fb1; --spot-ink: #1a0a12; --flash: #3a3110;
    --shot-shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .35);
  }
}
:root[data-theme="dark"] {
  --role-operator: #95a3f7; --role-operator-tint: #1b2142;
  --role-provider: #52cfbd; --role-provider-tint: #0d2925;
  --role-consumer: #e3a3f2; --role-consumer-tint: #2c1733;
  --role-server: #9ba8b6; --role-server-tint: #1c2530;
  --spot: #ff6fb1; --spot-ink: #1a0a12; --flash: #3a3110;
  --shot-shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .35);
}

/* Role chips: one hue per role, everywhere (journey map, section heads, filter). */
.role-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.role-chip { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .78rem; font-weight: 600; letter-spacing: .01em; border: 1px solid currentColor; }
.role-chip.role-operator { color: var(--role-operator); background: var(--role-operator-tint); }
.role-chip.role-provider { color: var(--role-provider); background: var(--role-provider-tint); }
.role-chip.role-consumer { color: var(--role-consumer); background: var(--role-consumer-tint); }
.role-chip.role-server { color: var(--role-server); background: var(--role-server-tint); }

/* Tools: who am I, search. */
.manual-tools { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 18rem); gap: 14px 24px; align-items: end; padding: 16px 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.role-filter { border: 0; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.role-filter legend { font-family: var(--font-display); font-weight: 600; margin-bottom: 8px; padding: 0; }
.role-filter label { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; cursor: pointer; font-size: .9rem; background: var(--bg); }
.role-filter label:has(input:checked) { border-color: var(--gov); background: var(--gov-tint); font-weight: 600; }
.role-filter input { accent-color: var(--gov); margin: 0; }
.manual-search label { display: block; font-family: var(--font-display); font-weight: 600; margin-bottom: 6px; }
.manual-search input { width: 100%; box-sizing: border-box; padding: 8px 12px; font: inherit; color: var(--ink); background: var(--bg); border: 1px solid var(--muted); border-radius: 8px; }
.search-status { grid-column: 1 / -1; margin: 0; min-height: 1.2em; font-size: .9rem; color: var(--muted); }
.search-status:empty { display: none; }

/* The journey map: the walkthrough on one card. */
.journey-map { padding: 18px 20px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.journey-map h2 { margin: 0 0 12px; font-size: 1.15rem; }
.journey { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 10px; }
.journey li { display: grid; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--bg); }
.journey li a { color: var(--ink); text-decoration: none; font-weight: 600; display: flex; gap: 8px; align-items: baseline; }
.journey li a:hover, .journey li a:focus-visible { text-decoration: underline; }
.journey .num { display: inline-grid; place-items: center; min-width: 1.6rem; height: 1.6rem; border-radius: 50%; background: var(--gov); color: var(--surface); font-size: .8rem; font-family: var(--font-display); }
.journey .and-mark { font-size: .75rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); font-weight: 600; }
.journey li[data-dimmed] { border-style: dashed; }
.journey li[data-dimmed] a { color: var(--muted); font-weight: 500; }

/* Sections. */
.manual-section { scroll-margin-top: 84px; }
.manual-section[hidden], .manual-section tr[hidden] { display: none !important; }
.section-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }
.section-head h2 { margin: 0; flex: 1 1 100%; }
.copy-link { margin-left: 6px; padding: 0 6px; border: 0; background: none; font: inherit; font-size: .8em; color: var(--muted); cursor: pointer; border-radius: 6px; vertical-align: middle; }
.copy-link:hover, .copy-link:focus-visible { color: var(--gov); background: var(--gov-tint); }
.done { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; font-size: .88rem; cursor: pointer; }
.done:has(input:checked) { border-color: var(--ok); background: var(--ok-tint); color: var(--ok); font-weight: 600; }
.done input { accent-color: var(--ok); margin: 0; }
.manual-section[data-dimmed] h2, .manual-section[data-dimmed] h3 { color: var(--muted); }
.manual-section[data-dimmed] .shot img { filter: grayscale(1); opacity: .55; }
.manual-section[data-dimmed] .shot-frame { box-shadow: none; }
ol.steps > li[id] { scroll-margin-top: 96px; border-radius: 8px; transition: background-color .6s; }
ol.steps > li.flash { background: var(--flash); outline: 2px solid var(--spot); outline-offset: 4px; }
ol.steps > li:focus { outline: 2px solid var(--spot); outline-offset: 4px; }

/* Screenshots with numbered hotspots (buttons over a clean image). */
.shot { margin: 4px 0 0; display: grid; gap: 8px; max-width: 100%; }
.shot-frame { position: relative; justify-self: start; max-width: 100%; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); box-shadow: var(--shot-shadow); }
.shot-open { display: block; padding: 0; margin: 0; border: 0; background: none; cursor: zoom-in; border-radius: 10px; overflow: hidden; }
.shot-open img { display: block; max-width: 100%; height: auto; }
.shot-open:focus-visible { outline: 3px solid var(--gov); outline-offset: 3px; }
.hotspot { position: absolute; padding: 0; margin: 0; border: 2px solid var(--spot); border-radius: 6px; background: transparent; cursor: pointer; box-shadow: 0 0 0 2px rgba(255, 255, 255, .7); }
.hotspot span { position: absolute; top: -13px; left: -13px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--spot); color: var(--spot-ink); font: 700 .78rem/1 var(--font-display); box-shadow: 0 1px 3px rgba(0, 0, 0, .3); }
.hotspot:hover, .hotspot:focus-visible { background: rgba(212, 35, 122, .12); outline: 3px solid var(--gov); outline-offset: 2px; }
.shot figcaption { font-size: .9rem; color: var(--muted); max-width: 80ch; }
@media (max-width: 640px) {
  .hotspot span { width: 18px; height: 18px; top: -9px; left: -9px; font-size: .65rem; }
  .manual-tools { grid-template-columns: minmax(0, 1fr); }
}

/* Lightbox. */
.shot-dialog { width: min(96vw, 1500px); max-height: 94vh; padding: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); }
.shot-dialog::backdrop { background: rgba(10, 14, 20, .72); }
.shot-dialog-bar { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 12px; padding: 10px 14px; background: var(--surface); border-bottom: 1px solid var(--line); }
.shot-dialog-bar p { margin: 0; flex: 1; font-weight: 600; }
.shot-dialog-close { padding: 6px 14px; border: 1px solid var(--muted); border-radius: 8px; background: var(--bg); color: var(--ink); font: inherit; cursor: pointer; }
.shot-dialog-body { padding: 18px; }
.shot-dialog-body .shot-frame { margin: 0 auto; }
.shot-dialog-body img { display: block; max-width: 100%; height: auto; border-radius: 10px; }

/* Tabs per operating system. */
.tabs { display: grid; grid-template-columns: minmax(0, 1fr); gap: 0; }
.tabs [role="tablist"] { display: flex; flex-wrap: wrap; gap: 4px; }
.tabs [role="tab"] { padding: 6px 12px; border: 1px solid var(--line); border-bottom: 0; border-radius: 8px 8px 0 0; background: var(--bg); color: var(--muted); font: inherit; font-size: .88rem; cursor: pointer; }
.tabs [role="tab"][aria-selected="true"] { background: var(--code-bg); color: var(--ink); font-weight: 600; }
.tabs [role="tab"]:focus-visible { outline: 3px solid var(--gov); outline-offset: 1px; }
.tabs [role="tabpanel"] .code { border-top-left-radius: 0; }

/* Progress in the contents rail. */
.manual-progress { display: grid; gap: 6px; margin-bottom: 14px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
.toc .manual-progress p { margin: 0; text-transform: none; letter-spacing: 0; font-size: .88rem; color: var(--ink); font-weight: 600; }
.reset-progress { justify-self: start; padding: 2px 8px; border: 1px solid var(--line); border-radius: 6px; background: none; color: var(--muted); font: inherit; font-size: .8rem; cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
  ol.steps > li[id] { transition: none; }
}

@media print {
  .topbar, .toc, .toc-mobile, .manual-tools, .copy-link, .done, .manual-progress, .shot-dialog, .copy { display: none !important; }
  .shell { display: block; }
  .manual-section[data-dimmed] h2, .manual-section[data-dimmed] h3 { color: inherit; }
  .manual-section[data-dimmed] .shot img { filter: none; opacity: 1; }
  .manual-section, .journey li { opacity: 1 !important; }
  .manual-section[hidden], ol.steps > li[hidden], tr[hidden] { display: revert !important; }
  .tabs [role="tablist"] { display: none; }
  .tabs [role="tabpanel"][hidden] { display: block !important; }
  .tabs [role="tabpanel"]::before { content: attr(data-print-label); display: block; font-weight: 600; margin: 8px 0 4px; }
  .shot, .shot-frame { break-inside: avoid; box-shadow: none; }
  .hotspot { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;

export const MANUAL_JS = String.raw`
(function () {
  var strings = JSON.parse(document.getElementById('manual-strings').textContent);
  var KEY = 'den-manual:';
  function load(k) { try { return window.localStorage.getItem(KEY + k); } catch (e) { return null; } }
  function save(k, v) { try { window.localStorage.setItem(KEY + k, v); } catch (e) {} }
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var status = document.querySelector('.search-status');
  function say(text) { if (status) status.textContent = text; }
  function byHash(hash) { return document.getElementById(decodeURIComponent(hash.replace(/^#/, ''))); }
  var sections = Array.prototype.slice.call(document.querySelectorAll('.manual-section'));
  var journey = Array.prototype.slice.call(document.querySelectorAll('.journey li'));
  function rolesOf(el) { return (el.getAttribute('data-roles') || '').split(' ').filter(Boolean); }

  // Who am I: the other roles' steps are dimmed, never hidden (it is one journey).
  function applyRole(role) {
    sections.concat(journey).forEach(function (el) {
      var roles = rolesOf(el);
      var mine = role === 'all' || !roles.length || roles.indexOf(role) >= 0 ||
        (role === 'operator' && roles.indexOf('server') >= 0);
      if (mine) el.removeAttribute('data-dimmed'); else el.setAttribute('data-dimmed', '');
    });
  }
  var radios = Array.prototype.slice.call(document.querySelectorAll('input[name="manual-role"]'));
  var savedRole = load('role') || 'all';
  radios.forEach(function (r) {
    if (r.value === savedRole) r.checked = true;
    r.addEventListener('change', function () { if (r.checked) { applyRole(r.value); save('role', r.value); } });
  });
  applyRole(savedRole);

  // Progress: a "Done" per step, counted in the contents rail.
  var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-done]'));
  var progress = document.querySelector('[data-progress]');
  var done = [];
  try { done = JSON.parse(load('done') || '[]'); } catch (e) { done = []; }
  function count() {
    var n = boxes.filter(function (b) { return b.checked; }).length;
    if (progress) progress.textContent = strings.progress.replace('{done}', n).replace('{total}', strings.total);
  }
  function remember() {
    save('done', JSON.stringify(boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.getAttribute('data-done'); })));
  }
  boxes.forEach(function (b) {
    b.checked = done.indexOf(b.getAttribute('data-done')) >= 0;
    b.addEventListener('change', function () { count(); remember(); });
  });
  var reset = document.querySelector('[data-reset-progress]');
  if (reset) reset.addEventListener('click', function () { boxes.forEach(function (b) { b.checked = false; }); count(); remember(); });
  count();

  // Hotspots: a numbered box on a screenshot leads to its sub-step in the text.
  function goTo(hash) {
    var item = byHash(hash);
    if (!item) return;
    item.setAttribute('tabindex', '-1');
    item.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
    item.focus({ preventScroll: true });
    item.classList.add('flash');
    setTimeout(function () { item.classList.remove('flash'); }, 2000);
  }
  var dialog = document.querySelector('.shot-dialog');
  var opener = null;
  var returnFocus = true;
  document.addEventListener('click', function (event) {
    var spot = event.target.closest && event.target.closest('.hotspot');
    if (spot) {
      event.preventDefault();
      if (dialog && dialog.open) { returnFocus = false; dialog.close(); }
      goTo(spot.getAttribute('data-target'));
      return;
    }
    var open = event.target.closest && event.target.closest('.shot-open');
    if (open && dialog && !dialog.contains(open)) {
      var figure = open.closest('.shot');
      var frame = figure.querySelector('.shot-frame').cloneNode(true);
      var inner = frame.querySelector('.shot-open');
      var img = inner.querySelector('img');
      img.removeAttribute('loading');
      inner.parentNode.replaceChild(img, inner);
      var body = dialog.querySelector('.shot-dialog-body');
      body.replaceChildren(frame);
      var caption = figure.querySelector('figcaption');
      dialog.querySelector('#shot-dialog-title').textContent = caption ? caption.textContent : img.alt;
      opener = open;
      returnFocus = true;
      dialog.showModal();
      return;
    }
    var link = event.target.closest && event.target.closest('[data-copy-link]');
    if (link) {
      var url = location.href.split('#')[0] + link.getAttribute('data-copy-link');
      try { if (navigator.clipboard) navigator.clipboard.writeText(url).catch(function () {}); } catch (e) {}
      say(strings.copied);
    }
  });
  if (dialog) {
    dialog.querySelector('.shot-dialog-close').addEventListener('click', function () { dialog.close(); });
    dialog.addEventListener('close', function () { if (returnFocus && opener) opener.focus(); });
  }

  // Tabs per operating system: arrow keys move, the chosen label applies to every group.
  var groups = Array.prototype.slice.call(document.querySelectorAll('[data-tabs]'));
  function select(group, index, focus) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (tab, i) {
      var on = i === index;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      var panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (focus) tabs[index].focus();
  }
  function selectLabel(label) {
    groups.forEach(function (group) {
      var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
      var i = tabs.map(function (t) { return t.getAttribute('data-label'); }).indexOf(label);
      if (i >= 0) select(group, i, false);
    });
  }
  groups.forEach(function (group) {
    var tabs = Array.prototype.slice.call(group.querySelectorAll('[role="tab"]'));
    tabs.forEach(function (tab, i) {
      var panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.setAttribute('data-print-label', tab.getAttribute('data-label'));
      tab.addEventListener('click', function () { selectLabel(tab.getAttribute('data-label')); save('tab', tab.getAttribute('data-label')); });
      tab.addEventListener('keydown', function (e) {
        var next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[e.key];
        if (next === undefined) return;
        e.preventDefault();
        next = (next + tabs.length) % tabs.length;
        select(group, next, true);
        selectLabel(tabs[next].getAttribute('data-label'));
        save('tab', tabs[next].getAttribute('data-label'));
      });
    });
  });
  var savedTab = load('tab');
  if (savedTab) selectLabel(savedTab);

  // Search: keeps the sections (and table rows) that mention the words.
  // Accent-insensitive: "atencion" finds "Atención".
  function fold(s) { return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  var search = document.getElementById('manual-search');
  if (search) search.addEventListener('input', function () {
    var q = fold(search.value.trim());
    var shown = 0;
    sections.forEach(function (s) {
      var rows = Array.prototype.slice.call(s.querySelectorAll('tbody tr'));
      rows.forEach(function (r) { r.hidden = false; });
      if (!q) { s.hidden = false; return; }
      var match = fold(s.textContent).indexOf(q) >= 0;
      s.hidden = !match;
      if (match) {
        shown += 1;
        var hits = rows.filter(function (r) { return fold(r.textContent).indexOf(q) >= 0; });
        if (hits.length) rows.forEach(function (r) { r.hidden = hits.indexOf(r) < 0; });
      }
    });
    say(!q ? '' : shown ? strings.results.replace('{count}', shown) : strings.noResults);
  });
})();
`;
