import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "../src/server/db";
import { loadTodayPlans } from "../src/server/today";
import { recordProgress } from "../src/server/progress";
import { savePersonalSituation } from "../src/server/onboarding";
import { saveGoal } from "../src/server/goals";
import { activatePlanVersion } from "../src/server/plan-activation";
import { resolveModelInput, validateModelInput } from "../src/server/model-config";

const USER = "review-regression-user";
const OTHER = "review-regression-other";
const now = new Date("2026-11-04T10:00:00+08:00");
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("../src/server/session", () => ({
  getCurrentUser: async () => ({
    id: "review-regression-user",
    email: "review-regression@test.local",
    timeZone: "Asia/Shanghai",
  }),
  requireAdmin: async () => ({
    id: "review-regression-user",
    email: "review-regression@test.local",
    timeZone: "Asia/Shanghai",
  }),
}));

beforeEach(async () => {
  await prisma.invite.deleteMany({ where: { createdById: USER } });
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.user.create({
    data: { id: USER, email: "review-regression@test.local", role: "ADMIN" },
  });
  await prisma.user.create({ data: { id: OTHER, email: "review-regression-other@test.local" } });
});
afterAll(async () => {
  await prisma.invite.deleteMany({ where: { createdById: USER } });
  await prisma.user.deleteMany({ where: { id: { in: [USER, OTHER] } } });
  await prisma.$disconnect();
});
async function plan(version: number, state: "ACTIVE" | "DRAFT", userId = USER) {
  return prisma.planVersion.create({
    data: {
      userId,
      localDate: "2026-11-04",
      timeZone: "Asia/Shanghai",
      version,
      state,
      items: {
        create: {
          title: `行动 ${version}`,
          startsAt: new Date("2026-11-04T11:00:00+08:00"),
          endsAt: new Date("2026-11-04T11:30:00+08:00"),
          minutes: 30,
        },
      },
    },
    include: { items: true },
  });
}

