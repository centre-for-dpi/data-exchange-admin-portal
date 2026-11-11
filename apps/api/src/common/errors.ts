import { ErrorCode } from '@rid/contracts';

export interface FieldError {
  path: string;
  message: string;
}

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

export class ForbiddenError extends DomainError {
  constructor(message = 'You are not allowed to perform this action') {
    super(ErrorCode.Forbidden, message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super(ErrorCode.Conflict, message);
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
