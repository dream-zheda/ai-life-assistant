"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "../../lib/auth-client";

export default function SignInPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);

    try {
      const result = await authClient.signIn.email({
        email: String(form.get("email") ?? ""),
        password: String(form.get("password") ?? ""),
      });

      setBusy(false);
      if (result.error !== null && result.error !== undefined) {
        setError(result.error.message ?? "登录失败");
        return;
      }
      router.push("/today");
      router.refresh();
    } catch {
      setError("暂时连接不上，请检查网络后重试。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <p className="eyebrow">WELCOME BACK</p>
      <h1>欢迎回到你的生活空间</h1>
      <p className="sub">照顾目标，也照顾自己的节奏。</p>

      <form onSubmit={onSubmit}>
        <label htmlFor="email">邮箱</label>
        <input id="email" name="email" type="email" required autoComplete="email" />

        <label htmlFor="password">密码</label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="current-password"
        />

        {error !== null && (
          <p className="danger" role="alert">
            {error}
          </p>
        )}

        <button type="submit" disabled={busy}>
          {busy ? "登录中…" : "登录"}
        </button>
      </form>

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/sign-up">没有账号，去注册 →</Link>
      </p>
    </main>
  );
}
