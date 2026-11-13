import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db";
import { claimJob, completeJob, enqueueJob, failJob } from "../src/queue";

/**
 * 任务队列的集成测试：真 PostgreSQL。
 *
 * 重点不是"能不能领取"，而是"并发时会不会重复领取"和"worker 崩了能不能恢复"。
 */

const past = (seconds: number): Date => new Date(Date.now() - seconds * 1000);

beforeEach(async () => {
  await prisma.job.deleteMany({});
});

afterAll(async () => {
  await prisma.job.deleteMany({});
  await prisma.$disconnect();
});

describe("claimJob", () => {
  it("并发领取时每个任务只会被一个 worker 拿到", async () => {
    await enqueueJob("a", { runAt: past(60) });
    await enqueueJob("b", { runAt: past(60) });
    await enqueueJob("c", { runAt: past(60) });

    const claims = await Promise.all([
      claimJob("w1"),
      claimJob("w2"),
      claimJob("w3"),
      claimJob("w4"),
    ]);

    const claimed = claims.filter((claim): claim is NonNullable<typeof claim> => claim !== null);

    // 3 个任务只能被领 3 次；并发下 null 落在哪一次是不确定的，不能断言下标
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((claim) => claim.id)).size).toBe(3);
    expect(claims.filter((claim) => claim === null)).toHaveLength(1);

    // 每个任务恰好被领取一次
    for (const claim of claimed) {
      expect(claim.attempts).toBe(1);
    }
  });

  it("未到时间的任务不会被领取", async () => {
    await enqueueJob("later", { runAt: new Date(Date.now() + 60_000) });
    expect(await claimJob("w1")).toBeNull();
  });

  it("租约过期后任务可被其他 worker 重新领取，并累计尝试次数", async () => {
    const id = await enqueueJob("stuck", { runAt: past(60) });

    const first = await claimJob("w1", { leaseSeconds: -10 });
    expect(first?.id).toBe(id);
    expect(first?.attempts).toBe(1);

    // 模拟 w1 崩溃：没有调用完成/失败，锁已过期
    const second = await claimJob("w2");
    expect(second?.id).toBe(id);
    expect(second?.attempts).toBe(2);
  });
});

describe("completeJob / failJob", () => {
  it("完成后状态为 SUCCEEDED", async () => {
    await enqueueJob("done", { runAt: past(60) });
    const claimed = await claimJob("w1");
    expect(claimed).not.toBeNull();

    await completeJob(claimed!.id);
    const row = await prisma.job.findUniqueOrThrow({ where: { id: claimed!.id } });
    expect(row.state).toBe("SUCCEEDED");
    expect(row.lockedUntil).toBeNull();
  });

  it("未达上限时退避重试，达上限后终态失败", async () => {
    const id = await enqueueJob("flaky", { runAt: past(60) });
    const now = new Date();

    const c1 = await claimJob("w1", { now });
    expect(c1?.attempts).toBe(1);

    const r1 = await failJob(id, "第一次失败", {
      now,
      maxAttempts: 2,
      retryDelaySeconds: 0,
    });
    expect(r1).toBe("retry");

    const afterRetry = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(afterRetry.state).toBe("PENDING");
    expect(afterRetry.lastError).toBe("第一次失败");

    const later = new Date(now.getTime() + 1000);
    const c2 = await claimJob("w2", { now: later });
    expect(c2?.attempts).toBe(2);

    const r2 = await failJob(id, "第二次失败", {
      now: later,
      maxAttempts: 2,
      retryDelaySeconds: 0,
    });
    expect(r2).toBe("failed");

    const final = await prisma.job.findUniqueOrThrow({ where: { id } });
    expect(final.state).toBe("FAILED");
    expect(final.lastError).toBe("第二次失败");
  });
});
