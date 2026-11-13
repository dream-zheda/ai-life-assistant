import {
  clipInterval,
  describeInstant,
  localDayOf,
  localDayRange,
  mergeIntervals,
  minutesBetween,
} from "@life/shared";
import { fixedSlotIntervalOnDay, fixedSlotIntervalsOnDay, type FixedSlot } from "@life/domain";

/**
 * 规划上下文组装。
 *
 * 这一层的职责是**把事实变成文字**：日期、星期、可用时长、固定安排、目标列表
 * 全部由代码算好再喂给模型。模型只负责"排列"，不负责"推算"（评审意见 C1）。
 */

export type PlanningGoal = {
  id: string;
  title: string;
  description?: string;
  priority: number;
  targetDate?: string;
};

export type RecentProgress = {
  title: string;
  state: string;
  ratio: number;
};

export type PlanningInput = {
  now: Date;
  timeZone: string;
  /** 要规划哪一天；不填默认今天（用户时区）。 */
  targetDay?: string;
  profile: {
    /** 用户原始自由描述，保留原文避免二次失真。 */
    rawInput?: string;
    structuredSummary?: string;
    preferences?: readonly string[];
  };
  goals: readonly PlanningGoal[];
  fixedSlots: readonly FixedSlot[];
  /** 预留缓冲，默认 30 分钟；不计入可用时间。 */
  bufferMinutes?: number;
  recentProgress?: readonly RecentProgress[];
  /** 用户临时补充（例如"下午要加班"）。 */
  userRequest?: string;
};

export type PlanningContext = {
  day: string;
  weekdayLabel: string;
  localTime: string;
  timeZone: string;
  allowedGoalIds: Set<string>;
  totalDayMinutes: number;
  busyMinutes: number;
  availableMinutes: number;
  /** 一天最多安排几项：既防模型刷长度，也避免早报被截断成纯标题。 */
  maxItems: number;
  fixedSlotLines: string[];
  systemPrompt: string;
  userPrompt: string;
};

const WEEKDAY_ZH: Record<number, string> = {
  1: "一",
  2: "二",
  3: "三",
  4: "四",
  5: "五",
  6: "六",
  7: "日",
};

export type DayCapacity = {
  totalDayMinutes: number;
  busyMinutes: number;
  availableMinutes: number;
};

/**
 * 计算某天被固定安排占用的分钟数。
 *
 * 区间先合并再求和：相邻的两节课如果分别计算会被重复计入。
 */
export function computeBusyMinutes(
  day: string,
  timeZone: string,
  slots: readonly FixedSlot[],
): number {
  const range = localDayRange(day, timeZone);
  const busy: Array<{ start: Date; end: Date }> = [];

  for (const slot of slots) {
    // 取「今天 + 前一天」两段：跨零点的约束会从前一天溢到今天
    // （「每天 23:00-07:00 睡觉」的 00:00-07:00 属于前一天那条规则）
    for (const interval of fixedSlotIntervalsOnDay(slot, day)) {
      const clipped = clipInterval(interval, range.start, range.end);
      if (clipped !== null) busy.push(clipped);
    }
  }

  return mergeIntervals(busy).reduce((sum, interval) => sum + minutesBetween(interval.start, interval.end), 0);
}

export function computeDayCapacity(
  day: string,
  timeZone: string,
  slots: readonly FixedSlot[],
  bufferMinutes = 0,
): DayCapacity {
  const range = localDayRange(day, timeZone);
  const totalDayMinutes = minutesBetween(range.start, range.end);
  const busyMinutes = computeBusyMinutes(day, timeZone, slots);
  const availableMinutes = Math.max(0, totalDayMinutes - busyMinutes - bufferMinutes);
  return { totalDayMinutes, busyMinutes, availableMinutes };
}

function describeSlot(slot: FixedSlot, day: string): string {
  const applies = fixedSlotIntervalOnDay(slot, day) !== null;
  const when =
    slot.kind === "weekly"
      ? `每周${WEEKDAY_ZH[slot.weekday] ?? "?"}`
      : `${slot.localDate} 一次性`;
  return `- ${slot.title}：${slot.startTime}–${slot.endTime}（${when}，${applies ? "今天生效" : "今天不生效"}）`;
}

function renderGoals(goals: readonly PlanningGoal[]): string {
  if (goals.length === 0) return "（用户还没有设定目标）";
  return goals
    .map((goal) => {
      const parts = [`- ${goal.id}：${goal.title}`, `优先级 ${goal.priority}`];
      if (goal.targetDate !== undefined) parts.push(`截止 ${goal.targetDate}`);
      if (goal.description !== undefined && goal.description.length > 0) {
        parts.push(`说明：${goal.description}`);
      }
      return parts.join("，");
    })
    .join("\n");
}

