import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { CountryConfigError, getCountryConfig } from '@den/config';
import { createApp } from './app.js';
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

  const app = await createApp();
  const port = Number(process.env.API_PORT ?? DEFAULT_PORT);
  await app.listen(port, '0.0.0.0');
  new Logger('Bootstrap').log(`Portal API listening on ${port} (country ${country})`);
}

void bootstrap();
