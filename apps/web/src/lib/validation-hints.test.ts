import type { VersionValidation } from '@den/contracts';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import es from '../../messages/es.json';
import {
  approvalBlock,
  type ContractHint,
  contractHint,
  failedOperations,
  type HealthcheckHint,
  healthcheckHint,
  operationHint,
} from './validation-hints';

type Health = NonNullable<VersionValidation['healthcheck']>;
type Contract = NonNullable<VersionValidation['contract']>;

const report = (status: VersionValidation['status']): VersionValidation => ({
  status,
  startedAt: '2026-11-18T10:00:00.000Z',
  finishedAt: status === 'running' ? null : '2026-11-18T10:00:05.000Z',
  healthcheck: null,
  contract: null,
});
const health = (h: Partial<Health>): Health => ({
  status: 'failed',
  httpStatus: null,
  latencyMs: null,
  ...h,
});
const contract = (c: Partial<Contract>): Contract => ({ status: 'failed', operations: [], ...c });

describe('the approval gate in the review (P-07)', () => {
  it('blocks while the validations run or after they failed, as the API does', () => {
    expect(approvalBlock(report('running'))).toBe('pending');
    expect(approvalBlock(report('failed'))).toBe('failed');
    expect(approvalBlock(report('passed'))).toBeNull();
  });

  it('leaves a version without a report to the API (deployments without validations)', () => {
    expect(approvalBlock(null)).toBeNull();
  });
});

describe('what a healthcheck result means (P-07)', () => {
  it('502 and 504 are the gateway not reaching the upstream, worded per upstream type', () => {
    for (const httpStatus of [502, 504]) {
      expect(healthcheckHint(health({ httpStatus, reason: 'server error' }), 'node')).toBe(
        'unreachableNode',
      );
      expect(healthcheckHint(health({ httpStatus }), 'direct')).toBe('unreachableDirect');
      expect(healthcheckHint(health({ httpStatus }), 'xroad')).toBe('unreachableXroad');
    }
  });

  it('another 5xx is the service failing', () => {
    for (const httpStatus of [500, 501, 503]) {
      expect(healthcheckHint(health({ httpStatus }), 'node')).toBe('serviceError');
    }
  });

  it('a 404 (or any 4xx) on the service root passed, and says why that is fine', () => {
    expect(healthcheckHint(health({ status: 'passed', httpStatus: 404 }), 'node')).toBe(
      'rootAnswered',
    );
    expect(healthcheckHint(health({ status: 'passed', httpStatus: 401 }), 'direct')).toBe(
      'rootAnswered',
    );
    expect(healthcheckHint(health({ status: 'passed', httpStatus: 200 }), 'node')).toBeNull();
  });

  it('failures without an answer are told apart by the probe reason', () => {
    const cases: Array<[string | undefined, HealthcheckHint]> = [
      ['timeout', 'timeout'],
      ['unreachable', 'gatewayDown'],
      ['no route', 'noRoute'],
      ['not configured', 'notConfigured'],
      ['something new', 'unknown'],
      [undefined, 'unknown'],
    ];
    for (const [reason, hint] of cases) {
      expect(healthcheckHint(health({ reason }), 'node'), reason).toBe(hint);
    }
  });
});

describe('what a contract test result means (P-07)', () => {
  it('a mismatch names the operations that failed, each with what went wrong', () => {
    const failed = contract({
      operations: [
        { operation: 'GET /afiliados/{id}', passed: true, codes: [], receivedStatus: null },
        {
          operation: 'POST /afiliados/verificaciones',
          passed: false,
          codes: ['ST101'],
          receivedStatus: 500,
        },
        { operation: 'GET /regimen', passed: false, codes: ['ST401'], receivedStatus: 200 },
      ],
    });
    expect(contractHint(failed)).toBe('mismatch');
    expect(failedOperations(failed)).toEqual(['POST /afiliados/verificaciones', 'GET /regimen']);
    expect(failed.operations.map(operationHint)).toEqual(['mismatch', 'serverError', 'mismatch']);
  });

  it('errors and skips are told apart by the runner reason', () => {
    const cases: Array<[Contract['status'], string | undefined, ContractHint | null]> = [
      ['passed', undefined, null],
      ['error', 'runner unreachable', 'runnerDown'],
      ['error', 'runner HTTP 502', 'runnerDown'],
      ['error', 'timeout', 'timeout'],
      ['error', 'exit 1', 'couldNotStart'],
      ['error', 'no operations tested', 'noOperations'],
      ['error', undefined, 'unknown'],
      ['skipped', 'no sandbox upstream', 'noSandbox'],
      ['skipped', 'runner not configured', 'runnerNotConfigured'],
    ];
    for (const [status, reason, hint] of cases) {
      expect(contractHint(contract({ status, reason })), `${status} ${reason}`).toBe(hint);
    }
  });
});

describe('the texts of every hint (P-07)', () => {
  const healthHints: HealthcheckHint[] = [
    'rootAnswered',
    'unreachableNode',
    'unreachableDirect',
    'unreachableXroad',
    'serviceError',
    'timeout',
    'gatewayDown',
    'noRoute',
    'notConfigured',
    'unknown',
  ];
  const contractHints: ContractHint[] = [
    'mismatch',
    'runnerDown',
    'timeout',
    'couldNotStart',
    'noOperations',
    'noSandbox',
    'runnerNotConfigured',
    'unknown',
  ];
  // Informational results have no next step; every failure says what to try.
  const informational = new Set(['rootAnswered', 'noSandbox', 'runnerNotConfigured']);

  it('exist in Spanish and English, with a next step for every failure', () => {
    for (const messages of [es, en]) {
      const hints = messages.version.validation.hints as Record<
        'health' | 'contract',
        Record<string, { meaning?: string; next?: string }>
      >;
      for (const [group, keys] of [
        ['health', healthHints],
        ['contract', contractHints],
      ] as const) {
        expect(Object.keys(hints[group]).sort()).toEqual([...keys].sort());
        for (const key of keys) {
          expect(hints[group][key]?.meaning, `${group}.${key}`).toBeTruthy();
          expect(Boolean(hints[group][key]?.next), `${group}.${key}.next`).toBe(
            !informational.has(key),
          );
        }
      }
      expect(Object.keys(messages.operator.review.approveBlocked).sort()).toEqual([
        'failed',
        'pending',
      ]);
    }
  });
});
