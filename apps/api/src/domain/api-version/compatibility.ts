/**
 * Backward compatibility of an OpenAPI revision against the published document (ADR-0019,
 * SPEC.md §4.2). Conservative: anything a consumer built against the published document might
 * rely on must stay. Allowed: new operations, new optional parameters, new response properties,
 * text changes. Returns one human-readable reason per breaking change (empty = compatible).
 */

type Json = Record<string, unknown>;
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;
const DATA_SUBJECT = 'x-rid-data-subject';

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
  params: Map<string, { required: boolean }>;
  bodyRequired: boolean;
  bodyRequiredProps: Set<string>;
  responses: Map<string, Map<string, string>>;
  dataSubject: string;
  security: string;
}

const canonical = (v: unknown): string =>
  JSON.stringify(v ?? null, (_k, val: unknown) =>
    isObject(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

function jsonSchemaOf(doc: Json, content: unknown): Json | undefined {
  if (!isObject(content)) return undefined;
  const media = content['application/json'] ?? Object.values(content)[0];
  if (!isObject(media)) return undefined;
  const schema = deref(doc, media.schema);
  return isObject(schema) ? schema : undefined;
}

/** Top-level properties of an object schema with their declared type. */
function propertyTypes(doc: Json, schema: Json | undefined): Map<string, string> {
  const out = new Map<string, string>();
  const props = schema && isObject(schema.properties) ? schema.properties : {};
  for (const [name, raw] of Object.entries(props)) {
    const prop = deref(doc, raw);
    out.set(name, isObject(prop) ? canonical(prop.type ?? null) : 'null');
  }
  return out;
}

function operations(doc: Json): Map<string, Operation> {
  const ops = new Map<string, Operation>();
  const paths = isObject(doc.paths) ? doc.paths : {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(doc, rawItem);
    if (!isObject(item)) continue;
    const shared: unknown[] = Array.isArray(item.parameters) ? item.parameters : [];
    for (const method of METHODS) {
      const op = item[method];
      if (!isObject(op)) continue;
      const params = new Map<string, { required: boolean }>();
      const own: unknown[] = Array.isArray(op.parameters) ? op.parameters : [];
      for (const raw of [...shared, ...own]) {
        const p = deref(doc, raw);
        if (isObject(p) && typeof p.name === 'string' && typeof p.in === 'string') {
          params.set(`${p.in}:${p.name}`, { required: p.required === true || p.in === 'path' });
        }
      }
      const body = deref(doc, op.requestBody);
      const bodySchema = isObject(body) ? jsonSchemaOf(doc, body.content) : undefined;
      const responses = new Map<string, Map<string, string>>();
      for (const [status, rawResponse] of Object.entries(
        isObject(op.responses) ? op.responses : {},
      )) {
        if (!/^2/.test(status)) continue;
        const response = deref(doc, rawResponse);
        responses.set(
          status,
          propertyTypes(doc, isObject(response) ? jsonSchemaOf(doc, response.content) : undefined),
        );
      }
      ops.set(`${method.toUpperCase()} ${path}`, {
        key: `${method.toUpperCase()} ${path}`,
        operationId: typeof op.operationId === 'string' ? op.operationId : undefined,
        params,
        bodyRequired: isObject(body) && body.required === true,
        bodyRequiredProps: new Set(
          bodySchema && Array.isArray(bodySchema.required) ? bodySchema.required.map(String) : [],
        ),
        responses,
        dataSubject: canonical(op[DATA_SUBJECT] ?? item[DATA_SUBJECT] ?? null),
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
    for (const name of old.params.keys()) {
      if (!now.params.has(name)) problems.push(`${key} removed parameter ${name}`);
    }
    if (!old.bodyRequired && now.bodyRequired) problems.push(`${key} now requires a request body`);
    for (const prop of now.bodyRequiredProps) {
      if (!old.bodyRequiredProps.has(prop))
        problems.push(`${key} requires the new body property ${prop}`);
    }
    for (const [status, props] of old.responses) {
      const nowProps = now.responses.get(status);
      if (!nowProps) {
        problems.push(`${key} no longer returns ${status}`);
        continue;
      }
      for (const [prop, type] of props) {
        if (!nowProps.has(prop)) problems.push(`${key} ${status} removed property ${prop}`);
        else if (nowProps.get(prop) !== type)
          problems.push(`${key} ${status} changed the type of ${prop}`);
      }
    }
    if (old.dataSubject !== now.dataSubject) {
      problems.push(`${key} changed its ${DATA_SUBJECT} declaration`);
    }
    if (old.security !== now.security) problems.push(`${key} changed its security requirements`);
  }
  return problems;
}
