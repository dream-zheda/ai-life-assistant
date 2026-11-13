/**
 * 端到端走查：一个用户从注册走到"收到提醒并反馈进度"。
 *
 * 为什么需要它：之前每一层都有自己的测试，但**拼起来断了一处**——
 * 计划永远是 DRAFT，worker 只认 ACTIVE，于是"生成计划成功但永远收不到提醒"。
 * 那种 bug 单测全绿、编译通过、日志无异常，只有横切一遍才会暴露。
 *
 * 这条走查跨了：HTTP 注册 → 数据库 → 规划生成 → 采纳 → worker 提醒 → 派发 → 入站回复 → 页面渲染。
 *
 * 用法：pnpm e2e
 * 前置：先跑过一次 `pnpm web:build`（脚本会检查 .next 是否存在）。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { CHANNEL_POLICIES } from "@life/channels";
import { createMockAdapter } from "@life/llm";

import { prisma } from "../apps/web/src/server/db";
import { activatePlanVersion } from "../apps/web/src/server/plan-activation";
import { generateTodayPlan } from "../apps/web/src/server/planning";
import { createInvite } from "../apps/web/src/server/invites";
import { createConsoleAdapter } from "../apps/worker/src/channels/console";
import { handleInboundMessage } from "../apps/worker/src/inbound";
import {
  dispatchDueNotifications,
  enqueueMorningBriefs,
  enqueueStartReminders,
} from "../apps/worker/src/reminders";

const TZ = "Asia/Shanghai";
const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = "e2e-admin@local.test";
const USER_EMAIL = "e2e-user@local.test";

type WalkthroughResult = { name: string; ok: boolean; detail: string };

const results: WalkthroughResult[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function todayLocal(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** 固定在一个容易构造场景的时刻：今天 07:10（早报窗口内）。 */
function scenarioNow(): Date {
  return new Date(`${todayLocal()}T07:10:00+08:00`);
}

