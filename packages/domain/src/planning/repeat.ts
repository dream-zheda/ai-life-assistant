/**
 * 「重复规则」到「单条周期约束」的展开。
 *
 * 为什么需要这一步（ADR-003）：
 * 一种"每天 23:00–07:00 睡觉"的规则，如果只存一条 weekly，跨零点时只有**开始那天**
 * 会被算作占用。2026-11-03 当天只会算 23:00–24:00 这 60 分钟，
 * 而 00:00–07:00 那 420 分钟属于前一天那条的尾巴 —— 于是 AI 被允许把行动排到凌晨 2 点。
 *
 * 所以"每天"必须展开成 7 条 weekly。展开逻辑放在纯函数里，可测、可解释。
 */

export type ConstraintRepeat = "daily" | "weekdays" | "weekends" | "weekly";

/** 展开后的单条周期约束（无数据库 id）。 */
export type WeeklySlotDraft = {
  kind: "weekly";
  title: string;
  weekday: number;
  startTime: string;
  endTime: string;
  timeZone: string;
};

export type ConstraintDraft = {
  title: string;
  startTime: string;
  endTime: string;
  repeat: ConstraintRepeat;
  /** 仅 repeat = "weekly" 时使用，ISO 星期 1–7。 */
  weekday?: number;
};

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export class ConstraintDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintDraftError";
  }
}

const WEEKDAYS_BY_REPEAT: Record<Exclude<ConstraintRepeat, "weekly">, readonly number[]> = {
  daily: [1, 2, 3, 4, 5, 6, 7],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [6, 7],
};

export function expandConstraintDraft(
  draft: ConstraintDraft,
  timeZone: string,
): WeeklySlotDraft[] {
  const title = draft.title.trim();
  if (title.length === 0) {
    throw new ConstraintDraftError("约束标题不能为空");
  }
  if (!TIME_PATTERN.test(draft.startTime) || !TIME_PATTERN.test(draft.endTime)) {
    throw new ConstraintDraftError("时间必须是 HH:mm 格式（例如 23:00）");
  }
  if (timeZone.trim().length === 0) {
    throw new ConstraintDraftError("必须指定时区");
  }

  const weekdays =
    draft.repeat === "weekly"
      ? [validateWeekday(draft.weekday)]
      : WEEKDAYS_BY_REPEAT[draft.repeat];

  return weekdays.map((weekday) => ({
    kind: "weekly" as const,
    title,
    weekday,
    startTime: draft.startTime,
    endTime: draft.endTime,
    timeZone,
  }));
}

function validateWeekday(weekday: number | undefined): number {
  if (weekday === undefined) {
    throw new ConstraintDraftError("按星期重复时必须指定 weekday（1–7）");
  }
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) {
    throw new ConstraintDraftError(`weekday 必须是 1–7 的整数，收到 ${weekday}`);
  }
  return weekday;
}

const REPEAT_LABEL: Record<ConstraintRepeat, string> = {
  daily: "每天",
  weekdays: "工作日",
  weekends: "周末",
  weekly: "指定星期",
};

export function describeRepeat(repeat: ConstraintRepeat, weekday?: number): string {
  if (repeat !== "weekly") return REPEAT_LABEL[repeat];
  const names = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return weekday === undefined ? REPEAT_LABEL.weekly : `每周${names[weekday]?.slice(1) ?? "?"}`;
}
