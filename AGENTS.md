# AGENTS.md

> 给接手这个仓库的 agent 看的入口文件。**先读完本页再动代码。**

## 这是什么

「AI 个人生活助手」：用户录入个人情况与目标 → AI 生成可执行的生活规划 → 通过微信提醒并在微信里双向对话 → 根据反馈调整剩余计划。

多用户、邀请制、部署在常驻云服务器。**P1 已完整交付**（含邀请制），P3 骨架与部署编排也就绪。还缺：真实微信通道（现在是控制台通道）、一次真实的服务器部署、真实模型验证。

## 文档地图（按阅读顺序）

| 文档 | 作用 |
| --- | --- |
| `README.md` | **人类入口**：它是什么、怎么跑、怎么验证、还缺什么 |
| `docs/需求与方案记录.md` | v0.1，最早的需求拆解与 38 条盲区清单 |
| `docs/产品与技术规划书-v1.0.md` | **产品与架构的主契约**（16 章） |
| `docs/评审意见-v1.0.md` | 对 v1.0 的评审：通道资质问题、缺失章节、10 处可落地性缺陷 |
| `docs/P0-仓库核验记录.md` | 4 个候选开源项目的核验结果（**必读第 4 章**） |
| `docs/decisions/ADR-001-本地开发环境约束.md` | 为什么 pnpm 用 hoisted、为什么不能跑数据库迁移 |
| `docs/decisions/ADR-002-微信通道与推送窗口.md` | 通道选型与 24 小时窗口的一等公民设计 |
| `docs/decisions/ADR-003-重复约束与跨零点建模.md` | 为什么"每天睡觉"要展开成 7 条约束，以及跨零点的静默错误 |
| `docs/decisions/ADR-004-Better-Auth接入.md` | 认证接入方式、schema 对齐取舍、隔离验证证据 |
| `docs/decisions/ADR-005-时间列与原生SQL时区.md` | 为什么原生 SQL 必须写 `AT TIME ZONE 'UTC'`（会早 8 小时触发提醒） |
| `docs/decisions/ADR-006-邀请制与引导期.md` | 邀请码拦截点、一次性与引导期例外、限流开关 |
| `docs/decisions/ADR-007-回复语法.md` | 为什么早报不能写「回复 1/2/3」，以及入站解析的定位规则 |
| `docs/decisions/ADR-008-计划生效流程.md` | DRAFT→ACTIVE 为什么是必经步骤（否则永远收不到提醒） |
| `docs/decisions/ADR-009-个人号协议登录.md` | **用户自备微信号协议登录**：能随时推送，但违反微信规范，代价与收敛措施 |
| `docs/wechaty-bridge.md` | **桥接服务参考实现**（wechaty）：契约、代码、第一次跑通要确认的事。**未运行验证** |
| `docs/runbook.md` | **部署与运维手册**：首次部署、迁移、备份恢复、密钥轮换、故障排查 |
| `docs/deploy-checklist.md` | **第一次部署当天照着念的清单**：每步带期望信号与排查入口 |
| `docs/compliance.md` | **合规边界**：定位、PIPL、AI 服务、数据出境、实现对照表、上线前检查清单 |
| `docs/进度-2026-11-03.md` | 已完成 / 未完成 / 阻塞三态清单 |

## 当前阶段

**P0 已完成，P1 已完成，P3 骨架已完成，部署配置已完成（静态校验）**。还缺：真实微信通道、一次真实部署、真实模型验证。

P0 的结论改变了产品前提，务必先读 `ADR-002`：**个人微信通道只能在用户最后一条消息之后 24 小时内主动推送**，"每天早上 7:30 提醒"这个核心功能在个人微信上不成立。只有认证企业服务号 / 企业微信应用被明确写为可随时主动推送。

## 目录结构

