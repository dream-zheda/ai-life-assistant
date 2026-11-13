import Link from "next/link";

import { getCurrentUser } from "../../server/session";
import { loadQqBinding, loadQqStatus } from "./qq/qq-connect";

export const dynamic = "force-dynamic";

export default async function ConnectIndexPage() {
  const user = await getCurrentUser();
  const [qqStatus, qqBinding] = await Promise.all([loadQqStatus(), loadQqBinding(user.id)]);

  const qqReady = qqStatus.configured && qqStatus.reachable && qqBinding?.verified === true;

  return (
    <main>
      <h1>提醒通道</h1>
      <p className="sub">
        提醒最终要落到你能看到的地方。选一个通道接上；没接也能用——「今天」页面会显示所有提醒。
      </p>

      <h2>已接入</h2>

      <div className="card">
        <div className="row">
          <strong>QQ 提醒助手</strong>
          <span className={qqReady ? "tag ok" : "tag"}>
            {qqReady ? "已接入" : qqStatus.configured ? "已配置未就绪" : "未配置"}
          </span>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          {qqReady
            ? `提醒会发到 QQ ${qqBinding?.qqNumber}`
            : "添加提醒助手为好友，再通过私聊绑定码验证。无需安装额外软件。"}
        </p>
        <Link href="/connect/qq">
          <button type="button" className="secondary">
            {qqReady ? "管理" : "去接入"}
          </button>
        </Link>
      </div>

      <div className="card">
        <div className="row">
          <strong>微信</strong>
          <span className="tag warn">协议已失效</span>
        </div>
        <p className="muted" style={{ marginTop: 6 }}>
          微信网页协议已被腾讯关闭，扫码后会在最后一步被拒。页面仍保留，用于以后接付费的
          iPad 协议。
        </p>
        <Link href="/connect/wechat">
          <button type="button" className="secondary">
            查看
          </button>
        </Link>
      </div>

      <h2>只在这里看</h2>
      <p className="muted">
        不接任何通道也能用：所有提醒都会出现在「今天」页面的「今日提醒」区块里。
        通道只是让提醒更主动一些。
      </p>

      <nav className="nav">
        <Link href="/today">← 回到今天</Link>
        <Link href="/settings">提醒设置</Link>
      </nav>
    </main>
  );
}
