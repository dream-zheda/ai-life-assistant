import { AppError } from "@life/shared";

/**
 * 行动执行状态机（规划书 §5）。
 *
 * 关键约定：
 * - 「开始」不等于「完成」，没有反馈不等于「没完成」。
 * - 已完成是不可回退的：撤销/重排不允许把 done 打回 pending。
 */

export type ActionState =
  | "pending"
  | "in_progress"
  | "partially_done"
  | "done"
  | "skipped"
  | "cancelled";

/** 观测状态：当没有任何反馈时，状态是"未知"，不是"未完成"。 */
export type ObservedState = ActionState | "unknown";

const TRANSITIONS: Record<ActionState, readonly ActionState[]> = {
  pending: ["in_progress", "partially_done", "done", "skipped", "cancelled"],
  in_progress: ["partially_done", "done", "skipped", "cancelled"],
  // 允许回到 in_progress：用户可能先报了一部分，随后继续做
  partially_done: ["in_progress", "partially_done", "done", "skipped", "cancelled"],
  // done 是终态：不能无条件回滚为未开始
  done: [],
  // 跳过之后可以重新安排
  skipped: ["pending", "in_progress"],
  cancelled: [],
};

export const TERMINAL_STATES: readonly ActionState[] = ["done", "cancelled"];

export function canTransition(from: ActionState, to: ActionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ActionState, to: ActionState): void {
  if (!canTransition(from, to)) {
    throw new AppError("VALIDATION_FAILED", `不允许的状态流转：${from} → ${to}`, {
      details: { from, to, allowed: TRANSITIONS[from] },
    });
  }
}

export type CompletionReport = {
  /** 0–1 的完成比例。 */
  ratio: number;
  note?: string;
};

export type AppliedReport = {
  state: ActionState;
  ratio: number;
};

/**
 * 把一次完成度反馈折算成状态。
 *
 * 比例由用户/系统给出，不由模型猜测；模型只能解释"用户说了什么"。
 */
export function applyReport(current: ActionState, report: CompletionReport): AppliedReport {
  if (TERMINAL_STATES.includes(current)) {
    throw new AppError("VALIDATION_FAILED", `状态 ${current} 已经是终态，不能再提交完成度`, {
      details: { current },
    });
  }

  const ratio = Math.min(1, Math.max(0, report.ratio));

  if (ratio >= 1) {
    assertTransition(current, "done");
    return { state: "done", ratio: 1 };
  }

  if (ratio <= 0) {
    // 明确报告"一点没做"，回到待进行；不自动迁到 skipped（跳过需要显式表达）
    return { state: "pending", ratio: 0 };
  }

  assertTransition(current, "partially_done");
  return { state: "partially_done", ratio };
}

export function markSkipped(current: ActionState): ActionState {
  assertTransition(current, "skipped");
  return "skipped";
}

export function markInProgress(current: ActionState): ActionState {
  assertTransition(current, "in_progress");
  return "in_progress";
}

/**
 * 计算对外展示的状态。
 *
 * 规划书 §5：「不把没有反馈解释为没有完成」。
 * 只有确实收到反馈时才展示 done/skipped；否则待进行一律显示为未知。
 */
export function resolveObservedState(state: ActionState, hasFeedback: boolean): ObservedState {
  if (hasFeedback) return state;
  if (state === "pending") return "unknown";
  return state;
}

export function isTerminal(state: ActionState): boolean {
  return TERMINAL_STATES.includes(state);
}
