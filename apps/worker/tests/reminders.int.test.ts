import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { CHANNEL_POLICIES } from "@life/channels";

import { createConsoleAdapter } from "../src/channels/console";
import { prisma } from "../src/db";
import {
  dispatchDueNotifications,
  enqueueMorningBriefs,
  enqueueStartReminders,
} from "../src/reminders";

/**
 * 提醒链路的集成测试：真数据库 + 控制台通道。
 *
 * 能证明：去重、窗口判断、派发顺序、计划失效后作废旧提醒。
 * 不能证明：微信真的能收到（那要 P4 用真实账号实测）。
 */

const NOW = new Date("2026-11-03T08:00:00+08:00");
const LOCAL_DATE = "2026-11-03";
const ALICE = "int-reminder-alice";
const BOB = "int-reminder-bob";

function adapter() {
  return createConsoleAdapter({ policy: CHANNEL_POLICIES["personal-wechat"] });
}

async function seedUser(userId: string, options: { lastInboundHoursAgo: number }): Promise<void> {
  await prisma.user.create({
    data: { id: userId, email: `${userId}@example.com`, timeZone: "Asia/Shanghai" },
  });

  const plan = await prisma.planVersion.create({
    data: {
      userId,
      localDate: LOCAL_DATE,
      timeZone: "Asia/Shanghai",
      version: 1,
      state: "ACTIVE",
    },
  });

  // 5 分钟后开始，落在 10 分钟的提醒窗口内
  const startsAt = new Date(NOW.getTime() + 5 * 60_000);
  const endsAt = new Date(NOW.getTime() + 35 * 60_000);

  await prisma.planItem.create({
    data: {
      userId,
      planVersionId: plan.id,
      title: "背单词",
      startsAt,
      endsAt,
      minutes: 30,
      reason: "测试",
    },
  });

  await prisma.channelBinding.create({
    data: {
      userId,
      channel: "PERSONAL_WECHAT",
      externalUserId: `wx-${userId}`,
      lastInboundAt: new Date(NOW.getTime() - options.lastInboundHoursAgo * 60 * 60 * 1000),
    },
  });
}

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
  await prisma.$disconnect();
});

describe("enqueueStartReminders", () => {
  it("支持设置页允许的 120 分钟提前量", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await prisma.userSettings.create({ data: { userId: ALICE, reminderLeadMinutes: 120 } });
    await prisma.planItem.updateMany({
      where: { userId: ALICE },
      data: {
        startsAt: new Date(NOW.getTime() + 110 * 60_000),
        endsAt: new Date(NOW.getTime() + 140 * 60_000),
      },
    });
    expect(await enqueueStartReminders(NOW)).toBe(1);
  });
  it("已提前完成的行动不再生成开始提醒", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    const item = await prisma.planItem.findFirstOrThrow({ where: { userId: ALICE } });
    await prisma.progressEvent.create({
      data: { userId: ALICE, planItemId: item.id, state: "DONE", ratio: 1 },
    });
    expect(await enqueueStartReminders(NOW)).toBe(0);
  });
  it("提醒排队后完成行动，派发前取消提醒", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await enqueueStartReminders(NOW);
    const item = await prisma.planItem.findFirstOrThrow({ where: { userId: ALICE } });
    await prisma.progressEvent.create({
      data: { userId: ALICE, planItemId: item.id, state: "DONE", ratio: 1 },
    });
    const result = await dispatchDueNotifications({ now: NOW, adapter: adapter() });
    expect(result.cancelled).toBe(1);
    expect(result.sent).toBe(0);
  });
  it("只对生效计划里即将开始的条目生成提醒，且重复扫描不会重复生成", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });

    const first = await enqueueStartReminders(NOW);
    expect(first).toBe(1);

    const second = await enqueueStartReminders(NOW);
    expect(second).toBe(0);

    const rows = await prisma.notification.findMany({ where: { userId: ALICE } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("START");
  });

  it("计划不是 ACTIVE 时不生成提醒", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await prisma.planVersion.updateMany({
      where: { userId: ALICE },
      data: { state: "DRAFT" },
    });

    expect(await enqueueStartReminders(NOW)).toBe(0);
  });
});

