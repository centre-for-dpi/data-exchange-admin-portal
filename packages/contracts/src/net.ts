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

/** The 8 groups of an IPv6 address (with an optional dotted IPv4 tail), or undefined. */
function expandIpv6(host: string): number[] | undefined {
  let h = host.toLowerCase();
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (tail?.[1]) {
    const v4 = parseIpv4(tail[1]);
    if (!v4) return undefined;
    h = `${h.slice(0, -tail[1].length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = h.split('::');
  if (halves.length > 2) return undefined;
  const parse = (part: string) => (part ? part.split(':') : []);
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => parseInt(g, 16));
}

const v4From = (high: number, low: number): number[] => [
  high >> 8,
  high & 0xff,
  low >> 8,
  low & 0xff,
];

function isPrivateIpv6(host: string): boolean {
  const g = expandIpv6(host);
  if (!g) return true; // unparseable: never trusted
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  // Addresses that embed an IPv4 one are judged by it: IPv4-compatible ::/96, mapped
  // ::ffff:0:0/96, NAT64 64:ff9b::/96 and 6to4 2002::/16.
  if (zeros(0, 6)) return isPrivateIpv4(v4From(g[6]!, g[7]!));
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIpv4(v4From(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateIpv4(v4From(g[6]!, g[7]!));
  if (g[0] === 0x2002) return isPrivateIpv4(v4From(g[1]!, g[2]!));
  const first = g[0]!;
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xffc0) === 0xfec0 || // site-local fec0::/10 (deprecated, still routed internally)
    (first & 0xff00) === 0xff00 || // multicast
    (first === 0x2001 && g[1] === 0x0db8) // documentation
  );
}

/** True when `address` (a resolved IPv4 or IPv6 address) is publicly routable. */
export function isPublicAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return !isPrivateIpv4(v4);
  return address.includes(':') && !isPrivateIpv6(address);
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
