#!/usr/bin/env node
// Builds the presentation version of the full walkthrough (docs/guides/walkthrough.html and
// docs/es/guides/walkthrough.html) from its Markdown, with the look of the other HTML guides:
// the <head>, styles, top bar and script are taken from entities.html of the same language, so the
// three guides stay one design. Run it after editing walkthrough.md:  node scripts/walkthrough-html.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// --- inline Markdown ----------------------------------------------------------------------------
const escapeHtml = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function inline(text) {
  // Code spans first: their content is literal.
  return text
    .split(/(`[^`]+`)/)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
          const url = href.replace(/\.md(#|$)/, '.html$1');
          return `<a href="${url}">${label}</a>`;
        });
    })
    .join('');
}

const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// --- blocks -------------------------------------------------------------------------------------
function table(lines) {
  const cells = (row) =>
    row
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim());
  const [head, , ...rows] = lines;
  const th = cells(head)
    .map((c) => `<th>${inline(c)}</th>`)
    .join('');
  const tr = rows
    .map(
      (r) =>
        `<tr>${cells(r)
          .map((c, i) => `<td${i ? ' class="wrap"' : ''}>${inline(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('\n');
  return `<div class="tablewrap"><table class="t"><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table></div>`;
}

function code(lines, copy) {
  return `<div class="code"><button class="copy" type="button">${copy}</button><pre><code>${escapeHtml(lines.join('\n'))}</code></pre></div>`;
}

/** Converts a run of Markdown lines (no section headings) into HTML blocks. */
function blocks(lines, copy) {
  const out = [];
  let i = 0;
  const isItem = (l) => /^(\d+\.|-) /.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }
    if (line.startsWith('```')) {
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith('```')) body.push(lines[i++]);
      i += 1;
      out.push(code(body, copy));
      continue;
    }
    if (line.startsWith('### ')) {
      out.push(`<h3>${inline(line.slice(4))}</h3>`);
      i += 1;
      continue;
    }
    if (line.startsWith('|')) {
      const rows = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    if (isItem(line)) {
      const ordered = /^\d+\. /.test(line);
      const items = [];
      while (
        i < lines.length &&
        (isItem(lines[i]) || !lines[i].trim() || /^\s{2,}/.test(lines[i]))
      ) {
        if (isItem(lines[i])) {
          if (/^\d+\. /.test(lines[i]) !== ordered) break;
          items.push([lines[i].replace(/^(\d+\.|-) /, '')]);
        } else if (items.length) {
          // Continuation: indented content of the current item (or a blank line inside it).
          const next = lines.slice(i + 1).find((l) => l.trim());
          if (!lines[i].trim() && !(next && (/^\s{2,}/.test(next) || isItem(next)))) break;
          items.at(-1).push(lines[i].replace(/^ {2,3}/, ''));
        }
        i += 1;
      }
      const html = items.map(([first, ...rest]) => {
        const nested = rest.length ? blocks(rest, copy) : '';
        return ordered
          ? `<li><span>${inline(first)}${nested ? `<div style="margin-top:8px;display:grid;gap:10px">${nested}</div>` : ''}</span></li>`
          : `<li>${inline(first)}${nested}</li>`;
      });
      out.push(
        ordered
          ? `<ol class="steps">\n${html.join('\n')}\n</ol>`
          : `<ul class="ticks">\n${html.join('\n')}\n</ul>`,
      );
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('|') &&
      !lines[i].startsWith('### ') &&
      !isItem(lines[i])
    ) {
      para.push(lines[i++].trim());
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

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
