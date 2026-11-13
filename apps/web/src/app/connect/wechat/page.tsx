import Link from "next/link";

import { getCurrentUser } from "../../../server/session";
import { loadBinding, loadConnectState } from "../../../server/wechat-connect";
import { ConnectClient } from "./connect-client";

export const dynamic = "force-dynamic";

export default async function ConnectWechatPage() {
  const user = await getCurrentUser();
  const [state, binding] = await Promise.all([loadConnectState(), loadBinding(user.id)]);

  return (
    <main>
      <h1>连接微信</h1>
      <p className="sub">
        用一个你自己注册的微信号接收提醒。登录由桥接服务完成——
        <strong>我们不保存你的密码，也拿不到任何凭据</strong>。
      </p>

      <ConnectClient
        initial={state}
        initialBinding={
          binding === null
            ? null
            : {
                externalUserId: binding.externalUserId,
                displayName: binding.displayName,
                sessionState: binding.sessionState,
                lastInboundAt: binding.lastInboundAt?.toISOString() ?? null,
              }
        }
      />

      <p className="danger">
        ⚠️ 个人微信号走第三方协议登录，违反《微信个人账号使用规范》1.2.6，
        账号可能被限制功能直至永久封禁。不要用你的主号，也请在别处保留一个能提醒到你的方式。
      </p>

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/today">← 回到今天</Link> · <Link href="/settings">提醒设置</Link>
      </p>
    </main>
  );
}
