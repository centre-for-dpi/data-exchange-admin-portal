import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  certificatesInPem,
  timestampRequest,
  tokenFromResponse,
  verifyTimestampToken,
} from '@den/transparency-verifier';

const TIMEOUT_MS = 10_000;

export interface Stamp {
  token: Uint8Array;
  genTime: Date;
  serialNumber: string;
}

/**
 * Client of the RFC 3161 time-stamping authority (DEN_TSA_URL; sigstore timestamp-server in
 * development, the country's accredited TSA in production). Each token is checked before it is
 * stored: right bytes, right nonce, valid signature chaining to the TSA's published chain.
 */
@Injectable()
export class TsaClient {
  private chain?: string[];

  private baseUrl(): string {
    return (process.env.DEN_TSA_URL ?? 'http://localhost:3004').replace(/\/+$/, '');
  }

  /** The TSA's certificate chain (PEM), fetched once from the TSA itself. */
  async certificates(): Promise<string[]> {
    if (this.chain) return this.chain;
    const res = await fetch(`${this.baseUrl()}/api/v1/timestamp/certchain`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TSA certificate chain: HTTP ${res.status}`);
    const chain = certificatesInPem(await res.text());
    if (chain.length === 0) throw new Error('TSA certificate chain: no certificates');
    this.chain = chain;
    return chain;
  }

  async stamp(data: Uint8Array): Promise<Stamp> {
    const nonce = randomBytes(8);
    const res = await fetch(`${this.baseUrl()}/api/v1/timestamp`, {
      method: 'POST',
      headers: { 'content-type': 'application/timestamp-query' },
      body: Buffer.from(timestampRequest(data, nonce)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`TSA: HTTP ${res.status}`);
    const token = tokenFromResponse(new Uint8Array(await res.arrayBuffer()), data, nonce);
    const { genTime, serialNumber } = await verifyTimestampToken(
      token,
      data,
      await this.certificates(),
    );
    return { token, genTime, serialNumber };
  }
}
