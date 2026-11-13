import { createHash, randomBytes } from "node:crypto";

import { prisma } from "./db";

/**
 * 邀请码。
 *
 * 设计要点：
 * - 数据库只存 **sha256 摘要**，明文只在创建时返回一次。库被读走也拿不到可用的码。
 * - 一次性：`usedAt` 非空即失效；并发注册靠 `updateMany` 的条件更新兜底。
 * - 引导（bootstrap）：库里一个用户都没有时，允许无邀请码注册，并把第一个用户设为 ADMIN。
 *   否则会陷入"要邀请码才能注册，但没人能创建邀请码"的死锁。
 */

export const INVITE_TOKEN_PREFIX = "iv_";
export const DEFAULT_INVITE_TTL_HOURS = 72;

export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateInviteToken(): string {
  return `${INVITE_TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
}

export class InviteError extends Error {
  readonly code: "not_found" | "used" | "expired" | "unavailable" | "missing";
  constructor(code: InviteError["code"], message: string) {
    super(message);
    this.name = "InviteError";
    this.code = code;
  }
}

export type CreatedInvite = {
  token: string;
  inviteId: string;
  expiresAt: Date;
};

/**
 * 创建邀请码。必须指定创建者（管理员）的邮箱，便于审计。
 */
export async function createInvite(options: {
  createdByEmail: string;
  expiresInHours?: number;
  email?: string;
}): Promise<CreatedInvite> {
  const creator = await prisma.user.findUnique({
    where: { email: options.createdByEmail },
    select: { id: true },
  });
  if (creator === null) {
    throw new InviteError("not_found", `创建者 ${options.createdByEmail} 不存在`);
  }

  const token = generateInviteToken();
  const expiresAt = new Date(
    Date.now() + (options.expiresInHours ?? DEFAULT_INVITE_TTL_HOURS) * 60 * 60 * 1000,
  );

  const invite = await prisma.invite.create({
    data: {
      tokenHash: hashInviteToken(token),
      createdById: creator.id,
      expiresAt,
      ...(options.email === undefined ? {} : { email: options.email }),
    },
    select: { id: true },
  });

  return { token, inviteId: invite.id, expiresAt };
}

/**
 * 消费邀请码。成功返回 inviteId；失败抛出可区分的 InviteError。
 *
 * 用带条件的 `updateMany` 而不是"先查后写"：并发下只有一个请求能把
 * `usedAt` 从 NULL 改成时间戳。
 */
export async function consumeInvite(token: string): Promise<string> {
  const tokenHash = hashInviteToken(token);
  const now = new Date();

  const invite = await prisma.invite.findUnique({
    where: { tokenHash },
    select: { id: true, usedAt: true, expiresAt: true },
  });

  if (invite === null) throw new InviteError("not_found", "邀请码无效");
  if (invite.usedAt !== null) throw new InviteError("used", "邀请码已被使用");
  if (invite.expiresAt.getTime() <= now.getTime()) {
    throw new InviteError("expired", "邀请码已过期");
  }

  const claimed = await prisma.invite.updateMany({
    where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now },
  });

  if (claimed.count === 0) {
    throw new InviteError("unavailable", "邀请码不可用（可能刚被他人使用）");
  }

  return invite.id;
}

/** 把已消费的邀请码关联到新用户，便于审计「谁邀请了谁」。 */
export async function attributeInvite(token: string, userId: string): Promise<void> {
  await prisma.invite.updateMany({
    where: { tokenHash: hashInviteToken(token), usedAt: { not: null }, usedById: null },
    data: { usedById: userId },
  });
}

export async function isBootstrapWindow(): Promise<boolean> {
  return (await prisma.user.count()) === 0;
}

/**
 * 从请求头里取邀请码。
 *
 * `context` 是 Better Auth 的 GenericEndpointContext，headers 可能是 Headers 实例，
 * 也可能是普通对象，这里两种都兼容。
 */
export function readInviteToken(context: unknown): string | null {
  if (context === null || typeof context !== "object") return null;
  const headers = (context as { headers?: unknown }).headers;
  if (headers === null || headers === undefined) return null;

  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers).get("x-invite-token");
    return value === null || value.length === 0 ? null : value;
  }

  if (typeof headers === "object") {
    const record = headers as Record<string, unknown>;
    const value = record["x-invite-token"] ?? record["X-Invite-Token"];
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  return null;
}
