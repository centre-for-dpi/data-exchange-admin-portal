import { createHash } from 'node:crypto';
import spectralCore from '@stoplight/spectral-core';
// Spectral packages are CommonJS: use their default export. Named/namespace imports work under
// Vitest's interop but are undefined in plain Node ESM (caught by scripts/smoke-dist.mjs).
import spectralParsers from '@stoplight/spectral-parsers';
import spectralRefResolver from '@stoplight/spectral-ref-resolver';
import spectralRulesets from '@stoplight/spectral-rulesets';
import { parseDocument } from 'yaml';
import { openapiHashVariants } from '../../domain/node/contract.js';
import type { DataSubject, LintIssue, LintReport, Operation } from '@den/contracts';

const { Spectral, Document, createRulesetFunction } = spectralCore;
const { oas } = spectralRulesets;
const { Yaml } = spectralParsers;
const { Resolver } = spectralRefResolver;

/**
 * The document is untrusted input. Spectral's default resolver follows $refs over HTTP and the
 * file system (SSRF, local file read): this one has no readers at all, so only local `#/...`
 * references resolve. External references are also reported by the den-no-external-ref rule.
 */
const localOnlyResolver = () => new Resolver({ resolvers: {} });

/** Limits against YAML alias bombs ("billion laughs") and oversized documents. */
const MAX_YAML_ALIASES = 100;
const MAX_PARSED_JSON_BYTES = 2 * 1024 * 1024;

const onlyLocalRefs = createRulesetFunction<unknown, null>({ input: null, options: null }, (ref) =>
  typeof ref === 'string' && ref.startsWith('#')
    ? undefined
    : [{ message: 'Only local references (#/...) are allowed; external $ref are not resolved' }],
);

/**
 * Words that mark a parameter as an identifier. Identifiers in the query string end up in URLs,
 * proxies and logs; DEN asks for them in the path or in a POST body (SPEC.md §4.2,
 * features.lint.noIdInQuery). Generic words (Spanish and English), not country document names.
 */
const ID_WORDS = new Set(['id', 'ids', 'uuid', 'doc', 'num', 'nro', 'numero', 'number']);
const ID_PREFIXES = ['ident', 'document'];

/** Splits camelCase, snake_case, kebab-case and dotted names into lower-case words. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export const isIdentifierLike = (name: string): boolean =>
  nameWords(name).some((w) => ID_WORDS.has(w) || ID_PREFIXES.some((p) => w.startsWith(p)));

const notIdentifierLike = createRulesetFunction<string, null>(
  { input: { type: 'string' }, options: null },
  (name) =>
    isIdentifierLike(name)
      ? [
          {
            message: `Query parameter "${name}" looks like an identifier: use a path parameter or a POST body`,
          },
        ]
      : undefined,
);

export interface LintOptions {
  /** features.lint.noIdInQuery of the country config. */
  noIdInQuery: boolean;
  /**
   * Data subject declarations (x-den-data-subject, ADR-0015). `required` for APIs with personal or
   * sensitive data; `documentTypes` are the country's person document types. Without it, declared
   * extensions are still checked for shape.
   */
  dataSubject?: { required: boolean; documentTypes: readonly string[] };
}

export const DATA_SUBJECT_EXTENSION = 'x-den-data-subject';

/** Path template parameters of an OpenAPI path, e.g. /a/{id}/b/{x}.json -> [id, x]. */
const templateParams = (path: string): string[] =>
  [...path.matchAll(/\{([^/{}]+)\}/g)].map((m) => m[1] ?? '');

/** RFC 6901 JSON pointer, as the gateway plugin accepts it (non-empty, starting with "/"). */
export const JSON_POINTER = /^(\/([^~/]|~[01])*)+$/;

/**
 * Reads x-den-data-subject: "none", or an object { in: path, name, documentType?,
 * documentTypeParam? } | { in: body, pointer, documentType?, documentTypePointer? } | { in: none }.
 * Returns 'invalid' for any other shape and undefined when the extension is absent.
 */
