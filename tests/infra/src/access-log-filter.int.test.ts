import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

// The compose file's image: the filter runs in the same Fluent Bit as in the stack.
const IMAGE = 'fluent/fluent-bit:5.1.5-debug';

type Record = { [key: string]: string | number | undefined };

/** Runs records through a Lua filter in a real Fluent Bit (stdin input, JSON lines out). */
function filter(records: Record[], script = 'allowlist.lua', call = 'allowlist'): Record[] {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '-v',
      `${fromRoot('infra/fluent-bit')}:/den:ro`,
      IMAGE,
      '/fluent-bit/bin/fluent-bit',
      '-q',
      '-i',
      'stdin',
      '-F',
      'lua',
      '-m',
      '*',
      '-p',
      `script=/den/${script}`,
      '-p',
      `call=${call}`,
      '-o',
      'stdout',
      '-m',
      '*',
      '-p',
      'format=json_lines',
      '-f',
      '1',
    ],
    {
      input: records.map((r) => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const { date: _date, ...rest } = JSON.parse(line) as Record;
      return rest;
    });
}

/** An access-log record as APISIX's http-logger sends it (ACCESS_LOG_FORMAT): all strings. */
const call = (overrides: Record = {}): Record => ({
  ts: '2026-11-16T01:02:08+00:00',
  request_id: 'demo-mwiiqve0',
  route_id: 'den-route-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
  operation: 'getAfiliado',
  method: 'GET',
  status: '200',
  latency_ms: '0.012',
  upstream_latency_ms: '0.010',
  consumer_entity: 'programas-sociales',
  consumer_app: 'den-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
  subscription_id: '01a1e1bb-e6e8-72d0-8fd0-9ae31776f31d',
  purpose: 'eligibility_check',
  end_user_hash: '96954dc22b760bf38d4d7922b0938cc626cc98be90f356e7220d4878a2d4bedd',
  bytes_sent: '512',
  gateway_node: 'apisix-1',
  deny_reason: '',
  deny_consumer_app: '',
  deny_consumer_entity: '',
  ...overrides,
});