describe("enqueueMorningBriefs", () => {
  const at = (hour: number, minute: number): Date =>
    new Date(
      `2026-11-03T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`,
    );

  it("在用户本地 7:00–7:30 生成早报，内容包含当天安排", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });

    const created = await enqueueMorningBriefs(at(7, 10));
    expect(created).toBe(1);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: ALICE, kind: "MORNING" },
    });
    expect(notification.content).toContain("今天");
    expect(notification.content).toContain("背单词");
    expect(notification.content).toContain("回复「完成 2」");
  });

  it("不在早报窗口内不生成", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    expect(await enqueueMorningBriefs(at(9, 0))).toBe(0);
  });

  it("同一个计划版本只发一次早报", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });

    expect(await enqueueMorningBriefs(at(7, 5))).toBe(1);
    expect(await enqueueMorningBriefs(at(7, 10))).toBe(0);

    expect(await prisma.notification.count({ where: { userId: ALICE, kind: "MORNING" } })).toBe(1);
  });

  it("当天没有 ACTIVE 计划时不生成早报", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await prisma.planVersion.updateMany({ where: { userId: ALICE }, data: { state: "DRAFT" } });

    expect(await enqueueMorningBriefs(at(7, 10))).toBe(0);
  });
});

describe("dispatchDueNotifications", () => {
  it("窗口内正常发送，并记录发送尝试", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.sent).toBe(1);

    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: ALICE } });
    expect(notification.state).toBe("SENT");

    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(attempt.outcome).toBe("accepted");

    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.text).toContain("背单词");
  });

  it("超出 24 小时窗口时不发送，标记为需要降级", async () => {
    await seedUser(BOB, { lastInboundHoursAgo: 30 });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.fallback).toBe(1);
    expect(channel.sent).toHaveLength(0);

    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: BOB } });
    expect(notification.state).toBe("FALLBACK_REQUIRED");

    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(attempt.outcome).toBe("fallback");
    expect(attempt.code).toBe("window_expired");
  });

  it("计划被替代后，旧提醒作废而不是照发", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await enqueueStartReminders(NOW);

    // 模拟重排：旧版本被新版本替代
    await prisma.planVersion.updateMany({
      where: { userId: ALICE },
      data: { state: "SUPERSEDED" },
    });

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.cancelled).toBe(1);
    expect(channel.sent).toHaveLength(0);

    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: ALICE } });
    expect(notification.state).toBe("CANCELLED");
  });

  it("用户没有绑定通道时标记为需要降级", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await prisma.channelBinding.deleteMany({ where: { userId: ALICE } });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.fallback).toBe(1);
    expect(channel.sent).toHaveLength(0);
  });
});

describe("提醒抑制：暂停 / 免打扰 / 每日上限", () => {
  async function setSettings(
    userId: string,
    data: {
      paused?: boolean;
      quietHoursStart?: string | null;
      quietHoursEnd?: string | null;
      maxPerDay?: number;
    },
  ): Promise<void> {
    await prisma.userSettings.create({
      data: {
        userId,
        remindersPaused: data.paused ?? false,
        quietHoursStart: data.quietHoursStart ?? null,
        quietHoursEnd: data.quietHoursEnd ?? null,
        maxRemindersPerDay: data.maxPerDay ?? 8,
      },
    });
  }

  it("暂停时一条都不发，并记录原因", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await setSettings(ALICE, { paused: true });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.sent).toBe(0);
    expect(outcome.suppressed).toBe(1);
    expect(channel.sent).toHaveLength(0);

    const notification = await prisma.notification.findFirstOrThrow({ where: { userId: ALICE } });
    expect(notification.state).toBe("CANCELLED");

    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notificationId: notification.id },
    });
    expect(attempt.outcome).toBe("blocked");
    expect(attempt.code).toBe("paused");
  });

  it("免打扰时段内不发（08:00 落在 07:00–09:00）", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await setSettings(ALICE, { quietHoursStart: "07:00", quietHoursEnd: "09:00" });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.suppressed).toBe(1);
    expect(channel.sent).toHaveLength(0);

    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notification: { userId: ALICE } },
    });
    expect(attempt.code).toBe("quiet_hours");
  });

  it("免打扰之外的时间照常发送", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await setSettings(ALICE, { quietHoursStart: "22:00", quietHoursEnd: "07:00" });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.sent).toBe(1);
    expect(channel.sent).toHaveLength(1);
  });

  it("达到每日上限后不再发送", async () => {
    await seedUser(ALICE, { lastInboundHoursAgo: 1 });
    await setSettings(ALICE, { maxPerDay: 0 });
    await enqueueStartReminders(NOW);

    const channel = adapter();
    const outcome = await dispatchDueNotifications({ now: NOW, adapter: channel });

    expect(outcome.suppressed).toBe(1);
    expect(channel.sent).toHaveLength(0);

    const attempt = await prisma.notificationAttempt.findFirstOrThrow({
      where: { notification: { userId: ALICE } },
    });
    expect(attempt.code).toBe("daily_limit");
  });
});
