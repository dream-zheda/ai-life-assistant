/**
 * 时区与本地时间计算。
 *
 * 设计约定（来自规划书 §9）：
 * - 绝对时间一律用 Date（DTO 层用 ISO 8601 字符串），不存"本地时间戳"。
 * - 用户时区用 IANA 标识（如 Asia/Shanghai），代码中不写死单一时区。
 * - "每天 22:00 免打扰"这类规则保留「本地时间 + 时区」，不能预先转成固定 UTC。
 *
 * 这里刻意不引入 dayjs/luxon：只依赖 Intl，避免多一个时间库带来的语义分歧。
 */

const MS_PER_MINUTE = 60_000;

/** 本地日期，格式 `YYYY-MM-DD`。 */
export type LocalDay = string;
/** 本地时刻，格式 `HH:mm`（24 小时制）。 */
export type LocalTime = string;

export type Interval = { start: Date; end: Date };

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  // 构造会抛 RangeError，等于顺带校验了时区标识是否合法
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

export function assertTimeZone(timeZone: string): void {
  // 非法时区在这里抛错，而不是在后面变成静默错位
  partsFormatter(timeZone);
}

export function parseLocalDay(day: LocalDay): [number, number, number] {
  const match = DAY_PATTERN.exec(day);
  if (!match) throw new Error(`Invalid local day "${day}", expected YYYY-MM-DD`);
  const [, y, m, d] = match;
  if (y === undefined || m === undefined || d === undefined) {
    throw new Error(`Invalid local day "${day}"`);
  }
  return [Number(y), Number(m), Number(d)];
}

export function parseLocalTime(time: LocalTime): { hour: number; minute: number } {
  const match = TIME_PATTERN.exec(time);
  if (!match) throw new Error(`Invalid local time "${time}", expected HH:mm`);
  const [, h, min] = match;
  if (h === undefined || min === undefined) {
    throw new Error(`Invalid local time "${time}"`);
  }
  return { hour: Number(h), minute: Number(min) };
}

const pad2 = (value: number): string => value.toString().padStart(2, "0");

export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

/** 把一个瞬间拆成指定时区下的年月日时分秒。 */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = partsFormatter(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) {
      throw new Error(`Unable to read "${type}" for time zone ${timeZone}`);
    }
    return Number(value);
  };
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    // 个别实现在午夜返回 24，归一到 0
    hour: pick("hour") % 24,
    minute: pick("minute"),
    second: pick("second"),
  };
}

/**
 * 指定瞬间在该时区的偏移量（毫秒）。正数表示本地时间领先 UTC。
 * 例：Asia/Shanghai 返回 28800000。
 */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // 抹掉毫秒，避免把亚秒误差算进偏移量
  return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** 该瞬间在指定时区属于哪一天。 */
export function localDayOf(instant: Date, timeZone: string): LocalDay {
  const parts = zonedParts(instant, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** 在「日历天数」意义上加减，与时区无关（先当作 UTC 日期算，再格式化）。 */
export function addLocalDays(day: LocalDay, delta: number): LocalDay {
  const [year, month, date] = parseLocalDay(day);
  const shifted = new Date(Date.UTC(year, month - 1, date + delta));
  return `${shifted.getUTCFullYear().toString().padStart(4, "0")}-${pad2(
    shifted.getUTCMonth() + 1,
  )}-${pad2(shifted.getUTCDate())}`;
}

/**
 * 把「本地日期 + 本地时刻」换算成绝对瞬间。
 *
 * 夏令时切换当天的本地时间可能不存在或重复，这里通过两次迭代取稳定的偏移量；
 * 中国无夏令时，但用户时区可配置，所以不能省。
 */
export function localDateTimeToInstant(
  day: LocalDay,
  time: LocalTime,
  timeZone: string,
): Date {
  const [year, month, date] = parseLocalDay(day);
  const { hour, minute } = parseLocalTime(time);
  const naiveUtc = Date.UTC(year, month - 1, date, hour, minute, 0, 0);

  const firstGuess = naiveUtc - timeZoneOffsetMs(new Date(naiveUtc), timeZone);
  const refined = naiveUtc - timeZoneOffsetMs(new Date(firstGuess), timeZone);
  return new Date(refined);
}

/** 本地某一天的半开区间 [00:00, 次日 00:00)。 */
export function localDayRange(day: LocalDay, timeZone: string): Interval {
  return {
    start: localDateTimeToInstant(day, "00:00", timeZone),
    end: localDateTimeToInstant(addLocalDays(day, 1), "00:00", timeZone),
  };
}

/** 半开区间是否相交（端点相接视为不相交）。 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/**
 * 合并重叠或相接的区间，返回按开始时间排序的不相交区间。
 *
 * 用于计算「今天被占用了多少分钟」：把固定安排合并后再求并集，
 * 否则相邻的两节课会被重复计算两次。
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged: Interval[] = [];

  for (const current of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      merged.push({ start: current.start, end: current.end });
    }
  }

  return merged;
}

/** 把区间裁剪到 [from, to] 内；完全在外时返回 null。 */
export function clipInterval(interval: Interval, from: Date, to: Date): Interval | null {
  const start = new Date(Math.max(interval.start.getTime(), from.getTime()));
  const end = new Date(Math.min(interval.end.getTime(), to.getTime()));
  if (end.getTime() <= start.getTime()) return null;
  return { start, end };
}

export function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / MS_PER_MINUTE);
}

/** 星期几，ISO 编号：周一 = 1 … 周日 = 7。 */
export function isoWeekday(instant: Date, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(instant);
  const map: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  };
  const value = map[weekday];
  if (value === undefined) throw new Error(`Unknown weekday "${weekday}"`);
  return value;
}

const WEEKDAY_ZH: Record<number, string> = {
  1: "周一",
  2: "周二",
  3: "周三",
  4: "周四",
  5: "周五",
  6: "周六",
  7: "周日",
};

/**
 * 生成注入 prompt 用的事实描述。
 *
 * 模型不许自己算日期（评审意见 C1 / 规划书 §5），所有日期事实由这里算好再喂进去。
 */
export function describeInstant(instant: Date, timeZone: string): {
  localDay: LocalDay;
  localTime: LocalTime;
  weekday: number;
  weekdayLabel: string;
  iso: string;
  timeZone: string;
} {
  assertTimeZone(timeZone);
  const parts = zonedParts(instant, timeZone);
  const day = localDayOf(instant, timeZone);
  const weekday = isoWeekday(instant, timeZone);
  return {
    localDay: day,
    localTime: `${pad2(parts.hour)}:${pad2(parts.minute)}`,
    weekday,
    weekdayLabel: WEEKDAY_ZH[weekday] ?? "未知",
    iso: instant.toISOString(),
    timeZone,
  };
}
