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

/** Resolves every local `$ref` below a value; a cycle is replaced by a marker. */
function expand(doc: Json, value: unknown, stack: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((v) => expand(doc, v, stack));
  if (!isObject(value)) return value;
  if (typeof value.$ref === 'string') {
    const ref = value.$ref;
    if (stack.includes(ref)) return { $cycle: ref };
    const target = deref(doc, value);
    // An unresolvable reference stays visible, so two different ones never compare equal.
    return isObject(target) && Object.keys(target).length === 0
      ? { $unresolved: ref }
      : expand(doc, target, [...stack, ref]);
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(doc, v, stack)]));
}

const COMBINATORS = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'discriminator'];
const MAX_DEPTH = 32;

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
  pairs: string[] = [],
  depth = 0,
): string[] {
  if (before.schema === undefined) return [];
  if (after.schema === undefined) return [`${where} no longer declares a schema`];
  if (depth > MAX_DEPTH) return [`${where} is nested too deeply to compare`];
  const bRef = isObject(before.schema) ? before.schema.$ref : undefined;
  const aRef = isObject(after.schema) ? after.schema.$ref : undefined;
  if (typeof bRef === 'string' || typeof aRef === 'string') {
    const pair = `${String(bRef)}|${String(aRef)}`;
    if (pairs.includes(pair)) return []; // being compared higher up
    pairs = [...pairs, pair];
  }
  const b = deref(before.doc, before.schema);
  const a = deref(after.doc, after.schema);
  if (!isObject(b) || !isObject(a)) {
    return canonical(b) === canonical(a) ? [] : [`${where} changed its schema`];
  }
  if (COMBINATORS.some((k) => k in b || k in a)) {
    return canonical(expand(before.doc, b)) === canonical(expand(after.doc, a))
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
    problems.push(
      ...schemaBreaks(
        { doc: before.doc, schema: raw },
        { doc: after.doc, schema: aProps[name] },
        `${where}.${name}`,
        input,
        pairs,
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
    problems.push(
      ...schemaBreaks(
        { doc: before.doc, schema: b.items },
        { doc: after.doc, schema: a.items },
        `${where}[]`,
        input,
        pairs,
        depth + 1,
      ),
    );
  }
  if (isObject(b.additionalProperties)) {
    problems.push(
      ...schemaBreaks(
        { doc: before.doc, schema: b.additionalProperties },
        { doc: after.doc, schema: a.additionalProperties },
        `${where}{}`,
        input,
        pairs,
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
      problems.push(
        ...schemaBreaks(
          { doc: published, schema: was.schema },
          { doc: revision, schema: is.schema },
          `${key} parameter ${name}`,
          true,
        ),
      );
    }
    if (!old.bodyRequired && now.bodyRequired) problems.push(`${key} now requires a request body`);
    problems.push(
      ...schemaBreaks(
        { doc: published, schema: old.bodySchema },
        { doc: revision, schema: now.bodySchema },
        `${key} request body`,
        true,
      ),
    );
    for (const [status, schema] of old.responses) {
      if (!now.responses.has(status)) {
        problems.push(`${key} no longer returns ${status}`);
        continue;
      }
      problems.push(
        ...schemaBreaks(
          { doc: published, schema },
          { doc: revision, schema: now.responses.get(status) },
          `${key} ${status}`,
          false,
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
