import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GET } from '../app/files/entity-check.sh/route';
import { csrCommands, ENTITY_CHECK_PATH } from './csr-commands';
import { repoRoot } from './entity-check-script';

const script = resolve(import.meta.dirname, '../../../../scripts/entity-check.sh');

describe('entity-check.sh for download (P-05)', () => {
  it('serves the repository script byte for byte, as an attachment that is never rendered', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(script))).toBe(true);
    expect(res.headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="entity-check.sh"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('is the script whose csr subcommand the page describes, with the same key and client IDs', () => {
    const text = readFileSync(script, 'utf8');
    const csr = text.slice(text.indexOf('cmd_csr() {'), text.indexOf('cmd_call() {'));
    expect(csr).toContain('[[ $id =~ ^[A-Za-z0-9._-]+$ ]]');
    expect(csr).toContain('[[ -e $id.key ]] && fail');
    expect(csr).toContain(
      'umask 077 && MSYS_NO_PATHCONV=1 openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256',
    );
    expect(csr).toContain('-nodes -keyout "$id.key" -out "$id.csr" -subj "/CN=$id"');
    expect(csr).toContain('rm -f "$id.key" "$id.csr"');
    const page = csrCommands({ clientId: 'den-app-x', keyExists: 'x', opensslMissing: 'y' });
    for (const { code } of page) {
      expect(code).toContain('req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes');
    }
    expect(ENTITY_CHECK_PATH).toBe('/files/entity-check.sh');
    expect(repoRoot(import.meta.dirname)).toBe(resolve(import.meta.dirname, '../../../..'));
  });
});
