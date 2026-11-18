import type { UpstreamType } from '@den/contracts';

/** What the version form asks about where the service lives (P-04, ADR-0029). */
export interface UpstreamChoices {
  /** The types the deployment accepts, node first. */
  types: UpstreamType[];
  /** More than one: the form asks which; with one it only asks for that one's details. */
  ask: boolean;
  /** The type selected at first. */
  initial: UpstreamType;
  /** Sandbox options: none, and the allowed node or direct (the form offers no X-Road sandbox). */
  sandbox: Array<'none' | 'node' | 'direct'>;
}

export function upstreamChoices(allowed: readonly UpstreamType[]): UpstreamChoices {
  const types = (['node', 'xroad', 'direct'] as const).filter((type) => allowed.includes(type));
  return {
    types,
    ask: types.length > 1,
    // The API never offers an empty list (it refuses to start); node as a last resort.
    initial: types[0] ?? 'node',
    sandbox: ['none', ...(['node', 'direct'] as const).filter((type) => allowed.includes(type))],
  };
}
