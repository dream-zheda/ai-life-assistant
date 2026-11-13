# ADR-004：Better Auth 接入方式

- 状态：已采纳
- 日期：2026-11-03
- 相关：`apps/web/src/server/auth.ts`、`apps/web/src/server/session.ts`

## 背景

规划书 §3 要求"账号：邀请注册、登录、退出、账号停用；**使用成熟认证库**"。
此前 `getCurrentUser()` 是临时实现，固定返回演示用户——那只是让页面能渲染，不构成认证。

选用 **Better Auth 1.7.15**（规划书 §8 的建议项），因为它提供的
`email/password + session + Prisma adapter` 正好覆盖第一版需求，且不需要自建密码哈希与 session 表。

## 决策

### 1. 复用已有的四张表，不另外生成 schema

我们在 P1 建表时已按 Better Auth 的核心字段设计：`users` / `sessions` / `accounts` / `verifications`。
物理表名是复数，由 Prisma 的 `@@map` 负责，适配器调用的仍是 `prisma.user` 模型名，
因此**不需要** `usePlural`，也不需要改表名。

### 2. role / status / timeZone 不进 `additionalFields`

这三个字段在数据库里分别是 PG 枚举（`UserRole`）、枚举（`UserStatus`）和带默认值的字符串。
如果把 `role` 声明成 Better Auth 的 `additionalFields: { type: "string" }`，
适配器写入时会用字符串去碰 PG 枚举列，属于自找类型摩擦。

**结论**：注册时只写 Better Auth 的核心字段，`role` / `status` / `timeZone` 交给数据库默认值，
需要时用 Prisma 直接读。代价是注册页无法一次填时区——第一版默认 `Asia/Shanghai` 可接受。

### 3. 本地关闭 Secure cookie

本地是 `http://127.0.0.1:3100`，`Secure` cookie 不会被浏览器回传，登录会"成功但立刻掉线"。
`advanced.useSecureCookies: false` 明确关闭；生产必须打开。

### 4. 守卫放在服务端组件里，用 redirect

```ts
export async function getCurrentUser(): Promise<CurrentUser> {
  const user = await loadUser();
  if (user === null) redirect("/sign-in");
  return user;
}
```

而不是在页面里写 `if (!user) return <LoginPrompt/>`。理由：**漏判的后果不同**。
`redirect` 写在唯一的入口函数里，任何页面忘记处理都拿不到 user，会直接跳转；
而"渲染提示"只要少写一处，就会在无会话时把页面骨架渲染出去。

### 5. 停用账号即使持有有效 session 也不放行

`loadUser()` 除了查 session，还检查 `status === "ACTIVE"`。
否则管理员停用账号后，用户只要不清 cookie 就还能继续用。

## 验证方式（真实 HTTP，不是"能编译"）

| 步骤 | 结果 |
| --- | --- |
| 未登录 `GET /today` | `307 → /sign-in` |
| `POST /api/auth/sign-up/email`（alice） | `200`，返回 token 并写入 session cookie |
| alice `GET /today` | `200`，页面显示 `alice@example.com` |
| 注册 bob 后 `GET /today` | `200`，显示 `bob@example.com`，**看不到 alice 的任何内容** |

这是 P1 验收条件「两个账号互相隔离」的直接证据。

## 未做的部分

| 事项 | 影响 |
| --- | --- |
| ~~邀请码~~ | **已补**，见 ADR-006（在 `databaseHooks.user.create.before` 拦截） |
| 邮箱验证 | `emailVerified` 恒为 false，未启用验证流 |
| 找回密码 | 未接入邮件服务 |
| 生产 Secure cookie | 需在部署配置里打开 |

## 后续

- [ ] 邀请码校验（注册时校验 invite token，写 `invites` 表）
- [ ] 登录/注册接口限流
- [ ] 生产环境 `useSecureCookies: true` 与真实 `BETTER_AUTH_SECRET`
