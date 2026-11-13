import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../web/src/server/crypto";
import { consumeQqLinkCode, issueQqLinkCode, unlinkQq } from "@life/db";
import { createOneBotAdapter, type OneBotFetchLike } from "@life/channels";
import { prisma } from "../src/db";
import { handleQqInboundRequest } from "../src/inbound-http";
import { acceptQqFriendRequest } from "../src/qq-friends";
import { dispatchDueNotifications } from "../src/reminders";
import { replyToUser } from "../src/conversation";
import type { LlmAdapter } from "@life/llm";

const A = "int-qq-link-a", B = "int-qq-link-b", BOT = "3463802115", SECRET = "qq-link-test-secret";
const NOW = new Date("2026-11-04T06:00:00Z");
const sentReplies: Array<{ userId: string; text: string }> = [];
function event(extra: Record<string, unknown> = {}) {
  return { self_id: Number(BOT), post_type: "message", detail_type: "private", sub_type: "friend", user_id: 12345678, message_id: 345, raw_message: "帮助", ...extra };
}
async function inbound(payload: Record<string, unknown>, valid = true) {
  const rawBody = JSON.stringify(payload);
  return handleQqInboundRequest({ rawBody, secret: SECRET, now: NOW,
    headers: { "x-signature": "sha1=" + createHmac("sha1", valid ? SECRET : "bad").update(rawBody).digest("hex") },
    sendReply: async (userId, text) => { sentReplies.push({ userId, text }); return "accepted"; },
  });
}
beforeAll(() => {
  vi.stubEnv("ONEBOT_SELF_ID", BOT); vi.stubEnv("ONEBOT_AUTO_ACCEPT_FRIENDS", "true");
  vi.stubEnv("ONEBOT_ENDPOINT", "http://127.0.0.1:3000"); vi.stubEnv("ONEBOT_TOKEN", "test-token"); vi.stubEnv("ONEBOT_SECRET", SECRET);
});
beforeEach(async () => {
  sentReplies.length = 0;
  await prisma.job.deleteMany({ where: { id: { startsWith: "qq-friend-" } } });
  await prisma.user.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.createMany({ data: [{ id: A, email: "qq-link-a@int.test" }, { id: B, email: "qq-link-b@int.test" }] });
});
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  vi.unstubAllEnvs();
  await prisma.job.deleteMany({ where: { id: { startsWith: "qq-friend-" } } });
  await prisma.user.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.$disconnect();
});

