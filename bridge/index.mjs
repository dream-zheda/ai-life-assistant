/**
 * wechaty 桥接服务（真实实现）。
 *
 * 职责：
 * - 用 wechaty 登录一个微信账号，把二维码/登录状态暴露成 HTTP
 * - 把收到的私聊消息，用 HMAC 签名后回调给主应用的 /inbound
 *
 * 安全性：登录凭据只在 wechaty 本地；主应用拿不到任何密码。
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";

import QRCode from "qrcode";
import { WechatyBuilder } from "wechaty";

const PORT = Number(process.env.BRIDGE_PORT ?? 8788);
const TOKEN = process.env.WECHAT_BRIDGE_TOKEN ?? "";
const SECRET = process.env.WECHAT_BRIDGE_SECRET ?? "";
const INBOUND_URL = process.env.INBOUND_URL ?? "";
const PUPPET = process.env.PUPPET ?? "wechaty-puppet-wechat4u";

/** 当前状态：offline | scan | logged_in | error */
let status = { state: "offline" };
let botUserId = null;
/** 最近一次失败原因：扫码确认后仍登录失败时，必须让页面看到，而不是继续转圈。 */
let lastError = null;

const bot = WechatyBuilder.build({ name: "life-assistant", puppet: PUPPET });

bot.on("scan", async (qrcode, scanStatus) => {
  try {
    const dataUrl = await QRCode.toDataURL(qrcode, { margin: 1, width: 260 });
    // scanStatus: 0=Waiting 1=Timeout 2=Scanning 3=Confirmed 4=Cancel
    // lastError 要跟着新二维码一起带上：否则"登录失败 → 出新码"会把原因冲掉，
    // 用户只会看到页面又转出一张码，以为没反应。
    status = {
      state: "scan",
      qrcodeDataUrl: dataUrl,
      scanStatus: Number(scanStatus),
      ...(lastError === null ? {} : { lastError }),
    };
    console.log(`[bridge] 二维码已生成（status=${scanStatus}），请扫码`);
  } catch (error) {
    console.error("[bridge] 生成二维码图片失败", error);
  }
});

bot.on("login", (user) => {
  botUserId = user.id;
  lastError = null;
  status = { state: "logged_in", accountId: user.id, displayName: user.name() };
  console.log(`[bridge] 已登录：${user.name()} (${user.id})`);
});

bot.on("logout", (user, reason) => {
  console.log(`[bridge] 已登出：${user?.name?.() ?? "?"} 原因=${reason ?? "未知"}`);
  botUserId = null;
  status = { state: "offline" };
});

bot.on("error", (error) => {
  const message = error?.message ?? String(error);
  console.error("[bridge] 错误：", message);
  lastError = message;
  // 已经扫过码但登录失败，这才是用户最需要知道的事
  if (status.state === "scan") {
    status = { state: "error", message, scanned: status.scanStatus === 3 };
  }
});

bot.on("message", async (message) => {
  try {
    if (message.self()) return;
    if (await message.room()) return; // 只处理私聊

    const text = await message.text();
    const from = message.talker().id;
    if (!text || !from) return;

    const body = JSON.stringify({ eventId: message.id, from, text, timestamp: Date.now() });
    const signature = createHmac("sha256", SECRET).update(body).digest("hex");

    const response = await fetch(INBOUND_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bridge-signature": signature },
      body,
    });
    console.log(`[bridge] 转发入站消息 ${message.id} -> ${response.status}`);
  } catch (error) {
    console.error("[bridge] 转发入站消息失败", error);
  }
});

function send(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  if (TOKEN.length > 0 && req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && req.url === "/status") {
    return send(res, 200, status);
  }

  // 重新拉起 wechaty：换新二维码 / 从错误状态恢复
  if (req.method === "POST" && req.url === "/relogin") {
    lastError = null;
    status = { state: "offline" };
    await bot.stop().catch(() => {});
    botUserId = null;
    bot.start().catch((error) => console.error("[bridge] 重启失败", error));
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/logout") {
    await bot.logout().catch(() => {});
    status = { state: "offline" };
    botUserId = null;
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && req.url === "/messages") {
    if (botUserId === null) return send(res, 503, { error: "not_logged_in" });
    try {
      const { to, text } = await readJson(req);
      const contact = await bot.Contact.find({ id: to });
      if (!contact) return send(res, 404, { error: "contact_not_found" });
      await contact.say(text);
      return send(res, 200, { id: `${Date.now()}` });
    } catch (error) {
      console.error("[bridge] 发送失败", error);
      return send(res, 500, { error: "send_failed" });
    }
  }

  send(res, 404, { error: "not_found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] listening http://127.0.0.1:${PORT} (puppet=${PUPPET})`);
});

console.log("[bridge] 启动 wechaty…");
bot.start().then(
  () => console.log("[bridge] wechaty 已启动"),
  (error) => console.error("[bridge] wechaty 启动失败：", error?.message ?? error),
);

process.on("SIGINT", () => {
  console.log("[bridge] 收到退出信号");
  void bot.stop().finally(() => process.exit(0));
});
