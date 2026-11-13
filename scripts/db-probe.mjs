/**
 * 探针：验证 embedded-postgres 能否在当前机器上初始化和启动。
 * 成功后可以删掉这个脚本。
 */
import EmbeddedPostgres from "embedded-postgres";

const databaseDir = process.env.PGDATA_DIR ?? ".pgdata-probe";
const port = Number(process.env.PGPORT ?? 55432);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "life",
  password: "life",
  port,
  persistent: true,
  // 系统 locale 是 "Chinese (Simplified)_China.936"，initdb 找不到对应的全文检索配置，
  // 并且会用 GBK 编码写初始化脚本导致 UTF8 报错。强制 UTF8 + C locale 绕开。
  initdbFlags: ["--encoding=UTF8", "--locale=C", "--lc-collate=C", "--lc-ctype=C"],
});

try {
  console.log(`[probe] databaseDir=${databaseDir} port=${port}`);
  await pg.initialise();
  console.log("[probe] initialise OK");
  await pg.start();
  console.log("[probe] start OK");

  const client = pg.getPgClient();
  await client.connect();
  const result = await client.query("select version() as version, current_database() as db");
  console.log("[probe] server:", result.rows[0]?.version);
  await client.end();
} catch (error) {
  console.error("[probe] FAILED:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  try {
    await pg.stop();
  } catch {
    // 已经停了
  }
}
