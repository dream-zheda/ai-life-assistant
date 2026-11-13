# wechaty 桥接服务

> ⚠️ **这份代码没有被运行验证过。** 开发机没有装 wechaty，也没有可用的微信号。
> 它描述的是桥接服务必须满足的契约；第一次真机上跑通之前，请把它当"参考实现"而不是"成品"。
>
> ⚠️ 个人号协议登录违反《微信个人账号使用规范》1.2.6，账号可能被永久封禁。见 [ADR-009](./decisions/ADR-009-个人号协议登录.md)。

## 它是什么

主应用（web + worker）不直接登录微信。中间隔一个**独立的桥接进程**：

```
主应用 worker ──POST /messages──▶ 桥接服务 ──wechaty──▶ 微信
主应用 worker ◀──POST /inbound─── 桥接服务
本应用网页 ───GET /status──────▶ 桥接服务（拿二维码）
```

为什么单独一个进程：

1. wechaty 的 puppet 很重、常崩，不该拖累主应用
2. 登录会话只应该存在一个地方
3. 被封号时只需要重启桥接，不影响业务数据

## 契约

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | 返回 `{state:"offline"}` / `{state:"scan", qrcodeDataUrl}` / `{state:"logged_in", accountId, displayName}` |
| POST | `/messages` | 入参 `{accountId, to, text, idempotencyKey}`，成功返回 `{id}` |
| POST | `/logout` | 退出登录并清空会话 |
| 出站 | `POST <我们的>/inbound` | 带 `x-bridge-signature: <hmac-sha256 hex>` |

除出站回调外，所有请求都要带 `authorization: Bearer <WECHAT_BRIDGE_TOKEN>`。

## 安装

```bash
mkdir wechaty-bridge && cd wechaty-bridge
npm init -y
npm i wechaty qrcode
# puppet 二选一：
#   wechaty-puppet-wechat   —— 免费（网页协议），最容易被封
#   wechaty-puppet-padlocal —— 付费，稳定性好一些
npm i wechaty-puppet-wechat
```

## 实现（`index.mjs`）

```js
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import QRCode from "qrcode";
import { WechatyBuilder } from "wechaty";

const PORT = Number(process.env.PORT ?? 8788);
const TOKEN = process.env.WECHAT_BRIDGE_TOKEN;
const SECRET = process.env.WECHAT_BRIDGE_SECRET;
const INBOUND_URL = process.env.INBOUND_URL; // 例：http://127.0.0.1:8789/inbound
const PUPPET = process.env.PUPPET ?? "wechaty-puppet-wechat";

if (!TOKEN || !SECRET || !INBOUND_URL) {
  console.error("缺少 WECHAT_BRIDGE_TOKEN / WECHAT_BRIDGE_SECRET / INBOUND_URL");
  process.exit(1);
}

/** 当前状态：offline | scan | logged_in */
let status = { state: "offline" };
let botUserId = null;

const bot = WechatyBuilder.build({ name: "life-assistant", puppet: PUPPET });

bot.on("scan", async (qrcode) => {
  // 桥接自己把二维码转成图片，前端就不用装二维码库
  const dataUrl = await QRCode.toDataURL(qrcode, { margin: 1, width: 240 });
  status = { state: "scan", qrcodeDataUrl: dataUrl };
  console.log("[bridge] 二维码已生成，请扫码");
});

bot.on("login", (user) => {
  botUserId = user.id;
  status = { state: "logged_in", accountId: user.id, displayName: user.name() };
  console.log(`[bridge] 已登录：${user.name()} (${user.id})`);
});

bot.on("logout", (user, reason) => {
  console.log(`[bridge] 登出：${user?.name?.() ?? "?"} 原因=${reason ?? "未知"}`);
  botUserId = null;
  status = { state: "offline" };
});

bot.on("message", async (message) => {
  try {
    if (message.self()) return;
    // 只处理私聊；群里不说话，避免打扰无关的人
    if (!(await message.room())) {
      const text = await message.text();
      const from = message.talker().id;
      if (!text || !from) return;

      const body = JSON.stringify({
        eventId: message.id,
        from,
        text,
        timestamp: Date.now(),
      });
      const signature = createHmac("sha256", SECRET).update(body).digest("hex");

      await fetch(INBOUND_URL, {
        method: "POST",
        headers: { "content-type": "application/json", "x-bridge-signature": signature },
        body,
      });
    }
  } catch (error) {
    console.error("[bridge] 处理消息失败", error);
  }
});

await bot.start();

// ---- HTTP 接口 ----------------------------------------------------------

function send(res, code, payload) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return send(res, 401, { error: "unauthorized" });
  }

  if (req.method === "GET" && req.url === "/status") {
    return send(res, 200, status);
  }

  if (req.method === "POST" && req.url === "/logout") {
    await bot.logout();
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
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] listening on http://127.0.0.1:${PORT}`);
});
```

## 主应用侧配置

```bash
WECHAT_BRIDGE_URL=http://127.0.0.1:8788
WECHAT_BRIDGE_TOKEN=<与桥接服务一致>
WECHAT_BRIDGE_SECRET=<与桥接服务一致>
WECHAT_BRIDGE_ACCOUNT_ID=<登录后拿到的 wxid>
WORKER_HTTP_PORT=8789
```

然后用反向代理把外部路径指到 worker 的 `/inbound`，并把 `INBOUND_URL` 配成桥接服务能访问到的地址。

## 第一次跑要确认的事

| 检查 | 期望 |
| --- | --- |
| 桥接启动 | 日志出现「二维码已生成」 |
| 打开 `/connect/wechat` | 页面出现二维码 |
| 手机扫码并确认 | 桥接日志「已登录」，页面自动变成「已绑定」 |
| 给自己发一条消息 | 桥接日志收到、`/inbound` 返回 200、页面进度变化 |
| `pnpm worker:once` | 日志出现 `[worker] send -> ...` |

**这几步里任何一步卡住，先看桥接服务的日志**——问题几乎总在那边，而不在主应用。

## 已知风险

- `wechaty-puppet-wechat` 用的是网页协议，微信早已不保证可用，登录失败或被踢下线都常见
- 账号被限制后 `login` 事件可能一直不触发，页面会停在「离线」
- 消息延迟与丢失都可能发生，**不能把"没收到提醒"当成"今天没安排"**（所以有站内信兜底）
