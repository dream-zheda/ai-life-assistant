"use client";

import { useRef, useState } from "react";

export function InviteLink({ url }: { url: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState("");

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("已复制完整邀请链接，可以直接发给受邀者。");
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage("请复制已选中的完整链接；手机上可长按复制。");
    }
  }

  return <div>
    <label htmlFor="invite-url">完整邀请链接</label>
    <input ref={input} id="invite-url" type="text" readOnly value={url} onFocus={event => event.currentTarget.select()} />
    <div className="row">
      <button type="button" onClick={copyLink}>复制邀请链接</button>
      <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开注册页面 ↗</a>
    </div>
    <p className="muted" role="status" aria-live="polite">{message}</p>
  </div>;
}
