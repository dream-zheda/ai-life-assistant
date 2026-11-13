import { DEFAULT_POLICY, type ReminderPolicy } from "@life/domain";

import { prisma } from "./db";

/**
 * 用户的提醒上下文：时区、抑制策略、提前量、早报时间。
 *
 * 没有 UserSettings 记录时用默认值——新注册用户不应该因为"还没设置"就收不到提醒。
 */

export type UserReminderContext = {
  timeZone: string;
  policy: ReminderPolicy;
  leadMinutes: number;
  briefStartTime: string;
};

export const DEFAULT_LEAD_MINUTES = 10;
export const DEFAULT_BRIEF_START = "07:00";

export async function loadReminderContext(userId: string): Promise<UserReminderContext | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      timeZone: true,
      status: true,
      settings: {
        select: {
          briefStartTime: true,
          reminderLeadMinutes: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          remindersPaused: true,
          maxRemindersPerDay: true,
        },
      },
    },
  });

  if (user === null || user.status !== "ACTIVE") return null;

  const settings = user.settings;
  const quietHours =
    settings?.quietHoursStart != null && settings.quietHoursEnd != null
      ? { start: settings.quietHoursStart, end: settings.quietHoursEnd }
      : null;

  return {
    timeZone: user.timeZone,
    policy: {
      paused: settings?.remindersPaused ?? DEFAULT_POLICY.paused,
      quietHours,
      maxPerDay: settings?.maxRemindersPerDay ?? DEFAULT_POLICY.maxPerDay,
    },
    leadMinutes: settings?.reminderLeadMinutes ?? DEFAULT_LEAD_MINUTES,
    briefStartTime: settings?.briefStartTime ?? DEFAULT_BRIEF_START,
  };
}

/** 一次 tick 内的简单缓存，避免同一用户被反复查询。 */
export function createContextCache(): {
  get: (userId: string) => Promise<UserReminderContext | null>;
} {
  const cache = new Map<string, UserReminderContext | null>();
  return {
    async get(userId: string) {
      if (!cache.has(userId)) {
        cache.set(userId, await loadReminderContext(userId));
      }
      return cache.get(userId) ?? null;
    },
  };
}
