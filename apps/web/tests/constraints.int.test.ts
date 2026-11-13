import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FixedSlot } from "@life/domain";
import { computeBusyMinutes, computeDayCapacity } from "@life/planning";

import { deleteConstraintGroup, groupConstraints, inferRepeat, saveConstraintGroup, updateConstraintGroup } from "../src/server/constraints";
import { prisma } from "../src/server/db";

/**
 * 「每天」展开成 7 条约束的集成测试。
 *
 * 这是 ADR-003 那个静默错误的回归测试：
 * 只存一条跨零点 weekly 时，当天只会算 60 分钟；展开成 7 条后应该算 480 分钟（8 小时）。
 */

const USER = "int-constraint-user";
const TZ = "Asia/Shanghai";
const DAY = "2026-11-03"; // 周二

function toFixedSlots(
  rows: Array<{
    id: string;
    kind: string;
    title: string;
    weekday: number | null;
    localDate: string | null;
    startTime: string;
    endTime: string;
    timeZone: string;
  }>,
): FixedSlot[] {
  return rows.flatMap((row) => {
    if (row.kind !== "WEEKLY" || row.weekday === null) return [];
    return [
      {
        kind: "weekly" as const,
        id: row.id,
        title: row.title,
        weekday: row.weekday,
        startTime: row.startTime,
        endTime: row.endTime,
        timeZone: row.timeZone,
      },
    ];
  });
}

beforeAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.user.create({
    data: { id: USER, email: "int-constraint@example.com", timeZone: TZ },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("saveConstraintGroup", () => {
  it("「每天」写入 7 行，共享同一个 groupId", async () => {
    const result = await saveConstraintGroup({
      userId: USER,
      timeZone: TZ,
      draft: { title: "睡觉", startTime: "23:00", endTime: "07:00", repeat: "daily" },
    });

    expect(result.count).toBe(7);

    const rows = await prisma.fixedConstraint.findMany({ where: { userId: USER } });
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.groupId)).size).toBe(1);
    expect(rows.map((row) => row.weekday).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5, 6, 7,
    ]);
  });

  it("展开后当天占用 480 分钟——这正是 ADR-003 要解决的问题", async () => {
    const rows = await prisma.fixedConstraint.findMany({ where: { userId: USER } });
    const slots = toFixedSlots(rows);

    // 8 小时睡眠 = 480 分钟：凌晨 00:00–07:00（前一天的尾巴）+ 当晚 23:00–24:00
    expect(computeBusyMinutes(DAY, TZ, slots)).toBe(480);

    const capacity = computeDayCapacity(DAY, TZ, slots, 0);
    expect(capacity.totalDayMinutes).toBe(1440);
    expect(capacity.availableMinutes).toBe(1440 - 480);
  });

  it("对照：只存一条会导致少算 420 分钟", async () => {
    const rows = await prisma.fixedConstraint.findMany({
      where: { userId: USER, weekday: 2 },
    });
    const single = toFixedSlots(rows);

    // 这就是不展开时的错误结果：只算到当天 23:00-24:00 的 60 分钟
    expect(computeBusyMinutes(DAY, TZ, single)).toBe(60);
  });

  it("能按组展示（7 条合并成一行）", async () => {
    const rows = await prisma.fixedConstraint.findMany({ where: { userId: USER } });
    const views = groupConstraints(rows);

    expect(views).toHaveLength(1);
    expect(views[0]?.title).toBe("睡觉");
    expect(views[0]?.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("删除整组时把 7 行一起删掉", async () => {
    const rows = await prisma.fixedConstraint.findMany({ where: { userId: USER } });
    const groupId = rows[0]?.groupId;
    expect(groupId).not.toBeNull();

    const deleted = await deleteConstraintGroup(USER, groupId ?? "");
    expect(deleted).toBe(7);
    expect(await prisma.fixedConstraint.count({ where: { userId: USER } })).toBe(0);
  });
});

describe("inferRepeat", () => {
  it("从星期集合反推出预设", () => {
    expect(inferRepeat([1, 2, 3, 4, 5, 6, 7])).toEqual({ repeat: "daily" });
    expect(inferRepeat([1, 2, 3, 4, 5])).toEqual({ repeat: "weekdays" });
    expect(inferRepeat([6, 7])).toEqual({ repeat: "weekends" });
    expect(inferRepeat([3])).toEqual({ repeat: "weekly", weekday: 3 });
  });

  it("顺序与重复无关", () => {
    expect(inferRepeat([7, 6, 5, 4, 3, 2, 1])).toEqual({ repeat: "daily" });
    expect(inferRepeat([5, 1, 3, 2, 4])).toEqual({ repeat: "weekdays" });
  });

  it("不属于预设的集合返回 null，而不是猜一个最接近的", () => {
    expect(inferRepeat([1, 3])).toBeNull();
    expect(inferRepeat([1, 2, 6])).toBeNull();
    expect(inferRepeat([])).toBeNull();
  });
});

describe("updateConstraintGroup", () => {
  it("保留 groupId 与 createdAt，替换展开出来的行", async () => {
    await prisma.fixedConstraint.deleteMany({ where: { userId: USER } });

    const created = await saveConstraintGroup({
      userId: USER,
      timeZone: TZ,
      draft: { title: "睡觉", startTime: "23:00", endTime: "07:00", repeat: "daily" },
    });

    const before = await prisma.fixedConstraint.findFirstOrThrow({
      where: { userId: USER, groupId: created.groupId },
      select: { createdAt: true },
    });

    // 改成"工作日 22:30–06:30"
    const result = await updateConstraintGroup({
      userId: USER,
      timeZone: TZ,
      groupId: created.groupId,
      draft: { title: "睡觉", startTime: "22:30", endTime: "06:30", repeat: "weekdays" },
    });

    expect(result.count).toBe(5);

    const rows = await prisma.fixedConstraint.findMany({ where: { userId: USER } });
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.groupId))).toEqual(new Set([created.groupId]));
    expect(rows.every((row) => row.startTime === "22:30")).toBe(true);
    expect(rows.map((row) => row.weekday).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      1, 2, 3, 4, 5,
    ]);

    // 创建时间没有被重置
    expect(rows[0]?.createdAt.getTime()).toBe(before.createdAt.getTime());
  });

  it("不属于自己的分组会抛错，且不产生任何写入", async () => {
    await prisma.fixedConstraint.deleteMany({ where: { userId: USER } });

    await expect(
      updateConstraintGroup({
        userId: USER,
        timeZone: TZ,
        groupId: "not-my-group",
        draft: { title: "睡觉", startTime: "23:00", endTime: "07:00", repeat: "daily" },
      }),
    ).rejects.toThrow(/不存在/);

    expect(await prisma.fixedConstraint.count({ where: { userId: USER } })).toBe(0);
  });
});
