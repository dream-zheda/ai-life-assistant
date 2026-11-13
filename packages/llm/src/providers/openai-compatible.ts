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
 * OpenAI Chat Completions 兼容协议。
 *
 * 适用于 DeepSeek、OpenAI、Kimi、小米 MiMo 以及各类兼容网关。
 * 这些服务商共用请求形状，但**不保证**都支持 `response_format`，因此 jsonMode 只是提示。
 */
export type OpenAiCompatibleConfig = {
  providerId: string;
  baseUrl: string;
  apiKey: string;
  /** 注入用（测试）；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  defaultMaxOutputTokens?: number;
  defaultTimeoutMs?: number;
};

type ChatCompletionResponse = {
  model?: string;
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export function createOpenAiCompatibleAdapter(config: OpenAiCompatibleConfig): LlmAdapter {
  const doFetch = config.fetchImpl ?? fetch;
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    providerId: config.providerId,

    async generateText(ref: ModelRef, input: TextRequest) {
      const messages = input.system
        ? [{ role: "system" as const, content: input.system }, ...input.messages]
        : input.messages;

      const body: Record<string, unknown> = {
        model: ref.modelId,
        messages,
        max_tokens: input.maxOutputTokens ?? config.defaultMaxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      };
      if (input.temperature !== undefined) body.temperature = input.temperature;
      if (input.jsonMode === true) body.response_format = { type: "json_object" };

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
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

      const data = (await response.json()) as ChatCompletionResponse;
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new AppError("LLM_UPSTREAM_FAILED", `${config.providerId} 返回了空内容`, {
          retryable: true,
        });
      }

      const usage =
        data.usage?.prompt_tokens === undefined || data.usage.completion_tokens === undefined
          ? undefined
          : {
              inputTokens: data.usage.prompt_tokens,
              outputTokens: data.usage.completion_tokens,
            };

      return {
        text: content,
        model: data.model ?? ref.modelId,
        ...(usage === undefined ? {} : { usage }),
      };
    },
  };
}
