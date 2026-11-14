import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../seed/realm.js';
import { AUDIT_ACTIONS, DYNAMIC_ACTIONS } from './actions.js';

const src = join(repoRoot(), 'apps/api/src');

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === 'generated') continue;
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (entry.endsWith('.ts') && !entry.includes('.test.')) yield path;
  }
}

/** Every string that looks like an audit action passed as `action:` (literal or template). */
function recordedActions(): string[] {
  const found = new Set<string>();
  for (const file of sources(src)) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/action:\s*([^,\n]+)/g)) {
      for (const literal of (m[1] ?? '').matchAll(/['`]([a-z_]+\.(?:[a-z_]+|\$\{\w+\}))['`]/g)) {
        found.add(literal[1] ?? '');
      }
    }
  }
  return [...found].sort();
}

const labels = (locale: 'es' | 'en') =>
  (
    JSON.parse(readFileSync(join(repoRoot(), `apps/web/messages/${locale}.json`), 'utf8')) as {
      audit: { actions: Record<string, Record<string, string>> };
    }
  ).audit.actions;

describe('audit action catalogue (M2-09)', () => {
  it('lists every action the code records', () => {
    const catalogue = new Set<string>(AUDIT_ACTIONS);
    const missing = recordedActions().filter((a) =>
      a in DYNAMIC_ACTIONS ? false : !catalogue.has(a),
    );
    expect(missing).toEqual([]);
  });

  it('covers every dynamic action by its expansions', () => {
    const dynamic = recordedActions().filter((a) => a.includes('${'));
    expect(dynamic.filter((a) => !(a in DYNAMIC_ACTIONS))).toEqual([]);
  });

  it('has a label for every action in both languages', () => {
    for (const locale of ['es', 'en'] as const) {
      const map = labels(locale);
      const unlabelled = AUDIT_ACTIONS.filter((action) => {
        const [area = '', event = ''] = action.split('.');
        return !map[area]?.[event];
      });
      expect(unlabelled, locale).toEqual([]);
    }
  });
});
