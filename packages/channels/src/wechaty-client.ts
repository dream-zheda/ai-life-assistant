/**
 * wechaty 桥接服务的客户端。
 *
 * 桥接服务（见 docs/wechaty-bridge.md）是一个独立进程，负责：
 * - 用 wechaty 登录微信，产出二维码
 * - 把扫码状态、登录后的账号 id 暴露成 HTTP
 * - 收到消息时回调我们的 /inbound
 *
 * 这里只做「我们能看懂它的状态」，不碰协议细节。
 * 之所以单独一个客户端而不是塞进 adapter：状态查询与发消息是两条不同的关注点，
 * 而且页面轮询状态时不应该顺带把发送逻辑加载进来。
 */

export type WechatyStatus =
  | { state: "offline" }
  | { state: "scan"; qrcodeDataUrl: string; scanStatus?: number; lastError?: string }
  | { state: "logged_in"; accountId: string; displayName?: string }
  | { state: "error"; message: string; scanned?: boolean };

export type WechatyClientResponse = { status: number; text: () => Promise<string> };

export type WechatyFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<WechatyClientResponse>;

export type WechatyClientOptions = {
  endpoint: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: WechatyFetchLike;
};

export type WechatyBridgeClient = {
  /** 取当前登录状态；桥接不可达时返回 null（页面据此显示"未配置/离线"）。 */
  getStatus(): Promise<WechatyStatus | null>;
  /** 让桥接服务退出登录并清空会话。 */
  logout(): Promise<boolean>;
  /** 重新拉起登录流程（换新二维码 / 从错误中恢复）。 */
  relogin(): Promise<boolean>;
};

function defaultFetch(): WechatyFetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    return { status: response.status, text: () => response.text() };
  };
}

function normalize(raw: unknown): WechatyStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const payload = raw as Record<string, unknown>;
  const state = payload["state"];

  if (state === "offline") return { state: "offline" };

  if (state === "scan") {
    const qr = payload["qrcodeDataUrl"];
    if (typeof qr !== "string" || qr.length === 0) return null;
    const scanStatus = payload["scanStatus"];
    const lastError = payload["lastError"];
    return {
      state: "scan",
      qrcodeDataUrl: qr,
      ...(typeof scanStatus === "number" ? { scanStatus } : {}),
      ...(typeof lastError === "string" && lastError.length > 0 ? { lastError } : {}),
    };
  }

  if (state === "error") {
    const message = payload["message"];
    return {
      state: "error",
      message: typeof message === "string" && message.length > 0 ? message : "未知错误",
      ...(typeof payload["scanned"] === "boolean" ? { scanned: payload["scanned"] } : {}),
    };
  }

  if (state === "logged_in") {
    const accountId = payload["accountId"];
    if (typeof accountId !== "string" || accountId.length === 0) return null;
    const displayName = payload["displayName"];
    return {
      state: "logged_in",
      accountId,
      ...(typeof displayName === "string" ? { displayName } : {}),
    };
  }

  return null;
}

export function createWechatyBridgeClient(options: WechatyClientOptions): WechatyBridgeClient {
  const doFetch = options.fetchImpl ?? defaultFetch();
  const headers = {
    authorization: `Bearer ${options.token}`,
    accept: "application/json",
  };
  const to = (path: string): string => `${options.endpoint.replace(/\/+$/, "")}${path}`;

  return {
    async getStatus(): Promise<WechatyStatus | null> {
      try {
        const response = await doFetch(to("/status"), { method: "GET", headers });
        if (response.status !== 200) return null;
        return normalize(JSON.parse(await response.text()));
      } catch {
        return null;
      }
    },

    async logout(): Promise<boolean> {
      try {
        const response = await doFetch(to("/logout"), { method: "POST", headers });
        return response.status === 200 || response.status === 204;
      } catch {
        return false;
      }
    },

    async relogin(): Promise<boolean> {
      try {
        const response = await doFetch(to("/relogin"), { method: "POST", headers });
        return response.status === 200;
      } catch {
        return false;
      }
    },
  };
}

/** 从环境变量构造；缺少必要项时返回 null，调用方据此走"未配置"分支。 */
export function createWechatyClientFromEnv(
  env: Record<string, string | undefined> = process.env,
): WechatyBridgeClient | null {
  const endpoint = env["WECHAT_BRIDGE_URL"];
  const token = env["WECHAT_BRIDGE_TOKEN"];
  if (endpoint === undefined || token === undefined) return null;
  if (endpoint.length === 0 || token.length === 0) return null;
  return createWechatyBridgeClient({ endpoint, token });
}
