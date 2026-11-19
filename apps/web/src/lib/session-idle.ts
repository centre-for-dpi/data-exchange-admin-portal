/** Keycloak's ssoSessionIdleTimeout of the realm den-portal (30 minutes by default), seconds. */
export const sessionIdleSeconds = (): number => {
  const value = Number(process.env.DEN_SESSION_IDLE_SECONDS);
  return Number.isInteger(value) && value > 180 ? value : 1800;
};
