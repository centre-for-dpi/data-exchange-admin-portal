import type { Upstream, VersionValidation } from '@den/contracts';

type Healthcheck = NonNullable<VersionValidation['healthcheck']>;
type Contract = NonNullable<VersionValidation['contract']>;

/**
 * Why the operator cannot approve a version yet (P-07): the same rule the API enforces with a
 * 409 (M4-06). `null` when approving is possible. A version with no report at all is left to
 * the API: the deployment may run without validations (DEN_VERSION_VALIDATION=off).
 */
export type ApprovalBlock = 'pending' | 'failed';

export function approvalBlock(validation: VersionValidation | null): ApprovalBlock | null {
  if (!validation || validation.status === 'passed') return null;
  return validation.status === 'failed' ? 'failed' : 'pending';
}

/**
 * What a healthcheck result means and what to try (P-07), as a key of
 * `version.validation.hints.health`. The healthcheck is a GET on the root of the service through
 * the gateway and passes with any answer that is not a 5xx: a 404 there proves the gateway reaches
 * the service. `null` when there is nothing to explain.
 */
export type HealthcheckHint =
  | 'rootAnswered'
  | 'unreachableNode'
  | 'unreachableDirect'
  | 'unreachableXroad'
  | 'serviceError'
  | 'timeout'
  | 'gatewayDown'
  | 'noRoute'
  | 'notConfigured'
  | 'unknown';

export function healthcheckHint(
  health: Healthcheck,
  upstream: Upstream['type'],
): HealthcheckHint | null {
  const http = health.httpStatus;
  if (health.status === 'passed') return http !== null && http >= 400 ? 'rootAnswered' : null;
  // 502 and 504 come from the gateway: it got no answer from the upstream (connection, TLS,
  // tunnel, Security Server) or not in time.
  if (http === 502 || http === 504) {
    return upstream === 'node'
      ? 'unreachableNode'
      : upstream === 'xroad'
        ? 'unreachableXroad'
        : 'unreachableDirect';
  }
  if (http !== null && http >= 500) return 'serviceError';
  switch (health.reason) {
    case 'timeout':
      return 'timeout';
    case 'unreachable':
      return 'gatewayDown';
    case 'no route':
      return 'noRoute';
    case 'not configured':
      return 'notConfigured';
    default:
      return 'unknown';
  }
}

/**
 * What a contract test result means and what to try (P-07), as a key of
 * `version.validation.hints.contract`; `null` when it passed. The reasons are the ones of the
 * API's probe and of infra/contract-runner.
 */
export type ContractHint =
  | 'mismatch'
  | 'runnerDown'
  | 'timeout'
  | 'couldNotStart'
  | 'noOperations'
  | 'noSandbox'
  | 'runnerNotConfigured'
  | 'unknown';

export function contractHint(contract: Contract): ContractHint | null {
  const reason = contract.reason ?? '';
  switch (contract.status) {
    case 'passed':
      return null;
    case 'failed':
      return 'mismatch';
    case 'skipped':
      return reason === 'runner not configured' ? 'runnerNotConfigured' : 'noSandbox';
    case 'error':
      if (reason === 'runner unreachable' || reason.startsWith('runner HTTP')) return 'runnerDown';
      if (reason === 'timeout') return 'timeout';
      if (reason.startsWith('exit')) return 'couldNotStart';
      if (reason === 'no operations tested') return 'noOperations';
      return 'unknown';
  }
}

/** The operations the contract test failed, as Schemathesis names them (`GET /path`). */
export const failedOperations = (contract: Contract): string[] =>
  contract.operations.filter((o) => !o.passed).map((o) => o.operation);

/**
 * What a failed operation means: the sandbox failed with a 5xx, or it answered something the
 * OpenAPI does not declare (status code, content type or schema: the checks the runner runs).
 */
export const operationHint = (
  operation: Contract['operations'][number],
): 'serverError' | 'mismatch' =>
  operation.receivedStatus !== null && operation.receivedStatus >= 500 ? 'serverError' : 'mismatch';
