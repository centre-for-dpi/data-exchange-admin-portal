import { listOperations } from '../../apis/lint/openapi-lint.js';

/**
 * Backward compatibility of an OpenAPI revision against the published document (ADR-0019,
 * SPEC.md §4.2). Conservative: anything a consumer built against the published document might
 * rely on must stay. Allowed: new operations, new optional parameters, new response properties,
 * text changes. Returns one human-readable reason per breaking change (empty = compatible).
 */

type Json = Record<string, unknown>;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
const DATA_SUBJECT = 'x-den-data-subject';

const isObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Follows local `$ref`s (#/components/...), guarding against cycles. */
function deref(doc: Json, value: unknown, seen = new Set<string>()): unknown {
  if (!isObject(value) || typeof value.$ref !== 'string') return value;
  const ref = value.$ref;
  if (!ref.startsWith('#/') || seen.has(ref)) return {};
  seen.add(ref);
  let target: unknown = doc;
  for (const part of ref.slice(2).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    target = isObject(target) ? target[key] : undefined;
  }
  return deref(doc, target, seen);
}

interface Operation {
  key: string;
  operationId?: string;
  params: Map<string, { required: boolean; schema: unknown }>;
  bodyRequired: boolean;
  bodySchema: unknown;
  responses: Map<string, unknown>;
  dataSubject: string;
  security: string;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, val: unknown) =>
    isObject(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

function mediaSchemaOf(content: unknown): unknown {
  if (!isObject(content)) return undefined;
  const media = content['application/json'] ?? Object.values(content)[0];
  return isObject(media) ? media.schema : undefined;
}

/** Work shared by one whole comparison: the untrusted documents must not make it explode. */
class Budget {
  private left = 200_000;
  /** Reference pairs being compared right now (a cycle through them compares equal). */
  readonly inProgress = new Set<string>();
  /** The breaks found by each finished pair of references, with the path they were found at. */
  readonly results = new Map<string, { where: string; problems: string[] }>();
  /** Outcome of the structural equality of reference pairs; true while in progress (coinductive). */
  readonly equal = new Map<string, boolean>();
  tick(n = 1): void {
    this.left -= n;
    if (this.left < 0) throw new TooComplexError();
  }
}
class TooComplexError extends Error {}

/**
 * Structural equality with local `$ref`s resolved lazily on both sides. A pair of references is
 * decided once (a cycle counts as equal while it is being decided), so a document whose schemas
 * reference each other many times costs one comparison per pair, not one per path.
 */
function equalResolved(
  da: Json,
  a: unknown,
  db: Json,
  b: unknown,
  budget: Budget,
  depth = 0,
): boolean {
  budget.tick();
  if (depth > MAX_EQUAL_DEPTH) throw new TooComplexError();
  const aRef = isObject(a) && typeof a.$ref === 'string' ? a.$ref : undefined;
  const bRef = isObject(b) && typeof b.$ref === 'string' ? b.$ref : undefined;
  if (aRef !== undefined || bRef !== undefined) {
    const key = `${aRef ?? ''}|${bRef ?? ''}`;
    // Only a pair of references is memoized; a reference against an inline value is resolved.
    if (aRef !== undefined && bRef !== undefined) {
      const known = budget.equal.get(key);
      if (known !== undefined) return known;
      budget.equal.set(key, true);
    }
    const ra = aRef !== undefined ? refTarget(da, a) : a;
    const rb = bRef !== undefined ? refTarget(db, b) : b;
    const result =
      ra !== undefined && rb !== undefined && equalResolved(da, ra, db, rb, budget, depth + 1);
    if (aRef !== undefined && bRef !== undefined) budget.equal.set(key, result);
    return result;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equalResolved(da, v, db, b[i], budget, depth + 1))
    );
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return (
      ka.length === kb.length &&
      ka.every((k, i) => k === kb[i] && equalResolved(da, a[k], db, b[k], budget, depth + 1))
    );
  }
  return a === b;
}

/** The target of a local `$ref` one step; undefined when it does not resolve. */
function refTarget(doc: Json, value: unknown): unknown {
  if (!isObject(value) || typeof value.$ref !== 'string' || !value.$ref.startsWith('#/')) {
    return undefined;
  }
  let target: unknown = doc;
  for (const part of value.$ref.slice(2).split('/')) {
    const key = part.replaceAll('~1', '/').replaceAll('~0', '~');
    target = isObject(target) ? target[key] : undefined;
  }
  return target;
}

const COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'discriminator'];
/** push(...list) overflows the stack on long lists. */
function addAll(into: string[], list: string[]): void {
  for (const item of list) into.push(item);
}

const MAX_DEPTH = 32;
const MAX_EQUAL_DEPTH = 400;

interface Side {
  doc: Json;
  schema: unknown;
}

