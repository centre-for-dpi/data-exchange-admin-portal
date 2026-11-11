import { describe, expect, it } from 'vitest';
import { ERROR_HTTP_STATUS, ErrorCode, problemDetailsSchema, problemType } from './errors.js';

describe('errors', () => {
  it('builds the problem type URL from the code', () => {
    expect(problemType(ErrorCode.InvalidTransition)).toBe(
      'https://rid.example/errors/invalid_transition',
    );
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(ERROR_HTTP_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it('validates a problem details payload', () => {
    const parsed = problemDetailsSchema.safeParse({
      type: problemType(ErrorCode.NotFound),
      title: 'Not Found',
      status: 404,
      code: ErrorCode.NotFound,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown error code', () => {
    const parsed = problemDetailsSchema.safeParse({
      type: problemType(ErrorCode.NotFound),
      title: 'Not Found',
      status: 404,
      code: 'made_up',
    });
    expect(parsed.success).toBe(false);
  });
});
