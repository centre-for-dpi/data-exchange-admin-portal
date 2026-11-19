import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/** Fastify's `trustProxy` as a function: whether the address at that hop may set X-Forwarded-For. */
export type TrustFunction = (address: string, hop: number) => boolean;
/** Resolves a host name to its addresses (DNS of the Compose network). */
export type Resolve = (name: string) => Promise<string[]>;

const resolveAll: Resolve = async (name) =>
  (await lookup(name, { all: true })).map((entry) => entry.address);

/** How often host names are resolved again: a container recreated by Compose changes address. */
export const REFRESH_MS = 30_000;
/** At most this often, an unknown direct peer triggers an early refresh. */
const EARLY_REFRESH_MS = 5_000;

const plain = (address: string): string => address.replace(/^::ffff:/i, '');
const family = (address: string): 'ipv4' | 'ipv6' => (isIP(address) === 6 ? 'ipv6' : 'ipv4');

/** An address (`172.20.0.2`) or a network (`172.20.0.0/16`), as opposed to a host name. */
function addressOrNetwork(entry: string): { address: string; prefix?: number } | undefined {
  const [address = '', prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !isIP(address)) return undefined;
  if (prefix === undefined) return { address };
  const bits = Number(prefix);
  const max = isIP(address) === 6 ? 128 : 32;
  return /^\d+$/.test(prefix) && bits <= max ? { address, prefix: bits } : undefined;
}

const HOST_NAME = /^[a-z0-9](?:[a-z0-9_.-]*[a-z0-9])?$/i;

/**
 * Who may set X-Forwarded-For (DEN_TRUST_PROXY, M6-01, M-27): request.ip is then the caller's
 * address, for rate limits, security events and the audit log. Comma-separated:
 *   - addresses or networks of the proxy (`172.30.0.2`, `172.30.0.0/16`), so that another container
 *     that reaches the API directly cannot pick the address it is logged and limited under;
 *   - host names, resolved on the Compose network and again every 30 s: the bundled proxy and the
 *     web, which forwards the visitor's address (`edge,web`), whatever address Docker gives them.
 * A number trusts that many hops whoever sends them: only where nothing but the proxy reaches the
 * API. Empty: nobody.
 */
export function trustedProxies(
  value: string | undefined,
  resolve: Resolve = resolveAll,
): string | TrustFunction | false {
  const setting = value?.trim() ?? '';
  if (!setting || setting === '0') return false;
  if (/^\d+$/.test(setting)) {
    const hops = Number(setting);
    return (_address: string, hop: number) => hop < hops;
  }
  const entries = setting
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const names = entries.filter((entry) => !addressOrNetwork(entry));
  // Addresses and networks only: Fastify's own matching, as before.
  if (names.length === 0) return setting;
  for (const name of names) {
    if (!HOST_NAME.test(name)) {
      throw new Error(`DEN_TRUST_PROXY: "${name}" is not an address, a network or a host name`);
    }
  }
  const fixed = new BlockList();
  for (const entry of entries) {
    const parsed = addressOrNetwork(entry);
    if (!parsed) continue;
    if (parsed.prefix === undefined) fixed.addAddress(parsed.address, family(parsed.address));
    else fixed.addSubnet(parsed.address, parsed.prefix, family(parsed.address));
  }

  let resolved = new Set<string>();
  let last = 0;
  let pending: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    last = Date.now();
    pending ??= Promise.all(names.map((name) => resolve(name).catch(() => [] as string[])))
      .then((lists) => {
        resolved = new Set(lists.flat().map(plain));
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  void refresh();
  setInterval(() => void refresh(), REFRESH_MS).unref();

  const trust: TrustFunction = (address, hop) => {
    const ip = plain(address);
    if (!isIP(ip)) return false;
    if (fixed.check(ip, family(ip)) || resolved.has(ip)) return true;
    // A direct peer we do not know: the proxy or the web may have just been recreated.
    if (hop === 0 && Date.now() - last > EARLY_REFRESH_MS) void refresh();
    return false;
  };
  return Object.assign(trust, { refresh });
}
