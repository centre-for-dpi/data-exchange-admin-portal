import { describe, expect, it } from 'vitest';
import { renderManual } from './user-manual-html.mjs';

const manifest = (shots) => ({ lang: 'es', shots });
const box = (n) => ({ n, x: 10 * n, y: 5, w: 8, h: 4 });
const entry = (id, count) => ({
  file: `${id}.jpg`,
  width: 800,
  height: 600,
  hotspots: Array.from({ length: count }, (_, i) => box(i + 1)),
});
const doc = (body) => `# Manual\n\nLede.\n\n## 1. Paso\n\n${body}\n`;

describe('user manual generator', () => {
  it('figure gets its image, caption and one hotspot per manifest box', () => {
    const html = renderManual(
      doc('1. a\n2. b\n\n![Alt](img/user-manual/x.jpg "Cap")'),
      manifest({ x: entry('x', 2) }),
      'es',
    );
    expect(html).toContain('src="img/user-manual/x.jpg"');
    expect(html).toContain('alt="Alt"');
    expect(html).toContain('width="800" height="600"');
    expect(html).toContain('<figcaption>Cap</figcaption>');
    expect(html.match(/class="hotspot"/g)).toHaveLength(2);
    expect(html).toContain('left:10%;top:5%;width:8%;height:4%');
    expect(html).toContain('aria-label="1. a"');
    // The hotspot points at its sub-step, which has that id.
    const target = /class="hotspot"[^>]*data-target="#([^"]+)"/.exec(html)?.[1];
    expect(target).toBeTruthy();
    expect(html).toContain(`<li id="${target}"`);
  });

  it('fails naming the id when the manifest lacks it', () => {
    expect(() =>
      renderManual(doc('1. a\n\n![Alt](img/user-manual/x.jpg "Cap")'), manifest({}), 'es'),
    ).toThrow(/x\.jpg/);
  });

  it('fails when hotspots and sub-steps differ', () => {
    expect(() =>
      renderManual(
        doc('1. a\n2. b\n\n![Alt](img/user-manual/x.jpg "Cap")'),
        manifest({ x: entry('x', 3) }),
        'es',
      ),
    ).toThrow(/x.*3.*2/);
  });

  it('roles comment tags the section and the journey map', () => {
    const html = renderManual(
      `# Manual\n\nLede.\n\n## 1. Alta\n\n<!-- roles: provider -->\n\nTexto.\n\n## 2. Revisión\n\n<!-- roles: operator -->\n\nTexto.\n`,
      manifest({}),
      'es',
    );
    expect(html).toMatch(/<section id="1-alta"[^>]*data-roles="provider"/);
    expect(html).toMatch(/<section id="2-revision"[^>]*data-roles="operator"/);
    const journey = /<ol class="journey"[\s\S]*?<\/ol>/.exec(html)?.[0] ?? '';
    expect(journey).toContain('href="#1-alta"');
    expect(journey).toContain('Entidad proveedora');
    expect(journey).toContain('Operador');
    expect(html).not.toContain('<!-- roles');
  });

  it('consecutive tab blocks become one tab group', () => {
    const html = renderManual(
      doc(
        '```bash tab="Linux o macOS"\nls\n```\n\n```powershell tab="Windows: PowerShell"\ndir\n```',
      ),
      manifest({}),
      'es',
    );
    expect(html.match(/role="tablist"/g)).toHaveLength(1);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toContain('data-label="Windows: PowerShell"');
    expect(html).toContain('<code>dir</code>');
  });

  it('tip and attention blockquotes become callouts', () => {
    const es = renderManual(
      doc('> **Consejo:** usa una ventana privada.\n\n> **Atención:** el token se ve una vez.'),
      manifest({}),
      'es',
    );
    expect(es).toMatch(/<aside class="callout info tip">[\s\S]*Consejo[\s\S]*ventana privada/);
    expect(es).toMatch(/<aside class="callout warn">[\s\S]*Atención[\s\S]*una vez/);
    // The label sits on its own line, so the text after it starts with a capital.
    expect(es).toContain('<p>Usa una ventana privada.</p>');
    const en = renderManual(
      doc('> **Tip:** use a private window.\n\n> **Attention:** shown once.'),
      manifest({}),
      'en',
    );
    expect(en).toMatch(/<aside class="callout info tip">[\s\S]*Tip/);
    expect(en).toMatch(/<aside class="callout warn">[\s\S]*Attention/);
  });

  it('every section and sub-section has a copy-link button', () => {
    const html = renderManual(doc('### 1.1 Sub\n\nTexto.'), manifest({}), 'es');
    expect(html).toMatch(/<h3 id="1-1-sub"/);
    expect(html).toContain('data-copy-link="#1-1-sub"');
    expect(html).toContain('data-copy-link="#1-paso"');
  });
});
