import { describe, expect, it } from 'vitest';
import { makeCsr } from '../../test/csr.js';
import { checkCsr, CsrRejected } from './csr.js';

const CLIENT = 'den-app-0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';

const reason = async (pem: string, clientId = CLIENT) => {
  try {
    await checkCsr(pem, clientId);
    return 'accepted';
  } catch (error) {
    if (error instanceof CsrRejected) return error.reason;
    throw error;
  }
};

describe('CSR checks before signing (M3-01)', () => {
  it('accepts ECDSA P-256, P-384 and RSA 2048 CSRs naming the client', async () => {
    expect(await reason(await makeCsr(CLIENT))).toBe('accepted');
    expect(await reason(await makeCsr(CLIENT, { key: 'P-384' }))).toBe('accepted');
    expect(await reason(await makeCsr(CLIENT, { key: 'RSA-2048' }))).toBe('accepted');
  });

  it('ignores other subject attributes and accepts the client id as its only DNS name', async () => {
    expect(await reason(await makeCsr(CLIENT, { organization: 'Programas' }))).toBe('accepted');
    expect(await reason(await makeCsr(CLIENT, { dnsNames: [CLIENT] }))).toBe('accepted');
  });

  it('returns the request as canonical PEM', async () => {
    const csr = await makeCsr(CLIENT);
    const canonical = await checkCsr(`\n\n${csr.replace(/\n/g, '\r\n')}  `, CLIENT);
    expect(canonical.pem).toBe(csr);
    expect(canonical.publicKey.length).toBeGreaterThan(60);
  });

  it('rejects a subject that does not name this application only', async () => {
    expect(await reason(await makeCsr('den-app-other'))).toBe('subject');
    expect(await reason(await makeCsr(CLIENT, { secondCn: 'den-app-other' }))).toBe('subject');
    expect(await reason(await makeCsr(CLIENT, { dnsNames: [CLIENT, 'evil.example'] }))).toBe(
      'subject',
    );
  });

  it('rejects weak or unusual keys', async () => {
    expect(await reason(await makeCsr(CLIENT, { key: 'RSA-1024' }))).toBe('key');
    expect(await reason(await makeCsr(CLIENT, { key: 'P-521' }))).toBe('key');
  });

  it('rejects a CSR whose signature does not verify', async () => {
    expect(await reason(await makeCsr(CLIENT, { tamper: true }))).toBe('signature');
  });

  it('rejects anything that is not exactly one PEM certificate request', async () => {
    const csr = await makeCsr(CLIENT);
    expect(await reason('hello')).toBe('malformed');
    expect(await reason(await makeCsr(CLIENT, { noAttributes: true }))).toBe('malformed');
    expect(await reason(csr.replace(/CERTIFICATE REQUEST/g, 'CERTIFICATE'))).toBe('malformed');
    expect(await reason(`${csr}${csr}`)).toBe('malformed');
    expect(
      await reason('-----BEGIN CERTIFICATE REQUEST-----\nAAAA\n-----END CERTIFICATE REQUEST-----'),
    ).toBe('malformed');
    // Trailing bytes after the DER structure.
    const body = csr.split('\n').slice(1, -2).join('');
    const padded = Buffer.concat([Buffer.from(body, 'base64'), Buffer.from([0, 0])]);
    expect(
      await reason(
        `-----BEGIN CERTIFICATE REQUEST-----\n${padded.toString('base64')}\n-----END CERTIFICATE REQUEST-----`,
      ),
    ).toBe('malformed');
  });
});
