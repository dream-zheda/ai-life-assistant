# QQ 机器人接入：一个账号服务多个用户

机器人由管理员维护。用户只需要网站账号和自己的 QQ，不安装 NapCat、不填写接口地址或密钥。管理员只登录专用机器人账号，不收集用户 QQ 密码。

## 用户流程

1. 登录网站，打开 `/connect/qq`，按页面 QQ 号添加机器人好友。
2. `ONEBOT_AUTO_ACCEPT_FRIENDS=true` 时，经过签名和机器人身份验证的好友申请进入 PostgreSQL 任务队列，后台自动通过；默认每 15 秒处理一次。关闭开关后由管理员手动通过。
3. 领取 10 分钟有效的一次性绑定码，私聊发送 `绑定 <16位绑定码>`。页面每 5 秒刷新，成功显示“已验证绑定”。
4. 网站生成并采纳计划，到点通过机器人私聊提醒。回复 `1` 或 `完成 2` 的既有反馈规则继续适用。
5. 更换 QQ 必须先在网页解绑。解绑撤销待使用绑定码，并移除后续提醒路由；已交给外部接口的消息不能撤回。

加好友不等于验证绑定。数据库只保存绑定码 SHA-256 哈希，原文只在领取响应中出现，不放 URL、日志、入站事件或对话记录。一位用户只有一个当前绑定码，一 QQ 不能关联两个网页账号。旧的手填记录必须重新验证。机器人换号后原绑定不会继续被使用。

## 本机配置

现有 NapCat 位置在原开发目录的 `napcat/onekey/NapCat.52230.Shell/versions/9.9.33-52230/resources/app/napcat`。不需要搬运整个仓库，也不用重新安装 QQ。

在应用根目录运行（将路径替换为本机 NapCat 目录）：

```powershell
node scripts/configure-qq.mjs 3463802115 "<NapCat目录>"
```

脚本生成 `.env.qq.local` 和 NapCat 的 `config/onebot11_3463802115.json`，已有文件先备份。只改 QQ 配置，不改原 `.env`。密钥不输出到控制台。

| 项目 | 本机值 / 含义 |
| --- | --- |
| HTTP 服务器 | `127.0.0.1:3000`，token 对应 `ONEBOT_TOKEN` |
| HTTP 客户端（事件上报） | `http://127.0.0.1:8789/inbound/qq` |
| HTTP 客户端 token | 对应 `ONEBOT_SECRET`，本机 NapCat 用它生成 `x-signature: sha1=...` |
| 消息格式 | array |
| reportSelfMessage | false |
| ONEBOT_SELF_ID | `3463802115`，必须与实际登录账号一致 |
| ONEBOT_AUTO_ACCEPT_FRIENDS | `true` 自动同意，`false` 停止自动同意 |

**注意：本机 NapCat 的 HTTP 客户端没有单独的 `secret` 字段。不要照旧交接文档填写不存在的字段。** Web 和 worker 必须使用同一数据库和 QQ 环境配置。

首次启用先停止 web/worker，生成 Prisma 客户端并部署新增的 `qq_link_codes` 迁移，然后构建：

```powershell
node node_modules/prisma/build/index.js generate --schema packages/db/prisma/schema.prisma
# DATABASE_URL 必须已设置为目标应用数据库；此命令不清库
node node_modules/prisma/build/index.js migrate deploy --schema packages/db/prisma/schema.prisma
pnpm web:build
```

Node 20.12+ 可直接加载配置，分别启动 web 和 worker（`.env` 提供数据库及认证配置）：

```powershell
node --env-file=.env --env-file=.env.qq.local node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3100 apps/web
node --env-file=.env --env-file=.env.qq.local node_modules/tsx/dist/cli.mjs apps/worker/src/index.ts
```

`APP_BASE_URL` 必须与访问网站的地址、端口一致。网页展示机器人在线需要 `get_login_info` 身份匹配且 `get_status` 在线；它不能单独证明事件上报已经接通，必须用真实绑定验证。

## NapCat 登录

在 NapCat 目录使用已有启动器。Windows 如果请求管理员权限，由电脑使用者确认；扫码时必须选择专用机器人账号。不要把 QQ 密码、登录二维码或 WebUI token 发到聊天中。NapCat 账号登录与本应用账号登录是两回事。

本地自动化只接受好友申请，不接受群邀请，不主动向陌生人发欢迎消息。添加后请用户按网页说明发送绑定码。

## 验证与运维

- 测试使用本地模拟 OneBot API，不登录真实 QQ，不向外发送测试消息。
- 验证覆盖：签名、错机器人、群聊/临时会话拒绝、码过期/撤销/并发、跨用户隔离、旧绑定拒绝发送、解绑、好友事件去重、动作失败与在线检查。
- 真实验收：用户添加好友 → 自动通过 → 发绑定码 → 网页确认 → 采纳一条未来计划 → 手机收到提醒 → QQ 回复完成 → 网页同步。代码测试通过不能代替这条真实验收。
- 好友申请最多重试 3 次；请求任务 24 小时后不再执行。响应丢失后重试会先查询好友列表，避免重复同意已经成功的申请。失败可检查 `jobs` 表，勿直接把含申请 flag 的记录公开。
- 本轮运行一个 worker。现有提醒派发尚无跨多个 worker 的并发领取保护，不要横向启动多个 worker；后续需单独完善提醒幂等派发、unknown 状态恢复和过期提醒处理。
- NapCat HTTP 上报本身不提供应用消息的完整持久重放保证；worker 离线期间的好友请求可能需用户重新申请或管理员手动通过。网站绑定失败时重新领取码并重发。
- 首次运行先检查端口冲突。不要向公网暴露 NapCat API 或 WebUI。Docker Compose 已加入 QQ 变量与 worker 端口，但容器版未实测，容器访问宿主机 NapCat 需要另配可达地址。
- NapCat 属于非官方 QQ 客户端接入，可能受版本更新、登录风控或平台限制影响；站内提醒继续保留。
