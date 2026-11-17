import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures as in the Standard Webhooks specification (standardwebhooks.com), so a
 * citizen app can verify them with any library that implements it:
 *   webhook-id, webhook-timestamp (Unix seconds),
 *   webhook-signature: v1,<base64 HMAC-SHA256(key, `${id}.${timestamp}.${body}`)>
 * The secret is `whsec_<base64 key>`.
 */
export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Messages older or newer than this are rejected (replay protection). */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

function keyOf(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX))
    throw new Error('Webhook secret must start with whsec_');
  const key = Buffer.from(secret.slice(WEBHOOK_SECRET_PREFIX.length), 'base64');
  if (key.length < 24) throw new Error('Webhook secret is too short');
  return key;
}

export function signWebhook(secret: string, id: string, timestamp: number, body: string): string {
  const mac = createHmac('sha256', keyOf(secret))
    .update(`${id}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${mac}`;
}

export interface WebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export function webhookHeaders(
  secret: string,
  id: string,
  body: string,
  now = new Date(),
): WebhookHeaders {
  const timestamp = Math.floor(now.getTime() / 1000);
  return {
    'webhook-id': id,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': signWebhook(secret, id, timestamp, body),
  };
}

/** For receivers (the reference citizen app, tests): true if one of the v1 signatures matches. */
export function verifyWebhook(
  secret: string,
  headers: Partial<Record<keyof WebhookHeaders, string | undefined>>,
  body: string,
  now = new Date(),
): boolean {
  const id = headers['webhook-id'];
  const timestamp = Number(headers['webhook-timestamp']);
  const signatures = headers['webhook-signature'];
  if (!id || !Number.isInteger(timestamp) || !signatures) return false;
  if (Math.abs(now.getTime() / 1000 - timestamp) > WEBHOOK_TOLERANCE_SECONDS) return false;
  const expected = Buffer.from(signWebhook(secret, id, timestamp, body));
  return signatures.split(' ').some((candidate) => {
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
