import {
  CHANNEL_POLICIES,
  createWechatBridgeAdapter,
  createOneBotAdapter,
  qqBotConfig,
  type ChannelAdapter,
} from "@life/channels";

import { createConsoleAdapter } from "./channels/console";
import { createInboundServer } from "./inbound-http";
import { claimJob, completeJob, failJob } from "./queue";
import { acceptQqFriendRequest } from "./qq-friends";
import {
  dispatchDueNotifications,
  enqueueMorningBriefs,
  enqueueStartReminders,
} from "./reminders";

/**
 * worker 入口。
 *
 * 用 `--once` 跑一个 tick，便于本地验证与 CI 冒烟；不带参数则常驻循环。
 *
 * 通道选择：
 * - 配了 `WECHAT_BRIDGE_URL` / `WECHAT_BRIDGE_TOKEN` / `WECHAT_BRIDGE_ACCOUNT_ID`
 *   → 走个人号桥接（ADR-009），能真正发到微信
 * - 否则 → 控制台通道，消息只打到日志
 *
 * ⚠️ 桥接通道违反微信平台规则，账号可能被封；这条路径必须配降级通道。
 */

const WORKER_ID = process.env.WORKER_ID ?? `worker-${process.pid}`;
const TICK_MS = Number(process.env.WORKER_TICK_MS ?? 15000);

async function createAdapter(): Promise<ChannelAdapter> {
  const qq = qqBotConfig();
  if (qq) {
    console.log(`[worker] 使用 QQ 通道 -> ${qq.endpoint} (account=${qq.selfId})`);
    return createOneBotAdapter({
      ...qq,
      channelInstanceId: qq.selfId,
    });
  }
  if (process.env.ONEBOT_ENDPOINT?.trim()) throw new Error("QQ 配置不完整：需要 endpoint/token/secret/selfId");

  const endpoint = process.env.WECHAT_BRIDGE_URL;
  const token = process.env.WECHAT_BRIDGE_TOKEN;
  const accountId = process.env.WECHAT_BRIDGE_ACCOUNT_ID;

  if (endpoint !== undefined && token !== undefined && accountId !== undefined) {
    console.log(`[worker] 使用微信桥接通道 -> ${endpoint} (account=${accountId})`);
    return createWechatBridgeAdapter({
      endpoint,
      token,
      accountId,
      channelInstanceId: process.env.WECHAT_BRIDGE_INSTANCE_ID ?? accountId,
      // 回调签名密钥缺失时 verifySignature 会一律拒绝，这是有意的失败安全
      inboundSecret: process.env.WECHAT_BRIDGE_SECRET ?? "",
      sendsPerMinute: Number(process.env.WECHAT_BRIDGE_MPM ?? 6),
    });
  }

  console.log("[worker] 未配置任何通道，使用控制台通道");
  return createConsoleAdapter({
    policy: CHANNEL_POLICIES["personal-wechat"],
    sink: (message) => {
      console.log(`[worker] send -> ${message.externalUserId}: ${message.text}`);
    },
  });
}

export async function runOnce(now: Date = new Date()): Promise<{
  job: string | null;
  remindersCreated: number;
  briefsCreated: number;
  dispatch: Awaited<ReturnType<typeof dispatchDueNotifications>>;
}> {
  const adapter = await createAdapter();

  let job: string | null = null;
  const claimed = await claimJob(WORKER_ID, { now });
  if (claimed !== null) {
    job = claimed.id;
    try {
      // 目前只有一种任务：扫描并生成提醒
      if (claimed.type === "enqueue-reminders") {
        await enqueueStartReminders(now);
      } else if (claimed.type === "qq-accept-friend") {
        await acceptQqFriendRequest(claimed.payload, now);
      } else {
        throw new Error("Unsupported job type");
      }
      await completeJob(claimed.id, now);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await failJob(claimed.id, message, { now });
      console.error(`[worker] job ${claimed.id} failed: ${message}`);
    }
  }

  const remindersCreated = await enqueueStartReminders(now);
  const briefsCreated = await enqueueMorningBriefs(now);
  const dispatch = await dispatchDueNotifications({ now, adapter });

  return { job, remindersCreated, briefsCreated, dispatch };
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  if (once) {
    const result = await runOnce();
    console.log(`[worker] once done: ${JSON.stringify(result)}`);
    return;
  }

  // 入站通道只在配置了密钥时开启；没配就完全不监听端口，减少暴露面
  const inboundPort = Number(process.env.WORKER_HTTP_PORT ?? 0);
  const wechatSecret = process.env.WECHAT_BRIDGE_SECRET;
  const qqSecret = process.env.ONEBOT_SECRET;
  const hasAnySecret =
    (wechatSecret !== undefined && wechatSecret.length > 0) ||
    (qqSecret !== undefined && qqSecret.length > 0);

  if (inboundPort > 0 && hasAnySecret) {
    const server = createInboundServer({
      port: inboundPort,
      wechatSecret,
      qqSecret,
    });
    server.listen(inboundPort, process.env.WORKER_HTTP_HOST ?? "127.0.0.1", () => {
      const paths = [
        wechatSecret !== undefined && wechatSecret.length > 0 ? "/inbound" : null,
        qqSecret !== undefined && qqSecret.length > 0 ? "/inbound/qq" : null,
      ].filter((path): path is string => path !== null);
      console.log(`[worker] 入站回调 http://127.0.0.1:${inboundPort}${paths.join(" ")}`);
    });
  } else if (inboundPort > 0) {
    console.warn("[worker] WORKER_HTTP_PORT 已设置但没有任何通道密钥，入站通道未启动");
  }

  console.log(`[worker] started as ${WORKER_ID}, tick=${TICK_MS}ms`);
  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  while (!stopping) {
    try {
      await runOnce();
    } catch (error) {
      // 单个 tick 出错不应让进程退出；记日志后继续
      console.error("[worker] tick failed:", error);
    }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }

  console.log("[worker] stopped");
}

const isEntrypoint = process.argv[1]?.includes("index.ts") === true;
if (isEntrypoint) {
  await main();
}
