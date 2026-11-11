/**
 * Multi-entity guard (CLAUDE.md, "Multi-entidad"): every domain query on an entity-owned table goes
 * through this helper, which forces `entityId` into the filter. Operations that address a row
 * only by its primary key (findUnique, update, delete) are deliberately not exposed: they would
 * bypass the entity filter. Use findFirst / updateMany with the id inside `where` instead.
 */

type AnyArgs = { where?: unknown; data?: unknown } & Record<string, unknown>;

/** Structural view of a Prisma model delegate (e.g. prisma.api) for a table with `entityId`. */
export interface ScopableDelegate {
  findMany(args?: never): Promise<unknown>;
  findFirst(args?: never): Promise<unknown>;
  count(args?: never): Promise<number>;
  create(args: never): Promise<unknown>;
  updateMany(args: never): Promise<unknown>;
}

type ArgsOf<F> = F extends (args: infer A) => unknown ? NonNullable<A> : never;
type ResultOf<F> = F extends (...args: never[]) => infer R ? R : never;

export class EntityScopeError extends Error {}

const scopeWhere = (where: unknown, entityId: string) =>
  where === undefined ? { entityId } : { AND: [where, { entityId }] };

function assertNoEntityChange(data: unknown, entityId: string, allowSame: boolean): void {
  if (data === null || typeof data !== 'object' || !('entityId' in data)) return;
  const value = (data as { entityId?: unknown }).entityId;
  if (!allowSame || value !== entityId) {
    throw new EntityScopeError('entityId cannot be set or changed through a scoped repository');
  }
}

export function scopedRepo<D extends ScopableDelegate>(delegate: D, entityId: string) {
  if (!entityId) throw new EntityScopeError('scopedRepo requires an entityId');
  const call = <K extends keyof ScopableDelegate>(method: K, args: AnyArgs) =>
    (delegate[method] as (a: AnyArgs) => ResultOf<D[K]>)(args);

  return {
    entityId,
    findMany: (args: ArgsOf<D['findMany']> = {} as ArgsOf<D['findMany']>) => {
      const a = args as AnyArgs;
      return call('findMany', { ...a, where: scopeWhere(a.where, entityId) });
    },
    findFirst: (args: ArgsOf<D['findFirst']> = {} as ArgsOf<D['findFirst']>) => {
      const a = args as AnyArgs;
      return call('findFirst', { ...a, where: scopeWhere(a.where, entityId) });
    },
    count: (args: ArgsOf<D['count']> = {} as ArgsOf<D['count']>) => {
      const a = args as AnyArgs;
      return call('count', { ...a, where: scopeWhere(a.where, entityId) });
    },
    create: (args: ArgsOf<D['create']>) => {
      const a = args as AnyArgs;
      assertNoEntityChange(a.data, entityId, true);
      return call('create', { ...a, data: { ...(a.data as object), entityId } });
    },
    updateMany: (args: ArgsOf<D['updateMany']>) => {
      const a = args as AnyArgs;
      assertNoEntityChange(a.data, entityId, false);
      return call('updateMany', { ...a, where: scopeWhere(a.where, entityId) });
    },
  };
}
