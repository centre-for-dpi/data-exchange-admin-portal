/**
 * OPA's API as the operator (B-15, ADR-0031): only decisions go without the admin token, so a test
 * that loads a policy or data into the local OPA sends DEN_OPA_ADMIN_TOKEN (the repo-root .env).
 */
export function opaAdminFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${process.env.DEN_OPA_ADMIN_TOKEN ?? ''}`);
  return fetch(url, { ...init, headers });
}

/** The gateway's token for decisions, as the reconciler writes it in each route's opa plugin. */
export const opaDecisionToken = (): string | undefined =>
  process.env.DEN_OPA_DECISION_TOKEN || undefined;
