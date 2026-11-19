# ADR-0030 — The data subject has one spelling: canonical document numbers

- Status: Accepted
- Date: 2026-11-19
- Story: R-02 (`docs/BACKLOG.md`), finding M-12 of the 2026-11 general review
- Refines: ADR-0015 (decision 2, the pseudonym) and ADR-0017 (the gateway reads the subject)

## Context

ADR-0017 says the gateway and the provider must read the same person. The gateway turns the data subject of a call into a keyed pseudonym, `HMAC(key, country|type|number)` (ADR-0015), and the citizen finds their consultations with the same pseudonym, computed from the document in their token. The general review found two ways the recorded person and the person looked up could differ:

- **Spelling of the number.** OPA normalized the number before hashing it (no spaces, dots or hyphens, upper case), but nothing else: `/afiliados/0001000000001` and `/afiliados/1000000001` gave different pseudonyms. A provider that stores the number as an integer, or strips separators of its own, answers both with the same person's data, and the citizen, whose reference comes from the canonical number, never sees the first call. The normalization itself was a guess about the provider: OPA recorded `1000000001` for `/afiliados/1.000.000.001` while the provider received `1.000.000.001`.
- **Letter case of body members.** `den-data-subject` rejected a body that repeats a member name, but compared names exactly: `{"numeroIdentificacion": "A", "NumeroIdentificacion": "B"}` passed, the gateway recorded `A`, and a case-insensitive provider (.NET's default binder, Jackson with `ACCEPT_CASE_INSENSITIVE_PROPERTIES`) can read `B`.

Each document type has its own rules. A Colombian cédula is a number without leading zeros; a passport is letters and digits. Those rules belong to the country, not to the code (CLAUDE.md, rule 6).

## Decision

1. **A canonical form per document type, in the country configuration.** `identifiers.personNumberFormat` maps each person document type to an anchored regular expression its number must match exactly, as written: for example `CC: '^[1-9][0-9]{2,9}$'`. The loader checks that each type is one of `identifiers.person` and that each pattern is anchored and portable (no lookaround, backreferences, named groups, `\p` classes or inline flags), since OPA (RE2) and JavaScript evaluate it. A type without a pattern, and every type in addition to its own, keeps to the network-wide shape: 3 to 20 upper-case letters and digits.
2. **The gateway denies, it does not normalize.** The portal puts the patterns in OPA's bundle (`config.documentNumberFormats`). The policy computes the pseudonym only when the document type is exactly one of the country's codes and the number matches the shape and the type's pattern. Anything else is denied with the new reason `data_subject_invalid` (403); `data_subject_required` stays for a call that carries no subject at all. The number is never rewritten, so what OPA records is byte for byte what the provider receives.
3. **Member names compare without letter case.** `den-data-subject` treats two names in the same object that differ only in ASCII letter case as a repetition, and gives no subject (OPA denies with `data_subject_required`).
4. **The citizen side.** The citizen API still drops separators and letter case from the number in the citizen's token, as the identity provider may format it, and then requires the canonical form of its type: a token whose number would never match a gateway record is refused (401) instead of returning an empty list.
5. **The provider contract.** A provider that declares a data subject (`x-den-data-subject`) receives only canonical numbers and must look the person up by that exact value; it may be stricter, never looser than the canonical form in a way that maps two canonical values to one person.

Colombia (`co.yaml`) sets digits without leading zeros for CC, CE, TI, PEP and PPT, and upper-case letters and digits for PA. These are the reference values; the issuing registries must confirm them before production (a registry whose numbers keep significant leading zeros needs another pattern).

## Alternatives considered

- **Normalize further in the gateway (strip leading zeros, separators, case).** It keeps more calls working, but it is still a guess about each provider: a provider that treats `01000000001` as a different string would get a call recorded under another person's pseudonym. Denying makes the gateway's reading and the provider's input the same string, whatever the provider does with it.
- **Normalize and rewrite the path or body before the upstream.** It would make both sides agree, but it changes what the consumer sent and what an `X-DEN-Assertion` signs, and the gateway would have to rewrite JSON bodies. Denying is simpler and visible to the consumer.
- **Leave it to each provider's contract.** It moves the guarantee out of the network, the same objection ADR-0017 raised against consumer-declared subjects.
- **Unicode case folding of member names.** LuaJIT has no Unicode case mapping; member names in DEN APIs are ASCII identifiers in practice. Non-ASCII names that differ only in case are not detected; the limit is stated in the plugin.

## Consequences

- One person has one pseudonym: the spelling of the number can no longer hide a consultation from the citizen.
- Consumers that sent formatted numbers (`1.000.000.001`, padded with zeros, with spaces) now get `403 data_subject_invalid` and must send the canonical form. The detail of the problem says so.
- Each country must state the canonical form of its document types; until it does, a type only keeps to the shape, which still forbids separators, spaces and lower case but not leading zeros.
- The pattern is the same everywhere it is checked: the bundle (OPA), the citizen API and the config tests use the one in the country file.
