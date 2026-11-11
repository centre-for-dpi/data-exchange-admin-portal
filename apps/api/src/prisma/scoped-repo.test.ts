import { describe, expect, it } from 'vitest';
import { EntityScopeError, scopedRepo } from './scoped-repo.js';

/** Fake Prisma delegate that records the arguments it receives. */
function fakeDelegate() {
  const calls: Array<{ method: string; args: unknown }> = [];
  const record =
    (method: string) =>
    (args?: unknown): Promise<unknown> => {
      calls.push({ method, args });
      return Promise.resolve(method === 'count' ? 0 : []);
    };
  return {
    calls,
    delegate: {
      findMany: record('findMany'),
      findFirst: record('findFirst'),
      count: record('count') as (args?: unknown) => Promise<number>,
      create: record('create'),
      updateMany: record('updateMany'),
    },
  };
}

const ENTITY = '0193a6c0-0000-7000-8000-00000000aaaa';

describe('scopedRepo', () => {
  it('adds the entity filter when there is no where', async () => {
    const { delegate, calls } = fakeDelegate();
    await scopedRepo(delegate, ENTITY).findMany();
    expect(calls[0]).toEqual({ method: 'findMany', args: { where: { entityId: ENTITY } } });
  });

  it('combines the caller filter with the entity filter instead of replacing it', async () => {
    const { delegate, calls } = fakeDelegate();
    const repo = scopedRepo(delegate, ENTITY);
    await repo.findFirst({ where: { id: 'x' } });
    await repo.count({ where: { status: 'draft' } });
    expect(calls.map((c) => c.args)).toEqual([
      { where: { AND: [{ id: 'x' }, { entityId: ENTITY }] } },
      { where: { AND: [{ status: 'draft' }, { entityId: ENTITY }] } },
    ]);
  });

  it('cannot be bypassed by a caller filter on another entity', async () => {
    const { delegate, calls } = fakeDelegate();
    await scopedRepo(delegate, ENTITY).findMany({ where: { entityId: 'other' } });
    expect(calls[0]?.args).toEqual({
      where: { AND: [{ entityId: 'other' }, { entityId: ENTITY }] },
    });
  });

  it('stamps the entity on create and rejects a different one', async () => {
    const { delegate, calls } = fakeDelegate();
    const repo = scopedRepo(delegate, ENTITY);
    await repo.create({ data: { name: 'API' } });
    expect(calls[0]?.args).toEqual({ data: { name: 'API', entityId: ENTITY } });
    expect(() => repo.create({ data: { name: 'API', entityId: 'other' } })).toThrow(
      EntityScopeError,
    );
  });

  it('scopes updates and forbids moving rows to another entity', async () => {
    const { delegate, calls } = fakeDelegate();
    const repo = scopedRepo(delegate, ENTITY);
    await repo.updateMany({ where: { id: 'x' }, data: { status: 'published' } });
    expect(calls[0]?.args).toEqual({
      where: { AND: [{ id: 'x' }, { entityId: ENTITY }] },
      data: { status: 'published' },
    });
    expect(() => repo.updateMany({ where: {}, data: { entityId: ENTITY } })).toThrow(
      EntityScopeError,
    );
  });

  it('requires an entity id', () => {
    expect(() => scopedRepo(fakeDelegate().delegate, '')).toThrow(EntityScopeError);
  });
});
