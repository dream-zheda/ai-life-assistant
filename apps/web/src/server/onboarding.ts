import { randomUUID } from "node:crypto";
import { expandConstraintDraft } from "@life/domain";
import { prisma } from "./db";

export async function savePersonalSituation(userId: string, timeZone: string, form: FormData) {
  const text = (key: string) =>
    typeof form.get(key) === "string" ? String(form.get(key)).trim() : "";
  const rawInput = text("rawInput");
  const goalTitle = text("goalTitle");
  const constraintTitle = text("constraintTitle");
  const priority = Number(text("goalPriority") || "3");
  if (rawInput.length > 12000) throw new Error("个人情况最多 12000 个字");
  if (goalTitle.length > 120 || constraintTitle.length > 120)
    throw new Error("目标和固定安排名称最多 120 个字");
  if (goalTitle && (!Number.isInteger(priority) || priority < 1 || priority > 5))
    throw new Error("目标优先级需要在 1 到 5 之间");
  const repeat = (["daily", "weekdays", "weekends", "weekly"] as const).find(
    (value) => value === text("constraintRepeat"),
  );
  if (constraintTitle && !repeat) throw new Error("请选择固定安排的重复方式");
  // 所有输入先校验，再原子写入：固定安排无效时不能留下已保存的目标或档案。
  const slots =
    constraintTitle && repeat
      ? expandConstraintDraft(
          {
            title: constraintTitle,
            repeat,
            startTime: text("constraintStart"),
            endTime: text("constraintEnd"),
            ...(repeat === "weekly" ? { weekday: Number(text("constraintWeekday")) } : {}),
          },
          timeZone,
        )
      : [];
  const groupId = randomUUID();
  await prisma.$transaction(async (tx) => {
    if (form.has("rawInput"))
      await tx.profile.upsert({
        where: { userId },
        create: { userId, rawInput },
        update: { rawInput, version: { increment: 1 } },
      });
    if (goalTitle) await tx.goal.create({ data: { userId, title: goalTitle, priority } });
    if (slots.length)
      await tx.fixedConstraint.createMany({
        data: slots.map((slot) => ({
          userId,
          kind: "WEEKLY",
          title: slot.title,
          weekday: slot.weekday,
          startTime: slot.startTime,
          endTime: slot.endTime,
          timeZone,
          groupId,
          source: "user",
        })),
      });
  });
}
