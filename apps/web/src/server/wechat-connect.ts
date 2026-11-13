import {
  createWechatyClientFromEnv,
  type WechatyBridgeClient,
  type WechatyStatus,
} from "@life/channels";

import { prisma } from "./db";

/**
 * 扫码连接个人微信。
 *
 * 分工：wechaty 桥接服务负责登录与二维码，我们只负责
 * 「展示状态」和「登录成功后把账号记到自己的库里」。
 * **我们全程不接触密码，也拿不到任何凭据**——桥接服务持有会话。
 */

export type ConnectState =
  | { configured: false }
  | { configured: true; reachable: false }
  | { configured: true; reachable: true; status: WechatyStatus };

export type BindingInfo = {
  externalUserId: string;
  displayName: string | null;
  sessionState: string;
  lastInboundAt: Date | null;
};

export function bridgeClient(): WechatyBridgeClient | null {
  return createWechatyClientFromEnv();
}

export async function loadConnectState(): Promise<ConnectState> {
  const client = bridgeClient();
  if (client === null) return { configured: false };

  const status = await client.getStatus();
  if (status === null) return { configured: true, reachable: false };
  return { configured: true, reachable: true, status };
}

export async function loadBinding(userId: string): Promise<BindingInfo | null> {
  const binding = await prisma.channelBinding.findFirst({
    where: { userId, channel: "WECHAT_PERSONAL_PROTOCOL" },
    select: {
      externalUserId: true,
      externalDisplayName: true,
      sessionState: true,
      lastInboundAt: true,
    },
  });

  if (binding === null) return null;
  return {
    externalUserId: binding.externalUserId,
    displayName: binding.externalDisplayName,
    sessionState: binding.sessionState,
    lastInboundAt: binding.lastInboundAt,
  };
}

export type BindResult =
  | { ok: true }
  | { ok: false; reason: "already_bound_by_other" | "not_logged_in" };

/**
 * 把桥接服务当前登录的账号绑定到本用户。
 *
 * 为什么由服务端读桥接状态而不是让前端传 wxid：
 * 否则用户可以把任意 wxid 绑到自己名下——那等于允许冒充别人的账号收消息。
 */
export async function bindCurrentBridgeAccount(userId: string): Promise<BindResult> {
  const state = await loadConnectState();
  if (!state.configured || !state.reachable || state.status.state !== "logged_in") {
    return { ok: false, reason: "not_logged_in" };
  }

  const accountId = state.status.accountId;
  const displayName = state.status.displayName ?? null;

  const existing = await prisma.channelBinding.findFirst({
    where: {
      channel: "WECHAT_PERSONAL_PROTOCOL",
      externalUserId: accountId,
      NOT: { userId },
    },
    select: { id: true },
  });
  if (existing !== null) return { ok: false, reason: "already_bound_by_other" };

  await prisma.channelBinding.upsert({
    where: { userId_channel: { userId, channel: "WECHAT_PERSONAL_PROTOCOL" } },
    create: {
      userId,
      channel: "WECHAT_PERSONAL_PROTOCOL",
      externalUserId: accountId,
      externalDisplayName: displayName,
      bridgeSessionId: accountId,
      sessionState: "ACTIVE",
      verifiedAt: new Date(),
    },
    update: {
      externalUserId: accountId,
      externalDisplayName: displayName,
      bridgeSessionId: accountId,
      sessionState: "ACTIVE",
      verifiedAt: new Date(),
    },
  });

  return { ok: true };
}

/** 解绑并通知桥接服务退出登录。两者都要做：只解绑会让账号继续登录着。 */
export async function disconnectWechat(userId: string): Promise<{ bridgeLoggedOut: boolean }> {
  await prisma.channelBinding.updateMany({
    where: { userId, channel: "WECHAT_PERSONAL_PROTOCOL" },
    data: { sessionState: "DISCONNECTED", disconnectedReason: "用户主动解绑" },
  });

  const client = bridgeClient();
  const bridgeLoggedOut = client === null ? false : await client.logout();
  return { bridgeLoggedOut };
}

/** 重新拉起桥接的登录流程，用于二维码过期或登录被拒之后重试。 */
export async function restartBridgeLogin(): Promise<boolean> {
  const client = bridgeClient();
  if (client === null) return false;
  return client.relogin();
}
