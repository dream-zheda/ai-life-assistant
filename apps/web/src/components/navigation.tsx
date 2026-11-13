"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const links = [
  ["/today", "今日概览", "◷"],
  ["/goals", "我的目标", "◎"],
  ["/onboarding", "我的情况", "☷"],
  ["/setup/model", "模型配置", "✧"],
  ["/connect", "提醒通道", "◇"],
  ["/settings", "偏好设置", "⚙"],
] as const;
export function Navigation({ admin }: { admin: boolean }) {
  const pathname = usePathname();
  const entries = admin ? [...links, ["/admin/invites", "邀请管理", "+"] as const] : links;
  return (
    <nav className="site-links" aria-label="主导航">
      {entries.map(([href, label, icon]) => {
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} prefetch={false} aria-current={active ? "page" : undefined}>
            <span className="nav-icon" aria-hidden="true">
              {icon}
            </span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
