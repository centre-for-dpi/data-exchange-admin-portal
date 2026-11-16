/** Injection token of the Prometheus client; null when the deployment has no Prometheus. */
export const PROMETHEUS = Symbol('PROMETHEUS');

/** One instant query to Prometheus: the first value of the result, null without data. */
export interface Prometheus {
  instant(query: string, at: Date): Promise<number | null>;
}

/** RID_PROMETHEUS_URL (observability profile); without it the indicators that need it are null. */
export const prometheusUrl = (): string | undefined => process.env.RID_PROMETHEUS_URL || undefined;

interface QueryResponse {
  status?: string;
  data?: { result?: Array<{ value?: [number, string] }> };
}

/** Prometheus' HTTP API (`/api/v1/query`). Read-only; no client library. */
export class HttpPrometheus implements Prometheus {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs = 5_000,
  ) {}

  async instant(query: string, at: Date): Promise<number | null> {
    const url = new URL('/api/v1/query', this.baseUrl);
    url.searchParams.set('query', query);
    url.searchParams.set('time', String(at.getTime() / 1000));
    const res = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Prometheus query: ${res.status}`);
    const body = (await res.json()) as QueryResponse;
    const value = Number(body.data?.result?.[0]?.value?.[1]);
    return body.status === 'success' && Number.isFinite(value) ? value : null;
  }
}
