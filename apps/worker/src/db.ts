import { PrismaClient } from "@life/db";

/**
 * worker 是独立进程，不复用 Next 的单例。
 */
const globalForPrisma = globalThis as unknown as { lifeWorkerPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.lifeWorkerPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.lifeWorkerPrisma = prisma;
}
