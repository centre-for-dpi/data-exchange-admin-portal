import { describe, expect, it } from 'vitest';
import { normalizeDocumentNumber, subjectRef } from './subject-ref.js';

describe('subject reference', () => {
  it('matches the vector shared with the OPA policy tests', () => {
    // packages/policy/den/authz_test.rego, test_the_reference_matches_the_portal_vector
    expect(
      subjectRef({
        key: 'subject-key-for-tests-0000000000000001',
        country: 'CO',
        documentType: 'CC',
        documentNumber: normalizeDocumentNumber(' 1.000.000-001 '),
      }),
    ).toBe('0d0deea2958985c2da0174f52dfb3bd1a9a88d0115ce41a4a3d1166e889b9062');
  });

  it("drops the identity provider's separators and letter case", () => {
    expect(normalizeDocumentNumber('ab 12.34-5')).toBe('AB12345');
  });
});
