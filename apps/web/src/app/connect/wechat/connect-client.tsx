"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type State =
  | { configured: false }
  | { configured: true; reachable: false }
  | {
      configured: true;
      reachable: true;
      status:
        | { state: "offline" }
        | { state: "scan"; qrcodeDataUrl: string; scanStatus?: number; lastError?: string }
        | { state: "logged_in"; accountId: string; displayName?: string }
        | { state: "error"; message: string; scanned?: boolean };
    };

type Binding = {
  externalUserId: string;
  displayName: string | null;
  sessionState: string;
  lastInboundAt: string | null;
} | null;

const POLL_MS = 2500;

export function ConnectClient({
  initial,
  initialBinding,
}: {
  initial: State;
  initialBinding: Binding;
}) {
  const [state, setState] = useState<State>(initial);
  const [binding, setBinding] = useState<Binding>(initialBinding);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  // 防止每次轮询都重复提交绑定
  const bindingInFlight = useRef(false);

  const refresh = useCallback(async () => {
    const response = await fetch("/api/connect/wechat/status", { cache: "no-store" });
    if (!response.ok) return;
    const data = (await response.json()) as { state: State; binding: Binding };
    setState(data.state);
    setBinding(data.binding);
    return data;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  // 扫码成功后自动绑定：扫码本身就是授权动作，不该再让用户点一次
  useEffect(() => {
    if (binding !== null) return;
    if (state.configured !== true || state.reachable !== true) return;
    if (state.status.state !== "logged_in") return;
    if (bindingInFlight.current) return;

    bindingInFlight.current = true;
    setBusy(true);
    void (async () => {
      const response = await fetch("/api/connect/wechat/bind", { method: "POST" });
      if (response.ok) {
        setNote("已绑定，接下来会往这个微信号发提醒。");
        await refresh();
      } else {
        const data = (await response.json()) as { error?: string };
        setNote(
          data.error === "already_bound_by_other"
            ? "这个微信号已经绑到别的账号上了。"
            : "绑定失败，请重新扫码。",
        );
      }
      setBusy(false);
      bindingInFlight.current = false;
    })();
  }, [binding, state, refresh]);

  const disconnect = async () => {
    setBusy(true);
    const response = await fetch("/api/connect/wechat/logout", { method: "POST" });
    const data = (await response.json()) as { bridgeLoggedOut?: boolean };
    setNote(
      data.bridgeLoggedOut === true
        ? "已解绑，并通知桥接服务退出登录。"
        : "已解绑。桥接服务未确认退出，请到桥接服务上确认一下。",
    );
    await refresh();
    setBusy(false);
  };

  const relogin = async () => {
    setBusy(true);
    const response = await fetch("/api/connect/wechat/relogin", { method: "POST" });
    setNote(
      response.ok
        ? "已让桥接服务重新开始登录，等一下会出现新二维码。"
        : "桥接服务没有响应，检查一下它是否还在运行。",
    );
    await refresh();
    setBusy(false);
  };

  if (!state.configured) {
    return (
      <div className="card">
        <strong>还没有配置桥接服务</strong>
        <p className="muted">
          扫码登录需要一个独立的 wechaty 桥接进程。配置下面两个环境变量并重启 web/worker 后，
          这里会出现二维码。
        </p>
        <pre style={{ overflowX: "auto", fontSize: 12 }}>
{`WECHAT_BRIDGE_URL=http://127.0.0.1:8788
WECHAT_BRIDGE_TOKEN=<随机串>`}
        </pre>
        <p className="muted">桥接服务怎么起，见 docs/wechaty-bridge.md。</p>
      </div>
    );
  }

  if (!state.reachable) {
    return (
      <div className="card">
        <strong>桥接服务连不上</strong>
        <p className="muted">
          已配置 {`WECHAT_BRIDGE_URL`}，但请求失败。确认桥接进程在跑、端口对、token 一致。
        </p>
      </div>
    );
  }

  return (
    <>
      {note !== null && <p className="warn">{note}</p>}

      {binding !== null ? (
        <div className="card">
          <div className="row">
            <strong>已绑定：{binding.displayName ?? binding.externalUserId}</strong>
            <span className="tag">{binding.sessionState}</span>
          </div>
          <p className="muted">
            提醒会发到这个微信号。最后一次收到消息：
            {binding.lastInboundAt === null
              ? "还没有（发一条消息即可激活）"
              : new Date(binding.lastInboundAt).toLocaleString("zh-CN")}
          </p>
          <button type="button" className="secondary" onClick={() => void disconnect()} disabled={busy}>
            解绑并退出登录
          </button>
        </div>
      ) : (
        <div className="card">
          {state.status.state === "scan" ? (
            <>
              {state.status.lastError !== undefined && (
                <p className="danger">
                  ⚠️ 上一次登录被微信拒绝：{state.status.lastError}
                  。你已经扫码确认过，失败发生在「换取登录态」这一步，通常是网页协议被禁用。
                </p>
              )}
              <strong>用要当提醒号的微信扫这个码</strong>
              <p className="muted">
                扫码后这个微信号就由 AI 使用。**注意：个人号协议登录违反微信规范，账号可能被封。**
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={state.status.qrcodeDataUrl}
                alt="微信登录二维码"
                width={220}
                height={220}
                style={{ background: "#fff", padding: 8, borderRadius: 8 }}
              />
              <p className="muted">二维码有效期很短，过期会自动刷新。</p>
            </>
          ) : state.status.state === "logged_in" ? (
            <>
              <strong>桥接服务已登录，正在绑定…</strong>
              <p className="muted">账号：{state.status.displayName ?? state.status.accountId}</p>
            </>
          ) : state.status.state === "error" ? (
            <>
              <strong>登录被微信拒绝了</strong>
              <p className="danger">
                桥接服务的错误：{state.status.message}
              </p>
              <p className="muted">
                {state.status.scanned === true
                  ? "你已经扫码并确认了，但微信在最后一步拒绝了网页登录——这通常是账号不支持网页协议，不是配置问题。"
                  : "换一台设备或换一个账号再试；如果是「不支持网页登录」，免费方案基本走不通。"}
              </p>
              <button type="button" className="secondary" onClick={() => void relogin()} disabled={busy}>
                重新开始登录
              </button>
            </>
          ) : (
            <>
              <strong>桥接服务离线</strong>
              <p className="muted">
                桥接进程可能在启动中，或者上一次登录已失效。等一会儿没有二维码就去看桥接服务日志。
              </p>
              <button type="button" className="secondary" onClick={() => void relogin()} disabled={busy}>
                重新开始登录
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