describe("QQ 好友、归属验证与用户隔离", () => {
  it("绑定码只存哈希，好友私聊绑定且不记录明文，重放无效", async () => {
    const { code } = await issueQqLinkCode(A, BOT, NOW);
    expect((await prisma.qqLinkCode.findUniqueOrThrow({ where: { userId: A } })).codeHash).not.toContain(code);
    const result = await inbound(event({ raw_message: `绑定 ${code}` }));
    expect(result.body.action).toBe("qq_bound");
    expect((await inbound(event({ raw_message: `绑定 ${code}` }))).body.action).toBe("binding_rejected");
    expect(await prisma.inboundEvent.count({ where: { channelBinding: { userId: A } } })).toBe(0);
    expect(await prisma.channelBinding.findFirst({ where: { userId: A } })).toMatchObject({ externalUserId: "12345678", bridgeSessionId: BOT, verifiedAt: NOW });
    expect(sentReplies[0]).toMatchObject({ userId: "12345678", text: expect.stringContaining("成功绑定") });
  });
  it("群聊、临时私聊、错机器人、假签名均不能绑定", async () => {
    const { code } = await issueQqLinkCode(A, BOT, NOW);
    for (const extra of [{ message_type: "group" }, { sub_type: "group" }, { self_id: 99999 }]) {
      await inbound(event({ raw_message: `绑定 ${code}`, ...extra }));
    }
    await inbound(event({ raw_message: `绑定 ${code}` }), false);
    expect(await prisma.channelBinding.count({ where: { userId: A } })).toBe(0);
  });
  it("过期、撤销、旧码与其他机器人不能消费", async () => {
    const first = await issueQqLinkCode(A, BOT, NOW);
    expect(await consumeQqLinkCode(first.code, "12345678", BOT, new Date(NOW.getTime() + 600000))).toBe(false);
    expect(await consumeQqLinkCode(first.code, "12345678", "99999", NOW)).toBe(false);
    const second = await issueQqLinkCode(A, BOT, new Date(NOW.getTime() + 31000));
    expect(await consumeQqLinkCode(first.code, "12345678", BOT, NOW)).toBe(false);
    await unlinkQq(A);
    expect(await consumeQqLinkCode(second.code, "12345678", BOT, NOW)).toBe(false);
  });
  it("领取码有限流；停用账号不能领取或绑定", async () => {
    const token = await issueQqLinkCode(A, BOT, NOW);
    await expect(issueQqLinkCode(A, BOT, NOW)).rejects.toThrow("30 秒");
    await prisma.user.update({ where: { id: A }, data: { status: "DISABLED" } });
    expect(await consumeQqLinkCode(token.code, "12345678", BOT, NOW)).toBe(false);
    await expect(issueQqLinkCode(A, BOT, new Date(NOW.getTime() + 31000))).rejects.toThrow("账号不可用");
  });
  it("一个 QQ 不能占用两个网页账号；并发同码只能成功一次", async () => {
    const a = await issueQqLinkCode(A, BOT, NOW), b = await issueQqLinkCode(B, BOT, NOW);
    const outcomes = await Promise.all([consumeQqLinkCode(a.code, "12345678", BOT, NOW), consumeQqLinkCode(a.code, "87654321", BOT, NOW)]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const binding = await prisma.channelBinding.findFirstOrThrow({ where: { userId: A } });
    expect(await consumeQqLinkCode(b.code, binding.externalUserId, BOT, NOW)).toBe(false);
    expect(await prisma.channelBinding.count({ where: { userId: B } })).toBe(0);
  });
  it("跨用户并发抢同一个 QQ，唯一约束只允许一个", async () => {
    const a = await issueQqLinkCode(A, BOT, NOW), b = await issueQqLinkCode(B, BOT, NOW);
    const results = await Promise.all([consumeQqLinkCode(a.code, "12345678", BOT, NOW), consumeQqLinkCode(b.code, "12345678", BOT, NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
  it("更换已验证 QQ 必须先解绑", async () => {
    const a = await issueQqLinkCode(A, BOT, NOW);
    await consumeQqLinkCode(a.code, "12345678", BOT, NOW);
    const next = new Date(NOW.getTime() + 31000), b = await issueQqLinkCode(A, BOT, next);
    expect(await consumeQqLinkCode(b.code, "87654321", BOT, next)).toBe(false);
    await unlinkQq(A);
    expect(await prisma.channelBinding.count({ where: { userId: A } })).toBe(0);
  });
  it("好友申请持久化并去重，绝不因加好友就绑定", async () => {
    const request = event({ post_type: "request", request_type: "friend", flag: "test-flag" });
    await Promise.all([inbound(request), inbound(request)]);
    expect(await prisma.job.count({ where: { type: "qq-accept-friend" } })).toBe(1);
    expect(await prisma.channelBinding.count({ where: { userId: A } })).toBe(0);
    expect((await inbound({ ...request, flag: "forged" }, false)).status).toBe(401);
    await inbound({ ...request, request_type: "group", flag: "group" });
    expect(await prisma.job.count({ where: { type: "qq-accept-friend" } })).toBe(1);
  });
  it("自动通过调用 OneBot；已是好友的重试不重复通过", async () => {
    const calls: string[] = []; let friend = false;
    const fake: OneBotFetchLike = async (url, init) => {
      const action = url.split("/").pop()!; calls.push(action);
      if (action === "set_friend_add_request") expect(JSON.parse(init.body)).toEqual({ flag: "flag", approve: true });
      const data = action === "get_login_info" ? { user_id: Number(BOT) } : action === "get_status" ? { online: true } : action === "get_friend_list" ? (friend ? [{ user_id: 12345678 }] : []) : null;
      return { status: 200, text: async () => JSON.stringify({ status: "ok", retcode: 0, data }) };
    };
    const payload = { botId: BOT, flag: "flag", senderId: "12345678", expiresAt: new Date(NOW.getTime() + 60000).toISOString() };
    await acceptQqFriendRequest(payload, NOW, fake); friend = true;
    await acceptQqFriendRequest(payload, NOW, fake);
    expect(calls.filter(x => x === "set_friend_add_request")).toHaveLength(1);
  });
  it("好友请求失败必须抛错交由队列重试", async () => {
    const fake: OneBotFetchLike = async () => ({ status: 200, text: async () => JSON.stringify({ status: "failed", retcode: 100 }) });
    await expect(acceptQqFriendRequest({ botId: BOT, flag: "flag", senderId: "12345678", expiresAt: new Date(NOW.getTime() + 60000).toISOString() }, NOW, fake)).rejects.toThrow();
  });
  it("好友自动同意关闭后绝不调用 OneBot", async () => {
    vi.stubEnv("ONEBOT_AUTO_ACCEPT_FRIENDS", "false");
    let calls = 0;
    await acceptQqFriendRequest({ botId: BOT, flag: "flag", senderId: "12345678", expiresAt: new Date(NOW.getTime() + 60000).toISOString() }, NOW, async () => {
      calls++; return { status: 200, text: async () => "{}" };
    });
    expect(calls).toBe(0);
    vi.stubEnv("ONEBOT_AUTO_ACCEPT_FRIENDS", "true");
  });
  it("提醒只发给对应已验证账号，旧手填记录走站内兜底", async () => {
    const a = await issueQqLinkCode(A, BOT, NOW);
    await consumeQqLinkCode(a.code, "12345678", BOT, NOW);
    await prisma.channelBinding.create({ data: { userId: B, channel: "QQ_ONEBOT", externalUserId: "87654321", verifiedAt: NOW } });
    await prisma.notification.createMany({ data: [A, B].map(userId => ({ userId, dedupeKey: `qq-link-${userId}`, kind: "TEST", content: userId, scheduledAt: NOW })) });
    const sent: string[] = [];
    const adapter = createOneBotAdapter({ endpoint: "http://local", token: "x", secret: SECRET, selfId: BOT, channelInstanceId: BOT,
      fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body).user_id.toString()); return { status: 200, text: async () => JSON.stringify({ status: "ok", retcode: 0, data: { message_id: 1 } }) }; } });
    await dispatchDueNotifications({ adapter, now: NOW });
    expect(sent).toEqual(["12345678"]);
    expect((await prisma.notification.findUniqueOrThrow({ where: { dedupeKey: `qq-link-${B}` } })).state).toBe("FALLBACK_REQUIRED");
    await unlinkQq(A);
    expect((await inbound(event())).status).toBe(202);
  });
  it("自然语言聊天调用用户上下文并连续保存、传入最近对话", async () => {
    const { code } = await issueQqLinkCode(A, BOT, NOW);
    await consumeQqLinkCode(code, "12345678", BOT, NOW);
    await prisma.profile.create({ data: { userId: A, rawInput: "我是学生，希望改善作息。" } });
    const calls: Array<{ system: string; messages: unknown[] }> = [];
    const model: LlmAdapter = { providerId: "test", async generateText(_ref, input) {
      calls.push({ system: input.system ?? "", messages: input.messages });
      return { text: calls.length === 1 ? "先从今天提前十分钟放下手机开始。" : "你刚才说想改善作息，我们可以继续把计划拆小。", model: "test" };
    } };
    const binding = await prisma.channelBinding.findFirstOrThrow({ where: { userId: A } });
    const modelRef = { providerId: "test", modelId: "test-model" };
    const first = await replyToUser({ userId: A, bindingId: binding.id, text: "我最近总是熬夜怎么办？", now: NOW, model: { adapter: model, ref: modelRef } });
    const second = await replyToUser({ userId: A, bindingId: binding.id, text: "能不能再具体一点？", now: new Date(NOW.getTime() + 10000), model: { adapter: model, ref: modelRef } });
    expect(first.reply).toContain("提前十分钟");
    expect(second.reply).toContain("改善作息");
    expect(calls[0]?.system).toContain("我是学生");
    expect(calls[1]?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "我最近总是熬夜怎么办？" }),
      expect.objectContaining({ role: "assistant", content: expect.stringContaining("提前十分钟") }),
      expect.objectContaining({ role: "user", content: "能不能再具体一点？" }),
    ]);
    expect(await prisma.message.count({ where: { conversation: { userId: A, channelBindingId: binding.id } } })).toBe(4);
  });
  it("没有配置模型时给用户明确提示，不冒充 AI 已回复", async () => {
    const result = await replyToUser({ userId: A, bindingId: "missing-binding", text: "你是谁？", now: NOW });
    expect(result.persisted).toBe(false);
    expect(result.reply).toContain("模型 API Key");
  });
  it("签名私聊通过已保存的模型凭据生成并回发，重复事件不重复调用模型", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", "isolated-qq-chat-test-secret");
    const { code } = await issueQqLinkCode(A, BOT, NOW);
    await consumeQqLinkCode(code, "12345678", BOT, NOW);
    await prisma.userSettings.create({ data: { userId: A, llmProvider: "deepseek", llmBaseUrl: "https://model.example.test/v1", llmModel: "deepseek-chat", llmApiKeyCipher: encryptSecret("test-key-only") } });
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toBe("https://model.example.test/v1/chat/completions");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-key-only");
      const payload = JSON.parse(String(init.body));
      expect(payload.model).toBe("deepseek-chat");
      expect(payload.messages.at(-1).content).toBe("今天不想学英语怎么办？");
      return new Response(JSON.stringify({ model: "deepseek-chat", choices: [{ message: { content: "先做五分钟听力，开始就算进步。" } }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fakeFetch);
    const payload = event({ message_id: 600, raw_message: "今天不想学英语怎么办？" });
    expect((await inbound(payload)).body).toMatchObject({ action: "assistant_reply", replyStatus: "accepted" });
    expect(sentReplies).toEqual([{ userId: "12345678", text: "先做五分钟听力，开始就算进步。" }]);
    expect((await inbound(payload)).body.duplicate).toBe(true);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(await prisma.message.count({ where: { conversation: { userId: B } } })).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("fetch failed"); }));
    await inbound(event({ message_id: 601, raw_message: "再给个建议" }));
    expect(sentReplies.at(-1)?.text).toContain("连不上模型服务商");
  });
});
