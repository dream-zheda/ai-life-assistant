import Link from "next/link";
import { notFound } from "next/navigation";

import { deleteConstraintAction, updateConstraintAction } from "../../actions";
import { inferRepeat } from "../../../server/constraints";
import { prisma } from "../../../server/db";
import { getCurrentUser } from "../../../server/session";

export const dynamic = "force-dynamic";

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

export default async function EditConstraintPage({
  params,
}: {
  params: Promise<{ groupId: string }>;
}) {
  const { groupId } = await params;
  const user = await getCurrentUser();

  const rows = await prisma.fixedConstraint.findMany({
    where: { userId: user.id, groupId },
    orderBy: { weekday: "asc" },
  });

  if (rows.length === 0) notFound();

  const first = rows[0];
  if (first === undefined) notFound();

  const weekdays = rows.map((row) => row.weekday).filter((day): day is number => day !== null);
  const inferred = inferRepeat(weekdays);

  if (inferred === null) {
    return (
      <main>
        <h1>编辑固定安排</h1>
        <p className="danger">
          这组安排的重复方式（{weekdays.join("、")}）不属于任何预设，暂时无法在这里编辑。
        </p>
        <form action={deleteConstraintAction} className="inline">
          <input type="hidden" name="groupId" value={groupId} />
          <button type="submit" className="secondary">
            删除这组安排
          </button>
        </form>
        <p className="muted" style={{ marginTop: 24 }}>
          <Link href="/onboarding">← 回到我的情况</Link>
        </p>
      </main>
    );
  }

  return (
    <main>
      <h1>编辑固定安排</h1>
      <p className="sub">修改后会保留这组安排的创建时间，但不会保留历史版本。</p>

      <form action={updateConstraintAction}>
        <input type="hidden" name="groupId" value={groupId} />

        <label htmlFor="title">名称</label>
        <input id="title" name="title" required defaultValue={first.title} />

        <label htmlFor="repeat">重复方式</label>
        <select id="repeat" name="repeat" defaultValue={inferred.repeat} style={{ padding: 9, width: "100%" }}>
          {REPEATS.map((repeat) => (
            <option key={repeat.value} value={repeat.value}>
              {repeat.label}
            </option>
          ))}
        </select>

        <label htmlFor="weekday">星期（仅在「指定某一天」时生效）</label>
        <select
          id="weekday"
          name="weekday"
          defaultValue={String(inferred.weekday ?? 2)}
          style={{ padding: 9, width: "100%" }}
        >
          {WEEKDAYS.map((day) => (
            <option key={day.value} value={day.value}>
              {day.label}
            </option>
          ))}
        </select>

        <label htmlFor="startTime">开始时间</label>
        <input
          id="startTime"
          name="startTime"
          type="time"
          step={60}
          required
          defaultValue={first.startTime}
        />

        <label htmlFor="endTime">结束时间</label>
        <input
          id="endTime"
          name="endTime"
          type="time"
          step={60}
          required
          defaultValue={first.endTime}
        />
        <p className="muted">
          结束时间早于开始时间表示跨零点（例如 23:00–07:00 的睡眠）。
        </p>

        <button type="submit">保存修改</button>
      </form>

      <p className="muted" style={{ marginTop: 24 }}>
        <Link href="/onboarding">← 回到我的情况</Link>
      </p>
    </main>
  );
}
