import { ENTITY_ROLES, PLATFORM_ROLES } from '@den/contracts';
import type { DiscoveredRoute } from '../openapi/openapi.service.js';
import { ENTITY_PERMISSIONS, MFA_ENTITY_ROLES, PLATFORM_PERMISSIONS } from './authz.policy.js';

/** Where the generated matrix lives, relative to the repo root: English, and its Spanish mirror. */
export const AUTHZ_DOC = 'docs/AUTHZ.md';
export const AUTHZ_DOC_ES = 'docs/es/AUTHZ.md';

export type DocLang = 'en' | 'es';

const yes = (on: boolean) => (on ? '✓' : '·');

const TEXT = {
  en: {
    access: {
      public: 'public (no session; internal routes require their own service token)',
      citizen: 'citizen (token from the citizens realm)',
      node: 'kit node (mTLS with its certificate, through the gateway control route)',
      optional: 'optional session (public catalog depending on the country config)',
      signedIn: 'any session; own resources only',
    } as Record<string, string>,
    entity: 'entity',
    platform: 'platform',
    undeclared: '**undeclared**',
    head: (mfa: string) => [
      '# Authorization matrix',
      '',
      '> Versión en español: [docs/es/AUTHZ.md](es/AUTHZ.md)',
      '',
      '> Generated from `apps/api/src/auth/authz.policy.ts` and the API routes. Do not edit it by hand:',
      '> `DEN_UPDATE_AUTHZ_DOC=1 pnpm --filter @den/api test -- authz.matrix`.',
      '',
      'Rules of the global guard (ADR-0014): without a session, 401. On entity routes: someone who is not a member',
      'and has no allowed platform role gets 404; a member without the role, 403. On platform',
      'routes: without the role, 403. A route without an access declaration cannot be called (403).',
      '',
      `Second factor (M3-08, ADR-0021): whoever has a platform role or ${mfa}`,
      'in some entity gets 403 `mfa_required` on every entity or platform route if their session',
      'was not opened with the one-time code. Routes for any session (`/me`) stay open.',
      '',
      "## Actions on an entity's resources",
      '',
    ],
    action: 'Action',
    platformActions: '## Platform actions',
    routes: ['## Routes', '', '| Method | Route | Access |'],
  },
  es: {
    access: {
      public: 'pública (sin sesión; las internas exigen su propio token de servicio)',
      citizen: 'ciudadano (token del realm de ciudadanos)',
      node: 'nodo del kit (mTLS con su certificado, a través de la ruta de control del gateway)',
      optional: 'sesión opcional (catálogo público según la config del país)',
      signedIn: 'cualquier sesión; solo recursos propios',
    } as Record<string, string>,
    entity: 'entidad',
    platform: 'plataforma',
    undeclared: '**sin declarar**',
    head: (mfa: string) => [
      '# Matriz de autorización',
      '',
      '> English version (official): [docs/AUTHZ.md](../AUTHZ.md)',
      '',
      '> Generado desde `apps/api/src/auth/authz.policy.ts` y las rutas del API. No lo edites a mano:',
      '> `DEN_UPDATE_AUTHZ_DOC=1 pnpm --filter @den/api test -- authz.matrix`.',
      '',
      'Reglas del guard global (ADR-0014): sin sesión, 401. En rutas de una entidad: quien no es miembro',
      'ni tiene un rol de plataforma permitido recibe 404; un miembro sin el rol, 403. En rutas de',
      'plataforma: sin el rol, 403. Una ruta sin declaración de acceso no se puede llamar (403).',
      '',
      `Segundo factor (M3-08, ADR-0021): quien tiene un rol de plataforma o ${mfa}`,
      'en alguna entidad recibe 403 `mfa_required` en toda ruta de entidad o de plataforma si su sesión',
      'no se abrió con el código de un solo uso. Las rutas de cualquier sesión (`/me`) siguen abiertas.',
      '',
      '## Acciones sobre recursos de una entidad',
      '',
    ],
    action: 'Acción',
    platformActions: '## Acciones de plataforma',
    routes: ['## Rutas', '', '| Método | Ruta | Acceso |'],
  },
} as const;

/**
 * Renders the authorization matrix from the central policy and the routes as the guard sees
 * them (SPEC.md §2, M2-03), in English or Spanish (ADR-0027). The document is generated: a test
 * fails when it is out of date.
 */
export function renderAuthzMatrix(routes: DiscoveredRoute[], lang: DocLang = 'en'): string {
  const t = TEXT[lang];
  const lines: string[] = [
    ...t.head(MFA_ENTITY_ROLES.map((r) => `\`${r}\``).join(', ')),
    `| ${t.action} | ${ENTITY_ROLES.map((r) => `\`${r}\``).join(' | ')} | ${PLATFORM_ROLES.map((r) => `\`${r}\``).join(' | ')} |`,
    `| :-- | ${[...ENTITY_ROLES, ...PLATFORM_ROLES].map(() => ':-:').join(' | ')} |`,
  ];
  for (const [action, p] of Object.entries(ENTITY_PERMISSIONS)) {
    const entity = ENTITY_ROLES.map((r) => yes((p.entityRoles as readonly string[]).includes(r)));
    const platform = PLATFORM_ROLES.map((r) =>
      yes((p.platformRoles as readonly string[]).includes(r)),
    );
    lines.push(`| \`${action}\` | ${[...entity, ...platform].join(' | ')} |`);
  }
  lines.push(
    '',
    t.platformActions,
    '',
    `| ${t.action} | ${PLATFORM_ROLES.map((r) => `\`${r}\``).join(' | ')} |`,
    `| :-- | ${PLATFORM_ROLES.map(() => ':-:').join(' | ')} |`,
  );
  for (const [action, roles] of Object.entries(PLATFORM_PERMISSIONS)) {
    lines.push(
      `| \`${action}\` | ${PLATFORM_ROLES.map((r) => yes((roles as readonly string[]).includes(r))).join(' | ')} |`,
    );
  }
  lines.push('', ...t.routes, '| :-- | :-- | :-- |');
  const sorted = [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  for (const route of sorted) {
    const { access } = route;
    const label =
      access.kind === 'entity'
        ? `${t.entity}: \`${access.action}\``
        : access.kind === 'platform'
          ? `${t.platform}: \`${access.action}\``
          : (t.access[access.kind] ?? t.undeclared);
    lines.push(`| ${route.method} | \`${route.path}\` | ${label} |`);
  }
  return `${lines.join('\n')}\n`;
}
