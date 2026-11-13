#!/usr/bin/env node
/**
 * 迁移部署演练。
 *
 * 验证的是**生产路径**：`prisma migrate deploy` 对一个全新空库是否能干净地建好 schema，
 * 以及手写的数据库约束是否真的生效。
 *
 * 为什么单独有这个脚本：平时开发用的是 `migrate dev`（会生成迁移），
 * 而生产用的是 `migrate deploy`（只应用已有迁移）。两条路径不同，后者从没被测过。
 *
 * 用法：pnpm db:rehearse
 *
 * 会临时创建一个 `life_rehearsal` 库，跑完自动删除。
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_NAME = "life_rehearsal";
const SCHEMA = "packages/db/prisma/schema.prisma";
const DB_URL = `postgresql://life:life@127.0.0.1:55432/${DB_NAME}?schema=public`;

const results = [];
function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function runDevDb(args) {
  return execFileSync(process.execPath, [path.join(projectRoot, "scripts", "dev-db.mjs"), ...args], {
    cwd: projectRoot,
    env: { ...process.env, PGDATABASE: DB_NAME },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ---------------------------------------------------------------------------

try {
  console.log(`[rehearse] 目标库: ${DB_NAME}\n`);

  // 1) 全新空库执行迁移
  const deploy = runDevDb(["prisma", "migrate", "deploy", "--schema", SCHEMA]);
  const applied = (deploy.match(/Applying migration/g) ?? []).length;
  record("migrate deploy 在空库上应用全部迁移", applied >= 4, `应用了 ${applied} 个迁移`);

  // 2) 幂等：再跑一次不应该重复应用
  const deployAgain = runDevDb(["prisma", "migrate", "deploy", "--schema", SCHEMA]);
  record(
    "migrate deploy 可重复执行",
    deployAgain.includes("No pending migrations") || !deployAgain.includes("Applying migration"),
    "第二次无待应用迁移",
  );

  // 3) 迁移结果与 schema.prisma 是否零漂移
  //    ← 这条防的是"有人改了 schema 却没生成迁移"
  const diff = runDevDb([
    "prisma",
    "migrate",
    "diff",
    "--from-url",
    DB_URL,
    "--to-schema-datamodel",
    SCHEMA,
    "--script",
  ]);
  record(
    "库与 schema.prisma 零漂移",
    diff.includes("empty migration") || !/\b(CREATE|ALTER|DROP)\b/.test(diff),
    "migrate diff 无变更",
  );

  // 4) 状态
  const status = runDevDb(["prisma", "migrate", "status", "--schema", SCHEMA]);
  record("migrate status 报告已同步", status.includes("up to date"), "");

  // 5) 手写约束在全新库上真的生效
  //    注意：migrate diff 不会校验 CHECK / 部分唯一索引，必须单独断言
  const verify = runDevDb(["sql", "scripts/verify-constraints.sql"]);
  record(
    "手写约束在全新库上生效",
    verify.includes("ALL CONSTRAINT CHECKS PASSED"),
    "4 条断言",
  );
} catch (error) {
  record("演练过程无异常", false, error instanceof Error ? error.message.split("\n")[0] : String(error));
} finally {
  try {
    runDevDb(["drop"]);
    console.log(`\n[rehearse] 已删除 ${DB_NAME}`);
  } catch {
    console.error(`[rehearse] 删除 ${DB_NAME} 失败，请手动清理：PGDATABASE=${DB_NAME} pnpm db:drop`);
  }
}

const failed = results.filter((item) => !item.ok).length;
console.log("");
if (failed > 0) {
  console.error(`${failed} / ${results.length} 项失败`);
  process.exit(1);
}
console.log(`${results.length} / ${results.length} 项通过`);
