import { localDayOf, localDayRange } from "@life/shared";

import { prisma } from "./db";

/**
 * 今日提醒（站内信）。
 *
 * 存在的理由：个人号通道随时可能失效（未接桥接、会话过期、被封）。
 * 如果那时界面上什么都看不到，用户会以为"今天没有安排"，
 * 而实际是**所有提醒都在沉默地失败**。
 *
 * 所以站内信不是"备用功能"，它是这条通道的可见性兜底。
 */

export type InboxItem = {
  id: string;
  kind: string;
  content: string;
  scheduledAt: Date;
  state: string;
  /** 给界面用的中文状态，避免把数据库枚举直接暴露给用户。 */
  stateLabel: string;
  /** 历史字段：表示通道已接受请求，不代表用户已收到或阅读。 */
  delivered: boolean;
};

const STATE_LABEL: Record<string, string> = {
  SCHEDULED: "待发送",
  SENT: "通道已接受",
  // 通道窗口关闭 / 账号不可用：内容仍然要能看到
  FALLBACK_REQUIRED: "仅站内可见",
  CANCELLED: "已取消",
  FAILED: "发送失败",
};

export async function listTodayNotifications(params: {
  userId: string;
  timeZone: string;
  now?: Date;
}): Promise<InboxItem[]> {
  const now = params.now ?? new Date();
  const day = localDayRange(localDayOf(now, params.timeZone), params.timeZone);

  const rows = await prisma.notification.findMany({
    where: {
      userId: params.userId,
      scheduledAt: { gte: day.start, lt: day.end },
    },
    orderBy: { scheduledAt: "asc" },
    select: { id: true, kind: true, content: true, scheduledAt: true, state: true },
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    content: row.content,
    scheduledAt: row.scheduledAt,
    state: row.state,
    stateLabel: STATE_LABEL[row.state] ?? row.state,
    delivered: row.state === "SENT",
  }));
}
