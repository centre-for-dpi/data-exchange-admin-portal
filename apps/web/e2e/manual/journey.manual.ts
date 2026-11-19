import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Browser, type Locator, type Page, test } from '@playwright/test';
import { makeCsr } from '../csr';
import { signIn } from '../flows';
import {
  gateway,
  gatewayFetch,
  gatewayToken,
  rememberCertificate,
  untilCertificateKnown,
} from '../gateway-flows';
import { mockNodeLogs, startMockNode } from '../mock-node';
import { lang, localePath, t, ui } from './i18n';
import {
  enrollTotp,
  ensureSignedIn,
  newPersonPage,
  peopleOf,
  type Person,
  register,
} from './people';
import { shot, writeManifest } from './shots';

// The user manual's screenshots (docs/guides/user-manual.md): the walkthrough's path, done by
// fresh synthetic people on a freshly reset local stack, one screenshot per step. Run it with
// `pnpm docs:manual --yes`, which resets the stack first.
//
// MANUAL_SUFFIX (development only) appends a suffix to every name, identifier and e-mail and skips
// the check for a clean stack, so the journey can be re-run while it is being written.

const suffix = process.env.MANUAL_SUFFIX ?? '';
const tag = (value: string, sep = '-') => (suffix ? `${value}${sep}${suffix}` : value);

const EXAMPLES = {
  es: {
    provider: 'Civil Registry',
    consumer: 'Ministerio de Bienestar de Wakanda',
    api: 'Certificado de afiliación',
    apiSummary: 'Certifica la afiliación de una persona a la seguridad social.',
    apiDescription: 'Responde, por número de documento, el régimen, la EPS y el estado.',
    app: 'Verificador de subsidios',
    appUse: 'Verifica requisitos de los subsidios del ministerio.',
    use: 'Verificar la afiliación al asignar el subsidio de vivienda.',
    legalBasis: 'Ley de protección de datos, artículo 10, literal b.',
    reason: 'Equipo de revisión del operador',
  },
  en: {
    provider: 'Civil Registry',
    consumer: 'Ministry of Welfare of Wakanda',
    api: 'Affiliation certificate',
    apiSummary: "Certifies a person's affiliation to social security.",
    apiDescription: 'Answers, by document number, the regime, the health insurer and the status.',
    app: 'Subsidy checker',
    appUse: "Checks the requirements of the ministry's subsidies.",
    use: 'Check the affiliation when granting the housing subsidy.',
    legalBasis: 'Data protection law, article 10, letter b.',
    reason: "Operator's review team",
  },
}[lang];

interface Org {
  name: string;
  slug: string;
  taxId: string;
  domain: string;
  website: string;
}
const digits = suffix.replace(/\D/g, '').slice(0, 5);
const provider: Org = {
  name: tag(EXAMPLES.provider, ' '),
  slug: tag('civil-registry'),
  taxId: suffix ? `9001${digits}` : '900000100',
  domain: 'civil-registry.example',
  website: 'https://civil-registry.example',
};
const consumer: Org = {
  name: tag(EXAMPLES.consumer, ' '),
  slug: tag('bienestar-wakanda'),
  taxId: suffix ? `9002${digits}` : '900000200',
  domain: 'bienestar-wakanda.example',
  website: 'https://bienestar-wakanda.example',
};
const apiSlug = tag('certificados-afiliacion');
const apiName = tag(EXAMPLES.api, ' ');
const nodeName = tag('nodo-principal');
const people = peopleOf(lang, suffix);

/** A tiny designation document: the portal stores it and its SHA-256, it does not read it. */
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n');
/** The contract the simulated node serves (infra/mock-providers/salud). */
const openapiFile = resolve(
  import.meta.dirname,
  '../../../../infra/mock-providers/salud/openapi.yaml',
);

const L = (es: string) => ui(lang, es);
const startsWith = (text: string) => new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
/** A form field by the start of its label (required fields add "(Required)" to it). */
const field = (scope: Page | Locator, es: string) => scope.getByLabel(startsWith(L(es)));
const button = (scope: Page | Locator, es: string) =>
  scope.getByRole('button', { name: L(es), exact: true });
