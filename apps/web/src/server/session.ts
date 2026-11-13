import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { auth } from "./auth";
import { prisma } from "./db";

/**
 * 会话解析。
 *
 * 由 Better Auth 校验 cookie 并返回 session，再回库取我们自己的字段（role / status / timeZone）。
 * 不信任任何来自表单或 URL 的用户标识。
 */

export type CurrentUser = {
  id: string;
  email: string;
  name: string | null;
  timeZone: string;
  role: "USER" | "ADMIN";
};

async function loadUser(): Promise<CurrentUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session === null) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, email: true, name: true, timeZone: true, status: true, role: true },
  });

  // 已停用的账号即使持有有效 session 也不放行
  if (user === null || user.status !== "ACTIVE") return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    timeZone: user.timeZone,
    role: user.role,
  };
}

export async function getOptionalUser(): Promise<CurrentUser | null> {
  return loadUser();
}

/** 页面与动作统一入口：没有有效会话就跳转登录。 */
export async function getCurrentUser(): Promise<CurrentUser> {
  const user = await loadUser();
  if (user === null) redirect("/sign-in");
  return user;
}

/**
 * 管理员入口。
 *
 * 非管理员直接送回 /today，而不是显示"无权限"页——
 * 后者等于告诉对方"这里有个管理后台，只是你进不去"。
 */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { role: true },
  });
  if (row?.role !== "ADMIN") redirect("/today");
  return user;
}
