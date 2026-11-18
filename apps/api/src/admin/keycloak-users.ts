import { KeycloakAdminError } from '../reconcilers/keycloak/keycloak-admin.js';
import type { DemoUsersKeycloak, KeycloakUserState } from './demo-users.js';

/**
 * The users of realm den-portal through Keycloak's Admin API, as the `master` administrator
 * (KEYCLOAK_ADMIN_USER / KEYCLOAK_ADMIN_PASSWORD), like `scripts/keycloak-*.mjs`. Used only by
 * the server's command line (`demo-users-cli.ts`), never by HTTP handlers (CLAUDE.md): the
 * portal's own service account (den-portal-provisioner) can only manage clients of den-gateway.
 */
export class HttpKeycloakUsers implements DemoUsersKeycloak {
  private token?: { value: string; expiresAt: number };

  constructor(
    private readonly options: {
      baseUrl: string;
      username: string;
      password: string;
      realm?: string;
      fetchFn?: typeof fetch;
    },
  ) {}

  /** From KEYCLOAK_URL and the master administrator; undefined if the credentials are missing. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): HttpKeycloakUsers | undefined {
    if (!env.KEYCLOAK_ADMIN_USER || !env.KEYCLOAK_ADMIN_PASSWORD) return undefined;
    return new HttpKeycloakUsers({
      baseUrl: (env.KEYCLOAK_URL ?? 'http://localhost:8080').replace(/\/+$/, ''),
      username: env.KEYCLOAK_ADMIN_USER,
      password: env.KEYCLOAK_ADMIN_PASSWORD,
    });
  }

  private get fetch(): typeof fetch {
    return this.options.fetchFn ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await this.fetch(
      `${this.options.baseUrl}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: this.options.username,
          password: this.options.password,
        }),
      },
    );
    if (!res.ok) throw new KeycloakAdminError(`Keycloak admin login failed (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 10) * 1000,
    };
    return body.access_token;
  }

  /** The response, or undefined on 404. */
  private async request(method: string, path: string, body?: unknown) {
    const res = await this.fetch(
      `${this.options.baseUrl}/admin/realms/${this.options.realm ?? 'den-portal'}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    if (res.status === 404) return undefined;
    if (!res.ok) {
      throw new KeycloakAdminError(`Keycloak ${method} /users failed (${res.status})`);
    }
    return res;
  }

  private async user(id: string): Promise<Record<string, unknown> | undefined> {
    const res = await this.request('GET', `/users/${encodeURIComponent(id)}`);
    return res ? ((await res.json()) as Record<string, unknown>) : undefined;
  }

  async state(id: string): Promise<KeycloakUserState> {
    const user = await this.user(id);
    if (!user) return 'missing';
    return user.enabled === false ? 'disabled' : 'enabled';
  }

  async disable(id: string): Promise<'disabled' | 'unchanged' | 'missing'> {
    const user = await this.user(id);
    if (!user) return 'missing';
    const path = `/users/${encodeURIComponent(id)}`;
    const wasEnabled = user.enabled !== false;
    // The whole representation back: a partial one could drop the profile's attributes.
    if (wasEnabled) await this.request('PUT', path, { ...user, enabled: false });
    // Always: a run cut short between both calls leaves no session behind.
    await this.request('POST', `${path}/logout`);
    return wasEnabled ? 'disabled' : 'unchanged';
  }
}
