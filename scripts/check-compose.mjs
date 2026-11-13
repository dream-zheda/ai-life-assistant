#!/usr/bin/env node
/**
 * compose.yaml / Dockerfile 静态校验。
 *
 * 本机没有 Docker，没法 `docker compose config`。这个脚本做的是能做的部分：
 * 解析 YAML、断言拓扑关系、交叉检查 compose 引用的 build target 在 Dockerfile 里确实存在。
 *
 * 它**不能**证明镜像能构建成功或服务能起来——那必须在有 Docker 的机器上实测。
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parse } from "yaml";

const compose = parse(readFileSync(new URL("../compose.yaml", import.meta.url), "utf8"));
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const dockerignore = readFileSync(new URL("../.dockerignore", import.meta.url), "utf8");

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? "" });
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

const services = compose?.services ?? {};

check("compose 有项目名", () => {
  assert.equal(typeof compose.name, "string");
  return compose.name;
});

check("服务集合为 db / migrate / web / worker", () => {
  assert.deepEqual(Object.keys(services).sort(), ["db", "migrate", "web", "worker"]);
  return Object.keys(services).join(", ");
});

check("db 有 pg_isready 健康检查", () => {
  const test = services.db?.healthcheck?.test;
  const joined = Array.isArray(test) ? test.join(" ") : String(test ?? "");
  assert.match(joined, /pg_isready/);
  return "healthcheck 存在";
});

check("db 使用命名卷持久化", () => {
  assert.ok(services.db?.volumes?.some((v) => String(v).includes("db-data")), "缺少 db-data 挂载");
  // 注意：`volumes:\n  db-data:` 解析出来是 null，必须判断键是否存在而不是真假
  assert.ok(Object.hasOwn(compose.volumes ?? {}, "db-data"), "顶层 volumes 未声明 db-data");
  return "db-data";
});

check("db 只绑定 127.0.0.1，不暴露公网", () => {
  const ports = services.db?.ports ?? [];
  assert.ok(ports.length > 0, "db 未声明 ports");
  for (const port of ports) {
    assert.match(String(port), /^127\.0\.0\.1:/, `端口 ${port} 未限制在本机`);
  }
  return ports.join(", ");
});

check("migrate 等 db 健康后执行，且跑完即退出", () => {
  assert.equal(services.migrate?.depends_on?.db?.condition, "service_healthy");
  assert.equal(String(services.migrate?.restart), "no");
  return "service_healthy / restart=no";
});

check("web 与 worker 都等 migrate 成功退出", () => {
  for (const name of ["web", "worker"]) {
    assert.equal(
      services[name]?.depends_on?.migrate?.condition,
      "service_completed_successfully",
      `${name} 的依赖条件不对`,
    );
  }
  return "service_completed_successfully";
});

check("web 暴露 3100 且只绑定本机", () => {
  const ports = services.web?.ports ?? [];
  assert.ok(
    ports.some((p) => String(p).includes("3100") && String(p).startsWith("127.0.0.1:")),
    "web 端口未绑定 127.0.0.1:3100",
  );
  return ports.join(", ");
});

check("必填环境变量使用 :? 强制校验", () => {
  const all = JSON.stringify(compose);
  for (const key of ["POSTGRES_PASSWORD", "APP_BASE_URL", "BETTER_AUTH_SECRET"]) {
    assert.ok(all.includes(`${key}:?`), `${key} 没有用 :? 强制要求`);
  }
  return "3 个必填项";
});

check("Dockerfile 定义了 compose 引用的所有 target", () => {
  const targets = Object.values(services)
    .map((svc) => svc?.build?.target)
    .filter(Boolean);
  assert.ok(targets.length > 0, "compose 没有引用任何 build target");
  for (const target of new Set(targets)) {
    assert.match(dockerfile, new RegExp(`AS ${target}\\b`, "i"), `Dockerfile 缺少 target: ${target}`);
  }
  return [...new Set(targets)].join(", ");
});

check("没有使用 :latest 镜像", () => {
  for (const [name, svc] of Object.entries(services)) {
    const image = svc?.image;
    if (image) assert.ok(!String(image).endsWith(":latest"), `${name} 使用了 :latest`);
  }
  return "ok";
});

check(".dockerignore 排除了 .env 与 node_modules", () => {
  assert.match(dockerignore, /^\.env$/m, ".dockerignore 未排除 .env");
  assert.match(dockerignore, /^node_modules$/m, ".dockerignore 未排除 node_modules");
  return "ok";
});

check("Dockerfile 不在镜像里跑独立的本机专用脚本", () => {
  // 只看真正的 RUN 指令，注释里提到不算
  assert.ok(
    !/^\s*RUN[^\n]*--ignore-scripts/m.test(dockerfile),
    "Dockerfile 不应继承本机的 --ignore-scripts 限制",
  );
  return "ok";
});

let failed = 0;
for (const result of results) {
  const mark = result.ok ? "OK  " : "FAIL";
  if (!result.ok) failed += 1;
  console.log(`${mark} ${result.name}${result.detail ? ` — ${result.detail}` : ""}`);
}

console.log("");
if (failed > 0) {
  console.error(`${failed} / ${results.length} 项检查失败`);
  console.error("注意：这些只是静态检查。镜像能否构建、服务能否起来，必须在有 Docker 的机器上实测。");
  process.exit(1);
}
console.log(`${results.length} / ${results.length} 项静态检查通过`);
console.log("提醒：静态通过 ≠ 能部署。请按 docs/runbook.md 的「首次部署」实测。");
