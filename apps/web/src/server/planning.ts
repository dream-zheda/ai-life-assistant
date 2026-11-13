import {
  createMockAdapter,
  createOpenAiCompatibleAdapter,
  type LlmAdapter,
  type ModelRef,
} from "@life/llm";
import { generatePlanDraft, type PlanDraftResult } from "@life/planning";
import type { FixedSlot } from "@life/domain";
import { localDayOf } from "@life/shared";

import { prisma } from "./db";
import { adapterFor, loadModelConfig } from "./model-config";

/**
 * 规划用例的服务端封装：读库 → 组装 → 调模型 → 落库。
 *
 * 模型选择策略：
 * - 配了 DEEPSEEK_API_KEY 就用真实模型；
 * - 没配就用 mock，但 mock **不会编造计划**，只返回空安排 + 一句"未配置模型"。
 *   宁可页面上明确显示"没有生成"，也不要拿假数据冒充 AI 结果。
 */

export const DEEPSEEK_DEFAULT_BASE_URL = "https://api.deepseek.com/v1";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-chat";

export type PlanningMode = "live" | "mock";

/**
 * 选择用哪个模型：**页面上填的 > 环境变量 > 离线 mock**。
 *
 * 必须异步且按用户读库——用户可以在设置页自己填 Key，
 * 这是单用户自托管下最省事的接入方式（不用改 .env、不用重启）。
 */
export async function resolvePlanningAdapter(
  userId: string,
): Promise<{ adapter: LlmAdapter; ref: ModelRef; mode: PlanningMode }> {
  const userConfig = await loadModelConfig(userId);
  if (userConfig !== null) {
    const { adapter, ref } = adapterFor(userConfig);
    return { adapter, ref, mode: "live" };
  }

  const apiKey = process.env.DEEPSEEK_API_KEY;
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_DEFAULT_BASE_URL;

  if (apiKey !== undefined && apiKey.trim().length > 0) {
    return {
      adapter: createOpenAiCompatibleAdapter({
        providerId: "deepseek",
        baseUrl,
        apiKey,
      }),
      ref: { providerId: "deepseek", modelId: DEEPSEEK_DEFAULT_MODEL },
      mode: "live",
    };
  }

  return {
    adapter: createMockAdapter({
      providerId: "mock",
      respond: ({ input }) => {
        // 从提示词里取回日期，保证返回的结构仍然合法
        const localDate = /安排 (\d{4}-\d{2}-\d{2}) 这一天/.exec(
          input.messages[0]?.content ?? "",
        )?.[1];
        const timezone = /\u3010时间事实\u3011时区 ([A-Za-z/_+0-9-]+)/.exec(
          input.messages[0]?.content ?? "",
        )?.[1];
        return JSON.stringify({
          localDate: localDate ?? "1970-01-01",
          timezone: timezone ?? "UTC",
          items: [],
          assumptions: ["还没有配置模型 API Key，本次没有生成任何安排"],
          unresolvedQuestions: ["在「提醒设置 → 模型」里填一个 API Key 后重试"],
        });
      },
    }),
    ref: { providerId: "mock", modelId: "mock-offline" },
    mode: "mock",
  };
}

function toFixedSlot(row: {
  id: string;
  kind: "WEEKLY" | "ONE_OFF";
  title: string;
  weekday: number | null;
  localDate: string | null;
  startTime: string;
  endTime: string;
  timeZone: string;
}): FixedSlot | null {
  if (row.kind === "WEEKLY") {
    if (row.weekday === null) return null;
    return {
      kind: "weekly",
      id: row.id,
      title: row.title,
      weekday: row.weekday,
      startTime: row.startTime,
      endTime: row.endTime,
      timeZone: row.timeZone,
    };
  }
  if (row.localDate === null) return null;
  return {
    kind: "one_off",
    id: row.id,
    title: row.title,
    localDate: row.localDate,
    startTime: row.startTime,
    endTime: row.endTime,
    timeZone: row.timeZone,
  };
}

