import { prisma } from "./db";

/**
 * 个人数据导出。
 *
 * 依据：`docs/compliance.md` 里「查阅权」的落地——用户有权拿到自己的数据。
 *
 * 两条硬规则：
 * 1. **只导出该用户自己的数据**。每个查询都带 userId 条件，不靠"记得过滤"。
 * 2. **绝不导出凭据**。`accounts`（密码哈希、OAuth token）、`sessions`（会话 token）、
 *    `verifications` 一律不导出，哪怕它们挂在用户身上。
 */

export const EXPORT_SCHEMA_VERSION = 1;

export type ExportPayload = Awaited<ReturnType<typeof exportUserData>>;

export async function exportUserData(userId: string): Promise<{
  exportedAt: string;
  schemaVersion: number;
  user: {
    id: string;
    email: string;
    name: string | null;
    timeZone: string;
    role: string;
    createdAt: Date;
  };
  settings: {
    briefStartTime: string;
    reminderLeadMinutes: number;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    remindersPaused: boolean;
    maxRemindersPerDay: number;
  } | null;
  profile: {
    rawInput: string | null;
    structured: unknown;
    version: number;
  } | null;
  goals: Array<{
    id: string;
    title: string;
    description: string | null;
    priority: number;
    state: string;
    targetDate: string | null;
  }>;
  constraints: Array<{
    id: string;
    kind: string;
    title: string;
    weekday: number | null;
    localDate: string | null;
    startTime: string;
    endTime: string;
    timeZone: string;
  }>;
  plans: Array<{
    id: string;
    localDate: string;
    timeZone: string;
    version: number;
    state: string;
    assumptions: unknown;
    items: Array<{
      id: string;
      title: string;
      startsAt: Date;
      endsAt: Date;
      minutes: number;
      reason: string | null;
    }>;
  }>;
  progress: Array<{
    planItemId: string;
    state: string;
    ratio: number;
    note: string | null;
    occurredAt: Date;
  }>;
  memories: Array<{ content: string; source: string; confirmed: boolean; createdAt: Date }>;
  conversations: Array<{
    id: string;
    startedAt: Date;
    lastMessageAt: Date;
    messages: Array<{ direction: string; text: string; createdAt: Date }>;
  }>;
  notifications: Array<{
    kind: string;
    content: string;
    scheduledAt: Date;
    state: string;
  }>;
  channelBindings: Array<{
    channel: string;
    externalUserId: string;
    lastInboundAt: Date | null;
    verifiedAt: Date | null;
  }>;
}> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      email: true,
      name: true,
      timeZone: true,
      role: true,
      createdAt: true,
      settings: {
        select: {
          briefStartTime: true,
          reminderLeadMinutes: true,
          quietHoursStart: true,
          quietHoursEnd: true,
          remindersPaused: true,
          maxRemindersPerDay: true,
        },
      },
      profile: { select: { rawInput: true, structured: true, version: true } },
    },
  });

  const [goals, constraints, plans, progress, memories, conversations, notifications, channelBindings] =
    await Promise.all([
      prisma.goal.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          title: true,
          description: true,
          priority: true,
          state: true,
          targetDate: true,
        },
      }),
      prisma.fixedConstraint.findMany({
        where: { userId },
        orderBy: [{ weekday: "asc" }, { startTime: "asc" }],
        select: {
          id: true,
          kind: true,
          title: true,
          weekday: true,
          localDate: true,
          startTime: true,
          endTime: true,
          timeZone: true,
        },
      }),
      prisma.planVersion.findMany({
        where: { userId },
        orderBy: [{ localDate: "asc" }, { version: "asc" }],
        select: {
          id: true,
          localDate: true,
          timeZone: true,
          version: true,
          state: true,
          basis: true,
          items: {
            orderBy: { startsAt: "asc" },
            select: {
              id: true,
              title: true,
              startsAt: true,
              endsAt: true,
              minutes: true,
              reason: true,
            },
          },
        },
      }),
      prisma.progressEvent.findMany({
        where: { userId },
        orderBy: { occurredAt: "asc" },
        select: {
          planItemId: true,
          state: true,
          ratio: true,
          note: true,
          occurredAt: true,
        },
      }),
      prisma.memory.findMany({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { content: true, source: true, confirmed: true, createdAt: true },
      }),
      prisma.conversation.findMany({
        where: { userId },
        orderBy: { startedAt: "asc" },
        select: {
          id: true,
          startedAt: true,
          lastMessageAt: true,
          messages: {
            orderBy: { createdAt: "asc" },
            select: { direction: true, text: true, createdAt: true },
          },
        },
      }),
      prisma.notification.findMany({
        where: { userId },
        orderBy: { scheduledAt: "asc" },
        select: { kind: true, content: true, scheduledAt: true, state: true },
      }),
      prisma.channelBinding.findMany({
        where: { userId },
        select: {
          channel: true,
          externalUserId: true,
          lastInboundAt: true,
          verifiedAt: true,
        },
      }),
    ]);

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: EXPORT_SCHEMA_VERSION,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      timeZone: user.timeZone,
      role: user.role,
      createdAt: user.createdAt,
    },
    settings: user.settings,
    profile: user.profile,
    goals,
    constraints,
    plans: plans.map((plan) => ({
      id: plan.id,
      localDate: plan.localDate,
      timeZone: plan.timeZone,
      version: plan.version,
      state: plan.state,
      assumptions: plan.basis,
      items: plan.items,
    })),
    progress,
    memories,
    conversations,
    notifications,
    channelBindings,
  };
}
