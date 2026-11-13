import { PrismaClient } from "@life/db";

/**
 * Prisma 单例。
 *
 * Next 的开发模式会热重载模块，若每次都 new PrismaClient() 会耗尽连接池，
 * 因此挂到 globalThis 上复用。
 */
const globalForPrisma = globalThis as unknown as { lifePrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.lifePrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.lifePrisma = prisma;
}
