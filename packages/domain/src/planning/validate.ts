import { addLocalDays, intervalsOverlap, localDayOf, localDayRange, minutesBetween } from "@life/shared";

import { fixedSlotIntervalsOnDay, type FixedSlot } from "./fixed-slots.js";
import type { ProposedPlan, ProposedPlanItem } from "./schema.js";

/**
 * 规划校验：把规划书 §5 的业务规则落成可测的纯函数。
 *
 * 分两类结果：
 * - violations：阻断性，不能生成生效计划。
 * - warnings：不阻断，但要告知用户或写入假设。
 */

export type PlanViolationCode =
  | "TIMEZONE_MISMATCH"
  | "PLAN_DATE_IN_PAST"
  | "INVALID_INTERVAL"
  | "PAST_SLOT"
  | "OUTSIDE_LOCAL_DAY"
  | "ITEM_OVERLAP"
  | "FIXED_CONSTRAINT_CONFLICT"
  | "UNKNOWN_GOAL"
  | "UNKNOWN_TASK"
  | "TASK_GOAL_MISMATCH"
  | "DUPLICATE_ITEM"
  | "TOO_MANY_ITEMS";

export type PlanWarningCode = "DURATION_MISMATCH" | "CAPACITY_EXCEEDED";

export type PlanViolation = {
  code: PlanViolationCode;
  message: string;
  /** 对应 plan.items 的下标；全局性问题（如时区不符）不填。 */
  itemIndex?: number;
};

export type PlanWarning = {
  code: PlanWarningCode;
  message: string;
  itemIndex?: number;
  suggestedDeferMinutes?: number;
};

export type ValidationContext = {
  /** 判定"是否已过期"的基准时刻。生效前必须用最新时刻再校验一次。 */
  now: Date;
  /** 用户设置里的时区，权威值。 */
  timeZone: string;
  /** 当前用户拥有的目标 ID。模型只能引用这些。 */
  allowedGoalIds: ReadonlySet<string>;
  /** 已知任务 ID → 所属目标 ID，用于校验模型是否把任务挂到别的目标上。 */
  knownTasks?: ReadonlyMap<string, string | null>;
  fixedSlots?: readonly FixedSlot[];
  /** 当日可用于安排的总分钟数，用于超额提醒。 */
  dailyCapacityMinutes?: number;
  /**
   * 一天最多允许几条安排。默认 24。
   *
   * 为什么需要：模型输出长度不受控时，可能给一天排 40 件事。
   * 那种计划既不可执行，也会让早报被截断得只剩标题。
   */
  maxItemsPerDay?: number;
};

export const DEFAULT_MAX_ITEMS_PER_DAY = 24;

export type NormalizedPlanItem = {
  index: number;
  title: string;
  goalId: string | null;
  existingTaskId: string | null;
  start: Date;
  end: Date;
  minutes: number;
  reason: string;
};

export type PlanValidationResult = {
  ok: boolean;
  violations: PlanViolation[];
  warnings: PlanWarning[];
  /** 已解析成绝对时间的条目；即使 ok=false 也会尽量返回，便于展示问题。 */
  items: NormalizedPlanItem[];
  totalPlannedMinutes: number;
};

type ParsedItem = {
  index: number;
  source: ProposedPlanItem;
  start: Date;
  end: Date;
  minutes: number;
};

function parseItems(items: ProposedPlanItem[]): {
  parsed: ParsedItem[];
  invalid: PlanViolation[];
} {
  const parsed: ParsedItem[] = [];
  const invalid: PlanViolation[] = [];

  items.forEach((source, index) => {
    const start = new Date(source.startAt);
    const end = new Date(source.endAt);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      invalid.push({
        code: "INVALID_INTERVAL",
        itemIndex: index,
        message: `第 ${index + 1} 项「${source.title}」的时间无法解析`,
      });
      return;
    }

    if (end.getTime() <= start.getTime()) {
      invalid.push({
        code: "INVALID_INTERVAL",
        itemIndex: index,
        message: `第 ${index + 1} 项「${source.title}」结束时间不晚于开始时间`,
      });
      return;
    }

    parsed.push({ index, source, start, end, minutes: minutesBetween(start, end) });
  });

  return { parsed, invalid };
}

