import { ConflictError } from '../../common/errors.js';
import type { PrismaService, Tx } from '../../prisma/prisma.service.js';

/**
 * A suspended or offboarded entity publishes nothing new and asks for no new access (SPEC.md
 * §4.1 step 4, M2-11): 409 for those actions.
 */
export async function assertEntityActive(
  prisma: PrismaService | Tx,
  entityId: string,
): Promise<void> {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { status: true },
  });
  if (entity && entity.status !== 'active') {
    throw new ConflictError(`The entity is ${entity.status}: it cannot do this now`);
  }
}