describe('access-log filter in Fluent Bit (ARCHITECTURE.md §8, M5-01)', () => {
  it('keeps the metadata with numbers as numbers and latencies in milliseconds', () => {
    const [out] = filter([call({ upstream_latency_ms: '0.010, 0.004' })]);
    expect(out).toEqual({
      ts: '2026-11-16T01:02:08+00:00',
      request_id: 'demo-mwiiqve0',
      route_id: 'den-route-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
      operation: 'getAfiliado',
      method: 'GET',
      status: 200,
      latency_ms: 12,
      // Two upstreams tried: the time spent in both.
      upstream_latency_ms: 14,
      consumer_entity: 'programas-sociales',
      consumer_app: 'den-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
      subscription_id: '01a1e1bb-e6e8-72d0-8fd0-9ae31776f31d',
      purpose: 'eligibility_check',
      end_user_hash: '96954dc22b760bf38d4d7922b0938cc626cc98be90f356e7220d4878a2d4bedd',
      bytes_sent: 512,
      gateway_node: 'apisix-1',
    });
  });

  it('takes the times APISIX sends as JSON numbers too', () => {
    const [out] = filter([call({ latency_ms: 0.004, upstream_latency_ms: 0.003, status: 200 })]);
    expect(out).toMatchObject({ latency_ms: 4, upstream_latency_ms: 3, status: 200 });
  });

  it('drops the path, the query, bodies and headers outside the allowlist', () => {
    const [out] = filter([
      call({
        uri: '/salud/afiliacion/v1/afiliados/1000000001?documento=1000000001',
        request_uri: '/salud/afiliacion/v1/afiliados/1000000001',
        upstream_uri: '/afiliados/1000000001',
        args: 'documento=1000000001',
        authorization: 'Bearer eyJ',
        body: '{"numero":"1000000001"}',
        subject_ref: 'b647aa1665f45e6af473b28a2300de59',
      }),
    ]);
    expect(JSON.stringify(out)).not.toContain('1000000001');
    expect(out).not.toHaveProperty('subject_ref');
    expect(out).not.toHaveProperty('authorization');
  });

  it('drops a value a client chose when it is not what the gateway would put there', () => {
    const [out] = filter([
      call({
        // Free text with an identification number where a purpose code goes.
        purpose: 'cedula 1000000001',
        request_id: 'consulta?doc=1000000001',
        route_id: '/salud/afiliados/1000000001',
        method: 'get /x',
        status: 'ok',
      }),
    ]);
    expect(JSON.stringify(out)).not.toContain('1000000001');
    for (const key of ['purpose', 'request_id', 'route_id', 'method', 'status']) {
      expect(out, key).not.toHaveProperty(key);
    }
    // A long value is not kept either.
    const [long] = filter([call({ request_id: 'a'.repeat(129) })]);
    expect(long).not.toHaveProperty('request_id');
  });

  it('drops a value the consumer wrote with six digits or more in a row (M-16)', () => {
    const uuid = '10324567-8901-4abc-8def-123456789012';
    const [denied, generated, short] = filter([
      // A denied call: the purpose is whatever the consumer declared.
      call({
        request_id: 'CC-1032456789',
        purpose: 'cc1032456789',
        status: '403',
        upstream_latency_ms: '',
        deny_reason: 'purpose_not_allowed',
      }),
      // The form the gateway generates (request-id plugin): its hex digits often run that long.
      call({ request_id: uuid }),
      call({ request_id: 'demo-12345', purpose: 'law_1581' }),
    ]);
    expect(JSON.stringify(denied)).not.toContain('1032456789');
    expect(denied).not.toHaveProperty('request_id');
    expect(denied).not.toHaveProperty('purpose');
    expect(denied).toMatchObject({ status: 403, deny_reason: 'purpose_not_allowed' });
    expect(generated).toMatchObject({ request_id: uuid });
    expect(short).toMatchObject({ request_id: 'demo-12345', purpose: 'law_1581' });
  });

  it('names the consumer of a denied call from the deny response, never on an allowed one', () => {
    const app = 'den-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b';
    const [denied, allowed] = filter([
      call({
        status: '403',
        consumer_app: '',
        consumer_entity: '',
        subscription_id: '',
        end_user_hash: '',
        upstream_latency_ms: '',
        deny_reason: 'purpose_not_allowed',
        deny_consumer_app: app,
        deny_consumer_entity: 'programas-sociales',
      }),
      call({ deny_consumer_app: 'den-app-other', deny_consumer_entity: 'otra' }),
    ]);
    expect(denied).toMatchObject({
      status: 403,
      deny_reason: 'purpose_not_allowed',
      consumer_app: app,
      consumer_entity: 'programas-sociales',
    });
    expect(denied).not.toHaveProperty('deny_consumer_app');
    expect(denied).not.toHaveProperty('upstream_latency_ms');
    expect(allowed).toMatchObject({ consumer_app: app, consumer_entity: 'programas-sociales' });
    expect(JSON.stringify(allowed)).not.toContain('den-app-other');
  });

  it('a deny reason a provider sent is not a denial: only the gateway denies', () => {
    const [out] = filter([
      call({
        status: '403',
        consumer_app: '',
        deny_reason: 'purpose_not_allowed',
        deny_consumer_app: 'den-app-falsa',
      }),
    ]);
    // The upstream answered (it has an upstream time): its X_DEN_Deny_Reason does not count.
    expect(out).toMatchObject({ status: 403, upstream_latency_ms: 10 });
    expect(out).not.toHaveProperty('deny_reason');
    expect(out).not.toHaveProperty('consumer_app');
  });
});