const h1 = (page: Page) => page.getByRole('heading', { level: 1 });
/** A heading and the block right after it (a table or a form under its title). */
const headed = (page: Page, es: string): Locator =>
  page
    .getByRole('heading', { name: L(es), exact: true })
    .first()
    .locator('xpath=ancestor::*[self::section or self::form][1]');
/** The card of a Keycloak page (title and form), whatever the theme's version. */
const keycloakCard = (page: Page) =>
  page.locator('.pf-v5-c-login__main, .pf-c-login__main, #kc-content').first();

/** Reloads until `check` passes: background work (validations, node, gateway) takes a while. */
async function until(page: Page, check: () => Promise<void>, timeout = 180_000) {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout, intervals: [3_000] });
}

/** Slugs of the manual's entities already in the database (an onboarding request is an entity too). */
function existingSlugs(): string {
  const slugs = `'${provider.slug}','${consumer.slug}'`;
  return execFileSync(
    'docker',
    [
      'exec',
      'den-postgres-1',
      'psql',
      '-U',
      process.env.POSTGRES_USER ?? 'den',
      '-d',
      process.env.POSTGRES_DB ?? 'den',
      '-tAc',
      `select slug from entity where slug in (${slugs})`,
    ],
    { encoding: 'utf8' },
  ).trim();
}

/**
 * A seed user (operator, platform administrator) signed in on a fresh context. Keycloak's login
 * page sometimes stalls on a loaded laptop: a stalled attempt is retried on a new context.
 */
async function seedUserPage(browser: Browser, username: string, path: string): Promise<Page> {
  for (let attempt = 1; ; attempt += 1) {
    const page = await newPersonPage(browser, lang);
    try {
      await signIn(page, username, localePath(lang, path));
      return page;
    } catch (error) {
      await page.context().close();
      if (attempt === 3) throw error;
    }
  }
}