/**
 * Compares two schemas recursively (nested properties, array items, additional properties).
 * What cannot be compared (combinators that differ, a depth beyond the limit) counts as
 * incompatible. `input` tells a request side (a new required property breaks callers) from a
 * response side (a property that stops being required breaks consumers).
 */
function schemaBreaks(
  before: Side,
  after: Side,
  where: string,
  input: boolean,
  budget: Budget,
  depth = 0,
): string[] {
  budget.tick();
  if (before.schema === undefined) return [];
  if (after.schema === undefined) return [`${where} no longer declares a schema`];
  if (depth > MAX_DEPTH) return [`${where} is nested too deeply to compare`];
  const bRef = isObject(before.schema) ? before.schema.$ref : undefined;
  const aRef = isObject(after.schema) ? after.schema.$ref : undefined;
  // Only a pair of references is shared work; an inline schema is always compared on its own.
  if (typeof bRef !== 'string' || typeof aRef !== 'string') {
    return schemaBreaksOf(before, after, where, input, budget, depth);
  }
  const pair = `${input ? 'in' : 'out'}|${bRef}|${aRef}`;
  const known = budget.results.get(pair);
  if (known) {
    // The same pair found the same breaks, now seen at another path. Repeating a long list costs
    // its length, so breaks that multiply through shared schemas end in 'too complex'.
    budget.tick(known.problems.length);
    return known.problems.map((p) => where + p.slice(known.where.length));
  }
  if (budget.inProgress.has(pair)) return []; // a genuine cycle: being compared higher up
  budget.inProgress.add(pair);
  const problems = schemaBreaksOf(before, after, where, input, budget, depth);
  budget.inProgress.delete(pair);
  budget.results.set(pair, { where, problems });
  return problems;
}

function schemaBreaksOf(
  before: Side,
  after: Side,
  where: string,
  input: boolean,
  budget: Budget,
  depth: number,
): string[] {
  const b = deref(before.doc, before.schema);
  const a = deref(after.doc, after.schema);
  if (!isObject(b) || !isObject(a)) {
    return canonical(b) === canonical(a) ? [] : [`${where} changed its schema`];
  }
  if (COMBINATORS.some((k) => k in b || k in a)) {
    return equalResolved(before.doc, b, after.doc, a, budget)
      ? []
      : [`${where} changed a composed schema (${COMBINATORS.join('/')}), which cannot be compared`];
  }
  const problems: string[] = [];
  if (canonical(b.type) !== canonical(a.type)) problems.push(`${where} changed its type`);
  if (canonical(b.format) !== canonical(a.format)) problems.push(`${where} changed its format`);
  if (
    (b.nullable === true) !== (a.nullable === true) &&
    (input ? a.nullable !== true : b.nullable === true)
  ) {
    problems.push(`${where} changed its nullability`);
  }
  const bProps = isObject(b.properties) ? b.properties : {};
  const aProps = isObject(a.properties) ? a.properties : {};
  for (const [name, raw] of Object.entries(bProps)) {
    if (!(name in aProps)) {
      problems.push(`${where} removed property ${name}`);
      continue;
    }
    addAll(
      problems,
      schemaBreaks(
        { doc: before.doc, schema: raw },
        { doc: after.doc, schema: aProps[name] },
        `${where}.${name}`,
        input,
        budget,
        depth + 1,
      ),
    );
  }
  const bReq = new Set(Array.isArray(b.required) ? b.required.map(String) : []);
  const aReq = new Set(Array.isArray(a.required) ? a.required.map(String) : []);
  if (input) {
    for (const p of aReq)
      if (!bReq.has(p)) problems.push(`${where} requires the new property ${p}`);
  } else {
    for (const p of bReq) if (!aReq.has(p)) problems.push(`${where} no longer always returns ${p}`);
  }
  if (b.items !== undefined) {
    addAll(
      problems,
      schemaBreaks(
        { doc: before.doc, schema: b.items },
        { doc: after.doc, schema: a.items },
        `${where}[]`,
        input,
        budget,
        depth + 1,
      ),
    );
  }
  if (isObject(b.additionalProperties)) {
    addAll(
      problems,
      schemaBreaks(
        { doc: before.doc, schema: b.additionalProperties },
        { doc: after.doc, schema: a.additionalProperties },
        `${where}{}`,
        input,
        budget,
        depth + 1,
      ),
    );
  } else if (canonical(b.additionalProperties) !== canonical(a.additionalProperties)) {
    problems.push(`${where} changed additionalProperties`);
  }
  return problems;
}

