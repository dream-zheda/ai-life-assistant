/**
 * 提醒的抑制策略：暂停、免打扰、每日上限。
 *
 * 规划书 §3 要求「免打扰、频率限制、暂停、失败记录和恢复策略」。
 * 这里只做**判断**，不做发送——发送在 worker 里，但"该不该发"必须能独立测试。
 *
 * 时区约定：调用方把"现在"换算成用户本地时间（分钟数）再传进来，
 * 本模块不认识 Date，也不认识时区——这样规则本身不会被时区问题污染。
 */

export type QuietHours = {
  /** 本地时刻 "HH:mm" */
  start: string;
  end: string;
};

export type ReminderPolicy = {
  /** 用户主动暂停：一条都不发。 */
  paused: boolean;
  /** 免打扰时段；null 表示没有设置。支持跨零点（23:00–07:00）。 */
  quietHours: QuietHours | null;
  /** 每天最多几条主动提醒（不含用户在对话里的回复）。 */
  maxPerDay: number;
};

export type SuppressionReason = "paused" | "quiet_hours" | "daily_limit";

export const DEFAULT_POLICY: ReminderPolicy = {
  paused: false,
  quietHours: null,
  maxPerDay: 8,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** "HH:mm" → 当天第几分钟；格式不合法返回 null（调用方应把它当作"没设置"）。 */
export function parseLocalTimeToMinutes(value: string): number | null {
  const match = TIME_PATTERN.exec(value);
  if (match === null) return null;
  const [, hour, minute] = match;
  if (hour === undefined || minute === undefined) return null;
  return Number(hour) * 60 + Number(minute);
}

/**
 * 判断某个本地时刻是否落在免打扰时段内。
 *
 * 跨零点必须支持：23:00–07:00 是常见的"睡觉"设置，
 * 如果按 start < end 的朴素比较，这段会被判成"永不生效"。
 */
export function isWithinQuietHours(
  quietHours: QuietHours | null,
  minutesOfDay: number,
): boolean {
  if (quietHours === null) return false;

  const start = parseLocalTimeToMinutes(quietHours.start);
  const end = parseLocalTimeToMinutes(quietHours.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // 起止相同视为未设置，避免"全天静音"

  if (start < end) {
    return minutesOfDay >= start && minutesOfDay < end;
  }

  // 跨零点：例如 23:00–07:00
  return minutesOfDay >= start || minutesOfDay < end;
}

export type SuppressionInput = {
  /** 用户本地时间的当天分钟数（0–1439）。 */
  minutesOfDay: number;
  /** 今天已经发出去多少条主动提醒。 */
  sentToday: number;
};

/**
 * 返回抑制原因；null 表示可以发。
 *
 * 判断顺序有意设计：**暂停优先于一切**。用户按了"暂停"之后，
 * 即使还在白天、即使没到上限，也不该有任何推送。
 */
export function shouldSuppressReminder(
  policy: ReminderPolicy,
  input: SuppressionInput,
): SuppressionReason | null {
  if (policy.paused) return "paused";
  if (isWithinQuietHours(policy.quietHours, input.minutesOfDay)) return "quiet_hours";
  if (input.sentToday >= policy.maxPerDay) return "daily_limit";
  return null;
}

export const SUPPRESSION_LABEL: Record<SuppressionReason, string> = {
  paused: "已暂停提醒",
  quiet_hours: "处于免打扰时段",
  daily_limit: "已达今日提醒上限",
};
