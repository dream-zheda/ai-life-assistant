import { describe, expect, it } from "vitest";

import type { FixedSlot } from "@life/domain";

import { buildPlanningContext, computeBusyMinutes, computeDayCapacity } from "../src/index.js";

const TZ = "Asia/Shanghai";
// 2026-11-03 是周二
const NOW = new Date("2026-11-03T08:00:00+08:00");
const DAY = "2026-11-03";

const classSlot: FixedSlot = {
  kind: "weekly",
  id: "slot-math",
  title: "高数课",
  weekday: 2,
  startTime: "08:30",
  endTime: "10:00",
  timeZone: TZ,
};

const goals = [
  { id: "g1", title: "提高英语听力", priority: 1, targetDate: "2026-12-31" },
  { id: "g2", title: "规律运动", priority: 2 },
];

describe("时间容量计算", () => {
  it("扣除固定安排与缓冲", () => {
    const capacity = computeDayCapacity(DAY, TZ, [classSlot], 30);

    expect(capacity.totalDayMinutes).toBe(1440);
    expect(capacity.busyMinutes).toBe(90);
    expect(capacity.availableMinutes).toBe(1440 - 90 - 30);
  });

  it("合并相邻区间，避免重复计入", () => {
    const adjacent: FixedSlot = {
      kind: "weekly",
      id: "slot-2",
      title: "英语课",
      weekday: 2,
      startTime: "10:00",
      endTime: "11:00",
      timeZone: TZ,
    };

    expect(computeBusyMinutes(DAY, TZ, [classSlot, adjacent])).toBe(150);
  });

  it("跨零点的睡眠只计入当天那一段", () => {
    const sleep: FixedSlot = {
      kind: "weekly",
      id: "slot-sleep",
      title: "睡觉",
      weekday: 2,
      startTime: "23:00",
      endTime: "07:00",
      timeZone: TZ,
    };

    // 23:00-24:00 属于 11-03；00:00-07:00 属于 11-04。
    // 因此要表达"每天睡 8 小时"，必须同时声明周一到周日 7 条约束，
    // 否则当天的凌晨时段不会被算作占用。这是建模上的现实约束，已记入 ADR。
    expect(computeBusyMinutes(DAY, TZ, [sleep])).toBe(60);
  });

  it("当天不生效的约束不计入", () => {
    const thursdayClass: FixedSlot = { ...classSlot, weekday: 4 };
    expect(computeBusyMinutes(DAY, TZ, [thursdayClass])).toBe(0);
  });
});

describe("buildPlanningContext", () => {
  it("把日期与星期算好后写入提示词，交给模型的是事实而非推算任务", () => {
    const context = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: { rawInput: "我是大学生，白天有课，晚上容易打游戏" },
      goals,
      fixedSlots: [classSlot],
    });

    expect(context.day).toBe(DAY);
    expect(context.systemPrompt).toContain("2026-11-03");
    expect(context.systemPrompt).toContain("周二");
    expect(context.systemPrompt).toContain(TZ);
    expect(context.userPrompt).toContain("2026-11-03");
  });

  it("只把用户实际拥有的目标设为允许集合", () => {
    const context = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: {},
      goals,
      fixedSlots: [],
    });

    expect([...context.allowedGoalIds]).toEqual(["g1", "g2"]);
    expect(context.userPrompt).toContain("g1");
  });

  it("提示词里明确写死不可覆盖固定安排", () => {
    const context = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: {},
      goals,
      fixedSlots: [classSlot],
    });

    expect(context.userPrompt).toContain("高数课");
    expect(context.userPrompt).toContain("今天生效");
    expect(context.systemPrompt).toContain("固定安排不可移动");
  });

  it("用户临时补充会进入提示词", () => {
    const context = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: {},
      goals,
      fixedSlots: [],
      userRequest: "今天下午要加班",
    });

    expect(context.userPrompt).toContain("今天下午要加班");
  });

  it("拒绝为已经过去的日期生成规划", () => {
    expect(() =>
      buildPlanningContext({
        now: NOW,
        timeZone: TZ,
        targetDay: "2026-11-02",
        profile: {},
        goals,
        fixedSlots: [],
      }),
    ).toThrow(/过去的日期/);
  });

  it("条目上限随可用时间收紧，但有 6–24 的夹逼", () => {
    // 几乎没时间：下限 6
    const tight = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: {},
      goals,
      fixedSlots: [],
      bufferMinutes: 1300,
    });
    expect(tight.maxItems).toBe(6);

    // 时间充裕：上限 24
    const loose = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: {},
      goals,
      fixedSlots: [],
    });
    expect(loose.maxItems).toBe(24);
  });

  it("提示词里写明了条目上限", () => {
    const context = buildPlanningContext({
      now: NOW,
      timeZone: TZ,
      profile: {},
      goals,
      fixedSlots: [],
    });

    expect(context.systemPrompt).toContain(`一天最多安排 ${context.maxItems} 项`);
  });
});
