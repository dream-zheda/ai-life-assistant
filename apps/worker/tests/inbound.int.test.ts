import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { handleInboundMessage, NO_TARGET_REPLY } from "../src/inbound";
import { prisma } from "../src/db";

/**
 * 入站回复的集成测试：真数据库。
 *
 * 验证的是「用户回复 → 进度落库 → 给出确认」这条回路，
 * 也就是提醒消息里那句「回复 1 完成」到底有没有用。
 */

const NOW = new Date("2026-11-03T10:35:00+08:00");
const TZ = "Asia/Shanghai";
const LOCAL_DATE = "2026-11-03";
const ALICE = "int-inbound-alice";
const BOB = "int-inbound-bob";

async function seed(userId: string, options: { withSentReminder: boolean }): Promise<{
  firstItemId: string;
  secondItemId: string;
}> {
  await prisma.user.create({
    data: { id: userId, email: `${userId}@example.com`, timeZone: TZ },
  });

  const plan = await prisma.planVersion.create({
    data: { userId, localDate: LOCAL_DATE, timeZone: TZ, version: 1, state: "ACTIVE" },
  });

  const first = await prisma.planItem.create({
    data: {
      userId,
      planVersionId: plan.id,
      title: "背单词",
      startsAt: new Date("2026-11-03T10:30:00+08:00"),
      endsAt: new Date("2026-11-03T11:00:00+08:00"),
      minutes: 30,
    },
  });

  const second = await prisma.planItem.create({
    data: {
      userId,
      planVersionId: plan.id,
      title: "运动",
      startsAt: new Date("2026-11-03T16:00:00+08:00"),
      endsAt: new Date("2026-11-03T16:30:00+08:00"),
      minutes: 30,
    },
  });

  if (options.withSentReminder) {
    await prisma.notification.create({
      data: {
        userId,
        planVersionId: plan.id,
        planItemId: first.id,
        kind: "START",
        dedupeKey: `START:${first.id}`,
        content: "10 分钟后开始",
        scheduledAt: new Date("2026-11-03T10:20:00+08:00"),
        state: "SENT",
      },
    });
  }

  return { firstItemId: first.id, secondItemId: second.id };
}

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
  await prisma.$disconnect();
});

describe("handleInboundMessage", () => {
  it("回复「1」把刚提醒过的那一项标记完成", async () => {
    const { firstItemId } = await seed(ALICE, { withSentReminder: true });

    const result = await handleInboundMessage({ userId: ALICE, text: "1", now: NOW });

    expect(result.action).toBe("progress");
    expect(result.planItemId).toBe(firstItemId);
    expect(result.reply).toContain("背单词");
    expect(result.reply).toContain("已完成");

    const event = await prisma.progressEvent.findFirstOrThrow({
      where: { planItemId: firstItemId },
    });
    expect(event.state).toBe("DONE");
    expect(event.ratio).toBe(1);
  });

  it("回复「2」记录为部分完成", async () => {
    const { firstItemId } = await seed(ALICE, { withSentReminder: true });

    await handleInboundMessage({ userId: ALICE, text: "2", now: NOW });

    const event = await prisma.progressEvent.findFirstOrThrow({
      where: { planItemId: firstItemId },
    });
    expect(event.state).toBe("PARTIALLY_DONE");
    expect(event.ratio).toBe(0.5);
  });

  it("回复「跳过」记录为 SKIPPED 而不是 0% 完成", async () => {
    const { firstItemId } = await seed(ALICE, { withSentReminder: true });

    await handleInboundMessage({ userId: ALICE, text: "跳过", now: NOW });

    const event = await prisma.progressEvent.findFirstOrThrow({
      where: { planItemId: firstItemId },
    });
    expect(event.state).toBe("SKIPPED");
  });

  it("「完成 2」按当天顺序命中第 2 项", async () => {
    const { secondItemId } = await seed(ALICE, { withSentReminder: false });

    const result = await handleInboundMessage({ userId: ALICE, text: "完成 2", now: NOW });

    expect(result.action).toBe("progress");
    expect(result.planItemId).toBe(secondItemId);
    expect(result.reply).toContain("运动");
  });

  it("已完成后再回复完成不会重复记一条", async () => {
    const { firstItemId } = await seed(ALICE, { withSentReminder: true });

    await handleInboundMessage({ userId: ALICE, text: "1", now: NOW });
    const again = await handleInboundMessage({ userId: ALICE, text: "1", now: NOW });

    expect(again.action).toBe("duplicate");
    expect(again.reply).toContain("已经记过完成");

    const events = await prisma.progressEvent.count({ where: { planItemId: firstItemId } });
    expect(events).toBe(1);
  });

  it("没有近期提醒时裸数字无法定位，给出可操作提示而不是静默", async () => {
    await seed(ALICE, { withSentReminder: false });

    const result = await handleInboundMessage({ userId: ALICE, text: "1", now: NOW });

    expect(result.action).toBe("no_target");
    expect(result.reply).toBe(NO_TARGET_REPLY);
  });

  it("「帮助」返回可用指令", async () => {
    await seed(ALICE, { withSentReminder: false });

    const result = await handleInboundMessage({ userId: ALICE, text: "帮助", now: NOW });

    expect(result.action).toBe("help");
    expect(result.reply).toContain("回复 1 / 2 / 3");
  });

  it("自由文本不当作指令，交给后续对话处理", async () => {
    await seed(ALICE, { withSentReminder: false });

    const result = await handleInboundMessage({
      userId: ALICE,
      text: "今天下午要加班",
      now: NOW,
    });

    expect(result.action).toBe("unknown");
    expect(result.reply).toBeNull();
  });

  it("只能改自己的条目：B 的回复不影响 A", async () => {
    const alice = await seed(ALICE, { withSentReminder: true });
    const bob = await seed(BOB, { withSentReminder: true });

    await handleInboundMessage({ userId: BOB, text: "完成 1", now: NOW });

    const aliceEvents = await prisma.progressEvent.count({
      where: { planItemId: alice.firstItemId },
    });
    const bobEvents = await prisma.progressEvent.count({ where: { planItemId: bob.firstItemId } });

    expect(aliceEvents).toBe(0);
    expect(bobEvents).toBe(1);
  });
});
