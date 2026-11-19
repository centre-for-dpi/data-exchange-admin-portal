import { randomBytes, randomUUID } from 'node:crypto';
import { Webhook } from 'standardwebhooks';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CitizenAppConfig } from './config.js';
import { html } from './html.js';
import { type Mailer, buildServer } from './server.js';
import { AlertStore } from './store.js';

const secret = `whsec_${randomBytes(32).toString('base64')}`;
const config: CitizenAppConfig = {
  publicUrl: 'https://citizen-app.test/citizen-app',
  basePath: '/citizen-app',
  port: 0,
  name: { es: 'Aplicación de prueba', en: 'Test app' },
  oidc: {
    issuer: 'https://identity.test/realms/den-citizens',
    internalUrl: 'https://identity.test/realms/den-citizens',
    clientId: 'citizen-app',
    clientSecret: 'secret',
  },
  portal: {
    apiUrl: 'https://portal.test',
    jwksUrl: 'https://portal.test/api/v1/transparency/jwks',
    tsaRootUrl: 'https://tsa.test/api/v1/timestamp/certchain',
    tsaRootsFile: null,
  },
  webhookSecret: secret,
  smtp: { host: 'localhost', port: 1025, from: 'avisos@citizen-app.test' },
  dataFile: '',
};

describe('reference citizen app (MT-07)', () => {
  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mailer: Mailer = {
    send: (m) => {
      sent.push(m);
      return Promise.resolve();
    },
  };
  const store = new AlertStore(null);
  const alertId = randomUUID();
  const app = buildServer(config, { store, mailer });

  beforeAll(async () => {
    process.env.DEN_COUNTRY ??= 'co';
    store.set(alertId, { sub: 'citizen-1', email: 'valentina@example.test' });
    await app.ready();
  });

  const notice = (overrides: { secret?: string; id?: string; alert?: string } = {}) => {
    const id = overrides.id ?? `msg_${randomUUID()}`;
    const body = JSON.stringify({
      type: 'subject_access.created',
      timestamp: new Date().toISOString(),
      data: {
        alertId: overrides.alert ?? alertId,
        accessId: randomUUID(),
        occurredAt: '2026-11-13T15:00:00.000Z',
        classification: 'sensitive',
      },
    });
    const now = new Date();
    const signature = new Webhook(overrides.secret ?? secret).sign(id, now, body);
    return app.inject({
      method: 'POST',
      url: '/citizen-app/api/den/alerts',
      headers: {
        'content-type': 'application/json',
        'webhook-id': id,
        'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
        'webhook-signature': signature,
      },
      payload: body,
    });
  };

  it('turns a signed notice into one email with no details of the consultation', async () => {
    sent.length = 0;
    const id = `msg_${randomUUID()}`;
    expect((await notice({ id })).statusCode).toBe(204);
    expect((await notice({ id })).statusCode).toBe(204); // retry of the same message
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: 'valentina@example.test' });
    expect(sent[0]?.text).toContain('https://citizen-app.test/citizen-app/consultas');
    expect(sent[0]?.text).toContain('datos sensibles');
    expect(sent[0]?.text).not.toContain(alertId);
  });

  it('rejects notices it cannot verify and ignores alerts it does not know', async () => {
    sent.length = 0;
    expect(
      (await notice({ secret: `whsec_${randomBytes(32).toString('base64')}` })).statusCode,
    ).toBe(401);
    expect((await notice({ alert: randomUUID() })).statusCode).toBe(204);
    expect(sent).toEqual([]);
  });

  it('serves its pages under the base path, and asks to sign in for the private ones', async () => {
    const home = await app.inject({ url: '/citizen-app/' });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('<html lang="es">');
    expect(home.headers['content-security-policy']).toContain("default-src 'self'");
    expect((await app.inject({ url: '/citizen-app/?lang=en' })).body).toContain('<html lang="en">');
    const consultations = await app.inject({ url: '/citizen-app/consultas' });
    expect(consultations.statusCode).toBe(302);
    expect(consultations.headers.location).toBe('/citizen-app/login');
    const login = await app.inject({ url: '/citizen-app/login' });
    const target = new URL(login.headers.location ?? '');
    expect(target.origin + target.pathname).toBe(
      'https://identity.test/realms/den-citizens/protocol/openid-connect/auth',
    );
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('redirect_uri')).toBe(
      'https://citizen-app.test/citizen-app/auth/callback',
    );
  });

  it('accepts a sign-in callback only in the browser that started it (login CSRF)', async () => {
    const login = await app.inject({ url: '/citizen-app/login' });
    const state = new URL(login.headers.location ?? '').searchParams.get('state') ?? '';
    const cookie = login.cookies.find((c) => c.name === 'citizen_login');
    expect(cookie).toMatchObject({ value: state, httpOnly: true, sameSite: 'Lax' });
    // Another browser (no cookie) arriving with this state and a code is sent home, signed out.
    const forged = await app.inject({ url: `/citizen-app/auth/callback?state=${state}&code=x` });
    expect(forged.statusCode).toBe(302);
    expect(forged.headers.location).toBe('/citizen-app/');
    expect(forged.cookies.find((c) => c.name === 'citizen_session')).toBeUndefined();
  });

  it('escapes everything it renders', () => {
    expect(html`<p>${'<script>alert(1)</script>'}</p>`.value).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>',
    );
  });
});
