#!/usr/bin/env node
// Builds the user manual's page (docs/guides/user-manual.html and docs/es/guides/user-manual.html)
// from its Markdown and the screenshots' manifest (img/user-manual/manifest.json, written by
// `pnpm docs:manual`). The <head>, styles, top bar and script come from entities.html of the same
// language, so every guide keeps one design; the manual adds its interactive layer
// (user-manual-page.mjs). Run it after editing user-manual.md:  pnpm docs:manual:html
//
// Markdown conventions on top of the guides' subset (scripts/lib/guide-md.mjs):
//   <!-- roles: operator,provider -->   after a "## " heading: who does the section (operator,
//                                       provider, consumer, server); <!-- and --> marks a section
//                                       done at the same time as the previous one
//   ![alt](img/user-manual/<id>.jpg "caption")   a screenshot; its numbered hotspots (from the
//                                       manifest) point at the items of the ordered list before it
//   > **Consejo:** / > **Tip:**         a tip box;  > **Atención:** / > **Attention:**  a warning
//   ```bash tab="Linux o macOS"         consecutive fenced blocks with tab="…" form one tab group
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks, code, escapeHtml, inline, slug } from './lib/guide-md.mjs';
import { MANUAL_CSS, MANUAL_JS } from './user-manual-page.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEXT = {
  es: {
    dir: 'docs/es/guides',
    title: 'Manual de usuario DEN',
    subtitle: '· manual de usuario',
    eyebrow: 'Manual de usuario · Paso a paso, con capturas',
    forWhom: '<b>Para</b> el operador, las entidades proveedoras y las consumidoras',
    version: '<b>Versión</b> 1.0 · noviembre 2026',
    other:
      '<a href="../../guides/user-manual.html" hreflang="en" lang="en">English version (official)</a>',
    contents: 'Contenido',
    intro: 'Valores de ejemplo',
    journey: 'El recorrido',
    and: 'y a la vez',
    copy: 'Copiar',
    copyLink: 'Copiar el enlace a',
    done: 'Hecho',
    enlarge: 'Ampliar la captura',
    close: 'Cerrar',
    tools: 'Herramientas del manual',
    who: '¿Quién eres?',
    everyone: 'Todos',
    search: 'Buscar en el manual',
    progress: '{done} de {total} pasos hechos',
    reset: 'Reiniciar el avance',
    noResults: 'No hay pasos que coincidan con la búsqueda.',
    results: '{count} pasos coinciden',
    copied: 'Enlace copiado',
    roles: {
      operator: 'Operador',
      provider: 'Entidad proveedora',
      consumer: 'Entidad consumidora',
      server: 'Servidor del portal',
    },
    callouts: { Consejo: 'tip', Atención: 'warn', Nota: 'note' },
    footer:
      'Generado desde <code>user-manual.md</code> con <code>scripts/user-manual-html.mjs</code>; las capturas salen del portal real con <code>pnpm docs:manual</code>.',
  },
  en: {
    dir: 'docs/guides',
    title: 'DEN user manual',
    subtitle: '· user manual',
    eyebrow: 'User manual · Step by step, with screenshots',
    forWhom: '<b>For</b> the operator, provider entities and consumer entities',
    version: '<b>Version</b> 1.0 · November 2026',
    other: '<a href="../es/guides/user-manual.html" hreflang="es" lang="es">Versión en español</a>',
    contents: 'Contents',
    intro: 'Example values',
    journey: 'The journey',
    and: 'and at the same time',
    copy: 'Copy',
    copyLink: 'Copy the link to',
    done: 'Done',
    enlarge: 'Enlarge the screenshot',
    close: 'Close',
    tools: 'Manual tools',
    who: 'Who are you?',
    everyone: 'Everyone',
    search: 'Search the manual',
    progress: '{done} of {total} steps done',
    reset: 'Reset progress',
    noResults: 'No step matches the search.',
    results: '{count} steps match',
    copied: 'Link copied',
    roles: {
      operator: 'Operator',
      provider: 'Provider entity',
      consumer: 'Consumer entity',
      server: 'Portal server',
    },
    callouts: { Tip: 'tip', Attention: 'warn', Note: 'note' },
    footer:
      'Generated from <code>user-manual.md</code> by <code>scripts/user-manual-html.mjs</code>; the screenshots come from the real portal through <code>pnpm docs:manual</code>.',
  },
};

const CALLOUT_CLASS = { tip: 'callout info tip', warn: 'callout warn', note: 'callout info' };

const stripTags = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const attr = (s) => escapeHtml(s).replaceAll('"', '&quot;');
const shorten = (s, max = 140) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);
const pct = (n) => `${Number(n.toFixed(2))}%`;

