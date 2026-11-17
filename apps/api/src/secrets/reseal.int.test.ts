import { randomBytes, randomUUID } from 'node:crypto';
import { loadCountryConfig } from '@rid/config';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuditService } from '../audit/audit.service.js';
import { open, seal } from '../common/secrets.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readRealmUsers } from '../seed/realm.js';
import { runSeed } from '../seed/seed.js';
import { resealAll } from './reseal.js';

const newKey = () => randomBytes(32).toString('base64');

/**
 * Rotation of RID_SECRETS_KEY (ASVS 11.1): values sealed with the old key are sealed again with
 * the new one, in the three places the portal keeps them, and the old key can then be retired.
 */
describe('resealing with a new RID_SECRETS_KEY', () => {
  const prisma = new PrismaService();
  const saved = {
    key: process.env.RID_SECRETS_KEY,
    previous: process.env.RID_SECRETS_KEYS_PREVIOUS,
  };
  const oldKey = newKey();
  const rotated = newKey();
  const ids = { credential: '', certificate: '', signingKey: '', kid: '', application: '' };

  beforeAll(async () => {
    await runSeed(prisma, new AuditService(), {
      config: loadCountryConfig({ code: 'co' }),
      realmUsers: readRealmUsers(),
    });
    // Everything already sealed in the test database stays readable during the test.
    process.env.RID_SECRETS_KEYS_PREVIOUS = saved.key ?? '';
    process.env.RID_SECRETS_KEY = oldKey;
    const entity = await prisma.entity.findFirstOrThrow({ where: { slug: 'programas-sociales' } });
    const run = randomUUID().slice(0, 8);
    const app = await prisma.application.create({
      data: {
        entityId: entity.id,
        name: `Resellado ${run}`,
        description: 'Prueba de rotación',
        environment: 'sandbox',
        keycloakClientId: `rid-app-reseal-${run}`,
        technicalContact: 'dev@example.org',
        createdBy: 'test',
      },
    });
    const credentialId = randomUUID();
    await prisma.credential.create({
      data: {
        id: credentialId,
        applicationId: app.id,
        kind: 'client_secret',
        secretHash: 'x',
        sealedSecret: seal('secreto-de-cliente', credentialId),
        createdBy: 'test',
      },
    });
    const certificateId = randomUUID();
    await prisma.gatewayCertificate.create({
      data: {
        id: certificateId,
        purpose: 'server',
        hosts: [`reseal-${run}.example`],
        certificatePem: 'pem',
        sealedKey: seal('clave-privada-tls', certificateId),
        fingerprint: run,
        notBefore: new Date(),
        notAfter: new Date(Date.now() + 86_400_000),
      },
    });
    const kid = `rid-gw-reseal-${run}`;
    const key = await prisma.gatewaySigningKey.create({
      data: {
        kid,
        publicJwk: {},
        sealedPrivateKey: seal('clave-de-firma', `gateway-signing-key:${kid}`),
        // Retired at once: it must not become the gateway's current key in other tests.
        retiredAt: new Date(),
      },
    });
    Object.assign(ids, {
      application: app.id,
      credential: credentialId,
      certificate: certificateId,
      signingKey: key.id,
      kid,
    });
  });
  afterEach(() => {
    process.env.RID_SECRETS_KEYS_PREVIOUS = saved.key ?? '';
  });
  afterAll(async () => {
    // Back to the environment's key for the suites that run after this one.
    process.env.RID_SECRETS_KEY = saved.key;
    process.env.RID_SECRETS_KEYS_PREVIOUS = `${rotated},${oldKey}`;
    await resealAll(prisma, new AuditService());
    // Its gateway rows go too: other suites read the gateway's certificates and the JWKS (the
    // API's role cannot delete credentials, by design; a sandbox client secret harms nothing).
    await prisma.gatewayCertificate.delete({ where: { id: ids.certificate } });
    await prisma.gatewaySigningKey.delete({ where: { id: ids.signingKey } });
    if (saved.previous === undefined) delete process.env.RID_SECRETS_KEYS_PREVIOUS;
    else process.env.RID_SECRETS_KEYS_PREVIOUS = saved.previous;
    await prisma.$disconnect();
  });

  const readAll = async () => {
    const credential = await prisma.credential.findUniqueOrThrow({ where: { id: ids.credential } });
    const certificate = await prisma.gatewayCertificate.findUniqueOrThrow({
      where: { id: ids.certificate },
    });
    const key = await prisma.gatewaySigningKey.findUniqueOrThrow({ where: { id: ids.signingKey } });
    return [
      open(credential.sealedSecret ?? '', ids.credential),
      open(certificate.sealedKey, ids.certificate),
      open(key.sealedPrivateKey, `gateway-signing-key:${ids.kid}`),
    ];
  };

  it('seals again with the new key, after which the old one can be retired', async () => {
    const before = await prisma.auditEvent.count({ where: { action: 'secrets.resealed' } });
    process.env.RID_SECRETS_KEY = rotated;
    process.env.RID_SECRETS_KEYS_PREVIOUS = [oldKey, saved.key].filter(Boolean).join(',');

    const summary = await resealAll(prisma, new AuditService());
    expect(summary.resealed.credential).toBeGreaterThanOrEqual(1);
    expect(summary.resealed.gatewayCertificate).toBeGreaterThanOrEqual(1);
    expect(summary.resealed.gatewaySigningKey).toBeGreaterThanOrEqual(1);
    const event = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'secrets.resealed' },
      orderBy: { seq: 'desc' },
    });
    expect(await prisma.auditEvent.count({ where: { action: 'secrets.resealed' } })).toBe(
      before + 1,
    );
    expect(event.after).toMatchObject({ keyId: summary.keyId });
    expect(JSON.stringify(event.after)).not.toContain(rotated);

    // The previous keys are gone: everything still opens with the new one alone.
    process.env.RID_SECRETS_KEYS_PREVIOUS = '';
    expect(await readAll()).toEqual(['secreto-de-cliente', 'clave-privada-tls', 'clave-de-firma']);

    // Idempotent: nothing left to reseal, no new event.
    const again = await resealAll(prisma, new AuditService());
    expect(Object.values(again.resealed)).toEqual([0, 0, 0]);
    expect(await prisma.auditEvent.count({ where: { action: 'secrets.resealed' } })).toBe(
      before + 1,
    );
  });

  it('stops, losing nothing, when no configured key opens a value', async () => {
    process.env.RID_SECRETS_KEY = newKey();
    process.env.RID_SECRETS_KEYS_PREVIOUS = '';
    await expect(resealAll(prisma, new AuditService())).rejects.toThrow(/neither RID_SECRETS_KEY/);
  });
});
