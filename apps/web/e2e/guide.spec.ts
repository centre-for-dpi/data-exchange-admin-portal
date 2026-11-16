import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectNoAccessibilityViolations } from './helpers';
import { activeAffiliationSubscription, certificateOf } from './gateway-flows';

const apiUrl = process.env.RID_API_URL ?? 'http://localhost:4000';
const repoRoot = resolve(import.meta.dirname, '../../..');
const LANGUAGES = [
  ['curl', 'curl'],
  ['python', 'Python'],
  ['node', 'Node.js'],
  ['java', 'Java'],
  ['csharp', 'C#'],
] as const;

/** Runs a command in the guide's folder with the application's secret in the environment. */
function run(cwd: string, env: Record<string, string>, command: string, args: string[]) {
  const result = spawnSync(command, args, {
    cwd,
    // Playwright sets FORCE_COLOR: no ANSI colours around what the programs print.
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...env },
    encoding: 'utf8',
    timeout: 240_000,
    shell: false,
  });
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

// M5-08: the integration guide's programs, copied from the page, get a token and call the API
// through the real gateway (mTLS, bound token, RID headers) in every language.
test.describe('integration guide (M5-08)', () => {
  test('every program of the guide works against the real gateway', async ({ browser, page }) => {
    test.setTimeout(900_000);
    const slug = `guia-${Date.now().toString(36)}`;
    const { appName, clientId, clientSecret } = await activeAffiliationSubscription(
      browser,
      page,
      slug,
    );
    await page.goto('/my-apps');
    await page.getByRole('link', { name: appName }).click();
    await expect(page.getByRole('heading', { level: 1, name: appName })).toBeVisible();

    // The tabs work with the keyboard too.
    const curlTab = page.getByRole('tab', { name: 'curl', exact: true });
    await curlTab.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Python', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expectNoAccessibilityViolations(page);

    const code: Record<string, string> = {};
    for (const [language, label] of LANGUAGES) {
      await page.getByRole('tab', { name: label, exact: true }).click();
      code[language] = (await page.getByTestId(`guide-${language}`).textContent()) ?? '';
    }

    // The guide's folder: the application's certificate and key, the network CA, the programs.
    const dir = mkdtempSync(join(tmpdir(), 'rid-guide-'));
    const tls = certificateOf(clientId);
    if (tls) {
      writeFileSync(join(dir, `${clientId}.crt`), tls.cert);
      writeFileSync(join(dir, `${clientId}.key`), tls.key);
      writeFileSync(
        join(dir, 'rid-network-ca.pem'),
        await (await fetch(`${apiUrl}/api/v1/pki/ca`)).text(),
      );
    }
    const fill = (source: string) =>
      source
        .replaceAll('/{entidad}/{api}/v1/...', `/salud/${slug}/v1/afiliados/1000000001`)
        .replaceAll('{finalidad}', 'eligibility_check')
        .replaceAll('{funcionario}', 'funcionario-guia');
    const env = { RID_CLIENT_SECRET: clientSecret, RID_P12_PASSWORD: 'guia-p12-0123' };
    const ok = (language: string, result: { status: number | null; out: string }) => {
      expect(result.status, `${language}: ${result.out.slice(-800)}`).toBe(0);
      expect(result.out, language).toMatch(/^200 /m);
      expect(result.out, language).toContain('regimen');
    };

    // curl as on Linux or macOS (OpenSSL): in a container that has it, outside the stack's
    // networks like a real consumer (the gateway is on its own network since M6-01). .curlrc
    // sends localhost:9443 to the host's published port, so the name (and its certificate) stay
    // the same. jq is not part of the test: a shim reads the token from the JSON.
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'jq'),
      ['#!/bin/sh', `sed -E 's/.*"access_token":"([^"]+)".*/\\1/'`, ''].join('\n'),
      { mode: 0o755 },
    );
    const gatewayHost = new URL(process.env.RID_GATEWAY_PUBLIC_URL ?? 'https://localhost:9443');
    writeFileSync(
      join(dir, '.curlrc'),
      `connect-to = ${gatewayHost.hostname}:${gatewayHost.port}:host.docker.internal:${gatewayHost.port}
`,
    );
    const script = fill(code.curl ?? '').replace(
      '-H "X-RID-End-User: funcionario-guia"',
      `-H "X-RID-End-User: funcionario-guia" -s -o body.json -w '%{http_code}'`,
    );
    writeFileSync(
      join(dir, 'rid.sh'),
      `${script}
echo " $(cat body.json)"
`,
    );
    ok(
      'curl',
      run(dir, env, 'docker', [
        'run',
        '--rm',
        '--add-host',
        'host.docker.internal:host-gateway',
        '-v',
        `${dir}:/guide`,
        '-w',
        '/guide',
        '-e',
        'RID_CLIENT_SECRET',
        '-e',
        'HOME=/guide',
        '-e',
        'PATH=/guide/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        '--entrypoint',
        'sh',
        'fluent/fluent-bit:5.1.5-debug',
        'rid.sh',
      ]),
    );

    writeFileSync(join(dir, 'rid.py'), fill(code.python ?? ''));
    ok('python', run(dir, env, 'python', ['rid.py']));

    // Node: the guide says npm install undici; the repo already has it.
    const store = join(repoRoot, 'node_modules', '.pnpm');
    const undici = readdirSync(store).find((d) => /^undici@8\./.test(d));
    mkdirSync(join(dir, 'node_modules'));
    symlinkSync(
      join(store, undici ?? '', 'node_modules', 'undici'),
      join(dir, 'node_modules', 'undici'),
      'junction',
    );
    writeFileSync(join(dir, 'rid.mjs'), fill(code.node ?? ''));
    ok('node', run(dir, env, 'node', ['rid.mjs']));

    // Java: the PKCS#12 file as the guide's comment says, then compile and run.
    const p12 = run(dir, env, 'openssl', [
      'pkcs12',
      '-export',
      '-in',
      `${clientId}.crt`,
      '-inkey',
      `${clientId}.key`,
      '-out',
      `${clientId}.p12`,
      '-passout',
      'env:RID_P12_PASSWORD',
    ]);
    expect(p12.status, p12.out).toBe(0);
    writeFileSync(join(dir, 'RidClient.java'), fill(code.java ?? ''));
    const javac = run(dir, env, 'javac', ['RidClient.java']);
    expect(javac.status, javac.out).toBe(0);
    ok('java', run(dir, env, 'java', ['RidClient']));

    // C#: a console project with the guide's Program.cs.
    const cs = join(dir, 'cs');
    const created = run(dir, env, 'dotnet', [
      'new',
      'console',
      '-o',
      cs,
      '-n',
      'RidGuide',
      '--force',
    ]);
    expect(created.status, created.out).toBe(0);
    for (const file of [`${clientId}.crt`, `${clientId}.key`, 'rid-network-ca.pem']) {
      if (tls) copyFileSync(join(dir, file), join(cs, file));
    }
    writeFileSync(join(cs, 'Program.cs'), fill(code.csharp ?? ''));
    ok('csharp', run(cs, env, 'dotnet', ['run']));
  });
});
