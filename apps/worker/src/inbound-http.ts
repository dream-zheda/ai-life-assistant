/**
 * 入站回调（两条通道共用一个 HTTP 端口）：
 *   POST /inbound      微信桥接（HMAC-SHA256，x-bridge-signature）
 *   POST /inbound/qq   QQ / OneBot 11（HMAC-SHA1，x-signature: sha1=…）
 *
 * 为什么放在 worker：通道收发本来就归 worker 管。
 * 放 web 里就要跨 app import 业务逻辑，还会把 worker 的依赖拖进 Next 构建。
 *
 * 安全要求（两条通道一致）：
 * 1. 必须校验签名，否则任何知道地址的人都能伪造用户消息
 * 2. 必须按 (bindingId, externalEventId) 去重，桥接会重试
 * 3. 未知发送者返回 202 而不是 404，避免暴露"这个号有没有绑定"
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  createOneBotAdapter,
  ONEBOT_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
  verifyHmac,
  verifyOneBotSignature,
} from "@life/channels";

import { prisma } from "./db";
import { handleInboundMessage } from "./inbound";
import { consumeQqLinkCode, qqIdValid } from "@life/db";
import { enqueueQqFriendRequest } from "./qq-friends";
import { replyToUser } from "./conversation";

export type InboundHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

export type InboundRequestInput = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  /** 未配置时拒绝一切（返回 503），绝不"默认放行" */
  secret: string | undefined;
  now?: Date;
  sendReply?: (externalUserId: string, text: string) => Promise<string>;
};

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const raw = headers[name];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

type InboundChannel = "WECHAT_PERSONAL_PROTOCOL" | "QQ_ONEBOT";

/**
 * 两条通道的公共部分：找绑定 → 去重落库 → 交给业务处理器 → 刷新会话状态。
 */
