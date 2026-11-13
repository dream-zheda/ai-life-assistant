# 运维手册（Runbook）

> 适用版本：P0–P3 骨架。**本手册中的 docker 步骤尚未在任何真实服务器上实测过**（开发机没有 Docker）。
> 首次部署时请严格按「第 1 节」的顺序执行，遇到偏差先停下来记录，不要跳步。

---

## 0. 部署前必须确认的三件事

| # | 事项 | 为什么 |
| --- | --- | --- |
| 1 | **微信通道能主动推送吗？** | 个人微信只有 24 小时窗口，超出后提醒发不出去（ADR-002）。这决定产品能不能兑现"每天早上提醒"的承诺 |
| 2 | `APP_BASE_URL` 是用户真正访问的地址 | Better Auth 的 cookie 域与它绑定，填错会导致"登录成功但立刻掉线" |
| 3 | 数据库备份是否真的能恢复 | 没演练过的备份等于没有备份 |

---

## 1. 首次部署

> **第一次部署请直接用 [deploy-checklist.md](./deploy-checklist.md)**：
> 它把本手册的步骤压成一条带「期望信号」的时间线，适合照着念。
> 动手前至少跑一次 `pnpm preflight .env`（会拦住占位符与过短的密钥）。

### 1.1 前置条件

- 一台常驻 Linux 服务器（2C2G 起），已装 Docker + Compose v2
- 一个指向该服务器的域名，HTTPS 由反向代理（Caddy / Nginx）终结
- 已填写 `.env`（从 `.env.production.example` 复制）

```bash
cp .env.production.example .env
# 必填三项，缺一不可（compose 里用 :? 强制校验）
#   POSTGRES_PASSWORD  —— 强随机密码
#   BETTER_AUTH_SECRET —— openssl rand -hex 32
#   APP_BASE_URL       —— https://your-domain.example
```

### 1.2 启动

```bash
# 1) 先只起数据库和迁移，确认 schema 能落到空库上
docker compose up -d db
docker compose run --rm migrate

# 2) 确认迁移结果（表数量应为 21 左右）
docker compose exec db psql -U life -d life_assistant -c '\dt'

# 3) 起应用
docker compose up -d web worker

# 4) 看健康状态
docker compose ps
docker compose logs -f web worker
```

### 1.3 首次验收（缺一不可）

| 步骤 | 期望结果 |
| --- | --- |
| 浏览器打开 `APP_BASE_URL/sign-up` 并注册 | 注册成功后跳到 `/onboarding` |
| 未登录直接访问 `/today` | 被重定向到 `/sign-in` |
| 在 `/onboarding` 填档案、目标、固定安排 | 保存后 `/today` 能看到 |
| 点「生成今天的计划」 | 配了 API Key 时生成具体安排；没配时显示"计划是空的"并提示未配置模型 |
| 在 `psql` 里 `select count(*) from jobs;` | worker 在跑时能看到任务被领取与完成 |
| 注册第二个账号 | 两个账号互相看不到对方的内容 |

> 第 2 条与第 6 条是安全底线。任何一条不通过都不要对外提供服务。

---

## 2. 日常操作

```bash
docker compose ps                    # 状态
docker compose logs -f --tail=100 web worker
docker compose restart worker        # 只重启 worker（改配置后常用）
docker compose down                  # 停止（数据卷保留）
docker compose down -v               # ⚠️ 连数据一起删，只在确认要清库时用
```

### 更新版本

```bash
git pull
docker compose build
docker compose run --rm migrate      # 先迁移
docker compose up -d web worker
```

**顺序不能反**：先迁移再上新代码，否则新代码会对着旧 schema 跑。

---

## 3. 数据库迁移

- 迁移文件在 `packages/db/prisma/migrations/`，随代码一起进版本库
- 生产只用 `prisma migrate deploy`（不生成、不交互）
- **不要**在生产跑 `migrate dev` 或 `db push`

```bash
docker compose run --rm migrate
```

### 3.1 已在本地演练过的部分

`pnpm db:rehearse` 会对一个**全新空库**跑一遍生产路径并断言结果，5 项全过：

| 检查 | 结果 |
| --- | --- |
| `migrate deploy` 在空库上应用全部迁移 | 6 个迁移全部应用 |
| `migrate deploy` 可重复执行 | 第二次「No pending migrations」 |
| 库与 `schema.prisma` 零漂移（`migrate diff`） | 无变更 |
| `migrate status` | up to date |
| 手写约束（CHECK / 部分唯一索引）在新库生效 | 4 条断言全过 |

**这条演练防的是**：有人改了 `schema.prisma` 却没生成迁移，导致生产库缺列。
`migrate diff` 能抓到这个；但如果没跑过，问题只会在线上暴露。

**注意**：`migrate diff` **不校验 CHECK 约束和部分唯一索引**（Prisma 无法表达），
所以第 5 项要单独用 `scripts/verify-constraints.sql` 断言。

### 迁移前必做

```bash
docker compose exec db pg_dump -U life -d life_assistant -Fc -f /tmp/pre-migrate.dump
docker compose cp db:/tmp/pre-migrate.dump ./backup/pre-migrate-$(date +%F-%H%M).dump
```

### 需要手写的约束

`migrations/*_constraints/migration.sql` 里有 Prisma schema 表达不了的约束
（部分唯一索引、CHECK）。新增迁移时不要把它们覆盖掉。

---

## 4. 备份与恢复

### 4.1 每日备份

```bash
mkdir -p backup
docker compose exec -T db pg_dump -U life -d life_assistant -Fc \
  > backup/life-$(date +%F).dump
# 建议再同步到对象存储，别只留在同一台机器上
```

建议加进 cron：`0 4 * * *`，保留 14 天。

