import { sha256 } from '@noble/hashes/sha2.js';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { equalBytes } from './merkle.js';

/**
 * RFC 3161 time-stamps: the request the portal sends to the TSA and the verification of the
 * token it gets back. A token proves that the stamped bytes existed at genTime, signed by a TSA
 * certificate that chains to a root the verifier trusts and is meant for time-stamping.
 */

const OID_SHA256 = '2.16.840.1.101.3.4.2.1';
const OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
const OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
const OID_EKU = '2.5.29.37';
const OID_EKU_TIME_STAMPING = '1.3.6.1.5.5.7.3.8';

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

/** DER of a TimeStampReq over SHA-256(data), asking the TSA to include its certificate. */
export function timestampRequest(data: Uint8Array, nonce: Uint8Array): Uint8Array {
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: toArrayBuffer(sha256(data)) }),
    }),
    nonce: new asn1js.Integer({ valueHex: toArrayBuffer(nonce) }),
    certReq: true,
  });
  return new Uint8Array(request.toSchema().toBER());
}

export class TimestampError extends Error {
  override name = 'TimestampError';
}

/**
 * Takes the TSA's TimeStampResp and returns the token (DER ContentInfo) if the TSA granted it for
 * exactly these bytes and this nonce. Signature and chain are checked by verifyTimestampToken.
 */
export function tokenFromResponse(response: Uint8Array, data: Uint8Array, nonce: Uint8Array) {
  let parsed: pkijs.TimeStampResp;
  try {
    parsed = pkijs.TimeStampResp.fromBER(toArrayBuffer(response));
  } catch {
    throw new TimestampError('The TSA response is not a TimeStampResp');
  }
  const granted = [pkijs.PKIStatus.granted, pkijs.PKIStatus.grantedWithMods];
  if (!granted.includes(parsed.status.status) || !parsed.timeStampToken) {
    throw new TimestampError(`The TSA refused the request (status ${parsed.status.status})`);
  }
  const info = tstInfoOf(parsed.timeStampToken);
  if (!equalBytes(imprintOf(info), sha256(data))) {
    throw new TimestampError('The TSA stamped other bytes');
  }
  const echoed = info.nonce ? new Uint8Array(info.nonce.valueBlock.valueHexView) : undefined;
  if (!echoed || !equalBytes(stripLeadingZeros(echoed), stripLeadingZeros(nonce))) {
    throw new TimestampError('The TSA response does not carry the request nonce');
  }
  return new Uint8Array(parsed.timeStampToken.toSchema().toBER());
}

export interface TimestampVerification {
  genTime: Date;
  /** Accuracy the TSA declares for genTime (RFC 3161 §2.4.2), in milliseconds; 0 if none. */
  accuracyMs: number;
  serialNumber: string;
}

/**
 * Verifies a time-stamp token over `data`: the message imprint is SHA-256(data), the CMS
 * signature is valid, the signer certificate chains to one of `trustedRoots` (PEM) at genTime,
 * and it carries the time-stamping extended key usage. Throws TimestampError otherwise.
 */
export async function verifyTimestampToken(
  token: Uint8Array,
  data: Uint8Array,
  trustedRoots: readonly string[],
): Promise<TimestampVerification> {
  let contentInfo: pkijs.ContentInfo;
  try {
    contentInfo = pkijs.ContentInfo.fromBER(toArrayBuffer(token));
  } catch {
    throw new TimestampError('The time-stamp token is not a CMS ContentInfo');
  }
  const info = tstInfoOf(contentInfo);
  if (info.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) {
    throw new TimestampError('The time-stamp does not use SHA-256');
  }
  if (!equalBytes(imprintOf(info), sha256(data))) {
    throw new TimestampError('The time-stamp is for other bytes');
  }
  if (trustedRoots.length === 0) throw new TimestampError('No trusted TSA root given');

  const signed = new pkijs.SignedData({ schema: contentInfo.content });
  let result: pkijs.SignedDataVerifyResult;
  try {
    result = await signed.verify({
      signer: 0,
      data: toArrayBuffer(data),
      trustedCerts: trustedRoots.map(certificateFromPem),
      checkChain: true,
      extendedMode: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TimestampError(`The time-stamp signature does not verify: ${message}`);
  }
  if (!result.signatureVerified || !result.signerCertificateVerified || !result.signerCertificate) {
    throw new TimestampError('The time-stamp signature or its certificate chain does not verify');
  }
  if (!hasTimeStampingUsage(result.signerCertificate)) {
    throw new TimestampError('The signer certificate is not meant for time-stamping');
  }
  const accuracy = info.accuracy;
  return {
    genTime: info.genTime,
    accuracyMs: accuracy
      ? (accuracy.seconds ?? 0) * 1000 + (accuracy.millis ?? 0) + (accuracy.micros ?? 0) / 1000
      : 0,
    serialNumber: Buffer.from(info.serialNumber.valueBlock.valueHexView).toString('hex'),
  };
}

function tstInfoOf(contentInfo: pkijs.ContentInfo): pkijs.TSTInfo {
  if (contentInfo.contentType !== OID_SIGNED_DATA) {
    throw new TimestampError('The time-stamp token is not CMS SignedData');
  }
  const signed = new pkijs.SignedData({ schema: contentInfo.content });
  const eContent = signed.encapContentInfo.eContent;
  if (signed.encapContentInfo.eContentType !== OID_TST_INFO || !eContent) {
    throw new TimestampError('The time-stamp token carries no TSTInfo');
  }
  try {
    return pkijs.TSTInfo.fromBER(eContent.getValue());
  } catch {
    throw new TimestampError('The TSTInfo of the time-stamp is malformed');
  }
}

const imprintOf = (info: pkijs.TSTInfo) =>
  new Uint8Array(info.messageImprint.hashedMessage.valueBlock.valueHexView);

function hasTimeStampingUsage(certificate: pkijs.Certificate): boolean {
  const extension = certificate.extensions?.find((e) => e.extnID === OID_EKU);
  const usages = (extension?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  return extension?.critical === true && usages.includes(OID_EKU_TIME_STAMPING);
}

export function certificateFromPem(pem: string): pkijs.Certificate {
  const body = /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\s]+)-----END CERTIFICATE-----/.exec(pem);
  if (!body?.[1]) throw new TimestampError('Not a PEM certificate');
  const der = Buffer.from(body[1].replace(/\s+/g, ''), 'base64');
  return pkijs.Certificate.fromBER(toArrayBuffer(new Uint8Array(der)));
}

/** All PEM certificates in a bundle. */
export const certificatesInPem = (bundle: string): string[] =>
  bundle.match(/-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+-----END CERTIFICATE-----/g) ?? [];

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.subarray(i);
}
