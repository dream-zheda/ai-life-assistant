import { describe, expect, it } from "vitest";

import {
  applyReport,
  canTransition,
  isTerminal,
  markSkipped,
  resolveObservedState,
} from "../src/index.js";

describe("状态流转", () => {
  it("允许从待进行开始", () => {
    expect(canTransition("pending", "in_progress")).toBe(true);
  });

  it("已完成是终态：不能被打回未开始", () => {
    expect(canTransition("done", "pending")).toBe(false);
    expect(isTerminal("done")).toBe(true);
  });

  it("跳过之后可以重新安排", () => {
    const skipped = markSkipped("pending");
    expect(skipped).toBe("skipped");
    expect(canTransition("skipped", "pending")).toBe(true);
  });
});

describe("applyReport", () => {
  it("部分完成保留实际进度", () => {
    expect(applyReport("in_progress", { ratio: 0.4 })).toEqual({
      state: "partially_done",
      ratio: 0.4,
    });
  });

  it("完成比例为 1 才标记完成", () => {
    expect(applyReport("in_progress", { ratio: 1 })).toEqual({ state: "done", ratio: 1 });
  });

  it("明确报告一点没做时回到待进行，而不是跳过", () => {
    expect(applyReport("in_progress", { ratio: 0 })).toEqual({ state: "pending", ratio: 0 });
  });

  it("已完成之后拒绝再次提交完成度", () => {
    expect(() => applyReport("done", { ratio: 1 })).toThrow(/终态/);
  });
});

describe("resolveObservedState", () => {
  it("没有反馈时显示未知，而不是未完成", () => {
    expect(resolveObservedState("pending", false)).toBe("unknown");
  });

  it("有反馈时按真实状态展示", () => {
    expect(resolveObservedState("pending", true)).toBe("pending");
    expect(resolveObservedState("done", false)).toBe("done");
  });

  it("「开始」不等于「完成」", () => {
    expect(resolveObservedState("in_progress", true)).toBe("in_progress");
  });
});
