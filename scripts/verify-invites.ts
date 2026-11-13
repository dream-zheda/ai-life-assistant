/**
 * 邀请制的端到端验证。
 *
 * 前提：PostgreSQL 与 web 服务已经在跑（由调用方启动），DATABASE_URL / APP_BASE_URL 已注入。
 * 它做的不是"单元测试"，而是**用真实 HTTP 走一遍注册流程**，包括失败路径。
 */
import { createInvite } from "../apps/web/src/server/invites";
import { prisma } from "../apps/web/src/server/db";

const BASE = process.env.APP_BASE_URL ?? "http://127.0.0.1:3100";

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

function record(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name} — ${detail}`);
}

async function signUp(params: {
  email: string;
  password?: string;
  name?: string;
  inviteToken?: string | null;
}): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    // 浏览器会自动带上 Origin；Better Auth 的 CSRF 校验依赖它
    origin: BASE,
  };
  if (params.inviteToken !== undefined && params.inviteToken !== null) {
    headers["x-invite-token"] = params.inviteToken;
  }

  const response = await fetch(`${BASE}/api/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: params.email,
      password: params.password ?? "password-123456",
      name: params.name ?? "测试用户",
    }),
  });

  return { status: response.status, body: await response.text() };
}

function snippet(body: string): string {
  return body.length > 120 ? `${body.slice(0, 120)}…` : body;
}

async function main(): Promise<void> {
  // 前置检查：没有服务就直说，不要让它失败在一堆 500 上
  try {
    await fetch(`${BASE}/sign-in`);
  } catch {
    console.error(`连不上 ${BASE}。请先启动 web 服务（pnpm web:dev 或 next start），再跑本脚本。`);
    process.exitCode = 1;
    return;
  }

  // 清空，模拟"全新安装"：邀请表先删（有外键指向 users）
  await prisma.invite.deleteMany({});
  await prisma.user.deleteMany({});
  record("准备：清空 users / invites", true, "库里没有用户了");

  // 1) 引导期：第一个用户不需要邀请码
  const first = await signUp({ email: "admin@example.com", name: "管理员" });
  record(
    "引导期首个用户可注册",
    first.status === 200,
    `status=${first.status} ${first.status === 200 ? "" : snippet(first.body)}`,
  );

  const admin = await prisma.user.findUnique({
    where: { email: "admin@example.com" },
    select: { id: true, role: true },
  });
  record(
    "首个用户自动成为 ADMIN",
    admin?.role === "ADMIN",
    `role=${admin?.role ?? "无用户"}`,
  );

  // 2) 引导期结束后，无邀请码不能再注册
  const second = await signUp({ email: "no-invite@example.com" });
  record(
    "无邀请码注册被拒绝",
    second.status === 400 && second.body.includes("邀请码"),
    `status=${second.status}`,
  );

  // 3) 管理员创建邀请码 → 可以注册
  const invite = await createInvite({ createdByEmail: "admin@example.com" });
  const third = await signUp({ email: "invited@example.com", inviteToken: invite.token });
  record("持有效邀请码可注册", third.status === 200, `status=${third.status}`);

  // 4) 同一个邀请码不能再用
  const reuse = await signUp({ email: "reuse@example.com", inviteToken: invite.token });
  record(
    "邀请码只能用一次",
    reuse.status === 400 && reuse.body.includes("已被使用"),
    `status=${reuse.status}`,
  );

  // 5) 过期的邀请码不可用
  const shortLived = await createInvite({
    createdByEmail: "admin@example.com",
    expiresInHours: 0.0005, // 约 1.8 秒
  });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const expired = await signUp({ email: "expired@example.com", inviteToken: shortLived.token });
  record(
    "过期邀请码被拒绝",
    expired.status === 400 && expired.body.includes("过期"),
    `status=${expired.status}`,
  );

  // 6) 邀请码应关联到被邀请者，可审计
  const redeemed = await prisma.invite.findUnique({
    where: { tokenHash: (await import("node:crypto")).createHash("sha256").update(invite.token).digest("hex") },
    select: { usedAt: true, usedById: true },
  });
  const invited = await prisma.user.findUnique({
    where: { email: "invited@example.com" },
    select: { id: true },
  });
  record(
    "邀请码记录了使用者",
    redeemed?.usedAt !== null && redeemed?.usedById === invited?.id,
    `usedById=${redeemed?.usedById ?? "null"}`,
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log("");
  console.log(`${results.length - failed} / ${results.length} 项通过`);
  if (failed > 0) process.exitCode = 1;
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
