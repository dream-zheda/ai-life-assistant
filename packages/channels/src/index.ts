/**
 * 通道抽象：策略 + 适配器契约。
 *
 * 策略部分在 policies.ts（纯函数，无依赖），适配器实现各自独立。
 * 这样做的原因：策略要被 worker、web、测试同时使用，
 * 而适配器会引入各自的传输细节（HTTP、桥接协议），不该被一起拖进来。
 */

import type { ChannelPolicy } from "./policies.js";

export * from "./policies.js";

// ---------------------------------------------------------------------------
// 通道适配器契约
// ---------------------------------------------------------------------------

export type InboundMessage = {
  channelInstanceId: string;
  /** 通道侧的事件 ID，用于幂等去重。 */
  externalEventId: string;
  externalUserId: string;
  occurredAt: Date;
  text: string;
};

export type OutboundMessage = {
  externalUserId: string;
  text: string;
};

/**
 * 发送结果必须区分「已接受」与「已送达」。
 *
 * 规划书 §12：通道接受请求只记为"已接受"，没有送达证据不得宣称用户已收到。
 */
export type SendOutcome =
  | { status: "accepted"; externalMessageId?: string }
  | { status: "failed"; retryable: boolean; code: string }
  | { status: "unknown"; code: string };

export type SendOptions = {
  /** 幂等键：桥接服务据此去重，避免重试造成重复消息。 */
  idempotencyKey?: string;
};

export interface ChannelAdapter {
  readonly policy: ChannelPolicy;
  send(message: OutboundMessage, options?: SendOptions): Promise<SendOutcome>;
  /**
   * 校验回调签名。返回 false 时调用方必须拒绝处理，且不得回显任何业务信息。
   */
  verifySignature(headers: Record<string, string>, rawBody: string): boolean;
  parseInbound(headers: Record<string, string>, rawBody: string): InboundMessage | null;
}

export * from "./onebot.js";
export * from "./onebot-api.js";
export * from "./rate-limit.js";
export * from "./render.js";
export * from "./reply.js";
export * from "./wechat-bridge.js";
export * from "./wechaty-client.js";