export function validateProposedPlan(
  plan: ProposedPlan,
  context: ValidationContext,
): PlanValidationResult {
  const violations: PlanViolation[] = [];
  const warnings: PlanWarning[] = [];

  if (plan.timezone !== context.timeZone) {
    violations.push({
      code: "TIMEZONE_MISMATCH",
      message: `计划时区 ${plan.timezone} 与用户时区 ${context.timeZone} 不一致`,
    });
  }

  const today = localDayOf(context.now, context.timeZone);
  if (plan.localDate < today) {
    violations.push({
      code: "PLAN_DATE_IN_PAST",
      message: `计划日期 ${plan.localDate} 早于今天 ${today}`,
    });
  }

  const dayRange = localDayRange(plan.localDate, context.timeZone);
  const { parsed, invalid } = parseItems(plan.items);
  violations.push(...invalid);

  // 条目数上限：防止模型给一天排出不可执行的长清单
  const maxItems = context.maxItemsPerDay ?? DEFAULT_MAX_ITEMS_PER_DAY;
  if (plan.items.length > maxItems) {
    violations.push({
      code: "TOO_MANY_ITEMS",
      message: `一天最多安排 ${maxItems} 项，这份计划有 ${plan.items.length} 项`,
    });
  }

  for (const item of parsed) {
    // 已过期的时段不能安排（规划书 §5）
    if (item.start.getTime() < context.now.getTime()) {
      violations.push({
        code: "PAST_SLOT",
        itemIndex: item.index,
        message: `第 ${item.index + 1} 项「${item.source.title}」的开始时间已经过去`,
      });
    }

    if (
      item.start.getTime() < dayRange.start.getTime() ||
      item.end.getTime() > dayRange.end.getTime()
    ) {
      violations.push({
        code: "OUTSIDE_LOCAL_DAY",
        itemIndex: item.index,
        message: `第 ${item.index + 1} 项「${item.source.title}」超出 ${plan.localDate} 这一天`,
      });
    }

    const goalId = item.source.goalId ?? null;
    if (goalId !== null && !context.allowedGoalIds.has(goalId)) {
      violations.push({
        code: "UNKNOWN_GOAL",
        itemIndex: item.index,
        message: `第 ${item.index + 1} 项引用了不属于当前用户的目标 ${goalId}`,
      });
    }

    const taskId = item.source.existingTaskId ?? null;
    if (taskId !== null && context.knownTasks !== undefined) {
      if (!context.knownTasks.has(taskId)) {
        violations.push({
          code: "UNKNOWN_TASK",
          itemIndex: item.index,
          message: `第 ${item.index + 1} 项引用了不存在的任务 ${taskId}`,
        });
      } else if ((context.knownTasks.get(taskId) ?? null) !== goalId) {
        violations.push({
          code: "TASK_GOAL_MISMATCH",
          itemIndex: item.index,
          message: `第 ${item.index + 1} 项的任务与目标归属不一致`,
        });
      }
    }

    // 模型自报时长与真实区间不符时只做提醒：以时间区间为准，不采信自报值
    if (item.source.estimatedMinutes != null) {
      const reported = item.source.estimatedMinutes;
      if (Math.abs(reported - item.minutes) > 1) {
        warnings.push({
          code: "DURATION_MISMATCH",
          itemIndex: item.index,
          message: `第 ${item.index + 1} 项自报 ${reported} 分钟，实际区间为 ${item.minutes} 分钟，已按实际区间处理`,
        });
      }
    }
  }

  // 条目之间不得重叠
  for (const [i, a] of parsed.entries()) {
    for (const [j, b] of parsed.entries()) {
      if (j <= i) continue;
      if (intervalsOverlap({ start: a.start, end: a.end }, { start: b.start, end: b.end })) {
        violations.push({
          code: "ITEM_OVERLAP",
          itemIndex: b.index,
          message: `「${a.source.title}」与「${b.source.title}」时间重叠`,
        });
      }
    }
  }

  // 同一标题、同一开始时间视为重复安排
  const seen = new Set<string>();
  for (const item of parsed) {
    const key = `${item.source.title}@${item.start.toISOString()}`;
    if (seen.has(key)) {
      violations.push({
        code: "DUPLICATE_ITEM",
        itemIndex: item.index,
        message: `「${item.source.title}」在相同时段被重复安排`,
      });
    }
    seen.add(key);
  }

  // 固定约束优先：任何与已有约定冲突的安排都不允许生效（规划书 §5）
  // 注意跨零点：前一天的规则可能溢出到今天，所以每个 slot 要取「今天 + 前一天」两段
  for (const item of parsed) {
    for (const slot of context.fixedSlots ?? []) {
      for (const slotInterval of fixedSlotIntervalsOnDay(slot, plan.localDate)) {
        if (intervalsOverlap({ start: item.start, end: item.end }, slotInterval)) {
          violations.push({
            code: "FIXED_CONSTRAINT_CONFLICT",
            itemIndex: item.index,
            message: `「${item.source.title}」与固定安排「${slot.title}」冲突`,
          });
          break;
        }
      }
    }
  }

  const totalPlannedMinutes = parsed.reduce((sum, item) => sum + item.minutes, 0);
  if (
    context.dailyCapacityMinutes !== undefined &&
    totalPlannedMinutes > context.dailyCapacityMinutes
  ) {
    const overflow = totalPlannedMinutes - context.dailyCapacityMinutes;
    warnings.push({
      code: "CAPACITY_EXCEEDED",
      message: `当日已安排 ${totalPlannedMinutes} 分钟，超出可用 ${context.dailyCapacityMinutes} 分钟约 ${overflow} 分钟，建议延期或减量`,
      suggestedDeferMinutes: overflow,
    });
  }

  const items: NormalizedPlanItem[] = parsed.map((item) => ({
    index: item.index,
    title: item.source.title,
    goalId: item.source.goalId ?? null,
    existingTaskId: item.source.existingTaskId ?? null,
    start: item.start,
    end: item.end,
    minutes: item.minutes,
    reason: item.source.reason ?? "",
  }));

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    items,
    totalPlannedMinutes,
  };
}

