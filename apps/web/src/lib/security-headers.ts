/**
 * Security headers of the web (M3-09, CLAUDE.md rule 9, OWASP ASVS V14.4).
 *
 * Pages get a per-request Content-Security-Policy with a nonce (set in the proxy): Next.js reads
 * the nonce from the request's CSP header and puts it on its own scripts, and `strict-dynamic`
 * lets those scripts load the app's chunks. Routes the proxy does not see (Auth.js, the branding
 * route) get a static policy from next.config, and file downloads their own sandbox policy.
 */

export interface CspOptions {
  /** Fresh per request, base64. */
  nonce: string;
  /** `next dev`: React needs eval for its debugging tools, and HMR a WebSocket. */
  development: boolean;
  /**
   * Where forms may go besides this origin. Sign-in and sign-out are server actions that
   * redirect to Keycloak, and browsers apply form-action to the redirect as well.
   */
  formTargets: readonly string[];
  /** The site is served over HTTPS: upgrade any http:// subresource. */
  https: boolean;
}

export function contentSecurityPolicy(options: CspOptions): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${options.nonce}'`,
      "'strict-dynamic'",
      ...(options.development ? ["'unsafe-eval'"] : []),
    ],
    // Style attributes (the brand colours from the country config) and the inline styles of
    // Scalar's API reference. Styles cannot run code; scripts stay nonce-only.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...(options.development ? ['ws:'] : [])],
    'frame-src': ["'none'"],
    'worker-src': ["'self'", 'blob:'],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'self'", ...options.formTargets],
    // Nobody may frame the portal (clickjacking).
    'frame-ancestors': ["'none'"],
  };
  const policy = Object.entries(directives).map(([name, values]) => `${name} ${values.join(' ')}`);
  if (options.https) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

/** For responses that are not pages (JSON, redirects, the logo): they load nothing. */
export const STATIC_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";

/**
 * Headers every response carries, page or not. next.config bakes them in at build time, before
 * the image knows its public URL, so none depends on it: browsers ignore HSTS received over http
 * (RFC 6797 §8.1), so it is always sent.
 */
export function securityHeaders(): Array<{ key: string; value: string }> {
  return [
    // Two years, as the HSTS preload list asks.
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    // Paths can carry ids: only the origin leaves the portal.
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
    { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    {
      key: 'Permissions-Policy',
      value:
        'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()',
    },
  ];
}

/** The origin of a URL, or nothing if it is not one. */
export function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A nonce for one response: 16 random bytes, base64 (CSP Level 3 asks for at least 128 bits). */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
