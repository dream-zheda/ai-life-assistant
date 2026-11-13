import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMockAdapter, type ModelRef } from "@life/llm";

import { prisma } from "../src/server/db";
import { generateTodayPlan } from "../src/server/planning";

/**
 * 集成测试：真数据库、真 Prisma、真领域校验，只有模型是假的。
 *
 * 验证的是「生成 → 校验 → 落库」这条链路，而不是页面渲染。
 * 时钟固定为 2026-11-03T08:00+08:00（周二），避免用例随真实日期漂移。
 */

const USER = "int-planning-user";
const TZ = "Asia/Shanghai";
const NOW = new Date("2026-11-03T08:00:00+08:00");
const REF: ModelRef = { providerId: "mock", modelId: "int-test" };

function planJson(items: Array<{ title: string; startAt: string; endAt: string }>): string {
  return JSON.stringify({
    localDate: "2026-11-03",
    timezone: TZ,
    items: items.map((item) => ({ ...item, reason: "集成测试" })),
    assumptions: [],
    unresolvedQuestions: [],
  });
}

const adapterFor = (json: string) => createMockAdapter({ respond: () => json });

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.user.create({
    data: { id: USER, email: "int-planning@example.com", timeZone: TZ },
  });
  await prisma.fixedConstraint.create({
    data: {
      userId: USER,
      kind: "WEEKLY",
      title: "高数课",
      weekday: 2,
      startTime: "08:30",
      endTime: "10:00",
      timeZone: TZ,
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("generateTodayPlan", () => {
  it("计划与固定安排冲突时不写入任何版本", async () => {
    const adapter = adapterFor(
      planJson([
        {
          title: "背单词",
          startAt: "2026-11-03T09:00:00+08:00",
          endAt: "2026-11-03T09:30:00+08:00",
        },
      ]),
    );

    const result = await generateTodayPlan(USER, TZ, {
      now: NOW,
      adapter,
      ref: REF,
      mode: "mock",
    });

    expect(result.ok).toBe(false);
    expect(result.planVersionId).toBeNull();

    const count = await prisma.planVersion.count({ where: { userId: USER } });
    expect(count).toBe(0);
  });

  it("合法计划写入 DRAFT 版本与条目，时间按绝对时刻保存", async () => {
    const adapter = adapterFor(
      planJson([
        {
          title: "背单词",
          startAt: "2026-11-03T10:30:00+08:00",
          endAt: "2026-11-03T11:00:00+08:00",
        },
      ]),
    );

    const result = await generateTodayPlan(USER, TZ, {
      now: NOW,
      adapter,
      ref: REF,
      mode: "mock",
    });

    expect(result.ok).toBe(true);
    expect(result.itemCount).toBe(1);
    expect(result.planVersionId).not.toBeNull();

    const version = await prisma.planVersion.findFirstOrThrow({
      where: { userId: USER, localDate: "2026-11-03" },
      include: { items: true },
    });

    expect(version.state).toBe("DRAFT");
    expect(version.items).toHaveLength(1);

    const item = version.items[0];
    expect(item?.title).toBe("背单词");
    expect(item?.minutes).toBe(30);
    expect(item?.startsAt.toISOString()).toBe("2026-11-03T02:30:00.000Z");
  });

  it("同一份计划重复生成会产生新的版本号，而不是覆盖旧版本", async () => {
    const adapter = adapterFor(
      planJson([
        {
          title: "运动",
          startAt: "2026-11-03T16:00:00+08:00",
          endAt: "2026-11-03T16:30:00+08:00",
        },
      ]),
    );

    const second = await generateTodayPlan(USER, TZ, {
      now: NOW,
      adapter,
      ref: REF,
      mode: "mock",
    });

    expect(second.ok).toBe(true);
    const versions = await prisma.planVersion.findMany({
      where: { userId: USER, localDate: "2026-11-03" },
      orderBy: { version: "asc" },
      select: { version: true },
    });

    expect(versions.map((row) => row.version)).toEqual([1, 2]);
  });

  it("两个真实用户的计划互不可见", async () => {
    const other = "int-other-user";
    await prisma.user.deleteMany({ where: { id: other } });
    await prisma.user.create({
      data: { id: other, email: "int-other@example.com", timeZone: TZ },
    });

    const adapter = adapterFor(
      planJson([
        {
          title: "别人的安排",
          startAt: "2026-11-03T20:00:00+08:00",
          endAt: "2026-11-03T20:30:00+08:00",
        },
      ]),
    );

    const forOther = await generateTodayPlan(other, TZ, {
      now: NOW,
      adapter,
      ref: REF,
      mode: "mock",
    });
    expect(forOther.ok).toBe(true);

    const mine = await prisma.planVersion.findMany({ where: { userId: USER } });
    const theirs = await prisma.planVersion.findMany({ where: { userId: other } });

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs).toHaveLength(1);
    expect(mine.every((row) => row.userId === USER)).toBe(true);
    expect(theirs[0]?.userId).toBe(other);

    await prisma.user.delete({ where: { id: other } });
  });
});
