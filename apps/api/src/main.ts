import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CountryConfigError, getCountryConfig } from '@den/config';
import { createApp } from './app.js';
import { allowedUpstreamTypes } from './apis/upstream-types.js';
import { assertApiSecretsAreNotExamples } from './common/example-secrets.js';
import { loadDevEnv } from './dev-env.js';

const DEFAULT_PORT = 4000;

async function bootstrap(): Promise<void> {
  loadDevEnv();

  // Fail fast: an invalid or missing country configuration must stop the process (M0-06).
  let country: string;
  try {
    country = getCountryConfig().country.code;
  } catch (error) {
    if (error instanceof CountryConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  // M-25: in production, no secret may keep the public value of .env.example.
  try {
    assertApiSecretsAreNotExamples();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  // P-04: a country that only accepts xroad needs the deployment's X-Road settings, or providers
  // could not publish anything.
  if (allowedUpstreamTypes().length === 0) {
    console.error(
      'features.upstreams only allows xroad, and DEN_XROAD_SECURITY_SERVER_URL and ' +
        'DEN_XROAD_CLIENT are not set: providers could not register any version',
    );
    process.exit(1);
  }

  const app = await createApp();
  const port = Number(process.env.API_PORT ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Portal API listening on ${port} (country ${country})`);
}

void bootstrap();
