# ADR-0038 — Transparency register: leaf format 2 and a checkpoint without a range

- Status: Accepted (clarifies ADR-0016; does not replace it)
- Date: 2026-11-19
- Story: R-11 (`docs/BACKLOG.md`), documentation row "ADR-0016 §1–2" of the 2026-11 general review (§5)

## Context

ADR-0016 (accepted, in Spanish, and not edited since) says that a leaf is `SHA-256(0x00 ‖ canonical JSON of the record)` and that a checkpoint contains `{from, to, root, hash of the previous checkpoint, date}`. The code does something else, and has since commit `7871c93` (MT-04, a review of the register): the leaf commits to the record's identifier and time, and the checkpoint has no range. The reference documents (ARCHITECTURE §7) describe the code, but no ADR said so, and a reader of ADR-0016 alone builds a verifier that rejects every real batch.

## Decision

The decisions of ADR-0016 stand: a Merkle tree per batch with the RFC 9162 rules, a checkpoint signed by the operator (JWS, EdDSA, `kid` in a JWKS) and stamped by an independent RFC 3161 TSA, anchored in the audit trail (`transparency.checkpoint`), and an open verifier. What this ADR fixes is the shape of the two objects, which `packages/transparency-verifier` implements:

1. **Leaf, format 2.** `SHA-256(0x00 ‖ RFC 8785 canonical JSON of {v, id, occurredAt, digest})`, where `digest` is the lowercase hex SHA-256 of the canonical JSON of the whole record (`AccessRecord`). The identifier and the time are in the leaf, not only in the record, because retention purges records: after a purge the leaf row keeps `id`, `occurredAt` and `digest`, and since the leaf is bound to the signed root, an early deletion cannot be passed off as a purge by moving the time of an unsigned row. Format 1 (the leaf over the record's canonical JSON, as ADR-0016 wrote it) is what the first batches used; they still verify, selected by the checkpoint's `v`.
2. **Checkpoint without a range.** `{v, log, seq, treeSize, root, prev, sealedAt}`: `v` is the leaf format (1 or 2), `log` identifies the register, `seq` counts 1, 2, 3 without gaps, `treeSize` is the number of leaves, `prev` is the SHA-256 of the previous checkpoint's canonical JSON (null for the first) and `sealedAt` is the sealing time. There is no `from` or `to`: which records a batch holds is given by the leaves, stored in order against their checkpoint, and the chain by `seq` and `prev`. A range would repeat what the leaves say and could disagree with them. The operator signs the canonical form as a compact JWS (`typ: den-checkpoint+jws`) and the TSA stamps the bytes of that JWS.
3. **Cross-check with the audit trail.** Each checkpoint has its anchor event in the audit chain. `GET /transparency/verify` reports an anchor without a checkpoint (`checkpoint_missing`, batches deleted, even at the end of the chain) and a checkpoint without an anchor (`anchor_missing`, one inserted outside the sealer).

## Alternatives considered

- **Edit ADR-0016.** Not allowed for an accepted ADR; this one clarifies it and ARCHITECTURE §7 links both.
- **Put a range back in the checkpoint.** Redundant with the stored leaves and `treeSize`; one more thing that could disagree.
- **Keep leaves over the whole record.** Then retention would leave the time of a purged record unsigned, which is the gap that format 2 closes.

## Consequences

- A verifier implemented from ADR-0016 alone must also support this ADR; the reference is the code in `packages/transparency-verifier` and ARCHITECTURE §7.
- Format 2 is the only one sealed today; the code keeps reading format 1 for the batches already sealed.
