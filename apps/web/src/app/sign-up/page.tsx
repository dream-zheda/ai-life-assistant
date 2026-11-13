import Link from "next/link";

import { SignUpForm } from "./sign-up-form";
import { prisma } from "../../server/db";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export default async function SignUpPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const inviteToken = first(params["invite"]);
  const bootstrap = (await prisma.user.count()) === 0;

  return (
    <main>
      <h1>注册</h1>
      <p className="sub">
        邀请制：必须通过管理员发放的邀请链接进入。第一个注册的账号会自动成为管理员。
      </p>

      <SignUpForm inviteToken={inviteToken} bootstrap={bootstrap} />

      <p className="muted" style={{ marginTop: 24 }}>
        注册前请先读 <Link href="/privacy">隐私说明</Link>：
        你的情况描述会发送给大模型服务商，服务器管理员理论上也能看到明文数据。
      </p>
    </main>
  );
}
