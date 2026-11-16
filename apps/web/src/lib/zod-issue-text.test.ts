import { describe, expect, it } from 'vitest';
import { zodIssueText } from './zod-issue-text';

/** The API's validation issues, worded again in the user's language (M6-02, WCAG 3.1.2). */
describe('zodIssueText', () => {
  it("words an issue with zod's locale", () => {
    const issue = { code: 'too_big', origin: 'string', maximum: 200, inclusive: true };
    expect(zodIssueText(issue, 'es', 'Obligatorio')).toMatch(/^Demasiado grande/);
    expect(zodIssueText(issue, 'en', 'Required')).toMatch(/^Too big/);
  });

  it('says what type it received from the type alone', () => {
    const issue = { code: 'invalid_type', expected: 'number', received: 'string' };
    expect(zodIssueText(issue, 'es', 'Obligatorio')).toContain('texto');
  });

  it('a missing value or an empty text reads as required', () => {
    expect(
      zodIssueText(
        { code: 'invalid_type', expected: 'string', received: 'undefined' },
        'es',
        'Obligatorio',
      ),
    ).toBe('Obligatorio');
    expect(
      zodIssueText(
        { code: 'too_small', origin: 'string', minimum: 1, inclusive: true },
        'en',
        'Required',
      ),
    ).toBe('Required');
  });
});
