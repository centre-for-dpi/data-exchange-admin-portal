#!/usr/bin/env node
// One-time codes of the demo users (M3-08): RFC 6238 TOTP, 6 digits, 30 s, HMAC-SHA1, as the
// den-portal realm's OTP policy says. The key is the UTF-8 bytes of DEN_DEMO_TOTP_SECRET, like the
// OTP credential the realm imports for the seed users with a critical role (dev and demo only).
//
//   pnpm demo:otp            # current code, and the key to add to an authenticator app
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The default of the realm file's placeholder ${DEN_DEMO_TOTP_SECRET:...}. */
export const DEFAULT_DEMO_TOTP_SECRET = 'den-demo-totp-secret';

export function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Base32 (RFC 4648, no padding): the form authenticator apps ask for. */
export function base32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(secret, 'utf8')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));
  const secret = process.env.DEN_DEMO_TOTP_SECRET ?? DEFAULT_DEMO_TOTP_SECRET;
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  console.log(
    `Código de un solo uso de los usuarios de demo: ${totp(secret)} (vence en ${left} s)`,
  );
  console.log(`Clave para una app autenticadora (TOTP, SHA-1, 6 dígitos, 30 s): ${base32(secret)}`);
}
