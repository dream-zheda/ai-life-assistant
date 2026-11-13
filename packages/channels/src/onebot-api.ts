import type { OneBotFetchLike } from "./onebot.js";

export type QqBotConfig = { endpoint: string; token: string; secret: string; selfId: string };
export function qqBotConfig(env: Record<string, string | undefined> = process.env): QqBotConfig | null {
  const endpoint = env.ONEBOT_ENDPOINT?.trim(), token = env.ONEBOT_TOKEN?.trim();
  const secret = env.ONEBOT_SECRET?.trim(), selfId = env.ONEBOT_SELF_ID?.trim();
  if (!endpoint || !token || !secret || !selfId || !/^[1-9]\d{4,11}$/.test(selfId)) return null;
  return { endpoint, token, secret, selfId };
}

/** Strict OneBot envelope validation: HTTP 200 alone does not prove an action succeeded. */
export async function oneBotCall(
  config: Pick<QqBotConfig, "endpoint" | "token">,
  action: string,
  params: Record<string, unknown> = {},
  fetchImpl: OneBotFetchLike = fetch,
): Promise<unknown> {
  const response = await fetchImpl(`${config.endpoint.replace(/\/+$/, "")}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
    body: JSON.stringify(params), signal: AbortSignal.timeout(8000),
  });
  if (response.status < 200 || response.status >= 300) throw new Error(`ONEBOT_HTTP_${response.status}`);
  const body: unknown = JSON.parse(await response.text());
  if (!body || typeof body !== "object" || !("retcode" in body) || body.retcode !== 0 ||
      !("status" in body) || body.status !== "ok") throw new Error("ONEBOT_ACTION_FAILED");
  return "data" in body ? body.data : null;
}

export async function checkQqBot(config: QqBotConfig, fetchImpl?: OneBotFetchLike): Promise<{ nickname: string }> {
  const login = await oneBotCall(config, "get_login_info", {}, fetchImpl) as { user_id?: unknown; nickname?: unknown } | null;
  if (!login || String(login.user_id) !== config.selfId) throw new Error("ONEBOT_ACCOUNT_MISMATCH");
  const status = await oneBotCall(config, "get_status", {}, fetchImpl) as { online?: unknown; good?: unknown } | null;
  if (status?.online !== true || status.good === false) throw new Error("ONEBOT_OFFLINE");
  return { nickname: typeof login.nickname === "string" ? login.nickname : "提醒助手" };
}
