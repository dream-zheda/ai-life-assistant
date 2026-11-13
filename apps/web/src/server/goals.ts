import { prisma } from "./db";

export type GoalInput = {
  id?: string;
  title: string;
  description: string;
  priority: number;
  state: string;
  targetDate: string;
};

export async function saveGoal(userId: string, input: GoalInput) {
  if (!input.title.trim() || input.title.trim().length > 120)
    throw new Error("目标名称需要 1–120 个字");
  if (input.description.length > 3000) throw new Error("目标说明最多 3000 个字");
  if (!Number.isInteger(input.priority) || input.priority < 1 || input.priority > 5)
    throw new Error("优先级需要在 1 到 5 之间");
  const states = ["ACTIVE", "PAUSED", "ACHIEVED", "DROPPED"] as const;
  const state = states.find((value) => value === input.state);
  if (!state) throw new Error("目标状态不正确");
  if (
    input.targetDate &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate) ||
      Number.isNaN(Date.parse(input.targetDate)) ||
      new Date(input.targetDate).toISOString().slice(0, 10) !== input.targetDate)
  )
    throw new Error("请选择有效的目标日期");
  const data = {
    title: input.title.trim(),
    description: input.description.trim() || null,
    priority: input.priority,
    state,
    targetDate: input.targetDate || null,
  };
  if (input.id) {
    const result = await prisma.goal.updateMany({ where: { id: input.id, userId }, data });
    if (result.count !== 1) throw new Error("目标不存在或不属于你");
  } else {
    await prisma.goal.create({ data: { ...data, userId } });
  }
}
