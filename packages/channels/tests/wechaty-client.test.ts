import { describe, expect, it } from "vitest";

import {
  createWechatyBridgeClient,
  createWechatyClientFromEnv,
  type WechatyFetchLike,
} from "../src/index.js";

/**
 * wechaty 桥接客户端的单元测试。
 *
 * 只覆盖"我们怎么理解桥接服务的状态"。
 * 真实的 wechaty 行为（扫码、登录、掉线）无法在这里验证。
 */

function fakeFetch(statusCode: number, body: string): { impl: WechatyFetchLike; calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  const impl: WechatyFetchLike = async (url, init) => {
    calls.push({ url, method: init.method });
    return { status: statusCode, text: async () => body };
  };
  return { impl, calls };
}

const BASE = { endpoint: "http://bridge.local/", token: "t" };

describe("createWechatyBridgeClient", () => {
  it("解析 offline", async () => {
    const { impl } = fakeFetch(200, JSON.stringify({ state: "offline" }));
    const client = createWechatyBridgeClient({ ...BASE, fetchImpl: impl });
    expect(await client.getStatus()).toEqual({ state: "offline" });
  });

  it("解析 scan 并带上二维码图片", async () => {
    const { impl, calls } = fakeFetch(
      200,
      JSON.stringify({ state: "scan", qrcodeDataUrl: "data:image/png;base64,AAA" }),
    );
    const client = createWechatyBridgeClient({ ...BASE, fetchImpl: impl });

    expect(await client.getStatus()).toEqual({
      state: "scan",
      qrcodeDataUrl: "data:image/png;base64,AAA",
    });
    expect(calls[0]?.url).toBe("http://bridge.local/status");
  });

  it("解析 logged_in 并带上账号 id", async () => {
    const { impl } = fakeFetch(
      200,
      JSON.stringify({ state: "logged_in", accountId: "wxid_abc", displayName: "我的小号" }),
    );
    const client = createWechatyBridgeClient({ ...BASE, fetchImpl: impl });

    expect(await client.getStatus()).toEqual({
      state: "logged_in",
      accountId: "wxid_abc",
      displayName: "我的小号",
    });
  });

  it("字段缺失或未知状态返回 null，而不是抛异常", async () => {
    for (const body of [
      JSON.stringify({ state: "scan" }),
      JSON.stringify({ state: "logged_in" }),
      JSON.stringify({ state: "weird" }),
      "not json",
      JSON.stringify(null),
    ]) {
      const { impl } = fakeFetch(200, body);
      const client = createWechatyBridgeClient({ ...BASE, fetchImpl: impl });
      expect(await client.getStatus()).toBeNull();
    }
  });

  it("桥接返回非 200 时视为不可用", async () => {
    const { impl } = fakeFetch(503, "{}");
    const client = createWechatyBridgeClient({ ...BASE, fetchImpl: impl });
    expect(await client.getStatus()).toBeNull();
  });

  it("网络异常时返回 null（页面显示离线，不要崩）", async () => {
    const impl: WechatyFetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const client = createWechatyBridgeClient({ ...BASE, fetchImpl: impl });
    expect(await client.getStatus()).toBeNull();
  });

  it("logout 成功/失败返回布尔", async () => {
    const ok = createWechatyBridgeClient({
      ...BASE,
      fetchImpl: fakeFetch(200, "{}").impl,
    });
    expect(await ok.logout()).toBe(true);

    const bad = createWechatyBridgeClient({
      ...BASE,
      fetchImpl: fakeFetch(500, "{}").impl,
    });
    expect(await bad.logout()).toBe(false);
  });
});

describe("createWechatyClientFromEnv", () => {
  it("缺少任一必要变量时返回 null", () => {
    expect(createWechatyClientFromEnv({})).toBeNull();
    expect(createWechatyClientFromEnv({ WECHAT_BRIDGE_URL: "http://x" })).toBeNull();
    expect(createWechatyClientFromEnv({ WECHAT_BRIDGE_TOKEN: "t" })).toBeNull();
    expect(createWechatyClientFromEnv({ WECHAT_BRIDGE_URL: "", WECHAT_BRIDGE_TOKEN: "t" })).toBeNull();
  });

  it("变量齐全时构造成功", () => {
    expect(
      createWechatyClientFromEnv({
        WECHAT_BRIDGE_URL: "http://bridge.local",
        WECHAT_BRIDGE_TOKEN: "t",
      }),
    ).not.toBeNull();
  });
});
