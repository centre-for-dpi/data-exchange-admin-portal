#!/usr/bin/env node
// Builds the presentation version of the full walkthrough (docs/guides/walkthrough.html and
// docs/es/guides/walkthrough.html) from its Markdown, with the look of the other HTML guides:
// the <head>, styles, top bar and script are taken from entities.html of the same language, so the
// three guides stay one design. Run it after editing walkthrough.md:  node scripts/walkthrough-html.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocks, inline, slug } from './lib/guide-md.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LANGS = {
  es: {
    dir: 'docs/es/guides',
    title: 'Recorrido completo DEN',
    subtitle: '· recorrido completo, paso a paso',
    eyebrow: 'Recorrido completo · De la cuenta a la consulta',
    forWhom: '<b>Para</b> el operador, las entidades proveedoras y las consumidoras',
    version: '<b>Versión</b> 1.0 · noviembre 2026',
    other:
      '<a href="../../guides/walkthrough.html" hreflang="en" lang="en">English version (official)</a>',
    contents: 'Contenido',
    intro: 'Valores de ejemplo',
    footer:
      'Generado desde <code>walkthrough.md</code> con <code>scripts/walkthrough-html.mjs</code>.',
  },
  en: {
    dir: 'docs/guides',
    title: 'DEN full walkthrough',
    subtitle: '· full walkthrough, step by step',
    eyebrow: 'Full walkthrough · From the account to the lookup',
    forWhom: '<b>For</b> the operator, provider entities and consumer entities',
    version: '<b>Version</b> 1.0 · November 2026',
    other: '<a href="../es/guides/walkthrough.html" hreflang="es" lang="es">Versión en español</a>',
    contents: 'Contents',
    intro: 'Example values',
    footer:
      'Generated from <code>walkthrough.md</code> by <code>scripts/walkthrough-html.mjs</code>.',
  },
};

// --- page ---------------------------------------------------------------------------------------
function build(lang) {
  const t = LANGS[lang];
  const md = readFileSync(resolve(root, t.dir, 'walkthrough.md'), 'utf8').replace(/\r\n/g, '\n');
  const shell = readFileSync(resolve(root, t.dir, 'entities.html'), 'utf8');
  const head = shell
    .slice(0, shell.indexOf('</style>') + '</style>'.length)
    .replace(/<title>[^<]*<\/title>/, `<title>${t.title}</title>`);
  const topbar = shell
    .slice(shell.indexOf('<div class="topbar">'), shell.indexOf('<header class="hero">'))
    .replace(/<small>[^<]*<\/small>/, `<small>${t.subtitle}</small>`);
  const script = shell.slice(shell.lastIndexOf('<script>'));

  const lines = md.split('\n');
  const h1 = lines.find((l) => l.startsWith('# ')).slice(2);
  const firstSection = lines.findIndex((l) => l.startsWith('## '));
  const preamble = lines
    .slice(lines.findIndex((l) => l.startsWith('# ')) + 1, firstSection)
    .filter((l) => !l.startsWith('>'));
  // The first paragraph is the lede; the rest of the preamble (example values) is its own section.
  const firstText = preamble.findIndex((l) => l.trim());
  let end = firstText;
  while (end < preamble.length && preamble[end].trim()) end += 1;
  const lede = preamble.slice(firstText, end).join(' ');
  const introBody = preamble.slice(end);

  const sections = [{ id: slug(t.intro), title: t.intro, body: introBody }];
  let current;
  for (const line of lines.slice(firstSection)) {
    if (line.startsWith('## ')) {
      current = { title: line.slice(3), body: [] };
      current.id = slug(current.title);
      sections.push(current);
    } else {
      current.body.push(line);
    }
  }

  const copy = lang === 'es' ? 'Copiar' : 'Copy';
  const heading = (title) => {
    const m = /^(\d+)\.\s+(.*)$/.exec(title);
    return m ? `<span class="num">${m[1]}</span>${inline(m[2])}` : inline(title);
  };
  const tocItems = sections
    .map((s) => `      <li><a href="#${s.id}">${inline(s.title)}</a></li>`)
    .join('\n');
  const main = sections
    .map(
      (s) =>
        `    <section id="${s.id}">\n      <h2>${heading(s.title)}</h2>\n${blocks(s.body, copy)}\n    </section>`,
    )
    .join('\n\n');

  const html = `${head}

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

${main}

    <p class="footer">${t.footer}</p>
  </main>
</div>

${script}`;
  const out = resolve(root, t.dir, 'walkthrough.html');
  writeFileSync(out, html.endsWith('\n') ? html : `${html}\n`);
  return { out, sections: sections.length, bytes: Buffer.byteLength(html) };
}

for (const lang of Object.keys(LANGS)) {
  const r = build(lang);
  console.log(`${r.out}: ${r.sections} sections, ${r.bytes} bytes`);
}