function operations(doc: Json): Map<string, Operation> {
  const ops = new Map<string, Operation>();
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    // Path items are read as the gateway and OPA read them (listOperations): no $ref.
    const item = rawItem;
    if (!isObject(item)) continue;
    const shared: unknown[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const params = new Map<string, { required: boolean; schema: unknown }>();
      const own: unknown[] = Array.isArray(op.parameters) ? op.parameters : [];
      for (const raw of [...shared, ...own]) {
        const p = deref(doc, raw);
        if (isObject(p) && typeof p.name === 'string' && typeof p.in === 'string') {
          params.set(`${p.in}:${p.name}`, {
            required: p.required === true || p.in === 'path',
            // OpenAPI 2-style parameters carry the type beside the name.
            schema:
              p.schema ?? (p.type === undefined ? mediaSchemaOf(p.content) : { type: p.type }),
          });
        }
      }
      const body = deref(doc, op.requestBody);
      const responses = new Map<string, unknown>();
      for (const [status, rawResponse] of Object.entries(
        isObject(op.responses) ? op.responses : {},
      )) {
        if (!/^2/.test(status)) continue;
        const response = deref(doc, rawResponse);
        responses.set(status, isObject(response) ? mediaSchemaOf(response.content) : undefined);
      }
      ops.set(`${method.toUpperCase()} ${path}`, {
        key: `${method.toUpperCase()} ${path}`,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        params,
        bodyRequired: isObject(body) && body.required === true,
        bodySchema: isObject(body) ? mediaSchemaOf(body.content) : undefined,
        responses,
        // Operation level only, as listOperations reads it.
        dataSubject: canonical(op[DATA_SUBJECT] ?? null),
        security: canonical(op.security ?? doc.security ?? null),
      });
    }
  }
  return ops;
}

export function breakingChanges(published: unknown, revision: unknown): string[] {
  try {
    return compare(published, revision, new Budget());
  } catch (error) {
    // Fail closed: what is too intricate to compare is not known to be compatible.
    if (error instanceof TooComplexError) return ['The schemas are too complex to compare'];
    throw error;
  }
}

function compare(published: unknown, revision: unknown, budget: Budget): string[] {
  if (!isObject(published) || !isObject(revision)) return ['The document is not an OpenAPI object'];
  const before = operations(published);
  const after = operations(revision);
  const problems: string[] = [];
  // What the gateway, OPA and the transparency register act on comes from listOperations: the
  // operations and their data subject must survive exactly as that parser sees them.
  const enforced = new Map(listOperations(revision).map((o) => [`${o.method} ${o.path}`, o]));
  for (const old of listOperations(published)) {
    const key = `${old.method} ${old.path}`;
    const now = enforced.get(key);
    if (!now) {
      if (!after.has(key)) continue; // reported below as removed
      problems.push(`${key} is no longer an operation the gateway recognises`);
      continue;
    }
    if (canonical(old.dataSubject) !== canonical(now.dataSubject)) {
      problems.push(`${key} changed its ${DATA_SUBJECT} declaration as the gateway reads it`);
    }
  }
  for (const [key, old] of before) {
    const now = after.get(key);
    if (!now) {
      problems.push(`${key} was removed`);
      continue;
    }
    if (old.operationId !== now.operationId) {
      problems.push(`${key} changed its operationId from ${old.operationId} to ${now.operationId}`);
    }
    for (const [name, p] of now.params) {
      const was = old.params.get(name);
      if (!was && p.required) problems.push(`${key} has a new required parameter ${name}`);
      if (was && !was.required && p.required)
        problems.push(`${key} made parameter ${name} required`);
    }
    for (const [name, was] of old.params) {
      const is = now.params.get(name);
      if (!is) {
        problems.push(`${key} removed parameter ${name}`);
        continue;
      }
      addAll(
        problems,
        schemaBreaks(
          { doc: published, schema: was.schema },
          { doc: revision, schema: is.schema },
          `${key} parameter ${name}`,
          true,
          budget,
        ),
      );
    }
    if (!old.bodyRequired && now.bodyRequired) problems.push(`${key} now requires a request body`);
    addAll(
      problems,
      schemaBreaks(
        { doc: published, schema: old.bodySchema },
        { doc: revision, schema: now.bodySchema },
        `${key} request body`,
        true,
        budget,
      ),
    );
    for (const [status, schema] of old.responses) {
      if (!now.responses.has(status)) {
        problems.push(`${key} no longer returns ${status}`);
        continue;
      }
      addAll(
        problems,
        schemaBreaks(
          { doc: published, schema },
          { doc: revision, schema: now.responses.get(status) },
          `${key} ${status}`,
          false,
          budget,
        ),
      );
    }
    if (old.dataSubject !== now.dataSubject) {
      problems.push(`${key} changed its ${DATA_SUBJECT} declaration`);
    }
    if (old.security !== now.security) problems.push(`${key} changed its security requirements`);
  }
  return problems;
}
