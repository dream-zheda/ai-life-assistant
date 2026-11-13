import { describe, expect, it } from "vitest";

import {
  DEFAULT_POLICY,
  SUPPRESSION_LABEL,
  isWithinQuietHours,
  parseLocalTimeToMinutes,
  shouldSuppressReminder,
  type ReminderPolicy,
} from "../src/index.js";

const at = (hour: number, minute = 0): number => hour * 60 + minute;

function policy(overrides: Partial<ReminderPolicy> = {}): ReminderPolicy {
  return { ...DEFAULT_POLICY, ...overrides };
}

describe("parseLocalTimeToMinutes", () => {
  it("解析合法时刻", () => {
    expect(parseLocalTimeToMinutes("00:00")).toBe(0);
    expect(parseLocalTimeToMinutes("07:30")).toBe(450);
    expect(parseLocalTimeToMinutes("23:59")).toBe(1439);
  });

  it("非法格式返回 null，而不是抛错", () => {
    expect(parseLocalTimeToMinutes("7:30")).toBeNull();
    expect(parseLocalTimeToMinutes("24:00")).toBeNull();
    expect(parseLocalTimeToMinutes("")).toBeNull();
  });
});

describe("isWithinQuietHours", () => {
  it("未设置时永远不生效", () => {
    expect(isWithinQuietHours(null, at(3))).toBe(false);
  });

  it("同一天内的时段：22:00–23:00", () => {
    const quiet = { start: "22:00", end: "23:00" };
    expect(isWithinQuietHours(quiet, at(21, 59))).toBe(false);
    expect(isWithinQuietHours(quiet, at(22, 0))).toBe(true);
    expect(isWithinQuietHours(quiet, at(22, 59))).toBe(true);
    expect(isWithinQuietHours(quiet, at(23, 0))).toBe(false);
  });

  it("跨零点时段：23:00–07:00", () => {
    const quiet = { start: "23:00", end: "07:00" };
    // 凌晨属于免打扰
    expect(isWithinQuietHours(quiet, at(2))).toBe(true);
    expect(isWithinQuietHours(quiet, at(6, 59))).toBe(true);
    expect(isWithinQuietHours(quiet, at(7, 0))).toBe(false);
    // 白天不属于
    expect(isWithinQuietHours(quiet, at(12))).toBe(false);
    // 深夜属于
    expect(isWithinQuietHours(quiet, at(23, 30))).toBe(true);
  });

  it("起止时间相同视为未设置，避免全天静音", () => {
    expect(isWithinQuietHours({ start: "08:00", end: "08:00" }, at(8))).toBe(false);
  });
});

describe("shouldSuppressReminder", () => {
  it("默认可发", () => {
    expect(shouldSuppressReminder(policy(), { minutesOfDay: at(10), sentToday: 0 })).toBeNull();
  });

  it("暂停优先于其他条件", () => {
    expect(
      shouldSuppressReminder(
        policy({ paused: true, quietHours: { start: "23:00", end: "07:00" } }),
        { minutesOfDay: at(10), sentToday: 999 },
      ),
    ).toBe("paused");
  });

  it("免打扰时段内不发", () => {
    expect(
      shouldSuppressReminder(
        policy({ quietHours: { start: "23:00", end: "07:00" } }),
        { minutesOfDay: at(2), sentToday: 0 },
      ),
    ).toBe("quiet_hours");
  });

  it("达到每日上限不发", () => {
    expect(
      shouldSuppressReminder(policy({ maxPerDay: 3 }), { minutesOfDay: at(12), sentToday: 3 }),
    ).toBe("daily_limit");
    expect(
      shouldSuppressReminder(policy({ maxPerDay: 3 }), { minutesOfDay: at(12), sentToday: 2 }),
    ).toBeNull();
  });
});

describe("SUPPRESSION_LABEL", () => {
  it("每种原因都有可展示文案", () => {
    expect(SUPPRESSION_LABEL.paused).toContain("暂停");
    expect(SUPPRESSION_LABEL.quiet_hours).toContain("免打扰");
    expect(SUPPRESSION_LABEL.daily_limit).toContain("上限");
  });
});
