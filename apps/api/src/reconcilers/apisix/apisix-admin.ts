/**
 * Minimal client of the APISIX Admin API (routes, upstreams and SSL objects). Used only by the reconciler,
 * never by HTTP handlers (CLAUDE.md). Objects are addressed by deterministic ids, so every write
 * is an idempotent PUT.
 */
export const APISIX_ADMIN = Symbol('APISIX_ADMIN');

/** plugin_metadata: per plugin, shared by every route (den-assertion's signing key, M6-10). */
export type ApisixKind = 'routes' | 'upstreams' | 'ssls' | 'plugin_metadata';
export type ApisixObject = Record<string, unknown>;

export interface ApisixAdmin {
  /** The stored object, or undefined when it does not exist. */
  get(kind: ApisixKind, id: string): Promise<ApisixObject | undefined>;
  put(kind: ApisixKind, id: string, value: ApisixObject): Promise<void>;
  /** Deleting an object that does not exist is not an error. */
  delete(kind: ApisixKind, id: string): Promise<void>;
  /** Ids of every object of that kind. */
  list(kind: ApisixKind): Promise<string[]>;
}

export class ApisixAdminError extends Error {}

/**
 * Deletes an upstream right after the route that used it. APISIX checks that no route uses an
 * upstream against its own config cache, which follows etcd with a short delay, so it may still
 * refuse for a moment: only that refusal is retried (for up to `attempts` × `delayMs`).
 */
export async function deleteUpstreamWhenUnused(
  admin: ApisixAdmin,
  id: string,
  { attempts = 20, delayMs = 250 } = {},
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await admin.delete('upstreams', id);
      return;
    } catch (error) {
      const stillUsed = error instanceof Error && /still using it/.test(error.message);
      if (!stillUsed || attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/** Fields APISIX adds to what was stored; they are not part of the desired state. */
const SERVER_FIELDS = new Set(['id', 'create_time', 'update_time']);

export class HttpApisixAdmin implements ApisixAdmin {
  constructor(
    private readonly options: { baseUrl: string; apiKey: string; fetchFn?: typeof fetch },
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const fetchFn = this.options.fetchFn ?? fetch;
    return fetchFn(`${this.options.baseUrl.replace(/\/$/, '')}/apisix/admin/${path}`, {
      method,
      headers: {
        'x-api-key': this.options.apiKey,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  private static async fail(res: Response, what: string): Promise<never> {
    // The Admin API echoes the offending configuration, never request data: safe to keep.
    const text = (await res.text()).slice(0, 500);
    throw new ApisixAdminError(`APISIX ${what} failed: ${res.status} ${text}`);
  }

  async get(kind: ApisixKind, id: string): Promise<ApisixObject | undefined> {
    const res = await this.request('GET', `${kind}/${encodeURIComponent(id)}`);
    if (res.status === 404) return undefined;
    if (!res.ok) return HttpApisixAdmin.fail(res, `GET ${kind}/${id}`);
    const value = ((await res.json()) as { value?: ApisixObject }).value ?? {};
    return Object.fromEntries(Object.entries(value).filter(([k]) => !SERVER_FIELDS.has(k)));
  }

  async put(kind: ApisixKind, id: string, value: ApisixObject): Promise<void> {
    const res = await this.request('PUT', `${kind}/${encodeURIComponent(id)}`, value);
    if (!res.ok) await HttpApisixAdmin.fail(res, `PUT ${kind}/${id}`);
  }

  async delete(kind: ApisixKind, id: string): Promise<void> {
    const res = await this.request('DELETE', `${kind}/${encodeURIComponent(id)}`);
    if (!res.ok && res.status !== 404) await HttpApisixAdmin.fail(res, `DELETE ${kind}/${id}`);
  }

  async list(kind: ApisixKind): Promise<string[]> {
    const res = await this.request('GET', kind);
    if (!res.ok) return HttpApisixAdmin.fail(res, `GET ${kind}`);
    const body = (await res.json()) as { list?: Array<{ value?: { id?: unknown } }> };
    return (body.list ?? [])
      .map((item) => item.value?.id)
      .filter((id): id is string => typeof id === 'string');
  }
}
