import { existsSync } from 'node:fs';
import { fromRoot } from './paths.js';

// Integration tests read the same repo-root .env that the Compose stack uses.
const envFile = fromRoot('.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`${name} is not set (copy .env.example to .env)`);
  }
  return value;
}
