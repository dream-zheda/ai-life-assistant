#!/usr/bin/env node
// Generates only QQ configuration; never prints keys or modifies existing .env.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const [botId, napcatDir] = process.argv.slice(2);
if (!/^[1-9]\d{4,11}$/.test(botId ?? "") || !napcatDir) {
  throw new Error('Usage: node scripts/configure-qq.mjs <bot-QQ> <NapCat directory containing napcat.mjs>');
}
const configDir = path.resolve(napcatDir, "config");
if (!existsSync(path.join(napcatDir, "napcat.mjs")) || !existsSync(configDir)) throw new Error("NapCat directory not found");
const envPath = path.resolve(".env.qq.local");
const current = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
if (current.ONEBOT_SELF_ID && current.ONEBOT_SELF_ID !== botId) throw new Error("Existing QQ env belongs to a different robot; review manually before switching");
const token = current.ONEBOT_TOKEN || randomBytes(32).toString("hex");
const secret = current.ONEBOT_SECRET || randomBytes(32).toString("hex");
const target = path.join(configDir, `onebot11_${botId}.json`);
const baseConfig = path.join(configDir, "napcat.json");
const config = existsSync(target) ? JSON.parse(readFileSync(target, "utf8"))
  : existsSync(baseConfig) ? JSON.parse(readFileSync(baseConfig, "utf8")) : {};
config.network ??= {};
const upsert = (entries, value) => [...(entries ?? []).filter(item => item.name !== value.name), value];
// Installed NapCat signs HTTP-client reports with its token, NOT a field named secret.
config.network.httpServers = upsert(config.network.httpServers, {
  name: "life-assistant-api", enable: true, host: "127.0.0.1", port: 3000,
  token, messagePostFormat: "array", enableCors: false, enableWebsocket: false, debug: false,
});
config.network.httpClients = upsert(config.network.httpClients, {
  name: "life-assistant-events", enable: true, url: "http://127.0.0.1:8789/inbound/qq",
  token: secret, messagePostFormat: "array", reportSelfMessage: false, debug: false,
});
if (config.network.httpServers.some(item => item.name !== "life-assistant-api" && item.enable && item.port === 3000)) {
  throw new Error("Another enabled NapCat HTTP server uses port 3000; resolve manually");
}
const suffix = `.backup-${Date.now()}`;
if (existsSync(target)) copyFileSync(target, target + suffix);
if (existsSync(envPath)) copyFileSync(envPath, envPath + suffix);
writeFileSync(envPath, [
  "ONEBOT_ENDPOINT=http://127.0.0.1:3000", `ONEBOT_TOKEN=${token}`, `ONEBOT_SECRET=${secret}`,
  `ONEBOT_SELF_ID=${botId}`, "ONEBOT_AUTO_ACCEPT_FRIENDS=true", "WORKER_HTTP_PORT=8789", "WORKER_HTTP_HOST=127.0.0.1", "",
].join("\n"), { mode: 0o600 });
writeFileSync(target, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
console.log(`Configured robot ${botId}. Keys saved locally; existing files backed up. Restart NapCat to load its account configuration.`);
