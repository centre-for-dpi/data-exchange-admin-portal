import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { citizenToken, myAccesses } from './citizen';
import { openRequestForm, publishNewApi, signIn } from './flows';
import {
  approveAsSteward,
  createGatewayApplication,
  gateway,
  gatewayFetch,
  gatewayToken,
  placesHolding,
  providerSaw,
  registeredCalls,
} from './gateway-flows';

// MT-02 (ADR-0015, ADR-0017): the gateway turns the data subject of every call into a keyed
// pseudonym, X-RID-Subject-Ref, reading it from the path or from the JSON body itself (never from
// a consumer claim). The provider gets the pseudonym only; an operation that declares a data
// subject is denied without one.
test.describe('data subject pseudonym at the gateway (MT-02)', () => {
  test('same person, same reference, wherever the identifier travels', async ({
    browser,
    page,
  }) => {
    test.setTimeout(300_000);
    const slug = `titular-${Date.now().toString(36)}`;
    const apiName = `Afiliación ${slug}`;
    await publishNewApi(browser, { slug, name: apiName });

    // carlos asks for both operations: the GET (subject in the path) and the POST (in the body).
    await signIn(page, 'carlos.dev', '/my-apps');
    const appName = `Verificador ${slug}`;
    const { clientId, clientSecret } = await createGatewayApplication(page, appName);
    await openRequestForm(page, apiName);
    await page.getByLabel(/^Aplicación que hará las llamadas/).selectOption({ label: appName });
    await page.getByLabel(/^Finalidad/).selectOption('eligibility_check');
    await page
      .getByLabel(/^Para qué usarás los datos/)
      .fill('Verificar afiliación al asignar el subsidio X.');
    await page
      .getByLabel(/^Base legal/)
      .fill('Ley de protección de datos, artículo 10, literal b.');
    await page.getByRole('checkbox', { name: /getAfiliado/ }).check();
    await page.getByRole('checkbox', { name: /verificarAfiliacion/ }).check();
    await page.getByLabel(/^Vigencia en meses/).fill('12');
    await page.getByRole('button', { name: 'Enviar solicitud' }).click();
    await expect(page.getByTestId('subscription-status')).toHaveText('Pendiente del proveedor');
    const subscriptionId = page.url().split('/my-apps/requests/')[1] ?? '';

    const steward = await (await browser.newContext()).newPage();
    await approveAsSteward(steward, subscriptionId);
    await steward.context().close();
    await page.goto(`/my-apps/requests/${subscriptionId}`);
    await expect(page.getByTestId('subscription-status')).toHaveText('Activa', { timeout: 60_000 });

    const token = await gatewayToken(clientId, clientSecret);
    const base = `${gateway}/salud/${slug}/v1/afiliados`;
    const since = new Date(Date.now() - 2_000).toISOString();
    const call = async (
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) => {
      const requestId = `mt02-${randomUUID()}`;
      const res = await gatewayFetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          'x-rid-purpose': 'eligibility_check',
          'x-rid-end-user': 'funcionario-42',
          'x-request-id': requestId,
          // A client cannot choose its own reference: the gateway overwrites it.
          'x-rid-subject-ref': 'forged-reference',
          ...init.headers,
        },
      });
      return { res, requestId };
    };
    const seenBy = async (requestId: string) => {
      await expect.poll(() => providerSaw(requestId, since), { timeout: 10_000 }).toBeDefined();
      return providerSaw(requestId, since) ?? {};
    };

    // Subject in the path.
    const byPath = await call('/1000000001');
    expect(byPath.res.status).toBe(200);
    const ref = (await seenBy(byPath.requestId))['x-rid-subject-ref'] ?? '';
    expect(ref).toMatch(/^[0-9a-f]{64}$/);

    // Same person, identifier in the body: the gateway reads it there (ADR-0017) and gets the same
    // reference. Whatever the consumer claims in headers about another person changes nothing,
    // and none of those values reaches the provider (the mock would log them, masked).
    const verify = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      call('/verificaciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    const byBody = await verify(
      { numeroIdentificacion: '1000000001' },
      { 'x-rid-body-subject': 'CC:1000000999', 'x-rid-data-subject': 'CC:1000000999' },
    );
    expect(byBody.res.status).toBe(200);
    const bodySeen = await seenBy(byBody.requestId);
    expect(bodySeen['x-rid-subject-ref']).toBe(ref);
    expect(bodySeen).not.toHaveProperty('x-rid-body-subject');
    expect(bodySeen).not.toHaveProperty('x-rid-data-subject');

    // A body without the identifier: the gateway does not know whose data it is, denied.
    const anonymous = await verify({});
    expect(anonymous.res.status).toBe(403);
    expect(anonymous.res.headers.get('x-rid-deny-reason')).toBe('data_subject_required');

    // Bodies the gateway and the provider could read as different people are denied too: a
    // repeated member name (parsers disagree on which wins), a body not declared as JSON, and a
    // colon in the number (it would let the consumer pick the document type).
    const ambiguous = [
      call('/verificaciones', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"numeroIdentificacion":"1000000001","numeroIdentificacion":"1000000002"}',
      }),
      call('/verificaciones', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ numeroIdentificacion: '1000000001' }),
      }),
      verify({ numeroIdentificacion: 'CE:1000000001' }),
    ];
    for (const { res } of await Promise.all(ambiguous)) {
      expect(res.status).toBe(403);
      expect(res.headers.get('x-rid-deny-reason')).toBe('data_subject_required');
    }
    // A JSON media type with parameters still counts as JSON, and the same name in different
    // objects is no repetition: the gateway lets it through (the strict mock provider then
    // rejects the extra member with 400, which is its call, not the gateway's).
    const nested = await call('/verificaciones', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ numeroIdentificacion: '1000000001', otros: { a: 1, b: [{ a: 2 }] } }),
    });
    expect(nested.res.status).toBe(400);
    expect(nested.res.headers.get('x-rid-deny-reason')).toBeNull();
    const withCharset = await verify(
      { numeroIdentificacion: '1000000001' },
      {
        'content-type': 'application/json; charset=utf-8',
      },
    );
    expect(withCharset.res.status).toBe(200);

    // Another person, another reference.
    const other = await call('/1000000002');
    expect(other.res.status).toBe(200);
    const otherRef = (await seenBy(other.requestId))['x-rid-subject-ref'];
    expect(otherRef).not.toBe(ref);

    // MT-03: a number never seen before, for a person the provider does not know (404). The call
    // still reached the provider, so it is registered, with the status the consumer got.
    const unseen = `7${String(Date.now()).slice(-9)}`;
    const unknown = await call(`/${unseen}`);
    expect(unknown.res.status).toBe(404);

    // Transparency register: every call that reached the provider, from the path or the body;
    // none of the denied ones. The citizen's pseudonym is the one the provider received.
    await expect.poll(() => registeredCalls(subscriptionId).length, { timeout: 30_000 }).toBe(6);
    const registered = registeredCalls(subscriptionId);
    expect(registered.map((r) => [r.operation, r.source, r.status])).toEqual([
      ['getAfiliado', 'path', 200],
      ['verificarAfiliacion', 'body', 200],
      ['verificarAfiliacion', 'body', 400],
      ['verificarAfiliacion', 'body', 200],
      ['getAfiliado', 'path', 200],
      ['getAfiliado', 'path', 404],
    ]);
    expect(registered.slice(0, 4).every((r) => r.subjectRef === ref)).toBe(true);
    expect(registered[4]?.subjectRef).toBe(otherRef);

    // The document number itself appears nowhere: gateway logs, pipeline logs and buffer, the
    // portal database (ADR-0015, golden rule 2).
    expect(placesHolding(unseen)).toEqual([]);

    // MT-05: the citizen behind 1000000001 logs in to the Carpeta with the (simulated) national
    // identity and sees exactly these calls: the portal derived the same pseudonym from the
    // verified document in the token as the gateway did from the request.
    const mine = (await myAccesses(await citizenToken('ciudadana.demo'))).filter(
      (a) => a.api?.name === apiName,
    );
    expect(mine.map((a) => [a.operation.id, a.status])).toEqual([
      ['verificarAfiliacion', 200],
      ['verificarAfiliacion', 400],
      ['verificarAfiliacion', 200],
      ['getAfiliado', 200],
    ]);
    // Andrés (1000000002) sees his one call; nobody sees the unknown number's.
    const his = (await myAccesses(await citizenToken('ciudadano.otro'))).filter(
      (a) => a.api?.name === apiName,
    );
    expect(his.map((a) => [a.operation.id, a.status])).toEqual([['getAfiliado', 200]]);
  });
});
