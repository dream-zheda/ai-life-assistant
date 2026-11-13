import { createHmac } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "../src/db";
import { handleQqInboundRequest as handleQqInboundRequestImpl } from "../src/inbound-http";

/**
 * QQ（OneBot 11）入站回调的集成测试。
 *
 * 与微信的区别：签名是 HMAC-SHA1（`sha1=` 前缀），事件是 OneBot 格式，
 * 绑定按 QQ_ONEBOT + 发送者 QQ 号查。
 */

const SECRET = "qq-test-secret";
const USER = "int-qq-user";
const QQ = "10001";
const NOW = new Date("2026-11-03T10:00:00+08:00");
const sentReplies: string[] = [];

function handleQqInboundRequest(input: Parameters<typeof handleQqInboundRequestImpl>[0]) {
  return handleQqInboundRequestImpl({ ...input, sendReply: async (_userId, text) => { sentReplies.push(text); return "accepted"; } });
}

function signed(body: string, secret = SECRET): string {
  return `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`;
}

function eventBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    self_id: 3463802115,
    user_id: Number(QQ),
    raw_message: "帮助",
    message_id: 9001,
    time: Math.floor(NOW.getTime() / 1000),
    ...overrides,
  });
}

beforeAll(async () => {
  vi.stubEnv("ONEBOT_SELF_ID", "3463802115");
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.user.create({ data: { id: USER, email: "qq@int.test", timeZone: "Asia/Shanghai" } });
});

beforeEach(async () => {
  sentReplies.length = 0;
  await prisma.channelBinding.deleteMany({ where: { userId: USER } });
  await prisma.channelBinding.create({
    data: {
      userId: USER,
      channel: "QQ_ONEBOT",
      externalUserId: QQ,
      sessionState: "ACTIVE",
      verifiedAt: NOW,
      bridgeSessionId: "3463802115",
    },
  });
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("handleQqInboundRequest", () => {
  it("没配置密钥时 503", async () => {
    const result = await handleQqInboundRequest({
      headers: {},
      rawBody: eventBody(),
      secret: undefined,
    });
    expect(result.status).toBe(503);
  });

  it("签名不对 401，且不落库", async () => {
    const body = eventBody({ message_id: 9100 });
    const result = await handleQqInboundRequest({
      headers: { "x-signature": signed(body, "wrong") },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });
    expect(result.status).toBe(401);
    expect(await prisma.inboundEvent.count({ where: { externalEventId: "9100" } })).toBe(0);
  });

  it("合法私聊消息：落库、处理、刷新 lastInboundAt", async () => {
    const body = eventBody({ message_id: 9002 });
    const result = await handleQqInboundRequest({
      headers: { "x-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: true, action: "help" });
    expect(sentReplies.at(-1)).toContain("回复 1 / 2 / 3");

    const binding = await prisma.channelBinding.findFirstOrThrow({ where: { userId: USER } });
    expect(binding.lastInboundAt?.getTime()).toBe(NOW.getTime());
    expect(binding.sessionState).toBe("ACTIVE");

    const events = await prisma.inboundEvent.findMany({ where: { channelBindingId: binding.id } });
    expect(events).toHaveLength(1);
    expect(events[0]?.processedAt?.getTime()).toBe(NOW.getTime());
  });

  it("群消息被忽略但返回 200（不是错误）", async () => {
    const body = eventBody({ message_type: "group", message_id: 9003 });
    const result = await handleQqInboundRequest({
      headers: { "x-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ accepted: false, reason: "ignored_event" });
  });

  it("未绑定的 QQ 号返回 202", async () => {
    const body = eventBody({ user_id: 99999, message_id: 9004 });
    const result = await handleQqInboundRequest({
      headers: { "x-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ accepted: false, reason: "unknown_sender" });
  });

  it("重复投递只处理一次", async () => {
    const body = eventBody({ message_id: 9005 });

    const first = await handleQqInboundRequest({
      headers: { "x-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });
    const second = await handleQqInboundRequest({
      headers: { "x-signature": signed(body) },
      rawBody: body,
      secret: SECRET,
      now: NOW,
    });

    expect(first.status).toBe(200);
    expect(second.body).toMatchObject({ accepted: true, duplicate: true });
  });
});
