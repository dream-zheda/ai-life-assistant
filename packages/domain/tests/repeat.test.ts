import { describe, expect, it } from "vitest";

import {
  ConstraintDraftError,
  describeRepeat,
  expandConstraintDraft,
  type ConstraintDraft,
} from "../src/index.js";

const base: ConstraintDraft = {
  title: "睡觉",
  startTime: "23:00",
  endTime: "07:00",
  repeat: "daily",
};

describe("expandConstraintDraft", () => {
  it("「每天」展开成 7 条，覆盖周一到周日", () => {
    const slots = expandConstraintDraft(base, "Asia/Shanghai");

    expect(slots).toHaveLength(7);
    expect(slots.map((slot) => slot.weekday)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // 每条的时间与标题都一样，只是星期不同
    for (const slot of slots) {
      expect(slot.startTime).toBe("23:00");
      expect(slot.endTime).toBe("07:00");
      expect(slot.title).toBe("睡觉");
      expect(slot.timeZone).toBe("Asia/Shanghai");
      expect(slot.kind).toBe("weekly");
    }
  });

  it("「工作日」展开成 5 条", () => {
    const slots = expandConstraintDraft({ ...base, repeat: "weekdays" }, "Asia/Shanghai");
    expect(slots.map((slot) => slot.weekday)).toEqual([1, 2, 3, 4, 5]);
  });

  it("「周末」展开成 2 条", () => {
    const slots = expandConstraintDraft({ ...base, repeat: "weekends" }, "Asia/Shanghai");
    expect(slots.map((slot) => slot.weekday)).toEqual([6, 7]);
  });

  it("「指定星期」只展开 1 条", () => {
    const slots = expandConstraintDraft(
      { ...base, title: "高数课", repeat: "weekly", weekday: 2 },
      "Asia/Shanghai",
    );
    expect(slots).toHaveLength(1);
    expect(slots[0]?.weekday).toBe(2);
  });

  it("跨零点的时间原样保留（是否跨天由消费方处理）", () => {
    const slots = expandConstraintDraft(base, "Asia/Shanghai");
    expect(slots[0]?.startTime).toBe("23:00");
    expect(slots[0]?.endTime).toBe("07:00");
  });

  it("按星期重复但没给 weekday 时抛错", () => {
    expect(() =>
      expandConstraintDraft({ ...base, repeat: "weekly" }, "Asia/Shanghai"),
    ).toThrow(ConstraintDraftError);
  });

  it("weekday 越界时抛错", () => {
    expect(() =>
      expandConstraintDraft({ ...base, repeat: "weekly", weekday: 8 }, "Asia/Shanghai"),
    ).toThrow(/weekday/);
  });

  it("时间格式不合法时抛错", () => {
    expect(() => expandConstraintDraft({ ...base, startTime: "9:00" }, "Asia/Shanghai")).toThrow(
      /HH:mm/,
    );
  });

  it("标题为空时抛错", () => {
    expect(() => expandConstraintDraft({ ...base, title: "  " }, "Asia/Shanghai")).toThrow(
      ConstraintDraftError,
    );
  });
});

describe("describeRepeat", () => {
  it("给出人类可读的重复描述", () => {
    expect(describeRepeat("daily")).toBe("每天");
    expect(describeRepeat("weekdays")).toBe("工作日");
    expect(describeRepeat("weekly", 2)).toBe("每周二");
  });
});
