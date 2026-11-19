import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';
import { needsRefresh, refreshTokens, type SessionTokens } from './lib/token-refresh';

declare module 'next-auth' {
  interface Session {
    /** When Keycloak last saw the session, epoch seconds (see SessionTokens.refreshedAt). */
    refreshedAt?: number;
  }
}

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

/** Issuer of the people realm; must match the `iss` Keycloak puts in tokens (KC_HOSTNAME). */
export const keycloakIssuer = (): string =>
  `${process.env.KEYCLOAK_URL ?? 'http://localhost:8080'}/realms/den-portal`;

const clientId = () => process.env.DEN_PORTAL_WEB_CLIENT_ID ?? 'den-portal-web';

export const { handlers, auth, signIn, signOut, unstable_update } = NextAuth({
  providers: [
    Keycloak({
      clientId: clientId(),
      clientSecret: required('DEN_PORTAL_WEB_CLIENT_SECRET'),
      issuer: keycloakIssuer(),
      // Authorization Code + PKCE S256 (required by the realm), plus state and nonce.
      checks: ['pkce', 'state', 'nonce'],
    }),
  ],
  session: { strategy: 'jwt', maxAge: 10 * 60 * 60 },
  callbacks: {
    async jwt({ token, account, trigger }) {
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
          refreshedAt: Math.floor(Date.now() / 1000),
        };
      }
      // A session whose refresh failed is over: returning null deletes the cookie, so the user is
      // signed out instead of keeping, for up to ten hours, a session that every API call
      // rejects (B-25).
      if (session.error) return null;
      // "Stay signed in" asks for a refresh now (trigger `update`): the Keycloak session only
      // lasts as long as refreshes keep arriving, not as long as the access token is valid.
      if (trigger !== 'update' && !needsRefresh(session)) return token;
      // Access tokens last 5 minutes: refresh before they expire (runs in the proxy on navigation).
      const refreshed = await refreshTokens(session, {
        tokenEndpoint: `${keycloakIssuer()}/protocol/openid-connect/token`,
        clientId: clientId(),
        clientSecret: required('DEN_PORTAL_WEB_CLIENT_SECRET'),
      });
      return refreshed.error ? null : { ...token, ...refreshed };
    },
    session({ session, token }) {
      // Never expose tokens to the browser: the session only carries the user's identity.
      if (token.sub) session.user.id = token.sub;
      // When Keycloak last saw the session: the session-end notice counts from here (B-25).
      session.refreshedAt = (token as typeof token & SessionTokens).refreshedAt;
      return session;
    },
  },
});
