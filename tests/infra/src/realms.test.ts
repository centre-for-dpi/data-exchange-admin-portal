import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

interface RealmFile {
  realm: string;
  registrationAllowed?: boolean;
  clients?: Array<{
    clientId: string;
    secret?: string;
    publicClient?: boolean;
    directAccessGrantsEnabled?: boolean;
    serviceAccountsEnabled?: boolean;
    attributes?: Record<string, string>;
  }>;
  users?: Array<{
    id?: string;
    username: string;
    credentials?: Array<{ value: string }>;
    clientRoles?: Record<string, string[]>;
  }>;
  defaultDefaultClientScopes?: string[];
  accessTokenLifespan?: number;
}

const readRealm = (name: string): RealmFile =>
  JSON.parse(readFileSync(fromRoot('infra/keycloak', `${name}-realm.json`), 'utf8')) as RealmFile;

const DEMO_USERS = [
  'ana.operadora',
  'pedro.publicador',
  'lucia.datos',
  'carlos.dev',
  'marta.regulador',
];

describe('realm rid-portal', () => {
  const realm = readRealm('rid-portal');

  it('has every user of docs/DEMO.md with a fixed id', () => {
    const users = realm.users ?? [];
    for (const username of DEMO_USERS) {
      const user = users.find((u) => u.username === username);
      expect(user, username).toBeDefined();
      expect(user?.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(users.map((u) => u.id)).size).toBe(users.length);
  });

  it('takes secrets and passwords from environment placeholders only', () => {
    for (const client of realm.clients ?? []) {
      if (client.secret !== undefined) expect(client.secret).toMatch(/^\$\{[A-Z_]+\}$/);
    }
    for (const user of realm.users ?? []) {
      for (const credential of user.credentials ?? []) {
        expect(credential.value).toMatch(/^\$\{[A-Z_]+(:[^}]*)?\}$/);
      }
    }
  });

  it('defines rid-portal-web as a confidential client with PKCE and no password grant', () => {
    const web = realm.clients?.find((c) => c.clientId === 'rid-portal-web');
    expect(web).toMatchObject({ publicClient: false, directAccessGrantsEnabled: false });
    expect(web?.attributes?.['pkce.code.challenge.method']).toBe('S256');
  });

  it('does not allow self-registration', () => {
    expect(realm.registrationAllowed).toBe(false);
  });
});

describe('realm rid-gateway', () => {
  const realm = readRealm('rid-gateway');

  it('contains no application clients, only the portal provisioner', () => {
    expect((realm.clients ?? []).map((c) => c.clientId)).toEqual(['rid-portal-provisioner']);
  });

  it('grants the provisioner manage-clients and nothing else', () => {
    const serviceAccount = realm.users?.find(
      (u) => u.username === 'service-account-rid-portal-provisioner',
    );
    expect(serviceAccount?.clientRoles).toEqual({ 'realm-management': ['manage-clients'] });
  });

  it('adds the rid-gateway audience to every new client and uses 5-minute tokens', () => {
    expect(realm.defaultDefaultClientScopes).toContain('rid-gateway-audience');
    expect(realm.accessTokenLifespan).toBe(300);
  });

  it('takes the provisioner secret from an environment placeholder', () => {
    const provisioner = realm.clients?.[0];
    expect(provisioner?.secret).toMatch(/^\$\{[A-Z_]+\}$/);
  });
});
