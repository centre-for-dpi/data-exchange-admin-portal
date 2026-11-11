import NextAuth from 'next-auth';
import Keycloak from 'next-auth/providers/keycloak';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set (see .env.example)`);
  return value;
};

/** Issuer of the people realm; must match the `iss` Keycloak puts in tokens (KC_HOSTNAME). */
export const keycloakIssuer = (): string =>
  `${process.env.KEYCLOAK_URL ?? 'http://localhost:8080'}/realms/rid-portal`;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Keycloak({
      clientId: process.env.RID_PORTAL_WEB_CLIENT_ID ?? 'rid-portal-web',
      clientSecret: required('RID_PORTAL_WEB_CLIENT_SECRET'),
      issuer: keycloakIssuer(),
      // Authorization Code + PKCE S256 (required by the realm), plus state and nonce.
      checks: ['pkce', 'state', 'nonce'],
    }),
  ],
  session: { strategy: 'jwt', maxAge: 10 * 60 * 60 },
  callbacks: {
    jwt({ token, account }) {
      // Tokens stay in the encrypted, HttpOnly session cookie (server side only). The access
      // token is used to call apps/api from server components (M1-02); the id token to log out.
      if (account) {
        token.accessToken = account.access_token;
        token.idToken = account.id_token;
        token.expiresAt = account.expires_at;
      }
      return token;
    },
    session({ session, token }) {
      // Never expose tokens to the browser: the session only carries the user's identity.
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
});