const roleChips = (roles, t) =>
  roles.length
    ? `<span class="role-chips">${roles
        .map((r) => `<span class="role-chip role-${r}">${t.roles[r] ?? r}</span>`)
        .join('')}</span>`
    : '';

const copyLink = (id, label, t) =>
  `<button class="copy-link" type="button" data-copy-link="#${id}" aria-label="${attr(`${t.copyLink} ${label}`)}">#</button>`;

/** Turns a section's body into HTML, with figures, callouts and tab groups. */
function renderBody(lines, sectionId, manifest, t, counters) {
  const out = [];
  let plain = [];
  let lastList = null;
  let listIndex = 0;

  const flush = () => {
    if (!plain.length) return;
    let html = blocks(plain, t.copy);
    plain = [];
    html = html.replace(/<h3>(.*?)<\/h3>/g, (_, inner) => {
      const id = slug(stripTags(inner));
      return `<h3 id="${id}">${inner} ${copyLink(id, stripTags(inner), t)}</h3>`;
    });
    html = html.replace(/<ol class="steps">\n([\s\S]*?)\n<\/ol>/g, (_, items) => {
      listIndex += 1;
      const parts = items.split(/\n(?=<li>)/);
      const ids = [];
      const texts = [];
      const lis = parts.map((li, n) => {
        const id = `${sectionId}-${listIndex}-${n + 1}`;
        ids.push(id);
        texts.push(shorten(stripTags(li)));
        return li.replace(/^<li>/, `<li id="${id}">`);
      });
      lastList = { ids, texts };
      return `<ol class="steps">\n${lis.join('\n')}\n</ol>`;
    });
    out.push(html);
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const figure = /^!\[([^\]]*)\]\((img\/user-manual\/([\w-]+)\.jpg)(?:\s+"([^"]*)")?\)\s*$/.exec(
      line.trim(),
    );
    if (figure) {
      flush();
      const [, alt, src, id, caption = ''] = figure;
      const entry = manifest.shots?.[id];
      if (!entry) {
        throw new Error(`figure ${src}: not in the manifest (run pnpm docs:manual)`);
      }
      const steps = lastList?.ids.length ?? 0;
      if (entry.hotspots.length !== steps) {
        throw new Error(
          `figure ${id}: ${entry.hotspots.length} hotspots but ${steps} sub-steps before it`,
        );
      }
      const spots = entry.hotspots
        .map((h, k) => {
          const target = lastList.ids[k];
          const label = `${h.n}. ${lastList.texts[k]}`;
          return `<button class="hotspot" type="button" data-n="${h.n}" data-target="#${target}" style="left:${pct(h.x)};top:${pct(h.y)};width:${pct(h.w)};height:${pct(h.h)}" aria-label="${attr(label)}"><span>${h.n}</span></button>`;
        })
        .join('');
      out.push(
        `<figure class="shot" id="shot-${id}">
<div class="shot-frame">
<button class="shot-open" type="button" aria-label="${attr(`${t.enlarge}: ${alt}`)}"><img src="${src}" alt="${attr(alt)}" width="${entry.width}" height="${entry.height}" loading="lazy" decoding="async"></button>${spots}
</div>
${caption ? `<figcaption>${inline(caption)}</figcaption>` : ''}
</figure>`,
      );
      lastList = null;
      i += 1;
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const quote = [];
      while (i < lines.length && lines[i].startsWith('>')) {
        quote.push(lines[i].replace(/^>\s?/, ''));
        i += 1;
      }
      const text = quote.join('\n').trim();
      const marker = /^\*\*([^*:]+):\*\*\s*/.exec(text);
      const kind = marker ? (t.callouts[marker[1]] ?? 'note') : 'note';
      const body = marker ? text.slice(marker[0].length) : text;
      const paragraphs = body
        .split(/\n\s*\n/)
        .map((p) => `<p>${inline(p.replace(/\n/g, ' '))}</p>`)
        .join('');
      out.push(
        `<aside class="${CALLOUT_CLASS[kind]}">${marker ? `<b>${escapeHtml(marker[1])}</b>` : ''}${paragraphs}</aside>`,
      );
      continue;
    }
    if (/^```\S*\s+tab="[^"]+"/.test(line)) {
      flush();
      const tabs = [];
      while (i < lines.length && /^```\S*\s+tab="[^"]+"/.test(lines[i])) {
        const label = /tab="([^"]+)"/.exec(lines[i])[1];
        const body = [];
        i += 1;
        while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
        i += 1;
        tabs.push({ label, body });
        let j = i;
        while (j < lines.length && !lines[j].trim()) j += 1;
        if (j < lines.length && /^```\S*\s+tab="[^"]+"/.test(lines[j])) i = j;
      }
      counters.tabs += 1;
      const group = `tabs-${counters.tabs}`;
      const buttons = tabs
        .map(
          (tab, k) =>
            `<button role="tab" type="button" id="${group}-tab-${k}" aria-controls="${group}-panel-${k}" aria-selected="${k === 0}" tabindex="${k === 0 ? 0 : -1}" data-label="${attr(tab.label)}">${escapeHtml(tab.label)}</button>`,
        )
        .join('');
      const panels = tabs
        .map(
          (tab, k) =>
            `<div role="tabpanel" id="${group}-panel-${k}" aria-labelledby="${group}-tab-${k}"${k === 0 ? '' : ' hidden'}>${code(tab.body, t.copy)}</div>`,
        )
        .join('\n');
      out.push(
        `<div class="tabs" data-tabs>\n<div role="tablist">${buttons}</div>\n${panels}\n</div>`,
      );
      continue;
    }
    plain.push(line);
    i += 1;
  }
  flush();
  return out.join('\n');
}

/** Parses the manual: title, lede and sections (with their roles and HTML). */
function parseManual(md, manifest, lang) {
  const t = TEXT[lang];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const h1 = lines.find((l) => l.startsWith('# '))?.slice(2) ?? t.title;
  const firstSection = lines.findIndex((l) => l.startsWith('## '));
  const preamble = lines
    .slice(
      lines.findIndex((l) => l.startsWith('# ')) + 1,
      firstSection < 0 ? undefined : firstSection,
    )
    .filter((l) => !l.startsWith('>'));
  const withoutComments = (body) =>
    body
      .join('\n')
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n');
  const pre = withoutComments(preamble);
  const firstText = pre.findIndex((l) => l.trim());
  let end = firstText;
  while (end >= 0 && end < pre.length && pre[end].trim()) end += 1;
  const lede = firstText >= 0 ? pre.slice(firstText, end).join(' ') : '';
  const introBody = firstText >= 0 ? pre.slice(end) : pre;

  const raw = [];
  if (introBody.some((l) => l.trim())) {
    raw.push({ title: t.intro, body: introBody, roles: [], and: false });
  }
  let current;
  for (const line of firstSection < 0 ? [] : lines.slice(firstSection)) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3).trim(), body: [], roles: [], and: false };
      raw.push(current);
      continue;
    }
    const roles = /^<!--\s*roles:\s*([^>]*?)\s*-->\s*$/.exec(line.trim());
    if (roles) {
      current.roles = roles[1].split(/[,\s]+/).filter(Boolean);
      continue;
    }
    if (/^<!--\s*and\s*-->\s*$/.test(line.trim())) {
      current.and = true;
      continue;
    }
    current.body.push(line);
  }

  const counters = { tabs: 0 };
  const sections = raw.map((s) => {
    const id = slug(s.title);
    return { ...s, id, html: renderBody(withoutComments(s.body), id, manifest, t, counters) };
  });
  return { t, h1, lede, sections };
}

const headingHtml = (title) => {
  const m = /^(\d+)\.\s+(.*)$/.exec(title);
  return m ? `<span class="num">${m[1]}</span>${inline(m[2])}` : inline(title);
};

function journeyHtml(sections, t) {
  const steps = sections.filter((s) => s.roles.length);
  const items = steps
    .map(
      (s) =>
        `<li data-roles="${s.roles.join(' ')}"${s.and ? ' class="and"' : ''}>${s.and ? `<span class="and-mark">${t.and}</span>` : ''}<a href="#${s.id}">${headingHtml(s.title)}</a>${roleChips(s.roles, t)}</li>`,
    )
    .join('\n');
  return `<nav class="journey-map" aria-labelledby="journey-title">
<h2 id="journey-title">${t.journey}</h2>
<ol class="journey">
${items}
</ol>
</nav>`;
}

function sectionHtml(s, t) {
  const done = s.roles.length
    ? `<label class="done"><input type="checkbox" data-done="${s.id}"> ${t.done}</label>`
    : '';
  return `<section id="${s.id}" class="manual-section" data-roles="${s.roles.join(' ')}">
<div class="section-head">
<h2>${headingHtml(s.title)} ${copyLink(s.id, stripTags(inline(s.title)), t)}</h2>
${roleChips(s.roles, t)}${done}
</div>
${s.html}
</section>`;
}

/** The manual's main content: the journey map and every section. */
export function renderManual(md, manifest, lang) {
  const { t, sections } = parseManual(md, manifest, lang);
  return `${journeyHtml(sections, t)}\n\n${sections.map((s) => sectionHtml(s, t)).join('\n\n')}`;
}

const readManifest = (file, lang) =>
  existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { lang, shots: {} };

/** The whole page (an HTML fragment, like the other guides) from the Markdown and the manifest. */
export function renderPage(md, manifest, lang) {
  const t = TEXT[lang];
  const dir = resolve(root, t.dir);
  const { h1, lede, sections } = parseManual(md, manifest, lang);
  const shell = readFileSync(resolve(dir, 'entities.html'), 'utf8');
  const head = shell
    .slice(0, shell.indexOf('</style>') + '</style>'.length)
    .replace(/<title>[^<]*<\/title>/, `<title>${t.title}</title>`);
  const topbar = shell
    .slice(shell.indexOf('<div class="topbar">'), shell.indexOf('<header class="hero">'))
    .replace(/<small>[^<]*<\/small>/, `<small>${t.subtitle}</small>`);
  const script = shell.slice(shell.lastIndexOf('<script>'));
  const steps = sections.filter((s) => s.roles.length).length;
  const strings = {
    progress: t.progress,
    noResults: t.noResults,
    results: t.results,
    copied: t.copied,
    total: steps,
  };

  const tocItems = sections
    .map((s) => `      <li><a href="#${s.id}">${inline(s.title)}</a></li>`)
    .join('\n');
  const roleOptions = ['all', 'operator', 'provider', 'consumer']
    .map(
      (r) =>
        `<label><input type="radio" name="manual-role" value="${r}"${r === 'all' ? ' checked' : ''}> ${r === 'all' ? t.everyone : t.roles[r]}</label>`,
    )
    .join('\n');

  const html = `${head}
<style>
${MANUAL_CSS}
</style>

${topbar}<header class="hero">
  <div class="hero-inner">
    <span class="eyebrow">${t.eyebrow}</span>
    <h1>${inline(h1)}</h1>
    <p class="lede">${inline(lede)}</p>
    <div class="meta">
      <span>${t.forWhom}</span>
      <span>${t.version}</span>
      <span>${t.other}</span>
    </div>
  </div>
</header>

<div class="shell">
  <nav class="toc" aria-label="${t.contents}">
    <div class="manual-progress"><p data-progress>${t.progress.replace('{done}', '0').replace('{total}', String(steps))}</p><button type="button" class="reset-progress" data-reset-progress>${t.reset}</button></div>
    <ol>
${tocItems}
    </ol>
  </nav>

  <main>
    <details class="toc-mobile">
      <summary>${t.contents}</summary>
      <ol>
${tocItems}
      </ol>
    </details>

    <div class="manual-tools" role="search" aria-label="${t.tools}">
      <fieldset class="role-filter">
        <legend>${t.who}</legend>
${roleOptions}
      </fieldset>
      <div class="manual-search">
        <label for="manual-search">${t.search}</label>
        <input type="search" id="manual-search" autocomplete="off">
      </div>
      <p class="search-status" role="status" aria-live="polite"></p>
    </div>

${renderManual(md, manifest, lang)}

    <p class="footer">${t.footer}</p>
  </main>
</div>

<dialog class="shot-dialog" aria-labelledby="shot-dialog-title">
  <div class="shot-dialog-bar"><p id="shot-dialog-title"></p><button type="button" class="shot-dialog-close">${t.close}</button></div>
  <div class="shot-dialog-body"></div>
</dialog>
<script type="application/json" id="manual-strings">${JSON.stringify(strings)}</script>

${script}
<script>
${MANUAL_JS}
</script>`;
  return { html: html.endsWith('\n') ? html : `${html}\n`, sections: sections.length };
}

/** Writes an HTML file; returns what the CLI prints. */
function write(out, page) {
  writeFileSync(out, page.html);
  return `${out}: ${page.sections} sections, ${Buffer.byteLength(page.html)} bytes`;
}

/** Writes docs/<es/>guides/user-manual.html for a language. */
export function build(lang) {
  const dir = resolve(root, TEXT[lang].dir);
  const md = readFileSync(resolve(dir, 'user-manual.md'), 'utf8');
  const manifest = readManifest(resolve(dir, 'img/user-manual/manifest.json'), lang);
  return write(resolve(dir, 'user-manual.html'), renderPage(md, manifest, lang));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const option = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  if (option('--md')) {
    // Any Markdown and manifest (the page's own tests):
    //   --md <file> --manifest <file> --lang es|en --out <file>
    const lang = option('--lang') ?? 'es';
    const md = readFileSync(option('--md'), 'utf8');
    const manifest = readManifest(option('--manifest') ?? '', lang);
    console.log(write(option('--out'), renderPage(md, manifest, lang)));
  } else {
    for (const lang of argv.length ? argv : ['es', 'en']) console.log(build(lang));
  }
}
