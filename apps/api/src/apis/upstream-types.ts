import { getCountryConfig, type UpstreamType as ConfigUpstreamType } from '@den/config';
import { FieldErrorKey, UPSTREAM_TYPES, type UpstreamType } from '@den/contracts';
import { ValidationError } from '../common/errors.js';

// The country config and the contracts name the same types.
const sameTypes: [ConfigUpstreamType, UpstreamType] extends [UpstreamType, ConfigUpstreamType]
  ? true
  : never = true;
void sameTypes;

/**
 * The deployment has the operator's Security Server (M4-05): without both variables the
 * reconciler has nowhere to send an `xroad` version.
 */
export const xroadConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.DEN_XROAD_SECURITY_SERVER_URL?.trim() && env.DEN_XROAD_CLIENT?.trim());

/**
 * Upstream types new versions may use in this deployment (P-04, ADR-0029): the country's
 * `features.upstreams`, with `xroad` only where the deployment has its X-Road settings. Node first.
 */
export function allowedUpstreamTypes(
  upstreams: readonly UpstreamType[] = getCountryConfig().features.upstreams,
  env: NodeJS.ProcessEnv = process.env,
): UpstreamType[] {
  return UPSTREAM_TYPES.filter(
    (type) => upstreams.includes(type) && (type !== 'xroad' || xroadConfigured(env)),
  );
}

/** The types of a version's upstreams that new versions may no longer use (sorted, distinct). */
export function disallowedUpstreamTypes(
  upstreams: Array<{ type?: unknown } | null | undefined>,
  allowed: readonly UpstreamType[] = allowedUpstreamTypes(),
): UpstreamType[] {
  const types = new Set(upstreams.map((u) => u?.type));
  return UPSTREAM_TYPES.filter((type) => types.has(type) && !allowed.includes(type));
}

/**
 * Refuses an upstream type the deployment does not accept (P-04): 400 with the field error key
 * the portal translates. `path` is the field (`upstream` or `sandboxUpstream`).
 */
export function assertUpstreamTypeAllowed(
  type: UpstreamType,
  path: string,
  upstreams: readonly UpstreamType[] = getCountryConfig().features.upstreams,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowed = allowedUpstreamTypes(upstreams, env);
  if (allowed.includes(type)) return;
  if (type === 'xroad' && upstreams.includes('xroad')) {
    throw new ValidationError([
      {
        path: `${path}.type`,
        message: 'X-Road is not configured in this deployment (no Security Server)',
        key: FieldErrorKey.XroadNotConfigured,
      },
    ]);
  }
  throw new ValidationError([
    {
      path: `${path}.type`,
      message: `This network does not accept "${type}" upstreams; allowed: ${allowed.join(', ')}`,
      key: FieldErrorKey.UpstreamTypeNotAllowed,
      params: { type, allowed: allowed.join(', ') },
    },
  ]);
}
