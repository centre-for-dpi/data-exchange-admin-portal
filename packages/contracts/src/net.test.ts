import { describe, expect, it } from 'vitest';
import { upstreamSchema } from './apis.js';
import { isPublicHostname } from './net.js';

const hostOf = (url: string) => new URL(url).hostname;

describe('isPublicHostname (SSRF guard for direct upstreams)', () => {
  it('accepts public DNS names and public IPs', () => {
    for (const url of [
      'https://api.salud.example',
      'https://servicios.entidad.gov.co:8443',
      'https://8.8.8.8',
      'https://[2001:4860:4860::8888]',
    ]) {
      expect(isPublicHostname(hostOf(url)), url).toBe(true);
    }
  });

  it('rejects platform services, private, loopback, link-local and metadata addresses', () => {
    for (const url of [
      'https://keycloak:8443',
      'https://opa',
      'https://localhost',
      'https://api.localhost',
      'https://apisix.internal',
      'https://printer.local',
      'https://127.0.0.1',
      'https://10.1.2.3',
      'https://172.20.0.5',
      'https://192.168.1.10',
      'https://169.254.169.254',
      'https://100.64.0.1',
      'https://0.0.0.0',
      'https://[::1]',
      'https://[fd00::1]',
      'https://[fe80::1]',
      'https://[::ffff:10.0.0.1]',
      // Alternative IPv4 spellings that URL parsing normalizes to loopback.
      'https://2130706433',
      'https://0x7f000001',
      'https://127.1',
    ]) {
      expect(isPublicHostname(hostOf(url)), url).toBe(false);
    }
  });

  it('is enforced when a version declares a direct upstream', () => {
    const parse = (url: string) => upstreamSchema.safeParse({ type: 'direct', url, mtls: false });
    expect(parse('https://api.salud.example/v1').success).toBe(true);
    const internal = parse('https://keycloak:8080/admin');
    expect(internal.success).toBe(false);
    expect(internal.error?.issues[0]?.message).toMatch(/public host/);
  });
});
