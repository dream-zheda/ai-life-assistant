import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createMockAdapter,
  extractJsonObject,
  generateStructured,
  type LlmMessage,
  type ModelRef,
} from "../src/index.js";

const REF: ModelRef = { providerId: "mock", modelId: "mock-1" };

const planSchema = z.object({
  items: z.array(
    z.object({
      title: z.string().min(1),
      startAt: z.string().min(1),
      endAt: z.string().min(1),
    }),
  ),
});

const validJson = JSON.stringify({
  items: [{ title: "背单词", startAt: "2026-11-03T09:00:00+08:00", endAt: "2026-11-03T09:30:00+08:00" }],
});

const baseMessages: LlmMessage[] = [{ role: "user", content: "给我排今天的计划" }];

describe("extractJsonObject", () => {
  it("剥离 ```json 围栏", () => {
    expect(extractJsonObject("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("忽略 JSON 之前的解释文字", () => {
    expect(extractJsonObject('好的，计划如下：{"a":1}')).toBe('{"a":1}');
  });

  it("字符串里的花括号不会提前截断", () => {
    const text = '{"note":"这里有个 } 符号","n":2}';
    expect(extractJsonObject(text)).toBe(text);
  });

  it("没有 JSON 时抛错", () => {
    expect(() => extractJsonObject("我无法完成")).toThrow(/没有 JSON 对象/);
  });
});

describe("generateStructured", () => {
  it("合法输出一次通过", async () => {
    const adapter = createMockAdapter({ respond: () => validJson });
    const result = await generateStructured(adapter, REF, {
      messages: baseMessages,
      schema: planSchema,
    });

    expect(result.attempts).toBe(1);
    expect(result.value.items).toHaveLength(1);
  });

  it("带代码围栏也能解析", async () => {
    const adapter = createMockAdapter({ respond: () => "```json\n" + validJson + "\n```" });
    const result = await generateStructured(adapter, REF, {
      messages: baseMessages,
      schema: planSchema,
    });

    expect(result.attempts).toBe(1);
  });

  it("第一次输出非法 JSON 时，把错误回灌后重试成功", async () => {
    const seen: LlmMessage[][] = [];
    const adapter = createMockAdapter({
      respond: ({ input, callIndex }) => {
        seen.push(input.messages);
        return callIndex === 0 ? "抱歉，我无法输出 JSON" : validJson;
      },
    });

    const result = await generateStructured(adapter, REF, {
      messages: baseMessages,
      schema: planSchema,
    });

    expect(result.attempts).toBe(2);
    // 第二次请求应包含 assistant 的原始输出 + user 的修复指令
    expect(seen[1]?.length).toBe(3);
    expect(seen[1]?.[1]?.role).toBe("assistant");
    expect(seen[1]?.[2]?.content).toContain("不符合契约");
  });

  it("结构合法但字段不合法时也会重试", async () => {
    const adapter = createMockAdapter({
      respond: ({ callIndex }) => (callIndex === 0 ? '{"items":"不是数组"}' : validJson),
    });

    const result = await generateStructured(adapter, REF, {
      messages: baseMessages,
      schema: planSchema,
    });

    expect(result.attempts).toBe(2);
  });

  it("超过重试次数后抛出可识别的错误", async () => {
    const adapter = createMockAdapter({ respond: () => "永远不是 JSON" });

    await expect(
      generateStructured(adapter, REF, {
        messages: baseMessages,
        schema: planSchema,
        maxRepairAttempts: 1,
      }),
    ).rejects.toMatchObject({ code: "LLM_INVALID_OUTPUT" });
  });
});
