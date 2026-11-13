import { prisma } from "./db";

/**
 * 提醒偏好的读写。
 *
 * 放在服务层而不是直接写在 page/action 里，是为了能在集成测试里验证校验逻辑——
 * 表单是薄的，规则是可测的。
 */

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

export type SettingsInput = {
  briefStartTime: string;
  reminderLeadMinutes: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  remindersPaused: boolean;
  maxRemindersPerDay: number;
};

function optionalTime(value: string, label: string): string | null {
  const text = value.trim();
  if (text.length === 0) return null;
  if (!TIME_PATTERN.test(text)) {
    throw new SettingsError(`${label}必须是 HH:mm 格式（例如 23:00）`);
  }
  return text;
}

export function parseSettingsForm(formData: FormData): SettingsInput {
  const briefStartTime = String(formData.get("briefStartTime") ?? "").trim();
  if (!TIME_PATTERN.test(briefStartTime)) {
    throw new SettingsError("早报时间必须是 HH:mm 格式（例如 07:00）");
  }

  const leadRaw = Number.parseInt(String(formData.get("reminderLeadMinutes") ?? ""), 10);
  if (!Number.isFinite(leadRaw) || leadRaw < 1 || leadRaw > 120) {
    throw new SettingsError("提前提醒分钟数必须在 1–120 之间");
  }

  const maxRaw = Number.parseInt(String(formData.get("maxRemindersPerDay") ?? ""), 10);
  if (!Number.isFinite(maxRaw) || maxRaw < 0 || maxRaw > 50) {
    throw new SettingsError("每日提醒上限必须在 0–50 之间");
  }

  const quietHoursStart = optionalTime(
    String(formData.get("quietHoursStart") ?? ""),
    "免打扰开始时间",
  );
  const quietHoursEnd = optionalTime(String(formData.get("quietHoursEnd") ?? ""), "免打扰结束时间");

  if ((quietHoursStart === null) !== (quietHoursEnd === null)) {
    throw new SettingsError("免打扰时段必须同时填写开始与结束，或都留空");
  }

  return {
    briefStartTime,
    reminderLeadMinutes: leadRaw,
    quietHoursStart,
    quietHoursEnd,
    remindersPaused: formData.get("remindersPaused") === "on",
    maxRemindersPerDay: maxRaw,
  };
}

export async function saveUserSettings(userId: string, input: SettingsInput): Promise<void> {
  const data = {
    briefStartTime: input.briefStartTime,
    reminderLeadMinutes: input.reminderLeadMinutes,
    quietHoursStart: input.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd,
    remindersPaused: input.remindersPaused,
    maxRemindersPerDay: input.maxRemindersPerDay,
  };

  await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export type SettingsView = SettingsInput;

export async function loadUserSettings(userId: string): Promise<SettingsView> {
  const row = await prisma.userSettings.findUnique({ where: { userId } });

  return {
    briefStartTime: row?.briefStartTime ?? "07:00",
    reminderLeadMinutes: row?.reminderLeadMinutes ?? 10,
    quietHoursStart: row?.quietHoursStart ?? null,
    quietHoursEnd: row?.quietHoursEnd ?? null,
    remindersPaused: row?.remindersPaused ?? false,
    maxRemindersPerDay: row?.maxRemindersPerDay ?? 8,
  };
}
