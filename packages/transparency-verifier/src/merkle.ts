import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Merkle tree hashes of RFC 9162 §2.1 (Certificate Transparency v2), with SHA-256:
 *   leaf = SHA-256(0x00 ‖ data)      node = SHA-256(0x01 ‖ left ‖ right)
 * The tree of n leaves splits at k, the largest power of two smaller than n.
 */

const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

export const leafHash = (data: string | Uint8Array): Uint8Array =>
  sha256(concatBytes(LEAF_PREFIX, typeof data === 'string' ? utf8ToBytes(data) : data));

export const nodeHash = (left: Uint8Array, right: Uint8Array): Uint8Array =>
  sha256(concatBytes(NODE_PREFIX, left, right));

/** Largest power of two strictly smaller than n (n > 1). */
const splitPoint = (n: number): number => {
  let k = 1;
  while (k << 1 < n) k <<= 1;
  return k;
};

/** MTH(D[n]) over leaf hashes. The empty tree hashes to SHA-256 of nothing. */
export function treeRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return sha256(new Uint8Array(0));
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = splitPoint(leaves.length);
  return nodeHash(treeRoot(leaves.slice(0, k)), treeRoot(leaves.slice(k)));
}

/** PATH(m, D[n]) of RFC 9162 §2.1.3.1: the audit path of leaf m, bottom to top. */
export function inclusionProof(leaves: readonly Uint8Array[], index: number): Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new RangeError('Leaf index out of range');
  }
  if (leaves.length === 1) return [];
  const k = splitPoint(leaves.length);
  return index < k
    ? [...inclusionProof(leaves.slice(0, k), index), treeRoot(leaves.slice(k))]
    : [...inclusionProof(leaves.slice(k), index - k), treeRoot(leaves.slice(0, k))];
}

/** Verification of an inclusion proof, RFC 9162 §2.1.3.2. */
export function verifyInclusion(
  leaf: Uint8Array,
  index: number,
  treeSize: number,
  proof: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isInteger(index) || !Number.isInteger(treeSize) || index < 0 || index >= treeSize) {
    return false;
  }
  let fn = index;
  let sn = treeSize - 1;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = nodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equalBytes(r, root);
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

export const toHex = bytesToHex;

/** Strict lowercase hex of a SHA-256 value. */
export function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new TypeError('Expected 32 bytes of lowercase hex');
  return hexToBytes(hex);
}
