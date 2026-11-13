/**
 * 创建邀请码（管理员用）。
 *
 * 用法：
 *   node scripts/dev-db.mjs node node_modules/tsx/dist/cli.mjs scripts/create-invite.ts <管理员邮箱> [有效期小时数]
 *
 * 输出一条邀请链接。明文令牌只在这里出现一次，数据库只存 sha256 摘要。
 */
import { createInvite } from "../apps/web/src/server/invites";
import { prisma } from "../apps/web/src/server/db";

const email = process.argv[2];
const hours = process.argv[3] === undefined ? undefined : Number(process.argv[3]);

if (email === undefined || email.length === 0) {
  console.error("用法: create-invite.ts <管理员邮箱> [有效期小时数]");
  process.exit(1);
}

if (hours !== undefined && (!Number.isFinite(hours) || hours <= 0)) {
  console.error("有效期小时数必须是正数");
  process.exit(1);
}

try {
  const created = await createInvite({
    createdByEmail: email,
    ...(hours === undefined ? {} : { expiresInHours: hours }),
  });

  const base = process.env.APP_BASE_URL ?? "http://127.0.0.1:3100";
  console.log(`邀请码: ${created.token}`);
  console.log(`有效期至: ${created.expiresAt.toISOString()}`);
  console.log(`邀请链接: ${base}/sign-up?invite=${created.token}`);
} catch (error) {
  console.error("创建失败:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
