import { randomBytes, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import {
  certificatesInPem,
  timestampRequest,
  tokenFromResponse,
  verifyTimestampToken,
} from '@den/transparency-verifier';

const TIMEOUT_MS = 10_000;

/** Subject of the root infra/tsa/init.sh creates for the development TSA. */
export const DEVELOPMENT_TSA_ROOT = 'CN=DEN Dev TSA Root';

export interface Stamp {
  token: Uint8Array;
  genTime: Date;
  serialNumber: string;
}

/**
 * Where the TSA is and what makes its stamps trusted (ADR-0032, M-14).
 *  - Pinned (DEN_TSA_ROOTS_FILE set): DEN_TSA_URL is the full URL of an RFC 3161 TSA, requests
 *    are POSTed to it as is, and its stamps are trusted only if they chain to the PEM roots in the
 *    file. Nothing about trust is downloaded: the country's accredited TSA.
 *  - Development (no roots file): DEN_TSA_URL is the base of the development TSA (sigstore
 *    timestamp-server, infra/tsa): stamps at /api/v1/timestamp, and its chain fetched from the
 *    TSA itself at /api/v1/timestamp/certchain. The operator runs it and holds its key.
 */
export interface TsaSettings {
  url: string;
  rootsFile: string | null;
  /** The development TSA's own chain endpoint; null when the roots are pinned. */
  chainUrl: string | null;
}

export function tsaSettings(env: NodeJS.ProcessEnv = process.env): TsaSettings {
  const configured = (env.DEN_TSA_URL ?? '').trim() || 'http://localhost:3004';
  const rootsFile = env.DEN_TSA_ROOTS_FILE?.trim() || null;
  if (rootsFile) return { url: configured, rootsFile, chainUrl: null };
  const base = configured.replace(/\/+$/, '').replace(/\/api\/v1\/timestamp$/, '');
  return {
    url: `${base}/api/v1/timestamp`,
    rootsFile: null,
    chainUrl: `${base}/api/v1/timestamp/certchain`,
  };
}

/** The PEM certificates of a pinned roots file; a file without any is a configuration error. */
export function readPinnedRoots(file: string): string[] {
  const roots = certificatesInPem(readFileSync(file, 'utf8'));
  if (roots.length === 0) throw new Error(`DEN_TSA_ROOTS_FILE (${file}) holds no PEM certificate`);
  return roots;
}

/**
 * Why the TSA in use is not independent of the operator, or null when it may be: its trust
 * comes from the TSA itself, or the pinned roots are the development TSA's.
 */
export function developmentTsaReason(
  settings: TsaSettings,
  pinned: string[] | null,
): string | null {
  if (!settings.rootsFile || !pinned) {
    return 'DEN_TSA_ROOTS_FILE is not set: the stamps are trusted on a chain downloaded from the TSA itself, the development TSA (infra/tsa)';
  }
  const development = pinned.some((pem) => {
    try {
      return new X509Certificate(pem).subject === DEVELOPMENT_TSA_ROOT;
    } catch {
      return false;
    }
  });
  return development
    ? `DEN_TSA_ROOTS_FILE pins the development TSA's root (${DEVELOPMENT_TSA_ROOT})`
    : null;
}

/**
 * Client of the RFC 3161 time-stamping authority (ADR-0016, ADR-0032): the country's accredited
 * TSA in production, the sigstore timestamp-server of infra/tsa in development. Each token is
 * checked before it is stored: right bytes, right nonce, valid signature chaining to the trusted
 * roots. Settings are read on each call (tests switch the TSA off and on).
 */
@Injectable()
export class TsaClient implements OnApplicationBootstrap {
  private readonly logger = new Logger(TsaClient.name);
  private cache?: { source: string; roots: string[] };

  /**
   * In production, the development TSA breaks ADR-0016's "not even the operator" guarantee: the
   * operator would hold the signing key, the TSA's key and the database. Said loudly at start,
   * or the API refuses to start with DEN_TSA_REQUIRE_INDEPENDENT=true. A roots file that is set
   * but unreadable is always a startup error.
   */
  onApplicationBootstrap(): void {
    const settings = tsaSettings();
    const pinned = settings.rootsFile ? readPinnedRoots(settings.rootsFile) : null;
    const reason = developmentTsaReason(settings, pinned);
    if (!reason || process.env.NODE_ENV !== 'production') return;
    const message =
      `The time-stamping authority is not independent of the operator: ${reason}. ` +
      'Batches and anchors stamped by it can be rewritten and stamped again by whoever runs ' +
      'the platform. Set DEN_TSA_URL and DEN_TSA_ROOTS_FILE to the accredited TSA ' +
      '(DEPLOYMENT.md §3.7, ADR-0032).';
    if (process.env.DEN_TSA_REQUIRE_INDEPENDENT === 'true') throw new Error(message);
    this.logger.error(`!!! ${message} !!!`);
  }

  /** The PEM certificates the TSA's stamps must chain to. */
  async certificates(): Promise<string[]> {
    const settings = tsaSettings();
    const source = settings.rootsFile ?? settings.chainUrl ?? '';
    if (this.cache?.source === source) return this.cache.roots;
    let roots: string[];
    if (settings.rootsFile) {
      roots = readPinnedRoots(settings.rootsFile);
    } else {
      const res = await fetch(source, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`TSA certificate chain: HTTP ${res.status}`);
      roots = certificatesInPem(await res.text());
      if (roots.length === 0) throw new Error('TSA certificate chain: no certificates');
    }
    this.cache = { source, roots };
    return roots;
  }

  async stamp(data: Uint8Array): Promise<Stamp> {
    const nonce = randomBytes(8);
    const res = await fetch(tsaSettings().url, {
      method: 'POST',
      headers: {
        'content-type': 'application/timestamp-query',
        accept: 'application/timestamp-reply',
      },
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
