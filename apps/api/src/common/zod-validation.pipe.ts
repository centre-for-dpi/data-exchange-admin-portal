import type { PipeTransform } from '@nestjs/common';
import { validationMessageKey, ZOD_ISSUE_KEY } from '@rid/contracts';
import type { z } from 'zod';
import { type FieldError, ValidationError } from './errors.js';

/**
 * A zod issue as a field error the portal can show in the user's language (M6-02, WCAG 3.1.2):
 * a message of the contracts keeps its own key; any other issue goes with what zod needs to word
 * it again in another locale (code, expected type, limits...). Never the input, which the issue
 * may carry: it is what the caller typed.
 */
export function issueToFieldError(issue: z.core.$ZodIssue): FieldError {
  const path = issue.path.map(String).join('.');
  const key = validationMessageKey(issue.message);
  if (key) return { path, message: issue.message, key };
  const { input, path: _path, message: _message, ...rest } = issue;
  const params: Record<string, unknown> = { ...rest };
  // What zod words as "received <type>": the type only, from the input it did not keep.
  if (issue.code === 'invalid_type') params.received = input === null ? 'null' : typeof input;
  return {
    path,
    message: issue.message,
    key: ZOD_ISSUE_KEY,
    // Plain JSON only (zod may keep a RegExp or a bigint in an issue).
    params: JSON.parse(JSON.stringify(params)) as Record<string, unknown>,
  };
}

/**
 * Validates and parses a request part with a zod schema from packages/contracts (CLAUDE.md,
 * rule 9). Use it per parameter: `@Body(new ZodValidationPipe(createApiSchema)) body`.
 * Unknown fields are handled by the schema (use z.strictObject to reject them).
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) throw new ValidationError(result.error.issues.map(issueToFieldError));
    return result.data;
  }
}
