import { webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

/**
 * A P-256 key and its PKCS#10 CSR with subject CN=<cn>, as `openssl req -new -subj /CN=<cn>`
 * would make them on the consumer's server.
 */
export async function makeCsr(cn: string): Promise<{ csr: string; keyPem: string }> {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const request = new pkijs.CertificationRequest();
  request.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: cn }),
    }),
  );
  await request.subjectPublicKeyInfo.importKey(pair.publicKey as never);
  // PKCS#10 requires the attributes field, even empty; pkijs writes it only when set.
  request.attributes = [];
  await request.sign(pair.privateKey as never, 'SHA-256');
  const pem = (label: string, der: ArrayBuffer) =>
    `-----BEGIN ${label}-----\n${Buffer.from(der)
      .toString('base64')
      .replace(/.{1,64}/g, '$&\n')}-----END ${label}-----\n`;
  return {
    csr: pem('CERTIFICATE REQUEST', request.toSchema().toBER(false)),
    keyPem: pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)),
  };
}
