import { isIPv4 } from 'node:net';

/**
 * Addresses of the WireGuard network between the hub and the kit nodes (M4-02, M4-03). IPv4
 * only: one subnet (DEN_WG_SUBNET, 10.77.0.0/16 by default), the hub on its first host address
 * and each node on a /32 of its own, never reused.
 */
export interface TunnelSubnet {
  /** Network address as a 32-bit unsigned integer. */
  network: number;
  prefix: number;
}

const toInt = (ip: string): number =>
  ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);

const toIp = (value: number): string =>
  [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join('.');

export function parseSubnet(cidr: string): TunnelSubnet {
  const [ip = '', bits = ''] = cidr.split('/');
  const prefix = Number(bits);
  if (!isIPv4(ip) || !Number.isInteger(prefix) || prefix < 8 || prefix > 29) {
    throw new Error(`DEN_WG_SUBNET must be an IPv4 CIDR between /8 and /29, got "${cidr}"`);
  }
  const size = 2 ** (32 - prefix);
  const network = toInt(ip) - (toInt(ip) % size);
  return { network, prefix };
}

export const subnetSize = (subnet: TunnelSubnet): number => 2 ** (32 - subnet.prefix);

/** The hub: the first host address of the subnet. */
export const hubAddress = (subnet: TunnelSubnet): string => toIp(subnet.network + 1);

export const subnetCidr = (subnet: TunnelSubnet): string =>
  `${toIp(subnet.network)}/${subnet.prefix}`;

export function inSubnet(subnet: TunnelSubnet, ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const value = toInt(ip);
  return value >= subnet.network && value < subnet.network + subnetSize(subnet);
}

/**
 * The next node address: one past the highest address ever given (addresses are not reused, so a
 * decommissioned node's address never reaches another node), skipping the hub and the broadcast.
 */
export function nextNodeAddress(subnet: TunnelSubnet, used: readonly string[]): string {
  const taken = used.filter((ip) => inSubnet(subnet, ip)).map(toInt);
  const first = subnet.network + 2;
  const next = taken.length ? Math.max(first - 1, ...taken) + 1 : first;
  const broadcast = subnet.network + subnetSize(subnet) - 1;
  if (next >= broadcast) throw new Error('The tunnel subnet has no free addresses');
  return toIp(next);
}

export function tunnelSubnet(env: NodeJS.ProcessEnv = process.env): TunnelSubnet {
  return parseSubnet(env.DEN_WG_SUBNET ?? '10.77.0.0/16');
}
