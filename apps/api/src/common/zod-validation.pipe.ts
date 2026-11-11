import type { PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * Validates and parses a request part with a zod schema from packages/contracts (CLAUDE.md,
 * rule 9). Use it per parameter: `@Body(new ZodValidationPipe(createApiSchema)) body`.
 * Unknown fields are handled by the schema (use z.strictObject to reject them).
 */
export class ZodValidationPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ValidationError(
        result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      );
    }
    return result.data;
  }
}
