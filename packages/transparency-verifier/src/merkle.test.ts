import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { inclusionProof, leafHash, toHex, treeRoot, verifyInclusion } from './merkle.js';

const hexBytes = (hex: string) => Uint8Array.from(Buffer.from(hex, 'hex'));

// Test vectors of Certificate Transparency (RFC 6962 / RFC 9162 trees): the leaves of the
// reference implementations' tests and the roots of their first 1…8 leaves.
const CT_LEAVES = [
  '',
  '00',
  '10',
  '2021',
  '3031',
  '40414243',
  '5051525354555657',
  '606162636465666768696a6b6c6d6e6f',
].map(hexBytes);
const CT_ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

/** The definition of RFC 9162 §2.1.1, recursively over the data, as a second implementation. */
function referenceRoot(data: readonly Uint8Array[]): Uint8Array {
  if (data.length === 0) return sha256(new Uint8Array(0));
  if (data.length === 1) return sha256(concatBytes(Uint8Array.of(0), data[0] as Uint8Array));
  let k = 1;
  while (k * 2 < data.length) k *= 2;
  return sha256(
    concatBytes(Uint8Array.of(1), referenceRoot(data.slice(0, k)), referenceRoot(data.slice(k))),
  );
}

describe('Merkle tree (RFC 9162)', () => {
  it('matches the Certificate Transparency test vectors', () => {
    for (let n = 1; n <= CT_LEAVES.length; n++) {
      expect(toHex(treeRoot(CT_LEAVES.slice(0, n).map(leafHash)))).toBe(CT_ROOTS[n - 1]);
    }
    expect(toHex(treeRoot([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('proves every leaf of every tree size, and nothing else', () => {
    for (let n = 1; n <= 40; n++) {
      const data = Array.from({ length: n }, (_, i) => new TextEncoder().encode(`leaf-${i}`));
      const leaves = data.map(leafHash);
      const root = treeRoot(leaves);
      expect(root).toEqual(referenceRoot(data));
      for (let m = 0; m < n; m++) {
        const proof = inclusionProof(leaves, m);
        expect(verifyInclusion(leaves[m] as Uint8Array, m, n, proof, root)).toBe(true);
        // Another position, another size, another leaf or a cut proof: rejected.
        if (n > 1) {
          expect(verifyInclusion(leaves[m] as Uint8Array, (m + 1) % n, n, proof, root)).toBe(false);
          expect(verifyInclusion(leaves[(m + 1) % n] as Uint8Array, m, n, proof, root)).toBe(false);
          expect(verifyInclusion(leaves[m] as Uint8Array, m, n, proof.slice(1), root)).toBe(false);
        }
        // Against the root of another tree (one leaf more): rejected. The size alone may give a
        // path of the same shape; it is signed with the root in the checkpoint.
        const bigger = treeRoot([...leaves, leafHash('extra')]);
        expect(verifyInclusion(leaves[m] as Uint8Array, m, n + 1, proof, bigger)).toBe(false);
      }
    }
  });

  it('rejects out-of-range positions', () => {
    const leaves = [leafHash('a'), leafHash('b')];
    expect(() => inclusionProof(leaves, 2)).toThrow(RangeError);
    expect(verifyInclusion(leafHash('a'), -1, 2, [], treeRoot(leaves))).toBe(false);
    expect(verifyInclusion(leafHash('a'), 2, 2, [], treeRoot(leaves))).toBe(false);
  });
});

describe('canonical JSON (RFC 8785)', () => {
  it('sorts keys at every level and has one encoding per value', () => {
    expect(canonicalJson({ b: 1, a: [{ d: true, c: null }], é: 'x', Z: 2.5 })).toBe(
      '{"Z":2.5,"a":[{"c":null,"d":true}],"b":1,"é":"x"}',
    );
    expect(canonicalJson({ a: undefined, b: 1e21, c: -0 })).toBe('{"b":1e+21,"c":0}');
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ a: 1n })).toThrow(TypeError);
  });
});
