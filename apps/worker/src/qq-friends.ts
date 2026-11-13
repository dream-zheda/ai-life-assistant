import { createHash } from "node:crypto";
import { checkQqBot, oneBotCall, qqBotConfig, type OneBotFetchLike } from "@life/channels";
import { qqIdValid } from "@life/db";
import { prisma } from "./db";

/** Signed requests are durably queued; duplicate OneBot delivery shares a job ID. */
export async function enqueueQqFriendRequest(event: Record<string, unknown>, now: Date) {
  if (process.env.ONEBOT_AUTO_ACCEPT_FRIENDS !== "true") return "disabled";
  if (event.request_type !== "friend" || !qqIdValid(String(event.user_id)) ||
      typeof event.flag !== "string" || event.flag.length === 0 || event.flag.length > 1024) return "ignored";
  const id = "qq-friend-" + createHash("sha256").update(`${event.self_id}:${event.flag}`).digest("hex");
  const botId = String(event.self_id);
  await prisma.job.upsert({ where: { id }, update: {}, create: {
    id, type: "qq-accept-friend", runAt: now,
    payload: { flag: event.flag, botId, senderId: String(event.user_id), expiresAt: new Date(now.getTime() + 86400_000).toISOString() },
  } });
  return "queued";
}

export async function acceptQqFriendRequest(payload: unknown, now = new Date(), fetchImpl?: OneBotFetchLike) {
  if (process.env.ONEBOT_AUTO_ACCEPT_FRIENDS !== "true") return;
  const config = qqBotConfig();
  if (!config) throw new Error("QQ_NOT_CONFIGURED");
  const data = payload as { flag?: unknown; botId?: unknown; senderId?: unknown; expiresAt?: unknown } | null;
  if (!data || data.botId !== config.selfId || typeof data.flag !== "string" ||
      typeof data.senderId !== "string" || !qqIdValid(data.senderId) || typeof data.expiresAt !== "string") {
    throw new Error("INVALID_QQ_FRIEND_JOB");
  }
  const expiry = Date.parse(data.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= now.getTime()) return;
  await checkQqBot(config, fetchImpl);
  // If a previous attempt succeeded but its response was lost, don't approve twice.
  const friends = await oneBotCall(config, "get_friend_list", {}, fetchImpl);
  if (!Array.isArray(friends)) throw new Error("INVALID_QQ_FRIEND_LIST");
  if (friends.some(friend => friend && String(friend.user_id) === data.senderId)) return;
  await oneBotCall(config, "set_friend_add_request", { flag: data.flag, approve: true }, fetchImpl);
}