export type GenerateResult = {
  ok: boolean;
  mode: PlanningMode;
  planVersionId: string | null;
  itemCount: number;
  failureReason?: string;
  warnings: string[];
};

/** 允许测试注入时钟与适配器，避免用例随真实日期漂移。 */
export type GenerateOptions = {
  now?: Date;
  adapter?: LlmAdapter;
  ref?: ModelRef;
  mode?: PlanningMode;
};

export async function generateTodayPlan(
  userId: string,
  timeZone: string,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const now = options.now ?? new Date();
  const localDate = localDayOf(now, timeZone);

  const [profile, goalRows, constraints] = await Promise.all([
    prisma.profile.findUnique({ where: { userId } }),
    prisma.goal.findMany({
      where: { userId, state: "ACTIVE" },
      orderBy: { priority: "asc" },
      select: { id: true, title: true, description: true, priority: true, targetDate: true },
    }),
    prisma.fixedConstraint.findMany({ where: { userId } }),
  ]);

  const fixedSlots = constraints
    .map((row) => toFixedSlot(row))
    .filter((slot): slot is FixedSlot => slot !== null);

  // 数据库用 null 表示"没有"，领域层用 undefined；在边界处转换，不让 null 渗进纯函数
  const goals = goalRows.map((row) => ({
    id: row.id,
    title: row.title,
    priority: row.priority,
    ...(row.description === null ? {} : { description: row.description }),
    ...(row.targetDate === null ? {} : { targetDate: row.targetDate }),
  }));

  const resolved =
    options.adapter !== undefined && options.ref !== undefined
      ? { adapter: options.adapter, ref: options.ref, mode: options.mode ?? "mock" }
      : await resolvePlanningAdapter(userId);
  const { adapter, ref, mode } = resolved;

  if (mode === "mock" && options.adapter === undefined) {
    return {
      ok: false,
      mode,
      planVersionId: null,
      itemCount: 0,
      failureReason: "请先在模型配置中接入模型，再生成计划。",
      warnings: [],
    };
  }

  const result: PlanDraftResult = await generatePlanDraft(
    { adapter, ref },
    {
      now,
      timeZone,
      profile: {
        ...(profile?.rawInput === null || profile?.rawInput === undefined
          ? {}
          : { rawInput: profile.rawInput }),
      },
      goals,
      fixedSlots,
    },
    { maxAttempts: 2 },
  );

  if (!result.ok || result.plan === null) {
    return {
      ok: false,
      mode,
      planVersionId: null,
      itemCount: 0,
      ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
      warnings: result.validation?.warnings.map((warning) => warning.message) ?? [],
    };
  }

  const proposed = result.plan;
  const planVersion = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const latest = await tx.planVersion.findFirst({
      where: { userId, localDate },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    const saved = await tx.planVersion.create({
      data: {
        userId,
        localDate,
        timeZone,
        version: nextVersion,
        state: "DRAFT",
        basis: {
          attempts: result.attempts,
          llmCalls: result.llmCalls,
          mode,
          assumptions: proposed.assumptions,
          unresolvedQuestions: proposed.unresolvedQuestions,
          violations: result.validation?.violations ?? [],
          warnings: result.validation?.warnings ?? [],
        },
      },
    });

    const items = result.validation?.items ?? [];
    if (items.length > 0) {
      await tx.planItem.createMany({
        data: items.map((item) => ({
          userId,
          planVersionId: saved.id,
          title: item.title,
          startsAt: item.start,
          endsAt: item.end,
          minutes: item.minutes,
          reason: item.reason,
          ...(item.goalId === null ? {} : { goalId: item.goalId }),
        })),
      });
    }
    return saved;
  });

  return {
    ok: true,
    mode,
    planVersionId: planVersion.id,
    itemCount: result.validation?.items.length ?? 0,
    warnings: result.validation?.warnings.map((warning) => warning.message) ?? [],
  };
}
