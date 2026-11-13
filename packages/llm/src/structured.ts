import { AppError } from "@life/shared";

import type { LlmAdapter, LlmMessage, ModelRef, TokenUsage } from "./types.js";

/**
 * 结构化输出：把「模型胡说」挡在业务层之外。
 *
 * 评审意见 §4 指出原契约 `generateStructured(): Promise<unknown>` 等于放弃校验。
 * 这里改成泛型 + schema 校验，失败时带错误摘要做有限次修复重试。
 *
 * 刻意只要求 `parse`：这样不绑定具体校验库的泛型（zod 的 `.default()` 会让
 * 输入类型与输出类型不一致，用 `ZodType<T>` 会逼调用方做强转）。
 */
export type SchemaLike<T> = {
  parse: (value: unknown) => T;
};

export const JSON_CONTRACT_INSTRUCTION = [
  "只输出一个 JSON 对象。",
  "不要输出 markdown 代码块、解释、前后缀文字。",
  "字段必须符合给定契约；不确定的内容用空数组表示，不要编造不存在的事实。",
].join("");

export type StructuredRequest<T> = {
  messages: LlmMessage[];
  system?: string;
  schema: SchemaLike<T>;
  /** 可选的契约说明（例如字段语义）。不是 JSON Schema，只是给模型看的自然语言。 */
  schemaHint?: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** 结构不合法时最多再试几次；总尝试次数 = maxRepairAttempts + 1。 */
  maxRepairAttempts?: number;
};

export type StructuredResult<T> = {
  value: T;
  /** 实际尝试次数，1 表示一次成功。 */
  attempts: number;
  text: string;
  usage?: TokenUsage;
};

/** 去掉 ```json 围栏；模型经常无视"不要代码块"这条要求。 */
function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const inner = fenced?.[1];
  return inner === undefined ? trimmed : inner.trim();
}

/**
 * 从模型输出中提取第一个完整的 JSON 对象。
 *
 * 逐字符扫描并跟踪字符串状态，避免在字符串里的 `}` 提前截断。
 */
export function extractJsonObject(input: string): string {
  const text = stripCodeFence(input);
  const start = text.indexOf("{");
  if (start === -1) throw new Error("输出中没有 JSON 对象");

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === undefined) break;

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  throw new Error("JSON 对象没有闭合");
}

function describeError(error: unknown): string {
  if (error instanceof Error && "issues" in error) {
    const issues = (error as { issues?: Array<{ path?: Array<string | number>; message?: string }> })
      .issues;
    if (Array.isArray(issues)) {
      return issues
        .slice(0, 8)
        .map((issue) => `${(issue.path ?? []).join(".") || "(root)"}: ${issue.message ?? "不合法"}`)
        .join("; ");
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function generateStructured<T>(
  adapter: LlmAdapter,
  ref: ModelRef,
  request: StructuredRequest<T>,
): Promise<StructuredResult<T>> {
  const maxRepairAttempts = request.maxRepairAttempts ?? 2;
  const totalAttempts = maxRepairAttempts + 1;
  const messages: LlmMessage[] = [...request.messages];
  let lastError = "未尝试";

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const system = [request.system, JSON_CONTRACT_INSTRUCTION, request.schemaHint]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join("\n\n");

    const result = await adapter.generateText(ref, {
      messages,
      system,
      jsonMode: true,
      ...(request.maxOutputTokens === undefined ? {} : { maxOutputTokens: request.maxOutputTokens }),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    });

    try {
      const json = extractJsonObject(result.text);
      const parsed: unknown = JSON.parse(json);
      const value = request.schema.parse(parsed);
      return {
        value,
        attempts: attempt,
        text: result.text,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      };
    } catch (error) {
      lastError = describeError(error);
      if (attempt === totalAttempts) break;

      // 把上一次的错误回灌给模型，比单纯重试有效得多
      messages.push({ role: "assistant", content: result.text });
      messages.push({
        role: "user",
        content: `上一次输出不符合契约：${lastError}\n请只重新输出符合契约的 JSON 对象。`,
      });
    }
  }

  throw new AppError("LLM_INVALID_OUTPUT", `模型输出在 ${totalAttempts} 次尝试后仍不符合契约`, {
    details: { lastError, attempts: totalAttempts, providerId: adapter.providerId },
  });
}
