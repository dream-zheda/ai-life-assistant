import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_LENGTH,
  clampToLength,
  describeFallback,
  renderMorningBrief,
  renderStartReminder,
} from "../src/index.js";

const item = {
  title: "背单词",
  startTime: "10:30",
  endTime: "11:00",
  goalTitle: "提高英语听力",
};

describe("renderStartReminder", () => {
  it("包含时间、标题、目标与可执行回法", () => {
    const text = renderStartReminder(item, { leadMinutes: 10 });

    expect(text).toContain("10 分钟后开始");
    expect(text).toContain("背单词");
    expect(text).toContain("10:30–11:00");
    expect(text).toContain("目标：提高英语听力");
    expect(text).toContain("回复 1 完成");
  });

  it("没有目标时不留空行", () => {
    const text = renderStartReminder({ title: "喝水", startTime: "09:00", endTime: "09:05" });
    expect(text).not.toContain("目标：");
  });

  it("超长标题会被截断且不超过上限", () => {
    const text = renderStartReminder({ ...item, title: "很长很长的标题".repeat(200) });
    expect([...text].length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("renderMorningBrief", () => {
  const threeItems = [
    { title: "高数课", startTime: "08:30", endTime: "10:00" },
    { title: "背单词", startTime: "10:30", endTime: "11:00", goalTitle: "提高英语听力" },
    { title: "运动", startTime: "16:00", endTime: "16:30", goalTitle: "规律运动" },
  ];

  it("列出全部条目并带编号", () => {
    const text = renderMorningBrief({ dateLabel: "11月3日 周二", items: threeItems });

    expect(text).toContain("今天 11月3日 周二");
    expect(text).toContain("1. 08:30–10:00 高数课");
    expect(text).toContain("2. 10:30–11:00 背单词（提高英语听力）");
    expect(text).toContain("3. 16:00–16:30 运动（规律运动）");
  });

  it("条目多时优先砍条目、明确告知还有几项，而不是截断半句话", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      title: `任务${index + 1}`,
      startTime: "09:00",
      endTime: "09:30",
    }));

    const text = renderMorningBrief({ dateLabel: "11月3日 周二", items: many });

    expect([...text].length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(text).toContain("另有");
    expect(text).not.toContain("任务30");
    // 结尾提示必须完整保留，不能切在半句
    expect(text).toContain("回复「完成 2」");
  });

  it("没有安排时给出明确说明", () => {
    const text = renderMorningBrief({ dateLabel: "11月3日 周二", items: [] });
    expect(text).toContain("今天没有安排");
  });

  it("maxItems 可以限制展示条数", () => {
    const text = renderMorningBrief({ dateLabel: "11月3日 周二", items: threeItems, maxItems: 2 });
    expect(text).toContain("另有 1 项");
    expect(text).not.toContain("运动");
  });
});

describe("clampToLength", () => {
  it("按码点截断，不切坏 emoji", () => {
    const text = "😀".repeat(10);
    const clamped = clampToLength(text, 5);
    expect([...clamped]).toHaveLength(5);
    expect(clamped).toBe("😀😀😀😀…");
  });

  it("未超长时原样返回", () => {
    expect(clampToLength("短消息", 100)).toBe("短消息");
  });
});

describe("describeFallback", () => {
  it("区分两种窗口关闭原因", () => {
    expect(describeFallback("never_contacted")).toContain("从未");
    expect(describeFallback("window_expired")).toContain("窗口");
  });
});
