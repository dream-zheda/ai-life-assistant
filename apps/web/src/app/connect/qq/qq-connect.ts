import { checkQqBot, qqBotConfig } from "@life/channels";
import { prisma } from "../../../server/db";

export type QqStatus =
  | { configured: false }
  | { configured: true; reachable: false; error: string }
  | { configured: true; reachable: true; botUserId: string; nickname: string };

export async function loadQqStatus(): Promise<QqStatus> {
  const config = qqBotConfig();
  if (!config) return { configured: false };
  try {
    const { nickname } = await checkQqBot(config);
    return { configured: true, reachable: true, botUserId: config.selfId, nickname };
  } catch {
    return { configured: true, reachable: false, error: "机器人暂时离线，或登录账号与配置不一致。" };
  }
}

export async function loadQqBinding(userId: string) {
  const binding = await prisma.channelBinding.findUnique({
    where: { userId_channel: { userId, channel: "QQ_ONEBOT" } },
    select: { externalUserId: true, sessionState: true, verifiedAt: true, bridgeSessionId: true, lastInboundAt: true },
  });
  if (!binding) return null;
  return { qqNumber: binding.externalUserId, sessionState: binding.sessionState, lastInboundAt: binding.lastInboundAt,
    verified: binding.sessionState === "ACTIVE" && binding.verifiedAt !== null &&
      binding.bridgeSessionId !== null && binding.bridgeSessionId === process.env.ONEBOT_SELF_ID };
}
