import { describe, expect, it } from "vitest";

import {
  prepareActivation,
  validateProposedPlan,
  type FixedSlot,
  type ProposedPlan,
  type ProposedPlanItem,
  type ValidationContext,
} from "../src/index.js";

const TZ = "Asia/Shanghai";
// 2026-11-03 是周二（ISO 星期 2）
const DAY = "2026-11-03";
const NOW = new Date("2026-11-03T08:00:00+08:00");

function makePlan(items: ProposedPlanItem[], overrides: Partial<ProposedPlan> = {}): ProposedPlan {
  return {
    localDate: DAY,
    timezone: TZ,
    items,
    assumptions: [],
    unresolvedQuestions: [],
    ...overrides,
  };
}

function makeContext(overrides: Partial<ValidationContext> = {}): ValidationContext {
  return {
    now: NOW,
    timeZone: TZ,
    allowedGoalIds: new Set(["g1"]),
    fixedSlots: [],
    ...overrides,
  };
}

function item(title: string, startAt: string, endAt: string, extra: Partial<ProposedPlanItem> = {}): ProposedPlanItem {
  return { title, startAt, endAt, ...extra };
}

const dailySlot: FixedSlot = {
  kind: "weekly",
  id: "slot-math",
  title: "高数课",
  weekday: 2,
  startTime: "08:30",
  endTime: "10:00",
  timeZone: TZ,
};

