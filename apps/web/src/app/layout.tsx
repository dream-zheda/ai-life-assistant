import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";

import { getOptionalUser } from "../server/session";
import { Navigation } from "../components/navigation";
import { SignOutButton } from "./sign-out-button";

import "./globals.css";

export const metadata: Metadata = {
  title: "生活助手",
  description: "把目标拆成今天能做的事",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getOptionalUser();

  return (
    <html lang="zh-CN">
      <body className={user ? "signed-in" : "public-page"}>
        <a href="#page-content" className="skip-link">
          跳到主要内容
        </a>
        <header className="site-header">
          <div className="site-header-inner">
            <Link href={user === null ? "/sign-in" : "/today"} className="site-brand">
              <span className="brand-mark" aria-hidden="true">
                生
              </span>
              <span>
                生活助手<small>让每一天，从容一点</small>
              </span>
            </Link>
            {user !== null && (
              <>
                <p className="nav-caption">我的生活空间</p>
                <Navigation admin={user.role === "ADMIN"} />
                <div className="sidebar-note">
                  <span className="status-dot" />
                  一步一步，照自己的节奏。<p>目标、安排和休息，都值得被认真对待。</p>
                </div>
                <div className="account-block">
                  <span className="avatar" aria-hidden="true">
                    {(user.name || user.email).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="account-detail">
                    <strong>{user.name || "我的账号"}</strong>
                    <small>{user.email}</small>
                  </div>
                  <SignOutButton />
                </div>
              </>
            )}
          </div>
        </header>
        <div id="page-content" tabIndex={-1}>
          {children}
        </div>
      </body>
    </html>
  );
}
