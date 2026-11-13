# ADR-005：时间列的存储约定与原生 SQL 的时区陷阱

- 状态：已采纳
- 日期：2026-11-03
- 相关：`apps/worker/src/queue.ts`

## 背景

Prisma 的 `DateTime` 在 PostgreSQL 上默认映射为 **`timestamp(3)`（不带时区）**，写入时按 UTC 存。
这套约定在 Prisma ORM 内部是自洽的——`where: { startsAt: { lte: now } }` 会正确地绑定成
`timestamp`，不会有时区偏移。

但只要写**原生 SQL**（本项目里任务领取必须用 `FOR UPDATE SKIP LOCKED`，绕不开），
约定就断了：`$queryRaw` 里的 `Date` 参数会被绑定成 **`timestamptz`**，
PG 拿它和 `timestamp` 列比较时，会按**会话时区**（本机是 `Asia/Shanghai`，+08）换算。

## 症状

任务表里有一个 `runAt = now + 60 秒` 的任务，领取查询却立刻把它捞了出来。

原因：`runAt` 存的是 UTC 墙上时间（例如 `12:05`），而参数是绝对瞬间
（`20:05 +08`）。PG 把 `12:05` 当作**上海本地时间**去和 `20:05+08` 比较，
等价于认为 `runAt` 是 8 小时前——于是「还没到点」变成了「早就过期」。

放到生产上，这个 bug 会让**提醒提前 8 小时触发**，而且不会有任何报错。

## 决策

### 1. 原生 SQL 里所有外部时间参数显式对齐到 UTC 墙上时间

```sql
"runAt" <= (${nowIso}::timestamptz AT TIME ZONE 'UTC')
```

`::timestamptz` 把 ISO 字符串解析成绝对瞬间，`AT TIME ZONE 'UTC'` 再把它转成
UTC 墙上时间的 `timestamp`，与列里存的值同一基准。

### 2. 参数只放值，类型转换必须写在 SQL 文本里

第一次修复时把整段表达式拼进了参数：

```ts
// 错的：整段变成字符串字面量，SQL 里只剩一个 text 参数
const nowUtc = `${now.toISOString()}::timestamptz AT TIME ZONE 'UTC'`;
... "runAt" <= ${nowUtc}
// → ERROR: operator does not exist: timestamp without time zone <= text
```

正确写法是让 `${...}` 里只有值，`::timestamptz` 留在模板字符串的 SQL 部分。
同理，`UPDATE ... SET "lockedUntil" = (...)` 也要一并处理，否则写进去的值会偏 8 小时。

### 3. 领取语句用 `UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)`

不用 `WHERE id = (SELECT ...)` 的标量子查询形式。后者在并发下不够稳，
前者是 PostgreSQL 官方推荐的队列模式：锁在子查询里取得，外层按 id 更新。

## 后果

- 任务队列的时间语义正确：未到点的任务不会被领取，租约到期能被重领。
- 回归测试固定在 `apps/worker/tests/queue.int.test.ts`：
  「未到时间的任务不会被领取」这条用例就是为这个 bug 写的。
- **任何新增的原生 SQL，只要比较或写入时间列，都必须用同一套 cast**。
  这条已写进 AGENTS.md 的硬规则。

## 未采纳 / 待办

| 方案 | 状态 |
| --- | --- |
| 把时间列改为 `@db.Timestamptz(3)` | 未采纳（本轮）。更彻底，但要改 20+ 个字段并重做迁移；记作后续优化 |
| 全部改用 ORM 查询 | 不可行：`SKIP LOCKED` 无法用 Prisma 查询构造器表达 |
| 把会话时区设成 UTC | 治标不治本：其他环境的会话时区不可控，且会掩盖问题 |

- [ ] 评估把绝对时间列统一迁移到 `timestamptz`，届时可以移除这些 cast
