import { z } from "zod";

/**
 * 模型输出的结构化契约（规划书 §10 的 ProposedPlan）。
 *
 * 这里是唯一的真相来源：`@life/llm` 用它校验模型输出，业务层用它推导类型。
 * 系统自己的字段（userId / planVersion / 权限）不在此契约内 —— 模型不能提供这些。
 */

const LOCAL_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** 必须带时区标识，否则无法还原绝对时间（禁止模型输出"裸时间"）。 */
const OFFSET_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

export const localDaySchema = z
  .string()
  .regex(LOCAL_DAY_PATTERN, "必须是 YYYY-MM-DD 格式的本地日期");

export const offsetDateTimeSchema = z
  .string()
  .regex(OFFSET_DATE_TIME_PATTERN, "必须是带时区标识的 ISO 8601 时间，例如 2026-11-03T09:00:00+08:00");

export const proposedPlanItemSchema = z.object({
  title: z.string().trim().min(1, "行动标题不能为空").max(200),
  startAt: offsetDateTimeSchema,
  endAt: offsetDateTimeSchema,
  goalId: z.string().min(1).nullish(),
  existingTaskId: z.string().min(1).nullish(),
  estimatedMinutes: z.number().int().min(0).max(1440).nullish(),
  reason: z.string().max(500).nullish(),
});

export const proposedPlanSchema = z.object({
  localDate: localDaySchema,
  timezone: z.string().min(1).max(64),
  items: z.array(proposedPlanItemSchema).max(64),
  assumptions: z.array(z.string().max(500)).max(20).default([]),
  unresolvedQuestions: z.array(z.string().max(500)).max(20).default([]),
});

export type ProposedPlanItem = z.infer<typeof proposedPlanItemSchema>;
export type ProposedPlan = z.infer<typeof proposedPlanSchema>;

/** 档案草稿的契约：模型整理用户自由描述时必须区分这三类信息（规划书 §4）。 */
export const profileDraftSchema = z.object({
  stated: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        value: z.string().min(1).max(500),
        quote: z.string().max(500).nullish(),
      }),
    )
    .max(40)
    .default([]),
  inferred: z
    .array(
      z.object({
        key: z.string().min(1).max(64),
        value: z.string().min(1).max(500),
        confidence: z.enum(["low", "medium", "high"]),
      }),
    )
    .max(40)
    .default([]),
  missingButImpactful: z.array(z.string().max(300)).max(20).default([]),
  followUpQuestions: z.array(z.string().max(300)).max(5).default([]),
});

export type ProfileDraft = z.infer<typeof profileDraftSchema>;
