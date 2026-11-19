/** Runs once when the server starts (Next.js instrumentation). */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertWebSecretsAreNotExamples } = await import('./lib/example-secrets');
  try {
    assertWebSecretsAreNotExamples();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
