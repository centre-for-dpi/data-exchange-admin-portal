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
});
