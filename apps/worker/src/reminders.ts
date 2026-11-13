import {
  decideProactiveDelivery,
  renderMorningBrief,
  renderStartReminder,
  type ChannelAdapter,
  type ChannelId,
  type ReminderItem,
} from "@life/channels";
import type { ChannelKind } from "@life/db";
import {
  parseLocalTimeToMinutes,
  shouldSuppressReminder,
  SUPPRESSION_LABEL,
  type SuppressionReason,
} from "@life/domain";
import { describeInstant, localDayOf, localDayRange, zonedParts } from "@life/shared";

import { prisma } from "./db";
import { createContextCache } from "./settings";

/**
 * 提醒的生成与派发。
 *
 * 三条硬规则：
 * 1. 「能不能发」在派发前就算出来，**不是发失败了再补救**（ADR-002）。
 * 2. 计划被替代后，旧提醒必须作废。
 * 3. 暂停 / 免打扰 / 每日上限在**派发时**再检查一次——
 *    生成时用户可能还没暂停，中间几秒的设置变化不该被忽略。
 */

export const REMINDER_LEAD_MINUTES = 10;
export const MORNING_BRIEF_START_HOUR = 7;
export const MORNING_BRIEF_WINDOW_MINUTES = 30;
/** 单次 tick 最多往前看多久，用于支持"每用户不同的提前量"。 */
const MAX_LEAD_MINUTES = 120;

const CHANNEL_KIND: Record<ChannelId, ChannelKind> = {
  "personal-wechat": "PERSONAL_WECHAT",
  "wechat-personal-protocol": "WECHAT_PERSONAL_PROTOCOL",
  "qq-onebot": "QQ_ONEBOT",
  "official-account-subscription": "OFFICIAL_ACCOUNT_SUBSCRIPTION",
  "official-account-service": "OFFICIAL_ACCOUNT_SERVICE",
  "wecom-app": "WECOM_APP",
  "wecom-kf": "WECOM_KF",
};

export function reminderDedupeKey(planItemId: string, kind: string): string {
  return `${kind}:${planItemId}`;
}

function timeLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(instant);
}

async function goalTitleMap(goalIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(goalIds)];
  if (unique.length === 0) return new Map();
  const goals = await prisma.goal.findMany({
    where: { id: { in: unique } },
    select: { id: true, title: true },
  });
  return new Map(goals.map((goal) => [goal.id, goal.title]));
}

/**
 * 为「即将开始」的条目生成提醒。
 *
 * 每用户提前量不同：先按最大窗口捞出来，再按各自 leadMinutes 过滤。
 */
export async function enqueueStartReminders(
  now: Date,
  options: { leadMinutes?: number } = {},
): Promise<number> {
  const maxLead = Math.max(options.leadMinutes ?? MAX_LEAD_MINUTES, MAX_LEAD_MINUTES);
  const until = new Date(now.getTime() + maxLead * 60_000);

  const items = await prisma.planItem.findMany({
    where: {
      startsAt: { gt: now, lte: until },
      planVersion: { state: "ACTIVE" },
      progressEvents: { none: { state: { in: ["DONE", "CANCELLED"] } } },
    },
    select: {
      id: true,
      userId: true,
      planVersionId: true,
      title: true,
      startsAt: true,
      endsAt: true,
      goalId: true,
      planVersion: { select: { timeZone: true } },
    },
  });

  if (items.length === 0) return 0;

  const titles = await goalTitleMap(
    items.map((item) => item.goalId).filter((id): id is string => id !== null),
  );
  const contexts = createContextCache();

  let created = 0;
  for (const item of items) {
    const context = await contexts.get(item.userId);
    if (context === null) continue;

    const leadMinutes = context.leadMinutes;
    const dueAt = item.startsAt.getTime() - leadMinutes * 60_000;
    if (dueAt > now.getTime()) continue; // 还没到该提醒的时候

    const timeZone = item.planVersion.timeZone;
    const goalTitle = item.goalId === null ? undefined : titles.get(item.goalId);

    const content = renderStartReminder(
      {
        title: item.title,
        startTime: timeLabel(item.startsAt, timeZone),
        endTime: timeLabel(item.endsAt, timeZone),
        ...(goalTitle === undefined ? {} : { goalTitle }),
      },
      { leadMinutes },
    );

    const result = await prisma.notification.createMany({
      data: [
        {
          userId: item.userId,
          planVersionId: item.planVersionId,
          planItemId: item.id,
          kind: "START",
          dedupeKey: reminderDedupeKey(item.id, "START"),
          content,
          scheduledAt: new Date(dueAt),
        },
      ],
      skipDuplicates: true,
    });
    created += result.count;
  }

  return created;
}

