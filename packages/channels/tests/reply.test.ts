import { describe, expect, it } from "vitest";

import { ACTION_RATIO, HELP_TEXT, parseReply } from "../src/index.js";

describe("parseReply：裸数字", () => {
  it("1 / 2 / 3 映射到完成 / 一半 / 跳过", () => {
    expect(parseReply("1")).toEqual({ kind: "progress", action: "done", ratio: 1, index: null });
    expect(parseReply("2")).toEqual({ kind: "progress", action: "half", ratio: 0.5, index: null });
    expect(parseReply("3")).toEqual({ kind: "progress", action: "skip", ratio: 0, index: null });
  });

  it("容忍全角数字与空白", () => {
    expect(parseReply(" １ ")).toEqual({
      kind: "progress",
      action: "done",
      ratio: 1,
      index: null,
    });
  });

  it("容忍句末标点", () => {
    expect(parseReply("2。")).toMatchObject({ kind: "progress", action: "half" });
  });

  it("4 及更大的裸数字不是有效指令", () => {
    expect(parseReply("4")).toEqual({ kind: "unknown" });
  });
});

describe("parseReply：文字命令", () => {
  it("完成 / 做了一半 / 跳过", () => {
    expect(parseReply("完成")).toMatchObject({ action: "done", index: null });
    expect(parseReply("做了一半")).toMatchObject({ action: "half", index: null });
    expect(parseReply("跳过")).toMatchObject({ action: "skip", index: null });
  });

  it("英文也认", () => {
    expect(parseReply("done")).toMatchObject({ action: "done" });
    expect(parseReply("SKIP")).toMatchObject({ action: "skip" });
  });
});

describe("parseReply：带序号的命令", () => {
  it("「完成 2」解析为第 2 项完成", () => {
    expect(parseReply("完成 2")).toEqual({
      kind: "progress",
      action: "done",
      ratio: 1,
      index: 2,
    });
  });

  it("容忍无空格与「第…项」", () => {
    expect(parseReply("跳过3")).toMatchObject({ action: "skip", index: 3 });
    expect(parseReply("完成第 2 项")).toMatchObject({ action: "done", index: 2 });
  });

  it("序号为 0 或非数字时不算有效指令", () => {
    expect(parseReply("完成 0")).toEqual({ kind: "unknown" });
    expect(parseReply("完成 x")).toEqual({ kind: "unknown" });
  });
});

describe("parseReply：其他", () => {
  it("帮助指令", () => {
    expect(parseReply("?")).toEqual({ kind: "help" });
    expect(parseReply("帮助")).toEqual({ kind: "help" });
  });

  it("无法识别的自由文本返回 unknown，交给后续对话处理", () => {
    expect(parseReply("今天下午要加班")).toEqual({ kind: "unknown" });
  });

  it("空字符串是 unknown", () => {
    expect(parseReply("   ")).toEqual({ kind: "unknown" });
  });
});

describe("常量", () => {
  it("比例与动作对应", () => {
    expect(ACTION_RATIO).toEqual({ done: 1, half: 0.5, skip: 0 });
  });

  it("帮助文案覆盖所有可用指令", () => {
    expect(HELP_TEXT).toContain("回复 1 / 2 / 3");
    expect(HELP_TEXT).toContain("完成 2");
  });
});
