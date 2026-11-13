import { addLocalDays, isoWeekday, localDateTimeToInstant, type Interval } from "@life/shared";

/**
 * 固定约束：用户已有的、不可被 AI 改动的占用时段（上课、上班、睡觉）。
 *
 * 刻意用「本地时间 + 时区」表示，而不是预先算好的 UTC 区间：
 * 每周三 08:00 的课在切换夏令时后仍然应该是 08:00。
 */
export type FixedSlot =
  | {
      kind: "weekly";
      id: string;
      title: string;
      /** ISO 星期：周一 = 1 … 周日 = 7。 */
      weekday: number;
      startTime: string;
      endTime: string;
      timeZone: string;
    }
  | {
      kind: "one_off";
      id: string;
      title: string;
      localDate: string;
      startTime: string;
      endTime: string;
      timeZone: string;
    };

/**
 * 求某个本地日期上这条约束实际占用的区间；当天不生效则返回 null。
 *
 * 跨零点（endTime ≤ startTime）视为跨到次日，例如 23:00–01:00。
 */
export function fixedSlotIntervalOnDay(slot: FixedSlot, day: string): Interval | null {
  const applies =
    slot.kind === "one_off"
      ? slot.localDate === day
      : // 用当天正午判断星期，避开午夜附近的夏令时边界
        isoWeekday(localDateTimeToInstant(day, "12:00", slot.timeZone), slot.timeZone) ===
        slot.weekday;

  if (!applies) return null;

  const start = localDateTimeToInstant(day, slot.startTime, slot.timeZone);
  const sameDayEnd = localDateTimeToInstant(day, slot.endTime, slot.timeZone);
  const end =
    sameDayEnd.getTime() <= start.getTime()
      ? localDateTimeToInstant(addLocalDays(day, 1), slot.endTime, slot.timeZone)
      : sameDayEnd;

  return { start, end };
}

/**
 * 某一天实际被这条约束占用的所有区间（0–2 段）。
 *
 * 为什么不是 1 段：跨零点的约束会**从前一天溢到当天**。
 * 例如「每天 23:00–07:00 睡觉」，周二的 00:00–07:00 属于**周一那条**规则。
 * 如果只问「这条规则在周二是否生效」，周一那条会返回 false，凌晨时段就被漏掉——
 * 结果 AI 会把行动排到凌晨 2 点。
 *
 * 调用方需要自己把返回值裁剪到目标日期区间：这里返回的区间可能完全落在前一天。
 */
export function fixedSlotIntervalsOnDay(slot: FixedSlot, day: string): Interval[] {
  const intervals: Interval[] = [];

  const today = fixedSlotIntervalOnDay(slot, day);
  if (today !== null) intervals.push(today);

  const previous = fixedSlotIntervalOnDay(slot, addLocalDays(day, -1));
  if (previous !== null) intervals.push(previous);

  return intervals;
}
