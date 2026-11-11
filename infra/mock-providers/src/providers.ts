export const PROVIDERS = ['salud', 'socioeconomico'] as const;
export type Provider = (typeof PROVIDERS)[number];

export function parseProvider(value: string | undefined): Provider {
  const provider = PROVIDERS.find((p) => p === value);
  if (!provider) {
    throw new Error(`PROVIDER must be one of ${PROVIDERS.join(', ')}; got "${value ?? ''}"`);
  }
  return provider;
}
