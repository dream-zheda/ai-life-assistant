import { createOpenAiCompatibleAdapter, type LlmAdapter, type ModelRef } from "@life/llm";

import { decryptSecret, encryptSecret, hintOf } from "./crypto";
import { prisma } from "./db";

/**
 * 用户自己的模型配置。
 *
 * 优先级：**页面上填的 > 环境变量 > 离线 mock**。
 * 这样单用户自托管时，既可以直接填页面，也可以部署时用环境变量统一配。
 */

export const PROVIDER_PRESETS = {
  deepseek: {
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-chat",
  },
  openai: {
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o-mini",
  },
  custom: {
    label: "自定义（OpenAI 兼容）",
    baseUrl: "",
    modelId: "",
  },
} as const;

export type ProviderId = keyof typeof PROVIDER_PRESETS;

export type ModelConfig = {
  providerId: ProviderId;
  baseUrl: string;
  modelId: string;
  apiKey: string;
};

export type ModelConfigSummary = {
  providerId: string;
  baseUrl: string;
  modelId: string;
  hint: string;
  updatedAt: Date | null;
};

export class ModelConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelConfigError";
  }
}

function parseProvider(value: string | undefined): ProviderId {
  if (value === "deepseek" || value === "openai" || value === "custom") return value;
  return "deepseek";
}

/** 读回明文配置（只在服务端内存里存在，绝不出现在响应里）。 */
export async function loadModelConfig(userId: string): Promise<ModelConfig | null> {
  const row = await prisma.userSettings.findUnique({
    where: { userId },
    select: {
      llmProvider: true,
      llmBaseUrl: true,
      llmModel: true,
      llmApiKeyCipher: true,
    },
  });

  if (row?.llmApiKeyCipher === null || row?.llmApiKeyCipher === undefined) return null;

  const apiKey = decryptSecret(row.llmApiKeyCipher);
  if (apiKey === null) return null;

  return {
    providerId: parseProvider(row.llmProvider ?? undefined),
    baseUrl: row.llmBaseUrl ?? "",
    modelId: row.llmModel ?? "",
    apiKey,
  };
}

/** 给界面用的摘要：只有末四位，没有明文。 */
export async function modelConfigSummary(userId: string): Promise<ModelConfigSummary | null> {
  const row = await prisma.userSettings.findUnique({
    where: { userId },
    select: {
      llmProvider: true,
      llmBaseUrl: true,
      llmModel: true,
      llmApiKeyHint: true,
      llmUpdatedAt: true,
    },
  });

  if (row?.llmApiKeyHint === null || row?.llmApiKeyHint === undefined) return null;

  return {
    providerId: row.llmProvider ?? "deepseek",
    baseUrl: row.llmBaseUrl ?? "",
    modelId: row.llmModel ?? "",
    hint: row.llmApiKeyHint,
    updatedAt: row.llmUpdatedAt,
  };
}

export type TestFailureReason = "auth" | "network" | "other" | "malformed";

/**
 * 判断用户是不是把网址/邮箱填进了 Key 框。
 *
 * 这不是防呆，是真实发生过：有人填了 `https://platform.deepseek.com`，
 * 服务商只回一句 `Your api key: ****.com is invalid`，两边都很难看出问题。
 */
export function looksLikeWrongSecret(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^https?:\/\//i.test(trimmed)) return true;
  if (trimmed.includes("://")) return true;
  if (trimmed.includes("@")) return true;
  if (trimmed.includes(" ")) return true;
  // 网址常见的结尾；真正的 Key 不会以 .com 结尾
  if (/\.(com|cn|net|org)(\/.*)?$/i.test(trimmed)) return true;
  return false;
}

export function validateModelInput(input: {
  baseUrl: string;
  modelId: string;
  apiKey: string;
}): void {
  const baseUrl = input.baseUrl.trim();
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ModelConfigError("Base URL 必须是完整地址（含 https://）");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ModelConfigError("Base URL 必须是完整地址（含 https://）");
  }
  // 公网必须 https，否则 Key 会以明文走网络
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new ModelConfigError("公网地址必须用 https");
  }
  if (input.modelId.trim().length === 0) {
    throw new ModelConfigError("请填写模型名");
  }
  if (looksLikeWrongSecret(input.apiKey)) {
    throw new ModelConfigError(
      "这看起来是网址或邮箱，不是 API Key。Key 应该是一串以 sk- 开头的字符（在服务商后台的「API keys」页面创建）。",
    );
  }
  if (input.apiKey.trim().length < 8) {
    throw new ModelConfigError("API Key 看起来不完整");
  }
}