/** The applicant fills the onboarding request, uploads the document and sends it to review. */
async function requestOnboarding(
  applicant: Person,
  org: Org,
  steward: Person,
  lead: Person,
  shots: boolean,
) {
  const page = await ensureSignedIn(lang, applicant, '/entity-requests/new');
  await field(page, 'Nombre legal').fill(org.name);
  await field(page, 'Nombre corto').fill(org.name);
  await page.locator('main [name="slug"]').fill(org.slug);
  await field(page, 'Número de identificación').fill(org.taxId);
  await field(page, 'Correo de contacto de la entidad').fill(`contacto@${org.domain}`);
  await page.locator('main [name="website"]').fill(org.website);
  await page.locator('main [name="dpoName"]').fill('Dora Protección');
  await page.locator('main [name="dpoEmail"]').fill(`dpo@${org.domain}`);
  const stewardEmail = page.locator('main [name="designees.data_steward.email"]');
  const leadEmail = page.locator('main [name="designees.technical_lead.email"]');
  await page
    .locator('[name="designees.data_steward.fullName"]')
    .fill(`${steward.firstName} ${steward.lastName}`);
  await stewardEmail.fill(steward.email);
  await page
    .locator('[name="designees.technical_lead.fullName"]')
    .fill(`${lead.firstName} ${lead.lastName}`);
  await leadEmail.fill(lead.email);
  const create = button(page, 'Crear la solicitud');
  if (shots) {
    await shot(page, lang, '04-entity-request-form', {
      region: [h1(page), page.locator('main form').first()],
      hotspots: [page.locator('main [name="slug"]'), stewardEmail, leadEmail, create],
    });
  }
  await create.click();
  await page.waitForURL(/\/entity-requests\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const requestUrl = page.url();
  await field(page, 'Documento de designación (PDF)').setInputFiles({
    name: 'designacion.pdf',
    mimeType: 'application/pdf',
    buffer: PDF,
  });
  await button(page, 'Subir documento').click();
  const document = page.getByRole('link', { name: 'designacion.pdf' });
  await expect(document).toBeVisible();
  const submit = button(page, 'Enviar a revisión');
  if (shots) {
    await shot(page, lang, '05-entity-request-submit', { hotspots: [document, submit] });
  }
  await submit.click();
  await expect(page.getByText(L('En revisión'), { exact: true }).first()).toBeVisible();
  return requestUrl;
}

/** The operator's reviewer approves an onboarding request from the console. */
async function approveOnboarding(browser: Browser, org: Org, shots: boolean) {
  const operator = await seedUserPage(browser, 'ana.operadora', '/operator');
  const queue = headed(operator, 'Altas de entidades por revisar');
  const link = operator.getByRole('link', { name: org.name, exact: true });
  if (shots) {
    await shot(operator, lang, '06-operator-onboarding-list', { region: queue, hotspots: [link] });
  }
  await link.click();
  const approve = button(operator, 'Aprobar el alta');
  if (shots) {
    await shot(operator, lang, '07-operator-onboarding-decision', {
      region: headed(operator, 'Decisión del operador'),
      hotspots: [approve],
    });
  }
  await approve.click();
  await expect(
    operator.getByText(L('Esta solicitud no está esperando una decisión.')),
  ).toBeVisible();
  await operator.context().close();
}

test('the user manual, step by step', async ({ browser }) => {
  const { rosa, diego, tomas, wanda } = people;

  await test.step('the stack is fresh', () => {
    if (suffix) return;
    if (existingSlugs()) throw new Error('reset the stack first (pnpm docs:manual --yes)');
  });

  await test.step('1. the provider administrator registers', async () => {
    const page = await register(browser, lang, rosa, async (form) => {
      await shot(form, lang, '01-register', {
        region: keycloakCard(form),
        hotspots: [
          form.locator('#email'),
          form.locator('#firstName'),
          form.locator('#kc-register-form [type="submit"]'),
        ],
        pad: 24,
      });
    });
    await page.goto(localePath(lang, '/'));
    const onboarding = page.getByRole('link', { name: new RegExp(L('Alta de entidades')) }).first();
    await expect(onboarding).toBeVisible();
    await shot(page, lang, '02-no-roles', { hotspots: [onboarding] });
  });

  await test.step('1. platform roles from the operator console', async () => {
    const admin = await seedUserPage(browser, 'pablo.plataforma', '/operator/platform-users');
    const grant = admin.getByRole('form', { name: L('Dar un rol') });
    await grant.getByLabel(L('Correo electrónico')).fill('revision@operador.example');
    await grant.getByLabel(L('Rol')).selectOption('platform_reviewer');
    await grant.getByLabel(L('Motivo')).fill(EXAMPLES.reason);
    await shot(admin, lang, '03-platform-roles', {
      region: grant,
      hotspots: [
        grant.getByLabel(L('Correo electrónico')),
        grant.getByLabel(L('Rol')),
        grant.getByLabel(L('Motivo')),
        button(grant, 'Dar el rol'),
      ],
    });
    await admin.context().close();
  });

  let requestUrl = '';
  await test.step('2. the provider asks for its onboarding', async () => {
    requestUrl = await requestOnboarding(rosa, provider, diego, tomas, true);
  });

  await test.step('3. the operator approves the onboarding', async () => {
    await approveOnboarding(browser, provider, true);
  });

  await test.step('4. the administrator sets up the second factor', async () => {
    const page = rosa.page as Page;
    await page.goto(requestUrl);
    await enrollTotp(page, rosa, async (form) => {
      const qr = form.locator('#kc-totp-secret-qr-code');
      await shot(form, lang, '08-totp-enroll', {
        region: keycloakCard(form),
        hotspots: [qr, form.locator('#totp'), form.locator('#saveTOTPBtn')],
        blur: [qr],
        pad: 24,
      });
    });
    await ensureSignedIn(lang, rosa, '/my-entity');
    const nodesLink = page.getByRole('link', { name: L('Nodos del kit') }).first();
    await shot(page, lang, '09-my-entity', { hotspots: [nodesLink], maxHeight: 540 });
  });

  await test.step('4. the officers accept their invitation', async () => {
    for (const p of [diego, tomas]) {
      const page = await register(browser, lang, p);
      await ensureSignedIn(lang, p, '/invitations');
      const accept = page.getByRole('button', {
        name: t(lang, 'invitations.acceptFor', { entity: provider.name }),
      });
      if (p === diego) await shot(page, lang, '10-invitations', { hotspots: [accept] });
      await accept.click();
      await page.waitForURL((url) => !url.pathname.includes('/invitations'));
      if (p === diego) await enrollTotp(page, p);
    }
  });

  await test.step('5. the node', async () => {
    const page = await ensureSignedIn(lang, rosa, '/my-entity/nodes');
    const name = field(page, 'Nombre del nodo');
    await name.fill(nodeName);
    const register = button(page, 'Registrar y emitir token');
    await shot(page, lang, '11-node-register', {
      region: headed(page, 'Registrar un nodo'),
      hotspots: [name, register],
    });
    await register.click();
    const token = page.getByTestId('enrollment-token');
    await expect(token).toBeVisible();
    const enrollment = (await token.textContent()) ?? '';
    const tokenBox = token.locator(
      'xpath=ancestor::*[self::section or self::div[contains(@class,"rounded")]][1]',
    );
    await shot(page, lang, '12-node-token', {
      region: tokenBox,
      hotspots: [token],
      blur: [token],
    });
    const kit = headed(page, 'Kit para instalar');
    const commands = page.getByTestId('kit-commands-release');
    await shot(page, lang, '13-node-kit', { region: kit, hotspots: [commands] });

    startMockNode(enrollment);
    const row = page.getByRole('row', { name: new RegExp(nodeName) });
    try {
      await until(page, () => expect(row).toContainText(L('En línea'), { timeout: 2_000 }));
    } catch (error) {
      console.error(mockNodeLogs());
      throw error;
    }
    await shot(page, lang, '14-node-online', {
      region: page.getByTestId('node-list'),
      hotspots: [row.getByText(L('En línea'), { exact: true })],
    });
  });

  let versionId = '';
  await test.step('6. the technical lead publishes the API', async () => {
    const page = await ensureSignedIn(lang, tomas, '/my-apis/new');
    await page.locator('main [name="name"]').fill(apiName);
    await page.locator('main [name="slug"]').fill(apiSlug);
    await page.locator('main [name="summary"]').fill(EXAMPLES.apiSummary);
    await page.locator('main [name="description"]').fill(EXAMPLES.apiDescription);
    await page.locator('main [name="sector"]').selectOption('salud');
    await page.locator('main [name="classification"]').selectOption('personal');
    await page.locator('main [name="ownerContact"]').fill(`apis@${provider.domain}`);
    const create = page.locator('main form [type="submit"]').first();
    await shot(page, lang, '15-api-register', {
      region: [h1(page), page.locator('main form').first()],
      hotspots: [
        page.locator('main [name="slug"]'),
        page.locator('main [name="classification"]'),
        create,
      ],
    });
    await create.click();
    await expect(h1(page)).toHaveText(apiName, { timeout: 30_000 });

    await page.getByRole('link', { name: L('Nueva versión') }).click();
    await page.locator('main [name="version"]').fill('1.0');
    await page.locator('main [name="openapiFile"]').setInputFiles(openapiFile);
    const node = page.locator('main [name="nodeId"]');
    const nodeValue = await node.locator('option', { hasText: nodeName }).getAttribute('value');
    await node.selectOption(nodeValue ?? '');
    await page.locator('main [name="servicePath"]').fill('/salud');
    await shot(page, lang, '16-version-contract', {
      region: [h1(page), page.locator('main [name="servicePath"]')],
      hotspots: [
        page.locator('main [name="openapiFile"]'),
        node,
        page.locator('main [name="servicePath"]'),
      ],
    });
    const purpose = page.locator('input[name="allowedPurposes"][value="eligibility_check"]');
    await purpose.check();
    await page.locator('#exposed-0').fill('regimen');
    await page.locator('main [name="legalBasisText"]').fill(EXAMPLES.legalBasis);
    const createVersion = page.getByRole('button', { name: L('Crear versión') });
    const purposeLabel = purpose.locator('xpath=ancestor::label[1]');
    await shot(page, lang, '17-version-data', {
      region: [purposeLabel.locator('xpath=ancestor::fieldset[1]'), createVersion],
      hotspots: [
        purposeLabel,
        page.locator('#exposed-0'),
        page.locator('main [name="legalBasisText"]'),
        createVersion,
      ],
    });
    await createVersion.click();
    const submit = button(page, 'Enviar a revisión');
    await expect(submit).toBeVisible({ timeout: 30_000 });
    versionId = page.url().split('/versions/')[1]?.split(/[?#/]/)[0] ?? '';
    await shot(page, lang, '18-version-sheet', {
      region: [headed(page, 'Operaciones'), submit],
      hotspots: [submit],
    });
    await submit.click();
    await expect(page.getByTestId('version-status')).toHaveText(L('En revisión'));
    const validation = page.getByTestId('version-validation');
    await until(page, () => expect(validation).toContainText(L('Superadas'), { timeout: 2_000 }));
    await shot(page, lang, '19-version-validations', {
      region: validation,
      hotspots: [validation.getByText(L('Superadas')).first()],
    });
  });

  await test.step('7. the operator approves the API', async () => {
    const operator = await seedUserPage(browser, 'ana.operadora', `/operator/reviews/${versionId}`);
    const approve = button(operator, 'Aprobar');
    await shot(operator, lang, '20-operator-review', {
      region: [operator.getByTestId('version-validation'), approve],
      hotspots: [operator.getByTestId('version-validation'), approve],
    });
    await approve.click();
    await expect(operator.getByTestId('version-status')).toHaveText(L('Publicada'));
    await operator.context().close();
  });

  await test.step('8. the consumer entity joins', async () => {
    await register(browser, lang, wanda);
    const url = await requestOnboarding(wanda, consumer, wanda, wanda, false);
    await approveOnboarding(browser, consumer, false);
    const page = wanda.page as Page;
    await page.goto(url);
    await enrollTotp(page, wanda);
  });

  let clientId = '';
  let clientSecret = '';
  await test.step('8. the application and its certificate', async () => {
    const page = await ensureSignedIn(lang, wanda, '/my-apps/new');
    await field(page, 'Nombre de la aplicación').fill(EXAMPLES.app);
    await field(page, 'Para qué la usará tu entidad').fill(EXAMPLES.appUse);
    await field(page, 'Entorno').selectOption('production');
    await field(page, 'Correo del contacto técnico').fill(`dev@${consumer.domain}`);
    const create = button(page, 'Crear aplicación');
    await shot(page, lang, '21-app-create', {
      region: [h1(page), page.locator('main form').first()],
      hotspots: [
        field(page, 'Nombre de la aplicación'),
        field(page, 'Para qué la usará tu entidad'),
        field(page, 'Entorno'),
        create,
      ],
    });
    await create.click();
    const id = page.getByTestId('client-id');
    const secret = page.getByTestId('client-secret');
    await expect(secret).toBeVisible();
    clientId = (await id.textContent()) ?? '';
    clientSecret = (await secret.textContent()) ?? '';
    await shot(page, lang, '22-app-secret', {
      region: [h1(page), page.locator('main section, main form').first()],
      hotspots: [id, secret],
      blur: [secret],
    });

    await page.getByRole('link', { name: L('Ir a la aplicación') }).click();
    const section = page.getByRole('region', { name: L('Certificado de cliente (mTLS)') });
    const { csr, keyPem } = await makeCsr(clientId);
    const csrField = field(section, 'Solicitud de certificado (CSR)');
    await csrField.fill(csr);
    const request = button(section, 'Solicitar certificado');
    await shot(page, lang, '23-app-certificate', {
      region: section,
      hotspots: [section.getByRole('tablist').first(), csrField, request],
    });
    await request.click();
    const ready = section
      .getByRole('status')
      .filter({ hasText: t(lang, 'myApps.certificates.issued').split('.')[0] });
    await expect(ready).toBeVisible();
    const download = ready.getByRole('link', { name: L('Descargar') });
    await shot(page, lang, '24-app-certificate-ready', { region: section, hotspots: [download] });
    const downloading = page.waitForEvent('download');
    await download.click();
    const chain = await readFile((await (await downloading).path()) ?? '', 'utf8');
    rememberCertificate(clientId, { cert: chain, key: keyPem });
  });

  let subscriptionId = '';
  await test.step('8. the consumer asks for access', async () => {
    const page = await ensureSignedIn(lang, wanda, '/catalog');
    const search = field(page, 'Buscar por nombre, resumen o etiqueta');
    await search.fill(apiName);
    await button(page, 'Filtrar').click();
    const result = page.getByRole('link', { name: apiName, exact: true });
    await expect(result).toBeVisible();
    await shot(page, lang, '25-catalog', { hotspots: [search, result] });
    await result.click();
    await expect(h1(page)).toHaveText(apiName);
    const ask = page.getByRole('link', { name: L('Solicitar acceso') }).first();
    await shot(page, lang, '26-catalog-api', { hotspots: [ask], maxHeight: 820 });
    await expect(async () => {
      await ask.click();
      await expect(page.locator('main [name="purpose"], select').first()).toBeVisible({
        timeout: 15_000,
      });
    }).toPass({ timeout: 60_000 });

    const app = field(page, 'Aplicación que hará las llamadas');
    await app.selectOption({ label: EXAMPLES.app });
    const purpose = field(page, 'Finalidad');
    await purpose.selectOption('eligibility_check');
    const use = field(page, 'Para qué usarás los datos');
    await use.fill(EXAMPLES.use);
    const legal = field(page, 'Base legal');
    await legal.fill(EXAMPLES.legalBasis);
    const months = field(page, 'Vigencia en meses');
    await months.fill('12');
    const send = button(page, 'Enviar solicitud');
    await shot(page, lang, '27-request-form', {
      region: [h1(page), page.locator('main form').first()],
      hotspots: [app, purpose, use, legal, months, send],
    });
    await send.click();
    const status = page.getByTestId('subscription-status');
    await expect(status).toHaveText(L('Pendiente del proveedor'));
    subscriptionId = page.url().split('/my-apps/requests/')[1]?.split(/[?#/]/)[0] ?? '';
    await shot(page, lang, '28-request-pending', { hotspots: [status], maxHeight: 800 });
  });

  await test.step('9. the provider decides', async () => {
    const page = await ensureSignedIn(lang, diego, '/requests');
    const link = page.locator(`a[href$="/requests/${subscriptionId}"]`).first();
    await shot(page, lang, '29-steward-requests', { hotspots: [link] });
    await link.click();
    const approve = page.getByRole('form', { name: L('Aprobar') });
    const months = field(approve, 'Vigencia aprobada en meses');
    const confirm = button(approve, 'Aprobar');
    await shot(page, lang, '30-steward-decision', { region: approve, hotspots: [months, confirm] });
    await confirm.click();
    await expect(page.getByTestId('subscription-status')).toHaveText(
      new RegExp(`${L('Aprobada')}|${L('Activa')}`),
    );
  });

  await test.step('10. the first lookup', async () => {
    const page = await ensureSignedIn(lang, wanda, `/my-apps/requests/${subscriptionId}`);
    const status = page.getByTestId('subscription-status');
    await until(page, () => expect(status).toHaveText(L('Activa'), { timeout: 2_000 }), 90_000);
    await shot(page, lang, '31-request-active', { hotspots: [status], maxHeight: 800 });

    // The manual documents a path that works: the lookup through the real gateway answers 200.
    const url = `${gateway}/${provider.slug}/${apiSlug}/v1/afiliados/1000000001`;
    const token = await gatewayToken(clientId, clientSecret);
    await untilCertificateKnown(url, token);
    const res = await gatewayFetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        'x-den-purpose': 'eligibility_check',
        'x-den-end-user': 'funcionario-123',
      },
    });
    expect(res.status, await res.clone().text()).toBe(200);
  });

  writeManifest(lang);
});
