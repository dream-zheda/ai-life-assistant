import { prisma } from "./db";

/** 草稿不能遮住正在执行的版本；只显示比生效版本更新的待采纳草稿。 */
export async function loadTodayPlans(userId: string, localDate: string) {
  const active = await prisma.planVersion.findFirst({
    where: { userId, localDate, state: "ACTIVE" },
    include: { items: { orderBy: { startsAt: "asc" } } },
  });
  const draft = await prisma.planVersion.findFirst({
    where: {
      userId,
      localDate,
      state: "DRAFT",
      ...(active ? { version: { gt: active.version } } : {}),
    },
    orderBy: { version: "desc" },
    include: { items: { orderBy: { startsAt: "asc" } } },
  });
  return { active, draft };
}
