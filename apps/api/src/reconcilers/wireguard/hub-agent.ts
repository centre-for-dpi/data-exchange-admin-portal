import { z } from 'zod';

/** A tunnel peer: one enrolled node (M4-03). */
export interface HubPeer {
  publicKey: string;
  address: string;
}

/** Where the SNI router sends the TLS connections for a node name (ADR-0023). */
export interface HubRoute {
  name: string;
  address: string;
  port: number;
}

export interface HubDesiredState {
  peers: HubPeer[];
  routes: HubRoute[];
}

const actualSchema = z.object({
  publicKey: z.string(),
  address: z.string(),
  listenPort: z.number(),
  peers: z.array(
    z.object({
      publicKey: z.string(),
      address: z.string(),
      endpoint: z.string().nullable(),
      latestHandshake: z.string().nullable(),
    }),
  ),
  routes: z.array(z.object({ name: z.string(), address: z.string(), port: z.number() })),
});
export type HubActualState = z.infer<typeof actualSchema>;

/** The hub agent (infra/wg-hub/hub-agent.mjs). Injected so tests can use a fake hub. */
export interface HubAgent {
  state(): Promise<HubActualState>;
  apply(desired: HubDesiredState): Promise<HubActualState>;
}

export const HUB_AGENT = Symbol('HUB_AGENT');

const TIMEOUT_MS = 10_000;

export class HttpHubAgent implements HubAgent {
  constructor(private readonly options: { baseUrl: string; token: string }) {}

  private async call(method: 'GET' | 'PUT', body?: unknown): Promise<HubActualState> {
    const res = await fetch(`${this.options.baseUrl.replace(/\/+$/, '')}/v1/state`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    // The agent's answers carry no secret; its errors name what was invalid.
    if (!res.ok) throw new Error(`hub agent ${method} /v1/state: HTTP ${res.status} ${text}`);
    return actualSchema.parse(JSON.parse(text));
  }

  state(): Promise<HubActualState> {
    return this.call('GET');
  }

  apply(desired: HubDesiredState): Promise<HubActualState> {
    return this.call('PUT', desired);
  }
}
