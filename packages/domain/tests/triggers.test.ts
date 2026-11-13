import { describe, expect, it } from "vitest";

import { decideAdjustments, shouldResetLongTermGoal, type AdjustmentSignal } from "../src/index.js";

function signal(overrides: Partial<AdjustmentSignal> = {}): AdjustmentSignal {
  return {
    mode: "confirm",
    reminderPaused: false,
    explicitTimeConflict: false,
    plannedToday: 3,
    missedToday: 0,
    completionRate7d: 0.8,
    trackedDays: 7,
    activeGoals: 2,
    ...overrides,
  };
}

describe("decideAdjustments", () => {
  it("暂停提醒时不做任何自动调整", () => {
    const actions = decideAdjustments(
      signal({ reminderPaused: true, explicitTimeConflict: true, missedToday: 3 }),
    );

    expect(actions).toEqual([{ kind: "NONE", reason: "提醒已暂停，不做自动调整" }]);
  });

  it("确认模式下，显式时间冲突需要用户确认后才重排", () => {
    const actions = decideAdjustments(signal({ explicitTimeConflict: true }));

    const revise = actions.find((a) => a.kind === "REVISE_REMAINING");
    expect(revise).toMatchObject({ kind: "REVISE_REMAINING", requiresConfirmation: true });
  });

  it("自动模式下，显式时间冲突可直接重排", () => {
    const actions = decideAdjustments(signal({ explicitTimeConflict: true, mode: "auto" }));

    const revise = actions.find((a) => a.kind === "REVISE_REMAINING");
    expect(revise).toMatchObject({ kind: "REVISE_REMAINING", requiresConfirmation: false });
  });

  it("当天未完成达到阈值时降载，且不需要确认", () => {
    const actions = decideAdjustments(signal({ missedToday: 2 }));

    const reduce = actions.find((a) => a.kind === "REDUCE_LOAD");
    expect(reduce).toMatchObject({ kind: "REDUCE_LOAD", factor: 0.8, requiresConfirmation: false });
  });

  it("样本不足时不因完成率低而建议重构目标", () => {
    const actions = decideAdjustments(signal({ completionRate7d: 0.1, trackedDays: 3 }));

    expect(actions.map((a) => a.kind)).not.toContain("SUGGEST_GOAL_REVIEW");
  });

  it("完成率持续过低时建议重构目标", () => {
    const actions = decideAdjustments(signal({ completionRate7d: 0.2, trackedDays: 10 }));

    expect(actions.map((a) => a.kind)).toContain("SUGGEST_GOAL_REVIEW");
  });

  it("完成率低与目标过多同时成立时只提示一次", () => {
    const actions = decideAdjustments(
      signal({ completionRate7d: 0.1, trackedDays: 10, activeGoals: 8 }),
    );

    expect(actions.filter((a) => a.kind === "SUGGEST_GOAL_REVIEW")).toHaveLength(1);
  });

  it("没有触发条件时返回 NONE", () => {
    expect(decideAdjustments(signal())).toEqual([
      { kind: "NONE", reason: "没有触发任何调整条件" },
    ]);
  });
});

describe("shouldResetLongTermGoal", () => {
  it("单次状态差不改写长期目标", () => {
    expect(shouldResetLongTermGoal(signal({ completionRate7d: 0, trackedDays: 2 }))).toBe(false);
  });

  it("持续低完成率才构成改写依据", () => {
    expect(shouldResetLongTermGoal(signal({ completionRate7d: 0.2, trackedDays: 9 }))).toBe(true);
  });
});
