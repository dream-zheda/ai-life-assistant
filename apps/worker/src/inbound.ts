import { ACTION_LABEL, HELP_TEXT, parseReply, type ParsedReply, type ReplyAction } from "@life/channels";
import { localDayOf } from "@life/shared";

import { prisma } from "./db";

/**
 * 入站消息处理：把「用户回了什么」变成进度记录。
 *
 * 这一步存在的理由：提醒消息里写了「回复 1 完成」。如果没人解析，
 * 就是给用户一个**无效承诺**——他照做了，系统毫无反应。
 *
 * 目标条目的解析规则：
 * - 带序号（`完成 2`）→ 取当天计划里第 2 项
 * - 裸数字（`1`）→ 取最近 2 小时内发过 START 提醒的那一项
 *   裸数字脱离上下文没有意义，硬要它对应"第 1 项"会让用户困惑
 */

const RECENT_NOTIFICATION_WINDOW_MS = 2 * 60 * 60 * 1000;

const STATE_BY_ACTION: Record<ReplyAction, "DONE" | "PARTIALLY_DONE" | "SKIPPED"> = {
  done: "DONE",
  half: "PARTIALLY_DONE",
  skip: "SKIPPED",
};

export type InboundResult = {
  action: "progress" | "help" | "unknown" | "no_target" | "duplicate";
  /** 要回给用户的话；unknown 时为 null（交给后续对话能力处理）。 */
  reply: string | null;
  planItemId?: string;
};

export const NO_TARGET_REPLY = "没找到要记录的那一项。回复「帮助」看看能做什么。";

type Target = { id: string; title: string };

async function resolveTarget(
  userId: string,
  parsed: Extract<ParsedReply, { kind: "progress" }>,
  now: Date,
): Promise<Target | null> {
  if (parsed.index !== null) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { timeZone: true },
    });
    if (user === null) return null;

    const localDate = localDayOf(now, user.timeZone);
    const plan = await prisma.planVersion.findFirst({
      where: { userId, localDate },
      orderBy: { version: "desc" },
      include: { items: { orderBy: { startsAt: "asc" } } },
    });

    const item = plan?.items[parsed.index - 1];
    return item === undefined ? null : { id: item.id, title: item.title };
  }

  const notification = await prisma.notification.findFirst({
    where: {
      userId,
      kind: "START",
      state: "SENT",
      planItemId: { not: null },
      scheduledAt: { gte: new Date(now.getTime() - RECENT_NOTIFICATION_WINDOW_MS) },
    },
    orderBy: { scheduledAt: "desc" },
    include: { planItem: { select: { id: true, title: true } } },
  });

  if (notification === null || notification.planItemId === null) return null;

  return {
    id: notification.planItemId,
    title: notification.planItem?.title ?? "这一项",
  };
}

export async function handleInboundMessage(params: {
  userId: string;
  text: string;
  now?: Date;
}): Promise<InboundResult> {
  const now = params.now ?? new Date();
  const parsed = parseReply(params.text);

  if (parsed.kind === "help") {
    return { action: "help", reply: HELP_TEXT };
  }

  if (parsed.kind === "unknown") {
    return { action: "unknown", reply: null };
  }

  const target = await resolveTarget(params.userId, parsed, now);
  if (target === null) {
    return { action: "no_target", reply: NO_TARGET_REPLY };
  }

  const latest = await prisma.progressEvent.findFirst({
    where: { planItemId: target.id, userId: params.userId },
    orderBy: { occurredAt: "desc" },
    select: { state: true },
  });

  // 已完成不可回退：重复回复不叠加记录，也不改写状态
  if (latest?.state === "DONE" && parsed.action === "done") {
    return {
      action: "duplicate",
      reply: `「${target.title}」已经记过完成了。`,
      planItemId: target.id,
    };
  }

  await prisma.progressEvent.create({
    data: {
      userId: params.userId,
      planItemId: target.id,
      state: STATE_BY_ACTION[parsed.action],
      ratio: parsed.ratio,
    },
  });

  return {
    action: "progress",
    reply: `已记录：${target.title} — ${ACTION_LABEL[parsed.action]}`,
    planItemId: target.id,
  };
}
