import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../../seed/realm.js';
import { developmentTsaReason, readPinnedRoots, TsaClient, tsaSettings } from './tsa.client.js';

const fixture = JSON.parse(
  readFileSync(
    join(repoRoot(), 'packages/transparency-verifier/src/__fixtures__/receipt-fixture.json'),
    'utf8',
  ),
) as { tsaRoot: string; otherRoot: string };

/** The development TSA's root (CN=DEN Dev TSA Root) and an unrelated one. */
const devRoot = fixture.tsaRoot;
const otherRoot = fixture.otherRoot;

describe('TSA settings: an accredited TSA can be connected (M-14, ADR-0032)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'den-tsa-'));
  const file = (name: string, content: string) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  afterEach(() => vi.unstubAllEnvs());

  it('with pinned roots, posts to the full URL as given and downloads no trust', () => {
    const rootsFile = file('accredited.pem', otherRoot);
    expect(
      tsaSettings({ DEN_TSA_URL: 'https://tsa.example.org/tsr', DEN_TSA_ROOTS_FILE: rootsFile }),
    ).toEqual({ url: 'https://tsa.example.org/tsr', rootsFile, chainUrl: null });
    // A TSA at the root of its host too: the URL is not rewritten.
    expect(
      tsaSettings({ DEN_TSA_URL: 'http://timestamp.example.org', DEN_TSA_ROOTS_FILE: rootsFile })
        .url,
    ).toBe('http://timestamp.example.org');
  });

  it('without them, the development TSA: its sigstore paths, its own chain', () => {
    for (const url of ['http://tsa:3004', 'http://tsa:3004/', 'http://tsa:3004/api/v1/timestamp']) {
      expect(tsaSettings({ DEN_TSA_URL: url })).toEqual({
        url: 'http://tsa:3004/api/v1/timestamp',
        rootsFile: null,
        chainUrl: 'http://tsa:3004/api/v1/timestamp/certchain',
      });
    }
    expect(tsaSettings({}).url).toBe('http://localhost:3004/api/v1/timestamp');
  });

  it('tells the development TSA from an independent one', () => {
    const dev = tsaSettings({ DEN_TSA_URL: 'http://tsa:3004' });
    expect(developmentTsaReason(dev, null)).toMatch(/DEN_TSA_ROOTS_FILE is not set/);
    const pinned = (pem: string) =>
      tsaSettings({
        DEN_TSA_URL: 'https://tsa.example.org/tsr',
        DEN_TSA_ROOTS_FILE: file('r.pem', pem),
      });
    expect(developmentTsaReason(pinned(devRoot), [devRoot])).toMatch(/development TSA's root/);
    expect(developmentTsaReason(pinned(otherRoot), [otherRoot])).toBeNull();
  });

  it('a roots file without certificates is a configuration error', () => {
    expect(() => readPinnedRoots(file('empty.pem', 'not a certificate'))).toThrow(/no PEM/);
    expect(() => readPinnedRoots(join(dir, 'missing.pem'))).toThrow();
  });

  it('in production, says it loudly at start, or refuses to start when asked to', () => {
    const client = new TsaClient();
    const error = vi.spyOn(client['logger'], 'error').mockImplementation(() => undefined);
    vi.stubEnv('DEN_TSA_URL', 'http://tsa:3004');
    vi.stubEnv('DEN_TSA_ROOTS_FILE', '');
    vi.stubEnv('NODE_ENV', 'development');
    client.onApplicationBootstrap();
    expect(error).not.toHaveBeenCalled();

    vi.stubEnv('NODE_ENV', 'production');
    client.onApplicationBootstrap();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/not independent of the operator/));

    vi.stubEnv('DEN_TSA_REQUIRE_INDEPENDENT', 'true');
    expect(() => client.onApplicationBootstrap()).toThrow(/not independent of the operator/);

    // The accredited TSA, pinned: nothing to say.
    error.mockClear();
    vi.stubEnv('DEN_TSA_URL', 'https://tsa.example.org/tsr');
    vi.stubEnv('DEN_TSA_ROOTS_FILE', file('accredited-2.pem', otherRoot));
    client.onApplicationBootstrap();
    expect(error).not.toHaveBeenCalled();
  });

  it('trusts only the pinned roots', async () => {
    vi.stubEnv('DEN_TSA_URL', 'https://tsa.example.org/tsr');
    vi.stubEnv('DEN_TSA_ROOTS_FILE', file('only.pem', otherRoot));
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await new TsaClient().certificates()).toEqual([otherRoot.trim()]);
    expect(fetch).not.toHaveBeenCalled();
    fetch.mockRestore();
  });
});
