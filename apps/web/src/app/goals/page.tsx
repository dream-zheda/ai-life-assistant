import Link from "next/link";
import { saveGoalAction } from "../actions";
import { SubmitButton } from "../../components/submit-button";
import { prisma } from "../../server/db";
import { getCurrentUser } from "../../server/session";

export const dynamic = "force-dynamic";
const states = { ACTIVE: "进行中", PAUSED: "已暂停", ACHIEVED: "已达成", DROPPED: "已结束" };
type GoalView = {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  state: string;
  targetDate: string | null;
};
function GoalForm({ goal }: { goal?: GoalView }) {
  const prefix = goal?.id ?? "new";
  return (
    <form action={saveGoalAction}>
      {goal && <input type="hidden" name="id" value={goal.id} />}
      <label htmlFor={`${prefix}-title`}>想达成什么</label>
      <input
        id={`${prefix}-title`}
        name="title"
        required
        maxLength={120}
        defaultValue={goal?.title ?? ""}
        placeholder="例如：坚持运动，让精力更充沛"
      />
      <label htmlFor={`${prefix}-description`}>当前情况与期待</label>
      <textarea
        id={`${prefix}-description`}
        name="description"
        maxLength={3000}
        defaultValue={goal?.description ?? ""}
        placeholder="目前做到哪里、有哪些困难，希望达到什么程度？"
      />
      <div className="form-grid">
        <div>
          <label htmlFor={`${prefix}-priority`}>优先级</label>
          <select id={`${prefix}-priority`} name="priority" defaultValue={goal?.priority ?? 3}>
            {[1, 2, 3, 4, 5].map((value) => (
              <option value={value} key={value}>
                {value}
                {value === 1 ? " · 最优先" : value === 5 ? " · 可以慢慢来" : ""}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`${prefix}-date`}>期望日期（可选）</label>
          <input
            id={`${prefix}-date`}
            name="targetDate"
            type="date"
            defaultValue={goal?.targetDate ?? ""}
          />
        </div>
      </div>
      {goal ? (
        <>
          <label htmlFor={`${prefix}-state`}>目标状态</label>
          <select id={`${prefix}-state`} name="state" defaultValue={goal.state}>
            {Object.entries(states).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </>
      ) : (
        <input type="hidden" name="state" value="ACTIVE" />
      )}
      <SubmitButton>{goal ? "保存目标" : "添加目标"}</SubmitButton>
    </form>
  );
}
export default async function GoalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  const params = await searchParams;
  const goals = await prisma.goal.findMany({
    where: { userId: user.id },
    orderBy: [{ state: "asc" }, { priority: "asc" }, { createdAt: "desc" }],
  });
  const error = Array.isArray(params.error) ? params.error[0] : params.error;
  return (
    <main>
      <header className="page-heading">
        <div>
          <p className="eyebrow">A LITTLE CLOSER, EVERY DAY</p>
          <h1>我的目标</h1>
          <p className="sub">说清楚想去的方向，具体行动交给助手来安排。</p>
        </div>
        <a className="btn" href="#new-goal">
          ＋ 添加目标
        </a>
      </header>
      {error && (
        <p className="danger" role="alert">
          {error}
        </p>
      )}
      {params.saved === "1" && (
        <p className="notice" role="status">
          目标已保存。新生成的计划会参考这些变化，当前生效计划不会自动改动。
        </p>
      )}
      <div className="section-heading">
        <h2>正在关心的事</h2>
        <span className="muted">
          {goals.filter((goal) => goal.state === "ACTIVE").length} 个进行中 · 共 {goals.length} 个
        </span>
      </div>
      {goals.length ? (
        <div className="goal-grid">
          {goals.map((goal) => (
            <article key={goal.id} className="card goal-card">
              <div className="row">
                <span className={`tag${goal.state === "ACTIVE" ? " ok" : ""}`}>
                  {states[goal.state]}
                </span>
                <span className="muted">优先级 {goal.priority}</span>
              </div>
              <h3>{goal.title}</h3>
              {goal.description && (
                <p className="muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                  {goal.description}
                </p>
              )}
              {goal.targetDate && <p className="field-hint">期望日期 · {goal.targetDate}</p>}
              <details>
                <summary>编辑目标与状态</summary>
                <GoalForm goal={goal} />
              </details>
            </article>
          ))}
        </div>
      ) : (
        <section className="card empty-state">
          <div className="empty-symbol">◎</div>
          <h3>从一个真正想做的目标开始</h3>
          <p className="muted">学习、运动、工作或生活习惯，都可以记录在这里。</p>
        </section>
      )}
      <section id="new-goal" className="card" style={{ marginTop: 28 }}>
        <h2>添加一个目标</h2>
        <p className="muted">暂停或结束目标后，助手不会在新计划里继续安排它。</p>
        <GoalForm />
      </section>
      <nav className="nav">
        <Link href="/today">查看今日安排 →</Link>
      </nav>
    </main>
  );
}
