import { PrismaClient } from "../generated/client/index.js";
export { issueQqLinkCode, consumeQqLinkCode, unlinkQq, QqBindingError, qqIdValid } from "./qq-binding.js";

/**
 * 数据库入口。
 *
 * 注意：`packages/db/generated` 是 `prisma generate` 的产物，不进版本库。
 * 首次使用前必须先跑 `pnpm db:generate`，否则类型不存在。
 */

export type { Prisma } from "../generated/client/index.js";
// 枚举类型一并导出：调用方（worker / web）需要它们做类型安全的查询条件
export type {
  ActionState,
  ChannelKind,
  GoalState,
  JobState,
  NotificationState,
  PlanState,
} from "../generated/client/index.js";

export { PrismaClient };

export type DbOptions = {
  /** 允许测试注入独立的连接串，生产走 DATABASE_URL。 */
  datasourceUrl?: string;
};

export function createPrismaClient(options: DbOptions = {}): PrismaClient {
  return new PrismaClient(
    options.datasourceUrl === undefined
      ? undefined
      : { datasourceUrl: options.datasourceUrl },
  );
}

let singleton: PrismaClient | undefined;

/** 进程内单例，避免每个请求都新建连接池。 */
export function getPrismaClient(): PrismaClient {
  singleton ??= createPrismaClient();
  return singleton;
}

/**
 * 任务队列的领取语句约束（实现 worker 时使用）。
 *
 * 不能用「先查后改」，必须一条语句搞定，否则并发会重复领取：
 *
 *   UPDATE jobs SET state = 'RUNNING', "lockedUntil" = now() + interval '60 seconds',
 *                   "lockedBy" = $1, attempts = attempts + 1
 *   WHERE id = (
 *     SELECT id FROM jobs
 *     WHERE state = 'PENDING' AND "runAt" <= now()
 *        OR (state = 'RUNNING' AND "lockedUntil" < now())
 *     ORDER BY "runAt"
 *     FOR UPDATE SKIP LOCKED
 *     LIMIT 1
 *   )
 *   RETURNING *;
 *
 * Prisma 需用 $queryRaw 执行；这是规划书 §8「不引入 Redis」的前提。
 */
export const JOB_CLAIM_SQL_HINT = "FOR UPDATE SKIP LOCKED";
