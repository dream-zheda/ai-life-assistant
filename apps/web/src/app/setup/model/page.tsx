import Link from "next/link";
import { ModelForm } from "../../../components/model-form";
import { modelConfigSummary, PROVIDER_PRESETS } from "../../../server/model-config";
import { getCurrentUser } from "../../../server/session";
export const dynamic = "force-dynamic";
type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
export default async function ModelSetupPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const user = await getCurrentUser();
  const model = await modelConfigSummary(user.id);
  const error = first(params.error);
  const message = first(params.msg);
  return (
    <main>
      <header className="page-heading">
        <div>
          <p className="eyebrow">YOUR ASSISTANT'S THINKING PARTNER</p>
          <h1>模型配置</h1>
          <p className="sub">选择适合你的模型，让它理解你的生活、帮你规划每一天。</p>
        </div>
      </header>
      {error && (
        <p className="danger" role="alert">
          {error}
        </p>
      )}
      {params.saved && (
        <p className="notice" role="status">
          模型配置已保存，可以回到今天生成计划。
        </p>
      )}
      {message && (
        <p
          role={params.test === "fail" ? "alert" : "status"}
          className={params.test === "ok" ? "notice" : "danger"}
        >
          {message}
        </p>
      )}
      <div className="dashboard-grid">
        <section className="card">
          <div className="row">
            <h2 style={{ margin: 0 }}>连接你的模型</h2>
            <span className={`tag${model ? " ok" : ""}`}>{model ? "已保存配置" : "尚未配置"}</span>
          </div>
          <ModelForm
            presets={Object.entries(PROVIDER_PRESETS).map(([id, value]) => ({ id, ...value }))}
            model={
              model
                ? {
                    providerId: model.providerId,
                    baseUrl: model.baseUrl,
                    modelId: model.modelId,
                    hint: model.hint,
                  }
                : null
            }
          />
        </section>
        <aside>
          <section className="card">
            <h2>如何开始</h2>
            <ol style={{ paddingLeft: 20 }}>
              <li>在模型服务商后台创建 API Key。</li>
              <li>选择服务商，确认接口与模型名称。</li>
              <li>测试连接，再保存配置。</li>
            </ol>
            <p className="muted">
              自定义选项可连接支持 OpenAI 兼容协议的服务。具体模型名称请以服务商说明为准。
            </p>
          </section>
          <section className="card">
            <h2>换模型，记忆还在</h2>
            <p className="muted">切换模型会影响后续生成；你的个人情况、目标和已有计划仍然保留。</p>
            <Link href="/today">回到今天 →</Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
