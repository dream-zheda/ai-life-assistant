import Link from "next/link";
import { clearModelConfigAction, deleteAccountAction, saveSettingsAction } from "../actions";
import { SubmitButton } from "../../components/submit-button";
import { modelConfigSummary } from "../../server/model-config";
import { loadUserSettings } from "../../server/settings";
import { getCurrentUser } from "../../server/session";
import { SignOutButton } from "../sign-out-button";
export const dynamic = "force-dynamic";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
export default async function SettingsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const [settings, model] = await Promise.all([
    loadUserSettings(user.id),
    modelConfigSummary(user.id),
  ]);
  const error = first(params.error);
  const message = first(params.msg);
  return (
    <main>
      <header className="page-heading">
        <div>
          <p className="eyebrow">MAKE ROOM FOR YOUR OWN RHYTHM</p>
          <h1>偏好设置</h1>
          <p className="sub">让助手在合适的时间出现，也给你不被打扰的空间。</p>
        </div>
      </header>
      {error && (
        <p className="danger" role="alert">
          {error}
        </p>
      )}
      {params.saved && (
        <p className="notice" role="status">
          设置已保存。
        </p>
      )}
      {message && <p className={params.test === "ok" ? "notice" : "danger"}>{message}</p>}
      <div className="dashboard-grid">
        <div>
          <form action={saveSettingsAction} className="card">
            <h2>提醒与免打扰</h2>
            <p className="muted">按你的本地时间执行 · {user.timeZone}</p>
            <div className="form-grid">
              <div>
                <label htmlFor="briefStartTime">每天几点发早报</label>
                <input
                  id="briefStartTime"
                  name="briefStartTime"
                  type="time"
                  step={60}
                  required
                  defaultValue={settings.briefStartTime}
                />
              </div>
              <div>
                <label htmlFor="reminderLeadMinutes">提前多少分钟提醒</label>
                <input
                  id="reminderLeadMinutes"
                  name="reminderLeadMinutes"
                  type="number"
                  required
                  min={1}
                  max={120}
                  defaultValue={settings.reminderLeadMinutes}
                />
              </div>
            </div>
            <div className="form-grid">
              <div>
                <label htmlFor="quietHoursStart">免打扰开始</label>
                <input
                  id="quietHoursStart"
                  name="quietHoursStart"
                  type="time"
                  defaultValue={settings.quietHoursStart ?? ""}
                />
              </div>
              <div>
                <label htmlFor="quietHoursEnd">免打扰结束</label>
                <input
                  id="quietHoursEnd"
                  name="quietHoursEnd"
                  type="time"
                  defaultValue={settings.quietHoursEnd ?? ""}
                />
              </div>
            </div>
            <p className="field-hint">例如 23:00 到 07:00。两项都留空表示不设置，支持跨夜。</p>
            <label htmlFor="maxRemindersPerDay">每天最多几条主动提醒</label>
            <input
              id="maxRemindersPerDay"
              name="maxRemindersPerDay"
              type="number"
              required
              min={0}
              max={50}
              defaultValue={settings.maxRemindersPerDay}
            />
            <p className="field-hint">达到上限后，后续提醒会跳过并记录，不再补发。</p>
            <label
              className="notice"
              style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 20 }}
            >
              <input
                name="remindersPaused"
                type="checkbox"
                defaultChecked={settings.remindersPaused}
              />
              暂停所有提醒，保留我的计划
            </label>
            <SubmitButton>保存设置</SubmitButton>
          </form>
          <section className="card">
            <h2>我的数据</h2>
            <p className="muted">
              下载个人档案、目标、计划、进度与提醒记录。导出文件不包含密码、会话令牌或模型密钥。
            </p>
            <a className="btn secondary" href="/api/export">
              下载我的数据（JSON）
            </a>
          </section>
          <details className="card danger-zone">
            <summary>账号删除</summary>
            <p className="muted" style={{ marginTop: 16 }}>
              删除后，个人档案、计划和相关记录无法恢复。备份副本保留至备份过期，最长 14
              天。建议先导出数据。
            </p>
            <form action={deleteAccountAction}>
              <label htmlFor="confirm">输入「删除我的账号」以确认</label>
              <input
                id="confirm"
                name="confirm"
                required
                placeholder="删除我的账号"
                autoComplete="off"
              />
              <SubmitButton className="danger-action" pendingLabel="正在删除…">
                永久删除我的账号
              </SubmitButton>
            </form>
          </details>
        </div>
        <aside>
          <section className="card">
            <h2>当前账号</h2>
            <p style={{ overflowWrap: "anywhere" }}>{user.email}</p>
            <p className="muted">时区 · {user.timeZone}</p>
            <SignOutButton />
          </section>
          <section className="card">
            <h2>AI 模型</h2>
            <p className="muted">
              {model ? `${model.modelId} · ${model.hint}` : "还没有保存个人模型配置"}
            </p>
            <Link href="/setup/model">管理模型与测试连接 →</Link>
            {model && (
              <details style={{ marginTop: 20 }}>
                <summary>移除个人模型配置</summary>
                <form action={clearModelConfigAction}>
                  <p className="field-hint">
                    移除后将使用服务器默认配置（如有）。已保存的计划会保留。
                  </p>
                  <SubmitButton className="secondary">确认清除配置</SubmitButton>
                </form>
              </details>
            )}
          </section>
          <section className="card">
            <h2>提醒通道</h2>
            <p className="muted">站内提醒随时可查看，外部通道可单独配置。</p>
            <Link href="/connect">查看通道设置 →</Link>
          </section>
          <Link href="/privacy" className="muted">
            隐私说明 ↗
          </Link>
        </aside>
      </div>
    </main>
  );
}
