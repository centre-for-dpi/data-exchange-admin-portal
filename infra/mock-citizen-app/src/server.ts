import { createHash, randomBytes } from 'node:crypto';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { getCountryConfig } from '@rid/config';
import {
  certificatesInPem,
  type Receipt,
  type ReceiptVerification,
  verifyReceipt,
} from '@rid/transparency-verifier';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createRemoteJWKSet, type JSONWebKeySet, jwtVerify } from 'jose';
import { Webhook } from 'standardwebhooks';
import type { CitizenAppConfig } from './config.js';
import { CSS, html, type Html, page } from './html.js';
import { type Lang, langOf, MESSAGES, type Messages } from './i18n.js';
import type { AlertStore } from './store.js';

export interface Mailer {
  send(message: { to: string; subject: string; text: string }): Promise<void>;
}

interface Session {
  sub: string;
  accessToken: string;
  idToken: string;
  expiresAt: number;
  csrf: string;
}

interface PendingLogin {
  verifier: string;
  nonce: string;
  createdAt: number;
}

interface Access {
  id: string;
  occurredAt: string;
  consumer: { entity: { name: string; shortName: string } | null; application: string | null };
  provider: { name: string; shortName: string } | null;
  api: { name: string; version: string } | null;
  operation: { id: string; summary: string | null };
  purpose: { code: string; name: string | Record<string, string> | null };
  data: Array<{ name: string; personal: boolean; sensitive: boolean }>;
  officialRef: string | null;
  status: number;
  sealed: boolean;
}

const SESSION_COOKIE = 'citizen_session';
const LOGIN_TTL_MS = 10 * 60 * 1000;
const PUBLIC_MATERIAL_TTL_MS = 5 * 60 * 1000;

class SessionExpired extends Error {}

/**
 * The reference citizen folder (MT-07). Server-rendered and dependency-light on purpose: it
 * shows what any citizen app needs to do with the portal, nothing more.
 *  - Signs the citizen in with the national identity (code + PKCE, confidential client) and
 *    keeps the tokens server side.
 *  - Lists the consultations of the citizen's data through the citizen API.
 *  - Lets the citizen turn on notices: the folder keeps the email and maps the portal's opaque
 *    alert id to its user; signed webhooks (Standard Webhooks, verified with the reference
 *    library) become emails (Mailpit in development).
 *  - Verifies each receipt by itself with public material: the operator's JWKS and the TSA's
 *    certificate chain.
 */