export function parseDataSubject(raw: unknown): DataSubject | 'invalid' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'none') return { in: 'none' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'invalid';
  const value = raw as Record<string, unknown>;
  const optionalString = (key: string) =>
    value[key] === undefined || (typeof value[key] === 'string' && value[key] !== '');
  const only = (keys: string[]) => Object.keys(value).every((k) => keys.includes(k));
  if (value.in === 'none' && only(['in'])) return { in: 'none' };
  if (
    value.in === 'body' &&
    only(['in', 'pointer', 'documentType', 'documentTypePointer']) &&
    typeof value.pointer === 'string' &&
    value.pointer !== '' &&
    optionalString('documentType') &&
    optionalString('documentTypePointer')
  ) {
    return {
      in: 'body',
      pointer: value.pointer,
      ...(typeof value.documentType === 'string' ? { documentType: value.documentType } : {}),
      ...(typeof value.documentTypePointer === 'string'
        ? { documentTypePointer: value.documentTypePointer }
        : {}),
    };
  }
  if (
    value.in === 'path' &&
    only(['in', 'name', 'documentType', 'documentTypeParam']) &&
    typeof value.name === 'string' &&
    value.name !== '' &&
    optionalString('documentType') &&
    optionalString('documentTypeParam')
  ) {
    return {
      in: 'path',
      name: value.name,
      ...(typeof value.documentType === 'string' ? { documentType: value.documentType } : {}),
      ...(typeof value.documentTypeParam === 'string'
        ? { documentTypeParam: value.documentTypeParam }
        : {}),
    };
  }
  return 'invalid';
}

/** DEN ruleset (M1-03): minimal and strict. Grows with M2-05 (compatibility) and M4-06. */
function ruleset(options: LintOptions) {
  return {
    // Start from the OAS ruleset with every rule off, then enable only what DEN requires.
    extends: [[oas, 'off']] as [typeof oas, 'off'][],
    rules: {
      'oas3-schema': 'error',
      'operation-operationId': 'error',
      'operation-operationId-unique': 'error',
      'operation-success-response': 'error',
      'operation-parameters': 'error',
      'path-params': 'error',
      'no-$ref-siblings': 'error',
      'den-no-external-ref': {
        description: 'Every $ref must point inside the document',
        severity: 'error',
        resolved: false,
        given: "$..[?(@property === '$ref')]",
        then: { function: onlyLocalRefs },
      },
      ...(options.noIdInQuery
        ? {
            'den-no-id-in-query': {
              description: 'Identifiers must not travel in the query string',
              severity: 'error',
              given: [
                '$.paths[*][*].parameters[?(@.in == "query")].name',
                '$.paths[*].parameters[?(@.in == "query")].name',
              ],
              then: { function: notIdentifierLike },
            },
          }
        : {}),
    },
  } as const;
}

export interface ParsedOpenApi {
  /** The document as JSON (what is stored and served). */
  spec: Record<string, unknown>;
  sha256: string;
  /** The same text's other byte forms a node may hold (P-02, openapiHashVariants). */
  sha256Variants: string[];
  report: LintReport;
  /** Operations declared in the document (input for subscriptions and OPA routes). */
  operations: Operation[];
}

const SEVERITY: Record<number, LintIssue['severity']> = {
  0: 'error',
  1: 'warning',
  2: 'info',
  3: 'info',
};
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

type RawOperation = { operationId?: unknown; [DATA_SUBJECT_EXTENSION]?: unknown };

export function listOperations(spec: Record<string, unknown>): ParsedOpenApi['operations'] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, RawOperation>>;
  const operations: ParsedOpenApi['operations'] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      const operationId = operation?.operationId;
      if (typeof operationId !== 'string') continue;
      const subject = parseDataSubject(operation?.[DATA_SUBJECT_EXTENSION]);
      operations.push({
        operationId,
        method: method.toUpperCase(),
        path,
        // An invalid declaration counts as none declared; the lint report says why.
        dataSubject: subject && subject !== 'invalid' ? subject : null,
      });
    }
  }
  return operations;
}