```text
AI个人助手/
├─ apps/
│  ├─ web/         Next.js 控制台：/today、/onboarding、/sign-in、/api/auth
│  └─ worker/      任务队列（SKIP LOCKED）、提醒派发、控制台通道
├─ packages/
│  ├─ shared/      时区与时间计算、错误模型（无外部依赖）
│  ├─ domain/      规划规则、触发规则、状态机、模型输出契约（zod）
│  ├─ channels/    通道策略、主动推送窗口、适配器接口
│  ├─ llm/         多服务商适配（OpenAI 兼容 + Anthropic）、结构化输出校验与修复
│  ├─ planning/    规划编排：上下文组装、双层防护生成（格式校验 + 业务违规回灌）
│  └─ db/          Prisma schema、迁移、生成的 client（generated/ 不进版本库）
├─ scripts/        dev-db.mjs（本地库）、seed.sql、verify-constraints.sql
├─ docs/           产品、评审、核验、ADR、进度
├─ tsconfig.json   全仓统一，含 @life/* 路径映射
└─ vitest.config.ts 单元测试配置（集成测试见 vitest.integration.config.ts）
```

`apps/worker` 已有队列与提醒派发；但**通道仍是控制台通道，不是微信**。

## 命令

pnpm 不在 PATH 里，装在 workspace 根目录的 `.tools/pnpm/pnpm.cmd`：

```powershell
$pnpm = "<项目根目录>\.tools\pnpm\pnpm.cmd"   # 按你的环境替换

# 安装（必须带 --ignore-scripts，见 ADR-001）
& $pnpm install --ignore-scripts

& $pnpm typecheck   # 覆盖 packages + apps/web + apps/worker（三份 tsconfig）
& $pnpm test        # vitest
& $pnpm db:validate # prisma validate，不需要数据库
& $pnpm db:generate # 生成 packages/db/generated，类型检查前必须先跑一次

# 本地 PostgreSQL（embedded-postgres，见 ADR-001 附录）
# 首次需要：subst Y: "<项目根目录>"   —— 路径含中文，initdb 会崩，只能走 ASCII 盘符
& $pnpm db:up       # 起库并保持运行（端口 55432）
& $pnpm db:migrate  # 生成并应用迁移
& $pnpm db:reset    # 清库并重放全部迁移
& $pnpm db:verify   # 断言数据库级约束真的拦得住坏数据
& $pnpm db:seed     # 写入演示用户与演示数据
& $pnpm db:drop     # 删除当前 PGDATABASE 指定的库（默认 life_assistant，慎用）
& $pnpm db:rehearse # 迁移演练：全新空库跑 migrate deploy + 漂移检查 + 约束断言，跑完自动删库

& $pnpm test:int    # 集成测试：自动起库 → 真 Prisma → 跑完关库
& $pnpm web:build   # next build（含类型检查）
& $pnpm worker:once # worker 跑一个 tick（自动起库、打印派发结果）
& $pnpm config:check # 校验 compose.yaml / Dockerfile 的静态一致性（不需要 Docker）
& $pnpm preflight .env  # 部署前体检：占位符、密钥长度、示例域名、迁移与 compose 完整性

# 邀请制
& $pnpm invite:create 管理员@example.com 72   # 生成邀请链接（72 小时有效）
& $pnpm verify:invites                        # 需要 web 服务在跑；清空用户表后走一遍注册流程

# 端到端走查（需要先跑过一次 web:build）
& $pnpm e2e        # 注册 → 生成 → 采纳 → 提醒 → 派发 → 回复 → 页面，17 项断言
```

**部署产物**：`compose.yaml`（db → migrate → web/worker）、`Dockerfile`（多阶段）、
`.env.production.example`、`.dockerignore`、`docs/runbook.md`。
⚠️ **docker 构建与启动未实测**（本机没有 Docker），runbook 第 8 节列了未验证项。

**认证已接入 Better Auth**：`getCurrentUser()` 会校验会话，无会话直接 `redirect("/sign-in")`，
并检查 `status === "ACTIVE"`（停用账号即使有有效 session 也拒绝）。隔离性已用真实 HTTP 验证，见 ADR-004。

**微信桥接（可选，ADR-009）**：worker 读这些环境变量，缺一个就退回控制台通道：

