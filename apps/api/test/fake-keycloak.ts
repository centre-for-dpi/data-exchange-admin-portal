import { randomBytes, randomUUID } from 'node:crypto';
import type {
  GatewayClient,
  KeycloakGatewayAdmin,
} from '../src/reconcilers/keycloak/keycloak-admin.js';

type StoredClient = GatewayClient & { id: string; secret?: string; rotated?: string };

/**
 * In-memory stand-in for the Keycloak Admin API (realm den-gateway). Secret rotation behaves like
 * Keycloak with the den-secret-rotation client policy (checked against Keycloak 26.8, M3-04):
 * regenerating moves the current secret to the rotated one; an update with `secret` replaces
 * only the current one.
 */
export class FakeKeycloak implements KeycloakGatewayAdmin {
  readonly clients = new Map<string, StoredClient>();
  readonly calls = { create: 0, update: 0, regenerate: 0, deleteRotated: 0 };

  private byId(id: string): StoredClient {
    const client = [...this.clients.values()].find((c) => c.id === id);
    if (!client) throw new Error('not found');
    return client;
  }

  /** What Keycloak would answer to client_credentials with this secret. */
  accepts(clientId: string, secret: string): boolean {
    const client = this.clients.get(clientId);
    return Boolean(client?.enabled && (client.secret === secret || client.rotated === secret));
  }

  findClient(clientId: string) {
    const client = this.clients.get(clientId);
    // Like Keycloak, the secret is not part of what the reconciler reads back.
    return Promise.resolve(
      client ? { ...client, secret: undefined, rotated: undefined } : undefined,
    );
  }
  createClient(client: GatewayClient) {
    this.calls.create += 1;
    this.clients.set(client.clientId, { ...client, id: randomUUID() });
    return Promise.resolve();
  }
  updateClient(id: string, client: GatewayClient) {
    this.calls.update += 1;
    const existing = this.byId(id);
    this.clients.set(client.clientId, {
      ...existing,
      ...client,
      id,
      secret: client.secret ?? existing.secret,
    });
    return Promise.resolve();
  }
  currentSecret(id: string) {
    return Promise.resolve(this.byId(id).secret);
  }
  rotatedSecret(id: string) {
    return Promise.resolve(this.byId(id).rotated);
  }
  regenerateSecret(id: string) {
    this.calls.regenerate += 1;
    const client = this.byId(id);
    client.rotated = client.secret;
    client.secret = randomBytes(32).toString('base64url');
    return Promise.resolve();
  }
  deleteRotatedSecret(id: string) {
    this.calls.deleteRotated += 1;
    delete this.byId(id).rotated;
    return Promise.resolve();
  }
}
