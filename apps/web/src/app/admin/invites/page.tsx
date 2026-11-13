import Link from "next/link";

import { createInviteAction, revokeInviteAction } from "../../actions";
import { listInvites, type InviteStatus } from "../../../server/invite-admin";
import { requireAdmin } from "../../../server/session";
import { SubmitButton } from "../../../components/submit-button";
import { InviteLink } from "./invite-link";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const STATUS_LABEL: Record<InviteStatus, string> = {
  pending: "待使用",
  used: "已使用",
  expired: "已过期",
  revoked: "已撤销",
};

function formatInstant(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export default async function AdminInvitesPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const admin = await requireAdmin();
  const invites = await listInvites();

  const createdToken = first(params["created"]);
  const inviteUrl = new URL("/sign-up", process.env.APP_SHARE_URL ?? process.env.APP_BASE_URL ?? "http://127.0.0.1:3100");
  if (createdToken !== undefined) inviteUrl.searchParams.set("invite", createdToken);
  const error = first(params["error"]);
  const revoked = first(params["revoked"]) === "1";

  const pending = invites.filter((invite) => invite.status === "pending").length;

  return (
    <main>
      <h1>邀请码</h1>
      <p className="sub">
        {admin.email} · 共 {invites.length} 条，其中 {pending} 条待使用
      </p>

      {error !== undefined && <p className="danger">{error}</p>}
      {revoked && <p className="warn">已撤销。</p>}

      {createdToken !== undefined && (
        <div className="card">
          <strong>邀请码已生成</strong>
          <p className="muted">
            请复制链接给受邀者。此页面地址包含邀请码，分享时请使用下方注册链接。
          </p>
          <InviteLink url={inviteUrl.toString()} />
          <details><summary>只查看邀请码</summary><p style={{ wordBreak: "break-all", fontFamily: "monospace" }}>{createdToken}</p></details>
        </div>
      )}

      <h2>生成新邀请码</h2>
      <form action={createInviteAction}>
        <label htmlFor="email">收件邮箱（可选，仅备注用）</label>
        <input id="email" name="email" type="email" placeholder="friend@example.com" />

        <label htmlFor="expiresInHours">有效期（小时，1–720）</label>
        <input
          id="expiresInHours"
          name="expiresInHours"
          type="number"
          min={1}
          max={720}
          defaultValue={72}
        />
        <p className="muted">
          邮箱目前只是备注，不会校验注册者是否使用同一邮箱——链接转发给别人仍然可用。
        </p>

        <SubmitButton pendingLabel="正在生成…">生成邀请码</SubmitButton>
      </form>

      <h2>已发出的邀请码</h2>
      {invites.length === 0 ? (
        <p className="muted">还没有发过邀请码。</p>
      ) : (
        <ul className="plain">
          {invites.map((invite) => (
            <li key={invite.id}>
              <div className="row">
                <span>
                  <span className="tag">{STATUS_LABEL[invite.status]}</span>{" "}
                  {invite.email ?? "（未指定邮箱）"}
                  <span className="muted">
                    {" "}
                    · 由 {invite.createdByEmail} 创建于 {formatInstant(invite.createdAt)}
                  </span>
                </span>
                {invite.status === "pending" ? (
                  <form action={revokeInviteAction} className="inline">
                    <input type="hidden" name="inviteId" value={invite.id} />
                    <button
                      type="submit"
                      className="secondary"
                      style={{ marginTop: 0, padding: "2px 8px", fontSize: 12 }}
                    >
                      撤销
                    </button>
                  </form>
                ) : null}
              </div>
              <div className="muted">
                {invite.status === "used"
                  ? `被 ${invite.usedByEmail ?? "未知用户"} 于 ${invite.usedAt ? formatInstant(invite.usedAt) : "未知时间"} 使用`
                  : invite.status === "expired"
                    ? `已于 ${formatInstant(invite.expiresAt)} 过期`
                    : `还剩 ${invite.daysLeft ?? 0} 天（${formatInstant(invite.expiresAt)} 过期）`}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/today">← 回到今天</Link>
      </p>
    </main>
  );
}
