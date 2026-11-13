/**
 * 提醒消息的渲染。
 *
 * 为什么单独一层：通道对消息有物理限制，而业务层不该关心"微信一条消息能放多少字"。
 * 渲染结果是纯字符串，可测、可在任何通道里复用。
 *
 * 设计约束：
 * - 单条消息**有长度上限**。个人微信虽然能发长文，但一条几百字的提醒没人读完，
 *   而且不同通道上限不同（服务号模板消息限制更严）。
 * - 超长时**优先保留**时间与标题，砍掉后面的条目并明确告知"还有几项"，
 *   而不是粗暴截断在半句话上。
 * - 文案要给出**可执行的回法**。微信里没有按钮，用户必须知道能回什么。
 * - 早报里有多个条目，所以**不能**用裸数字 1/2/3——那会被理解成"我完成了"，
 *   而不是"第 1 项完成"。多条目必须用带序号的命令（`完成 2`）。
 *   单项提醒没有歧义，才可以写「回复 1 完成」。
 */

export const MAX_MESSAGE_LENGTH = 480;

const ELLIPSIS = "…";

/** 按码点截断，避免把 emoji 或代理对切成半个字符。 */
export function clampToLength(text: string, max: number = MAX_MESSAGE_LENGTH): string {
  const points = [...text];
  if (points.length <= max) return text;
  return `${points.slice(0, Math.max(0, max - 1)).join("")}${ELLIPSIS}`;
}

export type ReminderItem = {
  title: string;
  /** 已经格式化好的本地时刻，例如 "10:30"。渲染层不做时区换算。 */
  startTime: string;
  endTime: string;
  goalTitle?: string;
};

export type StartReminderOptions = {
  leadMinutes?: number;
};

/**
 * 单项提醒：即将开始的一个行动。
 *
 * 保持极短，因为它出现在用户正在做别的事的时候——只给"什么时候、做什么、怎么回"。
 */
export function renderStartReminder(
  item: ReminderItem,
  options: StartReminderOptions = {},
): string {
  const leadMinutes = options.leadMinutes ?? 10;

  const lines = [
    `⏰ ${leadMinutes} 分钟后开始`,
    "",
    item.title,
    `${item.startTime}–${item.endTime}`,
  ];

  if (item.goalTitle !== undefined && item.goalTitle.length > 0) {
    lines.push(`目标：${item.goalTitle}`);
  }

  lines.push("", "回复 1 完成 · 2 做了一半 · 3 跳过");

  return clampToLength(lines.join("\n"));
}

export type MorningBriefParams = {
  /** 已经格式化好的日期，例如 "11月3日 周二"。 */
  dateLabel: string;
  items: readonly ReminderItem[];
  /** 最多列几项，默认 8。 */
  maxItems?: number;
  /** 自定义结尾提示。 */
  replyHint?: string;
};

const DEFAULT_BRIEF_HINT =
  "回复「完成 2」标记第 2 项完成，「跳过 3」跳过第 3 项。回复「帮助」看全部指令。";

/**
 * 早报：今天要做的事。
 *
 * 这是产品的核心承诺「每天早上提醒今天做什么」的载体。
 * 条目多的时候**宁可少列**也不要截断半句话——用户看到"……另有 5 项"还能去网页看，
 * 看到一句断掉的话只会困惑。
 */
export function renderMorningBrief(params: MorningBriefParams): string {
  const maxItems = params.maxItems ?? 8;
  const hint = params.replyHint ?? DEFAULT_BRIEF_HINT;

  const build = (shownCount: number, remaining: number): string => {
    const lines: string[] = [`今天 ${params.dateLabel}`, ""];

    const shown = params.items.slice(0, shownCount);
    shown.forEach((item, index) => {
      const goal =
        item.goalTitle !== undefined && item.goalTitle.length > 0 ? `（${item.goalTitle}）` : "";
      lines.push(`${index + 1}. ${item.startTime}–${item.endTime} ${item.title}${goal}`);
    });

    if (shownCount === 0 && remaining === 0) {
      lines.push("今天没有安排。");
    }
    if (remaining > 0) {
      lines.push(`……另有 ${remaining} 项，打开网页查看`);
    }

    lines.push("", hint);
    return lines.join("\n");
  };

  const total = params.items.length;
  let shownCount = Math.min(total, maxItems);
  let remaining = total - shownCount;
  let text = build(shownCount, remaining);

  // 仍然超长时逐条减少，直到放得下（最少保留 0 条 + "另有 N 项"）
  while (text.length > MAX_MESSAGE_LENGTH && shownCount > 0) {
    shownCount -= 1;
    remaining = total - shownCount;
    text = build(shownCount, remaining);
  }

  return clampToLength(text);
}

/**
 * 窗口关闭时的降级提示。
 *
 * 注意这不是发给用户的消息，而是给我们自己看的运维提示：
 * "该用户超过了平台推送窗口，只能等他自己发消息"。
 */
export function describeFallback(reason: "never_contacted" | "window_expired"): string {
  return reason === "never_contacted"
    ? "用户从未在通道上发过消息，无法主动推送"
    : "已超过通道允许的主动推送窗口，需用户先发一条消息";
}