/**
 * Checks x-den-data-subject on every operation (ADR-0015): its shape, that the parameters it
 * names exist in the path template, that document types are the country's, and, for personal or
 * sensitive APIs, that every operation declares one.
 */
function dataSubjectIssues(
  spec: Record<string, unknown>,
  options: LintOptions,
  lineOf: (path: string[]) => number,
): LintIssue[] {
  const issues: LintIssue[] = [];
  const paths = (spec.paths ?? {}) as Record<string, Record<string, RawOperation>>;
  const issue = (code: string, message: string, at: string[]) =>
    issues.push({ code, message, severity: 'error', path: at, line: lineOf(at) });
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (!operation || typeof operation !== 'object') continue;
      const name = typeof operation.operationId === 'string' ? operation.operationId : method;
      const at = ['paths', path, method];
      const subject = parseDataSubject(operation[DATA_SUBJECT_EXTENSION]);
      if (subject === undefined) {
        if (options.dataSubject?.required) {
          issue(
            'den-data-subject-required',
            `Operation ${name} must declare whose data it handles: ${DATA_SUBJECT_EXTENSION} with a path parameter, a body pointer, or none`,
            at,
          );
        }
        continue;
      }
      const atExtension = [...at, DATA_SUBJECT_EXTENSION];
      if (subject === 'invalid') {
        issue(
          'den-data-subject-invalid',
          `${DATA_SUBJECT_EXTENSION} must be "none", { in: path, name, documentType? or documentTypeParam? } or { in: body, pointer, documentType? or documentTypePointer? }`,
          atExtension,
        );
        continue;
      }
      if (subject.in === 'none') continue;
      const types = options.dataSubject?.documentTypes;
      if (subject.documentType && types && !types.includes(subject.documentType)) {
        issue(
          'den-data-subject-document-type',
          `Unknown document type "${subject.documentType}" (allowed: ${types.join(', ')})`,
          atExtension,
        );
      }
      if (subject.in === 'path') {
        const params = templateParams(path);
        for (const param of [subject.name, subject.documentTypeParam]) {
          if (param && !params.includes(param)) {
            issue(
              'den-data-subject-parameter',
              `Path parameter "${param}" is not in ${path}`,
              atExtension,
            );
          }
        }
        if (subject.documentType && subject.documentTypeParam) {
          issue(
            'den-data-subject-invalid',
            'Use either documentType or documentTypeParam, not both',
            atExtension,
          );
        }
      }
      if (subject.in === 'body') {
        // The gateway reads the subject from a JSON body: the operation must take one.
        const body = (operation as { requestBody?: { content?: Record<string, unknown> } })
          .requestBody;
        if (!body?.content?.['application/json']) {
          issue(
            'den-data-subject-body',
            `Operation ${name} declares its data subject in the body but takes no application/json request body`,
            atExtension,
          );
        }
        for (const pointer of [subject.pointer, subject.documentTypePointer]) {
          if (pointer && !JSON_POINTER.test(pointer)) {
            issue(
              'den-data-subject-pointer',
              `"${pointer}" is not a JSON pointer (RFC 6901), e.g. /numeroIdentificacion`,
              atExtension,
            );
          }
        }
        if (subject.documentType && subject.documentTypePointer) {
          issue(
            'den-data-subject-invalid',
            'Use either documentType or documentTypePointer, not both',
            atExtension,
          );
        }
      }
    }
  }
  return issues;
}

/**
 * One segment of a path template, as the gateway ranks it (M-13): 2 literal, 1 partly a parameter
 * ({id}.json), 0 a whole parameter. `prefix` and `suffix` are the literal text around the
 * parameters (the whole text for a literal segment).
 */
