import { ENTITY_ROLES, PLATFORM_ROLES } from '@rid/contracts';
import type { DiscoveredRoute } from '../openapi/openapi.service.js';
import { ENTITY_PERMISSIONS, MFA_ENTITY_ROLES, PLATFORM_PERMISSIONS } from './authz.policy.js';

/** Where the generated matrix lives, relative to the repo root. */
export const AUTHZ_DOC = 'docs/AUTHZ.md';

const yes = (on: boolean) => (on ? '✓' : '·');

const ACCESS_LABEL: Record<string, string> = {
  public: 'pública (sin sesión; las internas exigen su propio token de servicio)',
  citizen: 'ciudadano (token del realm de ciudadanos)',
  optional: 'sesión opcional (catálogo público según la config del país)',
  signedIn: 'cualquier sesión; solo recursos propios',
};

/**
 * Renders the authorization matrix from the central policy and the routes as the guard sees
 * them (SPEC.md §2, M2-03). The document is generated: a test fails when it is out of date.
 */
export function renderAuthzMatrix(routes: DiscoveredRoute[]): string {
  const lines: string[] = [
    '# Matriz de autorización',
    '',
    '> Generado desde `apps/api/src/auth/authz.policy.ts` y las rutas del API. No lo edites a mano:',
    '> `RID_UPDATE_AUTHZ_DOC=1 pnpm --filter @rid/api test -- authz.matrix`.',
    '',
    'Reglas del guard global (ADR-0014): sin sesión, 401. En rutas de una entidad: quien no es miembro',
    'ni tiene un rol de plataforma permitido recibe 404; un miembro sin el rol, 403. En rutas de',
    'plataforma: sin el rol, 403. Una ruta sin declaración de acceso no se puede llamar (403).',
    '',
    `Segundo factor (M3-08, ADR-0021): quien tiene un rol de plataforma o ${MFA_ENTITY_ROLES.map((r) => `\`${r}\``).join(', ')}`,
    'en alguna entidad recibe 403 `mfa_required` en toda ruta de entidad o de plataforma si su sesión',
    'no se abrió con el código de un solo uso. Las rutas de cualquier sesión (`/me`) siguen abiertas.',
    '',
    '## Acciones sobre recursos de una entidad',
    '',
    `| Acción | ${ENTITY_ROLES.map((r) => `\`${r}\``).join(' | ')} | ${PLATFORM_ROLES.map((r) => `\`${r}\``).join(' | ')} |`,
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
    '## Acciones de plataforma',
    '',
    `| Acción | ${PLATFORM_ROLES.map((r) => `\`${r}\``).join(' | ')} |`,
    `| :-- | ${PLATFORM_ROLES.map(() => ':-:').join(' | ')} |`,
  );
  for (const [action, roles] of Object.entries(PLATFORM_PERMISSIONS)) {
    lines.push(
      `| \`${action}\` | ${PLATFORM_ROLES.map((r) => yes((roles as readonly string[]).includes(r))).join(' | ')} |`,
    );
  }
  lines.push('', '## Rutas', '', '| Método | Ruta | Acceso |', '| :-- | :-- | :-- |');
  const sorted = [...routes].sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  );
  for (const route of sorted) {
    const { access } = route;
    const label =
      access.kind === 'entity'
        ? `entidad: \`${access.action}\``
        : access.kind === 'platform'
          ? `plataforma: \`${access.action}\``
          : (ACCESS_LABEL[access.kind] ?? '**sin declarar**');
    lines.push(`| ${route.method} | \`${route.path}\` | ${label} |`);
  }
  return `${lines.join('\n')}\n`;
}
