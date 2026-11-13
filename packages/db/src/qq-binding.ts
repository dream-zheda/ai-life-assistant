import { createHash, randomBytes } from "node:crypto";
import { getPrismaClient } from "./index.js";

const hash = (code: string) => createHash("sha256").update(code).digest("hex");
export const qqIdValid = (value: string): boolean => /^[1-9]\d{4,11}$/.test(value);

export class QqBindingError extends Error {}

export async function issueQqLinkCode(userId: string, botId: string, now = new Date()) {
  if (!qqIdValid(botId)) throw new QqBindingError("机器人尚未配置，请联系管理员。");
  return getPrismaClient().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (user?.status !== "ACTIVE") throw new QqBindingError("账号不可用。");
    const current = await tx.qqLinkCode.findUnique({ where: { userId } });
    if (current && now.getTime() - current.createdAt.getTime() < 30_000) {
      throw new QqBindingError("请等待 30 秒后再领取新绑定码。");
    }
    const code = randomBytes(8).toString("hex").toUpperCase();
    const expiresAt = new Date(now.getTime() + 10 * 60_000);
    const data = { codeHash: hash(code), botId, createdAt: now, expiresAt, consumedAt: null };
    await tx.qqLinkCode.upsert({ where: { userId }, create: { userId, ...data }, update: data });
    return { code, expiresAt: expiresAt.toISOString() };
  });
}

/** Only call after verifying the webhook signature, bot identity and friend-private subtype. */
export async function consumeQqLinkCode(code: string, senderId: string, botId: string, now = new Date()) {
  if (!qqIdValid(senderId) || senderId === botId || !/^[A-F0-9]{16}$/.test(code)) return false;
  const db = getPrismaClient();
  const candidate = await db.qqLinkCode.findUnique({ where: { codeHash: hash(code) } });
  if (!candidate) return false;
  try {
    return await db.$transaction(async tx => {
      // Same lock order as issuing / unlinking: invalidation and consumption are atomic.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.userId} FOR UPDATE`;
      const token = await tx.qqLinkCode.findUnique({ where: { userId: candidate.userId } });
      const user = await tx.user.findUnique({ where: { id: candidate.userId } });
      if (!token || token.codeHash !== hash(code) || token.botId !== botId || token.consumedAt ||
          token.expiresAt <= now || user?.status !== "ACTIVE") return false;
      const occupied = await tx.channelBinding.findUnique({
        where: { channel_externalUserId: { channel: "QQ_ONEBOT", externalUserId: senderId } },
      });
      if (occupied && occupied.userId !== token.userId) return false;
      const existing = await tx.channelBinding.findUnique({
        where: { userId_channel: { userId: token.userId, channel: "QQ_ONEBOT" } },
      });
      // A different previously verified QQ must be explicitly unlinked first.
      if (existing?.bridgeSessionId && existing.externalUserId !== senderId) return false;
      const data = { externalUserId: senderId, bridgeSessionId: botId, sessionState: "ACTIVE" as const,
        verifiedAt: now, lastInboundAt: now, lastHeartbeatAt: now, disconnectedReason: null };
      await tx.channelBinding.upsert({
        where: { userId_channel: { userId: token.userId, channel: "QQ_ONEBOT" } },
        create: { userId: token.userId, channel: "QQ_ONEBOT", ...data }, update: data,
      });
      await tx.qqLinkCode.update({ where: { userId: token.userId }, data: { consumedAt: now } });
      return true;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }
}

export async function unlinkQq(userId: string) {
  await getPrismaClient().$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    await tx.qqLinkCode.deleteMany({ where: { userId } });
    await tx.channelBinding.deleteMany({ where: { userId, channel: "QQ_ONEBOT" } });
  });
}
