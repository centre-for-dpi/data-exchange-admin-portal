import { ErrorCode, type FieldErrorDetail } from '@den/contracts';

/**
 * A field error: the English message for API clients, and the key and parameters the portal
 * translates (M6-02, packages/contracts errors.ts).
 */
export type FieldError = FieldErrorDetail;

/** Base class for errors the API turns into RFC 9457 problem details. */
export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly errors?: FieldError[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(errors: FieldError[]) {
    super(ErrorCode.ValidationFailed, 'The request is not valid', errors);
  }
}

export class NotFoundError extends DomainError {
  constructor(what = 'Resource') {
    super(ErrorCode.NotFound, `${what} not found`);
  }
}

/** The request carries no valid credential (401). */
export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication is required') {
    super(ErrorCode.Unauthenticated, message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You are not allowed to perform this action') {
    super(ErrorCode.Forbidden, message);
  }
}

export class ConflictError extends DomainError {
  /** `reason`: a key the portal words for the user (ADR-0025), for conflicts worth explaining. */
  constructor(message: string, reason?: Omit<FieldError, 'path' | 'message'>) {
    super(ErrorCode.Conflict, message, reason ? [{ path: '', message, ...reason }] : undefined);
  }
}

/** Thrown by state machines (domain/<context>/state-machine.ts) on a forbidden transition. */
export class InvalidTransitionError extends DomainError {
  constructor(
    readonly entity: string,
    readonly from: string,
    readonly to: string,
  ) {
    super(ErrorCode.InvalidTransition, `${entity} cannot go from ${from} to ${to}`);
  }
}

export class UnsupportedMediaTypeError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.UnsupportedMediaType, message);
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.PayloadTooLarge, message);
  }
}

export class GoneError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.Gone, message);
  }
}

/**
 * The caller's roles require a second factor and the token says the session was opened without
 * one (M3-08, ADR-0021). The web answers by signing in again with acr_values=mfa.
 */
export class MfaRequiredError extends DomainError {
  constructor() {
    super(
      ErrorCode.MfaRequired,
      'Your roles require a second factor: sign in again with your one-time code',
    );
  }
}

/** A service the request depends on did not answer; the client may try again later. */
export class ServiceUnavailableError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.ServiceUnavailable, message);
  }
}
