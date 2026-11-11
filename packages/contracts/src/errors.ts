import { z } from 'zod';

/** Base URL for RFC 9457 problem `type` values. */
export const PROBLEM_TYPE_BASE = 'https://rid.example/errors/';

/**
 * Stable error codes exposed by the portal API. The code is the last path segment
 * of the problem `type` URL. Add new codes here; never rename an existing one.
 */
export const ErrorCode = {
  ValidationFailed: 'validation_failed',
  BadRequest: 'bad_request',
  Unauthenticated: 'unauthenticated',
  Forbidden: 'forbidden',
  NotFound: 'not_found',
  Conflict: 'conflict',
  InvalidTransition: 'invalid_transition',
  PayloadTooLarge: 'payload_too_large',
  UnsupportedMediaType: 'unsupported_media_type',
  RateLimited: 'rate_limited',
  Internal: 'internal',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid_transition: 409,
  payload_too_large: 413,
  unsupported_media_type: 415,
  rate_limited: 429,
  internal: 500,
};

export function problemType(code: ErrorCode): string {
  return `${PROBLEM_TYPE_BASE}${code}`;
}

/** RFC 9457 problem details as returned by the portal API (`application/problem+json`). */
export const problemDetailsSchema = z.object({
  type: z.url(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]),
  errors: z
    .array(
      z.object({
        path: z.string(),
        message: z.string(),
      }),
    )
    .optional(),
});

export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
