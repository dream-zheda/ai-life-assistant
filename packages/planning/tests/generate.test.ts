import { describe, expect, it } from "vitest";

import type { FixedSlot } from "@life/domain";
import { createMockAdapter, type LlmMessage } from "@life/llm";

import { generatePlanDraft } from "../src/index.js";

const TZ = "Asia/Shanghai";
const NOW = new Date("2026-11-03T08:00:00+08:00");
const DAY = "2026-11-03";
const REF = { providerId: "mock", modelId: "mock-plan" };

const goals = [{ id: "g1", title: "提高英语听力", priority: 1 }];

const classSlot: FixedSlot = {
  kind: "weekly",
  id: "slot-math",
  title: "高数课",
  weekday: 2,
  startTime: "08:30",
  endTime: "10:00",
  timeZone: TZ,
};

const baseInput = {
  now: NOW,
  timeZone: TZ,
  profile: { rawInput: "我是大学生，白天有课" },
  goals,
  fixedSlots: [classSlot],
};

function planWith(items: Array<{ title: string; startAt: string; endAt: string; goalId?: string }>): string {
  return JSON.stringify({
    localDate: DAY,
    timezone: TZ,
    items: items.map((item) => ({ ...item, reason: "测试用" })),
    assumptions: [],
    unresolvedQuestions: [],
  });
}

const validPlan = planWith([
  { title: "背单词", startAt: "2026-11-03T10:30:00+08:00", endAt: "2026-11-03T11:00:00+08:00", goalId: "g1" },
]);

// 09:00 落在高数课 08:30-10:00 之内
const conflictingPlan = planWith([
  { title: "背单词", startAt: "2026-11-03T09:00:00+08:00", endAt: "2026-11-03T09:30:00+08:00", goalId: "g1" },
]);

describe("generatePlanDraft", () => {
  it("一次生成合法计划", async () => {
    const adapter = createMockAdapter({ respond: () => validPlan });

    const result = await generatePlanDraft({ adapter, ref: REF }, baseInput);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.llmCalls).toBe(1);
    expect(result.plan?.items).toHaveLength(1);
  });

  it("把业务违规回灌给模型后重生成，而不是直接失败", async () => {
    const captured: LlmMessage[][] = [];
    const adapter = createMockAdapter({
      respond: ({ input, callIndex }) => {
        captured.push(input.messages);
        return callIndex === 0 ? conflictingPlan : validPlan;
      },
    });

    const result = await generatePlanDraft({ adapter, ref: REF }, baseInput);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    // 第二次请求：原始需求 + 上一版计划 + 违规说明
    expect(captured[1]).toHaveLength(3);
    expect(captured[1]?.[1]?.role).toBe("assistant");
    expect(captured[1]?.[2]?.content).toContain("FIXED_CONSTRAINT_CONFLICT");
  });

  it("始终冲突时返回失败与原因，不抛出异常", async () => {
    const adapter = createMockAdapter({ respond: () => conflictingPlan });

    const result = await generatePlanDraft({ adapter, ref: REF }, baseInput, { maxAttempts: 2 });

    expect(result.ok).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.failureReason).toContain("FIXED_CONSTRAINT_CONFLICT");
    expect(result.attempts).toBe(2);
  });

  it("引用不属于用户的目标会被拦下并重试", async () => {
    const adapter = createMockAdapter({
      respond: ({ callIndex }) =>
        callIndex === 0
          ? planWith([
              {
                title: "写代码",
                startAt: "2026-11-03T10:30:00+08:00",
                endAt: "2026-11-03T11:00:00+08:00",
                goalId: "g-other",
              },
            ])
          : validPlan,
    });

    const result = await generatePlanDraft({ adapter, ref: REF }, baseInput);

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });

  it("模型始终给不出合法 JSON 时返回失败，错误码可识别", async () => {
    const adapter = createMockAdapter({ respond: () => "我无法输出 JSON" });

    const result = await generatePlanDraft({ adapter, ref: REF }, baseInput);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("不符合契约");
    // 格式层重试 2 次（1 + maxRepairAttemptsPerCall 默认 1）
    expect(result.llmCalls).toBe(2);
  });

  it("已过去的时段会被判定为违规", async () => {
    const adapter = createMockAdapter({
      respond: () =>
        planWith([
          {
            title: "早餐",
            startAt: "2026-11-03T07:00:00+08:00",
            endAt: "2026-11-03T07:30:00+08:00",
            goalId: "g1",
          },
        ]),
    });

    const result = await generatePlanDraft({ adapter, ref: REF }, baseInput, { maxAttempts: 1 });

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain("PAST_SLOT");
  });
});
