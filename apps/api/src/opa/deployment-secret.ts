/**
 * A key of the deployment that OPA uses (the end user salt, the data subject key). It must be
 * long enough and, in production, not the example value of .env.example: every deployment has
 * its own, or the same official or citizen gets the same hash in two countries' logs (M3-06).
 * Throws with the reason; the caller fails closed (no bundle, the gateway denies).
 */
export function deploymentSecret(
  name: string,
  value: string | undefined,
  minLength: number,
  production = process.env.NODE_ENV === 'production',
): string {
  const secret = value ?? '';
  if (secret.length < minLength) {
    throw new Error(`${name} is missing or shorter than ${minLength}`);
  }
  if (production && /change-me/i.test(secret)) {
    throw new Error(`${name} is the example value of .env.example: generate one per deployment`);
  }
  return secret;
}