describe("前端主流程回归", () => {
  it("新草稿与生效计划分别返回，其他用户的计划不可见", async () => {
    const active = await plan(1, "ACTIVE");
    const draft = await plan(2, "DRAFT");
    await plan(10, "DRAFT", OTHER);
    const view = await loadTodayPlans(USER, "2026-11-04");
    expect(view.active?.id).toBe(active.id);
    expect(view.draft?.id).toBe(draft.id);
  });
  it("旧草稿不再遮挡更新的生效版本", async () => {
    await plan(1, "DRAFT");
    await plan(2, "ACTIVE");
    expect((await loadTodayPlans(USER, "2026-11-04")).draft).toBeNull();
  });
  it("已完成不可回退，重复反馈不创建重复记录", async () => {
    const active = await plan(1, "ACTIVE");
    const id = active.items[0]!.id;
    await Promise.all([recordProgress(USER, id, 1), recordProgress(USER, id, 1)]);
    await expect(recordProgress(USER, id, 0)).rejects.toThrow(/不能改回/);
    expect(await prisma.progressEvent.count({ where: { planItemId: id } })).toBe(1);
  });
  it("不能反馈草稿或其他用户的条目，不接受非有限比例", async () => {
    const draft = await plan(1, "DRAFT");
    await expect(recordProgress(USER, draft.items[0]!.id, 0.5)).rejects.toThrow(/生效/);
    const other = await plan(1, "ACTIVE", OTHER);
    await expect(recordProgress(USER, other.items[0]!.id, 1)).rejects.toThrow(/不属于/);
    await expect(recordProgress(USER, draft.items[0]!.id, NaN)).rejects.toThrow(/比例/);
    expect(await prisma.progressEvent.count({ where: { userId: USER } })).toBe(0);
  });
  it("完成行动后取消尚未发送的关联提醒", async () => {
    const active = await plan(1, "ACTIVE");
    const n = await prisma.notification.create({
      data: {
        userId: USER,
        planVersionId: active.id,
        planItemId: active.items[0]!.id,
        kind: "START",
        dedupeKey: "review-completion",
        content: "提醒",
        scheduledAt: now,
      },
    });
    await recordProgress(USER, active.items[0]!.id, 1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).state).toBe(
      "CANCELLED",
    );
  });
  it("并发采纳保持单一生效版本，旧提醒立即取消", async () => {
    const active = await plan(1, "ACTIVE");
    const n = await prisma.notification.create({
      data: {
        userId: USER,
        planVersionId: active.id,
        kind: "START",
        dedupeKey: "review-activation",
        content: "提醒",
        scheduledAt: now,
      },
    });
    const a = await plan(2, "DRAFT");
    const b = await plan(3, "DRAFT");
    await Promise.all([
      activatePlanVersion({ userId: USER, planVersionId: a.id, now }),
      activatePlanVersion({ userId: USER, planVersionId: b.id, now }),
    ]);
    expect(await prisma.planVersion.count({ where: { userId: USER, state: "ACTIVE" } })).toBe(1);
    expect((await loadTodayPlans(USER, "2026-11-04")).active?.id).toBe(b.id);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).state).toBe(
      "CANCELLED",
    );
  });
  it("固定安排无效时，档案和目标都不发生部分写入", async () => {
    const form = new FormData();
    Object.entries({
      rawInput: "新档案",
      goalTitle: "新目标",
      goalPriority: "2",
      constraintTitle: "睡觉",
      constraintRepeat: "daily",
      constraintStart: "invalid",
      constraintEnd: "07:00",
    }).forEach(([key, value]) => form.set(key, value));
    await expect(savePersonalSituation(USER, "Asia/Shanghai", form)).rejects.toThrow();
    expect(await prisma.profile.count({ where: { userId: USER } })).toBe(0);
    expect(await prisma.goal.count({ where: { userId: USER } })).toBe(0);
  });
  it("允许主动清空个人描述", async () => {
    await prisma.profile.create({ data: { userId: USER, rawInput: "旧描述" } });
    const form = new FormData();
    form.set("rawInput", "");
    await savePersonalSituation(USER, "Asia/Shanghai", form);
    expect((await prisma.profile.findUniqueOrThrow({ where: { userId: USER } })).rawInput).toBe("");
  });
  it("目标支持更新、暂停，且不能修改他人目标", async () => {
    const input = {
      title: "运动",
      description: "循序渐进",
      priority: 2,
      state: "ACTIVE",
      targetDate: "",
    };
    await saveGoal(USER, input);
    const goal = await prisma.goal.findFirstOrThrow({ where: { userId: USER } });
    await saveGoal(USER, { ...input, id: goal.id, state: "PAUSED" });
    await expect(saveGoal(OTHER, { ...input, id: goal.id })).rejects.toThrow(/不属于/);
    expect((await prisma.goal.findUniqueOrThrow({ where: { id: goal.id } })).state).toBe("PAUSED");
    await expect(saveGoal(USER, { ...input, targetDate: "2026-02-30" })).rejects.toThrow(/日期/);
  });
  it("生成邀请码成功跳转，不会被 catch 当成失败", async () => {
    const { createInviteAction } = await import("../src/app/actions");
    const form = new FormData();
    form.set("expiresInHours", "72");
    await expect(createInviteAction(form)).rejects.toThrow(/^REDIRECT:\/admin\/invites\?created=/);
    expect(await prisma.invite.count({ where: { createdById: USER } })).toBe(1);
  });
});

describe("模型配置边界", () => {
  const existing = {
    providerId: "deepseek" as const,
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
    apiKey: "sk-test-private-key",
  };
  it("只更换同地址模型时可保留 Key，跨服务商或接口时必须重填", () => {
    expect(
      resolveModelInput({ ...existing, modelId: "another-model", apiKey: "" }, existing).apiKey,
    ).toBe(existing.apiKey);
    expect(() =>
      resolveModelInput({ ...existing, providerId: "openai", apiKey: "" }, existing),
    ).toThrow(/重新填写/);
    expect(() =>
      resolveModelInput(
        { ...existing, baseUrl: "https://elsewhere.example/v1", apiKey: "" },
        existing,
      ),
    ).toThrow(/重新填写/);
  });
  it("URL 中包含 localhost 不能绕过公网 HTTPS 检查", () => {
    expect(() =>
      validateModelInput({ ...existing, baseUrl: "http://localhost.example.com/v1" }),
    ).toThrow(/https/);
    expect(() =>
      validateModelInput({ ...existing, baseUrl: "http://example.com/localhost" }),
    ).toThrow(/https/);
    expect(() =>
      validateModelInput({ ...existing, baseUrl: "https://user:pass@example.com" }),
    ).toThrow();
  });
});
