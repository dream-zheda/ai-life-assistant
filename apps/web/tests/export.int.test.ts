import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/server/db";
import { exportUserData } from "../src/server/export";

/**
 * 数据导出的集成测试。
 *
 * 重点不是"能导出"，而是三条边界：
 * 1. 只导出自己的数据
 * 2. 绝不导出凭据（密码哈希 / 会话 token / OAuth 凭据）
 * 3. 计划、条目、进度这些关键结构完整
 */

const ALICE = "int-export-alice";
const BOB = "int-export-bob";
const TZ = "Asia/Shanghai";

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });

  // Alice：一份完整数据
  await prisma.user.create({ data: { id: ALICE, email: "alice@export.test", timeZone: TZ } });
  await prisma.profile.create({
    data: { userId: ALICE, rawInput: "我是大学生", version: 2 },
  });
  await prisma.userSettings.create({
    data: { userId: ALICE, briefStartTime: "07:30", remindersPaused: true },
  });
  await prisma.goal.create({
    data: { userId: ALICE, title: "提高英语听力", priority: 1 },
  });
  await prisma.fixedConstraint.create({
    data: {
      userId: ALICE,
      kind: "WEEKLY",
      title: "高数课",
      weekday: 2,
      startTime: "08:30",
      endTime: "10:00",
      timeZone: TZ,
    },
  });

  const plan = await prisma.planVersion.create({
    data: { userId: ALICE, localDate: "2026-11-03", timeZone: TZ, version: 1, state: "ACTIVE" },
  });
  const item = await prisma.planItem.create({
    data: {
      userId: ALICE,
      planVersionId: plan.id,
      title: "背单词",
      startsAt: new Date("2026-11-03T10:30:00+08:00"),
      endsAt: new Date("2026-11-03T11:00:00+08:00"),
      minutes: 30,
    },
  });
  await prisma.progressEvent.create({
    data: { userId: ALICE, planItemId: item.id, state: "PARTIALLY_DONE", ratio: 0.5 },
  });
  await prisma.memory.create({
    data: { userId: ALICE, content: "最近在减脂", source: "user" },
  });
  const conversation = await prisma.conversation.create({ data: { userId: ALICE } });
  await prisma.message.create({
    data: { conversationId: conversation.id, direction: "INBOUND", text: "今天下午要加班" },
  });
  await prisma.notification.create({
    data: {
      userId: ALICE,
      planVersionId: plan.id,
      planItemId: item.id,
      kind: "START",
      dedupeKey: `START:${item.id}`,
      content: "10 分钟后开始：背单词",
      scheduledAt: new Date("2026-11-03T10:20:00+08:00"),
      state: "SENT",
    },
  });
  await prisma.channelBinding.create({
    data: { userId: ALICE, channel: "PERSONAL_WECHAT", externalUserId: "wx-alice" },
  });

  // Alice 的凭据：绝不能出现在导出里
  await prisma.account.create({
    data: {
      userId: ALICE,
      accountId: "alice@export.test",
      providerId: "credential",
      password: "hashed-password-should-never-export",
    },
  });
  await prisma.session.create({
    data: {
      userId: ALICE,
      token: "session-token-should-never-export",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  // Bob：用来验证隔离
  await prisma.user.create({ data: { id: BOB, email: "bob@export.test", timeZone: TZ } });
  await prisma.goal.create({
    data: { userId: BOB, title: "BOB的私密目标", priority: 1 },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [ALICE, BOB] } } });
  await prisma.$disconnect();
});

describe("exportUserData", () => {
  it("包含本人的完整数据", async () => {
    const data = await exportUserData(ALICE);

    expect(data.schemaVersion).toBe(1);
    expect(data.user.email).toBe("alice@export.test");
    expect(data.profile?.rawInput).toBe("我是大学生");
    expect(data.settings?.briefStartTime).toBe("07:30");
    expect(data.settings?.remindersPaused).toBe(true);
    expect(data.goals.map((goal) => goal.title)).toContain("提高英语听力");
    expect(data.constraints.map((row) => row.title)).toContain("高数课");
    expect(data.plans).toHaveLength(1);
    expect(data.plans[0]?.items[0]?.title).toBe("背单词");
    expect(data.progress[0]?.ratio).toBe(0.5);
    expect(data.memories[0]?.content).toBe("最近在减脂");
    expect(data.conversations[0]?.messages[0]?.text).toBe("今天下午要加班");
    expect(data.notifications[0]?.content).toContain("背单词");
    expect(data.channelBindings[0]?.externalUserId).toBe("wx-alice");
  });

  it("不包含其他用户的数据", async () => {
    const data = await exportUserData(ALICE);
    const json = JSON.stringify(data);

    expect(json).not.toContain("BOB的私密目标");
    expect(json).not.toContain("bob@export.test");
  });

  it("绝不导出凭据：密码哈希与会话 token", async () => {
    const data = await exportUserData(ALICE);
    const json = JSON.stringify(data);

    expect(json).not.toContain("hashed-password-should-never-export");
    expect(json).not.toContain("session-token-should-never-export");
    expect(json).not.toContain("password");
    expect(json).not.toContain("token");
  });

  it("导出的时间字段是可序列化的", async () => {
    const data = await exportUserData(ALICE);
    const roundTripped = JSON.parse(JSON.stringify(data)) as { plans: Array<{ items: Array<{ startsAt: string }> }> };

    expect(roundTripped.plans[0]?.items[0]?.startsAt).toBe("2026-11-03T02:30:00.000Z");
  });
});
