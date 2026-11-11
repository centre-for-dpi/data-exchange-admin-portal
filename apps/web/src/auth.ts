import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { needsRefresh, refreshTokens, type SessionTokens } from './lib/token-refresh';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

/** Issuer of the people realm; must match the `iss` Keycloak puts in tokens (KC_HOSTNAME). */
export const keycloakIssuer = (): string =>
  `${process.env.KEYCLOAK_URL ?? 'http://localhost:8080'}/realms/rid-portal`;

const clientId = () => process.env.RID_PORTAL_WEB_CLIENT_ID ?? 'rid-portal-web';

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Keycloak({
      clientId: clientId(),
      clientSecret: required('RID_PORTAL_WEB_CLIENT_SECRET'),
      issuer: keycloakIssuer(),
      // Authorization Code + PKCE S256 (required by the realm), plus state and nonce.
      checks: ['pkce', 'state', 'nonce'],
    }),
  ],
  session: { strategy: 'jwt', maxAge: 10 * 60 * 60 },
  callbacks: {
    async jwt({ token, account }) {
      // Tokens stay in the encrypted, HttpOnly session cookie (server side only). The access
      // token calls apps/api from the server; the id token is used to log out of Keycloak.
      const session = token as typeof token & SessionTokens;
      if (account) {
        return {
          ...token,
          accessToken: account.access_token,
          refreshToken: account.refresh_token,
          idToken: account.id_token,
          expiresAt: account.expires_at,
        };
      }
      if (session.error || !needsRefresh(session)) return token;
      // Access tokens last 5 minutes: refresh before they expire (runs in the proxy on navigation).
      return {
        ...token,
        ...(await refreshTokens(session, {
          tokenEndpoint: `${keycloakIssuer()}/protocol/openid-connect/token`,
          clientId: clientId(),
          clientSecret: required('RID_PORTAL_WEB_CLIENT_SECRET'),
        })),
      };
    },
    session({ session, token }) {
      // Never expose tokens to the browser: the session only carries the user's identity.
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
