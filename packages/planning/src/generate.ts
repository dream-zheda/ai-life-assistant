import { isAppError } from "@life/shared";
import {
  proposedPlanSchema,
  validateProposedPlan,
  type PlanValidationResult,
  type PlanViolation,
  type ProposedPlan,
} from "@life/domain";
import { generateStructured, type LlmAdapter, type LlmMessage, type ModelRef } from "@life/llm";

import { buildPlanningContext, type PlanningInput } from "./context.js";

/**
 * 规划生成用例。
 *
 * 两层防护，缺一不可：
 *   1. 格式层：`generateStructured` 用 zod 校验并做修复重试（模型输出不是合法 JSON）。
 *   2. 业务层：`validateProposedPlan` 校验规则，然后把**业务违规**回灌给模型再试
 *      （格式合法但排到已过去的时段、覆盖了固定课程，这类错误 zod 抓不到）。
 */

export const PLAN_SCHEMA_HINT = [
  "JSON 结构说明：",
  '{ "localDate": "YYYY-MM-DD", "timezone": "IANA 时区",',
  '  "items": [{ "title": "行动标题", "startAt": "带时区的 ISO 8601", "endAt": "带时区的 ISO 8601",',
  '              "goalId": "目标 ID 或 null", "estimatedMinutes": 30, "reason": "为什么安排在这里" }],',
  '  "assumptions": ["需要用户确认的假设"],',
  '  "unresolvedQuestions": ["无法确定、需要向用户提问的事项"] }',
].join("\n");

export type PlanDraftDeps = {
  adapter: LlmAdapter;
  ref: ModelRef;
};

export type PlanDraftOptions = {
  /** 业务违规后最多重新生成几次；总生成次数 = maxAttempts。 */
  maxAttempts?: number;
  /** 单次生成内部允许的格式修复次数。 */
  maxRepairAttemptsPerCall?: number;
};

export type PlanDraftResult = {
  ok: boolean;
  plan: ProposedPlan | null;
  validation: PlanValidationResult | null;
  /** 业务层尝试次数。 */
  attempts: number;
  /** 实际调用模型的次数（含格式修复）。 */
  llmCalls: number;
  failureReason?: string;
};

export function summarizeViolations(violations: readonly PlanViolation[]): string {
  return violations.map((violation) => `${violation.code}: ${violation.message}`).join("； ");
}

function buildViolationFeedback(
  violations: readonly PlanViolation[],
  availableMinutes: number,
): string {
  const lines = violations.map((violation) => {
    const where = violation.itemIndex === undefined ? "" : `（第 ${violation.itemIndex + 1} 项）`;
    return `- ${violation.code}${where}：${violation.message}`;
  });

  return [
    "这份计划没有通过业务校验，问题如下：",
    ...lines,
    "",
    "请修正后重新输出完整 JSON。注意：",
    "1. 固定安排不可覆盖，与其重叠的时段必须避开；",
    "2. 所有时间必须落在当天之内，且不能早于当前时间；",
    "3. 条目之间不得重叠；",
    `4. 当天可用于安排行动的时间约 ${availableMinutes} 分钟，不要超出；`,
    "5. 只使用目标列表中出现过的 goalId。",
  ].join("\n");
}

export async function generatePlanDraft(
  deps: PlanDraftDeps,
  input: PlanningInput,
  options: PlanDraftOptions = {},
): Promise<PlanDraftResult> {
  const maxAttempts = options.maxAttempts ?? 2;
  const context = buildPlanningContext(input);
  const messages: LlmMessage[] = [{ role: "user", content: context.userPrompt }];

  let validation: PlanValidationResult | null = null;
  let llmCalls = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const generated = await generateStructured(deps.adapter, deps.ref, {
        messages,
        system: context.systemPrompt,
        schema: proposedPlanSchema,
        schemaHint: PLAN_SCHEMA_HINT,
        maxRepairAttempts: options.maxRepairAttemptsPerCall ?? 1,
      });

      llmCalls += generated.attempts;
      const plan = generated.value;

      validation = validateProposedPlan(plan, {
        now: input.now,
        timeZone: input.timeZone,
        allowedGoalIds: context.allowedGoalIds,
        fixedSlots: input.fixedSlots,
        dailyCapacityMinutes: context.availableMinutes,
        maxItemsPerDay: context.maxItems,
      });

      if (validation.ok) {
        return { ok: true, plan, validation, attempts: attempt, llmCalls };
      }

      if (attempt === maxAttempts) break;

      // 业务违规回灌：把这份计划和具体问题一起发回去
      messages.push({ role: "assistant", content: JSON.stringify(plan) });
      messages.push({
        role: "user",
        content: buildViolationFeedback(validation.violations, context.availableMinutes),
      });
    } catch (error) {
      // 模型连格式都给不出来：保留原因，不让异常穿透到 HTTP 层
      if (isAppError(error) && error.code === "LLM_INVALID_OUTPUT") {
        const used = error.details?.["attempts"];
        if (typeof used === "number") llmCalls += used;
        return {
          ok: false,
          plan: null,
          validation,
          attempts: attempt,
          llmCalls,
          failureReason: error.message,
        };
      }
      throw error;
    }
  }

  return {
    ok: false,
    plan: null,
    validation,
    attempts: maxAttempts,
    llmCalls,
    failureReason:
      validation === null ? "未获得可用计划" : summarizeViolations(validation.violations),
  };
}
