import { afterEach, describe, expect, it, vi } from 'vitest';
import { DenLogger, logFormat, maskLogText } from './logger.js';

describe('maskLogText', () => {
  it('masks query strings, which may carry identification numbers', () => {
    expect(maskLogText('GET /api/v1/x?documento=CC&numero=12 failed')).toBe(
      'GET /api/v1/x?[masked] failed',
    );
  });

  it('masks runs of six digits or more and keeps shorter numbers', () => {
    expect(maskLogText('person 1032456789 on port 5432, pid 42')).toBe(
      'person [n] on port 5432, pid 42',
    );
  });

  it('keeps UUIDs whole: they identify records, not people', () => {
    const id = '01934567-8901-7abc-8def-123456789012';
    expect(maskLogText(`subscription ${id} activated`)).toBe(`subscription ${id} activated`);
  });

  it('masks e-mail addresses', () => {
    expect(maskLogText('invitation for ana.perez@entidad.gov.co sent')).toBe(
      'invitation for [email] sent',
    );
  });

  it('masks the credentials of a URL', () => {
    expect(maskLogText('connect postgresql://den_app:s3cr3t@db:5432/den refused')).toBe(
      'connect postgresql://[masked]@db:5432/den refused',
    );
  });

  it('leaves a question mark in prose alone', () => {
    expect(maskLogText('Is DEN_COUNTRY set? It is not.')).toBe('Is DEN_COUNTRY set? It is not.');
  });

  it('masks the whole query, quotes included', () => {
    expect(maskLogText('path /x?a="1"&b=2 end')).toBe('path /x?[masked] end');
  });
});

describe('logFormat', () => {
  it('is text by default and json on request', () => {
    expect(logFormat({})).toBe('text');
    expect(logFormat({ DEN_LOG_FORMAT: 'JSON' })).toBe('json');
    expect(logFormat({ DEN_LOG_FORMAT: ' text ' })).toBe('text');
  });

  it('rejects anything else', () => {
    expect(() => logFormat({ DEN_LOG_FORMAT: 'yaml' })).toThrow(/DEN_LOG_FORMAT/);
  });
});

describe('DenLogger', () => {
  afterEach(() => vi.restoreAllMocks());

  function capture() {
    const lines: string[] = [];
    const sink = (chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    };
    vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    return lines;
  }

  it('writes one masked JSON object per line in json format', () => {
    const lines = capture();
    new DenLogger('json', ['log']).log('lookup ?numero=1032456789 done', 'Probe');
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'log',
      context: 'Probe',
      message: 'lookup ?[masked] done',
    });
  });

  it('masks the stack of an error in json format', () => {
    const lines = capture();
    new DenLogger('json', ['error']).error(
      'upstream failed',
      'Error: GET /v1/personas/1032456789\n    at f (file.js:1:2)',
      'Proxy',
    );
    const text = lines.join('');
    expect(text).not.toContain('1032456789');
    expect(() => JSON.parse(lines[0]!) as unknown).not.toThrow();
  });

  it('masks messages and stacks in text format, without colors', () => {
    const lines = capture();
    const logger = new DenLogger('text', ['error']);
    logger.error(
      'mail to ana@entidad.gov.co failed',
      'Error: x\n    at y (/srv/1032456789.js:1:1)',
      'Mail',
    );
    const text = lines.join('');
    expect(text).toContain('[email]');
    expect(text).not.toContain('ana@entidad.gov.co');
    expect(text).not.toContain('1032456789');
    expect(text).not.toContain('\u001b[');
  });

  it('honours the levels it is given', () => {
    const lines = capture();
    new DenLogger('json', ['error']).log('not printed');
    expect(lines).toHaveLength(0);
  });
});
