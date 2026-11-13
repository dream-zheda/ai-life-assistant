import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/server/db";
import { listTodayNotifications } from "../src/server/inbox";

/**
 * 今日提醒（站内信）的集成测试。
 *
 * 重点：只看到自己的、只看到今天的、状态映射正确（尤其"未送达"不能被说成"已推送"）。
 */

const USER = "int-inbox-user";
const OTHER = "int-inbox-other";
const TZ = "Asia/Shanghai";
const NOW = new Date("2026-11-03T20:00:00+08:00");

async function seed(userId: string, rows: Array<{ scheduledAt: string; state: string }>) {
  // 每天只允许一个 ACTIVE 版本，所以先把旧的清掉（连带删除其提醒）
  await prisma.planVersion.deleteMany({ where: { userId } });

  const plan = await prisma.planVersion.create({
    data: { userId, localDate: "2026-11-03", timeZone: TZ, version: 1, state: "ACTIVE" },
  });

  for (const [index, row] of rows.entries()) {
    await prisma.notification.create({
      data: {
        userId,
        planVersionId: plan.id,
        kind: "START",
        dedupeKey: `${userId}-${index}`,
        content: `提醒 ${index}`,
        scheduledAt: new Date(row.scheduledAt),
        state: row.state as never,
      },
    });
  }
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.user.create({ data: { id: USER, email: "inbox@int.test", timeZone: TZ } });
  await prisma.user.create({ data: { id: OTHER, email: "inbox2@int.test", timeZone: TZ } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.$disconnect();
});

describe("listTodayNotifications", () => {
  it("只返回今天的提醒，按时间升序", async () => {
    await seed(USER, [
      { scheduledAt: "2026-11-03T15:00:00+08:00", state: "SCHEDULED" },
      { scheduledAt: "2026-11-03T09:00:00+08:00", state: "SENT" },
      // 昨天与明天都不该出现
      { scheduledAt: "2026-11-02T23:00:00+08:00", state: "SENT" },
      { scheduledAt: "2026-11-04T01:00:00+08:00", state: "SCHEDULED" },
    ]);

    const items = await listTodayNotifications({ userId: USER, timeZone: TZ, now: NOW });

    expect(items).toHaveLength(2);
    expect(items.map((item) => item.state)).toEqual(["SENT", "SCHEDULED"]);
  });

  it("不返回其他用户的提醒", async () => {
    await seed(OTHER, [{ scheduledAt: "2026-11-03T10:00:00+08:00", state: "SENT" }]);

    const items = await listTodayNotifications({ userId: USER, timeZone: TZ, now: NOW });
    expect(items.every((item) => item.content.startsWith("提醒"))).toBe(true);
    expect(items).toHaveLength(2);
  });

  it("状态映射：SENT 仅表示通道已接受，不宣称已送达", async () => {
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await seed(USER, [
      { scheduledAt: "2026-11-03T09:00:00+08:00", state: "SENT" },
      { scheduledAt: "2026-11-03T10:00:00+08:00", state: "FALLBACK_REQUIRED" },
      { scheduledAt: "2026-11-03T11:00:00+08:00", state: "FAILED" },
      { scheduledAt: "2026-11-03T12:00:00+08:00", state: "CANCELLED" },
    ]);

    const items = await listTodayNotifications({ userId: USER, timeZone: TZ, now: NOW });
    const byState = new Map(items.map((item) => [item.state, item]));

    expect(byState.get("SENT")?.delivered).toBe(true);
    expect(byState.get("SENT")?.stateLabel).toBe("通道已接受");
    expect(byState.get("FALLBACK_REQUIRED")?.delivered).toBe(false);
    expect(byState.get("FALLBACK_REQUIRED")?.stateLabel).toContain("站内可见");
    expect(byState.get("FAILED")?.delivered).toBe(false);
  });

  it("跨零点：本地 23:30 的提醒算今天", async () => {
    await prisma.notification.deleteMany({ where: { userId: USER } });
    await seed(USER, [{ scheduledAt: "2026-11-03T23:30:00+08:00", state: "SCHEDULED" }]);

    const items = await listTodayNotifications({ userId: USER, timeZone: TZ, now: NOW });
    expect(items).toHaveLength(1);
  });
});
