import Link from "next/link";

export const metadata = {
  title: "隐私说明 · 生活助手",
};

/**
 * 用户可见的隐私说明。
 *
 * 这份文案必须与实现一致（见 docs/compliance.md 的对照表）。
 * 不要在这里写"端到端加密""绝不外泄"这类做不到的承诺。
 */
export default function PrivacyPage() {
  return (
    <main>
      <h1>隐私说明</h1>
      <p className="sub">最后更新：2026-11-03</p>

      <h2>我们收集什么</h2>
      <ul className="plain">
        <li>邮箱与密码（密码以哈希形式保存，我们不保存明文）</li>
        <li>你填写的个人情况、目标、固定安排</li>
        <li>你对计划的完成反馈</li>
        <li>如果你绑定了微信：你的微信标识，以及你最后一次发消息的时间</li>
      </ul>
      <p className="muted">
        我们不收集真实姓名、身份证、地理位置、通讯录或设备指纹。
      </p>

      <h2>这些信息用在哪</h2>
      <ul className="plain">
        <li>生成你的生活计划、判断时间冲突、发送提醒</li>
        <li>
          <strong>会发送给大模型服务商</strong>：生成计划时，你的情况描述与目标会作为请求内容发给模型服务商。
          具体是哪家服务商由部署方配置。
        </li>
        <li>我们不会把你的数据用于训练模型，也不会出售给第三方。</li>
      </ul>

      <h2>谁能看到</h2>
      <ul className="plain">
        <li>你自己：网页端可以看到全部数据。</li>
        <li>
          <strong>服务器与数据库管理员：理论上能看到明文数据。</strong>
          这个服务没有做端到端加密——请不要在这里存放你无法接受被运维人员看到的信息。
        </li>
        <li>其他用户：看不到你的任何数据。</li>
      </ul>

      <h2>保留多久</h2>
      <ul className="plain">
        <li>业务数据随账号存续，不自动过期。</li>
        <li>数据库每日备份，保留 14 天。</li>
        <li>
          删除账号会删除你的计划、进度与提醒；
          <strong>备份中的副本会保留到备份过期（最长 14 天）</strong>。
        </li>
      </ul>

      <h2>我们不做什么</h2>
      <ul className="plain">
        <li>不提供医疗、法律或投资建议。计划只是安排，不构成专业意见。</li>
        <li>不保证提醒一定送达——微信平台对主动推送有时间窗口限制。</li>
        <li>不向未成年人提供服务。</li>
      </ul>

      <h2>你的权利</h2>
      <p className="muted">
        你可以在网页端查看与修改自己的信息；在「提醒设置」页可以
        <strong>下载自己的全部数据（JSON）</strong>，也可以在那里
        <strong>永久删除账号</strong>（需要输入确认文字）。
        导出的文件不包含密码哈希、会话 token 或第三方登录凭据。
      </p>

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/today">← 回到今天</Link>
      </p>
    </main>
  );
}
