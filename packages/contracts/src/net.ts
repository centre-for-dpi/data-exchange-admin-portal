/**
 * Upstream hosts the gateway may reach (SSRF guard). A provider's existing API must be a public
 * DNS name or a public IP: the gateway must never be turned into a proxy towards the platform's
 * own network (Keycloak, OPA, etcd, the Admin API) or a cloud metadata service.
 *
 * This checks the name as written. A public name can still resolve to a private address (DNS
 * rebinding); egress from the gateway must also be restricted at the network level
 * (ARCHITECTURE.md §4.1).
 */

const parseIpv4 = (host: string): number[] | undefined => {
  const parts = host.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
};

function isPrivateIpv4([a, b]: number[]): boolean {
  return (
    a === 0 || // "this" network
    a === 10 ||
    a === 127 || // loopback
    (a === 100 && b !== undefined && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) || // IETF protocol assignments
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a! >= 224 // multicast and reserved
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::' || h === '::1') return true;
  // IPv4-mapped (::ffff:10.0.0.1) and its hex form are judged as IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped?.[1]) {
    const v4 = parseIpv4(mapped[1]);
    return v4 ? isPrivateIpv4(v4) : true;
  }
  if (h.startsWith('::ffff:')) return true;
  return (
    /^f[cd]/.test(h) || // unique local fc00::/7
    /^fe[89ab]/.test(h) || // link-local fe80::/10
    h.startsWith('ff') // multicast
  );
}

const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.intranet', '.lan', '.home.arpa'];

/** True when `hostname` (as URL.hostname returns it) is a public DNS name or public IP. */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) return !isPrivateIpv6(host.slice(1, -1));
  if (host.includes(':')) return !isPrivateIpv6(host);
  const v4 = parseIpv4(host);
  if (v4) return !isPrivateIpv4(v4);
  // Numeric forms URL parsing may leave (e.g. 2130706433) are never accepted.
  if (/^[\d.]+$/.test(host) || /^0x/.test(host)) return false;
  // Single-label names (keycloak, opa, etcd, localhost) are container or intranet names.
  if (!host.includes('.')) return false;
  return !INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix));
}
