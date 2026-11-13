/**
 * 用户回复的解析。
 *
 * 背景：提醒消息里写了「回复 1 完成」，如果没人解析这句话，就是**给用户一个无效承诺**，
 * 比不写更伤害信任。这个模块把"用户到底回了什么"变成可判定的结构。
 *
 * 两种回复形态，故意分开：
 * - **裸数字 1/2/3**：只有在"刚刚收到一条单项提醒"的上下文里才有意义，
 *   解析器本身不做上下文判断，只给出意图，由调用方去解析目标条目。
 * - **带序号的命令**（`完成 2`、`跳过 3`）：早报里有多个条目，必须显式指定，
 *   否则"1"到底是"完成第 1 项"还是"我完成了"就说不清。
 */

export type ReplyAction = "done" | "half" | "skip";

export type ParsedReply =
  | { kind: "progress"; action: ReplyAction; ratio: number; index: number | null }
  | { kind: "help" }
  | { kind: "unknown" };

export const ACTION_RATIO: Record<ReplyAction, number> = {
  done: 1,
  half: 0.5,
  skip: 0,
};

/** 全角转半角，并去掉首尾空白与常见标点。 */
function normalize(input: string): string {
  const halfWidth = input.replace(/[\uFF01-\uFF5E]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xfee0),
  );
  return halfWidth
    .trim()
    // 只去掉句末的 。，.! 之类；问号要保留，因为它本身是「帮助」指令
    .replace(/^[。，.!！\s]+/, "")
    .replace(/[。，.!！\s]+$/, "")
    .replace(/\s+/g, " ");
}

const BARE_NUMBER: Record<string, ReplyAction> = {
  "1": "done",
  "2": "half",
  "3": "skip",
};

const WORD_ACTION: Array<{ pattern: RegExp; action: ReplyAction }> = [
  { pattern: /^(完成|做完|搞定|done)$/i, action: "done" },
  { pattern: /^(一半|做了一半|部分完成|partial)$/i, action: "half" },
  { pattern: /^(跳过|不做|skip)$/i, action: "skip" },
];

/** `完成 2`、`跳过2`、`第 2 项完成` 这类带序号的命令。 */
const INDEXED_COMMAND = /^(完成|做完|跳过|不做|一半|done|skip|partial)\s*第?\s*(\d{1,2})\s*项?$/i;

const HELP_PATTERN = /^(\?|？|帮助|help|怎么用)$/i;

export function parseReply(input: string): ParsedReply {
  const text = normalize(input);
  if (text.length === 0) return { kind: "unknown" };

  if (HELP_PATTERN.test(text)) return { kind: "help" };

  const bare = BARE_NUMBER[text];
  if (bare !== undefined) {
    return { kind: "progress", action: bare, ratio: ACTION_RATIO[bare], index: null };
  }

  const indexed = INDEXED_COMMAND.exec(text);
  if (indexed !== null) {
    const [, word, digits] = indexed;
    const index = Number(digits);
    if (word === undefined || digits === undefined || !Number.isInteger(index) || index < 1) {
      return { kind: "unknown" };
    }
    const action = wordToAction(word);
    if (action === undefined) return { kind: "unknown" };
    return { kind: "progress", action, ratio: ACTION_RATIO[action], index };
  }

  for (const { pattern, action } of WORD_ACTION) {
    if (pattern.test(text)) {
      return { kind: "progress", action, ratio: ACTION_RATIO[action], index: null };
    }
  }

  return { kind: "unknown" };
}

function wordToAction(word: string): ReplyAction | undefined {
  const normalized = word.toLowerCase();
  if (normalized === "完成" || normalized === "做完" || normalized === "done") return "done";
  if (normalized === "一半" || normalized === "partial") return "half";
  if (normalized === "跳过" || normalized === "不做" || normalized === "skip") return "skip";
  return undefined;
}

export const HELP_TEXT = [
  "我能听懂这些：",
  "· 回复 1 / 2 / 3 —— 针对刚刚提醒你的那一项：完成 / 做了一半 / 跳过",
  "· 回复「完成 2」—— 完成今天第 2 项",
  "· 回复「跳过 3」—— 跳过今天第 3 项",
  "· 回复「今天累了」—— 我会把剩下的安排往后挪（该功能还在做）",
].join("\n");

export const ACTION_LABEL: Record<ReplyAction, string> = {
  done: "已完成",
  half: "做了一半",
  skip: "已跳过",
};
