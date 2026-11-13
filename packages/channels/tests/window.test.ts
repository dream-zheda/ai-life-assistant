import { describe, expect, it } from "vitest";

import {
  CHANNEL_POLICIES,
  decideProactiveDelivery,
  evaluateDeliveryWindow,
} from "../src/index.js";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-03T07:30:00+08:00");
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe("个人微信的 24 小时窗口", () => {
  const policy = CHANNEL_POLICIES["personal-wechat"];

  it("从未收到过消息时不能主动推送", () => {
    expect(evaluateDeliveryWindow(policy, null, NOW)).toEqual({
      kind: "closed",
      reason: "never_contacted",
    });
  });

  it("用户刚发过消息时窗口开放", () => {
    const window = evaluateDeliveryWindow(policy, ago(1 * HOUR), NOW);
    expect(window.kind).toBe("open");
  });

  it("超过 24 小时后窗口关闭", () => {
    expect(evaluateDeliveryWindow(policy, ago(24 * HOUR), NOW)).toEqual({
      kind: "closed",
      reason: "window_expired",
    });
  });

  it("恰好 23 小时 59 分仍在窗口内", () => {
    expect(evaluateDeliveryWindow(policy, ago(24 * HOUR - 60_000), NOW).kind).toBe("open");
  });
});

describe("个人订阅号", () => {
  const policy = CHANNEL_POLICIES["official-account-subscription"];

  it("窗口长度为 0，任何时刻都不能主动推送", () => {
    expect(evaluateDeliveryWindow(policy, ago(1_000), NOW)).toEqual({
      kind: "closed",
      reason: "window_expired",
    });
  });
});

describe("认证企业服务号与企业微信", () => {
  it("服务号不受窗口限制", () => {
    const policy = CHANNEL_POLICIES["official-account-service"];
    expect(evaluateDeliveryWindow(policy, null, NOW)).toEqual({ kind: "unrestricted" });
  });

  it("企业微信应用不受窗口限制", () => {
    const policy = CHANNEL_POLICIES["wecom-app"];
    expect(decideProactiveDelivery(policy, null, NOW)).toEqual({
      action: "send",
      expiresAt: null,
    });
  });
});

describe("decideProactiveDelivery", () => {
  it("窗口开放时给出截止时间，便于提前发送", () => {
    const policy = CHANNEL_POLICIES["personal-wechat"];
    const decision = decideProactiveDelivery(policy, ago(2 * HOUR), NOW);

    expect(decision.action).toBe("send");
    if (decision.action === "send") {
      expect(decision.expiresAt?.toISOString()).toBe(ago(-22 * HOUR).toISOString());
    }
  });

  it("窗口关闭时降级，而不是假装发得出去", () => {
    const policy = CHANNEL_POLICIES["personal-wechat"];
    const decision = decideProactiveDelivery(policy, ago(30 * HOUR), NOW);

    expect(decision.action).toBe("fallback");
    if (decision.action === "fallback") {
      expect(decision.reason).toBe("window_expired");
      expect(decision.hint).toContain("主动发一条消息");
    }
  });
});