export type DroppedItem = {
  index: number;
  title: string;
  startAt: string;
  reason: "unparsable" | "expired";
};

export type ActivationResult = PlanValidationResult & {
  /** 生效前被剔除的已过期条目；调用方应写入假设并告知用户。 */
  dropped: DroppedItem[];
  /** 是否可以进入生效事务（仍有 violations 时为 false）。 */
  canActivate: boolean;
};

/**
 * 生效前的二次校验。
 *
 * 生成有耗时，模型返回时部分条目可能已经过期（评审意见 §4）。
 * 这里先剔除过期项，再用当前时刻重新校验，避免把"已经过去的安排"写进生效计划。
 */
export function prepareActivation(
  plan: ProposedPlan,
  context: ValidationContext,
): ActivationResult {
  const dropped: DroppedItem[] = [];
  const kept: ProposedPlanItem[] = [];

  plan.items.forEach((item, index) => {
    const start = new Date(item.startAt);
    if (Number.isNaN(start.getTime())) {
      dropped.push({ index, title: item.title, startAt: item.startAt, reason: "unparsable" });
      return;
    }
    if (start.getTime() < context.now.getTime()) {
      dropped.push({ index, title: item.title, startAt: item.startAt, reason: "expired" });
      return;
    }
    kept.push(item);
  });

  const validation = validateProposedPlan({ ...plan, items: kept }, context);
  return { ...validation, dropped, canActivate: validation.ok };
}

/** 供 prompt 使用：把固定约束渲染成模型能读懂的文本。 */
export function describeFixedSlotsForDay(
  slots: readonly FixedSlot[],
  day: string,
): string[] {
  const lines = new Set<string>();
  for (const slot of slots) {
    // 包含「前一天溢出到今天」的那一段：凌晨的睡眠也要让模型知道
    if (fixedSlotIntervalsOnDay(slot, day).length === 0) continue;
    lines.add(`${slot.title} ${slot.startTime}-${slot.endTime}`);
  }
  return [...lines];
}

export { addLocalDays };
