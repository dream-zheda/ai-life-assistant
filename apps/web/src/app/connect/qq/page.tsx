import Link from "next/link";
import { getCurrentUser } from "../../../server/session";
import { SubmitButton } from "../../../components/submit-button";
import { loadQqBinding, loadQqStatus } from "./qq-connect";
import { LinkCodeForm } from "./link-code-form";
import { unlinkQqAction } from "./actions";

export const dynamic = "force-dynamic";

export default async function ConnectQqPage() {
  const user = await getCurrentUser();
  const [status, binding] = await Promise.all([loadQqStatus(), loadQqBinding(user.id)]);
  const online = status.configured && status.reachable;
  const botId = process.env.ONEBOT_SELF_ID ?? "";
  return <main>
    <div className="page-heading"><div><p className="eyebrow">连接你的日常</p><h1>用 QQ 聊天和接收提醒</h1>
      <p className="sub">添加同一个提醒助手，绑定你自己的账号。你的安排与完成反馈只会关联到你。</p></div></div>
    <section className="card">
      <div className="row"><h2>1. 添加提醒助手为好友</h2><span className={online ? "tag ok" : "tag"}>{online ? "QQ 在线" : "暂未上线"}</span></div>
      <p>{status.configured && status.reachable ? status.nickname : "AI 个人助手"}</p>
      {botId ? <p>机器人 QQ 号：<strong style={{ fontSize: "1.5rem" }}>{botId}</strong></p> : <p>管理员尚未设置机器人账号。</p>}
      <p className="muted">在 QQ 中搜索这个号码并添加好友。{process.env.ONEBOT_AUTO_ACCEPT_FRIENDS === "true" ? "助手会自动通过好友申请，通常需等待几秒至一分钟。" : "请等待管理员通过好友申请。"}</p>
      {!online && <p className="warn">机器人暂未准备好，稍后刷新页面再绑定。站内计划仍可正常使用。</p>}
    </section>
    <section className="card"><h2>2. 私聊验证并绑定</h2>
      {binding?.verified ? <><p className="tag ok">已验证绑定</p><p>接收提醒的 QQ：<strong>{binding.qqNumber}</strong></p><p className="muted">可以在「今天」生成并采纳计划。到点后由机器人私聊提醒你。</p></> : <>
        <p>成为好友后，领取绑定码，将下方消息发送给机器人。</p>
        {binding && <p className="warn">旧的手填 QQ 记录尚未验证，请重新绑定后再接收提醒。</p>}
      </>}
      <LinkCodeForm online={online} verified={binding?.verified ?? false} />
      {binding && <form action={unlinkQqAction}><p className="muted">更换 QQ 前请先解绑。解绑会停止通过此 QQ 接收后续提醒，并使未使用的绑定码失效。</p><SubmitButton className="secondary" pendingLabel="解绑中…">解除 QQ 绑定</SubmitButton></form>}
    </section>
    <section className="card"><h2>3. 接收提醒，反馈进度</h2><p>收到提醒后回复「1」反馈最近一项，或回复「完成 2」反馈当天第 2 项。网页会同步你的进度。</p>
      <p className="muted">添加好友不等于完成绑定。机器人需要保持在线；免打扰、暂停提醒和每日上限仍然生效。</p><Link href="/settings">调整提醒偏好 →</Link>
    </section>
    <section className="card"><h2>4. 直接和 AI 聊聊</h2>
      <p>绑定后，在 QQ 私聊中直接发送文字，例如「我今天不想学英语，怎么开始？」或「结合今天的安排给我一点建议」。助手会结合你的个人情况、当天已生效计划和最近对话回复。</p>
      <p className="muted">聊天使用你在网页配置的模型。普通聊天提供建议；修改计划需要回到网页确认。「完成 2」等进度指令仍可直接使用。对话内容会保存，并连同必要的个人情况和计划发送给你选择的模型服务商。</p>
      <Link href="/setup/model">配置或测试聊天模型 →</Link>
    </section>
    {user.role === "ADMIN" && <section className="card"><h2>管理员连接说明</h2><p className="muted">只需由管理员登录一次机器人账号。用户无需安装或配置 NapCat。若账号离线，请检查机器人登录、HTTP 接口和事件上报；详细步骤见项目文档《QQ机器人接入》。</p></section>}
    <nav className="nav"><Link href="/today">← 回到今天</Link><Link href="/connect/qq">刷新连接状态</Link></nav>
  </main>;
}
