/**
 * 个人微信「协议登录」通道的桥接适配器。
 *
 * ⚠️ 合规前提（务必先读 docs/decisions/ADR-009）：
 * 用第三方协议登录个人微信号**违反《微信个人账号使用规范》1.2.6**，
 * 账号可能被限制功能直至永久封禁。本模块不改变这个事实，只是把风险收敛到可控：
 *
 * 1. **绝不接触密码。** 登录由桥接服务完成（扫码），我们只保存会话引用。
 * 2. **发送限速。** 突发高频是最典型的封号画像，所以内置令牌桶。
 * 3. **必带降级。** 账号随时可能死，调用方必须准备别的通道。
 *
 * 桥接服务需要实现的契约（两边都要实现，缺一不可）：
 *
 *   我方 → 桥接：POST {endpoint}/messages
 *     headers: authorization: Bearer <token>, content-type: application/json
 *     body:    { accountId, to, text, idempotencyKey }
 *     200/201: { id?: string }
 *
 *   桥接 → 我方：POST <我们的 webhook>
 *     headers: x-bridge-signature: <hex hmac-sha256 of raw body>
 *     body:    { eventId, from, text, timestamp }
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import type { ChannelId } from "./policies.js";
import { CHANNEL_POLICIES, type ChannelPolicy } from "./policies.js";
import { createTokenBucket, type TokenBucket } from "./rate-limit.js";

// 类型从 index 取会被擦除，不会造成运行时循环依赖
import type {
  ChannelAdapter,
  InboundMessage,
  OutboundMessage,
  SendOptions,
  SendOutcome,
} from "./index.js";

export type BridgeResponse = {
  status: number;
  text: () => Promise<string>;
};

export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<BridgeResponse>;

export type WechatBridgeOptions = {
  /** 桥接服务基址，例如 http://127.0.0.1:8788 */
  endpoint: string;
  /** 我方调用桥接服务的凭据 */
  token: string;
  /** 桥接服务回调我方时的 HMAC 密钥 */
  inboundSecret: string;
  /** 通道实例标识（多账号部署时区分） */
  channelInstanceId: string;
  /** 该用户在桥接服务侧的账号标识 */
  accountId: string;
  /** 每分钟最多发多少条。默认 6，留足余量。 */
  sendsPerMinute?: number;
  /** 单次请求超时。默认 10 秒。 */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
};

export const SIGNATURE_HEADER = "x-bridge-signature";

/**
 * 校验桥接服务回调的 HMAC-SHA256 签名。
 *
 * 单独导出，因为 worker 的 webhook 与 adapter 都要用它——
 * 两处各写一遍就会出现"一边对一边错"的经典事故。
 */
export function verifyHmac(secret: string, rawBody: string, providedHex: string): boolean {
  if (providedHex.length === 0) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(providedHex, "utf8");
  const b = Buffer.from(expected, "utf8");
  // 长度不等时 timingSafeEqual 会抛错，先挡掉
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function defaultFetch(): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, text: () => response.text() };
  };
}

export type WechatBridgeAdapter = ChannelAdapter & {
  readonly accountId: string;
  /** 当前是否还有发送额度（用于调用方提前降级，而不是等失败）。 */
  canSendNow(): boolean;
};

export function createWechatBridgeAdapter(options: WechatBridgeOptions): WechatBridgeAdapter {
  const policy: ChannelPolicy = CHANNEL_POLICIES["wechat-personal-protocol" satisfies ChannelId];
  const doFetch = options.fetchImpl ?? defaultFetch();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const bucket: TokenBucket = createTokenBucket({
    capacity: options.sendsPerMinute ?? 6,
    refillPerMinute: options.sendsPerMinute ?? 6,
    now,
  });

  const to = (path: string): string => `${options.endpoint.replace(/\/+$/, "")}${path}`;

  return {
    policy,
    accountId: options.accountId,

    canSendNow(): boolean {
      return bucket.remaining(now()) > 0;
    },

    async send(message: OutboundMessage, extra?: SendOptions): Promise<SendOutcome> {
      // 限速在本地拦，不要等服务端 429——高频失败本身也会被风控记一笔
      if (!bucket.tryTake(now())) {
        return { status: "failed", retryable: true, code: "LOCAL_RATE_LIMITED" };
      }

      const body = JSON.stringify({
        accountId: options.accountId,
        to: message.externalUserId,
        text: message.text,
        idempotencyKey: extra?.idempotencyKey ?? null,
      });

      let response: BridgeResponse;
      try {
        response = await doFetch(to("/messages"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${options.token}`,
          },
          body,
          ...(typeof AbortSignal.timeout === "function"
            ? { signal: AbortSignal.timeout(timeoutMs) }
            : {}),
        });
      } catch (error) {
        // 网络层失败：我们不知道消息有没有出去，必须报 unknown 而不是 failed
        const message = error instanceof Error ? error.message : String(error);
        return { status: "unknown", code: `NETWORK:${message.slice(0, 80)}` };
      }

      if (response.status === 200 || response.status === 201) {
        const raw = await response.text().catch(() => "");
        let externalMessageId: string | undefined;
        try {
          const parsed = JSON.parse(raw) as { id?: unknown };
          if (typeof parsed.id === "string") externalMessageId = parsed.id;
        } catch {
          // 响应体不是 JSON 也不影响"已接受"的判定
        }
        return { status: "accepted", ...(externalMessageId ? { externalMessageId } : {}) };
      }

      if (response.status === 429 || response.status >= 500) {
        return { status: "failed", retryable: true, code: `HTTP_${response.status}` };
      }

      if (response.status === 401 || response.status === 403) {
        // 凭据失效：重试没有意义，而且继续重试可能加重风控
        return { status: "failed", retryable: false, code: "BRIDGE_UNAUTHORIZED" };
      }

      return { status: "failed", retryable: false, code: `HTTP_${response.status}` };
    },

    verifySignature(headers: Record<string, string>, rawBody: string): boolean {
      return verifyHmac(options.inboundSecret, rawBody, headers[SIGNATURE_HEADER] ?? "");
    },

    parseInbound(_headers: Record<string, string>, rawBody: string): InboundMessage | null {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return null;
      }

      if (typeof parsed !== "object" || parsed === null) return null;
      const payload = parsed as Record<string, unknown>;

      const eventId = payload["eventId"];
      const from = payload["from"];
      const text = payload["text"];
      if (typeof eventId !== "string" || eventId.length === 0) return null;
      if (typeof from !== "string" || from.length === 0) return null;
      if (typeof text !== "string") return null;

      const timestamp = payload["timestamp"];
      const occurredAt =
        typeof timestamp === "number" && Number.isFinite(timestamp)
          ? new Date(timestamp)
          : new Date(0);

      return {
        channelInstanceId: options.channelInstanceId,
        externalEventId: eventId,
        externalUserId: from,
        occurredAt,
        text,
      };
    },
  };
}
