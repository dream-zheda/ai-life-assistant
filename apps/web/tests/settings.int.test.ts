import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/server/db";
import {
  loadUserSettings,
  parseSettingsForm,
  saveUserSettings,
  SettingsError,
} from "../src/server/settings";

/**
 * 提醒设置的集成测试。
 *
 * 页面本身很薄，规则在服务层——校验、默认值、持久化都在这里验证。
 */

const USER = "int-settings-user";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set("briefStartTime", overrides["briefStartTime"] ?? "07:30");
  data.set("reminderLeadMinutes", overrides["reminderLeadMinutes"] ?? "15");
  data.set("quietHoursStart", overrides["quietHoursStart"] ?? "23:00");
  data.set("quietHoursEnd", overrides["quietHoursEnd"] ?? "07:00");
  data.set("maxRemindersPerDay", overrides["maxRemindersPerDay"] ?? "6");
  if (overrides["remindersPaused"] === "on") data.set("remindersPaused", "on");
  return data;
}

beforeEach(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.user.create({
    data: { id: USER, email: "int-settings@example.com", timeZone: "Asia/Shanghai" },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("parseSettingsForm", () => {
  it("解析合法表单", () => {
    const input = parseSettingsForm(form());

    expect(input).toEqual({
      briefStartTime: "07:30",
      reminderLeadMinutes: 15,
      quietHoursStart: "23:00",
      quietHoursEnd: "07:00",
      remindersPaused: false,
      maxRemindersPerDay: 6,
    });
  });

  it("免打扰两个都留空是允许的", () => {
    const input = parseSettingsForm(form({ quietHoursStart: "", quietHoursEnd: "" }));
    expect(input.quietHoursStart).toBeNull();
    expect(input.quietHoursEnd).toBeNull();
  });

  it("免打扰只填一半会报错（否则规则无法判断）", () => {
    expect(() => parseSettingsForm(form({ quietHoursEnd: "" }))).toThrow(SettingsError);
  });

  it("早报时间格式不合法会报错", () => {
    expect(() => parseSettingsForm(form({ briefStartTime: "7:30" }))).toThrow(/HH:mm/);
  });

  it("提前分钟数越界会报错", () => {
    expect(() => parseSettingsForm(form({ reminderLeadMinutes: "0" }))).toThrow(SettingsError);
    expect(() => parseSettingsForm(form({ reminderLeadMinutes: "500" }))).toThrow(SettingsError);
  });

  it("每日上限越界会报错", () => {
    expect(() => parseSettingsForm(form({ maxRemindersPerDay: "99" }))).toThrow(SettingsError);
  });
});

describe("saveUserSettings / loadUserSettings", () => {
  it("没有记录时返回默认值", async () => {
    const settings = await loadUserSettings(USER);
    expect(settings.briefStartTime).toBe("07:00");
    expect(settings.remindersPaused).toBe(false);
    expect(settings.quietHoursStart).toBeNull();
  });

  it("保存后能读回，暂停状态也会保留", async () => {
    const input = parseSettingsForm(form({ remindersPaused: "on" }));
    await saveUserSettings(USER, input);

    const settings = await loadUserSettings(USER);
    expect(settings.briefStartTime).toBe("07:30");
    expect(settings.reminderLeadMinutes).toBe(15);
    expect(settings.quietHoursStart).toBe("23:00");
    expect(settings.remindersPaused).toBe(true);
    expect(settings.maxRemindersPerDay).toBe(6);
  });

  it("再次保存是更新而不是插入第二行", async () => {
    await saveUserSettings(USER, parseSettingsForm(form()));
    await saveUserSettings(USER, parseSettingsForm(form({ briefStartTime: "08:15" })));

    const rows = await prisma.userSettings.count({ where: { userId: USER } });
    expect(rows).toBe(1);

    const settings = await loadUserSettings(USER);
    expect(settings.briefStartTime).toBe("08:15");
  });
});
