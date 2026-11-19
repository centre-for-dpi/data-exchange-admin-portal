import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDotenv } from '@den/config';
import { describe, expect, it } from 'vitest';
import { API_SECRETS, assertApiSecretsAreNotExamples } from './example-secrets.js';

const exampleFile = resolve(import.meta.dirname, '../../../../.env.example');
const example = parseDotenv(readFileSync(exampleFile, 'utf8'));

describe('the API refuses the example secrets in production (M-25)', () => {
  it('every secret it checks is documented in .env.example', () => {
    const text = readFileSync(exampleFile, 'utf8');
    for (const name of API_SECRETS) expect(text, name).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
  });

  it('a copy of .env.example does not start', () => {
    const env = { ...Object.fromEntries(example), NODE_ENV: 'production' };
    let message = '';
    try {
      assertApiSecretsAreNotExamples({ env });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of API_SECRETS.filter((n) => example.get(n))) {
      expect(message, name).toContain(name);
    }
  });

  it('the example database password inside DATABASE_URL counts', () => {
    const env = {
      NODE_ENV: 'production',
      DATABASE_URL: `postgresql://den_app:${example.get('DEN_APP_DB_PASSWORD')}@postgres:5432/den`,
    };
    expect(() => assertApiSecretsAreNotExamples({ env })).toThrow(/DATABASE_URL/);
  });

  it('generated secrets start, and development keeps the examples', () => {
    const env: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
    for (const name of API_SECRETS) env[name] = randomBytes(24).toString('base64url');
    expect(() => assertApiSecretsAreNotExamples({ env })).not.toThrow();
    expect(() =>
      assertApiSecretsAreNotExamples({ env: { ...Object.fromEntries(example) } }),
    ).not.toThrow();
  });
});
