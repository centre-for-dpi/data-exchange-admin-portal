import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

interface RealmFile {
  realm: string;
  registrationAllowed?: boolean;
  verifyEmail?: boolean;
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
    credentials?: Array<{
      type: string;
      value?: string;
      secretData?: string;
      credentialData?: string;
    }>;
    clientRoles?: Record<string, string[]>;
  }>;
  defaultDefaultClientScopes?: string[];
  accessTokenLifespan?: number;
  attributes?: Record<string, string>;
  browserFlow?: string;
  otpPolicyCodeReusable?: boolean;
  authenticationFlows?: Array<{
    alias: string;
    authenticationExecutions: Array<{
      authenticator?: string;
      flowAlias?: string;
      requirement: string;
      authenticatorConfig?: string;
    }>;
  }>;
  authenticatorConfig?: Array<{ alias: string; config: Record<string, string> }>;
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
        const secret =
          credential.type === 'otp'
            ? (JSON.parse(credential.secretData ?? '{}') as { value?: string }).value
            : credential.value;
        expect(secret, `${user.username} ${credential.type}`).toMatch(/^\$\{[A-Z_]+(:[^}]*)?\}$/);
      }
    }
  });

  it('defines rid-portal-web as a confidential client with PKCE and no password grant', () => {
    const web = realm.clients?.find((c) => c.clientId === 'rid-portal-web');
    expect(web).toMatchObject({ publicClient: false, directAccessGrantsEnabled: false });
    expect(web?.attributes?.['pkce.code.challenge.method']).toBe('S256');
  });

  it('allows self-registration only with a verified e-mail (ADR-0018)', () => {
    expect(realm.registrationAllowed).toBe(true);
    expect(realm.verifyEmail).toBe(true);
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

describe('realm rid-citizens (MT-05)', () => {
  const realm = readRealm('rid-citizens') as RealmFile & {
    components?: Record<string, Array<{ config: Record<string, string[]> }>>;
    users: Array<{ attributes?: Record<string, string[]> }>;
  };
  const carpeta = realm.clients?.find((c) => c.clientId === 'carpeta-ciudadana');

  it('has one citizen app: confidential, code + PKCE, no password grant', () => {
    expect(realm.clients).toHaveLength(1);
    expect(carpeta).toMatchObject({
      publicClient: false,
      directAccessGrantsEnabled: false,
      serviceAccountsEnabled: false,
      secret: '${RID_CARPETA_CLIENT_SECRET}',
    });
    expect(carpeta?.attributes?.['pkce.code.challenge.method']).toBe('S256');
    expect(realm.registrationAllowed).toBe(false);
  });

  it('gives every citizen a verified document the citizen cannot edit', () => {
    for (const user of realm.users) {
      expect(user.attributes?.document_type?.[0]).toMatch(/^[A-Z]{2,4}$/);
      expect(user.attributes?.document_number?.[0]).toMatch(/^[0-9]{6,12}$/);
    }
    const raw =
      realm.components?.['org.keycloak.userprofile.UserProfileProvider']?.[0]?.config[
        'kc.user.profile.config'
      ]?.[0] ?? '{}';
    const profile = JSON.parse(raw) as {
      attributes: Array<{ name: string; permissions: { edit: string[] } }>;
      unmanagedAttributePolicy?: string;
    };
    for (const name of ['document_type', 'document_number']) {
      expect(profile.attributes.find((a) => a.name === name)?.permissions.edit).toEqual(['admin']);
    }
    // No other attribute the citizen could set and the token could carry.
    expect(profile.unmanagedAttributePolicy).toBeUndefined();
  });
});

describe('realm rid-portal: second factor (M3-08, ADR-0021)', () => {
  const realm = readRealm('rid-portal');
  const flow = (alias: string) => realm.authenticationFlows?.find((f) => f.alias === alias);
  const config = (alias?: string) => realm.authenticatorConfig?.find((c) => c.alias === alias);

  it('maps acr=mfa to level of authentication 2', () => {
    expect(JSON.parse(realm.attributes?.['acr.loa.map'] ?? '{}')).toEqual({ password: 1, mfa: 2 });
  });

  it('logs in with the password, and asks for the one-time code only at level 2', () => {
    expect(realm.browserFlow).toBe('rid-browser');
    expect(flow('rid-browser')?.authenticationExecutions).toEqual([
      expect.objectContaining({ authenticator: 'auth-cookie', requirement: 'ALTERNATIVE' }),
      expect.objectContaining({ flowAlias: 'rid-browser-forms', requirement: 'ALTERNATIVE' }),
    ]);
    const levels = flow('rid-browser-forms')?.authenticationExecutions.map((e) => {
      const steps = flow(e.flowAlias ?? '')?.authenticationExecutions ?? [];
      return {
        requirement: e.requirement,
        level: config(steps[0]?.authenticatorConfig)?.config['loa-condition-level'],
        steps: steps.map((s) => `${s.authenticator} ${s.requirement}`),
      };
    });
    expect(levels).toEqual([
      {
        requirement: 'CONDITIONAL',
        level: '1',
        steps: [
          'conditional-level-of-authentication REQUIRED',
          'auth-username-password-form REQUIRED',
        ],
      },
      {
        requirement: 'CONDITIONAL',
        level: '2',
        steps: ['conditional-level-of-authentication REQUIRED', 'auth-otp-form REQUIRED'],
      },
    ]);
  });

  it('does not let a one-time code be used twice', () => {
    expect(realm.otpPolicyCodeReusable).not.toBe(true);
  });

  it('seeds a one-time code only for the demo users with a critical role', () => {
    const withOtp = (realm.users ?? [])
      .filter((u) => u.credentials?.some((c) => c.type === 'otp'))
      .map((u) => u.username)
      .sort();
    expect(withOtp).toEqual([
      'ana.operadora',
      'lucia.datos',
      'marta.regulador',
      'pablo.plataforma',
      'sofia.auditora',
    ]);
  });
});
