import { describe, expect, it } from "vitest";

import {
  createWechatBridgeAdapter,
  createTokenBucket,
  decideProactiveDelivery,
  CHANNEL_POLICIES,
  type BridgeResponse,
} from "../src/index.js";

/**
 * 个人号协议登录通道的适配器测试。
 *
 * 这些测试只覆盖我们自己这一侧的行为（限速、错误分类、签名、解析）。
 * **真实的微信协议行为无法在这里验证**——那需要一个真账号和一台桥接服务。
 */

const BASE = {
  endpoint: "http://bridge.local/",
  token: "bridge-token",
  inboundSecret: "inbound-secret",
  channelInstanceId: "inst-1",
  accountId: "wx-account-1",
};

function fakeFetch(handler: (url: string, init: unknown) => BridgeResponse | Promise<BridgeResponse>) {
  const calls: Array<{ url: string; init: any }> = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { impl, calls };
}

function jsonResponse(status: number, body: unknown): BridgeResponse {
  return { status, text: async () => JSON.stringify(body) };
}

describe("通道策略：协议登录没有窗口", () => {
  it("wechat-personal-protocol 不受主动推送窗口限制", () => {
    const decision = decideProactiveDelivery(
      CHANNEL_POLICIES["wechat-personal-protocol"],
      null,
      new Date(),
    );
    expect(decision).toEqual({ action: "send", expiresAt: null });
  });

  it("但仍然要求有降级通道（账号随时可能被封）", () => {
    expect(CHANNEL_POLICIES["wechat-personal-protocol"].needsFallback).toBe(true);
  });
});

describe("createWechatBridgeAdapter", () => {
  it("发送成功返回已接受，并带上外部消息 ID", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, { id: "msg-1" }));
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl });

    const outcome = await adapter.send({ externalUserId: "wx-user", text: "该喝水了" });

    expect(outcome).toEqual({ status: "accepted", externalMessageId: "msg-1" });
    expect(calls[0]?.url).toBe("http://bridge.local/messages");
    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body).toMatchObject({ accountId: "wx-account-1", to: "wx-user", text: "该喝水了" });
    expect(calls[0]?.init.headers.authorization).toBe("Bearer bridge-token");
  });

  it("把幂等键透传给桥接服务", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, {}));
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl });

    await adapter.send({ externalUserId: "wx-user", text: "x" }, { idempotencyKey: "n-1" });

    expect(JSON.parse(calls[0]?.init.body as string).idempotencyKey).toBe("n-1");
  });

  it("429 与 5xx 归为可重试", async () => {
    for (const status of [429, 500, 503]) {
      const { impl } = fakeFetch(() => jsonResponse(status, {}));
      const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl });
      const outcome = await adapter.send({ externalUserId: "u", text: "x" });
      expect(outcome).toEqual({ status: "failed", retryable: true, code: `HTTP_${status}` });
    }
  });

  it("401/403 归为不可重试（凭据失效，重试只会加重风控）", async () => {
    for (const status of [401, 403]) {
      const { impl } = fakeFetch(() => jsonResponse(status, {}));
      const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl });
      const outcome = await adapter.send({ externalUserId: "u", text: "x" });
      expect(outcome).toEqual({ status: "failed", retryable: false, code: "BRIDGE_UNAUTHORIZED" });
    }
  });

  it("网络异常记为 unknown，而不是 failed", async () => {
    const { impl } = fakeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl });

    const outcome = await adapter.send({ externalUserId: "u", text: "x" });

    expect(outcome.status).toBe("unknown");
    // 关键点：我们不知道消息有没有发出去，不能当失败重试，否则可能重复打扰用户
    expect(outcome).not.toHaveProperty("retryable");
  });

  it("本地限速：超过每分钟额度直接返回可重试失败，不发请求", async () => {
    const { impl, calls } = fakeFetch(() => jsonResponse(200, {}));
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl, sendsPerMinute: 2 });

    const first = await adapter.send({ externalUserId: "u", text: "1" });
    const second = await adapter.send({ externalUserId: "u", text: "2" });
    const third = await adapter.send({ externalUserId: "u", text: "3" });

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(third).toEqual({ status: "failed", retryable: true, code: "LOCAL_RATE_LIMITED" });
    expect(calls).toHaveLength(2);
  });

  it("canSendNow 能在发送前判断额度", async () => {
    const { impl } = fakeFetch(() => jsonResponse(200, {}));
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: impl, sendsPerMinute: 1 });

    expect(adapter.canSendNow()).toBe(true);
    await adapter.send({ externalUserId: "u", text: "x" });
    expect(adapter.canSendNow()).toBe(false);
  });
});

describe("签名校验", () => {
  it("正确的 HMAC 通过，错误或缺失的拒绝", async () => {
    const { createHmac } = await import("node:crypto");
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: fakeFetch(() => jsonResponse(200, {})).impl });

    const body = JSON.stringify({ eventId: "e1", from: "wx-a", text: "hi" });
    const good = createHmac("sha256", BASE.inboundSecret).update(body).digest("hex");

    expect(adapter.verifySignature({ "x-bridge-signature": good }, body)).toBe(true);
    expect(adapter.verifySignature({ "x-bridge-signature": "deadbeef" }, body)).toBe(false);
    expect(adapter.verifySignature({}, body)).toBe(false);
    // 改一个字节就必须失败
    expect(adapter.verifySignature({ "x-bridge-signature": good }, `${body} `)).toBe(false);
  });
});

describe("入站解析", () => {
  it("正常事件解析为 InboundMessage", async () => {
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: fakeFetch(() => jsonResponse(200, {})).impl });

    const parsed = adapter.parseInbound({}, JSON.stringify({
      eventId: "e1",
      from: "wx-a",
      text: "完成 2",
      timestamp: 1_760_000_000_000,
    }));

    expect(parsed).toEqual({
      channelInstanceId: "inst-1",
      externalEventId: "e1",
      externalUserId: "wx-a",
      occurredAt: new Date(1_760_000_000_000),
      text: "完成 2",
    });
  });

  it("缺字段或不是 JSON 时返回 null，而不是抛异常", async () => {
    const adapter = createWechatBridgeAdapter({ ...BASE, fetchImpl: fakeFetch(() => jsonResponse(200, {})).impl });

    expect(adapter.parseInbound({}, "not json")).toBeNull();
    expect(adapter.parseInbound({}, JSON.stringify({ from: "wx-a", text: "x" }))).toBeNull();
    expect(adapter.parseInbound({}, JSON.stringify({ eventId: "e1", text: "x" }))).toBeNull();
    expect(adapter.parseInbound({}, JSON.stringify({ eventId: "e1", from: "wx-a" }))).toBeNull();
  });
});

describe("createTokenBucket", () => {
  it("按时间补充令牌", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 2, refillPerMinute: 60, now: () => now });

    expect(bucket.tryTake(now)).toBe(true);
    expect(bucket.tryTake(now)).toBe(true);
    expect(bucket.tryTake(now)).toBe(false);

    // 每分钟 60 个 → 每秒 1 个
    now = 1000;
    expect(bucket.tryTake(now)).toBe(true);
    expect(bucket.remaining(now)).toBe(0);
  });

  it("容量是上限，不会无限累积", () => {
    let now = 0;
    const bucket = createTokenBucket({ capacity: 3, refillPerMinute: 60, now: () => now });

    now = 60_000;
    expect(bucket.remaining(now)).toBe(3);
  });
});