function renderProgress(progress: readonly RecentProgress[] | undefined): string {
  if (progress === undefined || progress.length === 0) return "（暂无反馈记录）";
  return progress
    .map((item) => `- ${item.title}：${item.state}（完成 ${Math.round(item.ratio * 100)}%）`)
    .join("\n");
}

export function buildPlanningContext(input: PlanningInput): PlanningContext {
  const now = describeInstant(input.now, input.timeZone);
  const day = input.targetDay ?? now.localDay;

  if (day < now.localDay) {
    throw new RangeError(`不能为过去的日期 ${day} 生成规划（今天是 ${now.localDay}）`);
  }

  const bufferMinutes = input.bufferMinutes ?? 30;
  const capacity = computeDayCapacity(day, input.timeZone, input.fixedSlots, bufferMinutes);
  const allowedGoalIds = new Set(input.goals.map((goal) => goal.id));
  const fixedSlotLines = input.fixedSlots.map((slot) => describeSlot(slot, day));

  // 每项至少给 30 分钟，上下夹在 6–24 之间：
  // 可用时间少的时候不该允许排 24 项，可用时间多的时候也不需要更多。
  const maxItems = Math.max(6, Math.min(24, Math.floor(capacity.availableMinutes / 30)));

  const weekdayLabel = day === now.localDay ? now.weekdayLabel : "（未来某天）";

  const systemPrompt = [
    "你是一个生活规划助手。任务：把用户的目标拆解为当天可以执行的行动，并安排到当天的时间线上。",
    "",
    "硬性规则（违反任何一条，输出都会被系统拒绝）：",
    "1. 只能引用下面「目标列表」里出现过的 goalId，不得编造新的 goalId。",
    "2. 固定安排不可移动、不可覆盖。任何与固定安排重叠的时段都无效。",
    `3. 所有时间必须落在 ${day} 这一天之内，且必须是带时区偏移的 ISO 8601（例如 ${day}T09:00:00+08:00）。`,
    "4. 不能安排已经过去的时段。",
    "5. 条目之间不能重叠。",
    "6. 必须为休息和缓冲留出时间，不要把可用时段排满。",
    `7. 一天最多安排 ${maxItems} 项。宁可少而能执行，也不要多到列不完。`,
    "8. 不允许编造课程、会议、教材、截止日期等事实。不确定的内容写入 assumptions 或 unresolvedQuestions。",
    `9. 今天是 ${now.localDay}（${now.weekdayLabel}），当前本地时间 ${now.localTime}，时区 ${input.timeZone}。不要自己推算日期。`,
    "",
    "输出要求：只输出 JSON 对象，字段为 localDate、timezone、items、assumptions、unresolvedQuestions。",
  ].join("\n");

  const userPrompt = [
    `请安排 ${day} 这一天。`,
    "",
    `【时间事实】时区 ${input.timeZone}；当天共 ${capacity.totalDayMinutes} 分钟；` +
      `固定安排占用 ${capacity.busyMinutes} 分钟；已预留 ${bufferMinutes} 分钟缓冲；` +
      `可用于安排行动的时间约 ${capacity.availableMinutes} 分钟。`,
    "",
    "【固定安排】",
    fixedSlotLines.length === 0 ? "（无）" : fixedSlotLines.join("\n"),
    "",
    "【目标列表】",
    renderGoals(input.goals),
    "",
    "【用户情况】",
    input.profile.structuredSummary ?? input.profile.rawInput ?? "（未填写）",
    "",
    "【用户偏好】",
    input.profile.preferences === undefined || input.profile.preferences.length === 0
      ? "（无）"
      : input.profile.preferences.map((item) => `- ${item}`).join("\n"),
    "",
    "【近期进度】",
    renderProgress(input.recentProgress),
    "",
    "【用户临时补充】",
    input.userRequest ?? "（无）",
    "",
    "请给出今天的具体安排。每一条 action 都要写清为什么安排在这个时间（reason 字段）。",
  ].join("\n");

  return {
    day,
    weekdayLabel,
    localTime: now.localTime,
    timeZone: input.timeZone,
    allowedGoalIds,
    totalDayMinutes: capacity.totalDayMinutes,
    busyMinutes: capacity.busyMinutes,
    availableMinutes: capacity.availableMinutes,
    maxItems,
    fixedSlotLines,
    systemPrompt,
    userPrompt,
  };
}

/** 供外部复用：判断给定时刻是否属于「今天」之外。 */
export function isToday(instant: Date, timeZone: string, now: Date): boolean {
  return localDayOf(instant, timeZone) === localDayOf(now, timeZone);
}