### 4.2 恢复演练（每季度至少一次）

> ⚠️ **本机无法演练这一步。** 开发机用的 embedded-postgres 只打包了
> `postgres.exe` / `initdb.exe` / `pg_ctl.exe`，**没有 `pg_dump` / `pg_restore` / `psql`**。
> 所以下面的命令必须在有 Docker 或已装 PostgreSQL 客户端的机器上执行。
> 在真正演练成功之前，请把「我们有备份」当成一个未验证的假设。

```bash
# 在**另一台机器或另一个库名**上恢复，不要直接覆盖生产
docker compose exec -T db createdb -U life life_assistant_restore
docker compose exec -T db pg_restore -U life -d life_assistant_restore --clean --if-exists \
  < backup/life-2026-11-03.dump
docker compose exec db psql -U life -d life_assistant_restore -c 'select count(*) from users;'
```

**只有演练成功过，才算有备份。** 记录每次演练的日期与结果。

### 4.3 数据删除的时效

账号删除会级联删除该用户的计划、进度与提醒，但**备份里的副本会保留到备份过期**。
如果对用户承诺"删除即彻底"，需要说明这一点。

---

## 5. 密钥轮换

| 密钥 | 轮换影响 | 步骤 |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | **所有用户会被登出** | 改 `.env` → `docker compose up -d web` |
| `DEEPSEEK_API_KEY` | 无（下次调用生效） | 改 `.env` → `up -d web worker` |
| `POSTGRES_PASSWORD` | 需同时改库与连接串 | 见下 |

改数据库密码的顺序（避免把自己锁在外面）：

```bash
docker compose exec db psql -U life -d life_assistant -c "ALTER USER life WITH PASSWORD '新密码';"
# 立刻更新 .env 里的 POSTGRES_PASSWORD，然后
docker compose up -d web worker
```

---

## 6. 故障处理

### 6.1 web 打不开

```bash
docker compose ps                # 看 web 是否 healthy
docker compose logs --tail=200 web
```

| 现象 | 常见原因 |
| --- | --- |
| 容器反复重启 | `APP_BASE_URL` / `BETTER_AUTH_SECRET` 未设置（compose 会直接拒绝启动） |
| 打开就 500 | `DATABASE_URL` 连不上，或迁移没跑 |
| 登录成功但立刻掉线 | `APP_BASE_URL` 与真实访问地址不一致，cookie 域对不上 |
| 静态资源 404 | 反向代理没转发全部路径 |

### 6.2 worker 不派发提醒

按这个顺序查，**不要直接从"没收到提醒"跳到"通道坏了"**：

```sql
-- 1) 有没有待执行的提醒？
select state, count(*) from notifications group by state;

-- 2) 有没有被标为需要降级？（这就是通道窗口问题）
select code, count(*) from notification_attempts where outcome='fallback' group by code;

-- 3) 任务队列是否卡住？
select state, count(*), min("runAt") from jobs group by state;

-- 4) 用户最后一次发消息是什么时候？（决定还能不能主动推）
select "userId", "channel", "lastInboundAt" from channel_bindings;
```

| 查询结果 | 判断 |
| --- | --- |
| 大量 `FALLBACK_REQUIRED` 且 code=`window_expired` | 通道窗口问题，不是 worker 问题。见 ADR-002 |
| `jobs` 里有大量 `RUNNING` 且 `lockedUntil` 已过期 | worker 崩过，重启后会自愈（租约机制） |
| `jobs` 里大量 `FAILED` | 看 `lastError` 字段 |
| 什么都没有 | 检查是否根本没有 ACTIVE 计划 |

### 6.3 时区看起来差了 8 小时

时间相关的原生 SQL 必须写 `AT TIME ZONE 'UTC'`。漏写会让时间偏 8 小时且**不报错**。
见 ADR-005，以及 `apps/worker/src/queue.ts` 里的注释。

### 6.4 磁盘满

```bash
docker system df
docker image prune -a -f          # 清理无用镜像
docker compose exec db psql -U life -d life_assistant -c "vacuum full;"
```

日志与备份不要放在容器内。

---

## 7. 需要盯的三个指标

| 指标 | 为什么 | 怎么看 |
| --- | --- | --- |
| 提醒成功率 = `SENT` / 应发送 | 唯一能证明产品在履约的指标 | `notifications` 按 state 分组 |
| 任务积压 = 最老 `PENDING` 的年龄 | worker 静默死亡时网页仍然 200 | `jobs` 的 `min(runAt)` |
| 模型失败率 | 规划生成是异步的，失败必须可见 | `notification_attempts` / 应用日志 |

**告警不要走自己的微信通道**——通道挂了就收不到告警。用邮件或第三方。

---

## 8. 本手册尚未验证的部分

| 项 | 状态 |
| --- | --- |
| `docker compose up` 全流程 | **未实测**（开发机没有 Docker） |
| `Dockerfile` 能否构建成功 | **未实测** |
| `prisma migrate deploy` 对空库 | ✅ **已演练**（`pnpm db:rehearse`，5 项断言） |
| 迁移与 schema 的零漂移 | ✅ 已演练（`migrate diff`） |
| 手写数据库约束在新库生效 | ✅ 已演练（4 条断言） |
| 反向代理 + HTTPS 配置 | 未涉及（依赖具体反代） |
| 微信通道真实收发 | **未实测**（无资质与账号，见 ADR-002） |
| 真实模型生成的规划质量 | **未验证**（无 API Key，目前是 mock） |
| 备份恢复演练 | ❌ **无法在本机执行**（缺 `pg_dump`），需在有客户端的机器上做 |

首次部署时请把实际结果补回本表，不要让它停留在"未实测"。
