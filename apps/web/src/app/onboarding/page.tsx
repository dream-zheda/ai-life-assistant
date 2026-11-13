import Link from "next/link";

import { deleteConstraintAction, saveOnboarding } from "../actions";
import { groupConstraints } from "../../server/constraints";
import { prisma } from "../../server/db";
import { modelConfigSummary, PROVIDER_PRESETS } from "../../server/model-config";
import { getCurrentUser } from "../../server/session";
import { SubmitButton } from "../../components/submit-button";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const WEEKDAYS = [
  { value: "1", label: "周一" },
  { value: "2", label: "周二" },
  { value: "3", label: "周三" },
  { value: "4", label: "周四" },
  { value: "5", label: "周五" },
  { value: "6", label: "周六" },
  { value: "7", label: "周日" },
];

const REPEATS = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日（周一至周五）" },
  { value: "weekends", label: "周末" },
  { value: "weekly", label: "指定某一天" },
];

function weekdayLabel(weekdays: readonly number[]): string {
  const key = weekdays.join(",");
  if (key === "1,2,3,4,5,6,7") return "每天";
  if (key === "1,2,3,4,5") return "工作日";
  if (key === "6,7") return "周末";
  return weekdays.map((day) => WEEKDAYS[day - 1]?.label ?? `第${day}天`).join("、");
}

export default async function OnboardingPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const user = await getCurrentUser();

  const [profile, goals, constraints] = await Promise.all([
    prisma.profile.findUnique({ where: { userId: user.id } }),
    prisma.goal.findMany({
      where: { userId: user.id, state: "ACTIVE" },
      orderBy: { priority: "asc" },
    }),
    prisma.fixedConstraint.findMany({ where: { userId: user.id } }),
  ]);

  const groups = groupConstraints(constraints);
  const error = first(params["error"]);
  const deleted = first(params["deleted"]) === "1";
  const saved = first(params["saved"]) !== undefined;
  const test = first(params["test"]);
  const message = first(params["msg"]);
  const model = await modelConfigSummary(user.id);

  return (
    <main>
      <p className="eyebrow">A PLAN THAT KNOWS YOU</p>
      <h1>我的情况</h1>
      <p className="sub">告诉助手你的生活是什么样的。你提供背景，它来安排具体行动。</p>

      {error !== undefined && <p className="danger">{error}</p>}
      {deleted && <p className="warn">已删除。</p>}
      {saved && <p className="warn">已保存。</p>}
      {test === "ok" && message !== undefined && <p className="notice">{message}</p>}
      {test === "fail" && message !== undefined && <p className="danger">{message}</p>}

      <h2>AI 助手</h2>
      {model === null ? (
        <div className="card">
          <strong>还没有接入模型</strong>
          <p className="muted">先保存自己的情况，再接入模型，就可以生成计划。</p>
          <Link href="/setup/model" className="btn">
            去填 API Key
          </Link>
        </div>
      ) : (
        <p className="muted">
          已接入：
          {PROVIDER_PRESETS[model.providerId as keyof typeof PROVIDER_PRESETS]?.label ??
            model.providerId}
          {" · "}
          {model.modelId}
          {" · Key "}
          {model.hint}
          {"  "}
          <Link href="/setup/model">换一个 →</Link>
        </p>
      )}

      <div className="section-heading">
        <h2>当前目标与固定安排</h2>
        <Link href="/goals">管理目标 →</Link>
      </div>
      <ul className="plain">
        {goals.length === 0 && groups.length === 0 && profile === null ? (
          <li className="muted">还没有任何信息</li>
        ) : null}
        {goals.map((goal) => (
          <li key={goal.id}>
            <span className="tag">目标</span> {goal.title}
            <span className="muted"> · 优先级 {goal.priority}</span>
          </li>
        ))}
        {groups.map((group) => (
          <li key={group.key}>
            <div className="row">
              <span>
                <span className="tag">固定安排</span> {group.title}
                <span className="muted">
                  {" "}
                  · {weekdayLabel(group.weekdays)} {group.startTime}–{group.endTime}
                </span>
              </span>
              <span>
                {group.groupId !== null ? (
                  <Link href={`/constraints/${group.groupId}`}>编辑</Link>
                ) : null}{" "}
                <form action={deleteConstraintAction} className="inline">
                  <input type="hidden" name="groupId" value={group.groupId ?? ""} />
                  <input
                    type="hidden"
                    name="constraintId"
                    value={group.groupId === null ? (group.ids[0] ?? "") : ""}
                  />
                  <button
                    type="submit"
                    className="secondary"
                    style={{ marginTop: 0, padding: "2px 8px", fontSize: 12 }}
                  >
                    删除
                  </button>
                </form>
              </span>
            </div>
          </li>
        ))}
      </ul>

      <h2>补充信息</h2>
      <form action={saveOnboarding} className="card">
        <label htmlFor="rawInput">用一段话描述你的情况</label>
        <textarea
          id="rawInput"
          name="rawInput"
          defaultValue={profile?.rawInput ?? ""}
          maxLength={12000}
          placeholder="例如：我是大学生，白天有课，晚上容易打游戏，想提高英语和规律运动，希望保留娱乐时间。"
        />

        <label htmlFor="goalTitle">新增一个目标</label>
        <input
          id="goalTitle"
          name="goalTitle"
          maxLength={120}
          placeholder="例如：提高英语听力（可选）"
        />
        <label htmlFor="goalPriority">优先级（1 最高，5 最低）</label>
        <input
          id="goalPriority"
          name="goalPriority"
          type="number"
          min={1}
          max={5}
          defaultValue={3}
        />

        <label htmlFor="constraintTitle">新增固定安排</label>
        <input id="constraintTitle" name="constraintTitle" placeholder="例如：睡觉 / 高数课" />
        <div style={{ display: "flex", gap: 8 }}>
          <select
            name="constraintRepeat"
            defaultValue="daily"
            aria-label="重复方式"
            style={{ flex: 1, padding: 9 }}
          >
            {REPEATS.map((repeat) => (
              <option key={repeat.value} value={repeat.value}>
                {repeat.label}
              </option>
            ))}
          </select>
          <select
            name="constraintWeekday"
            defaultValue="2"
            aria-label="星期"
            style={{ flex: 1, padding: 9 }}
          >
            {WEEKDAYS.map((day) => (
              <option key={day.value} value={day.value}>
                {day.label}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input name="constraintStart" type="time" defaultValue="23:00" aria-label="开始时间" />
          <input name="constraintEnd" type="time" defaultValue="07:00" aria-label="结束时间" />
        </div>
        <p className="muted">
          填写已确定的课程、工作或睡眠时间，助手会避开这些时段。
          支持跨夜安排；「星期」仅在选择「指定某一天」时生效。
        </p>

        <SubmitButton>保存我的情况</SubmitButton>
      </form>

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/today">← 回到今天</Link>
      </p>
    </main>
  );
}
