import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { loadCountryConfig } from '@den/config';
import {
  currentKitReleaseSchema,
  FieldErrorKey,
  KIT_BUNDLE_MEDIA_TYPE,
  kitReleaseListSchema,
} from '@den/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createTestIssuer, type TestIssuer } from '../../test/test-auth.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';

describe('the node kit from the portal (P-03)', () => {
  const prisma = new PrismaService();
  const realmUsers = readRealmUsers();
  const subOf = (username: string) => realmUsers.find((u) => u.username === username)?.id ?? '';
  let app: NestFastifyApplication;
  let issuer: TestIssuer;

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers,
    });
    issuer = await createTestIssuer();
    app = await createTestApp(issuer);
  });
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const auth = async (who: string) => ({
    authorization: `Bearer ${await issuer.token(subOf(who))}`,
  });
  const call = async (method: 'GET' | 'PUT', url: string, who?: string, payload?: object) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: who ? await auth(who) : {},
      ...(payload !== undefined ? { payload } : {}),
    });
  const upload = async (version: string, bytes: Buffer, who?: string, type = 'application/gzip') =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/admin/kit-releases/${version}/bundle`,
      headers: { ...(who ? await auth(who) : {}), 'content-type': type },
      payload: bytes,
    });

  const newVersion = () => `0.0.1-test.${randomUUID().slice(0, 8)}`;
  const bundle = () => {
    const bytes = gzipSync(randomBytes(4096));
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const release = (version: string, b: { bytes: Buffer; sha256: string }) => ({
    url: `https://github.com/example/kit/releases/download/v${version}/den-node-kit-${version}.tar.gz`,
    sizeBytes: b.bytes.length,
    sha256: b.sha256,
  });
  const auditOf = async (version: string) => {
    const row = await prisma.kitRelease.findUniqueOrThrow({ where: { version } });
    const events = await prisma.auditEvent.findMany({
      where: { targetType: 'kit_release', targetId: row.id },
      orderBy: { seq: 'asc' },
    });
    return events;
  };

  it('the operator sets the current version; anyone reads it, audited once', async () => {
    const version = newVersion();
    const b = bundle();
    const res = await call('PUT', `/admin/kit-releases/${version}`, 'pablo.plataforma', {
      ...release(version, b),
      sha256: b.sha256.toUpperCase(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const list = kitReleaseListSchema.parse(res.json());
    expect(list.items.find((r) => r.current)).toMatchObject({
      version,
      fileName: `den-node-kit-${version}.tar.gz`,
      sha256: b.sha256,
      mirrored: false,
    });

    const anonymous = await call('GET', '/kit/current');
    expect(anonymous.statusCode).toBe(200);
    expect(currentKitReleaseSchema.parse(anonymous.json()).release).toMatchObject({
      version,
      sizeBytes: b.bytes.length,
      signatureUrl: null,
    });
    const events = await auditOf(version);
    expect(events.map((e) => e.action)).toEqual([
      'kit_release.created',
      'kit_release.made_current',
    ]);
    expect(events[0]?.actorId).toBe(subOf('pablo.plataforma'));

    // The same again changes nothing and records nothing.
    const again = await call(
      'PUT',
      `/admin/kit-releases/${version}`,
      'pablo.plataforma',
      release(version, b),
    );
    expect(again.statusCode).toBe(200);
    expect(await auditOf(version)).toHaveLength(2);
  });

  it('a correction is audited with before and after; an older version can be made current again', async () => {
    const older = newVersion();
    const newer = newVersion();
    const b = bundle();
    await call('PUT', `/admin/kit-releases/${older}`, 'pablo.plataforma', release(older, b));
    await call('PUT', `/admin/kit-releases/${newer}`, 'pablo.plataforma', release(newer, b));
    const signed = {
      ...release(older, b),
      signatureUrl: `https://github.com/example/kit/releases/download/v${older}/kit.sig`,
      allowedSigners: 'operator@example.org namespaces="file" ssh-ed25519 AAAAC3Nza\r\n',
    };
    const res = await call('PUT', `/admin/kit-releases/${older}`, 'pablo.plataforma', signed);
    expect(res.statusCode, res.body).toBe(200);
    const current = currentKitReleaseSchema.parse((await call('GET', '/kit/current')).json());
    expect(current.release).toMatchObject({
      version: older,
      signatureUrl: signed.signatureUrl,
      allowedSigners: 'operator@example.org namespaces="file" ssh-ed25519 AAAAC3Nza',
    });
    const events = await auditOf(older);
    expect(events.map((e) => e.action)).toEqual([
      'kit_release.created',
      'kit_release.made_current',
      'kit_release.updated',
      'kit_release.made_current',
    ]);
    expect(events[2]?.before).toMatchObject({ signatureUrl: null });
    expect(events[2]?.after).toMatchObject({ signatureUrl: signed.signatureUrl });
  });

  it('validates the version, the link, the size and the checksum', async () => {
    const b = bundle();
    const version = newVersion();
    const cases: Array<[string, object, string]> = [
      ['not-semver', release(version, b), ''],
      [version, { ...release(version, b), url: 'http://example.org/k.tar.gz' }, 'url'],
      [version, { ...release(version, b), url: 'https://example.org/releases/latest' }, 'url'],
      [version, { ...release(version, b), sha256: 'abc' }, 'sha256'],
      [version, { ...release(version, b), sizeBytes: 0 }, 'sizeBytes'],
      [version, { ...release(version, b), allowedSigners: 'a\u0007b' }, 'allowedSigners'],
      [version, { ...release(version, b), extra: true }, ''],
    ];
    for (const [v, body, path] of cases) {
      const res = await call('PUT', `/admin/kit-releases/${v}`, 'pablo.plataforma', body);
      expect(res.statusCode, `${v} ${JSON.stringify(body)}`).toBe(400);
      if (path) {
        expect(res.json<{ errors: Array<{ path: string }> }>().errors.map((e) => e.path)).toContain(
          path,
        );
      }
    }
    const keys = async (body: object) =>
      (await call('PUT', `/admin/kit-releases/${version}`, 'pablo.plataforma', body))
        .json<{ errors: Array<{ key?: string }> }>()
        .errors.map((e) => e.key);
    expect(await keys({ ...release(version, b), url: 'http://example.org/k.tar.gz' })).toContain(
      'https_url',
    );
    expect(await keys({ ...release(version, b), url: 'https://example.org/latest' })).toContain(
      'kit_bundle_link',
    );
    expect(await keys({ ...release(version, b), sha256: 'abc' })).toContain('sha256_hex');
    expect(await prisma.kitRelease.count({ where: { version } })).toBe(0);
  });

  it('who reads and who sets: platform admin sets, reviewer reads, others 403, anonymous 401', async () => {
    const version = newVersion();
    const body = release(version, bundle());
    expect((await call('GET', '/admin/kit-releases', 'pablo.plataforma')).statusCode).toBe(200);
    expect((await call('GET', '/admin/kit-releases', 'ana.operadora')).statusCode).toBe(200);
    for (const who of ['marta.regulador', 'sofia.auditora', 'elena.admin', 'carlos.dev']) {
      expect((await call('GET', '/admin/kit-releases', who)).statusCode, who).toBe(403);
    }
    for (const who of ['ana.operadora', 'marta.regulador', 'elena.admin', 'pedro.publicador']) {
      const res = await call('PUT', `/admin/kit-releases/${version}`, who, body);
      expect(res.statusCode, who).toBe(403);
    }
    expect((await call('GET', '/admin/kit-releases')).statusCode).toBe(401);
    expect((await call('PUT', `/admin/kit-releases/${version}`, undefined, body)).statusCode).toBe(
      401,
    );
    expect(await prisma.kitRelease.count({ where: { version } })).toBe(0);
    // The current version is public: members, outsiders and anonymous callers alike.
    for (const who of ['elena.admin', 'carlos.dev', 'marta.regulador', undefined]) {
      expect((await call('GET', '/kit/current', who)).statusCode, String(who)).toBe(200);
    }
  });

  it('refuses a non-uploader before reading the bundle body', async () => {
    // A valid token is not enough to make the API buffer up to 128 MiB: the role is checked in
    // onRequest. A declared length over the limit gets the 403 there; only the uploader reaches
    // the body checks (413 for the same request).
    const version = newVersion();
    const b = bundle();
    await call('PUT', `/admin/kit-releases/${version}`, 'pablo.plataforma', release(version, b));
    const oversized = async (who: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/admin/kit-releases/${version}/bundle`,
        headers: {
          ...(await auth(who)),
          'content-type': 'application/gzip',
          'content-length': String(128 * 1024 * 1024 + 1),
        },
        payload: b.bytes,
      });
    for (const who of ['elena.admin', 'ana.operadora']) {
      const res = await oversized(who);
      expect(res.statusCode, who).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
    }
    expect((await oversized('pablo.plataforma')).statusCode).not.toBe(403);
  });

  it('mirrors the declared bundle only, once, and serves it anonymously for good', async () => {
    const version = newVersion();
    const b = bundle();
    await call('PUT', `/admin/kit-releases/${version}`, 'pablo.plataforma', release(version, b));
    const fileName = `den-node-kit-${version}.tar.gz`;
    const file = `/api/v1/kit/releases/${version}/${fileName}`;
    expect((await app.inject({ method: 'GET', url: file })).statusCode).toBe(404);

    // Who: anonymous 401 before the body is read, the reviewer 403, JSON 415.
    expect((await upload(version, b.bytes)).statusCode).toBe(401);
    expect((await upload(version, b.bytes, 'ana.operadora')).statusCode).toBe(403);
    expect((await upload(version, b.bytes, 'elena.admin')).statusCode).toBe(403);
    const json = await app.inject({
      method: 'PUT',
      url: `/api/v1/admin/kit-releases/${version}/bundle`,
      headers: await auth('pablo.plataforma'),
      payload: { bundle: 'no' },
    });
    expect(json.statusCode).toBe(415);
    expect((await upload(newVersion(), b.bytes, 'pablo.plataforma')).statusCode).toBe(404);

    // Not the declared bytes: another size, then the same size with other content.
    const shorter = await upload(version, b.bytes.subarray(1), 'pablo.plataforma');
    expect(shorter.statusCode).toBe(400);
    expect(shorter.json<{ errors: Array<{ key?: string }> }>().errors[0]?.key).toBe(
      FieldErrorKey.KitBundleSizeMismatch,
    );
    const tampered = Buffer.from(b.bytes);
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff;
    const other = await upload(version, tampered, 'pablo.plataforma');
    expect(other.statusCode).toBe(400);
    expect(other.json<{ errors: Array<{ key?: string }> }>().errors[0]?.key).toBe(
      FieldErrorKey.KitBundleChecksumMismatch,
    );

    const ok = await upload(version, b.bytes, 'pablo.plataforma');
    expect(ok.statusCode, ok.body).toBe(200);
    expect(
      kitReleaseListSchema.parse(ok.json()).items.find((r) => r.version === version),
    ).toMatchObject({ mirrored: true });
    const events = await auditOf(version);
    expect(events.at(-1)).toMatchObject({ action: 'kit_release.mirrored' });
    expect(events.at(-1)?.after).toMatchObject({ sha256: b.sha256, sizeBytes: b.bytes.length });

    // Once mirrored, the path never serves other bytes.
    const twice = await upload(version, b.bytes, 'pablo.plataforma');
    expect(twice.statusCode).toBe(409);
    expect(twice.json<{ errors: Array<{ key?: string }> }>().errors[0]?.key).toBe(
      FieldErrorKey.KitBundleMirrored,
    );
    const changed = await call('PUT', `/admin/kit-releases/${version}`, 'pablo.plataforma', {
      ...release(version, b),
      sha256: bundle().sha256,
    });
    expect(changed.statusCode).toBe(409);
    const signed = await call('PUT', `/admin/kit-releases/${version}`, 'pablo.plataforma', {
      ...release(version, b),
      signatureUrl: 'https://example.org/kit.sig',
    });
    expect(signed.statusCode, signed.body).toBe(200);

    // Anonymous download: the bytes, as a gzip attachment, cached for good, never sniffed.
    const download = await app.inject({ method: 'GET', url: file });
    expect(download.statusCode).toBe(200);
    expect(download.rawPayload.equals(b.bytes)).toBe(true);
    expect(download.headers['content-type']).toBe(KIT_BUNDLE_MEDIA_TYPE);
    expect(download.headers['content-length']).toBe(String(b.bytes.length));
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${fileName}"`);
    expect(download.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(download.headers['x-content-type-options']).toBe('nosniff');

    const checksum = await app.inject({ method: 'GET', url: `${file}.sha256` });
    expect(checksum.statusCode).toBe(200);
    expect(checksum.body).toBe(`${b.sha256}  ${fileName}\n`);
    expect(checksum.headers['content-type']).toMatch(/^text\/plain/);

    for (const path of [
      `/api/v1/kit/releases/${version}/other.tar.gz`,
      `/api/v1/kit/releases/${newVersion()}/${fileName}`,
    ]) {
      expect((await app.inject({ method: 'GET', url: path })).statusCode, path).toBe(404);
    }
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/kit/releases/latest/${fileName}` }))
        .statusCode,
    ).toBe(400);
    const current = currentKitReleaseSchema.parse((await call('GET', '/kit/current')).json());
    expect(current.release).toMatchObject({ version, mirrored: true });
  });
});
