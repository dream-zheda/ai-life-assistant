# 第一次部署 · 当天清单

> 把 `runbook.md` 里散在各节的步骤压成一条时间线，每一步都给「期望信号」和「不对时看哪」。
> 打勾式执行；**任何一步的信号不对，停下来，不要往下走。**

预计用时：1–2 小时（不含域名备案与微信资质，那两项以周计）。

---

## D-1：动手之前

| # | 事项 | 期望信号 |
| --- | --- | --- |
| 1 | 服务器能装 Docker（2C2G 起） | `docker --version` 有输出 |
| 2 | 域名已解析到服务器 IP | `nslookup your-domain` 指向正确 |
| 3 | **想清楚用哪家模型服务商** | 境内厂商 → 不涉及数据出境；境外 → 需评估（见 `compliance.md`） |
| 4 | 拿到模型 API Key（可选） | 没有也能部署，但网页端只会生成空计划 |

---

## T-0：部署

### 步骤 1 · 拉代码并写配置

```bash
git clone <repo> && cd ai-life-assistant
cp .env.production.example .env
# 编辑 .env：至少把这三项换成真实值
#   POSTGRES_PASSWORD   —— 强随机密码
#   BETTER_AUTH_SECRET  —— openssl rand -hex 32
#   APP_BASE_URL        —— https://your-domain
```

**期望信号**：体检脚本全 OK。

```bash
node scripts/preflight.mjs .env
```

> ⚠️ 这一步会**故意**拦住占位符。如果你看到 `仍是示例域名` 或 `仍是示例/开发用密钥`，
> 说明还没真的替换——不要跳过，`BETTER_AUTH_SECRET` 用示例值意味着会话可被伪造。

**不对时看哪**：`preflight.mjs` 的报错文案本身就是原因。

---

### 步骤 2 · 先只起数据库

```bash
docker compose up -d db
docker compose ps
```

**期望信号**：`db` 一列显示 `healthy`（不是 `starting`）。

**不对时看哪**：`docker compose logs db`。常见原因：`.env` 里 `POSTGRES_PASSWORD` 为空、磁盘满。

---

### 步骤 3 · 跑迁移（一次性容器）

```bash
docker compose run --rm migrate
```

**期望信号**：日志里出现 `Applying migration ...`（共 6 个，首次部署），最后容器退出码 0。

> 这条路径已在本地演练过（`pnpm db:rehearse`，5 项断言全过），包括「迁移与 schema 零漂移」
> 和「手写约束在全新库上生效」。

**不对时看哪**：`docker compose logs migrate`。若是连接失败，回步骤 2 确认 db 状态。

---

### 步骤 4 · 起应用

```bash
docker compose up -d web worker
docker compose ps
```

**期望信号**：`web` 在 20–40 秒内变成 `healthy`；`worker` 保持 `running`。

**不对时看哪**：
- `web` 反复重启 → 多半是 `APP_BASE_URL` / `BETTER_AUTH_SECRET` 没填（compose 会直接拒绝启动）
- `web` 起得来但打不开 → 反向代理没配，见步骤 5

---

### 步骤 5 · 反向代理与 HTTPS

在 Caddy / Nginx 里把域名反代到 `127.0.0.1:3100`。

**期望信号**：浏览器打开 `https://your-domain/sign-in`，证书有效，页面正常。

**不对时看哪**：反代日志。常见：`APP_BASE_URL` 与实际访问地址不一致（会导致"登录成功但立刻掉线"）。

---

## T+0：验收（缺一不可）

| # | 操作 | 期望信号 |
| --- | --- | --- |
| 1 | **立刻**用管理员邮箱注册 | 注册成功，并成为 ADMIN |
| 2 | 未登录直接访问 `/today` | 被跳到 `/sign-in` |
| 3 | 在 `/onboarding` 填档案、目标、固定安排 | 保存后 `/today` 能看到 |
| 4 | 点「生成今天的计划」 | 配了 Key → 有具体安排；没配 → 显示"计划是空的"并提示未配置模型 |
| 5 | 打开 `/settings` 改早报时间 | 保存后刷新仍是新值 |
| 6 | 打开 `/api/export` | 下载到一个 JSON 文件 |
| 7 | 注册第二个账号（管理员先发邀请码） | 两个账号互相看不到对方内容 |

> **第 1 步有时限。** 库里零用户时注册不需要邀请码（引导期，见 ADR-006）。
> 部署完到注册管理员之间，任何能打开 `/sign-up` 的人都能成为管理员。
> **这一步没做完，不要对外公布地址。**

**不对时看哪**：步骤 1 失败 → `docker compose logs web`；步骤 7 失败 → 检查 `invites` 表与 `/admin/invites`。

---

## T+1：第二天早上

| # | 检查 | 期望信号 |
| --- | --- | --- |
| 1 | 早报有没有发出来 | `notifications` 表里有 `kind='MORNING'` 且 `state='SENT'` |
| 2 | 有没有被抑制 | `notification_attempts` 里 `outcome='blocked'` 的原因码符合预期 |
| 3 | 有没有卡住的提醒 | `select state, count(*) from notifications group by state;` 不应有大量 `FALLBACK_REQUIRED` |

**如果是个人微信通道且大量 `FALLBACK_REQUIRED`，原因码多为 `window_expired`** ——
这不是 bug，是平台的 24 小时窗口限制（ADR-002）。要么改用能随时推送的通道，要么接受降级。

**不对时看哪**：`runbook.md` §6.2 的排查 SQL 顺序。

---

## 还没验证过的事（诚实清单）

| 项 | 状态 |
| --- | --- |
| `docker compose up` 全流程 | ❌ 未实测（开发机没 Docker） |
| `Dockerfile` 能否构建 | ❌ 未实测 |
| 备份 / 恢复 | ❌ 未演练（本机缺 `pg_dump`） |
| 迁移 + 约束 | ✅ 已本地演练 |
| 认证 / 邀请 / 导出 / 设置 | ✅ 已本地用真实 HTTP 验证 |

**第一次部署时请把上面 ❌ 的项实测结果补回 `runbook.md` 第 8 节。**
在那之前，这份清单只是"计划"，不是"验证过的流程"。
