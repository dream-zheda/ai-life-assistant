import { prisma } from "./db";

/**
 * PostgreSQL 任务队列。
 *
 * 规划书 §8 要求"第一版不引入 Redis，用 PostgreSQL 的任务表 + 事务 + 锁领取"。
 * 关键点：领取必须是**一条语句**，用 `FOR UPDATE SKIP LOCKED` 让并发的 worker
 * 各自拿到不同的任务，而不是"先查后改"（那会重复领取）。
 *
 * 租约（lease）解决 worker 崩溃：进程死在任务上时没人调用完成/失败，
 * 锁到期后任务会被其他 worker 重新领取。
 */

export type ClaimedJob = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
};

type ClaimedRow = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
};

export type ClaimOptions = {
  /** 租约秒数。超过后任务可被其他 worker 重新领取。 */
  leaseSeconds?: number;
  /** 注入用（测试），默认取真实时间。 */
  now?: Date;
};

export async function claimJob(
  workerId: string,
  options: ClaimOptions = {},
): Promise<ClaimedJob | null> {
  const leaseSeconds = options.leaseSeconds ?? 60;
  const now = options.now ?? new Date();
  const lockedUntil = new Date(now.getTime() + leaseSeconds * 1000);

  // ⚠️ 时区陷阱（见 ADR-005）：
  // Prisma 把 DateTime 存成 `timestamp(3)`（无时区）且按 UTC 写入；
  // 而 $queryRaw 里的 Date 参数会被绑定成 `timestamptz`，PG 与 timestamp 比较时
  // 会按会话时区（这里 +08）换算，导致「1 分钟后的任务」被误判成「8 小时前」。
  // 所以原生 SQL 里必须显式 `AT TIME ZONE 'UTC'`，把参数拉回 UTC 墙上时间。
  const nowParam = now.toISOString();
  const lockedUntilParam = lockedUntil.toISOString();

  // 用 $queryRaw 而不是 ORM：SKIP LOCKED 是行锁语义，Prisma 的查询构造器表达不了。
  //
  // 用 `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)` 而不是
  // `WHERE id = (SELECT ...)`：后者在并发下出现过同一行被两个 worker 同时领取的情况。
  // 前者是 PostgreSQL 官方推荐的队列模式，锁在子查询里拿到、外层直接按 id 更新。
  //
  // 参数只放值，`::timestamptz AT TIME ZONE 'UTC'` 必须留在 SQL 文本里。
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "jobs" AS j
       SET "state" = 'RUNNING',
           "lockedUntil" = (${lockedUntilParam}::timestamptz AT TIME ZONE 'UTC'),
           "lockedBy" = ${workerId},
           "attempts" = j."attempts" + 1,
           "updatedAt" = (${nowParam}::timestamptz AT TIME ZONE 'UTC')
      FROM (
        SELECT "id" FROM "jobs"
         WHERE ("state" = 'PENDING' AND "runAt" <= (${nowParam}::timestamptz AT TIME ZONE 'UTC'))
            OR ("state" = 'RUNNING' AND "lockedUntil" < (${nowParam}::timestamptz AT TIME ZONE 'UTC'))
         ORDER BY "runAt"
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      ) AS picked
     WHERE j."id" = picked."id"
    RETURNING j."id", j."type", j."payload", j."attempts"
  `;

  return rows[0] ?? null;
}

export async function completeJob(jobId: string, now: Date = new Date()): Promise<void> {
  await prisma.job.update({
    where: { id: jobId },
    data: { state: "SUCCEEDED", lockedUntil: null, lockedBy: null, updatedAt: now },
  });
}

export type FailOptions = {
  maxAttempts?: number;
  retryDelaySeconds?: number;
  now?: Date;
};

/**
 * 失败处理：未达上限则退避重试，达到上限则终态失败。
 *
 * 注意 attempts 是在领取时 +1 的，所以这里读到的是"本次已包含在内"的次数。
 */
export async function failJob(
  jobId: string,
  error: string,
  options: FailOptions = {},
): Promise<"retry" | "failed"> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? 3;
  const retryDelaySeconds = options.retryDelaySeconds ?? 30;

  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { attempts: true },
  });
  if (job === null) return "failed";

  const canRetry = job.attempts < maxAttempts;

  await prisma.job.update({
    where: { id: jobId },
    data: {
      state: canRetry ? "PENDING" : "FAILED",
      lastError: error.slice(0, 500),
      lockedUntil: null,
      lockedBy: null,
      updatedAt: now,
      ...(canRetry ? { runAt: new Date(now.getTime() + retryDelaySeconds * 1000) } : {}),
    },
  });

  return canRetry ? "retry" : "failed";
}

export type EnqueueOptions = {
  runAt?: Date;
  payload?: unknown;
};

export async function enqueueJob(
  type: string,
  options: EnqueueOptions = {},
): Promise<string> {
  const job = await prisma.job.create({
    data: {
      type,
      payload: (options.payload ?? {}) as never,
      runAt: options.runAt ?? new Date(),
    },
    select: { id: true },
  });
  return job.id;
}
