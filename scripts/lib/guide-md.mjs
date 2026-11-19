// Markdown to HTML blocks shared by the guide generators (walkthrough-html.mjs, user-manual-html.mjs):
// the small subset the guides use (headings h3, paragraphs, lists, tables, fenced code, inline
// code/bold/italic/links). Links to .md become links to the .html of the same guide.

// --- inline Markdown ----------------------------------------------------------------------------
export const escapeHtml = (s) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function inline(text) {
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

export const slug = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

// --- blocks -------------------------------------------------------------------------------------
export function table(lines) {
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

export function code(lines, copy) {
  return `<div class="code"><button class="copy" type="button">${copy}</button><pre><code>${escapeHtml(lines.join('\n'))}</code></pre></div>`;
}

/** Converts a run of Markdown lines (no section headings) into HTML blocks. */
export function blocks(lines, copy) {
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
