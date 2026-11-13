import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "../src/server/db";
import { inviteStatus, listInvites, revokeInvite } from "../src/server/invite-admin";

/**
 * 邀请码管理视图的集成测试。
 *
 * 重点：状态判定、不泄露摘要、撤销的边界（已用的不能删）。
 *
 * 注意：`listInvites` 返回**全库**的邀请码（管理员看所有），
 * 所以测试必须先清空邀请表，否则其他用例/脚本留下的邀请码会干扰断言。
 */

const ADMIN = "int-admin-user";
const FRIEND = "int-invited-user";
const NOW = new Date("2026-11-03T12:00:00+08:00");
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  // 邀请码有指向 users 的外键，必须先删邀请码再删用户
  await prisma.invite.deleteMany({});
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, FRIEND] } } });

  await prisma.user.create({
    data: { id: ADMIN, email: "admin@int.test", role: "ADMIN", timeZone: "Asia/Shanghai" },
  });
  await prisma.user.create({
    data: { id: FRIEND, email: "friend@int.test", timeZone: "Asia/Shanghai" },
  });
});

afterAll(async () => {
  await prisma.invite.deleteMany({});
  await prisma.user.deleteMany({ where: { id: { in: [ADMIN, FRIEND] } } });
  await prisma.$disconnect();
});

describe("inviteStatus", () => {
  it("已用优先于过期", () => {
    const past = new Date(NOW.getTime() - DAY);
    expect(inviteStatus({ usedAt: past, expiresAt: past }, NOW)).toBe("used");
  });

  it("未使用且已过期", () => {
    expect(inviteStatus({ usedAt: null, expiresAt: new Date(NOW.getTime() - 1) }, NOW)).toBe(
      "expired",
    );
  });

  it("未使用且未过期", () => {
    expect(
      inviteStatus({ usedAt: null, expiresAt: new Date(NOW.getTime() + DAY) }, NOW),
    ).toBe("pending");
  });
});

describe("listInvites", () => {
  it("返回三种状态，并带上创建者与被邀请者邮箱", async () => {
    await prisma.invite.deleteMany({});

    await prisma.invite.create({
      data: {
        tokenHash: "hash-pending",
        createdById: ADMIN,
        email: "pending@int.test",
        expiresAt: new Date(NOW.getTime() + 2 * DAY),
      },
    });
    await prisma.invite.create({
      data: {
        tokenHash: "hash-used",
        createdById: ADMIN,
        expiresAt: new Date(NOW.getTime() + DAY),
        usedAt: new Date(NOW.getTime() - 3600_000),
        usedById: FRIEND,
      },
    });
    await prisma.invite.create({
      data: {
        tokenHash: "hash-expired",
        createdById: ADMIN,
        expiresAt: new Date(NOW.getTime() - DAY),
      },
    });

    const list = await listInvites(NOW);
    const byStatus = new Map(list.map((item) => [item.status, item]));

    expect(byStatus.get("pending")?.email).toBe("pending@int.test");
    expect(byStatus.get("pending")?.daysLeft).toBe(2);
    expect(byStatus.get("used")?.usedByEmail).toBe("friend@int.test");
    expect(byStatus.get("used")?.daysLeft).toBeNull();
    expect(byStatus.get("expired")?.daysLeft).toBeNull();

    for (const item of list) {
      expect(item.createdByEmail).toBe("admin@int.test");
    }
  });

  it("绝不返回令牌摘要", async () => {
    await prisma.invite.deleteMany({});
    await prisma.invite.create({
      data: {
        tokenHash: "hash-must-not-leak",
        createdById: ADMIN,
        expiresAt: new Date(NOW.getTime() + DAY),
      },
    });

    const json = JSON.stringify(await listInvites(NOW));
    expect(json).not.toContain("hash-must-not-leak");
    expect(json).not.toContain("tokenHash");
  });
});

describe("revokeInvite", () => {
  it("可以撤销待使用的邀请码", async () => {
    const invite = await prisma.invite.create({
      data: {
        tokenHash: "hash-revocable",
        createdById: ADMIN,
        expiresAt: new Date(NOW.getTime() + DAY),
      },
    });

    expect(await revokeInvite(invite.id, NOW)).toEqual({ ok: true });
    expect(await prisma.invite.count({ where: { id: invite.id } })).toBe(0);
  });

  it("已使用的邀请码不能撤销（审计记录）", async () => {
    const invite = await prisma.invite.create({
      data: {
        tokenHash: "hash-used-no-revoke",
        createdById: ADMIN,
        expiresAt: new Date(NOW.getTime() + DAY),
        usedAt: NOW,
        usedById: FRIEND,
      },
    });

    expect(await revokeInvite(invite.id, NOW)).toEqual({ ok: false, reason: "used" });
    expect(await prisma.invite.count({ where: { id: invite.id } })).toBe(1);
  });

  it("已过期的邀请码返回 expired", async () => {
    const invite = await prisma.invite.create({
      data: {
        tokenHash: "hash-expired-revoke",
        createdById: ADMIN,
        expiresAt: new Date(NOW.getTime() - DAY),
      },
    });

    expect(await revokeInvite(invite.id, NOW)).toEqual({ ok: false, reason: "expired" });
  });

  it("不存在的邀请码返回 not_found", async () => {
    expect(await revokeInvite("does-not-exist", NOW)).toEqual({ ok: false, reason: "not_found" });
  });
});
