"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { authClient } from "../lib/auth-client";

export function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  return (
    <button
      type="button"
      className="secondary"
      style={{ marginTop: 0, padding: "4px 12px", fontSize: 13 }}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        setError(false);
        try {
          const result = await authClient.signOut();
          if (result.error) {
            setError(true);
            return;
          }
          router.push("/sign-in");
          router.refresh();
        } catch {
          setError(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "退出中…" : error ? "退出失败，点击重试" : "退出登录"}
    </button>
  );
}