interface TemplateSegment {
  rank: 0 | 1 | 2;
  text: string;
  prefix: string;
  suffix: string;
  pattern: RegExp;
}

function templateSegments(path: string): TemplateSegment[] {
  return path.split('/').map((text) => {
    const parts = text.split(/\{[^/{}]+\}/);
    const escaped = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return {
      rank: parts.length === 1 ? 2 : /^\{[^/{}]+\}$/.test(text) ? 0 : 1,
      text,
      prefix: parts[0] ?? '',
      suffix: parts.at(-1) ?? '',
      pattern: new RegExp(`^${escaped.join('[^/]+')}$`),
    };
  });
}

/** Whether some request segment could match both (conservative when both have parameters). */
function segmentsOverlap(a: TemplateSegment, b: TemplateSegment): boolean {
  if (a.rank === 2 && b.rank === 2) return a.text === b.text;
  if (a.rank === 2) return b.pattern.test(a.text);
  if (b.rank === 2) return a.pattern.test(b.text);
  // Both with parameters: disjoint only if their literal ends cannot agree (.json and .xml).
  const prefixes = a.prefix.startsWith(b.prefix) || b.prefix.startsWith(a.prefix);
  const suffixes = a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix);
  return prefixes && suffixes;
}

/** a is at least as specific as b in every segment and more in one: every router picks a. */
const dominates = (a: TemplateSegment[], b: TemplateSegment[]): boolean =>
  a.every((s, i) => s.rank >= (b[i]?.rank ?? 0)) && a.some((s, i) => s.rank > (b[i]?.rank ?? 0));

/**
 * Paths a request could match under one method with neither more specific (M-13). The gateway
 * gives a literal segment precedence over a parameter (packages/policy/den/authz.rego,
 * operation), so /afiliados/buscar next to /afiliados/{id} is fine. /a/{x} next to /{y}/b is not:
 * routers disagree on /a/b, and the gateway could authorize and record one operation while the
 * provider runs the other. Equivalent templates (/a/{x} and /a/{y}) are Spectral's path-params.
 */
function ambiguousPathIssues(
  spec: Record<string, unknown>,
  lineOf: (path: string[]) => number,
): LintIssue[] {
  const paths = Object.entries((spec.paths ?? {}) as Record<string, Record<string, unknown>>).map(
    ([path, item]) => ({
      path,
      segments: templateSegments(path),
      shape: path.replace(/\{[^/{}]+\}/g, '{}'),
      methods: HTTP_METHODS.filter((m) => item && typeof item === 'object' && m in item),
    }),
  );
  const issues: LintIssue[] = [];
  for (const [i, a] of paths.entries()) {
    for (const b of paths.slice(i + 1)) {
      if (a.segments.length !== b.segments.length || a.shape === b.shape) continue;
      const methods = a.methods.filter((m) => b.methods.includes(m));
      if (methods.length === 0) continue;
      if (!a.segments.every((s, k) => b.segments[k] && segmentsOverlap(s, b.segments[k]))) continue;
      if (dominates(a.segments, b.segments) || dominates(b.segments, a.segments)) continue;
      const at = ['paths', b.path];
      issues.push({
        code: 'den-ambiguous-paths',
        message: `Paths ${a.path} and ${b.path} can match the same ${methods.map((m) => m.toUpperCase()).join('/')} request and neither is more specific: make one literal wherever the other has a parameter, or separate them`,
        severity: 'error',
        path: at,
        line: lineOf(at),
      });
    }
  }
  return issues;
}

/**
 * Gatekeeper in front of Spectral, whose YAML parser expands aliases without limit. Fails closed:
 * the document reaches Spectral only if the bounded parser read it without any error, with at
 * most MAX_YAML_ALIASES alias expansions and within MAX_PARSED_JSON_BYTES. Any other outcome
 * (syntax error, duplicate key, alias bomb, oversize) rejects it here, with the error's line.
 */
