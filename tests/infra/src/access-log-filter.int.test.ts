import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

// The compose file's image: the filter runs in the same Fluent Bit as in the stack.
const IMAGE = 'fluent/fluent-bit:5.1.5-debug';

type Record = { [key: string]: string | number | undefined };

/** Runs records through allowlist.lua in a real Fluent Bit (stdin input, JSON lines out). */
function filter(records: Record[]): Record[] {
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '-v',
      `${fromRoot('infra/fluent-bit')}:/rid:ro`,
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
      'script=/rid/allowlist.lua',
      '-p',
      'call=allowlist',
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
  route_id: 'rid-route-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
  operation: 'getAfiliado',
  method: 'GET',
  status: '200',
  latency_ms: '0.012',
  upstream_latency_ms: '0.010',
  consumer_entity: 'programas-sociales',
  consumer_app: 'rid-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
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
      route_id: 'rid-route-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
      operation: 'getAfiliado',
      method: 'GET',
      status: 200,
      latency_ms: 12,
      // Two upstreams tried: the time spent in both.
      upstream_latency_ms: 14,
      consumer_entity: 'programas-sociales',
      consumer_app: 'rid-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
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

  it('names the consumer of a denied call from the deny response, never on an allowed one', () => {
    const app = 'rid-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b';
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
      call({ deny_consumer_app: 'rid-app-other', deny_consumer_entity: 'otra' }),
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
    expect(JSON.stringify(allowed)).not.toContain('rid-app-other');
  });

  it('a deny reason a provider sent is not a denial: only the gateway denies', () => {
    const [out] = filter([
      call({
        status: '403',
        consumer_app: '',
        deny_reason: 'purpose_not_allowed',
        deny_consumer_app: 'rid-app-falsa',
      }),
    ]);
    // The upstream answered (it has an upstream time): its X_RID_Deny_Reason does not count.
    expect(out).toMatchObject({ status: 403, upstream_latency_ms: 10 });
    expect(out).not.toHaveProperty('deny_reason');
    expect(out).not.toHaveProperty('consumer_app');
  });
});
