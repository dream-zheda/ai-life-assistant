import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { prismaAdapter } from "better-auth/adapters/prisma";

import { prisma } from "./db";
import {
  attributeInvite,
  consumeInvite,
  InviteError,
  isBootstrapWindow,
  readInviteToken,
} from "./invites";

function inviteErrorToApiError(error: unknown): APIError {
  if (error instanceof InviteError) {
    // 不区分"不存在"与"已用过"的具体细节给前端，避免被用来枚举邀请码
    return new APIError("BAD_REQUEST", { message: error.message });
  }
  return new APIError("BAD_REQUEST", { message: "邀请码校验失败" });
}

/**
 * Better Auth 配置。
 *
 * schema 对齐说明：
 * - 我们已经按 Better Auth 的核心字段建了 users / sessions / accounts / verifications 四张表
 *   （物理表名复数，由 Prisma 的 @@map 处理，适配器调用的仍是 prisma.user 等模型名）。
 * - 刻意**不**把 role / status / timeZone 放进 additionalFields：
 *   它们是数据库枚举/默认值，交给 DB 默认值填充更稳，避免字符串与 PG enum 打架。
 *   timeZone 需要时直接用 prisma 读。
 *
 * 邀请制：注册在 `databaseHooks.user.create.before` 里拦截。
 * 放在这一层而不是页面/路由里，是因为**所有注册路径都会经过它**——
 * 无论前端怎么调、有没有绕过我们的表单。
 */
export const auth = betterAuth({
  baseURL: process.env.APP_BASE_URL ?? "http://127.0.0.1:3100",
  // Public access can use a separate session key without re-encrypting model credentials.
  secret: process.env.AUTH_SESSION_SECRET ?? process.env.BETTER_AUTH_SECRET ?? "dev-only-insecure-secret-change-me",
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    minPasswordLength: 8,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    // 生产必须保持开启：登录/注册是最容易被撞库的入口。
    // 端到端验证时用 AUTH_RATE_LIMIT=off 关掉，否则连发几个注册请求会被 429 拦下，
    // 掩盖真正要验证的逻辑（邀请码一次性、过期）。
    enabled: process.env.AUTH_RATE_LIMIT !== "off",
    window: 60,
    max: 10,
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          // 引导期：库里还没有任何用户时放行，否则会陷入死锁（没人能创建邀请码）
          if (await isBootstrapWindow()) {
            return { data: user };
          }

          const token = readInviteToken(context);
          if (token === null) {
            throw new APIError("BAD_REQUEST", { message: "注册需要邀请码" });
          }

          try {
            await consumeInvite(token);
          } catch (error) {
            throw inviteErrorToApiError(error);
          }

          return { data: user };
        },
        after: async (user, context) => {
          const total = await prisma.user.count();

          // 第一个用户自动成为管理员
          if (total === 1) {
            await prisma.user.update({
              where: { id: user.id },
              data: { role: "ADMIN" },
            });
          }

          const token = readInviteToken(context);
          if (token !== null) {
            await attributeInvite(token, user.id);
          }
        },
      },
    },
  },
  advanced: {
    // HTTPS tunnels terminate TLS before forwarding to the local HTTP server.
    useSecureCookies: process.env.APP_BASE_URL?.startsWith("https://") ?? false,
  },
});

export type AuthSession = typeof auth.$Infer.Session;