describe("validateProposedPlan", () => {
  it("接受不冲突且未过期的计划", () => {
    const result = validateProposedPlan(
      makePlan([item("背单词", "2026-11-03T10:30:00+08:00", "2026-11-03T11:00:00+08:00")]),
      makeContext(),
    );

    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.items).toHaveLength(1);
    expect(result.totalPlannedMinutes).toBe(30);
  });

  it("拒绝与固定课程冲突的安排", () => {
    const result = validateProposedPlan(
      makePlan([item("自习", "2026-11-03T09:00:00+08:00", "2026-11-03T10:30:00+08:00")]),
      makeContext({ fixedSlots: [dailySlot] }),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("FIXED_CONSTRAINT_CONFLICT");
  });

  it("只在约束对应的星期生效（周四不冲突）", () => {
    const result = validateProposedPlan(
      makePlan(
        [item("自习", "2026-11-05T09:00:00+08:00", "2026-11-05T10:30:00+08:00")],
        { localDate: "2026-11-05" },
      ),
      makeContext({ now: new Date("2026-11-05T08:00:00+08:00"), fixedSlots: [dailySlot] }),
    );

    expect(result.violations.map((v) => v.code)).not.toContain("FIXED_CONSTRAINT_CONFLICT");
  });

  it("拒绝条目之间重叠", () => {
    const result = validateProposedPlan(
      makePlan([
        item("跑步", "2026-11-03T09:00:00+08:00", "2026-11-03T10:00:00+08:00"),
        item("英语", "2026-11-03T09:30:00+08:00", "2026-11-03T10:30:00+08:00"),
      ]),
      makeContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("ITEM_OVERLAP");
  });

  it("拒绝已经过去的时段", () => {
    const result = validateProposedPlan(
      makePlan([item("早餐", "2026-11-03T07:00:00+08:00", "2026-11-03T07:30:00+08:00")]),
      makeContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("PAST_SLOT");
  });

  it("拒绝引用不属于当前用户的目标", () => {
    const result = validateProposedPlan(
      makePlan([item("写代码", "2026-11-03T10:00:00+08:00", "2026-11-03T11:00:00+08:00", { goalId: "g-other" })]),
      makeContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("UNKNOWN_GOAL");
  });

  it("拒绝时区与用户设置不一致的计划", () => {
    const result = validateProposedPlan(
      makePlan([item("阅读", "2026-11-03T10:00:00+08:00", "2026-11-03T11:00:00+08:00")], {
        timezone: "UTC",
      }),
      makeContext(),
    );

    expect(result.violations.map((v) => v.code)).toContain("TIMEZONE_MISMATCH");
  });

  it("拒绝跨出当天范围的条目", () => {
    const result = validateProposedPlan(
      makePlan([item("夜读", "2026-11-03T23:00:00+08:00", "2026-11-04T01:00:00+08:00")]),
      makeContext(),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("OUTSIDE_LOCAL_DAY");
  });

  it("任务与目标归属不一致时报错", () => {
    const result = validateProposedPlan(
      makePlan([item("复盘", "2026-11-03T10:00:00+08:00", "2026-11-03T10:30:00+08:00", { goalId: "g1", existingTaskId: "t1" })]),
      makeContext({ knownTasks: new Map([["t1", "g2"]]) }),
    );

    expect(result.violations.map((v) => v.code)).toContain("TASK_GOAL_MISMATCH");
  });

  it("超出当日容量只警告、不阻断", () => {
    const result = validateProposedPlan(
      makePlan([item("大块任务", "2026-11-03T09:00:00+08:00", "2026-11-03T13:00:00+08:00")]),
      makeContext({ dailyCapacityMinutes: 180 }),
    );

    expect(result.ok).toBe(true);
    const warning = result.warnings.find((w) => w.code === "CAPACITY_EXCEEDED");
    expect(warning?.suggestedDeferMinutes).toBe(60);
  });

  it("自报时长与真实区间不一致时给出警告，并以区间为准", () => {
    const result = validateProposedPlan(
      makePlan([
        item("背单词", "2026-11-03T09:00:00+08:00", "2026-11-03T10:00:00+08:00", {
          estimatedMinutes: 30,
        }),
      ]),
      makeContext(),
    );

    expect(result.warnings.map((w) => w.code)).toContain("DURATION_MISMATCH");
    expect(result.items[0]?.minutes).toBe(60);
  });

  it("条目数超过上限时拒绝（防止模型刷出不可执行的长清单）", () => {
    const result = validateProposedPlan(
      makePlan([
        item("阅读", "2026-11-03T09:00:00+08:00", "2026-11-03T09:30:00+08:00"),
        item("写作", "2026-11-03T10:00:00+08:00", "2026-11-03T10:30:00+08:00"),
      ]),
      makeContext({ maxItemsPerDay: 1 }),
    );

    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.code)).toContain("TOO_MANY_ITEMS");
  });

  it("不指定上限时默认允许 24 项", () => {
    const items = Array.from({ length: 24 }, (_, index) =>
      item(
        `任务${index + 1}`,
        `2026-11-03T${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "00" : "30"}:00+08:00`,
        `2026-11-03T${String(9 + Math.floor(index / 2)).padStart(2, "0")}:${index % 2 === 0 ? "30" : "59"}:00+08:00`,
      ),
    );

    const result = validateProposedPlan(makePlan(items), makeContext());
    expect(result.violations.map((v) => v.code)).not.toContain("TOO_MANY_ITEMS");
  });

  it("跨零点的固定约束也能识别冲突", () => {
    const overnight: FixedSlot = {
      kind: "weekly",
      id: "slot-sleep",
      title: "睡觉",
      weekday: 2,
      startTime: "23:00",
      endTime: "07:00",
      timeZone: TZ,
    };

    const result = validateProposedPlan(
      makePlan([item("夜读", "2026-11-03T23:30:00+08:00", "2026-11-03T23:59:00+08:00")]),
      makeContext({ fixedSlots: [overnight] }),
    );

    expect(result.violations.map((v) => v.code)).toContain("FIXED_CONSTRAINT_CONFLICT");
  });

  it("前一天的跨零点约束溢到今天：凌晨 2 点不能安排", () => {
    // 周一的「23:00–07:00 睡觉」会一直占到现在周六的 00:00–07:00
    const mondaySleep: FixedSlot = {
      kind: "weekly",
      id: "slot-sleep-mon",
      title: "睡觉",
      weekday: 1,
      startTime: "23:00",
      endTime: "07:00",
      timeZone: TZ,
    };

    const result = validateProposedPlan(
      makePlan([item("夜读", "2026-11-03T02:00:00+08:00", "2026-11-03T02:30:00+08:00")]),
      makeContext({
        // 把"现在"挪到凌晨 1 点，避免这条被判成过期而掩盖真正的冲突
        now: new Date("2026-11-03T01:00:00+08:00"),
        fixedSlots: [mondaySleep],
      }),
    );

    expect(result.violations.map((v) => v.code)).toContain("FIXED_CONSTRAINT_CONFLICT");
  });

  it("前一天的普通约束不会误伤今天（不跨零点时不溢出）", () => {
    const mondayClass: FixedSlot = {
      kind: "weekly",
      id: "slot-mon-class",
      title: "周一课",
      weekday: 1,
      startTime: "09:00",
      endTime: "10:00",
      timeZone: TZ,
    };

    const result = validateProposedPlan(
      makePlan([item("背单词", "2026-11-03T09:00:00+08:00", "2026-11-03T09:30:00+08:00")]),
      makeContext({ fixedSlots: [mondayClass] }),
    );

    expect(result.ok).toBe(true);
  });
});

describe("prepareActivation", () => {
  it("生效前剔除已过期条目，并放行剩余部分", () => {
    const result = prepareActivation(
      makePlan([
        item("早餐", "2026-11-03T07:00:00+08:00", "2026-11-03T07:30:00+08:00"),
        item("背单词", "2026-11-03T09:00:00+08:00", "2026-11-03T09:30:00+08:00"),
      ]),
      makeContext(),
    );

    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]?.reason).toBe("expired");
    expect(result.items).toHaveLength(1);
    expect(result.canActivate).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("存在阻断性问题时不允许生效", () => {
    const result = prepareActivation(
      makePlan([item("自习", "2026-11-03T09:00:00+08:00", "2026-11-03T10:30:00+08:00")]),
      makeContext({ fixedSlots: [dailySlot] }),
    );

    expect(result.canActivate).toBe(false);
  });
});
