"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "../../lib/auth-client";

export function SignUpForm({
  inviteToken,
  bootstrap = false,
}: {
  inviteToken: string | null;
  bootstrap?: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.signUp.email(
        {
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
          name: String(form.get("name") ?? ""),
        },
        inviteToken === null ? undefined : { headers: { "x-invite-token": inviteToken } },
      );

      setBusy(false);
      if (result.error !== null && result.error !== undefined) {
        setError(result.error.message ?? "注册失败");
        return;
      }
      router.push("/setup/model");
      router.refresh();
    } catch {
      setError("暂时连接不上，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {bootstrap ? (
        <p className="notice">欢迎首次使用。你可以直接创建管理员账号，之后通过邀请添加其他用户。</p>
      ) : inviteToken === null ? (
        <p className="danger">
          没有检测到邀请码。这个产品是邀请制，请使用管理员给你的邀请链接打开本页。
        </p>
      ) : (
        <p className="muted">已带上邀请码（{inviteToken.slice(0, 8)}…）。</p>
      )}

      <form onSubmit={onSubmit} className="card">
        <label htmlFor="name">怎么称呼你</label>
        <input id="name" name="name" autoComplete="name" />

        <label htmlFor="email">邮箱</label>
        <input id="email" name="email" type="email" required autoComplete="email" />

        <label htmlFor="password">密码（至少 8 位）</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
        />

        {error !== null && <p className="danger">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? "创建中…" : "创建账号"}
        </button>
      </form>

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/sign-in">已有账号，去登录 →</Link>
      </p>
    </>
  );
}
