import { prisma } from "./db";

/**
 * 邀请码的管理视图。
 *
 * 安全约定：**永远不返回 tokenHash**。管理界面只能看到"有这条邀请"，
 * 看不到任何可用于兑换的凭据（明文只在创建时出现一次）。
 */

export type InviteStatus = "pending" | "used" | "expired" | "revoked";

export type InviteListItem = {
  id: string;
  /** 预填的收件邮箱（可选，未强制校验）。 */
  email: string | null;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  createdByEmail: string;
  usedByEmail: string | null;
  status: InviteStatus;
  /** 距离过期的天数，已过期/已用为 null。 */
  daysLeft: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function inviteStatus(
  row: { usedAt: Date | null; expiresAt: Date },
  now: Date,
): InviteStatus {
  if (row.usedAt !== null) return "used";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "pending";
}

export async function listInvites(now: Date = new Date()): Promise<InviteListItem[]> {
  const rows = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      createdAt: true,
      expiresAt: true,
      usedAt: true,
      createdBy: { select: { email: true } },
      usedBy: { select: { email: true } },
    },
  });

  return rows.map((row) => {
    const status = inviteStatus(row, now);
    const daysLeft =
      status === "pending"
        ? Math.max(0, Math.ceil((row.expiresAt.getTime() - now.getTime()) / DAY_MS))
        : null;

    return {
      id: row.id,
      email: row.email,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      createdByEmail: row.createdBy.email,
      usedByEmail: row.usedBy?.email ?? null,
      status,
      daysLeft,
    };
  });
}

export type RevokeResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "used" | "expired" };

/**
 * 撤销（删除）一个尚未使用的邀请码。
 *
 * 已使用的不允许删除——它是一条审计记录，删了就查不到"谁邀请了谁"。
 */
export async function revokeInvite(id: string, now: Date = new Date()): Promise<RevokeResult> {
  const row = await prisma.invite.findUnique({
    where: { id },
    select: { usedAt: true, expiresAt: true },
  });

  if (row === null) return { ok: false, reason: "not_found" };
  if (row.usedAt !== null) return { ok: false, reason: "used" };
  if (row.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: "expired" };

  await prisma.invite.delete({ where: { id } });
  return { ok: true };
}
