import { applyReport, type ActionState } from "@life/domain";
import { prisma } from "./db";

export async function recordProgress(userId: string, planItemId: string, ratio: number) {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)
    throw new Error("完成比例必须在 0 到 1 之间");
  return prisma.$transaction(async (tx) => {
    // 与计划采纳使用相同的用户锁，避免替代计划和反馈同时覆盖状态。
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
    const item = await tx.planItem.findFirst({
      where: { id: planItemId, userId },
      include: { planVersion: true },
    });
    if (!item) throw new Error("这项安排不存在或不属于你");
    if (item.planVersion.state !== "ACTIVE") throw new Error("请在当前生效的计划上反馈进度");
    const previous = await tx.progressEvent.findFirst({
      where: { userId, planItemId },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    });
    if (previous?.ratio === ratio) return previous;
    if (previous?.state === "DONE" || previous?.state === "CANCELLED")
      throw new Error("已完成或已取消的安排不能改回未完成");
    const result = applyReport((previous?.state.toLowerCase() ?? "pending") as ActionState, {
      ratio,
    });
    const event = await tx.progressEvent.create({
      data: {
        userId,
        planItemId,
        state: result.state.toUpperCase() as "PENDING" | "PARTIALLY_DONE" | "DONE",
        ratio: result.ratio,
      },
    });
    if (result.state === "done") {
      await tx.notification.updateMany({
        where: { userId, planItemId, state: "SCHEDULED" },
        data: { state: "CANCELLED" },
      });
    }
    return event;
  });
}
