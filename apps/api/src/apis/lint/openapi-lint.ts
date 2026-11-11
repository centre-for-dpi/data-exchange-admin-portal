import { createHash } from 'node:crypto';
import spectralCore from '@stoplight/spectral-core';
// Spectral packages are CommonJS: use their default export. Named/namespace imports work under
// Vitest's interop but are undefined in plain Node ESM (caught by scripts/smoke-dist.mjs).
import spectralParsers from '@stoplight/spectral-parsers';
import spectralRefResolver from '@stoplight/spectral-ref-resolver';
import spectralRulesets from '@stoplight/spectral-rulesets';
import { parse as parseYaml } from 'yaml';
import type { LintIssue, LintReport } from '@rid/contracts';

const { Spectral, Document, createRulesetFunction } = spectralCore;
const { oas } = spectralRulesets;
const { Yaml } = spectralParsers;
const { Resolver } = spectralRefResolver;

/**
 * The document is untrusted input. Spectral's default resolver follows $refs over HTTP and the
 * file system (SSRF, local file read): this one has no readers at all, so only local `#/...`
 * references resolve. External references are also reported by the rid-no-external-ref rule.
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
 * proxies and logs; RID asks for them in the path or in a POST body (SPEC.md §4.2,
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
}

/** RID ruleset (M1-03): minimal and strict. Grows with M2-05 (compatibility) and M4-06. */
function ruleset(options: LintOptions) {
  return {
    // Start from the OAS ruleset with every rule off, then enable only what RID requires.
    extends: [[oas, 'off']] as [typeof oas, 'off'][],
    rules: {
      'oas3-schema': 'error',
      'operation-operationId': 'error',
      'operation-operationId-unique': 'error',
      'operation-success-response': 'error',
      'operation-parameters': 'error',
      'path-params': 'error',
      'no-$ref-siblings': 'error',
      'rid-no-external-ref': {
        description: 'Every $ref must point inside the document',
        severity: 'error',
        resolved: false,
        given: "$..[?(@property === '$ref')]",
        then: { function: onlyLocalRefs },
      },
      ...(options.noIdInQuery
        ? {
            'rid-no-id-in-query': {
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
  report: LintReport;
  /** operationIds declared in the document (input for subscriptions and OPA routes). */
  operations: Array<{ operationId: string; method: string; path: string }>;
}

const SEVERITY: Record<number, LintIssue['severity']> = {
  0: 'error',
  1: 'warning',
  2: 'info',
  3: 'info',
};
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

export function listOperations(spec: Record<string, unknown>): ParsedOpenApi['operations'] {
  const paths = (spec.paths ?? {}) as Record<string, Record<string, { operationId?: unknown }>>;
  const operations: ParsedOpenApi['operations'] = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operationId = item?.[method]?.operationId;
      if (typeof operationId === 'string')
        operations.push({ operationId, method: method.toUpperCase(), path });
    }
  }
  return operations;
}

/**
 * Parses an OpenAPI 3.x document given as YAML or JSON text and lints it with the RID ruleset.
 * Issues carry 1-based line numbers so the UI can point at them (M1-03).
 */
/**
 * Pre-parse with a bounded YAML parser before handing the text to Spectral, whose parser expands
 * aliases without limit. Returns an issue when the document must not be processed further.
 */
function preflight(source: string): LintIssue | undefined {
  let data: unknown;
  try {
    data = parseYaml(source, { maxAliasCount: MAX_YAML_ALIASES, prettyErrors: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/alias/i.test(message)) {
      return {
        code: 'rid-yaml-too-complex',
        message: `The YAML uses too many aliases (limit ${MAX_YAML_ALIASES})`,
        severity: 'error',
        path: [],
        line: 1,
      };
    }
    return undefined; // Syntax errors are reported with their line by Spectral's parser below.
  }
  if (JSON.stringify(data ?? null).length > MAX_PARSED_JSON_BYTES) {
    return {
      code: 'rid-openapi-too-large',
      message: 'The document is too large once parsed',
      severity: 'error',
      path: [],
      line: 1,
    };
  }
  return undefined;
}

export async function lintOpenApi(source: string, options: LintOptions): Promise<ParsedOpenApi> {
  const sha256 = createHash('sha256').update(source).digest('hex');
  const rejected = preflight(source);
  if (rejected) {
    return { spec: {}, sha256, report: { valid: false, issues: [rejected] }, operations: [] };
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
      code: 'rid-openapi-3',
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
  }

  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return {
    spec,
    sha256,
    report: { valid: !issues.some((i) => i.severity === 'error'), issues },
    operations: listOperations(spec),
  };
}
