import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromRoot } from './paths.js';

// The compose file's image.
const IMAGE = 'fluent/fluent-bit:5.1.5-debug';
/** APISIX's tcp-logger batch (batch_max_size in apps/api/src/reconcilers/apisix/desired-state.ts). */
const BATCH_MAX_SIZE = 100;

const docker = (...args: string[]) =>
  spawnSync('docker', args, {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A record as APISIX's tcp-logger sends it (TRANSPARENCY_LOG_FORMAT): every value a string. */
const consulted = (i: number, extra: Record<string, string> = {}) => ({
  ts: (1_794_000_000 + i / 1000).toFixed(3),
  gateway_node: 'apisix-5f7c9d8b6-x2k4q',
  gateway_request_id: i.toString(16).padStart(32, '0'),
  route_id: 'den-route-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
  operation: 'getAfiliadoPorDocumentoDeIdentidad',
  subscription_id: '01a1e1bb-e6e8-72d0-8fd0-9ae31776f31d',
  consumer_entity: 'programas-sociales-del-departamento',
  consumer_app: 'den-app-01a1e1bb-a2ca-73cb-9746-621ebe76f18b',
  purpose: 'eligibility_check',
  end_user_hash: 'e'.repeat(64),
  subject_ref: 's'.repeat(64),
  status: '200',
  upstream_status: '200',
  ...extra,
});

/**
 * The transparency pipeline's input (A-3): APISIX's tcp-logger sends each batch as one JSON array
 * over TCP, and a record lost there is a consultation the citizen never sees. Runs the
 * repository's transparency.yaml in a real Fluent Bit, with its input and Lua filter as they
 * are and stdout in place of the collector, and counts what comes out of full batches.
 */
describe('transparency pipeline: full APISIX batches reach the output (A-3)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'den-transparency-'));
  let container = '';
  let tcpPort = 0;

  beforeAll(async () => {
    const source = readFileSync(fromRoot('infra/fluent-bit/transparency.yaml'), 'utf8');
    const [pipeline] = source.split('\n  outputs:\n');
    expect(pipeline).toContain('name: tcp');
    writeFileSync(
      join(dir, 'transparency.yaml'),
      `${pipeline}\n  outputs:\n    - name: stdout\n      match: den.transparency\n      format: json_lines\n`,
    );
    const run = docker(
      'run',
      '-d',
      '-p',
      '127.0.0.1::5170',
      '-p',
      '127.0.0.1::2020',
      '-e',
      'FLUENT_BIT_HTTP_PORT=2020',
      '-v',
      `${fromRoot('infra/fluent-bit')}:/fluent-bit/etc/den:ro`,
      '-v',
      `${dir}:/test:ro`,
      IMAGE,
      '/fluent-bit/bin/fluent-bit',
      '-c',
      '/test/transparency.yaml',
    );
    expect(run.status, run.stderr).toBe(0);
    container = run.stdout.trim();
    const published = (port: string) =>
      Number(/:(\d+)\s*$/m.exec(docker('port', container, port).stdout)?.[1] ?? 0);
    tcpPort = published('5170/tcp');
    const healthPort = published('2020/tcp');
    // Docker accepts connections before Fluent Bit listens: wait for its health endpoint.
    for (let i = 0; i < 60; i++) {
      const ok = await fetch(`http://127.0.0.1:${healthPort}/api/v1/health`).then(
        (r) => r.ok,
        () => false,
      );
      if (ok) return;
      await sleep(500);
    }
    throw new Error(`Fluent Bit did not start: ${docker('logs', container).stderr}`);
  }, 90_000);

  afterAll(() => {
    if (container) docker('rm', '-f', container);
    rmSync(dir, { recursive: true, force: true });
  });

  /** Sends one batch as tcp-logger does: the JSON array, then the connection closes. */
  const send = (batch: unknown[]) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify(batch);
      const socket = createConnection({ host: '127.0.0.1', port: tcpPort }, () => {
        socket.end(body);
      });
      socket.on('error', reject);
      socket.on('close', () => resolve(Buffer.byteLength(body)));
    });

  /** Records of these gateway request ids printed by the stdout output. */
  const delivered = async (ids: Set<string>, expected: number) => {
    let seen = new Set<string>();
    for (let i = 0; i < 40 && seen.size < expected; i++) {
      await sleep(500);
      const { stdout } = docker('logs', container);
      seen = new Set(
        stdout
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) =>
            String((JSON.parse(line) as { gateway_request_id?: string }).gateway_request_id),
          )
          .filter((id) => ids.has(id)),
      );
    }
    return seen.size;
  };

  it('delivers every record of a full batch', async () => {
    const batch = Array.from({ length: BATCH_MAX_SIZE }, (_, i) => consulted(i));
    const bytes = await send(batch);
    // Over the tcp input's default 32 KB buffer, where the whole batch used to be dropped.
    expect(bytes).toBeGreaterThan(48 * 1024);
    const ids = new Set(batch.map((r) => r.gateway_request_id));
    expect(await delivered(ids, BATCH_MAX_SIZE)).toBe(BATCH_MAX_SIZE);
  }, 60_000);

  it('delivers a full batch of the old log format with 8 KB request ids, without them', async () => {
    // The largest a header can make a record: nginx's request header buffers are 8 KB.
    const batch = Array.from({ length: BATCH_MAX_SIZE }, (_, i) =>
      consulted(1000 + i, { request_id: 'a'.repeat(8000) }),
    );
    expect(await send(batch)).toBeGreaterThan(800 * 1024);
    const ids = new Set(batch.map((r) => r.gateway_request_id));
    expect(await delivered(ids, BATCH_MAX_SIZE)).toBe(BATCH_MAX_SIZE);
    expect(docker('logs', container).stdout).not.toContain('a'.repeat(300));
  }, 60_000);
});
