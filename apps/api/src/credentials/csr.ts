import { createPublicKey } from 'node:crypto';
import type { CsrError } from '@den/contracts';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const OID_COMMON_NAME = '2.5.4.3';
const OID_EXTENSION_REQUEST = '1.2.840.113549.1.9.14';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const DNS_NAME = 2;
const CURVES = new Set(['prime256v1', 'secp384r1']);
const PEM_BLOCK =
  /^-----BEGIN (NEW )?CERTIFICATE REQUEST-----\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n?-----END \1?CERTIFICATE REQUEST-----$/;

/** A CSR the portal refuses; `reason` selects the stable message (CSR_ERRORS). */
export class CsrRejected extends Error {
  constructor(readonly reason: CsrError) {
    super(`CSR rejected: ${reason}`);
    this.name = 'CsrRejected';
  }
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function decodePem(pem: string): Buffer {
  const match = PEM_BLOCK.exec(pem.trim());
  if (!match?.[2]) throw new CsrRejected('malformed');
  return Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
}

function parse(der: Buffer): pkijs.CertificationRequest {
  const asn = asn1js.fromBER(toArrayBuffer(der));
  // The whole block must be one DER structure: no trailing bytes.
  if (asn.offset === -1 || asn.offset !== der.byteLength) throw new CsrRejected('malformed');
  let csr: pkijs.CertificationRequest;
  try {
    csr = new pkijs.CertificationRequest({ schema: asn.result });
  } catch {
    throw new CsrRejected('malformed');
  }
  // RFC 2986 makes the attributes field ([0], fourth of certificationRequestInfo) mandatory, even
  // empty, and the CA's parser insists. pkijs reads an empty one as missing: check the DER.
  const info = (asn.result.valueBlock as { value?: asn1js.AsnType[] }).value?.[0];
  const fields = (info?.valueBlock as { value?: asn1js.AsnType[] } | undefined)?.value ?? [];
  const attributes = fields[3]?.idBlock;
  if (fields.length !== 4 || attributes?.tagClass !== 3 || attributes.tagNumber !== 0) {
    throw new CsrRejected('malformed');
  }
  return csr;
}

/** ECDSA P-256/P-384 or RSA 2048-4096: what OpenSSL, Java and .NET clients all handle. */
function checkKey(csr: pkijs.CertificationRequest): void {
  let details: { type?: string; curve?: string; bits?: number };
  try {
    const key = createPublicKey({
      key: Buffer.from(csr.subjectPublicKeyInfo.toSchema().toBER()),
      format: 'der',
      type: 'spki',
    });
    details = {
      type: key.asymmetricKeyType,
      curve: key.asymmetricKeyDetails?.namedCurve,
      bits: key.asymmetricKeyDetails?.modulusLength,
    };
  } catch {
    throw new CsrRejected('key');
  }
  const ok =
    (details.type === 'ec' && CURVES.has(details.curve ?? '')) ||
    (details.type === 'rsa' && (details.bits ?? 0) >= 2048 && (details.bits ?? 0) <= 4096);
  if (!ok) throw new CsrRejected('key');
}

function commonNames(csr: pkijs.CertificationRequest): string[] {
  return csr.subject.typesAndValues
    .filter((tv) => tv.type === OID_COMMON_NAME)
    .map((tv) => {
      const value = (tv.value.valueBlock as { value?: unknown }).value;
      return typeof value === 'string' ? value : '';
    });
}

/** Subject alternative names the CSR asks for, as `type:value` (DNS names as `dns:<name>`). */
function requestedAltNames(csr: pkijs.CertificationRequest): string[] {
  const names: string[] = [];
  for (const attribute of csr.attributes ?? []) {
    if (attribute.type !== OID_EXTENSION_REQUEST) continue;
    for (const value of attribute.values) {
      const extensions = new pkijs.Extensions({ schema: value });
      for (const extension of extensions.extensions) {
        if (extension.extnID !== OID_SUBJECT_ALT_NAME) continue;
        const inner = asn1js.fromBER(toArrayBuffer(extension.extnValue.valueBlock.valueHexView));
        if (inner.offset === -1) throw new CsrRejected('malformed');
        const altNames = new pkijs.GeneralNames({ schema: inner.result });
        for (const name of altNames.names) {
          names.push(name.type === DNS_NAME ? `dns:${String(name.value)}` : `other:${name.type}`);
        }
      }
    }
  }
  return names;
}

/**
 * Checks a PKCS#10 CSR before it reaches the CA (SPEC.md §4.3): one PEM block, a self-signature
 * that verifies, an accepted key, and a subject naming only the application, CN=<clientId> (no
 * other subject alternative name than that same client id). The CA issues the certificate with
 * the subject alone (infra/step-ca/app.tpl), so other subject attributes are ignored. Returns the
 * request re-encoded as canonical PEM and its public key (SPKI, DER), to compare with what the CA
 * issues.
 */
export async function checkCsr(
  pem: string,
  clientId: string,
  options: { altNames?: 'same' | 'none' } = {},
): Promise<{ pem: string; publicKey: Buffer }> {
  const der = decodePem(pem);
  const csr = parse(der);
  checkKey(csr);
  let verified: boolean;
  try {
    // pkijs uses Node's global WebCrypto.
    verified = await csr.verify();
  } catch {
    verified = false;
  }
  if (!verified) throw new CsrRejected('signature');
  const cns = commonNames(csr);
  let altNames: string[];
  try {
    altNames = requestedAltNames(csr);
  } catch {
    throw new CsrRejected('malformed');
  }
  // Kit nodes (M4-02) ask with the fixed CN=den-node and no names: the CA adds the node's own
  // name, which the kit does not know before enrolling.
  const badAltNames =
    options.altNames === 'none'
      ? altNames.length > 0
      : altNames.some((n) => n !== `dns:${clientId}`);
  if (cns.length !== 1 || cns[0] !== clientId || badAltNames) {
    throw new CsrRejected('subject');
  }
  const body = der.toString('base64').replace(/.{1,64}/g, '$&\n');
  return {
    pem: `-----BEGIN CERTIFICATE REQUEST-----\n${body}-----END CERTIFICATE REQUEST-----\n`,
    publicKey: Buffer.from(csr.subjectPublicKeyInfo.toSchema().toBER()),
  };
}
