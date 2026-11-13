/**
 * 「反馈 → 调整」的触发规则。
 *
 * 规划书 §5 只写了"根据完成情况和临时变化调整规划"，但没有定义"什么条件下应该重排"。
 * 规则不定，AI 每天的"重排/不重排"就是随机的，产品体验不可复现（评审意见 §3.4）。
 *
 * 这个模块把规则写成确定性的纯函数，可测、可解释、可审计。
 */

export type PlanningMode = "confirm" | "auto";

export type AdjustmentSignal = {
  mode: PlanningMode;
  /** 用户在免打扰/暂停状态：除显式冲突外，一律不打扰。 */
  reminderPaused: boolean;
  /** 用户明确说了时间冲突（例如"下午要加班"）。 */
  explicitTimeConflict: boolean;
  plannedToday: number;
  missedToday: number;
  /** 最近 7 天完成率，样本不足时为 null。 */
  completionRate7d: number | null;
  /** 有反馈的天数，用于判断样本是否足够。 */
  trackedDays: number;
  activeGoals: number;
};

export type AdjustmentAction =
  | { kind: "NONE"; reason: string }
  | { kind: "REVISE_REMAINING"; requiresConfirmation: boolean; reason: string }
  | { kind: "REDUCE_LOAD"; factor: number; requiresConfirmation: boolean; reason: string }
  | { kind: "SUGGEST_GOAL_REVIEW"; requiresConfirmation: true; reason: string };

export const THRESHOLDS = {
  /** 当天未完成达到几项就该降载。 */
  missedTodayForReduce: 2,
  /** 7 天完成率低于此值建议重构目标。 */
  lowCompletionRate: 0.3,
  /** 判定完成率所需的最小样本天数。 */
  minTrackedDays: 7,
  /** 同时推进的目标超过此数，建议收敛。 */
  activeGoalsForReview: 6,
  /** 降载系数。 */
  reduceFactor: 0.8,
} as const;

export function decideAdjustments(signal: AdjustmentSignal): AdjustmentAction[] {
  // 暂停提醒是用户的显式授权边界，优先级最高：不做任何自动调整。
  if (signal.reminderPaused) {
    return [{ kind: "NONE", reason: "提醒已暂停，不做自动调整" }];
  }

  const actions: AdjustmentAction[] = [];
  const requiresConfirmation = signal.mode === "confirm";

  if (signal.explicitTimeConflict) {
    actions.push({
      kind: "REVISE_REMAINING",
      requiresConfirmation,
      reason: "用户报告了时间冲突，需要重排剩余时段",
    });
  }

  if (
    signal.missedToday >= THRESHOLDS.missedTodayForReduce &&
    signal.plannedToday >= THRESHOLDS.missedTodayForReduce
  ) {
    actions.push({
      kind: "REDUCE_LOAD",
      factor: THRESHOLDS.reduceFactor,
      requiresConfirmation: false,
      reason: `今天已有 ${signal.missedToday} 项未完成，次日按 ${THRESHOLDS.reduceFactor} 降载`,
    });
  }

  const completionTooLow =
    signal.completionRate7d !== null &&
    signal.trackedDays >= THRESHOLDS.minTrackedDays &&
    signal.completionRate7d < THRESHOLDS.lowCompletionRate;

  const tooManyGoals = signal.activeGoals >= THRESHOLDS.activeGoalsForReview;

  if (completionTooLow || tooManyGoals) {
    const reason = completionTooLow
      ? `最近 ${signal.trackedDays} 天完成率仅 ${Math.round(
          (signal.completionRate7d ?? 0) * 100,
        )}%，建议重新审视目标`
      : `同时推进 ${signal.activeGoals} 个目标，建议收敛`;
    // 两种情况可能同时成立，只提示一次
    actions.push({ kind: "SUGGEST_GOAL_REVIEW", requiresConfirmation: true, reason });
  }

  if (actions.length === 0) {
    return [{ kind: "NONE", reason: "没有触发任何调整条件" }];
  }

  return actions;
}

/** 单次状态差不应该改写长期目标（规划书 §5）—— 只有完成率持续过低才触发。 */
export function shouldResetLongTermGoal(signal: AdjustmentSignal): boolean {
  return (
    signal.completionRate7d !== null &&
    signal.trackedDays >= THRESHOLDS.minTrackedDays &&
    signal.completionRate7d < THRESHOLDS.lowCompletionRate
  );
}