async function waitForServer(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/sign-in`);
      return true;
    } catch {
      await sleep(500);
    }
  }
  return false;
}

async function cleanup(): Promise<void> {
  await prisma.invite.deleteMany({ where: { createdBy: { email: ADMIN_EMAIL } } });
  await prisma.user.deleteMany({ where: { email: { in: [ADMIN_EMAIL, USER_EMAIL] } } });
}

// ---------------------------------------------------------------------------

if (!existsSync(path.join(import.meta.dirname, "..", "apps/web/.next/BUILD_ID"))) {
  console.error("找不到 apps/web/.next/BUILD_ID —— 先跑 `pnpm web:build`");
  process.exit(1);
}

const now = scenarioNow();
const day = todayLocal();
let server;

try {
  console.log(`[e2e] 场景时间 ${day} 07:10 ${TZ}\n`);

  await cleanup();

  // 1) 准备一个管理员（直接写库），由他发邀请码
  const admin = await prisma.user.create({
    data: { email: ADMIN_EMAIL, name: "E2E Admin", role: "ADMIN", timeZone: TZ },
  });
  const invite = await createInvite({ createdByEmail: ADMIN_EMAIL, expiresInHours: 1 });
  record("准备：管理员与邀请码", true, admin.id);

  // 2) 起 web 服务
  server = spawn(process.execPath, [
    path.join(import.meta.dirname, "..", "node_modules/next/dist/bin/next"),
    "start",
    "-p",
    String(PORT),
  ], {
    cwd: path.join(import.meta.dirname, "..", "apps/web"),
    env: { ...process.env, APP_BASE_URL: BASE, AUTH_RATE_LIMIT: "off" },
    stdio: "ignore",
  });
  const ready = await waitForServer();
  record("web 服务启动", ready, BASE);
  if (!ready) throw new Error("web 未能在 60s 内就绪");

  // 3) HTTP 注册（带邀请码）
  const signUp = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "x-invite-token": invite.token },
    body: JSON.stringify({ email: USER_EMAIL, password: "e2e-password-123", name: "E2E User" }),
  });
  const cookies = signUp.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  record("HTTP 注册（持邀请码）", signUp.status === 200 && cookies.length > 0, `status=${signUp.status}`);

  const user = await prisma.user.findUnique({ where: { email: USER_EMAIL } });
  if (user === null) throw new Error("注册后找不到用户");
  record("新用户不是管理员", user.role === "USER", `role=${user.role}`);

  const authHeaders = { cookie: cookies };

  // 4) 录入目标与固定安排（走服务层，等价于 onboarding 的写入）
  const goal = await prisma.goal.create({
    data: { userId: user.id, title: "提高英语听力", priority: 1 },
  });
  await prisma.fixedConstraint.create({
    data: {
      userId: user.id,
      kind: "WEEKLY",
      title: "高数课",
      weekday: 2,
      startTime: "08:00",
      endTime: "09:00",
      timeZone: TZ,
    },
  });
  await prisma.channelBinding.create({
    data: {
      userId: user.id,
      channel: "PERSONAL_WECHAT",
      externalUserId: `wx-${user.id}`,
      lastInboundAt: new Date(now.getTime() - 60 * 60 * 1000),
    },
  });
  record("录入目标、固定安排、通道绑定", true, "1 个目标 / 1 条约束 / 已绑定");

  // 5) 生成计划（用固定输出的 mock，避免依赖真实模型）
  const planJson = JSON.stringify({
    localDate: day,
    timezone: TZ,
    items: [
      {
        title: "背单词",
        startAt: `${day}T07:15:00+08:00`,
        endAt: `${day}T07:45:00+08:00`,
        goalId: goal.id,
        reason: "早上记忆最好",
      },
    ],
    assumptions: [],
    unresolvedQuestions: [],
  });

  const generated = await generateTodayPlan(user.id, TZ, {
    now,
    adapter: createMockAdapter({ respond: () => planJson }),
    ref: { providerId: "mock", modelId: "e2e" },
    mode: "mock",
  });
  record("生成计划（DRAFT）", generated.ok && generated.itemCount === 1, `items=${generated.itemCount}`);

  // 6) 页面应显示"未生效"与采纳入口（这正是上轮补的断点）
  const draftPage = await fetch(`${BASE}/today`, { headers: authHeaders });
  const draftHtml = await draftPage.text();
  record(
    "页面显示「采纳这份计划」",
    draftPage.status === 200 && draftHtml.includes("采纳这份计划"),
    `status=${draftPage.status}`,
  );
  record("页面在采纳前不显示为已生效", !draftHtml.includes("计划已采纳"), "");

  // 7) 采纳
  const planVersion = await prisma.planVersion.findFirstOrThrow({
    where: { userId: user.id, localDate: day },
    orderBy: { version: "desc" },
  });
  const activated = await activatePlanVersion({
    userId: user.id,
    planVersionId: planVersion.id,
    now,
  });
  record("采纳计划（DRAFT → ACTIVE）", activated.ok, activated.ok ? "" : activated.reason);

  // 8) worker 生成提醒
  const startReminders = await enqueueStartReminders(now);
  const briefs = await enqueueMorningBriefs(now);
  record("worker 生成单项提醒", startReminders >= 1, `${startReminders} 条`);
  record("worker 生成早报", briefs >= 1, `${briefs} 条`);

  // 9) 派发到通道
  const channel = createConsoleAdapter({
    policy: CHANNEL_POLICIES["personal-wechat"],
  });
  const dispatched = await dispatchDueNotifications({ now, adapter: channel });
  record("派发提醒", dispatched.sent >= 1, `sent=${dispatched.sent} fallback=${dispatched.fallback}`);

  const sentText = channel.sent.map((message) => message.text).join("\n---\n");
  record("消息内容包含安排标题", sentText.includes("背单词"), "");
  record("消息包含可执行回法", sentText.includes("回复"), "");

  // 10) 用户回复「1」，记录进度
  const inbound = await handleInboundMessage({ userId: user.id, text: "1", now });
  record("入站回复被处理", inbound.action === "progress", inbound.reply ?? inbound.action);

  // 11) 页面反映进度
  const donePage = await fetch(`${BASE}/today`, { headers: authHeaders });
  const doneHtml = await donePage.text();
  record(
    "页面显示已完成",
    doneHtml.includes("已完成"),
    `status=${donePage.status}`,
  );

  await cleanup();
  record("清理测试数据", true, "");
} catch (error) {
  record("走查未中断", false, error instanceof Error ? error.message : String(error));
} finally {
  if (server !== undefined) server.kill();
  await prisma.$disconnect();
}

const failed = results.filter((item) => !item.ok).length;
console.log("");
if (failed > 0) {
  console.error(`${failed} / ${results.length} 项失败`);
  process.exit(1);
}
console.log(`${results.length} / ${results.length} 项通过 — 主链路闭环`);
