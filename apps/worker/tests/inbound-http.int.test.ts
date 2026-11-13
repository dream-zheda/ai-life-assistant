import { createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { prisma } from "../src/db";

import { handleInboundRequest } from "../src/inbound-http";

/**
 * 入站 webhook 的集成测试。
 *
 * 这是真实桥接接入前唯一能验证的部分：签名、去重、绑定解析、状态刷新。
 * 真正的微信消息能否到达，只能等有真账号与桥接服务时验证。
 */

const SECRET = "test-inbound-secret";
const USER = "int-inbound-user";
const WXID = "wx-inbound-alice";
const NOW = new Date("2026-11-03T09:00:00+08:00");

function signed(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventId: "evt-1",
    from: WXID,
    text: "帮助",
    timestamp: NOW.getTime(),
    ...overrides,
  });
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.user.create({
    data: { id: USER, email: "inbound@int.test", timeZone: "Asia/Shanghai" },
  });
});

beforeEach(async () => {
  await prisma.channelBinding.deleteMany({ where: { userId: USER } });
  await prisma.channelBinding.create({
    data: {
      userId: USER,
      channel: "WECHAT_PERSONAL_PROTOCOL",
      externalUserId: WXID,
      sessionState: "ACTIVE",
    },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("handleInboundRequest", () => {
  it("没有配置密钥时拒绝一切（503），不默认放行", async () => {
    const result = await handleInboundRequest({
      headers: {},
      rawBody: eventBody(),
      secret: undefined,
    });

    expect(result.status).toBe(503);
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it("签名不对返回 401，且不写入任何事件", async () => {
    const body = eventBody();
    const result = await handleInboundRequest({
      headers: { "x-bridge-signature": signed(body, "wrong-secret") },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(result.status).toBe(401);
    expect(await prisma.inboundEvent.count({ where: { payload: { path: ["eventId"], equals: "evt-1" } } })).toBe(0);
  });

  it("签名缺失同样拒绝", async () => {
    const result = await handleInboundRequest({
      headers: {},
      rawBody: eventBody(),
      secret: SECRET,
      now: NOW,
    });
    expect(result.status).toBe(401);
  });

  it("未绑定的发送者返回 202，且不落库（避免暴露绑定关系）", async () => {
    const body = eventBody({ from: "wx-stranger" });
    const result = await handleInboundRequest({
      headers: { "x-bridge-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ accepted: false, reason: "unknown_sender" });
    expect(await prisma.inboundEvent.count()).toBe(0);
  });

  it("合法事件：落库、调用处理器、刷新 lastInboundAt", async () => {
    const body = eventBody();
    const result = await handleInboundRequest({
      headers: { "x-bridge-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: true, action: "help" });

    const binding = await prisma.channelBinding.findFirstOrThrow({ where: { userId: USER } });
    expect(binding.lastInboundAt?.getTime()).toBe(NOW.getTime());
    expect(binding.sessionState).toBe("ACTIVE");

    const events = await prisma.inboundEvent.findMany({ where: { channelBindingId: binding.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.processedAt?.getTime()).toBe(NOW.getTime());
    expect(events[0]?.failureReason).toBeNull();
  });

  it("重复投递同一个 eventId 只处理一次", async () => {
    const body = eventBody({ eventId: "evt-dup" });

    const first = await handleInboundRequest({
      headers: { "x-bridge-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });
    const second = await handleInboundRequest({
      headers: { "x-bridge-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ accepted: true, duplicate: true });

    const binding = await prisma.channelBinding.findFirstOrThrow({ where: { userId: USER } });
    expect(await prisma.inboundEvent.count({ where: { channelBindingId: binding.id } })).toBe(1);
  });

  it("签名正确但内容畸形时返回 400", async () => {
    for (const body of ["not json", JSON.stringify({ from: WXID, text: "x" }), JSON.stringify({ eventId: "e", from: WXID })]) {
      const result = await handleInboundRequest({
        headers: { "x-bridge-signature": signed(body) },
        rawBody: body,
        secret: SECRET,
        now: NOW,
      });
      expect(result.status).toBe(400);
    }
  });
});
