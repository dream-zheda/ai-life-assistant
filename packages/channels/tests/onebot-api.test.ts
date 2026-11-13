import { describe, expect, it } from "vitest";
import { checkQqBot, oneBotCall, qqBotConfig, type OneBotFetchLike } from "../src/index.js";
const config = { endpoint: "http://localhost:3000", token: "token", secret: "secret", selfId: "123456" };
const response = (data: unknown) => ({ status: 200, text: async () => JSON.stringify({ status: "ok", retcode: 0, data }) });
describe("QQ 机器人配置与在线状态", () => {
  it("配置缺少身份或签名密钥时不启用", () => {
    expect(qqBotConfig({ ONEBOT_ENDPOINT: "http://localhost", ONEBOT_TOKEN: "x" })).toBeNull();
    expect(qqBotConfig({ ONEBOT_ENDPOINT: "http://localhost", ONEBOT_TOKEN: "x", ONEBOT_SECRET: "s", ONEBOT_SELF_ID: "123456" })?.selfId).toBe("123456");
  });
  it("登录身份和在线状态同时正确才就绪", async () => {
    const fake: OneBotFetchLike = async url => response(url.endsWith("get_login_info") ? { user_id: 123456, nickname: "助手" } : { online: true, good: true });
    expect(await checkQqBot(config, fake)).toEqual({ nickname: "助手" });
  });
  it("账号错配不能用其他 QQ 发提醒", async () => {
    await expect(checkQqBot(config, async () => response({ user_id: 999999 }))).rejects.toThrow("MISMATCH");
  });
  it("离线不可误报为在线", async () => {
    const fake: OneBotFetchLike = async url => response(url.endsWith("get_login_info") ? { user_id: 123456 } : { online: false });
    await expect(checkQqBot(config, fake)).rejects.toThrow("OFFLINE");
  });
  it("HTTP 200 但动作失败或错误结构必须报错", async () => {
    for (const body of [{ status: "failed", retcode: 100 }, {}, null]) {
      await expect(oneBotCall(config, "set_friend_add_request", {}, async () => ({ status: 200, text: async () => JSON.stringify(body) }))).rejects.toThrow();
    }
  });
});
