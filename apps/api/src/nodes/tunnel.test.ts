import { describe, expect, it } from 'vitest';
import { hubAddress, inSubnet, nextNodeAddress, parseSubnet, subnetCidr } from './tunnel.js';

describe('tunnel addresses (M4-02)', () => {
  const subnet = parseSubnet('10.77.0.0/16');

  it('puts the hub on the first host and nodes after it', () => {
    expect(hubAddress(subnet)).toBe('10.77.0.1');
    expect(nextNodeAddress(subnet, [])).toBe('10.77.0.2');
    expect(nextNodeAddress(subnet, ['10.77.0.2', '10.77.0.3'])).toBe('10.77.0.4');
  });

  it('never reuses an address, even one freed in the middle', () => {
    expect(nextNodeAddress(subnet, ['10.77.0.2', '10.77.0.9'])).toBe('10.77.0.10');
    expect(nextNodeAddress(subnet, ['10.77.0.255'])).toBe('10.77.1.0');
  });

  it('ignores addresses outside the subnet and normalizes the network', () => {
    expect(nextNodeAddress(subnet, ['192.168.1.200'])).toBe('10.77.0.2');
    expect(subnetCidr(parseSubnet('10.77.3.4/16'))).toBe('10.77.0.0/16');
    expect(inSubnet(subnet, '10.78.0.1')).toBe(false);
  });

  it('fails when the subnet is full, before the broadcast address', () => {
    const tiny = parseSubnet('10.0.0.0/29');
    expect(nextNodeAddress(tiny, ['10.0.0.5'])).toBe('10.0.0.6');
    expect(() => nextNodeAddress(tiny, ['10.0.0.6'])).toThrow(/no free addresses/);
  });

  it('rejects subnets that are not IPv4 CIDRs of a sensible size', () => {
    expect(() => parseSubnet('fd00::/64')).toThrow();
    expect(() => parseSubnet('10.0.0.0/31')).toThrow();
    expect(() => parseSubnet('10.0.0.0')).toThrow();
  });
});
