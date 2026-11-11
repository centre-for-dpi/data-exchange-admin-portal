import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../generated/prisma/client.js';

/** Client handed to code running inside `prisma.$transaction(async (tx) => ...)`. */
export type Tx = Prisma.TransactionClient;

/**
 * Prisma client for the runtime role (DATABASE_URL = rid_app: no DDL, append-only audit).
 * Migrations use DATABASE_MIGRATION_URL through prisma.config.ts, never this client.
 * Connects lazily on the first query.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
