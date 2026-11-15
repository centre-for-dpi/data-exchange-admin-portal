import { webcrypto } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export type CsrKey = 'P-256' | 'P-384' | 'P-521' | 'RSA-2048' | 'RSA-1024';

export interface CsrOptions {
  key?: CsrKey;
  /** Extra subject attributes, e.g. organisation (ignored by the CA). */
  organization?: string;
  /** Requested DNS subject alternative names. */
  dnsNames?: string[];
  /** A second CN. */
  secondCn?: string;
  /** Flip a byte of the signature. */
  tamper?: boolean;
  /** Leave out the (mandatory) attributes field. */
  noAttributes?: boolean;
}

const algorithm = (key: CsrKey): webcrypto.RsaHashedKeyGenParams | webcrypto.EcKeyGenParams =>
  key.startsWith('RSA')
    ? {
        name: 'RSASSA-PKCS1-v1_5',
        modulusLength: Number(key.slice(4)),
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: 'SHA-256',
      }
    : { name: 'ECDSA', namedCurve: key };

const pem = (der: ArrayBuffer): string =>
  `-----BEGIN CERTIFICATE REQUEST-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE REQUEST-----\n`;

/** Builds a PKCS#10 CSR for tests, the way `openssl req -new -subj /CN=<cn>` would. */
export async function makeCsr(cn: string, options: CsrOptions = {}): Promise<string> {
  return (await makeKeyAndCsr(cn, options)).csr;
}

/** The CSR and its private key (PKCS#8 PEM), to use the issued certificate in TLS tests. */
export async function makeKeyAndCsr(
  cn: string,
  options: CsrOptions = {},
): Promise<{ csr: string; keyPem: string }> {
  const key = options.key ?? 'P-256';
  const pair = await webcrypto.subtle.generateKey(algorithm(key), true, ['sign', 'verify']);
  const csr = new pkijs.CertificationRequest();
  const name = (type: string, value: string) =>
    new pkijs.AttributeTypeAndValue({ type, value: new asn1js.Utf8String({ value }) });
  if (options.organization) csr.subject.typesAndValues.push(name('2.5.4.10', options.organization));
  csr.subject.typesAndValues.push(name('2.5.4.3', cn));
  if (options.secondCn) csr.subject.typesAndValues.push(name('2.5.4.3', options.secondCn));
  await csr.subjectPublicKeyInfo.importKey(pair.publicKey);
  // PKCS#10 requires the attributes field, even empty (Go, and so step-ca, insists). pkijs writes
  // it only when the property exists.
  if (!options.noAttributes) csr.attributes = [];
  if (options.dnsNames?.length) {
    const altNames = new pkijs.GeneralNames({
      names: options.dnsNames.map((value) => new pkijs.GeneralName({ type: 2, value })),
    });
    csr.attributes = [
      new pkijs.Attribute({
        type: '1.2.840.113549.1.9.14',
        values: [
          new pkijs.Extensions({
            extensions: [
              new pkijs.Extension({
                extnID: '2.5.29.17',
                critical: false,
                extnValue: altNames.toSchema().toBER(false),
              }),
            ],
          }).toSchema(),
        ],
      }),
    ];
  }
  await csr.sign(pair.privateKey, 'SHA-256');
  const der = new Uint8Array(csr.toSchema().toBER(false));
  if (options.tamper) der[der.length - 5] = (der[der.length - 5] ?? 0) ^ 0xff;
  const pkcs8 = await webcrypto.subtle.exportKey('pkcs8', pair.privateKey);
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(pkcs8)
    .toString('base64')
    .replace(/.{1,64}/g, '$&\n')}-----END PRIVATE KEY-----\n`;
  return { csr: pem(der.buffer), keyPem };
}
