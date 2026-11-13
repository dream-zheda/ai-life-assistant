/**
 * QQ 通道：OneBot 11 协议（NapCat / LLOneBot / Lagrange 等实现都支持）。
 *
 * 为什么选 OneBot 而不是 QQ 官方机器人：
 * 官方机器人要开发者认证、创建应用、申请单聊与主动消息权限，且主动消息有额度上限；
 * OneBot 是本地跑一个 QQ 客户端 + 注入，直接以好友身份发消息，没有窗口，接起来只要两个接口。
 *
 * 代价和微信一样：属于协议登录，违反 QQ 用户协议，账号可能被封。
 *
 * 我们只依赖最小的一组接口：
 *   POST {endpoint}/send_private_msg   body: {user_id, message}
 *   事件回调 POST 到我们的地址，带 X-Signature: sha1=<hmac-sha1 hex>
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { ChannelId } from "./policies.js";
import { CHANNEL_POLICIES, type ChannelPolicy } from "./policies.js";

import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  SendOptions,
  SendOutcome,
} from "./index.js";

export const ONEBOT_SIGNATURE_HEADER = "x-signature";

export type OneBotResponse = { status: number; text: () => Promise<string> };

export type OneBotFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<OneBotResponse>;

export type OneBotOptions = {
  /** OneBot HTTP 服务地址，例如 http://127.0.0.1:3000 */
  endpoint: string;
  /** access_token；NapCat 里配置的 token */
  token: string;
  /** 上报事件的签名密钥（OneBot 的 secret） */
  secret: string;
  /** 通道实例标识 */
  channelInstanceId: string;
  /** 机器人自己的 QQ 号，用于忽略自己发的消息 */
  selfId: string;
  timeoutMs?: number;
  fetchImpl?: OneBotFetchLike;
};

export type OneBotAdapter = ChannelAdapter & { readonly selfId: string };

/** OneBot 的 X-Signature 是 `sha1=` + HMAC-SHA1 的十六进制。 */
export function verifyOneBotSignature(secret: string, rawBody: string, provided: string): boolean {
  if (provided.length === 0) return false;
  const hex = provided.startsWith("sha1=") ? provided.slice(5) : provided;
  const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
  const a = Buffer.from(hex, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function defaultFetch(): OneBotFetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, text: () => response.text() };
  };
}

/** 从 OneBot 事件里取纯文本；数组段格式（CQ 码之外的现代格式）也兼容。 */
function textOf(message: unknown, raw: unknown): string | null {
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    const parts: string[] = [];
    for (const segment of message) {
      if (typeof segment === "object" && segment !== null) {
        const data = (segment as { data?: { text?: unknown } }).data;
        if (typeof data?.text === "string") parts.push(data.text);
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  }
  return null;
}

export function createOneBotAdapter(options: OneBotOptions): OneBotAdapter {
  const policy: ChannelPolicy = CHANNEL_POLICIES["qq-onebot" satisfies ChannelId];
  const doFetch = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const base = options.endpoint.replace(/\/+$/, "");
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${options.token}`,
  };

  return {
    policy,
    selfId: options.selfId,

    async send(message: OutboundMessage, _options?: SendOptions): Promise<SendOutcome> {
      const body = JSON.stringify({ user_id: Number(message.externalUserId), message: message.text, auto_escape: true });

      let response: OneBotResponse;
      try {
        response = await doFetch(`${base}/send_private_msg`, {
          method: "POST",
          headers,
          body,
          ...(typeof AbortSignal.timeout === "function"
            ? { signal: AbortSignal.timeout(timeoutMs) }
            : {}),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // 不确定消息是否已送达，只能报 unknown
        return { status: "unknown", code: `NETWORK:${reason.slice(0, 80)}` };
      }

      const raw = await response.text().catch(() => "");

      if (response.status === 401 || response.status === 403) {
        return { status: "failed", retryable: false, code: "ONEBOT_UNAUTHORIZED" };
      }
      if (response.status >= 500) {
        return { status: "failed", retryable: true, code: `HTTP_${response.status}` };
      }
      if (response.status < 200 || response.status >= 300) {
        return { status: "failed", retryable: response.status === 429, code: `HTTP_${response.status}` };
      }

      // OneBot 即使在 HTTP 200 时也可能返回 retcode != 0
      try {
        const parsed = JSON.parse(raw) as { status?: unknown; retcode?: unknown; data?: { message_id?: unknown } };
        if (parsed.retcode !== undefined && parsed.retcode !== 0) {
          return { status: "failed", retryable: true, code: `RETCODE_${String(parsed.retcode)}` };
        }
        if (parsed.status !== "ok" || parsed.retcode !== 0) {
          return { status: "unknown", code: "INVALID_ONEBOT_RESPONSE" };
        }
        const id = parsed.data?.message_id;
        return {
          status: "accepted",
          ...(typeof id === "number" || typeof id === "string" ? { externalMessageId: String(id) } : {}),
        };
      } catch {
        return { status: "unknown", code: "INVALID_ONEBOT_RESPONSE" };
      }
    },

    verifySignature(requestHeaders: Record<string, string>, rawBody: string): boolean {
      return verifyOneBotSignature(
        options.secret,
        rawBody,
        requestHeaders[ONEBOT_SIGNATURE_HEADER] ?? "",
      );
    },

    parseInbound(_headers: Record<string, string>, rawBody: string): InboundMessage | null {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        return null;
      }
      if (typeof payload !== "object" || payload === null) return null;

      const event = payload as Record<string, unknown>;
      // 只处理私聊消息；群消息直接忽略
      if (event["post_type"] !== "message") return null;
      if ((event["message_type"] ?? event["detail_type"]) !== "private") return null;

      const userId = event["user_id"];
      if (userId === undefined || userId === null) return null;
      const senderId = String(userId);
      if (senderId === options.selfId) return null;

      const text = textOf(event["message"], event["raw_message"]);
      if (text === null || text.length === 0) return null;

      const messageId = event["message_id"];
      const time = event["time"];
      const occurredAt =
        typeof time === "number" && Number.isFinite(time) ? new Date(time * 1000) : new Date(0);

      return {
        channelInstanceId: options.channelInstanceId,
        externalEventId: String(messageId ?? `${senderId}-${time ?? 0}`),
        externalUserId: senderId,
        occurredAt,
        text,
      };
    },
  };
}