/**
 * 生成每日早报。
 *
 * 时间来自用户设置（默认 07:00），窗口 30 分钟。
 * `dedupeKey = morning:<planVersionId>` 保证每个版本只发一次。
 */
export async function enqueueMorningBriefs(
  now: Date,
  options: { windowMinutes?: number } = {},
): Promise<number> {
  const windowMinutes = options.windowMinutes ?? MORNING_BRIEF_WINDOW_MINUTES;

  const users = await prisma.user.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, timeZone: true, settings: { select: { briefStartTime: true } } },
  });

  let created = 0;

  for (const user of users) {
    const briefStart = parseLocalTimeToMinutes(user.settings?.briefStartTime ?? "07:00");
    if (briefStart === null) continue;

    const parts = zonedParts(now, user.timeZone);
    const minutesOfDay = parts.hour * 60 + parts.minute;
    if (minutesOfDay < briefStart || minutesOfDay >= briefStart + windowMinutes) continue;

    const localDate = localDayOf(now, user.timeZone);
    const plan = await prisma.planVersion.findFirst({
      where: { userId: user.id, localDate, state: "ACTIVE" },
      include: { items: { orderBy: { startsAt: "asc" } } },
    });
    if (plan === null) continue;

    const titles = await goalTitleMap(
      plan.items.map((item) => item.goalId).filter((id): id is string => id !== null),
    );

    const items: ReminderItem[] = plan.items.map((item) => {
      const goalTitle = item.goalId === null ? undefined : titles.get(item.goalId);
      return {
        title: item.title,
        startTime: timeLabel(item.startsAt, plan.timeZone),
        endTime: timeLabel(item.endsAt, plan.timeZone),
        ...(goalTitle === undefined ? {} : { goalTitle }),
      };
    });

    const stamp = describeInstant(now, user.timeZone);
    const dateLabel = `${parts.month}月${parts.day}日 ${stamp.weekdayLabel}`;

    const result = await prisma.notification.createMany({
      data: [
        {
          userId: user.id,
          planVersionId: plan.id,
          kind: "MORNING",
          dedupeKey: `morning:${plan.id}`,
          content: renderMorningBrief({ dateLabel, items }),
          scheduledAt: now,
        },
      ],
      skipDuplicates: true,
    });
    created += result.count;
  }

  return created;
}

export type DispatchOutcome = {
  sent: number;
  fallback: number;
  cancelled: number;
  suppressed: number;
  failed: number;
};

async function countSentToday(userId: string, timeZone: string, now: Date): Promise<number> {
  const range = localDayRange(localDayOf(now, timeZone), timeZone);
  return prisma.notification.count({
    where: {
      userId,
      state: "SENT",
      scheduledAt: { gte: range.start, lt: range.end },
    },
  });
}

async function suppress(notificationId: string, reason: SuppressionReason): Promise<void> {
  await prisma.$transaction([
    prisma.notification.update({
      where: { id: notificationId },
      data: { state: "CANCELLED" },
    }),
    prisma.notificationAttempt.create({
      data: { notificationId, outcome: "blocked", code: reason },
    }),
  ]);
}

/**
 * 派发到期的提醒。
 *
 * 顺序：计划是否仍生效 → 暂停/免打扰/上限 → 通道窗口 → 发送。
 * 前两步都是"不发"，但含义不同：前者是计划变了，后者是用户的选择。
 */
