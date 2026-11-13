import { AppError } from "@life/shared";

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  DEFAULT_TIMEOUT_MS,
  type LlmAdapter,
  type ModelRef,
  type TextRequest,
} from "../types.js";
import { networkError, readErrorBody, timeoutSignal, upstreamError } from "./http.js";

/**
 * Anthropic Messages 原生协议。
 *
 * 和 OpenAI 风格有三处实质差异，所以必须单独一个适配器：
 * 1. 系统提示词是顶层 `system` 字段，不是 messages 里的一条。
 * 2. 鉴权用 `x-api-key` + `anthropic-version`，不是 `Authorization: Bearer`。
 * 3. 响应正文是 content block 数组，不是单个字符串。
 */
export type AnthropicConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  anthropicVersion?: string;
  fetchImpl?: typeof fetch;
  defaultMaxOutputTokens?: number;
  defaultTimeoutMs?: number;
};

type AnthropicResponse = {
  model?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
};

export function createAnthropicAdapter(config: AnthropicConfig): LlmAdapter {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const version = config.anthropicVersion ?? "2023-06-01";

  return {
    providerId: config.providerId,

    async generateText(ref: ModelRef, input: TextRequest) {
      const body: Record<string, unknown> = {
        model: ref.modelId,
        max_tokens: input.maxOutputTokens ?? config.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        // Anthropic 不接受空字符串的 system
        messages: input.messages
          .filter((message) => message.role !== "system")
          .map((message) => ({ role: message.role, content: message.content })),
      };
      if (input.system !== undefined && input.system.length > 0) body.system = input.system;
      if (input.temperature !== undefined) body.temperature = input.temperature;

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": config.apiKey,
            "anthropic-version": version,
          },
          body: JSON.stringify(body),
          signal: timeoutSignal(input.timeoutMs ?? config.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
        });
      } catch (error) {
        throw networkError(error, config.providerId);
      }

      if (!response.ok) {
        throw upstreamError(response.status, await readErrorBody(response), config.providerId);
      }

      const data = (await response.json()) as AnthropicResponse;
      const text = (data.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text ?? "")
        .join("");

      if (text.length === 0) {
        throw new AppError("LLM_UPSTREAM_FAILED", `${config.providerId} 返回了空内容`, {
          retryable: true,
          details: { stopReason: data.stop_reason },
        });
      }

      const usage =
        data.usage?.input_tokens === undefined || data.usage.output_tokens === undefined
          ? undefined
          : { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens };

      return {
        text,
        model: data.model ?? ref.modelId,
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}