export function buildServer(
  config: CitizenAppConfig,
  deps: { store: AlertStore; mailer: Mailer; fetch?: typeof fetch },
): FastifyInstance {
  const fetchFn = deps.fetch ?? fetch;
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: true });
  const sessions = new Map<string, Session>();
  const logins = new Map<string, PendingLogin>();
  const secure = config.publicUrl.startsWith('https://');
  const base = config.basePath;
  const oidc = {
    authorize: `${config.oidc.issuer}/protocol/openid-connect/auth`,
    logout: `${config.oidc.issuer}/protocol/openid-connect/logout`,
    token: `${config.oidc.internalUrl}/protocol/openid-connect/token`,
    jwks: createRemoteJWKSet(new URL(`${config.oidc.internalUrl}/protocol/openid-connect/certs`)),
  };
  const webhook = new Webhook(config.webhookSecret);
  const country = getCountryConfig();
  const formatDate = (iso: string, lang: Lang) =>
    new Intl.DateTimeFormat(lang, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: country.country.timezone,
    }).format(new Date(iso));

  void app.register(cookie);
  void app.register(formbody);
  // Webhooks are verified over the exact bytes received.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header(
      'content-security-policy',
      "default-src 'self'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });

  const langFor = (request: FastifyRequest, reply: FastifyReply): Lang => {
    const asked = (request.query as { lang?: string } | undefined)?.lang;
    if (asked === 'es' || asked === 'en') {
      void reply.setCookie('lang', asked, { path: base || '/', sameSite: 'lax', secure });
      return asked;
    }
    return langOf(request.cookies.lang);
  };
  const sessionOf = (request: FastifyRequest): Session | undefined => {
    const session = sessions.get(request.cookies[SESSION_COOKIE] ?? '');
    return session && session.expiresAt > Date.now() ? session : undefined;
  };
  const render = (
    reply: FastifyReply,
    lang: Lang,
    o: { title: string; path: string; signedIn: boolean; body: Html; status?: number },
  ) =>
    reply
      .code(o.status ?? 200)
      .type('text/html; charset=utf-8')
      .send(
        page({
          lang,
          title: o.title,
          appName: config.name[lang],
          basePath: base,
          path: o.path,
          signedIn: o.signedIn,
          body: o.body,
        }),
      );

  /** GET/PUT on the portal's citizen API with the citizen's own token. */
  const portal = async (session: Session, path: string, init: RequestInit = {}) => {
    const res = await fetchFn(`${config.portal.apiUrl}/api/v1/data-subjects/me${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (res.status === 401) throw new SessionExpired();
    return res;
  };

  let material: { at: number; jwks: JSONWebKeySet; roots: string[] } | undefined;
  const publicMaterial = async () => {
    if (material && Date.now() - material.at < PUBLIC_MATERIAL_TTL_MS) return material;
    const [jwks, chain] = await Promise.all([
      fetchFn(config.portal.jwksUrl).then((r) => r.json() as Promise<JSONWebKeySet>),
      fetchFn(config.portal.tsaRootUrl).then((r) => r.text()),
    ]);
    material = { at: Date.now(), jwks, roots: certificatesInPem(chain) };
    return material;
  };

  // Liveness at the root too, for the container health check behind a path prefix.
  if (base) app.get('/health', () => Promise.resolve({ status: 'ok' }));

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof SessionExpired) {
      if (request.cookies[SESSION_COOKIE]) sessions.delete(request.cookies[SESSION_COOKIE]);
      return reply.redirect(`${base}/login`);
    }
    request.log.error(error);
    return reply.code(500).type('text/plain').send('Error');
  });

  void app.register(
    (routes, _opts, done) => {
      routes.get('/health', () => Promise.resolve({ status: 'ok' }));
      routes.get('/static/app.css', (_req, reply) => reply.type('text/css').send(CSS));

      routes.get('/', async (request, reply) => {
        const lang = langFor(request, reply);
        if (sessionOf(request)) return reply.redirect(`${base}/consultas`);
        const t = MESSAGES[lang];
        return render(reply, lang, {
          title: t.landingTitle,
          path: '/',
          signedIn: false,
          body: html`<h1>${t.landingTitle}</h1>
            <p>${t.landingLead}</p>
            <p><a class="button" href="${base}/login">${t.signIn}</a></p>
            <p class="muted">${t.landingNote}</p>`,
        });
      });

      routes.get('/login', async (_request, reply) => {
        const state = randomBytes(16).toString('base64url');
        const verifier = randomBytes(32).toString('base64url');
        const nonce = randomBytes(16).toString('base64url');
        for (const [key, login] of logins) {
          if (Date.now() - login.createdAt > LOGIN_TTL_MS) logins.delete(key);
        }
        logins.set(state, { verifier, nonce, createdAt: Date.now() });
        const params = new URLSearchParams({
          client_id: config.oidc.clientId,
          response_type: 'code',
          scope: 'openid',
          redirect_uri: `${config.publicUrl}/auth/callback`,
          state,
          nonce,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        });
        return reply.redirect(`${oidc.authorize}?${params.toString()}`);
      });

      routes.get('/auth/callback', async (request, reply) => {
        const { code, state } = request.query as { code?: string; state?: string };
        const login = logins.get(state ?? '');
        logins.delete(state ?? '');
        if (!code || !login || Date.now() - login.createdAt > LOGIN_TTL_MS) {
          return reply.redirect(`${base}/`);
        }
        const res = await fetchFn(oidc.token, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: `Basic ${Buffer.from(
              `${encodeURIComponent(config.oidc.clientId)}:${encodeURIComponent(config.oidc.clientSecret)}`,
            ).toString('base64')}`,
          },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: `${config.publicUrl}/auth/callback`,
            code_verifier: login.verifier,
          }),
        });
        if (!res.ok) return reply.redirect(`${base}/`);
        const tokens = (await res.json()) as {
          access_token: string;
          id_token: string;
          expires_in: number;
        };
        const { payload } = await jwtVerify(tokens.id_token, oidc.jwks, {
          issuer: config.oidc.issuer,
          audience: config.oidc.clientId,
        });
        if (payload.nonce !== login.nonce || !payload.sub) return reply.redirect(`${base}/`);
        const sid = randomBytes(32).toString('base64url');
        sessions.set(sid, {
          sub: payload.sub,
          accessToken: tokens.access_token,
          idToken: tokens.id_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
          csrf: randomBytes(16).toString('base64url'),
        });
        void reply.setCookie(SESSION_COOKIE, sid, {
          path: base || '/',
          httpOnly: true,
          sameSite: 'lax',
          secure,
        });
        return reply.redirect(`${base}/consultas`);
      });

      routes.post('/logout', async (request, reply) => {
        const session = sessionOf(request);
        sessions.delete(request.cookies[SESSION_COOKIE] ?? '');
        void reply.clearCookie(SESSION_COOKIE, { path: base || '/' });
        if (!session) return reply.redirect(`${base}/`);
        const params = new URLSearchParams({
          id_token_hint: session.idToken,
          post_logout_redirect_uri: `${config.publicUrl}/`,
        });
        return reply.redirect(`${oidc.logout}?${params.toString()}`);
      });

      routes.get('/consultas', async (request, reply) => {
        const lang = langFor(request, reply);
        const session = sessionOf(request);
        if (!session) return reply.redirect(`${base}/login`);
        const t = MESSAGES[lang];
        const [accessesRes, alertsRes] = await Promise.all([
          portal(session, '/accesses?limit=100'),
          portal(session, '/alerts'),
        ]);
        const { items } = (await accessesRes.json()) as { items: Access[] };
        const alerts = (await alertsRes.json()) as { classifications: string[] };
        const flash = (request.query as { saved?: string }).saved;
        return render(reply, lang, {
          title: t.accessesTitle,
          path: '/consultas',
          signedIn: true,
          body: html`<h1>${t.accessesTitle}</h1>
            <p>${t.accessesLead}</p>
            ${items.length === 0 ? html`<p>${t.accessesEmpty}</p>` : accessesTable(items, lang, t)}
            ${alertsForm(session, alerts.classifications, deps.store.emailOf(session.sub) ?? '', t, flash)}`,
        });
      });

      routes.post('/avisos', async (request, reply) => {
        const lang = langFor(request, reply);
        const session = sessionOf(request);
        if (!session) return reply.redirect(`${base}/login`);
        const form = request.body as Record<string, string | string[] | undefined>;
        if (form.csrf !== session.csrf) return reply.code(403).send('Forbidden');
        const classifications = [form.personal && 'personal', form.sensitive && 'sensitive'].filter(
          (c): c is string => Boolean(c),
        );
        const email = typeof form.email === 'string' ? form.email.trim() : '';
        if (classifications.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return reply.redirect(`${base}/consultas?saved=email`);
        }
        const res = await portal(session, '/alerts', {
          method: 'PUT',
          body: JSON.stringify({ classifications }),
        });
        if (!res.ok) throw new Error(`alerts: ${res.status}`);
        const saved = (await res.json()) as { alertId: string };
        if (classifications.length > 0) deps.store.set(saved.alertId, { sub: session.sub, email });
        else deps.store.delete(saved.alertId);
        void lang;
        return reply.redirect(
          `${base}/consultas?saved=${classifications.length > 0 ? 'on' : 'off'}`,
        );
      });

      routes.get('/consultas/:id/comprobante', async (request, reply) => {
        const lang = langFor(request, reply);
        const session = sessionOf(request);
        if (!session) return reply.redirect(`${base}/login`);
        const t = MESSAGES[lang];
        const { id } = request.params as { id: string };
        if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send('Not found');
        const res = await portal(session, `/accesses/${id}/receipt`);
        if (res.status === 404 || res.status === 409) return reply.redirect(`${base}/consultas`);
        const receipt = (await res.json()) as Receipt;
        const { jwks, roots } = await publicMaterial();
        const result = await verifyReceipt(receipt, {
          jwks,
          tsaRoots: roots,
          allowPendingTimestamp: true,
        });
        return render(reply, lang, {
          title: t.receiptTitle,
          path: `/consultas/${id}/comprobante`,
          signedIn: true,
          body: receiptView(id, result, lang, t),
        });
      });

      routes.get('/consultas/:id/comprobante.json', async (request, reply) => {
        const session = sessionOf(request);
        if (!session) return reply.redirect(`${base}/login`);
        const { id } = request.params as { id: string };
        if (!/^[0-9a-f-]{36}$/.test(id)) return reply.code(404).send('Not found');
        const res = await portal(session, `/accesses/${id}/receipt`);
        return reply
          .code(res.status)
          .type('application/json')
          .header('content-disposition', `attachment; filename="comprobante-${id}.json"`)
          .send(await res.text());
      });

      // Notices from the portal (MT-06): Standard Webhooks, verified with the reference library.
      routes.post('/api/rid/alerts', async (request, reply) => {
        const body = typeof request.body === 'string' ? request.body : '';
        let message: {
          type?: string;
          data?: { alertId?: string; occurredAt?: string; classification?: string };
        };
        try {
          message = webhook.verify(
            body,
            request.headers as Record<string, string>,
          ) as typeof message;
        } catch {
          return reply.code(401).send({ error: 'invalid signature' });
        }
        const webhookId = String(request.headers['webhook-id']);
        if (message.type !== 'subject_access.created' || !deps.store.firstTime(webhookId)) {
          return reply.code(204).send();
        }
        const owner = deps.store.ownerOf(message.data?.alertId ?? '');
        // Unknown alert: the user turned notices off here; nothing to tell anyone.
        if (!owner) return reply.code(204).send();
        const lang: Lang = 'es';
        const t = MESSAGES[lang];
        await deps.mailer.send({
          to: owner.email,
          subject: t.mailSubject,
          text: t.mailBody
            .replace(
              '{date}',
              formatDate(message.data?.occurredAt ?? new Date().toISOString(), lang),
            )
            .replace(
              '{classification}',
              message.data?.classification === 'sensitive' ? t.classSensitive : t.classPersonal,
            )
            .replace('{link}', `${config.publicUrl}/consultas`),
        });
        return reply.code(204).send();
      });
      done();
    },
    { prefix: base },
  );

  function accessesTable(items: Access[], lang: Lang, t: Messages): Html {
    const result = (status: number) =>
      status >= 200 && status < 300
        ? t.resultAnswered
        : status === 404
          ? t.resultNotFound
          : status >= 400 && status < 500
            ? t.resultRejected
            : t.resultError;
    const purpose = (p: Access['purpose']) =>
      typeof p.name === 'string' ? p.name : (p.name?.[lang] ?? p.name?.es ?? p.code);
    const rows = items.map(
      (a) =>
        html`<tr>
          <td><time datetime="${a.occurredAt}">${formatDate(a.occurredAt, lang)}</time></td>
          <td>
            ${a.consumer.entity?.shortName ?? '—'}${a.consumer.application ? html`<br /><span class="muted">${a.consumer.application}</span>` : ''}${a.officialRef ? html`<br /><span class="muted">${t.official}: <code>${a.officialRef.slice(0, 12)}</code></span>` : ''}
          </td>
          <td>${a.provider?.shortName ?? '—'}</td>
          <td>
            ${a.api?.name ?? a.operation.id}${a.operation.summary ? html`<br /><span class="muted">${a.operation.summary}</span>` : ''}${a.data.length ? html`<br /><span class="muted">${a.data.map((d) => d.name).join(', ')}</span>` : ''}
          </td>
          <td>${purpose(a.purpose)}</td>
          <td>${result(a.status)}</td>
          <td>
            ${a.sealed ? html`<a href="${base}/consultas/${a.id}/comprobante">${t.verify}<span class="visually-hidden"> ${formatDate(a.occurredAt, lang)}</span></a>` : html`<span class="muted">${t.sealing}</span>`}
          </td>
        </tr>`,
    );
    return html`<div class="table-wrap">
      <table>
        <caption>
          ${t.accessesCaption}
        </caption>
        <thead>
          <tr>
            <th scope="col">${t.colWhen}</th>
            <th scope="col">${t.colWho}</th>
            <th scope="col">${t.colProvider}</th>
            <th scope="col">${t.colWhat}</th>
            <th scope="col">${t.colWhy}</th>
            <th scope="col">${t.colResult}</th>
            <th scope="col">${t.colReceipt}</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>`;
  }

  function alertsForm(
    session: Session,
    current: string[],
    email: string,
    t: Messages,
    flash: string | undefined,
  ): Html {
    const checked = (c: string) => (current.includes(c) ? html` checked` : '');
    const message =
      flash === 'on'
        ? t.alertsSaved
        : flash === 'off'
          ? t.alertsOff
          : flash === 'email'
            ? t.alertsEmailRequired
            : '';
    return html`<section aria-labelledby="alerts-title">
      <h2 id="alerts-title">${t.alertsTitle}</h2>
      <p>${t.alertsLead}</p>
      ${message ? html`<p class="status${flash === 'email' ? ' bad' : ' ok'}" role="status">${message}</p>` : ''}
      <form method="post" action="${base}/avisos">
        <input type="hidden" name="csrf" value="${session.csrf}" />
        <fieldset>
          <legend>${t.alertsTitle}</legend>
          <label
            ><input type="checkbox" name="personal" value="1" ${checked('personal')} />
            ${t.alertsPersonal}</label
          >
          <label
            ><input type="checkbox" name="sensitive" value="1" ${checked('sensitive')} />
            ${t.alertsSensitive}</label
          >
          <label for="email">${t.alertsEmail}</label>
          <input type="email" id="email" name="email" autocomplete="email" value="${email}" />
        </fieldset>
        <p><button class="button" type="submit">${t.alertsSave}</button></p>
      </form>
    </section>`;
  }

  function receiptView(id: string, r: ReceiptVerification, lang: Lang, t: Messages): Html {
    const state = (ok: boolean | string) =>
      ok === true || ok === 'valid' ? t.ok : ok === 'pending' ? t.pending : t.failed;
    const headline = r.valid
      ? r.checks.timestamp === 'pending'
        ? t.receiptPending
        : t.receiptValid
      : t.receiptInvalid;
    return html`<h1>${t.receiptTitle}</h1>
      <p class="status ${r.valid ? 'ok' : 'bad'}" role="status" data-testid="receipt-status">
        ${headline}
      </p>
      <p>${t.receiptLead}</p>
      <ul>
        <li>${t.checkSignature}: ${state(r.checks.signature)}</li>
        <li>${t.checkInclusion}: ${state(r.checks.inclusion)}</li>
        <li>
          ${t.checkTimestamp}:
          ${state(r.checks.timestamp)}${r.stampedAt ? html` · ${t.stampedAt} <time datetime="${r.stampedAt}">${formatDate(r.stampedAt, lang)}</time>` : ''}
        </li>
      </ul>
      <p><a href="${base}/consultas/${id}/comprobante.json">${t.download}</a></p>
      <p>
        ${t.cli}<br /><code
          >rid-verify-receipt comprobante-${id}.json --jwks ${config.portal.jwksUrl} --tsa-root
          ${config.portal.tsaRootUrl}</code
        >
      </p>
      <p><a href="${base}/consultas">${t.back}</a></p>`;
  }

  return app;
}
