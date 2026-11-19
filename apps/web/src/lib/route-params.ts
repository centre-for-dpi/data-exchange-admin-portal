import { notFound } from 'next/navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value);

/**
 * Route parameters that name a resource are UUIDs. They go into API paths, so anything else
 * (`..%2f`, `?x=`, `#`) would change which endpoint the web calls with the user's token (B-26):
 * it is a 404 before any call is made.
 */
export function uuidParams<T extends Record<string, string>>(params: T, ...names: (keyof T)[]): T {
  for (const name of names) if (!isUuid(params[name] ?? '')) notFound();
  return params;
}
