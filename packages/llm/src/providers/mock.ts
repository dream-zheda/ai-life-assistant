import type { LlmAdapter, ModelRef, TextRequest } from "../types.js";

/**
 * 可编程的假适配器。
 *
 * 用途有两个：
 * 1. 单元测试里精确控制每一次返回（包括故意返回非法 JSON）。
 * 2. 没有 API Key 时让网页端跑通流程——但**必须在界面上标明这是模拟结果**，
 *    不能让"未接模型"看起来像"已验证"。
 */
export type MockResponder = (params: {
  ref: ModelRef;
  input: TextRequest;
  callIndex: number;
}) => string | Promise<string>;

export type MockAdapterOptions = {
  providerId?: string;
  respond: MockResponder;
};

export function createMockAdapter(options: MockAdapterOptions): LlmAdapter {
  let callIndex = 0;

  return {
    providerId: options.providerId ?? "mock",
    async generateText(ref: ModelRef, input: TextRequest) {
      const current = callIndex;
      callIndex += 1;
      const text = await options.respond({ ref, input, callIndex: current });
      return { text, model: ref.modelId, usage: { inputTokens: 0, outputTokens: 0 } };
    },
  };
}