```
WECHAT_BRIDGE_URL=http://127.0.0.1:8788   # 桥接服务基址
WECHAT_BRIDGE_TOKEN=...                    # 我们调桥接用的凭据
WECHAT_BRIDGE_ACCOUNT_ID=...               # 该微信号在桥接侧的标识
WECHAT_BRIDGE_SECRET=...                   # 桥接回调我们的 HMAC 密钥
WECHAT_BRIDGE_INSTANCE_ID=...              # 可选，多账号时区分
WECHAT_BRIDGE_MPM=6                        # 可选，每分钟发送上限（默认 6）
WORKER_HTTP_PORT=8789                      # 设了才开入站 webhook，绑定 127.0.0.1
```

**注意：`pnpm test` 需要能启动子进程**（vitest 通过 esbuild 起服务进程）。
若沙箱禁止管道型子进程会报 `spawn EPERM`，此时需要放宽文件/进程策略。

## 硬规则（违反会导致返工）

1. **不写死时区。** 用户时区存 IANA 标识，所有本地时间计算走 `@life/shared/time.ts`。
2. **模型不许算日期。** 今天的日期、星期、可用时段由代码算好注入 prompt；模型只负责排列，不负责推算。
3. **模型输出必须过 zod 校验**，且校验后还要过业务规则（`validateProposedPlan`）。格式合法 ≠ 业务合法。
4. **系统字段不信任模型输出。** `userId` / `planVersion` / 权限一律由服务端上下文决定。
5. **通道只记「已接受」，不记「已送达」。** 没有送达证据就不要在界面上说"已发送"。
6. **待处理任务由我们自己的 worker + 数据库持有**，不依赖通道项目自己的定时器。
7. **窗口关闭时不许假装发得出去。** 走 `decideProactiveDelivery` 的 `fallback` 分支。
8. **不 fork 候选项目做业务底座。** 通道能力放在 `ChannelAdapter` 后面，业务数据只存我们自己的库。
9. **原生 SQL 里比较或写入时间列，必须 `(${iso}::timestamptz AT TIME ZONE 'UTC')`。** Prisma 把
   `DateTime` 存成无时区的 `timestamp`（UTC），而 `$queryRaw` 的参数是 `timestamptz`，
   不显式对齐会出现 **8 小时偏移**——提醒会提前 8 小时触发且不报错。见 ADR-005。
10. **并发领取任务只能用 `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`。**
   标量子查询形式在并发下不稳。见 ADR-005。
11. **改文件用 write/edit 工具，不要用 PowerShell 的 `Set-Content`。** 本机是 Windows PowerShell 5.1，
    默认编码不是 UTF-8，改完中文源码会变成乱码且 `read` 直接报 invalid UTF-8。
    另外 `[System.IO.File]` 用的是**进程**工作目录，不是 `Set-Location` 后的位置——两者容易混淆。
12. **新建目录后要同步加进 typecheck 的 include。** 这个盲区已经出现过三次：
    `apps/`（根命令不覆盖）、`apps/web/tests/`（web tsconfig 不含 tests）、`scripts/`（根 include 没有）。
    每次都是"检查通过"但其实没检查。新增目录时先问：`pnpm typecheck` 真的会看它吗？

## 现在能跑的验证

