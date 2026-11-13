import { describe, expect, it } from "vitest";

import {
  createAnthropicAdapter,
  createOpenAiCompatibleAdapter,
  type ModelRef,
  type TextRequest,
} from "../src/index.js";

const REF: ModelRef = { providerId: "test", modelId: "model-1" };
const INPUT: TextRequest = {
  system: "你是生活规划助手",
  messages: [{ role: "user", content: "排今天的计划" }],
  maxOutputTokens: 512,
};

type Captured = { url: string; init: RequestInit };

function recordingFetch(response: () => Response): { fn: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { fn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenAI 兼容适配器", () => {
  it("正确构造请求并解析回复", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        model: "model-1",
        choices: [{ message: { content: "排好了" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );

    const adapter = createOpenAiCompatibleAdapter({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/v1/",
      apiKey: "sk-test",
      fetchImpl: fn,
    });

    const result = await adapter.generateText(REF, INPUT);

    expect(calls[0]?.url).toBe("https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.model).toBe("model-1");
    expect(body.max_tokens).toBe(512);
    // system 被折叠成 messages 的第一条
    expect((body.messages as Array<{ role: string }>)[0]?.role).toBe("system");

    expect(result.text).toBe("排好了");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("jsonMode 会带上 response_format", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: "{}" } }] }),
    );
    const adapter = createOpenAiCompatibleAdapter({
      providerId: "p",
      baseUrl: "https://example.com",
      apiKey: "k",
      fetchImpl: fn,
    });

    await adapter.generateText(REF, { ...INPUT, jsonMode: true });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("429 标记为可重试，400 标记为不可重试", async () => {
    const adapter429 = createOpenAiCompatibleAdapter({
      providerId: "p",
      baseUrl: "https://example.com",
      apiKey: "k",
      fetchImpl: recordingFetch(() => jsonResponse({ error: "rate" }, 429)).fn,
    });
    await expect(adapter429.generateText(REF, INPUT)).rejects.toMatchObject({
      code: "LLM_UPSTREAM_FAILED",
      retryable: true,
    });

    const adapter400 = createOpenAiCompatibleAdapter({
      providerId: "p",
      baseUrl: "https://example.com",
      apiKey: "k",
      fetchImpl: recordingFetch(() => jsonResponse({ error: "bad" }, 400)).fn,
    });
    await expect(adapter400.generateText(REF, INPUT)).rejects.toMatchObject({
      code: "LLM_UPSTREAM_FAILED",
      retryable: false,
    });
  });

  it("空内容视为上游失败", async () => {
    const adapter = createOpenAiCompatibleAdapter({
      providerId: "p",
      baseUrl: "https://example.com",
      apiKey: "k",
      fetchImpl: recordingFetch(() => jsonResponse({ choices: [{ message: { content: "" } }] })).fn,
    });

    await expect(adapter.generateText(REF, INPUT)).rejects.toMatchObject({
      code: "LLM_UPSTREAM_FAILED",
    });
  });
});

describe("Anthropic 适配器", () => {
  it("system 走顶层字段，正文从 content 数组拼接", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({
        model: "claude-test",
        content: [
          { type: "text", text: "第一段。" },
          { type: "text", text: "第二段。" },
        ],
        usage: { input_tokens: 20, output_tokens: 8 },
      }),
    );

    const adapter = createAnthropicAdapter({
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "ak-test",
      fetchImpl: fn,
    });

    const result = await adapter.generateText(REF, INPUT);

    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.system).toBe("你是生活规划助手");
    expect(body.messages).toEqual([{ role: "user", content: "排今天的计划" }]);

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("ak-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");

    expect(result.text).toBe("第一段。第二段。");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 8 });
  });

  it("没有 system 时不发送空字段", async () => {
    const { fn, calls } = recordingFetch(() =>
      jsonResponse({ content: [{ type: "text", text: "ok" }] }),
    );
    const adapter = createAnthropicAdapter({
      providerId: "anthropic",
      baseUrl: "https://api.anthropic.com",
      apiKey: "ak",
      fetchImpl: fn,
    });

    await adapter.generateText(REF, { messages: [{ role: "user", content: "hi" }] });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.system).toBeUndefined();
  });
});
