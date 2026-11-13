"use client";
import { useActionState, useEffect, useState } from "react";
import { issueLinkCodeAction } from "./actions";
import { SubmitButton } from "../../../components/submit-button";

export function LinkCodeForm({ online, verified }: { online: boolean; verified: boolean }) {
  const [state, action] = useActionState(issueLinkCodeAction, {});
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(false);
  const [verifiedQq, setVerifiedQq] = useState<string | null>(null);
  useEffect(() => {
    setCopied(false); setExpired(false); setVerifiedQq(null);
    if (!state.code || verified) return;
    let active = true;
    const poll = async () => {
      if (Date.now() >= Date.parse(state.expiresAt ?? "")) { setExpired(true); return; }
      try {
        const response = await fetch("/api/connect/qq/status", { cache: "no-store" });
        if (!active || !response.ok) return;
        const result: unknown = await response.json();
        if (typeof result === "object" && result !== null && "verified" in result && result.verified === true &&
            "qqNumber" in result && typeof result.qqNumber === "string") setVerifiedQq(result.qqNumber);
      } catch { /* transient network errors are retried on the next interval */ }
    };
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => { active = false; clearInterval(timer); };
  }, [state.code, state.expiresAt, verified]);
  if (verified) return null;
  if (verifiedQq) return <p className="tag ok" role="status">已验证绑定，接收提醒的 QQ：{verifiedQq}</p>;
  return <div>
    <form action={action}><SubmitButton disabled={!online} pendingLabel="领取中…">{state.code ? "重新领取绑定码" : "领取绑定码"}</SubmitButton></form>
    {state.error && <p className="danger" role="alert">{state.error}</p>}
    {state.code && <div className="card" aria-live="polite">
      {expired ? <p className="warn">绑定码已过期，请重新领取。</p> : <>
        <p>复制这条消息，发送到机器人私聊：</p>
        <p><code style={{ overflowWrap: "anywhere" }}>绑定 {state.code}</code></p>
        <button type="button" className="secondary" onClick={async () => {
          try { await navigator.clipboard.writeText(`绑定 ${state.code}`); setCopied(true); }
          catch { setCopied(false); }
        }}>{copied ? "已复制" : "复制绑定消息"}</button>
        <p className="muted">10 分钟内有效，只能使用一次。请勿分享；重新领取会使旧码失效。发送后本页会自动更新。</p>
      </>}
    </div>}
  </div>;
}
