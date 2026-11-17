import {
  entitySlugSchema,
  RESERVED_ENTITY_SLUGS,
  ValidationMessage,
  ZOD_ISSUE_KEY,
} from '@den/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ValidationError } from './errors.js';
import { issueToFieldError, ZodValidationPipe } from './zod-validation.pipe.js';

/** Field errors the portal can word in the user's language (M6-02, WCAG 3.1.2). */
describe('ZodValidationPipe field errors', () => {
  const errorsOf = (schema: z.ZodType, value: unknown) => {
    try {
      new ZodValidationPipe(schema).transform(value);
    } catch (error) {
      if (error instanceof ValidationError) return error.errors ?? [];
    }
    throw new Error('expected a validation error');
  };

  it("keeps a contract message's own key", () => {
    const [error] = errorsOf(
      z.object({ s: z.string().regex(/^x$/, ValidationMessage.reserved_slug) }),
      {
        s: 'y',
      },
    );
    expect(error).toEqual({ path: 's', message: 'reserved name', key: 'reserved_slug' });
  });

  it('sends what zod needs to word an issue again, never the input', () => {
    const [error] = errorsOf(z.object({ n: z.string().max(3) }), { n: 'secret-123' });
    expect(error).toMatchObject({
      path: 'n',
      key: ZOD_ISSUE_KEY,
      params: { code: 'too_big', origin: 'string', maximum: 3 },
    });
    expect(JSON.stringify(error)).not.toContain('secret-123');
  });

  it('names the type it received for a wrong type, not the value', () => {
    const issue = z.object({ n: z.number() }).safeParse({ n: '1000000001' }).error?.issues[0];
    if (!issue) throw new Error('expected an issue');
    const error = issueToFieldError({ ...issue, input: '1000000001' } as typeof issue);
    expect(error.params).toMatchObject({
      code: 'invalid_type',
      expected: 'number',
      received: 'string',
    });
    expect(JSON.stringify(error)).not.toContain('1000000001');
  });

  it('every contract message used in a schema maps back to its key', () => {
    const errors = errorsOf(z.object({ slug: entitySlugSchema }), {
      slug: RESERVED_ENTITY_SLUGS[0],
    });
    const slug = errors.find((e) => e.path === 'slug');
    expect(slug?.key).toBe('reserved_slug');
  });
});
