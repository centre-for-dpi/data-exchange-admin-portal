/**
 * Minimal Keycloak Admin API client for the realm den-gateway, authenticated as the portal's
 * service account (den-portal-provisioner, manage-clients only: ARCHITECTURE.md §3.2). Used only
 * by the reconciler, never by HTTP handlers (CLAUDE.md).
 */
export const KEYCLOAK_ADMIN = Symbol('KEYCLOAK_ADMIN');

export interface GatewayClient {
  /** Keycloak internal id (set on read). */
  id?: string;
  clientId: string;
  name: string;
  description: string;
  enabled: boolean;
  publicClient: boolean;
  serviceAccountsEnabled: boolean;
  standardFlowEnabled: boolean;
  directAccessGrantsEnabled: boolean;
  implicitFlowEnabled: boolean;
  attributes: Record<string, string>;
  /** Only sent when it must change; never read back. */
  secret?: string;
}

/**
 * Keycloak binds the client's tokens to the certificate of the request (RFC 8705, cnf.x5t#S256).
 * The reconciler manages it, like the den.* attributes (M3-10).
 */
export const BOUND_TOKENS_ATTRIBUTE = 'tls.client.certificate.bound.access.tokens';

export interface KeycloakGatewayAdmin {
  findClient(clientId: string): Promise<GatewayClient | undefined>;
  createClient(client: GatewayClient): Promise<void>;
  updateClient(id: string, client: GatewayClient): Promise<void>;
  /**
   * Secret rotation (M3-04), with the realm's client policy den-secret-rotation (executor
   * secret-rotation, clients with den.managed = true): regenerating moves the current secret to
   * the client's rotated secret, which keeps working until it expires or is deleted; a later
   * update with `secret` replaces only the current one. The values only pass through the
   * reconciler's memory to compare their hashes.
   */
  currentSecret(id: string): Promise<string | undefined>;
  regenerateSecret(id: string): Promise<void>;
  rotatedSecret(id: string): Promise<string | undefined>;
  deleteRotatedSecret(id: string): Promise<void>;
}

export class KeycloakAdminError extends Error {}

/** Time one Keycloak Admin API call may take: a hung Keycloak must not stall the reconciler. */
export const KEYCLOAK_ADMIN_TIMEOUT_MS = 10_000;

const FIELDS: Array<keyof GatewayClient> = [
  'clientId',
  'name',
  'description',
  'enabled',
  'publicClient',
  'serviceAccountsEnabled',
  'standardFlowEnabled',
  'directAccessGrantsEnabled',
  'implicitFlowEnabled',
  'attributes',
];

export class HttpKeycloakGatewayAdmin implements KeycloakGatewayAdmin {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly options: {
      baseUrl: string;
      realm: string;
      clientId: string;
      clientSecret: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  /** Every call is cut after timeoutMs (B-14): the job fails and is retried. */
  private fetch(url: string, init: RequestInit = {}): Promise<Response> {
    return (this.options.fetchFn ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(this.options.timeoutMs ?? KEYCLOAK_ADMIN_TIMEOUT_MS),
    });
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await this.fetch(
      `${this.options.baseUrl}/realms/${this.options.realm}/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
      },
    );
    if (!res.ok) throw new KeycloakAdminError(`Keycloak token request failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 30) * 1000,
    };
    return body.access_token;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.fetch(
      `${this.options.baseUrl}/admin/realms/${this.options.realm}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (!res.ok) {
      throw new KeycloakAdminError(
        `Keycloak ${method} ${path.split('?')[0]} failed (${res.status})`,
      );
    }
    return res;
  }

  async findClient(clientId: string): Promise<GatewayClient | undefined> {
    const res = await this.request('GET', `/clients?clientId=${encodeURIComponent(clientId)}`);
    const found = ((await res.json()) as Array<Record<string, unknown>>).find(
      (c) => c.clientId === clientId,
    );
    if (!found) return undefined;
    const client = Object.fromEntries(FIELDS.map((f) => [f, found[f]])) as unknown as GatewayClient;
    return {
      ...client,
      id: String(found.id),
      name: typeof found.name === 'string' ? found.name : '',
      description: typeof found.description === 'string' ? found.description : '',
      attributes: Object.fromEntries(
        Object.entries((found.attributes ?? {}) as Record<string, string>).filter(
          ([k]) => k.startsWith('den.') || k === BOUND_TOKENS_ATTRIBUTE,
        ),
      ),
    };
  }

  private async secretAt(path: string): Promise<string | undefined> {
    const res = await this.fetch(
      `${this.options.baseUrl}/admin/realms/${this.options.realm}${path}`,
      { headers: { authorization: `Bearer ${await this.accessToken()}` } },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new KeycloakAdminError(`Keycloak GET client secret failed (${res.status})`);
    }
    const value = ((await res.json()) as { value?: unknown }).value;
    return typeof value === 'string' && value ? value : undefined;
  }

  currentSecret(id: string): Promise<string | undefined> {
    return this.secretAt(`/clients/${id}/client-secret`);
  }

  rotatedSecret(id: string): Promise<string | undefined> {
    return this.secretAt(`/clients/${id}/client-secret/rotated`);
  }

  async regenerateSecret(id: string): Promise<void> {
    await this.request('POST', `/clients/${id}/client-secret`);
  }

  async deleteRotatedSecret(id: string): Promise<void> {
    await this.request('DELETE', `/clients/${id}/client-secret/rotated`);
  }

  async createClient(client: GatewayClient): Promise<void> {
    await this.request('POST', '/clients', {
      ...client,
      protocol: 'openid-connect',
      clientAuthenticatorType: 'client-secret',
    });
  }

  async updateClient(id: string, client: GatewayClient): Promise<void> {
    const { id: _ignored, ...rest } = client;
    await this.request('PUT', `/clients/${id}`, {
      ...rest,
      protocol: 'openid-connect',
      clientAuthenticatorType: 'client-secret',
    });
  }
}
