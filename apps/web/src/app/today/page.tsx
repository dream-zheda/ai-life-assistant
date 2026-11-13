import Link from "next/link";
import { describeInstant, localDayOf } from "@life/shared";
import { activatePlanAction, generatePlanAction, submitProgress } from "../actions";
import { SubmitButton } from "../../components/submit-button";
import { prisma } from "../../server/db";
import { listTodayNotifications } from "../../server/inbox";
import { modelConfigSummary } from "../../server/model-config";
import { getCurrentUser } from "../../server/session";
import { loadUserSettings } from "../../server/settings";
import { loadTodayPlans } from "../../server/today";

export const dynamic = "force-dynamic";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
const labels: Record<string, string> = {
  PENDING: "待进行",
  IN_PROGRESS: "进行中",
  PARTIALLY_DONE: "部分完成",
  DONE: "已完成",
  SKIPPED: "已跳过",
  CANCELLED: "已取消",
};
function time(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
function Generation({ configured, again = false }: { configured: boolean; again?: boolean }) {
  return (
    <form action={generatePlanAction}>
      <SubmitButton disabled={!configured} pendingLabel="正在规划，请稍候…">
        {again ? "重新规划今天" : "生成今天的计划"}
        <span aria-hidden="true"> ↗</span>
      </SubmitButton>
    </form>
  );
}

export default async function TodayPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const now = new Date();
  const today = localDayOf(now, user.timeZone);
  const stamp = describeInstant(now, user.timeZone);
  const [{ active, draft }, inbox, model, settings, profile, goalCount] = await Promise.all([
    loadTodayPlans(user.id, today),
    listTodayNotifications({ userId: user.id, timeZone: user.timeZone, now }),
    modelConfigSummary(user.id),
    loadUserSettings(user.id),
    prisma.profile.findUnique({ where: { userId: user.id } }),
    prisma.goal.count({ where: { userId: user.id, state: "ACTIVE" } }),
  ]);
  const configured = model !== null || Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  const events = active
    ? await prisma.progressEvent.findMany({
        where: { userId: user.id, planItemId: { in: active.items.map((item) => item.id) } },
        orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      })
    : [];
  const progress = new Map<string, { state: string; ratio: number }>();
  for (const event of events)
    if (!progress.has(event.planItemId)) progress.set(event.planItemId, event);
  const items = active?.items ?? [];
  const completed = items.filter((item) => progress.get(item.id)?.state === "DONE").length;
  const minutes = items.reduce((sum, item) => sum + item.minutes, 0);
  const next = items.find(
    (item) =>
      item.endsAt > now &&
      !["DONE", "CANCELLED", "SKIPPED"].includes(progress.get(item.id)?.state ?? ""),
  );
  const basis = (draft?.basis ?? active?.basis) as {
    assumptions?: string[];
    unresolvedQuestions?: string[];
    warnings?: Array<{ message: string }>;
  } | null;
  const error = first(params.error);
  const dropped = Number(first(params.dropped) ?? "0");

  return (
    <main>
      <header className="page-heading">
        <div>
          <p className="eyebrow">YOUR DAY, AT YOUR PACE</p>
          <h1>{user.name ? `${user.name}，` : ""}把今天安排好</h1>
          <p className="sub">
            {stamp.localDay} · {stamp.weekdayLabel}{" "}
            <span className="muted"> / 给重要的事，也给自己留一点时间。</span>
          </p>
        </div>
        <div className="actions">
          <Generation configured={configured} again={Boolean(active || draft)} />
        </div>
      </header>
      {error && (
        <p role="alert" className="danger">
          {error}
        </p>
      )}
      {first(params.generated) === "1" && (
        <p role="status" className="notice">
          新计划已生成，请查看下方草稿并采纳。
          {active ? "当前生效计划会继续执行，直到你采纳新版本。" : ""}
        </p>
      )}
      {first(params.generated) === "0" && !error && (
        <p role="alert" className="danger">
          本次没有生成可用计划，请检查模型配置，或补充个人情况后重试。
        </p>
      )}
      {first(params.activated) === "1" && (
        <p role="status" className="notice">
          计划已采纳，提醒将按设置执行。
          {Number.isFinite(dropped) && dropped > 0 ? `已跳过 ${dropped} 项已经结束的安排。` : ""}
        </p>
      )}
      {first(params.saved) === "1" && (
        <p role="status" className="notice">
          已保存，进度已更新。
        </p>
      )}
      {settings.remindersPaused && (
        <p className="warn">
          提醒已暂停。你仍可查看和完成计划，<Link href="/settings">前往设置恢复提醒 →</Link>
        </p>
      )}

      <section className="stats-grid" aria-label="今日统计">
        <div className="card stat-card">
          <span>今日安排</span>
          <p className="stat-value">
            {items.length}
            <small>项</small>
          </p>
        </div>
        <div className="card stat-card">
          <span>已完成</span>
          <p className="stat-value">
            {completed}
            <small>/ {items.length} 项</small>
          </p>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="今日完成进度"
            aria-valuemin={0}
            aria-valuemax={items.length || 1}
            aria-valuenow={completed}
          >
            <div
              className="progress-fill"
              style={{ width: `${items.length ? (completed / items.length) * 100 : 0}%` }}
            />
          </div>
        </div>
        <div className="card stat-card">
          <span>计划投入</span>
          <p className="stat-value">
            {minutes}
            <small>分钟</small>
          </p>
        </div>
      </section>

      <div className="dashboard-grid">
        <section aria-label="今天的计划">
          <div className="card focus-card">
            <p className="eyebrow">
              {next
                ? next.startsAt <= now
                  ? "现在可以专注"
                  : "下一步，从这里开始"
                : "留一点空间，慢慢来"}
            </p>
            <h2>
              {next?.title ??
                (active ? "按自己的节奏，收好今天" : "一份适合你的计划，从了解你开始")}
            </h2>
            <p className="muted">
              {next
                ? `${time(next.startsAt, user.timeZone)}–${time(next.endsAt, user.timeZone)} · ${next.minutes} 分钟`
                : active
                  ? "你可以在下方记录进展。没有反馈的安排会保留原样。"
                  : "告诉助手你的目标与作息，让它帮你把想做的事安排进生活。"}
            </p>
            {next && (
              <span className="tag">
                {progress.get(next.id)?.state === "PARTIALLY_DONE"
                  ? "已经完成一部分，继续加油"
                  : "一次，做好一件事"}
              </span>
            )}
            {!active && <Link href="/onboarding">完善我的情况 →</Link>}
          </div>

          {draft && (
            <section className="card draft-panel" aria-label="待采纳计划">
              <div className="row">
                <h3>这份计划还没有生效</h3>
                <span className="tag warn">待采纳 · 版本 {draft.version}</span>
              </div>
              <p className="muted">
                {active
                  ? "这是新的建议。采纳后会替换当前安排；已完成的历史记录会保留。"
                  : "查看安排是否合适，采纳之后才会按它生成提醒。"}
              </p>
              {draft.items.length ? (
                <ul className="draft-list">
                  {draft.items.map((item) => (
                    <li key={item.id}>
                      <time>
                        {time(item.startsAt, user.timeZone)}–{time(item.endsAt, user.timeZone)}
                      </time>
                      <div>
                        <strong>{item.title}</strong>
                        {item.reason && <div className="muted">{item.reason}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="empty">这份草稿没有具体安排，请补充信息或检查模型配置后重新生成。</p>
              )}
              {draft.items.length > 0 && (
                <form action={activatePlanAction}>
                  <input type="hidden" name="planVersionId" value={draft.id} />
                  <SubmitButton pendingLabel="正在采纳…">采纳这份计划</SubmitButton>
                </form>
              )}
            </section>
          )}

          <div className="section-heading">
            <h2>今天的安排</h2>
            <span className="muted">
              {active ? `生效中 · 版本 ${active.version}` : "等待计划生效"}
            </span>
          </div>
          {items.length ? (
            <ol className="timeline">
              {items.map((item) => {
                const state = progress.get(item.id);
                const done = state?.state === "DONE";
                const terminal = done || state?.state === "CANCELLED";
                return (
                  <li className="timeline-item" key={item.id}>
                    <div className="timeline-time">
                      {time(item.startsAt, user.timeZone)}
                      <small>{time(item.endsAt, user.timeZone)}</small>
                    </div>
                    <article
                      className={`card timeline-card${done ? " is-done" : next?.id === item.id ? " is-current" : ""}`}
                    >
                      <h3>{item.title}</h3>
                      {item.reason && <p className="task-reason">{item.reason}</p>}
                      <div className="task-bottom">
                        <span className={`tag${done ? " ok" : ""}`}>
                          {state
                            ? `${labels[state.state] ?? state.state}${state.state === "PARTIALLY_DONE" ? ` ${Math.round(state.ratio * 100)}%` : ""}`
                            : "待反馈"}
                        </span>
                        {!terminal && (
                          <div className="task-actions">
                            {[
                              { ratio: 0, label: "还没做" },
                              { ratio: 0.5, label: "做了一半" },
                              { ratio: 1, label: "完成" },
                            ].map((option) => (
                              <form action={submitProgress} key={option.ratio}>
                                <input type="hidden" name="planItemId" value={item.id} />
                                <input type="hidden" name="ratio" value={option.ratio} />
                                <SubmitButton className="secondary" pendingLabel="记录中…">
                                  {option.label}
                                </SubmitButton>
                              </form>
                            ))}
                          </div>
                        )}
                      </div>
                    </article>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="card empty-state">
              <div className="empty-symbol" aria-hidden="true">
                ◷
              </div>
              <h3>{draft ? "采纳草稿，开始今天" : "今天还没有计划"}</h3>
              <p className="sub">
                {draft
                  ? "上方草稿供你确认，生效后可在这里反馈进度。"
                  : "准备好个人情况和模型，就可以让助手为你安排一天。"}
              </p>
              {!draft && (
                <div className="actions">
                  {configured ? (
                    <Generation configured />
                  ) : (
                    <Link className="btn" href="/setup/model">
                      接入模型
                    </Link>
                  )}
                </div>
              )}
            </div>
          )}
          {basis && (
            <details className="card">
              <summary>看看助手的规划依据</summary>
              <div style={{ marginTop: 16 }}>
                {basis.assumptions?.map((line, index) => (
                  <p className="muted" key={`a${index}`}>
                    {line}
                  </p>
                ))}
                {basis.unresolvedQuestions?.map((line, index) => (
                  <p className="warn" key={`q${index}`}>
                    {line}
                  </p>
                ))}
                {basis.warnings?.map((line, index) => (
                  <p className="warn" key={`w${index}`}>
                    {line.message}
                  </p>
                ))}
                <Link href="/onboarding">补充或纠正我的情况 →</Link>
              </div>
            </details>
          )}
        </section>
        <aside aria-label="提醒和个人设置">
          <section className="card">
            <h2>我的准备情况</h2>
            <ul className="checklist">
              {[
                {
                  href: "/onboarding",
                  title: "介绍一下自己",
                  note: profile?.rawInput ? "个人情况已保存，可随时更新" : "作息、偏好和最近的状态",
                  ok: Boolean(profile?.rawInput),
                },
                {
                  href: "/goals",
                  title: "确定想做的事",
                  note: goalCount ? `${goalCount} 个目标正在推进` : "从一个小目标开始也可以",
                  ok: goalCount > 0,
                },
                {
                  href: "/setup/model",
                  title: "连接 AI 模型",
                  note:
                    model?.modelId ??
                    (configured ? "使用服务器配置的模型" : "支持多家模型与兼容接口"),
                  ok: configured,
                },
              ].map((step, index) => (
                <li key={step.href}>
                  <Link href={step.href}>
                    <span className={`check-indicator${step.ok ? " ok" : ""}`}>
                      {step.ok ? "✓" : index + 1}
                    </span>
                    <span>
                      {step.title}
                      <small>{step.note}</small>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <div className="section-heading" style={{ marginTop: 0 }}>
              <h2>今日提醒</h2>
              <Link href="/settings">设置</Link>
            </div>
            {inbox.length ? (
              <ul className="notification-list">
                {inbox.map((item) => (
                  <li key={item.id}>
                    <div className="row">
                      <time className="muted">{time(item.scheduledAt, user.timeZone)}</time>
                      <span
                        className={`tag${item.state === "FAILED" ? " bad" : item.state === "SENT" ? " ok" : ""}`}
                      >
                        {item.stateLabel}
                      </span>
                    </div>
                    <p>{item.content}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="empty">暂时没有提醒。计划生效后，提醒会在这里汇总。</p>
            )}
            {inbox.some((item) => ["FAILED", "FALLBACK_REQUIRED"].includes(item.state)) && (
              <p className="field-hint">部分提醒仅在站内保留，可直接查看上方安排。</p>
            )}
          </section>
          <section className="card">
            <h2>按你的节奏</h2>
            <p className="muted">安排太满或生活有变化时，先更新情况，再重新规划。</p>
            <div className="quick-links">
              <Link href="/onboarding">
                更新我的情况 <span>↗</span>
              </Link>
              <Link href="/goals">
                调整目标优先级 <span>↗</span>
              </Link>
              <Link href="/settings">
                管理免打扰 <span>↗</span>
              </Link>
            </div>
          </section>
        </aside>
      </div>
      <footer className="status-strip">
        <span>
          {user.timeZone} · 页面更新于 {stamp.localTime}
        </span>
        <span>完成情况以你的反馈为准</span>
      </footer>
    </main>
  );
}
