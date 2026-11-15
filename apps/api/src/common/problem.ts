import { HttpException } from '@nestjs/common';
import { ERROR_HTTP_STATUS, ErrorCode, problemType, type ProblemDetails } from '@rid/contracts';
import { DomainError } from './errors.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

const TITLES: Record<ErrorCode, string> = {
  validation_failed: 'Validation failed',
  bad_request: 'Bad request',
  unauthenticated: 'Authentication required',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  invalid_transition: 'Invalid state transition',
  gone: 'Gone',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  rate_limited: 'Too many requests',
  internal: 'Internal server error',
  service_unavailable: 'Service unavailable',
  mfa_required: 'Second factor required',
};

const CODE_BY_STATUS: Record<number, ErrorCode> = {
  400: ErrorCode.BadRequest,
  401: ErrorCode.Unauthenticated,
  403: ErrorCode.Forbidden,
  404: ErrorCode.NotFound,
  409: ErrorCode.Conflict,
  410: ErrorCode.Gone,
  413: ErrorCode.PayloadTooLarge,
  415: ErrorCode.UnsupportedMediaType,
  429: ErrorCode.RateLimited,
  503: ErrorCode.ServiceUnavailable,
};

const codeForStatus = (status: number): ErrorCode =>
  CODE_BY_STATUS[status] ??
  (status >= 400 && status < 500 ? ErrorCode.BadRequest : ErrorCode.Internal);

const statusOf = (exception: unknown): number | undefined => {
  const status = (exception as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status <= 599 ? status : undefined;
};

/**
 * Maps any thrown value to RFC 9457 problem details. Only DomainError messages (written by us)
 * become `detail`: framework and parser messages can echo the URL or a fragment of the body
 * (e.g. JSON.parse errors), which may carry identifiers. Stack traces never leave the server.
 */
export function toProblem(exception: unknown, instance?: string): ProblemDetails {
  let code: ErrorCode;
  let detail: string | undefined;
  let errors: ProblemDetails['errors'];

  if (exception instanceof DomainError) {
    code = exception.code;
    detail = exception.message;
    errors = exception.errors;
  } else if (exception instanceof HttpException) {
    code = codeForStatus(exception.getStatus());
  } else if (statusOf(exception) !== undefined) {
    // Fastify errors raised before the route handler (body parsing, size limit, content type).
    code = codeForStatus(statusOf(exception) ?? 500);
  } else {
    code = ErrorCode.Internal;
  }

  return {
    type: problemType(code),
    title: TITLES[code],
    status: ERROR_HTTP_STATUS[code],
    code,
    ...(detail ? { detail } : {}),
    ...(instance ? { instance } : {}),
    ...(errors?.length ? { errors } : {}),
  };
}
