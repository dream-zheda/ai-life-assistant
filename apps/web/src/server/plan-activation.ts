import { prisma } from "./db";

/**
 * 计划版本的「采纳」（DRAFT → ACTIVE）。
 *
 * 为什么必须有这一步（而不是生成后直接生效）：
 * 规划书 §6 要求「初次计划需要确认」——用户先看到 AI 排了什么，接受之后才进入执行。
 *
 * 同时这一步也是**提醒能否发出的前提**：
 * worker 只为 `state = 'ACTIVE'` 的计划生成提醒。没有采纳，就不会有任何提醒。
 */

export type ActivateResult =
  | { ok: true; activatedAt: Date; droppedCount: number; itemCount: number }
  | { ok: false; reason: "not_found" | "already_active" | "empty" | "expired" | "superseded" };

export async function activatePlanVersion(params: {
  userId: string;
  planVersionId: string;
  now?: Date;
}): Promise<ActivateResult> {
  const now = params.now ?? new Date();
  return prisma.$transaction(async (tx): Promise<ActivateResult> => {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${params.userId} FOR UPDATE`;
    const plan = await tx.planVersion.findFirst({
      where: { id: params.planVersionId, userId: params.userId },
      include: { items: { orderBy: { startsAt: "asc" } } },
    });

    if (plan === null) return { ok: false, reason: "not_found" };
    if (plan.state === "ACTIVE") return { ok: false, reason: "already_active" };
    if (plan.state !== "DRAFT") return { ok: false, reason: "superseded" };

    // 空计划与"全部过期"是两件事，必须分开报：
    // 前者通常是没配模型，后者是生成太久才来采纳。混在一起会把人带偏。
    if (plan.items.length === 0) return { ok: false, reason: "empty" };

    // 生效前的二次校验：生成有耗时，部分条目可能已经结束。
    // 完全过去的条目直接丢弃；跨在"现在"的条目保留（用户可能正在做）。
    const expired = plan.items.filter((item) => item.endsAt.getTime() <= now.getTime());
    const kept = plan.items.filter((item) => item.endsAt.getTime() > now.getTime());

    if (kept.length === 0) return { ok: false, reason: "expired" };

    const newer = await tx.planVersion.findFirst({
      where: {
        userId: params.userId,
        localDate: plan.localDate,
        state: "ACTIVE",
        version: { gt: plan.version },
      },
    });
    if (newer) return { ok: false, reason: "superseded" };
    // 顺序不能反：部分唯一索引要求同一天只有一个 ACTIVE，
    // 先撤下旧的再启用新的。
    await tx.planVersion.updateMany({
      where: { userId: params.userId, localDate: plan.localDate, state: "ACTIVE" },
      data: { state: "SUPERSEDED", supersededAt: now },
    });

    await tx.notification.updateMany({
      where: {
        userId: params.userId,
        state: "SCHEDULED",
        planVersion: { localDate: plan.localDate, state: "SUPERSEDED" },
      },
      data: { state: "CANCELLED" },
    });

    await tx.planVersion.update({
      where: { id: plan.id },
      data: { state: "ACTIVE", activatedAt: now },
    });

    if (expired.length > 0) {
      await tx.planItem.deleteMany({
        where: { planVersionId: plan.id, endsAt: { lte: now } },
      });
    }
    return {
      ok: true,
      activatedAt: now,
      droppedCount: expired.length,
      itemCount: kept.length,
    };
  });
}
