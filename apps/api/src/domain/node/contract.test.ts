import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compareContract, openapiHashVariants, serviceFor } from './contract.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const file = 'openapi: 3.1.0\ninfo:\n  title: Afiliación\n  version: "1.0"\npaths: {}\n';
/** What the portal receives when the same file is pasted in the form: trimmed, CRLF. */
const pasted = file.trim().replace(/\n/g, '\r\n');

describe('openapiHashVariants (P-02)', () => {
  it('accepts the node’s file when the form trimmed it and changed its line endings', () => {
    expect(sha(pasted)).not.toBe(sha(file));
    expect(openapiHashVariants(pasted)).toContain(sha(file));
  });

  it('accepts a file with a BOM that the upload dropped, and CRLF files', () => {
    expect(openapiHashVariants(file)).toContain(sha(`\uFEFF${file}`));
    expect(openapiHashVariants(file)).toContain(sha(file.replace(/\n/g, '\r\n')));
    expect(openapiHashVariants(file)).toContain(sha(file.trimEnd()));
  });

  it('leaves out the exact hash (stored apart) and any other document', () => {
    expect(openapiHashVariants(file)).not.toContain(sha(file));
    expect(openapiHashVariants(file)).not.toContain(sha(file.replace('Afiliación', 'Otra')));
    expect(openapiHashVariants(file)).toHaveLength(7);
  });
});

describe('serviceFor (P-02)', () => {
  const services = [
    { name: 'raiz', path: '/' },
    { name: 'salud', path: '/salud' },
    { name: 'salud-v2', path: '/salud/v2/' },
    { name: 'certificados', path: '/certificados' },
  ];

  it('takes the service on that very path', () => {
    expect(serviceFor(services, '/salud')?.name).toBe('salud');
    expect(serviceFor(services, '/salud/')?.name).toBe('salud');
    expect(serviceFor(services, '/certificados')?.name).toBe('certificados');
  });

  it('else the longest prefix on a segment boundary', () => {
    expect(serviceFor(services, '/salud/v1')?.name).toBe('salud');
    expect(serviceFor(services, '/salud/v2/afiliados')?.name).toBe('salud-v2');
    expect(serviceFor(services, '/saludable')?.name).toBe('raiz');
    expect(serviceFor(services.slice(1), '/saludable')).toBeUndefined();
  });
});

describe('compareContract (P-02)', () => {
  const version = {
    openapiSha256: sha(pasted),
    openapiSha256Variants: openapiHashVariants(pasted),
  };
  const on = (openapiSha256?: string) => [
    { name: 'afiliacion', path: '/salud', ...(openapiSha256 ? { openapiSha256 } : {}) },
  ];

  it('matches the published hash or one of its variants', () => {
    expect(compareContract(version, on(sha(pasted)), '/salud')).toEqual({
      status: 'matches',
      serviceName: 'afiliacion',
      reportedSha256: sha(pasted),
    });
    expect(compareContract(version, on(sha(file)), '/salud').status).toBe('matches');
  });

  it('differs when the service reports another document', () => {
    const other = sha('openapi: 3.1.0\n');
    expect(compareContract(version, on(other), '/salud')).toEqual({
      status: 'differs',
      serviceName: 'afiliacion',
      reportedSha256: other,
    });
  });

  it('is not reported when the service has no OpenAPI, or the node has no service there', () => {
    expect(compareContract(version, on(), '/salud')).toEqual({
      status: 'not_reported',
      serviceName: 'afiliacion',
      reportedSha256: null,
    });
    expect(compareContract(version, on(sha(file)), '/certificados')).toEqual({
      status: 'not_reported',
      serviceName: null,
      reportedSha256: null,
    });
    expect(compareContract(version, [], '/salud').status).toBe('not_reported');
  });

  it('compares per service path', () => {
    const services = [
      { name: 'afiliacion', path: '/salud', openapiSha256: sha(file) },
      { name: 'certificados', path: '/certificados', openapiSha256: sha('otro') },
    ];
    expect(compareContract(version, services, '/salud').status).toBe('matches');
    expect(compareContract(version, services, '/certificados').status).toBe('differs');
  });
});
