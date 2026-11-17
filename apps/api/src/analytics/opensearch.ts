/** Where the access logs live (ARCHITECTURE.md §8): den-access-YYYY.MM, written by Fluent Bit. */
export const ACCESS_LOG_INDICES = 'den-access-*';

/** Injection token of the OpenSearch client (tests can replace it). */
export const OPENSEARCH = Symbol('OPENSEARCH');

export interface OpenSearchResponse<T> {
  status: number;
  body: T;
}

/** The few REST calls the portal makes to OpenSearch: no client library (ADR-0002). */
export interface OpenSearch {
  request<T = unknown>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<OpenSearchResponse<T>>;
}

export class OpenSearchUnavailableError extends Error {}

export const openSearchUrl = (): string =>
  process.env.DEN_OPENSEARCH_URL ?? 'http://localhost:9200';

/**
 * OpenSearch over HTTP. In the Compose network it has no authentication (dev and the pilot);
 * DEN_OPENSEARCH_AUTH ("user:password") is sent as Basic when the security plugin is on.
 */
export class HttpOpenSearch implements OpenSearch {
  constructor(
    private readonly baseUrl: string,
    private readonly auth = process.env.DEN_OPENSEARCH_AUTH,
    private readonly timeoutMs = 10_000,
  ) {}

  async request<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<OpenSearchResponse<T>> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: {
          'content-type': 'application/json',
          ...(this.auth
            ? { authorization: `Basic ${Buffer.from(this.auth).toString('base64')}` }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OpenSearchUnavailableError(`OpenSearch ${method} ${path}: ${String(error)}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (res.status >= 500) {
      throw new OpenSearchUnavailableError(`OpenSearch ${method} ${path}: ${res.status}`);
    }
    return { status: res.status, body: parsed as T };
  }
}
