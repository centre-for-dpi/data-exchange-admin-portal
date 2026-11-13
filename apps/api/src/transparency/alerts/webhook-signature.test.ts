import { describe, expect, it } from 'vitest';
import { signWebhook, verifyWebhook, webhookHeaders } from './webhook-signature.js';

describe('webhook signatures (Standard Webhooks)', () => {
  it('matches the example of the specification', () => {
    expect(
      signWebhook(
        'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
        'msg_p5jXN8AQM9LWM0D4loKWxJek',
        1614265330,
        '{"test": 2432232314}',
      ),
    ).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
  });

  it('verifies its own messages and rejects tampering, other keys and replays', () => {
    const secret = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
    const other = `whsec_${Buffer.alloc(32, 8).toString('base64')}`;
    const now = new Date('2026-11-13T12:00:00Z');
    const body = '{"type":"subject_access.created"}';
    const headers = webhookHeaders(secret, 'evt-1', body, now);
    expect(verifyWebhook(secret, headers, body, now)).toBe(true);
    expect(verifyWebhook(secret, headers, `${body} `, now)).toBe(false);
    expect(verifyWebhook(other, headers, body, now)).toBe(false);
    expect(verifyWebhook(secret, { ...headers, 'webhook-id': 'evt-2' }, body, now)).toBe(false);
    expect(verifyWebhook(secret, headers, body, new Date('2026-11-13T12:10:00Z'))).toBe(false);
  });
});