describe('transparency filter in Fluent Bit (transparency.lua, MT-03)', () => {
  const subjectRef = '96954dc22b760bf38d4d7922b0938cc626cc98be90f356e7220d4878a2d4bedd';
  /** A transparency record as APISIX's tcp-logger sends it, plus what must never pass. */
  const consulted = (overrides: Record = {}): Record => ({
    ts: '1794000000.123',
    gateway_node: 'apisix-1',
    gateway_request_id: 'dd4242b0e03c4fce6d98679e89ae89fd',
    route_id: 'den-route-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
    operation: 'getAfiliado',
    subscription_id: '01a1e1bb-e6e8-72d0-8fd0-9ae31776f31d',
    consumer_entity: 'programas-sociales',
    consumer_app: 'den-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
    purpose: 'eligibility_check',
    end_user_hash: subjectRef,
    subject_ref: subjectRef,
    status: '200',
    upstream_status: '200',
    uri: '/salud/afiliados/1000000001',
    ...overrides,
  });
  const transparency = (records: Record[]) => filter(records, 'transparency.lua', 'transparency');

  it("never keeps the consumer's X-Request-Id, whatever its length (A-4, M-16)", () => {
    const outs = transparency([
      // A gateway still on the old log format sends it.
      consulted({ request_id: 'CC-1000000001' }),
      consulted({ request_id: 'a'.repeat(8000) }),
    ]);
    expect(outs).toHaveLength(2);
    for (const out of outs) {
      expect(out).not.toHaveProperty('request_id');
      expect(out).not.toHaveProperty('uri');
      expect(out).toMatchObject({ subject_ref: subjectRef, upstream_status: '200' });
    }
    expect(JSON.stringify(outs)).not.toContain('1000000001');
  });

  it('drops an oversized value alone, and the calls without a pseudonym or an upstream', () => {
    const outs = transparency([
      consulted({ purpose: 'p'.repeat(300) }),
      consulted({ subject_ref: '' }),
      consulted({ upstream_status: '-' }),
    ]);
    expect(outs).toHaveLength(1);
    expect(outs[0]).not.toHaveProperty('purpose');
    expect(outs[0]).toMatchObject({ operation: 'getAfiliado', gateway_node: 'apisix-1' });
  });
});

describe('error-log filter in Fluent Bit (gateway-errors.lua, M5-01)', () => {
  const errors = (messages: string[]) =>
    filter(
      messages.map((message) => ({ ident: 'apisix', message })),
      'gateway-errors.lua',
      'scrub',
    ).map((r) => String(r.message));
  const prefix =
    '2026/11/16 01:31:23 [error] 50#50: *1701 connect() failed (111: Connection refused) while ' +
    'connecting to upstream, client: 172.24.0.1, server: _';

  it('masks the request line and everything after it, keeping the request id', () => {
    const [out] = errors([
      `${prefix}, request: "GET /salud/afiliados/1000000001?documento=AB123 HTTP/1.1", ` +
        `upstream: "http://10.0.0.5:8000/afiliados/1000000001", host: "gw.example", ` +
        `referrer: "https://x.example/AB123", request_id: "dd4242b0e03c4fce6d98679e89ae89fd"`,
    ]);
    expect(out).toBe(
      `${prefix}, request: "[masked]", request_id: "dd4242b0e03c4fce6d98679e89ae89fd"`,
    );
  });

  it('a path with quotes or fake field names does not end the mask early', () => {
    const [quoted, fake] = errors([
      `${prefix}, request: "GET /salud/a"b/PASAPORTE-XY987 HTTP/1.1", upstream: "http://u/a"b/XY987", host: "h"`,
      // The path itself pretends to end with APISIX's request id.
      `${prefix}, request: "GET /s/XY987, request_id: "abc" HTTP/1.1", upstream: "http://u/XY987", request_id: "abc", x: "XY987"`,
    ]);
    for (const line of [quoted, fake]) {
      expect(line).not.toContain('XY987');
      expect(line).toContain('request: "[masked]"');
    }
  });

  it('masks long digit runs and query strings outside a request too', () => {
    const [out] = errors(['lua error: failed to parse /afiliados/1000000001?doc=AB123 at line 42']);
    expect(out).not.toContain('1000000001');
    expect(out).not.toContain('AB123');
    expect(out).toContain('line 42');
  });
});
