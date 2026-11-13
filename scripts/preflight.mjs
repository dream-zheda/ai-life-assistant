#!/usr/bin/env node
/**
 * 部署前体检。
 *
 * 检查的是"人和配置"这一层：环境变量有没有填、填的是不是占位符、密钥够不够长。
 * 这些错误在 `docker compose up` 时有的会直接崩、有的会**静默生效**——
 * 比如 BETTER_AUTH_SECRET 用了示例值，服务能起来，但所有人的会话都能被伪造。
 *
 * 用法：
 *   node scripts/preflight.mjs .env.production.example   # 对模板跑，应当报错
 *   node scripts/preflight.mjs .env                      # 对本机配置跑
 *   node scripts/preflight.mjs .env --quiet              # 只输出问题
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = process.argv[2] ?? ".env";
const quiet = process.argv.includes("--quiet");

const results = [];
function check(level, name, message) {
  results.push({ level, name, message });
  if (quiet && level === "ok") return;
  const mark = level === "ok" ? "OK   " : level === "warn" ? "WARN " : "ERROR";
  console.log(`${mark} ${name}${message ? ` — ${message}` : ""}`);
}

const PLACEHOLDER = /(请替换|replace-me|change-me|your-|example\.com|xxx)/i;
const DEV_SECRET = /(dev-only|insecure|local-secret)/i;

function parseEnv(text) {
  const map = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1. 配置文件本身
// ---------------------------------------------------------------------------

const absoluteEnvPath = path.isAbsolute(envPath) ? envPath : path.join(projectRoot, envPath);
let env = new Map();

if (!existsSync(absoluteEnvPath)) {
  check("error", "环境文件存在", `找不到 ${envPath}`);
} else {
  env = parseEnv(readFileSync(absoluteEnvPath, "utf8"));
  check("ok", "环境文件存在", `${envPath}（${env.size} 个变量）`);
}

const get = (key) => (env.get(key) ?? process.env[key] ?? "").trim();

// ---------------------------------------------------------------------------
// 2. 必填项
// ---------------------------------------------------------------------------

const password = get("POSTGRES_PASSWORD");
if (password.length === 0) check("error", "POSTGRES_PASSWORD", "未设置");
else if (PLACEHOLDER.test(password)) check("error", "POSTGRES_PASSWORD", "仍是占位符");
else if (password.length < 12) check("warn", "POSTGRES_PASSWORD", "短于 12 位，建议加长");
else check("ok", "POSTGRES_PASSWORD", "已设置");

const secret = get("BETTER_AUTH_SECRET");
if (secret.length === 0) check("error", "BETTER_AUTH_SECRET", "未设置");
else if (PLACEHOLDER.test(secret) || DEV_SECRET.test(secret))
  check("error", "BETTER_AUTH_SECRET", "仍是示例/开发用密钥");
else if (secret.length < 32) check("error", "BETTER_AUTH_SECRET", `只有 ${secret.length} 字符，建议 openssl rand -hex 32`);
else check("ok", "BETTER_AUTH_SECRET", `${secret.length} 字符`);

const baseUrl = get("APP_BASE_URL");
const PLACEHOLDER_HOST = /(your-domain|yourdomain|example\.(com|org|net)|\.example\b)/i;
if (baseUrl.length === 0) {
  check("error", "APP_BASE_URL", "未设置");
} else if (!/^https?:\/\//.test(baseUrl)) {
  check("error", "APP_BASE_URL", "必须是完整 URL（含协议）");
} else if (PLACEHOLDER_HOST.test(baseUrl)) {
  check("error", "APP_BASE_URL", "仍是示例域名");
} else if (baseUrl.startsWith("http://") && !/localhost|127\.0\.0\.1/.test(baseUrl)) {
  check("error", "APP_BASE_URL", "公网地址必须是 https，否则 cookie 会被中间人截获");
} else if (baseUrl.startsWith("http://")) {
  check("warn", "APP_BASE_URL", "本地 http 仅适合开发");
} else {
  check("ok", "APP_BASE_URL", baseUrl);
}

// ---------------------------------------------------------------------------
// 3. 会影响行为但不阻断启动的项
// ---------------------------------------------------------------------------

if (get("DEEPSEEK_API_KEY").length === 0) {
  check("warn", "DEEPSEEK_API_KEY", "未设置：网页端会走离线 mock，只生成空计划");
} else {
  check("ok", "DEEPSEEK_API_KEY", "已设置");
}

const tz = get("TZ");
if (tz.length === 0) check("warn", "TZ", "未设置，容器默认 UTC；建议 Asia/Shanghai");
else check("ok", "TZ", tz);

// ---------------------------------------------------------------------------
// 4. 仓库里该有的东西
// ---------------------------------------------------------------------------

const migrationsDir = path.join(projectRoot, "packages/db/prisma/migrations");
if (!existsSync(migrationsDir)) {
  check("error", "迁移文件", "找不到 packages/db/prisma/migrations");
} else {
  const migrations = readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name));
  if (migrations.length === 0) check("error", "迁移文件", "目录里没有迁移");
  else check("ok", "迁移文件", `${migrations.length} 个`);
}

const composePath = path.join(projectRoot, "compose.yaml");
if (!existsSync(composePath)) check("error", "compose.yaml", "找不到");
else {
  const compose = readFileSync(composePath, "utf8");
  const missing = ["db", "migrate", "web", "worker"].filter(
    (service) => !new RegExp(`^\\s{2}${service}:`, "m").test(compose),
  );
  if (missing.length > 0) check("error", "compose.yaml", `缺少服务：${missing.join(", ")}`);
  else check("ok", "compose.yaml", "4 个服务齐全");
}

// ---------------------------------------------------------------------------

const errors = results.filter((item) => item.level === "error").length;
const warnings = results.filter((item) => item.level === "warn").length;

console.log("");
if (errors > 0) {
  console.error(`${errors} 个错误，${warnings} 个警告 — 请修正后重跑`);
  process.exit(1);
}
console.log(`通过（${warnings} 个警告）`);