async function processInbound(params: {
  channel: InboundChannel;
  externalEventId: string;
  externalUserId: string;
  text: string;
  payload: unknown;
  now: Date;
  botId?: string;
  sendReply?: (externalUserId: string, text: string) => Promise<string>;
}): Promise<InboundHttpResult> {
  const binding = await prisma.channelBinding.findFirst({
    where: { channel: params.channel, externalUserId: params.externalUserId,
      user: { status: "ACTIVE" },
      ...(params.channel === "QQ_ONEBOT" ? { sessionState: "ACTIVE", verifiedAt: { not: null }, bridgeSessionId: params.botId ?? "" } : {}),
    },
    select: { id: true, userId: true },
  });

  if (binding === null) {
    // 202：收到了但忽略。用 404 会让探测者知道这个号有没有绑定
    return { status: 202, body: { accepted: false, reason: "unknown_sender" } };
  }

  let event: { id: string };
  try {
    event = await prisma.inboundEvent.create({
      data: {
        channelBindingId: binding.id,
        externalEventId: params.externalEventId,
        payload: params.payload as never,
      },
      select: { id: true },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { status: 200, body: { accepted: true, duplicate: true } };
    }
    throw error;
  }

  try {
    const result = await handleInboundMessage({
      userId: binding.userId,
      text: params.text,
      now: params.now,
    });

    let reply = result.reply;
    let replyAction: string = result.action;
    if (result.action === "unknown" && params.channel === "QQ_ONEBOT") {
      const conversation = await replyToUser({
        userId: binding.userId,
        bindingId: binding.id,
        text: params.text,
        now: params.now,
      });
      reply = conversation.reply;
      replyAction = "assistant_reply";
    }

    let replyStatus: string | undefined;
    if (reply && params.channel === "QQ_ONEBOT") {
      const config = {
        endpoint: process.env["ONEBOT_ENDPOINT"] ?? "http://127.0.0.1:3000",
        token: process.env["ONEBOT_TOKEN"] ?? "",
        secret: process.env["ONEBOT_SECRET"] ?? "",
        selfId: params.botId ?? "",
        channelInstanceId: params.botId ?? "onebot",
      };
      if (params.sendReply) replyStatus = await params.sendReply(params.externalUserId, reply);
      else {
        const adapter = createOneBotAdapter(config);
        let outbound = await adapter.send({ externalUserId: params.externalUserId, text: reply });
        for (let attempt = 0; outbound.status === "failed" && outbound.retryable && attempt < 2; attempt += 1) {
          outbound = await adapter.send({ externalUserId: params.externalUserId, text: reply });
        }
        replyStatus = outbound.status;
        if (outbound.status !== "accepted") console.error(`[worker] QQ reply was not accepted for user ${binding.userId}: ${outbound.status}${outbound.status === "failed" ? `/${outbound.code}` : ""}`);
      }
    }

    await prisma.$transaction([
      prisma.inboundEvent.update({ where: { id: event.id }, data: { processedAt: params.now } }),
      // 入站即证明账号还活着：刷新窗口输入并修正会话状态
      prisma.channelBinding.update({
        where: { id: binding.id },
        data: { lastInboundAt: params.now, sessionState: "ACTIVE", lastHeartbeatAt: params.now },
      }),
    ]);

    return { status: 200, body: { accepted: true, action: replyAction, ...(replyStatus ? { replyStatus } : {}) } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await prisma.inboundEvent.update({
      where: { id: event.id },
      data: { failureReason: reason.slice(0, 500) },
    });
    // 500 让桥接重试；failureReason 留给我们自己排查
    return { status: 500, body: { error: "handler_failed" } };
  }
}

/** 微信桥接：HMAC-SHA256 + 自定义 JSON。 */
export async function handleInboundRequest(input: InboundRequestInput): Promise<InboundHttpResult> {
  const now = input.now ?? new Date();

  if (input.secret === undefined || input.secret.length === 0) {
    return { status: 503, body: { error: "bridge_not_configured" } };
  }

  const signature = headerValue(input.headers, SIGNATURE_HEADER);
  if (!verifyHmac(input.secret, input.rawBody, signature)) {
    return { status: 401, body: { error: "bad_signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }
  if (typeof payload !== "object" || payload === null) {
    return { status: 400, body: { error: "bad_payload" } };
  }

  const record = payload as Record<string, unknown>;
  const eventId = record["eventId"];
  const from = record["from"];
  const text = record["text"];

  if (typeof eventId !== "string" || eventId.length === 0) {
    return { status: 400, body: { error: "missing_event_id" } };
  }
  if (typeof from !== "string" || from.length === 0) {
    return { status: 400, body: { error: "missing_sender" } };
  }
  if (typeof text !== "string") {
    return { status: 400, body: { error: "missing_text" } };
  }

  return processInbound({
    channel: "WECHAT_PERSONAL_PROTOCOL",
    externalEventId: eventId,
    externalUserId: from,
    text,
    payload,
    now,
  });
}

/** QQ / OneBot 11：HMAC-SHA1（x-signature: sha1=…）+ 事件推送格式。 */
export async function handleQqInboundRequest(input: InboundRequestInput): Promise<InboundHttpResult> {
  const now = input.now ?? new Date();
  const secret = input.secret;

  if (secret === undefined || secret.length === 0) {
    return { status: 503, body: { error: "qq_not_configured" } };
  }

  const signature = headerValue(input.headers, ONEBOT_SIGNATURE_HEADER);
  if (!verifyOneBotSignature(secret, input.rawBody, signature)) {
    return { status: 401, body: { error: "bad_signature" } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }

  // 复用适配器的解析逻辑：它已经处理了消息段格式、群聊过滤、自己发的消息
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { status: 400, body: { error: "bad_payload" } };
  }
  const event = payload as Record<string, unknown>;
  const botId = process.env.ONEBOT_SELF_ID ?? "";
  if (!qqIdValid(botId)) return { status: 503, body: { error: "qq_bot_not_configured" } };
  if (String(event.self_id) !== botId) return { status: 403, body: { error: "wrong_bot" } };
  if (event.post_type === "request") {
    const result = await enqueueQqFriendRequest(event, now);
    return { status: 200, body: { accepted: result === "queued", action: `friend_${result}` } };
  }
  const adapter = createOneBotAdapter({
    endpoint: process.env["ONEBOT_ENDPOINT"] ?? "http://127.0.0.1:3000",
    token: process.env["ONEBOT_TOKEN"] ?? "",
    secret,
    channelInstanceId: process.env["ONEBOT_SELF_ID"] ?? "onebot",
    selfId: process.env["ONEBOT_SELF_ID"] ?? "",
  });

  const parsed = adapter.parseInbound({}, input.rawBody);
  if (parsed === null) {
    // 群消息、通知事件、空文本等：正常忽略，不是错误
    return { status: 200, body: { accepted: false, reason: "ignored_event" } };
  }

  // Temporary/group-private sessions cannot claim an account. Friend requests themselves never bind users.
  if ((event.message_type ?? event.detail_type) !== "private" || event.sub_type !== "friend" ||
      !qqIdValid(parsed.externalUserId) || event.message_id === undefined) {
    return { status: 200, body: { accepted: false, reason: "not_friend_private" } };
  }
  const match = /^绑定\s+([A-F0-9]{16})$/i.exec(parsed.text.trim());
  if (match?.[1]) {
    const bound = await consumeQqLinkCode(match[1].toUpperCase(), parsed.externalUserId, botId, now);
    // Never store the raw binding command in inbound_events or conversation history.
    if (bound) {
      const adapter = createOneBotAdapter({ endpoint: process.env["ONEBOT_ENDPOINT"] ?? "http://127.0.0.1:3000", token: process.env["ONEBOT_TOKEN"] ?? "", secret, selfId: botId, channelInstanceId: botId });
      const confirmation = "QQ 已成功绑定。之后你可以直接和我聊天，也可以回复提醒来更新计划进度。";
      if (input.sendReply) await input.sendReply(parsed.externalUserId, confirmation);
      else await adapter.send({ externalUserId: parsed.externalUserId, text: confirmation });
    }
    return { status: 200, body: { accepted: bound, action: bound ? "qq_bound" : "binding_rejected" } };
  }

  return processInbound({
    channel: "QQ_ONEBOT",
    externalEventId: parsed.externalEventId,
    externalUserId: parsed.externalUserId,
    text: parsed.text,
    payload,
    now,
    botId,
    ...(input.sendReply ? { sendReply: input.sendReply } : {}),
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function readBody(request: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limitBytes) throw new Error("payload_too_large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export type InboundServerOptions = {
  port: number;
  /** 微信桥接的 HMAC 密钥；未配置时 /inbound 返回 503 */
  wechatSecret?: string | undefined;
  /** QQ 的 HMAC-SHA1 密钥；未配置时 /inbound/qq 返回 503 */
  qqSecret?: string | undefined;
  host?: string;
  now?: () => Date;
};

export function createInboundServer(options: InboundServerOptions): Server {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const url = request.url ?? "";
      const isWechat = url === "/inbound";
      const isQq = url === "/inbound/qq";

      if (request.method !== "POST" || (!isWechat && !isQq)) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      let rawBody: string;
      try {
        rawBody = await readBody(request);
      } catch {
        response.writeHead(413, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "payload_too_large" }));
        return;
      }

      const result = isQq
        ? await handleQqInboundRequest({
            headers: request.headers,
            rawBody,
            secret: options.qqSecret,
            ...(options.now ? { now: options.now() } : {}),
          })
        : await handleInboundRequest({
            headers: request.headers,
            rawBody,
            secret: options.wechatSecret,
            ...(options.now ? { now: options.now() } : {}),
          });

      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "internal" }));
    });
  });
}
