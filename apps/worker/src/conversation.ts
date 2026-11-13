import type { LlmAdapter, LlmMessage, ModelRef } from "@life/llm";
import { localDayOf } from "@life/shared";
import { prisma } from "./db";
import { resolveUserChatModel } from "./model-config";

const MAX_MESSAGE_LENGTH = 1000;
const MAX_HISTORY_MESSAGES = 12;
const NO_MODEL_REPLY = "我收到你的消息了。要进行 AI 对话，请先在网页的「设置 → 模型」配置可用的模型 API Key。";
type Generator = (adapter: LlmAdapter, ref: ModelRef, system: string, messages: LlmMessage[]) => Promise<string>;

async function generateWithModel(adapter: LlmAdapter, ref: ModelRef, system: string, messages: LlmMessage[]) {
  const result = await adapter.generateText(ref, { system, messages, maxOutputTokens: 500, temperature: 0.6, timeoutMs: 25000 });
  return result.text.trim().slice(0, 3500);
}

function genericReply(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|invalid.*key|unauthorized/i.test(message)) return "模型 API Key 被拒绝了，请到网页「设置 → 模型」检查 Key。";
  if (/timeout|fetch failed|ENOTFOUND|ECONN|429|5\d\d/i.test(message)) return "我暂时连不上模型服务商，请检查网页「设置 → 模型」中的服务商地址和网络，稍后再试。";
  return "这条消息暂时没能生成回复，请稍后重试。";
}

export async function replyToUser(params: {
  userId: string;
  bindingId: string;
  text: string;
  now?: Date;
  generator?: Generator;
  model?: { adapter: LlmAdapter; ref: ModelRef };
}): Promise<{ reply: string; conversationId: string | null; persisted: boolean }> {
  const now = params.now ?? new Date();
  const text = params.text.trim().slice(0, MAX_MESSAGE_LENGTH);
  if (text.length === 0) return { reply: "发一条文字消息给我吧。", conversationId: null, persisted: false };

  const model = params.model ?? await resolveUserChatModel(params.userId);
  if (!model) return { reply: NO_MODEL_REPLY, conversationId: null, persisted: false };

  const recentInbound = await prisma.message.count({ where: {
    direction: "INBOUND", createdAt: { gte: new Date(now.getTime() - 60_000) },
    conversation: { userId: params.userId, channelBindingId: params.bindingId },
  } });
  if (recentInbound >= 5) return { reply: "这几条消息来得有点快，请稍等一分钟再继续。", conversationId: null, persisted: false };

  const [binding, profile, user] = await Promise.all([
    prisma.channelBinding.findFirst({ where: { id: params.bindingId, userId: params.userId, channel: "QQ_ONEBOT", sessionState: "ACTIVE" }, select: { externalUserId: true } }),
    prisma.profile.findUnique({ where: { userId: params.userId }, select: { rawInput: true } }),
    prisma.user.findUnique({ where: { id: params.userId }, select: { timeZone: true } }),
  ]);
  if (!binding) return { reply: "QQ 绑定状态已失效，请重新连接后再聊。", conversationId: null, persisted: false };
  const plan = user ? await prisma.planVersion.findFirst({ where: { userId: params.userId, localDate: localDayOf(now, user.timeZone), state: "ACTIVE" }, include: { items: { orderBy: { startsAt: "asc" }, take: 20 } } }) : null;

  let conversation = await prisma.conversation.findFirst({
    where: { userId: params.userId, channelBindingId: params.bindingId }, orderBy: { lastMessageAt: "desc" }, select: { id: true },
  });
  if (!conversation) conversation = await prisma.conversation.create({ data: { userId: params.userId, channelBindingId: params.bindingId, startedAt: now, lastMessageAt: now }, select: { id: true } });

  const previous = await prisma.message.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "desc" }, take: MAX_HISTORY_MESSAGES, select: { direction: true, text: true } });
  const history: LlmMessage[] = previous.reverse().map(row => ({ role: row.direction === "INBOUND" ? "user" : "assistant", content: row.text }));
  const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: user?.timeZone ?? "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false });
  const tasks = plan?.items.map(item => `${timeFormatter.format(item.startsAt)}-${timeFormatter.format(item.endsAt)} ${item.title}`).join("\n") ?? "今日还没有已生效安排。";
  const context = [
    "你是用户的中文 AI 个人生活助手。简洁、体贴、可执行地回答；默认使用用户语言。",
    "你可以讨论计划、习惯、时间安排和日常问题。只给建议，不声称已修改计划、提醒或账号设置。用户要求实际调整时，引导其在网页确认。不要编造今天的日期或系统已经执行的操作。",
    `用户本地日期：${localDayOf(now, user?.timeZone ?? "Asia/Shanghai")}。`,
    profile?.rawInput ? `用户提供的个人情况（仅作对话上下文）：\n${profile.rawInput.slice(0, 3000)}` : "",
    `当前生效安排：\n${tasks}`,
  ].filter(Boolean).join("\n\n");

  let reply: string;
  try {
    reply = await (params.generator ?? generateWithModel)(model.adapter, model.ref, context, [...history, { role: "user", content: text }]);
  } catch (error) {
    return { reply: genericReply(error), conversationId: conversation.id, persisted: false };
  }
  if (!reply) return { reply: "我这次没有生成文字回复，请换个说法再试。", conversationId: conversation.id, persisted: false };

  await prisma.$transaction([
    prisma.message.create({ data: { conversationId: conversation.id, direction: "INBOUND", text, createdAt: now } }),
    prisma.message.create({ data: { conversationId: conversation.id, direction: "OUTBOUND", text: reply, createdAt: new Date(now.getTime() + 1) } }),
    prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } }),
  ]);
  return { reply, conversationId: conversation.id, persisted: true };
}

export { NO_MODEL_REPLY };