function preflight(source: string): LintIssue[] {
  const document = parseDocument(source, { prettyErrors: false, uniqueKeys: true });
  if (document.errors.length > 0) {
    return document.errors.map((error) => ({
      code: 'parser',
      message: error.message,
      severity: 'error' as const,
      path: [],
      line: error.linePos?.[0]?.line ?? 1,
    }));
  }
  let data: unknown;
  try {
    data = document.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch {
    return [
      {
        code: 'den-yaml-too-complex',
        message: `The YAML uses too many aliases (limit ${MAX_YAML_ALIASES})`,
        severity: 'error',
        path: [],
        line: 1,
      },
    ];
  }
  if (JSON.stringify(data ?? null).length > MAX_PARSED_JSON_BYTES) {
    return [
      {
        code: 'den-openapi-too-large',
        message: 'The document is too large once parsed',
        severity: 'error',
        path: [],
        line: 1,
      },
    ];
  }
  return [];
}

/**
 * Parses an OpenAPI 3.x document given as YAML or JSON text and lints it with the DEN ruleset.
 * Issues carry 1-based line numbers so the UI can point at them (M1-03).
 */

export async function lintOpenApi(source: string, options: LintOptions): Promise<ParsedOpenApi> {
  const sha256 = createHash('sha256').update(source).digest('hex');
  const sha256Variants = openapiHashVariants(source);
  const rejected = preflight(source);
  if (rejected.length > 0) {
    return {
      spec: {},
      sha256,
      sha256Variants,
      report: { valid: false, issues: rejected },
      operations: [],
    };
  }

  const document = new Document(source, Yaml, 'openapi.yaml');
  const spec = (document.data ?? {}) as Record<string, unknown>;
  const issues: LintIssue[] = [];

  for (const error of document.diagnostics) {
    issues.push({
      code: 'parser',
      message: error.message,
      severity: 'error',
      path: (error.path ?? []).map(String),
      line: error.range.start.line + 1,
    });
  }

  const version = typeof spec.openapi === 'string' ? spec.openapi : undefined;
  if (!version?.startsWith('3.')) {
    issues.push({
      code: 'den-openapi-3',
      message: 'The document must be OpenAPI 3.x (field "openapi": "3.0.x" or "3.1.x")',
      severity: 'error',
      path: ['openapi'],
      line: 1,
    });
  } else {
    const spectral = new Spectral({ resolver: localOnlyResolver() });
    spectral.setRuleset(ruleset(options) as unknown as Parameters<typeof spectral.setRuleset>[0]);
    for (const result of await spectral.run(document)) {
      issues.push({
        code: String(result.code),
        message: result.message,
        severity: SEVERITY[result.severity] ?? 'error',
        path: result.path.map(String),
        line: result.range.start.line + 1,
      });
    }
    // Paths stay inside the version: no `.`/`..` segments, encoded dots or slashes, backslashes or
    // empty segments, which a gateway, a Security Server or the contract test could resolve to
    // another route (M4-06 security review).
    for (const path of Object.keys(spec.paths ?? {})) {
      if (/(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(path)) {
        const at = ['paths', path];
        const range = document.getRangeForJsonPath(at, true);
        issues.push({
          code: 'den-path-traversal',
          message: `Path ${path} must not contain . or .. segments, encoded dots or slashes, backslashes or empty segments`,
          severity: 'error',
          path: at,
          line: range ? range.start.line + 1 : 1,
        });
      }
    }
    const lineOf = (path: string[]) => {
      const range = document.getRangeForJsonPath(path, true);
      return range ? range.start.line + 1 : 1;
    };
    issues.push(...dataSubjectIssues(spec, options, lineOf), ...ambiguousPathIssues(spec, lineOf));
  }

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return {
    spec,
    sha256,
    sha256Variants,
    report: { valid: !issues.some((i) => i.severity === 'error'), issues },
    operations: listOperations(spec),
  };
}
