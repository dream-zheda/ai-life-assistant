#!/usr/bin/env node
/**
 * 本地开发数据库（embedded-postgres）。
 *
 * 背景：本机没有 Docker / PostgreSQL / WSL，但 P1 的验收（"两个账号互相隔离"）
 * 必须有真实数据库。这里用 embedded-postgres 起一个进程内托管的 PostgreSQL 18。
 *
 * 两个必须绕开的坑（详见 ADR-001 附录）：
 * 1. 项目路径含中文用户名。initdb 会把**工作目录**写进初始化 SQL，
 *    GBK 字节喂给 UTF-8 编码的模板库会报 `invalid byte sequence for encoding "UTF8"`。
 *    解法：用 `subst` 映射一个 ASCII 盘符，并在启动前 chdir 过去。
 * 2. 系统 locale 是 Chinese (Simplified)_China.936，initdb 找不到全文检索配置。
 *    解法：`--encoding=UTF8 --locale=C`。
 *
 * 用法：
 *   node scripts/dev-db.mjs start                      # 起库并保持运行，打印连接串
 *   node scripts/dev-db.mjs prisma migrate dev --name init
 *   node scripts/dev-db.mjs prisma migrate dev --create-only --name init
 *   node scripts/dev-db.mjs prisma generate
 *   node scripts/dev-db.mjs sql path/to/file.sql
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

const DRIVE = process.env.DSH_ASCII_DRIVE ?? "Y:";
const DATA_DIR = process.env.PGDATA_DIR ?? `${DRIVE}\\.pgdata`;
const PORT = Number(process.env.PGPORT ?? 55432);
const DB = process.env.PGDATABASE ?? "life_assistant";
const USER = "life";
const PASSWORD = "life";

// 调用者原本的目录。initdb 必须在 ASCII 目录下跑，但后续命令要回到这里：
// 否则 Vite 等工具会同时看到 Y:/ 和 C:/ 两套逻辑路径，解析出错。
const originalCwd = process.cwd();

if (!existsSync(`${DRIVE}\\`)) {
  console.error(
    `[db] 盘符 ${DRIVE} 不存在。请先执行：\n  subst ${DRIVE} "<项目根目录>"\n` +
      `然后用 DSH_ASCII_DRIVE 指定盘符。`,
  );
  process.exit(1);
}

mkdirSync(`${DRIVE}\\tmp`, { recursive: true });
process.chdir(`${DRIVE}\\`);
process.env.TMP = `${DRIVE}\\tmp`;
process.env.TEMP = `${DRIVE}\\tmp`;

const databaseUrl = `postgresql://${USER}:${PASSWORD}@127.0.0.1:${PORT}/${DB}?schema=public`;

const pg = new EmbeddedPostgres({
  databaseDir: DATA_DIR,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-collate=C", "--lc-ctype=C"],
  onLog: (message) => {
    if (process.env.DSH_DB_VERBOSE === "1") console.log(`[pg] ${message}`);
  },
  onError: (message) => console.error(`[pg] ${message}`),
});

const alreadyInitialised = existsSync(`${DATA_DIR}\\PG_VERSION`);
if (!alreadyInitialised) {
  console.log(`[db] initialising cluster at ${DATA_DIR}`);
  await pg.initialise();
}

await pg.start();
// 集群已经起来了，把工作目录还给调用者（见文件头 originalCwd 的说明）
process.chdir(originalCwd);
console.log(`[db] running at ${databaseUrl}`);

try {
  try {
    await pg.createDatabase(DB);
    console.log(`[db] created database ${DB}`);
  } catch {
    // 已存在，忽略
  }

  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === "start") {
    console.log("[db] 保持运行中，Ctrl+C 结束");
    await new Promise((resolve) => {
      process.on("SIGINT", resolve);
      process.on("SIGTERM", resolve);
    });
  } else if (args[0] === "sql") {
    const file = args[1];
    if (file === undefined) throw new Error("用法: sql <file.sql>");
    const client = pg.getPgClient(DB);
    await client.connect();
    // 把 RAISE NOTICE 打出来：断言脚本靠这些输出自证
    client.on("notice", (notice) => console.log(`[assert] ${notice.message}`));
    try {
      await client.query(readFileSync(file, "utf8"));
      console.log(`[db] executed ${file}`);
    } finally {
      await client.end();
    }
  } else if (args[0] === "drop") {
    await pg.dropDatabase(DB);
    console.log(`[db] dropped database ${DB}`);
  } else {
    const [command, ...rest] = args;
    const env = { ...process.env, DATABASE_URL: databaseUrl };
    const resolved = command === "prisma" ? [process.execPath, "node_modules/prisma/build/index.js", ...rest] : [command, ...rest];
    execFileSync(resolved[0], resolved.slice(1), { stdio: "inherit", cwd: process.cwd(), env });
  }
} finally {
  await pg.stop();
  console.log("[db] stopped");
}
