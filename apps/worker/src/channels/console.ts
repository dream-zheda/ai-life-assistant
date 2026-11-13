import type {
  ChannelAdapter,
  ChannelPolicy,
  InboundMessage,
  OutboundMessage,
  SendOutcome,
} from "@life/channels";

/**
 * 控制台通道。
 *
 * 用途：在接入真实微信之前，把「派发 → 发送 → 记录」这条链路跑通并测试。
 * 它**不是**微信——任何用它得到的结论都只能说明业务链路通了，不能说明微信能用。
 */
export type ConsoleAdapter = ChannelAdapter & {
  sent: OutboundMessage[];
};

export function createConsoleAdapter(options: {
  policy: ChannelPolicy;
  sink?: (message: OutboundMessage) => void;
}): ConsoleAdapter {
  const sent: OutboundMessage[] = [];

  return {
    policy: options.policy,
    sent,
    async send(message: OutboundMessage): Promise<SendOutcome> {
      sent.push(message);
      options.sink?.(message);
      return { status: "accepted" };
    },
    verifySignature(): boolean {
      // 控制台通道没有签名，永远放行；真实通道必须实现校验
      return true;
    },
    parseInbound(): InboundMessage | null {
      return null;
    },
  };
}
