import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createOneBotAdapter,
  verifyOneBotSignature,
  CHANNEL_POLICIES,
  decideProactiveDelivery,
  type OneBotFetchLike,
  type OneBotResponse,
} from "../src/index.js";

/**
 * QQ（OneBot 11）适配器的单元测试。
 *
 * 只覆盖我们这一侧：请求形状、retcode 处理、签名、事件解析。
 * 真实 NapCat 是否可用，只能装起来才知道。
 */

const BASE = {
  endpoint: "http://127.0.0.1:3000/",
  token: "onebot-token",
  secret: "onebot-secret",
  channelInstanceId: "napcat-1",
  selfId: "10000",
};

function fake(handler: (url: string, init: any) => OneBotResponse) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl: OneBotFetchLike = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function json(status: number, body: unknown): OneBotResponse {
  return { status, text: async () => JSON.stringify(body) };
}

describe("通道策略", () => {
  it("QQ 以好友身份发消息，没有窗口限制", () => {
    expect(
      decideProactiveDelivery(CHANNEL_POLICIES["qq-onebot"], null, new Date()),
    ).toEqual({ action: "send", expiresAt: null });
  });

  it("仍然要求有降级通道", () => {
    expect(CHANNEL_POLICIES["qq-onebot"].needsFallback).toBe(true);
  });
});

describe("createOneBotAdapter.send", () => {
  it("发送到 send_private_msg，带上 token 与 QQ 号", async () => {
    const { impl, calls } = fake(() => json(200, { status: "ok", retcode: 0, data: { message_id: 42 } }));
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: impl });

    const outcome = await adapter.send({ externalUserId: "12345", text: "该喝水了" });

    expect(outcome).toEqual({ status: "accepted", externalMessageId: "42" });
    expect(calls[0]?.url).toBe("http://127.0.0.1:3000/send_private_msg");
    expect(calls[0]?.init.headers.authorization).toBe("Bearer onebot-token");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      user_id: 12345,
      message: "该喝水了",
      auto_escape: true,
    });
  });

  it("HTTP 200 但 retcode 非 0 时算失败（OneBot 的常见坑）", async () => {
    const { impl } = fake(() => json(200, { status: "failed", retcode: 100, data: null }));
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: impl });

    const outcome = await adapter.send({ externalUserId: "1", text: "x" });
    expect(outcome).toEqual({ status: "failed", retryable: true, code: "RETCODE_100" });
  });

  it("401 不重试，5xx 重试", async () => {
    const unauthorized = createOneBotAdapter({
      ...BASE,
      fetchImpl: fake(() => json(401, {})).impl,
    });
    expect(await unauthorized.send({ externalUserId: "1", text: "x" })).toEqual({
      status: "failed",
      retryable: false,
      code: "ONEBOT_UNAUTHORIZED",
    });

    const broken = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(502, {})).impl });
    expect(await broken.send({ externalUserId: "1", text: "x" })).toEqual({
      status: "failed",
      retryable: true,
      code: "HTTP_502",
    });
  });

  it("网络异常记 unknown", async () => {
    const impl: OneBotFetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: impl });
    expect((await adapter.send({ externalUserId: "1", text: "x" })).status).toBe("unknown");
  });

  it("HTTP 200 的畸形响应不声称接受，429 可重试", async () => {
    for (const body of [{}, { status: "failed", retcode: 0 }, null]) {
      const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(200, body)).impl });
      expect((await adapter.send({ externalUserId: "12345", text: "x" })).status).toBe("unknown");
    }
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(429, {})).impl });
    expect(await adapter.send({ externalUserId: "12345", text: "x" })).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("签名与事件解析", () => {
  it("X-Signature 用 HMAC-SHA1，前缀 sha1=", () => {
    const body = '{"post_type":"message"}';
    const sig = `sha1=${createHmac("sha1", BASE.secret).update(body).digest("hex")}`;

    expect(verifyOneBotSignature(BASE.secret, body, sig)).toBe(true);
    expect(verifyOneBotSignature(BASE.secret, body, sig.slice(5))).toBe(true);
    expect(verifyOneBotSignature(BASE.secret, `${body} `, sig)).toBe(false);
    expect(verifyOneBotSignature(BASE.secret, body, "")).toBe(false);
  });

  it("解析私聊消息（字符串格式）", () => {
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(200, {})).impl });

    const parsed = adapter.parseInbound(
      {},
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: 12345,
        raw_message: "完成 2",
        message_id: 777,
        time: 1_760_000_000,
      }),
    );

    expect(parsed).toEqual({
      channelInstanceId: "napcat-1",
      externalEventId: "777",
      externalUserId: "12345",
      occurredAt: new Date(1_760_000_000_000),
      text: "完成 2",
    });
  });

  it("接受 NapCat 的 detail_type 私聊事件", () => {
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(200, {})).impl });
    const parsed = adapter.parseInbound({}, JSON.stringify({
      self_id: 10000, post_type: "message", detail_type: "private", sub_type: "friend",
      user_id: 12345, message_id: 891, time: 1_760_000_000, message: [{ type: "text", data: { text: "帮助" } }],
    }));
    expect(parsed).toMatchObject({ externalUserId: "12345", externalEventId: "891", text: "帮助" });
    expect(adapter.parseInbound({}, JSON.stringify({ post_type: "message", detail_type: "group", user_id: 12345, raw_message: "帮助" }))).toBeNull();
  });

  it("解析数组段格式，只取文本段", () => {
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(200, {})).impl });

    const parsed = adapter.parseInbound(
      {},
      JSON.stringify({
        post_type: "message",
        message_type: "private",
        user_id: 1,
        message: [
          { type: "text", data: { text: "帮助" } },
          { type: "face", data: { id: "1" } },
        ],
        message_id: 1,
        time: 1,
      }),
    );

    expect(parsed?.text).toBe("帮助");
  });

  it("忽略群消息和自己发的消息", () => {
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(200, {})).impl });

    expect(
      adapter.parseInbound(
        {},
        JSON.stringify({ post_type: "message", message_type: "group", user_id: 12345, raw_message: "x", message_id: 1, time: 1 }),
      ),
    ).toBeNull();

    expect(
      adapter.parseInbound(
        {},
        JSON.stringify({ post_type: "message", message_type: "private", user_id: 10000, raw_message: "x", message_id: 1, time: 1 }),
      ),
    ).toBeNull();
  });

  it("非法 JSON 与非消息事件返回 null", () => {
    const adapter = createOneBotAdapter({ ...BASE, fetchImpl: fake(() => json(200, {})).impl });
    expect(adapter.parseInbound({}, "not json")).toBeNull();
    expect(adapter.parseInbound({}, JSON.stringify({ post_type: "notice" }))).toBeNull();
  });
});