/** 更换服务商或请求地址时必须重新提供 Key，避免旧密钥被发往新地址。 */
export function resolveModelInput(input: ModelConfig, existing: ModelConfig | null): ModelConfig {
  const sameEndpoint =
    existing !== null &&
    existing.providerId === input.providerId &&
    existing.baseUrl.replace(/\/+$/, "") === input.baseUrl.replace(/\/+$/, "");
  if (!input.apiKey && existing && !sameEndpoint)
    throw new ModelConfigError("更换服务商或接口地址后，请重新填写对应的 API Key");
  const resolved = { ...input, apiKey: input.apiKey || (sameEndpoint ? existing!.apiKey : "") };
  validateModelInput(resolved);
  return resolved;
}

export async function saveModelConfig(userId: string, input: ModelConfig): Promise<void> {
  validateModelInput(input);

  const data = {
    llmProvider: input.providerId,
    llmBaseUrl: input.baseUrl.trim(),
    llmModel: input.modelId.trim(),
    llmApiKeyCipher: encryptSecret(input.apiKey.trim()),
    llmApiKeyHint: hintOf(input.apiKey),
    llmUpdatedAt: new Date(),
  };

  await prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export async function clearModelConfig(userId: string): Promise<void> {
  await prisma.userSettings.updateMany({
    where: { userId },
    data: {
      llmProvider: null,
      llmBaseUrl: null,
      llmModel: null,
      llmApiKeyCipher: null,
      llmApiKeyHint: null,
      llmUpdatedAt: null,
    },
  });
}

export function adapterFor(config: ModelConfig): { adapter: LlmAdapter; ref: ModelRef } {
  return {
    adapter: createOpenAiCompatibleAdapter({
      providerId: config.providerId,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    }),
    ref: { providerId: config.providerId, modelId: config.modelId },
  };
}

/** 从 AppError.details.body 里取出服务商原始响应（这是排错最有价值的信息）。 */
function upstreamBody(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return "";
  const body = (details as { body?: unknown }).body;
  return typeof body === "string" ? body : "";
}

/** 服务商通常把原因放在 error.message / message / detail 里。 */
function extractProviderMessage(body: string): string | null {
  if (body.length === 0) return null;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const nested = parsed["error"];
    if (typeof nested === "object" && nested !== null) {
      const message = (nested as { message?: unknown }).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
    for (const key of ["message", "detail", "error_message"]) {
      const value = parsed[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  } catch {
    // 不是 JSON 就直接截断原文
  }
  return body.slice(0, 160);
}

/**
 * 真的发一次很小的请求，确认 Key 能用。
 *
 * 返回值刻意区分「鉴权失败」和「其它失败」：前者要用户改 Key，后者可能只是网络问题。
 * 而且**把请求发往哪里写进错误信息**——最常见的错误不是 Key 坏了，
 * 是把 DeepSeek 的 Key 发给了 OpenAI 的地址，只显示"被拒绝"根本查不出来。
 */
export async function testModelConfig(
  config: ModelConfig,
): Promise<
  { ok: true; model: string } | { ok: false; reason: TestFailureReason; message: string }
> {
  try {
    validateModelInput(config);
  } catch (error) {
    return {
      ok: false,
      reason: "malformed",
      message: error instanceof Error ? error.message : "配置无效",
    };
  }
  // 先在本地拦掉"填成网址/邮箱"这种明显错误，别浪费一次请求
  if (looksLikeWrongSecret(config.apiKey)) {
    return {
      ok: false,
      reason: "malformed",
      message:
        "这看起来是网址或邮箱，不是 API Key。" +
        "Key 应该是一串以 sk- 开头的字符，在服务商后台的「API keys」页面创建后复制。",
    };
  }

  const { adapter, ref } = adapterFor(config);
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const where = `请求发往 ${endpoint}，模型 ${config.modelId}`;

  try {
    const result = await adapter.generateText(ref, {
      messages: [{ role: "user", content: "只回复两个字：可用" }],
      maxOutputTokens: 16,
      timeoutMs: 20_000,
    });
    return { ok: true, model: result.model };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const body = upstreamBody(error);
    const providerMessage = extractProviderMessage(body) ?? raw.slice(0, 160);
    const tail = `服务商原文：${providerMessage}`;

    if (/insufficient|balance|quota|余额|欠费/i.test(`${raw} ${body}`)) {
      return {
        ok: false,
        reason: "other",
        message: `服务商说余额/额度不足（不是 Key 错误）。${where}。${tail}`,
      };
    }

    if (/401|403|unauthorized|invalid.*key|authentication|api key/i.test(`${raw} ${body}`)) {
      return {
        ok: false,
        reason: "auth",
        message:
          `Key 被拒绝（401/403）。${where}。` +
          "请确认：①Key 与所选服务商匹配（DeepSeek 的 Key 不能填到 OpenAI 地址）；" +
          "②复制时没带空格、引号或换行；③Key 未过期/未被禁用。" +
          tail,
      };
    }

    if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|timeout|fetch failed|abort/i.test(raw)) {
      return {
        ok: false,
        reason: "network",
        message: `连不上服务商（${where}）：${providerMessage}`,
      };
    }
    return { ok: false, reason: "other", message: `${where} 失败：${tail}` };
  }
}