export async function dispatchDueNotifications(params: {
  now: Date;
  adapter: ChannelAdapter;
  limit?: number;
}): Promise<DispatchOutcome> {
  const { now, adapter } = params;
  const outcome: DispatchOutcome = {
    sent: 0,
    fallback: 0,
    cancelled: 0,
    suppressed: 0,
    failed: 0,
  };

  const due = await prisma.notification.findMany({
    where: { state: "SCHEDULED", scheduledAt: { lte: now } },
    orderBy: { scheduledAt: "asc" },
    take: params.limit ?? 20,
    include: { planVersion: { select: { state: true } } },
  });

  const contexts = createContextCache();
  const sentTodayCache = new Map<string, number>();

  for (const notification of due) {
    if (notification.planItemId !== null) {
      const terminal = await prisma.progressEvent.findFirst({
        where: {
          userId: notification.userId,
          planItemId: notification.planItemId,
          state: { in: ["DONE", "CANCELLED"] },
        },
      });
      if (terminal) {
        await prisma.notification.update({
          where: { id: notification.id },
          data: { state: "CANCELLED" },
        });
        outcome.cancelled += 1;
        continue;
      }
    }
    // 计划已被替代或撤下：旧提醒直接作废
    if (notification.planVersion !== null && notification.planVersion.state !== "ACTIVE") {
      await prisma.notification.update({
        where: { id: notification.id },
        data: { state: "CANCELLED" },
      });
      outcome.cancelled += 1;
      continue;
    }

    const context = await contexts.get(notification.userId);
    if (context === null) {
      await suppress(notification.id, "paused");
      outcome.suppressed += 1;
      continue;
    }

    const parts = zonedParts(now, context.timeZone);
    const minutesOfDay = parts.hour * 60 + parts.minute;

    if (!sentTodayCache.has(notification.userId)) {
      sentTodayCache.set(
        notification.userId,
        await countSentToday(notification.userId, context.timeZone, now),
      );
    }

    const reason = shouldSuppressReminder(context.policy, {
      minutesOfDay,
      sentToday: sentTodayCache.get(notification.userId) ?? 0,
    });

    if (reason !== null) {
      await suppress(notification.id, reason);
      outcome.suppressed += 1;
      continue;
    }

    const binding = await prisma.channelBinding.findFirst({
      where: {
        userId: notification.userId,
        channel: CHANNEL_KIND[adapter.policy.id],
        ...(adapter.policy.id === "qq-onebot" ? {
          sessionState: "ACTIVE", verifiedAt: { not: null },
          bridgeSessionId: "selfId" in adapter ? String(adapter.selfId) : "",
          user: { status: "ACTIVE" },
        } : {}),
      },
      select: { externalUserId: true, lastInboundAt: true },
    });

    if (binding === null) {
      await prisma.$transaction([
        prisma.notification.update({
          where: { id: notification.id },
          data: { state: "FALLBACK_REQUIRED" },
        }),
        prisma.notificationAttempt.create({
          data: { notificationId: notification.id, outcome: "fallback", code: "no_binding" },
        }),
      ]);
      outcome.fallback += 1;
      continue;
    }

    const decision = decideProactiveDelivery(adapter.policy, binding.lastInboundAt, now);

    if (decision.action === "fallback") {
      await prisma.$transaction([
        prisma.notification.update({
          where: { id: notification.id },
          data: { state: "FALLBACK_REQUIRED" },
        }),
        prisma.notificationAttempt.create({
          data: { notificationId: notification.id, outcome: "fallback", code: decision.reason },
        }),
      ]);
      outcome.fallback += 1;
      continue;
    }

    const result = await adapter.send({
      externalUserId: binding.externalUserId,
      text: notification.content,
    });

    await prisma.$transaction([
      prisma.notificationAttempt.create({
        data: {
          notificationId: notification.id,
          outcome: result.status,
          code: result.status === "accepted" ? null : result.code,
        },
      }),
      prisma.notification.update({
        where: { id: notification.id },
        data: { state: result.status === "accepted" ? "SENT" : "FAILED" },
      }),
    ]);

    if (result.status === "accepted") {
      outcome.sent += 1;
      sentTodayCache.set(notification.userId, (sentTodayCache.get(notification.userId) ?? 0) + 1);
    } else {
      outcome.failed += 1;
    }
  }

  return outcome;
}

export { SUPPRESSION_LABEL };
