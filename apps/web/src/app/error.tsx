"use client";
import Link from "next/link";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main>
      <section className="card empty-state">
        <p className="eyebrow">暂时遇到问题</p>
        <h1>页面没有加载成功</h1>
        <p className="sub">
          请稍后重试。如果刚刚提交了修改，请先查看最新状态，再决定是否重新提交。
        </p>
        <div className="actions">
          <button onClick={reset}>重新加载</button>
          <Link className="btn secondary" href="/today">
            回到今天
          </Link>
        </div>
      </section>
    </main>
  );
}
