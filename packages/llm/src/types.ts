/**
 * 多模型适配层（规划书 §10）。
 *
 * 原则：
 * - 适配器只负责「发请求、拿文本」，不负责校验业务语义。
 * - 不假定所有服务商协议相同：兼容接口走 OpenAI 风格，原生协议各写一个适配器。
 * - 模型标识、权限、用量归属都由调用方上下文决定，不接受模型返回。
 */

export type LlmRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type ModelRef = {
  providerId: string;
  modelId: string;
};

export type TextRequest = {
  messages: LlmMessage[];
  /** 系统提示词。与 messages 分开，便于各家适配器映射到各自字段。 */
  system?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** 请服务商以 JSON 形式返回（仅部分协议支持，不支持的适配器可忽略）。 */
  jsonMode?: boolean;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type TextResult = {
  text: string;
  model: string;
  usage?: TokenUsage;
};

export interface LlmAdapter {
  readonly providerId: string;
  generateText(ref: ModelRef, input: TextRequest): Promise<TextResult>;
}

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 4_096;
