import { describe, expect, it } from 'vitest';
import { problemToFormState } from './forms';

describe('problemToFormState', () => {
  it('groups API field errors by top-level field', () => {
    expect(
      problemToFormState(
        {
          errors: [
            { path: 'slug', message: 'bad slug' },
            { path: 'upstream.url', message: 'must be https' },
            { path: 'openapi:12', message: 'missing operationId' },
          ],
        },
        'fallback',
      ),
    ).toEqual({
      fieldErrors: {
        slug: ['bad slug'],
        upstream: ['must be https'],
        openapi: ['missing operationId'],
      },
    });
  });

  it('uses the problem detail, or the fallback, when no field is involved', () => {
    expect(problemToFormState({ detail: 'Already exists' }, 'fallback')).toEqual({
      fieldErrors: {},
      formError: 'Already exists',
    });
    expect(problemToFormState(undefined, 'fallback').formError).toBe('fallback');
  });

  it('treats body-level errors (empty path) as form errors', () => {
    expect(
      problemToFormState({ errors: [{ path: '', message: 'Unrecognized key' }] }, 'x'),
    ).toEqual({
      fieldErrors: {},
      formError: 'Unrecognized key',
    });
  });

  it('words every text in the language of the user when given a translation (M6-02)', () => {
    const state = problemToFormState(
      {
        code: 'conflict',
        detail: 'The request changed meanwhile; reload it',
        errors: [
          {
            path: 'validityMonths',
            message: 'at most 6 months',
            key: 'max_validity_months',
            params: { max: 6 },
          },
        ],
      },
      'fallback',
      {
        translation: {
          field: (e) => `campo ${e.key ?? ''} ${JSON.stringify(e.params?.max)}`,
          code: (code) => `código ${code}`,
        },
      },
    );
    expect(state.fieldErrors).toEqual({ validityMonths: ['campo max_validity_months 6'] });
    const general = problemToFormState(
      { code: 'conflict', detail: 'The request changed meanwhile; reload it' },
      'fallback',
      { translation: { field: (e) => e.message, code: (code) => `código ${code}` } },
    );
    // The API's English detail is not shown: the code's text is.
    expect(general.formError).toBe('código conflict');
  });
});
