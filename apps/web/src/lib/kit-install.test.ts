import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  kitDirectory,
  kitInstallCommands,
  kitMirrorUrl,
  portalUrl,
  shellWord,
} from './kit-install';

const release = {
  version: '0.2.0',
  url: 'https://github.com/centre-for-dpi/data-exchange-provider/releases/download/v0.2.0/den-node-kit-0.2.0.tar.gz',
  fileName: 'den-node-kit-0.2.0.tar.gz',
  sha256: '4e196fae6d46a4c5942c0bdc1d35cdf29dc6ca25d667a0341dadf1b5c47c21d9',
};

describe('kit install commands (P-03)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('downloads, checks the page checksum, extracts and installs, as the walkthrough does', () => {
    expect(kitInstallCommands({ ...release, locale: 'en' }).split('\n')).toEqual([
      `curl -fLO ${release.url}`,
      `echo "${release.sha256}  den-node-kit-0.2.0.tar.gz" | sha256sum -c -`,
      'tar -xzf den-node-kit-0.2.0.tar.gz',
      'cd den-node-kit-0.2.0',
      'sudo ./install.sh',
    ]);
  });

  it('asks the installer for Spanish on the Spanish page', () => {
    expect(
      kitInstallCommands({ ...release, locale: 'es' })
        .split('\n')
        .at(-1),
    ).toBe('sudo DEN_LANG=es ./install.sh');
  });

  it('downloads from the mirror under /kit/<version>/ on the portal', () => {
    const url = kitMirrorUrl('https://portal.example.org', release);
    expect(url).toBe('https://portal.example.org/kit/0.2.0/den-node-kit-0.2.0.tar.gz');
    expect(kitInstallCommands({ ...release, url, locale: 'en' })).toContain(`curl -fLO ${url}\n`);
  });

  it('quotes a link the shell would read otherwise', () => {
    expect(shellWord('https://example.org/k.tar.gz?a=1&b=2')).toBe(
      "'https://example.org/k.tar.gz?a=1&b=2'",
    );
    expect(shellWord("https://example.org/it's.tgz")).toBe("'https://example.org/it'\\''s.tgz'");
    expect(kitDirectory('kit-1.0.0.tgz')).toBe('kit-1.0.0');
  });

  it('takes the portal URL from DEN_WEB_URL, without a trailing slash', () => {
    vi.stubEnv('DEN_WEB_URL', 'https://portal.example.org/');
    expect(portalUrl()).toBe('https://portal.example.org');
  });
});