```text
单元测试：147 个，14 个文件（pnpm test）
集成测试：91 个，12 个文件，真 PostgreSQL（pnpm test:int）
构建：next build 通过，/today 与 /onboarding 为动态路由
worker：pnpm worker:once 能在真库上跑完一个 tick（含早报生成）
部署配置：pnpm config:check 13/13 项静态检查通过（Docker 未实测）

单元覆盖面：
- 固定约束冲突（含跨零点、只在指定星期生效）
- 时间重叠、过期时段、跨出当天、越权目标、任务归属不符
- 生效前剔除过期条目（prepareActivation）
- 完成度反馈与状态流转（done 不可回退、无反馈记为 unknown）
- 调整触发规则（暂停提醒优先、确认/自动模式差异、阈值去重）
- 通道推送窗口（24 小时边界、订阅号窗口为 0、服务号不受限）
- 模型输出提取（代码围栏、前置文字、字符串内花括号）
- 结构化输出修复重试（非法 JSON、字段类型错、超次数报错）
- 双协议适配器请求构造与错误可重试性（429 vs 400）
- 规划编排：业务违规回灌后重生成、始终违规时返回原因而不抛异常
- 容量计算：相邻区间合并、跨零点只计当天段（ADR-003）
- 重复约束展开：每天→7 条、工作日→5 条、周末→2 条、指定星期→1 条
- 跨零点溢出：前一天的 23:00–07:00 会占到今天凌晨（只展开 7 条不够，见 ADR-003 修正）
- 消息渲染：长度上限 480、超长优先砍条目而非截断半句、按码点截断（emoji 安全）
- 回复解析：裸数字 1/2/3、带序号命令「完成 2」、全角数字、句末标点、帮助指令
- 提醒抑制：暂停优先于一切、跨零点免打扰（23:00–07:00）、每日上限、起止相同视为未设置
- 条目上限：一天最多 N 项（随可用时间在 6–24 之间夹逼），超限判 `TOO_MANY_ITEMS`
- 个人号桥接适配器：HMAC 签名、错误分类（429/5xx 可重试、401/403 不可重试）、
  网络异常记 `unknown`、本地令牌桶限速、入站解析容错
- wechaty 客户端：三种状态解析（offline / scan / logged_in）、字段缺失与未知状态返回 null、
  桥接不可达不抛异常、logout 成功/失败

集成覆盖面（web）：
- 计划与固定安排冲突时**不写入任何版本**
- 合法计划写入 DRAFT 版本与条目，时间按绝对时刻（UTC）保存
- 重复生成产生新版本而不是覆盖旧版本
- 两个真实用户的计划互不可见
- 「每天 23:00–07:00 睡觉」展开成 7 行后，当天占用 = 480 分钟（对照组单条 = 60）

集成覆盖面（worker）：
- 并发领取：3 个任务被 4 个 worker 抢，恰好 3 次成功、无重复
- 租约过期后可被重新领取，attempts 累加
- 失败退避重试，达上限转 FAILED
- 提醒去重（重复扫描不重复生成）
- 24 小时窗口内发送、窗口外标 FALLBACK_REQUIRED 且不发送
- 计划被替代后旧提醒作废
- 未绑定通道时标 FALLBACK_REQUIRED
- 早报：按用户设置的本地时间（默认 07:00，窗口 30 分钟）生成、内容含当天安排与回法；
  不在窗口内不生成；同一计划版本只发一次；计划非 ACTIVE 不生成
- 入站回复：「1」定位到最近 2 小时内提醒过的那一项；「完成 2」按当天顺序；
  已完成不重复记；无目标时给可操作提示而非静默；无近期提醒时不猜；
  跨用户隔离（B 的回复不影响 A）
- 提醒抑制：暂停 / 免打扰 / 每日上限都记录成 `blocked` + 原因码，不是静默丢弃
- 设置页：表单校验（HH:mm、范围、免打扰必须成对）、默认值、保存后读回、重复保存不插入第二行
- 数据导出：只含本人数据、不含他人数据、不含密码哈希与会话 token、时间字段可序列化
- 邀请码管理：状态判定（已用优先于过期）、列表不返回 tokenHash、撤销拒绝已用/已过期、不存在返回 not_found
- 约束组编辑：保留 groupId 与 createdAt、星期集合反推重复方式、非本人分组拒绝且不写入
- 计划采纳：DRAFT→ACTIVE、丢弃已结束条目、旧版本自动替代、拒绝空计划与已替代版本
- 入站 webhook：缺密钥 503、签名错 401、未知发送者 202 且不落库、重复 eventId 只处理一次、
  合法事件刷新 lastInboundAt、畸形内容 400
- 站内提醒：只返回本人、只返回当天（含本地 23:30 跨零点）、只有 SENT 才算「已推送」
- 模型凭据：AES-256-GCM 加解密往返、换密钥/篡改后解密返回 null、库里与导出里都没有明文、
  摘要只给末四位、清除后读回 null、URL/模型名/Key 长度校验；**用户配置优先于环境变量**
- 导出/邀请码/约束编辑/采纳的真实 HTTP 验证见下方

认证（真实 HTTP 验证，见 ADR-004）：
- 未登录 GET /today → 307 /sign-in
- 注册 → 200 + session cookie
- 带会话访问 → 200，页面显示本人邮箱
- 两个账号各自只看到自己的内容

邀请制（真实 HTTP 验证，见 ADR-006）：
- 引导期首个用户可注册，且自动成为 ADMIN
- 引导期结束后无邀请码 → 400
- 有效邀请码 → 200；同一个码用第二次 → 400；过期 → 400
- 邀请码记录了使用者（usedById）

数据库级约束断言：pnpm db:verify（4 条，含一个被断言抓出来的 SQL NULL 逻辑 bug）

迁移演练（`pnpm db:rehearse`，5 项全过）：
- 全新空库上 `migrate deploy` 应用全部 6 个迁移
- 可重复执行（第二次 No pending migrations）
- `migrate diff` 显示库与 schema.prisma **零漂移**
- `migrate status` = up to date
- 手写 CHECK / 部分唯一索引在全新库上仍然生效

⚠️ 备份恢复**无法在本机演练**：embedded-postgres 不带 `pg_dump`/`pg_restore`/`psql`。
这条只能留到有 Docker 或已装客户端的机器上做，runbook §4.2 已标注。

部署体检（`pnpm preflight <env>`，三种输入都验过）：
- 对 `.env.production.example` → 3 个错误（占位密码 / 示例密钥 / 示例域名）
- 对合格的生产配置 → 全 OK、exit 0
- 对本地 `.env` → 报错（缺 POSTGRES_PASSWORD）+ 警告（http、无 API Key）

隐私说明（真实 HTTP 验证）：
- 匿名 GET /privacy → 200（公开可读），含"会发送给大模型服务商""没有端到端加密""备份保留 14 天"
- /sign-up 页含隐私说明链接
- 匿名 GET /settings → 307

数据导出（真实 HTTP 验证）：
- 匿名 GET /api/export → 401
- 登录后 → 200，`content-disposition: attachment; filename="life-assistant-export-<date>.json"`
- 内容含本人邮箱、含 schemaVersion、不含密码字段
- 设置页提供「下载我的数据」与「删除账号」入口

邀请码管理（真实 HTTP 验证）：
- 管理员 GET /admin/invites → 200，含「生成新邀请码」「已发出的邀请码」
- 普通用户 → 307 /today（不暴露"你无权访问"）
- 匿名 → 307 /sign-in

约束编辑（真实 HTTP 验证）：
- GET /constraints/<自己的分组> → 200，含表单与已回填的星期（周二）
- GET /constraints/<不存在的分组> → 404

计划采纳（真实 HTTP 验证，见 ADR-008）：
- /today 对 DRAFT 计划显示「这份计划还没有生效」「采纳这份计划」表单
- **提醒只对 ACTIVE 计划生成**——没有采纳就永远不会有推送

端到端走查（`pnpm e2e`，17 项全过）：
- HTTP 注册（持邀请码）→ 新用户不是管理员
- 生成计划（DRAFT）→ 页面显示「采纳这份计划」且未显示"已生效"
- 采纳（DRAFT→ACTIVE）→ worker 生成单项提醒 + 早报
- 派发 → 消息含安排标题与可执行回法（sent=2, fallback=0）
- 回复「1」→ 进度记录 → 页面显示「已完成」
```

## 下一步建议顺序

1. 真实微信通道：桥接适配器与扫码页都已就绪，但**没有连过真 wechaty**。
   按 `docs/wechaty-bridge.md` 起桥接进程 → 配置 5 个环境变量 → 扫一次码即可验证（ADR-009）。
2. 首次真实部署：按 `docs/runbook.md` 跑一遍，把实测结果补回第 8 节。
3. 降级通道：个人号随时可能被封，网页/邮件提醒是**前置条件**而不是可选功能
   （目前 `/today` 的站内提醒已经能兜住"看得到"）。
4. 合规遗留：显式同意留痕、输出内容安全过滤、举报入口（见 `docs/compliance.md`）。

## 未解决的外部依赖

| 事项 | 阻塞什么 |
| --- | --- |
| 企业主体资质（营业执照）+ 微信认证（约 300 元/年） | 认证服务号 / 企业微信，决定能否做到"随时主动提醒" |
| 一个真实的模型 API Key | **用户已可在 `/settings` 自行填写**；对 agent 而言仍缺一个用来验证生成质量 |
| 真实微信号 + 一次真实桥接登录 | 个人微信通道能否真正发出去 |
