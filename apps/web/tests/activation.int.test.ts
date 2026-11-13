import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/server/db";
import { activatePlanVersion } from "../src/server/plan-activation";

/**
 * 计划采纳（DRAFT → ACTIVE）的集成测试。
 *
 * 这一步是**提醒能否发出的前提**：worker 只为 ACTIVE 计划生成提醒。
 * 之前缺了这一步，导致"生成计划成功但永远收不到提醒"——主链路是断的。
 */

const USER = "int-activate-user";
const OTHER = "int-activate-other";
const TZ = "Asia/Shanghai";
const LOCAL_DATE = "2026-11-03";
const NOW = new Date("2026-11-03T10:00:00+08:00");

async function seedPlan(options: {
  userId: string;
  version: number;
  items: Array<{ title: string; startAt: string; endAt: string }>;
  state?: "DRAFT" | "ACTIVE" | "SUPERSEDED";
}): Promise<string> {
  const plan = await prisma.planVersion.create({
    data: {
      userId: options.userId,
      localDate: LOCAL_DATE,
      timeZone: TZ,
      version: options.version,
      state: options.state ?? "DRAFT",
    },
  });

  for (const item of options.items) {
    const [startsAt, endsAt] = [new Date(item.startAt), new Date(item.endAt)];
    await prisma.planItem.create({
      data: {
        userId: options.userId,
        planVersionId: plan.id,
        title: item.title,
        startsAt,
        endsAt,
        minutes: Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000),
      },
    });
  }

  return plan.id;
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.user.create({ data: { id: USER, email: "activate@int.test", timeZone: TZ } });
  await prisma.user.create({ data: { id: OTHER, email: "other@int.test", timeZone: TZ } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.$disconnect();
});

describe("activatePlanVersion", () => {
  it("把草稿变成生效，并丢弃已经结束的条目", async () => {
    const planId = await seedPlan({
      userId: USER,
      version: 1,
      items: [
        { title: "已经过去的", startAt: "2026-11-03T08:00:00+08:00", endAt: "2026-11-03T08:30:00+08:00" },
        { title: "还没开始", startAt: "2026-11-03T11:00:00+08:00", endAt: "2026-11-03T11:30:00+08:00" },
      ],
    });

    const result = await activatePlanVersion({ userId: USER, planVersionId: planId, now: NOW });

    expect(result).toMatchObject({ ok: true, droppedCount: 1, itemCount: 1 });
    if (!result.ok) throw new Error("unreachable");

    const plan = await prisma.planVersion.findUniqueOrThrow({
      where: { id: planId },
      include: { items: true },
    });
    expect(plan.state).toBe("ACTIVE");
    expect(plan.activatedAt?.getTime()).toBe(NOW.getTime());
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.title).toBe("还没开始");
  });

  it("采纳新版本时，旧版本自动被替代（同一天只有一个 ACTIVE）", async () => {
    await prisma.user.deleteMany({ where: { id: USER } });
    await prisma.user.create({ data: { id: USER, email: "activate@int.test", timeZone: TZ } });

    const v1 = await seedPlan({
      userId: USER,
      version: 1,
      items: [{ title: "旧安排", startAt: "2026-11-03T11:00:00+08:00", endAt: "2026-11-03T11:30:00+08:00" }],
    });
    await activatePlanVersion({ userId: USER, planVersionId: v1, now: NOW });

    const v2 = await seedPlan({
      userId: USER,
      version: 2,
      items: [{ title: "新安排", startAt: "2026-11-03T14:00:00+08:00", endAt: "2026-11-03T14:30:00+08:00" }],
    });
    const result = await activatePlanVersion({ userId: USER, planVersionId: v2, now: NOW });
    expect(result.ok).toBe(true);

    const active = await prisma.planVersion.findMany({
      where: { userId: USER, state: "ACTIVE" },
    });
    expect(active).toHaveLength(1);
    expect(active[0]?.id).toBe(v2);

    const old = await prisma.planVersion.findUniqueOrThrow({ where: { id: v1 } });
    expect(old.state).toBe("SUPERSEDED");
    expect(old.supersededAt?.getTime()).toBe(NOW.getTime());
  });

  it("重复采纳同一版本返回 already_active", async () => {
    const plan = await prisma.planVersion.findFirstOrThrow({
      where: { userId: USER, state: "ACTIVE" },
    });

    expect(
      await activatePlanVersion({ userId: USER, planVersionId: plan.id, now: NOW }),
    ).toEqual({ ok: false, reason: "already_active" });
  });

  it("不能采纳别人的计划", async () => {
    const otherPlan = await seedPlan({
      userId: OTHER,
      version: 1,
      items: [{ title: "别人的", startAt: "2026-11-03T15:00:00+08:00", endAt: "2026-11-03T15:30:00+08:00" }],
    });

    expect(
      await activatePlanVersion({ userId: USER, planVersionId: otherPlan, now: NOW }),
    ).toEqual({ ok: false, reason: "not_found" });

    const plan = await prisma.planVersion.findUniqueOrThrow({ where: { id: otherPlan } });
    expect(plan.state).toBe("DRAFT");
  });

  it("条目全部过期时返回 expired（和空计划是两回事）", async () => {
    await prisma.user.deleteMany({ where: { id: OTHER } });
    await prisma.user.create({ data: { id: OTHER, email: "other@int.test", timeZone: TZ } });

    const expired = await seedPlan({
      userId: OTHER,
      version: 1,
      items: [{ title: "早就过去", startAt: "2026-11-03T07:00:00+08:00", endAt: "2026-11-03T07:30:00+08:00" }],
    });

    expect(
      await activatePlanVersion({ userId: OTHER, planVersionId: expired, now: NOW }),
    ).toEqual({ ok: false, reason: "expired" });

    const plan = await prisma.planVersion.findUniqueOrThrow({ where: { id: expired } });
    expect(plan.state).toBe("DRAFT");
  });

  it("一条安排都没有时返回 empty，不要谎称「都过去了」", async () => {
    await prisma.user.deleteMany({ where: { id: OTHER } });
    await prisma.user.create({ data: { id: OTHER, email: "other@int.test", timeZone: TZ } });

    const blank = await seedPlan({ userId: OTHER, version: 1, items: [] });

    expect(
      await activatePlanVersion({ userId: OTHER, planVersionId: blank, now: NOW }),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("已被替代的版本不能再被采纳", async () => {
    const superseded = await prisma.planVersion.findFirstOrThrow({
      where: { userId: USER, state: "SUPERSEDED" },
    });

    expect(
      await activatePlanVersion({ userId: USER, planVersionId: superseded.id, now: NOW }),
    ).toEqual({ ok: false, reason: "superseded" });
  });
});
