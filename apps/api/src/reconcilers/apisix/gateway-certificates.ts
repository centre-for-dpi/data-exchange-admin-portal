import { webcrypto, X509Certificate } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { AuditService } from '../../audit/audit.service.js';
import { open, seal } from '../../common/secrets.js';
import { uuidv7 } from '../../common/uuidv7.js';
import { leafOf, thumbprintOf } from '../../credentials/credential-view.js';
import {
  CERTIFICATE_AUTHORITY,
  type CertificateAuthority,
} from '../../credentials/step-ca.client.js';
import type {
  GatewayCertificate,
  GatewayCertificatePurpose,
} from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** The gateway's own certificates live 90 days. */
const VALIDITY_HOURS = 90 * 24;
const SYSTEM = { type: 'system' as const, id: 'system:apisix-reconciler' };
const PEM_CERT = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export interface IssuedGatewayCertificate {
  id: string;
  hosts: string[];
  /** Certificate followed by its issuing chain, PEM (what APISIX serves). */
  certificatePem: string;
  keyPem: string;
  /**
   * The network CA: the intermediate(s) and the root, PEM. It issues the client certificates the
   * gateway accepts (client.ca) and the certificates of kit nodes it calls (upstream ca_certs).
   */
  networkCaPem: string;
  fingerprint: string;
  notAfter: Date;
}

const pem = (label: string, der: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(der)
    .toString('base64')
    .replace(/.{1,64}/g, '$&\n')}-----END ${label}-----\n`;

/** A fresh P-256 key and its CSR for the host names (CN = the first one). */
async function keyAndCsr(hosts: string[]) {
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const csr = new pkijs.CertificationRequest();
  csr.subject.typesAndValues.push(
    new pkijs.AttributeTypeAndValue({
      type: '2.5.4.3',
      value: new asn1js.Utf8String({ value: hosts[0] ?? '' }),
    }),
  );
  await csr.subjectPublicKeyInfo.importKey(pair.publicKey);
  const altNames = new pkijs.GeneralNames({
    names: hosts.map((value) => new pkijs.GeneralName({ type: 2, value })),
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
  await csr.sign(pair.privateKey, 'SHA-256');
  return {
    csrPem: pem('CERTIFICATE REQUEST', csr.toSchema().toBER(false)),
    keyPem: pem('PRIVATE KEY', await webcrypto.subtle.exportKey('pkcs8', pair.privateKey)),
    publicKey: Buffer.from(await webcrypto.subtle.exportKey('spki', pair.publicKey)),
  };
}

const sameHosts = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((host, i) => host === b[i]);

/** Renewed in the last third of its life, so a failing CA leaves a month to fix it. */
export function renewalDue(c: { notBefore: Date; notAfter: Date }, now: Date): boolean {
  const life = c.notAfter.getTime() - c.notBefore.getTime();
  return c.notAfter.getTime() - now.getTime() < life / 3;
}

/**
 * Certificates of the gateway itself, issued by the network CA (ARCHITECTURE.md §4.4, M3-02).
 * The portal generates the key, has step-ca sign the CSR through the rid-gateway-tls provisioner
 * and keeps both (the key sealed with RID_SECRETS_KEY); the APISIX reconciler puts them in the
 * SSL object. Called only by the reconciler.
 */
@Injectable()
export class GatewayCertificates {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(CERTIFICATE_AUTHORITY) private readonly ca: CertificateAuthority,
  ) {}

  private async view(row: GatewayCertificate): Promise<IssuedGatewayCertificate> {
    const issuers = (row.certificatePem.match(PEM_CERT) ?? []).slice(1);
    const root = await this.ca.rootCertificate();
    return {
      id: row.id,
      hosts: row.hosts,
      certificatePem: row.certificatePem,
      keyPem: open(row.sealedKey, row.id),
      networkCaPem: [...issuers, root.trim()].map((c) => `${c.trim()}\n`).join(''),
      fingerprint: row.fingerprint,
      notAfter: row.notAfter,
    };
  }

  /**
   * The server certificate for these host names: the current one, or a new one when there is
   * none, it names other hosts or it is due for renewal.
   */
  server(hosts: readonly string[], now = new Date()): Promise<IssuedGatewayCertificate> {
    return this.ensure('server', hosts, now);
  }

  /**
   * A client certificate the gateway presents to upstreams that require mTLS (M3-03): subject
   * CN=<name>, one per provider entity (rid-gateway.<slug>), issued like the applications' (TLS
   * client authentication only, provisioner rid-portal). Each provider trusts the network CA and
   * its own name only.
   */
  upstreamClient(name: string, now = new Date()): Promise<IssuedGatewayCertificate> {
    return this.ensure('upstream_client', [name], now);
  }

  private async ensure(
    purpose: GatewayCertificatePurpose,
    hosts: readonly string[],
    now: Date,
  ): Promise<IssuedGatewayCertificate> {
    const current = await this.prisma.gatewayCertificate.findFirst({
      where: { purpose, hosts: { equals: [...hosts] }, notAfter: { gt: now } },
      orderBy: { createdAt: 'desc' },
    });
    if (current && sameHosts(current.hosts, hosts) && !renewalDue(current, now)) {
      return this.view(current);
    }
    return this.view(await this.issue(purpose, [...hosts]));
  }

  private async issue(
    purpose: GatewayCertificatePurpose,
    hosts: string[],
  ): Promise<GatewayCertificate> {
    if (hosts.length === 0) throw new Error('The gateway certificate has no name');
    const { csrPem, keyPem, publicKey } = await keyAndCsr(hosts);
    const chainPem = await this.ca.sign({
      csrPem,
      commonName: hosts[0] ?? '',
      sans: hosts,
      publicKey,
      profile: purpose === 'server' ? 'gateway-server' : 'application',
      validityHours: VALIDITY_HOURS,
    });
    const leaf: X509Certificate = leafOf(chainPem);
    const id = uuidv7();
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.gatewayCertificate.create({
        data: {
          id,
          purpose,
          hosts,
          certificatePem: chainPem,
          sealedKey: seal(keyPem, id),
          fingerprint: thumbprintOf(leaf),
          notBefore: leaf.validFromDate,
          notAfter: leaf.validToDate,
        },
      });
      await this.audit.record(tx, {
        actor: SYSTEM,
        action: 'gateway_certificate.issued',
        target: { type: 'gateway_certificate', id },
        // Public facts only; the key never enters the trail.
        after: {
          purpose,
          hosts,
          fingerprint: row.fingerprint,
          serial: leaf.serialNumber.toLowerCase(),
          notAfter: row.notAfter.toISOString(),
        },
      });
      return row;
    });
  }
}
