import { LANGS, type Lang, type Messages, MESSAGES } from './i18n.js';

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for HTML. Everything that comes from outside goes through it. */
export const esc = (value: string | number | boolean | null | undefined): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

type Value = string | number | boolean | null | undefined | Html;

/** Marks trusted, already-escaped HTML. */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

/** Template tag: interpolated values are escaped unless they are Html (or arrays of it). */
export function html(strings: TemplateStringsArray, ...values: Array<Value | Value[]>): Html {
  let out = strings[0] ?? '';
  values.forEach((value, i) => {
    const part = Array.isArray(value)
      ? value.map((v: Value) => (v instanceof Html ? v.value : esc(v))).join('')
      : value instanceof Html
        ? value.value
        : esc(value);
    out += part + (strings[i + 1] ?? '');
  });
  return new Html(out);
}

export interface PageOptions {
  lang: Lang;
  title: string;
  appName: string;
  basePath: string;
  path: string;
  signedIn: boolean;
  body: Html;
}

export function page(o: PageOptions): string {
  const t: Messages = MESSAGES[o.lang];
  const langLinks = LANGS.map(
    (l) =>
      html`<li>
        <a
          href="${o.basePath}${o.path.split('?')[0]}?lang=${l}"
          lang="${l}"
          hreflang="${l}"
          ${new Html(l === o.lang ? ' aria-current="true"' : '')}
          >${l.toUpperCase()}</a
        >
      </li>`,
  );
  return html`<!doctype html>
    <html lang="${o.lang}">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${o.title} · ${o.appName}</title>
        <link rel="stylesheet" href="${o.basePath}/static/app.css" />
      </head>
      <body>
        <a class="skip" href="#main">${t.skip}</a>
        <header>
          <a class="brand" href="${o.basePath}/">${o.appName}</a>
          <nav aria-label="${t.langLabel}">
            <ul class="langs">
              ${langLinks}
            </ul>
          </nav>
          ${o.signedIn ? html`<form method="post" action="${o.basePath}/logout"><button type="submit" class="link">${t.signOut}</button></form>` : ''}
        </header>
        <main id="main" tabindex="-1">${o.body}</main>
      </body>
    </html>`.value;
}

export const CSS = `
:root { color-scheme: light; --fg:#1b1f24; --muted:#4a5560; --accent:#0b5cad; --ok:#11643a; --bad:#a1260d; --bg:#ffffff; --line:#d5dbe1; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: -999px; } .skip:focus { left: 1rem; top: 1rem; background: #fff; padding: .5rem; }
header { display: flex; gap: 1rem; align-items: center; justify-content: space-between; padding: 1rem clamp(1rem, 4vw, 3rem); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brand { font-weight: 700; color: var(--fg); text-decoration: none; }
.langs { display: flex; gap: .5rem; list-style: none; margin: 0; padding: 0; }
main { padding: 1.5rem clamp(1rem, 4vw, 3rem); max-width: 72rem; }
a, .link { color: var(--accent); }
.link { background: none; border: 0; padding: 0; font: inherit; text-decoration: underline; cursor: pointer; }
.button { display: inline-block; background: var(--accent); color: #fff; padding: .6rem 1rem; border-radius: .4rem; text-decoration: none; border: 0; font: inherit; cursor: pointer; }
:focus-visible { outline: 3px solid #f2a900; outline-offset: 2px; }
.muted { color: var(--muted); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; margin: 1rem 0; }
caption { text-align: left; font-weight: 600; padding: .5rem 0; }
th, td { text-align: left; vertical-align: top; padding: .6rem .5rem; border-bottom: 1px solid var(--line); }
th { font-size: .9rem; }
fieldset { border: 1px solid var(--line); border-radius: .4rem; padding: 1rem; }
label { display: block; margin: .3rem 0; }
input[type=email] { padding: .4rem; font: inherit; min-width: min(22rem, 100%); }
.status { padding: .8rem 1rem; border-radius: .4rem; border: 1px solid var(--line); }
.status.ok { border-color: var(--ok); color: var(--ok); }
.status.bad { border-color: var(--bad); color: var(--bad); }
code { overflow-wrap: anywhere; }
`;
