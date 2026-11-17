import { ConsoleLogger, type LogLevel } from '@nestjs/common';

/**
 * The API's logger (ARCHITECTURE.md §8, ASVS 16.4.3, M6-05). Every line it writes, message and
 * stack trace alike, is masked first (CLAUDE.md, rule 2): an error can quote a request path with
 * an identification number, a query string, an e-mail address or a connection URL with its
 * password. In `json` format (DEN_LOG_FORMAT=json, the Helm chart) each record is one JSON object
 * per line on stdout/stderr, for the cluster's log collector to ship to the operator's central
 * system; `text` (the default) is Nest's usual format, colored only on a terminal.
 */
export type LogFormat = 'text' | 'json';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** A UUID is kept (it names a record, not a person); six digits or more are masked. */
const UUID_OR_NUMBER = new RegExp(`${UUID}|\\d{6,}`, 'gi');
/** A query string, up to whitespace. */
const QUERY = /\?\S+/g;
const URL_CREDENTIALS = /:\/\/[^\s/@]+@/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi;

export function maskLogText(text: string): string {
  return text
    .replace(URL_CREDENTIALS, '://[masked]@')
    .replace(EMAIL, '[email]')
    .replace(QUERY, '?[masked]')
    .replace(UUID_OR_NUMBER, (match) => (match.includes('-') ? match : '[n]'));
}

export function logFormat(env: NodeJS.ProcessEnv = process.env): LogFormat {
  const value = env.DEN_LOG_FORMAT?.trim().toLowerCase();
  if (!value || value === 'text') return 'text';
  if (value === 'json') return 'json';
  throw new Error(`DEN_LOG_FORMAT must be "text" or "json", got "${value}"`);
}

export class DenLogger extends ConsoleLogger {
  constructor(format: LogFormat, logLevels: LogLevel[]) {
    super({
      json: format === 'json',
      colors: format === 'text' && process.stdout.isTTY === true,
      logLevels,
    });
  }

  protected override formatMessage(...args: Parameters<ConsoleLogger['formatMessage']>): string {
    return maskLogText(super.formatMessage(...args));
  }

  protected override printStackTrace(stack: string): void {
    super.printStackTrace(stack ? maskLogText(stack) : stack);
  }

  /** In JSON, each string value is masked before it is serialized (numbers stay numbers). */
  protected override stringifyReplacer(key: string, value: unknown): unknown {
    const replaced = super.stringifyReplacer(key, value);
    return typeof replaced === 'string' ? maskLogText(replaced) : replaced;
  }
}
