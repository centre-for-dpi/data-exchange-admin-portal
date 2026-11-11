import { Body, Controller, ForbiddenException, Get, Module, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { problemDetailsSchema } from '@rid/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../app.js';
import { CoreModule } from '../core.module.js';
import { InvalidTransitionError, NotFoundError } from './errors.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const createThingSchema = z.strictObject({ name: z.string().min(3), size: z.number().int() });

@Controller('test-errors')
class ErrorsController {
  @Get('not-found')
  notFound(): never {
    throw new NotFoundError('Api');
  }

  @Get('transition')
  transition(): never {
    throw new InvalidTransitionError('subscription', 'revoked', 'active');
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException();
  }

  @Get('crash')
  crash(): never {
    throw new Error('db password is hunter2');
  }

  @Post('things')
  create(@Body(new ZodValidationPipe(createThingSchema)) body: z.infer<typeof createThingSchema>) {
    return body;
  }
}

@Module({ imports: [CoreModule], controllers: [ErrorsController] })
class ErrorsTestModule {}

describe('RFC 9457 problem details', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(ErrorsTestModule);
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const get = (url: string) => app.inject({ method: 'GET', url });
  const post = (url: string, payload: string, contentType = 'application/json') =>
    app.inject({ method: 'POST', url, payload, headers: { 'content-type': contentType } });

  function expectProblem(
    res: Awaited<ReturnType<typeof get>>,
    status: number,
    code: string,
  ): Record<string, unknown> {
    expect(res.statusCode).toBe(status);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = res.json<Record<string, unknown>>();
    expect(problemDetailsSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    expect(body).toMatchObject({ status, code, type: `https://rid.example/errors/${code}` });
    return body;
  }

  it('maps domain errors to their code and status', async () => {
    expectProblem(await get('/api/v1/test-errors/not-found'), 404, 'not_found');
    const transition = expectProblem(
      await get('/api/v1/test-errors/transition'),
      409,
      'invalid_transition',
    );
    expect(transition.detail).toBe('subscription cannot go from revoked to active');
  });

  it('maps Nest HTTP exceptions', async () => {
    expectProblem(await get('/api/v1/test-errors/forbidden'), 403, 'forbidden');
  });

  it('answers unknown routes with a not_found problem and no query string in instance', async () => {
    const res = await get('/api/v1/nope?cedula=123');
    const body = expectProblem(res, 404, 'not_found');
    expect(body.instance).toBe('/api/v1/nope');
    expect(res.body).not.toContain('123');
  });

  it('hides internal error messages from the client', async () => {
    const res = await get('/api/v1/test-errors/crash');
    const body = expectProblem(res, 500, 'internal');
    expect(res.body).not.toContain('hunter2');
    expect(body).not.toHaveProperty('detail');
  });

  it('returns field errors from zod validation', async () => {
    const res = await post('/api/v1/test-errors/things', JSON.stringify({ name: 'x', extra: 1 }));
    const body = expectProblem(res, 400, 'validation_failed');
    const paths = (body.errors as Array<{ path: string }>).map((e) => e.path).sort();
    expect(paths).toEqual(['', 'name', 'size']);
  });

  it('accepts a valid body', async () => {
    const res = await post('/api/v1/test-errors/things', JSON.stringify({ name: 'abc', size: 2 }));
    expect(res.statusCode).toBe(201);
  });

  it('turns errors raised by Fastify before the handler into problems', async () => {
    const malformed = await post('/api/v1/test-errors/things', '{"name": "52123456", bad');
    expectProblem(malformed, 400, 'bad_request');
    // Parser messages quote the body; they must not be echoed back.
    expect(malformed.body).not.toContain('52123456');
    expectProblem(
      await post('/api/v1/test-errors/things', 'name=abc', 'text/plain'),
      415,
      'unsupported_media_type',
    );
    const big = JSON.stringify({ name: 'a'.repeat(1024 * 1024 + 10), size: 1 });
    expectProblem(await post('/api/v1/test-errors/things', big), 413, 'payload_too_large');
  });
});
