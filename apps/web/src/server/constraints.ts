import { randomUUID } from "node:crypto";

import {
  expandConstraintDraft,
  type ConstraintDraft,
  type ConstraintRepeat,
} from "@life/domain";

import { prisma } from "./db";

/**
 * 固定约束的写入与删除。
 *
 * 关键点：把一条「每天 23:00–07:00」展开成 7 行，并给它们同一个 groupId。
 * 不展开的话，跨零点约束只有"开始那天"生效，凌晨时段会被误判为可用（ADR-003）。
 */

export type SaveConstraintResult = {
  groupId: string;
  count: number;
};

export async function saveConstraintGroup(params: {
  userId: string;
  timeZone: string;
  draft: ConstraintDraft;
}): Promise<SaveConstraintResult> {
  const slots = expandConstraintDraft(params.draft, params.timeZone);
  const groupId = randomUUID();

  await prisma.fixedConstraint.createMany({
    data: slots.map((slot) => ({
      userId: params.userId,
      kind: "WEEKLY",
      title: slot.title,
      weekday: slot.weekday,
      startTime: slot.startTime,
      endTime: slot.endTime,
      timeZone: slot.timeZone,
      groupId,
      source: "user",
    })),
  });

  return { groupId, count: slots.length };
}

/**
 * 删除整组约束。
 *
 * 必须带 userId 条件：groupId 是客户端传来的，不能只按 groupId 删。
 */
export async function deleteConstraintGroup(userId: string, groupId: string): Promise<number> {
  const result = await prisma.fixedConstraint.deleteMany({ where: { userId, groupId } });
  return result.count;
}

export class ConstraintNotFoundError extends Error {
  constructor() {
    super("固定安排不存在");
    this.name = "ConstraintNotFoundError";
  }
}

/**
 * 从一组星期反推出「重复方式」，用于编辑时回填表单。
 *
 * 返回 null 表示这组星期不属于任何预设（例如手工造的数据），
 * 调用方应当拒绝编辑而不是猜一个最接近的预设——猜错会静默改掉用户的作息。
 */
export function inferRepeat(
  weekdays: readonly number[],
): { repeat: ConstraintRepeat; weekday?: number } | null {
  const sorted = [...new Set(weekdays)].sort((a, b) => a - b);
  const key = sorted.join(",");

  if (key === "1,2,3,4,5,6,7") return { repeat: "daily" };
  if (key === "1,2,3,4,5") return { repeat: "weekdays" };
  if (key === "6,7") return { repeat: "weekends" };

  const only = sorted[0];
  if (sorted.length === 1 && only !== undefined && only >= 1 && only <= 7) {
    return { repeat: "weekly", weekday: only };
  }

  return null;
}

/**
 * 编辑整组约束：保留 groupId 与 createdAt，替换展开出来的行。
 *
 * 为什么保留 createdAt：它是"这条作息是什么时候设的"的唯一审计线索。
 * 如果按"删除后重建"来做，每改一次时间戳就归零，事后查不到任何历史。
 * （真正的版本历史仍未实现，见 docs/进度 的未完成项。）
 */
export async function updateConstraintGroup(params: {
  userId: string;
  timeZone: string;
  groupId: string;
  draft: ConstraintDraft;
}): Promise<{ count: number }> {
  const existing = await prisma.fixedConstraint.findMany({
    where: { userId: params.userId, groupId: params.groupId },
    select: { createdAt: true },
  });

  if (existing.length === 0) throw new ConstraintNotFoundError();

  const createdAt = existing.reduce(
    (earliest, row) => (row.createdAt < earliest ? row.createdAt : earliest),
    existing[0]?.createdAt ?? new Date(),
  );

  const slots = expandConstraintDraft(params.draft, params.timeZone);

  await prisma.$transaction([
    prisma.fixedConstraint.deleteMany({
      where: { userId: params.userId, groupId: params.groupId },
    }),
    prisma.fixedConstraint.createMany({
      data: slots.map((slot) => ({
        userId: params.userId,
        kind: "WEEKLY",
        title: slot.title,
        weekday: slot.weekday,
        startTime: slot.startTime,
        endTime: slot.endTime,
        timeZone: slot.timeZone,
        groupId: params.groupId,
        source: "user",
        createdAt,
      })),
    }),
  ]);

  return { count: slots.length };
}

export async function deleteConstraintById(userId: string, id: string): Promise<number> {
  const result = await prisma.fixedConstraint.deleteMany({ where: { userId, id } });
  return result.count;
}

export type ConstraintView = {
  /** 同组约束共享；单条约束用自身 id 占位，便于前端统一处理。 */
  key: string;
  groupId: string | null;
  ids: string[];
  title: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
  timeZone: string;
};

export type ConstraintRow = {
  id: string;
  groupId: string | null;
  title: string;
  weekday: number | null;
  startTime: string;
  endTime: string;
  timeZone: string;
};

/** 把数据库里的多行合并成"一组一条"的展示结构。 */
export function groupConstraints(rows: readonly ConstraintRow[]): ConstraintView[] {
  const map = new Map<string, ConstraintView>();

  for (const row of rows) {
    const key = row.groupId ?? row.id;
    const existing = map.get(key);
    const weekday = row.weekday;

    if (existing === undefined) {
      map.set(key, {
        key,
        groupId: row.groupId,
        ids: [row.id],
        title: row.title,
        weekdays: weekday === null ? [] : [weekday],
        startTime: row.startTime,
        endTime: row.endTime,
        timeZone: row.timeZone,
      });
      continue;
    }

    existing.ids.push(row.id);
    if (weekday !== null && !existing.weekdays.includes(weekday)) {
      existing.weekdays.push(weekday);
    }
  }

  for (const view of map.values()) {
    view.weekdays.sort((a, b) => a - b);
  }

  return [...map.values()].sort((a, b) => a.title.localeCompare(b.title, "zh-CN"));
}
