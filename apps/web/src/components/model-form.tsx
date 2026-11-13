"use client";
import { useState } from "react";
import { saveModelConfigAction, testModelAction } from "../app/actions";
import { SubmitButton } from "./submit-button";

type Preset = { id: string; label: string; baseUrl: string; modelId: string };
type Summary = { providerId: string; baseUrl: string; modelId: string; hint: string };
export function ModelForm({
  presets,
  model,
  back = "/setup/model",
}: {
  presets: Preset[];
  model: Summary | null;
  back?: string;
}) {
  const [provider, setProvider] = useState(model?.providerId ?? "deepseek");
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? presets[0]?.baseUrl ?? "");
  const [modelId, setModelId] = useState(model?.modelId ?? presets[0]?.modelId ?? "");
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const changed = Boolean(
    model &&
      (provider !== model.providerId ||
        baseUrl.replace(/\/+$/, "") !== model.baseUrl.replace(/\/+$/, "")),
  );
  return (
    <form action={saveModelConfigAction}>
      <input type="hidden" name="next" value={back} />
      <label htmlFor="providerId">模型服务商</label>
      <select
        id="providerId"
        name="providerId"
        value={provider}
        onChange={(event) => {
          const selected = presets.find((item) => item.id === event.target.value);
          setProvider(event.target.value);
          setBaseUrl(selected?.baseUrl ?? "");
          setModelId(selected?.modelId ?? "");
          setKey("");
        }}
      >
        {presets.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {preset.label}
          </option>
        ))}
      </select>
      <div className="form-grid">
        <div>
          <label htmlFor="baseUrl">接口地址</label>
          <input
            id="baseUrl"
            name="baseUrl"
            type="url"
            required
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://服务商地址/v1"
          />
        </div>
        <div>
          <label htmlFor="modelId">模型名称</label>
          <input
            id="modelId"
            name="modelId"
            required
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            placeholder="服务商提供的模型 ID"
          />
        </div>
      </div>
      <label htmlFor="apiKey">API Key {model && !changed ? "（留空保留已有密钥）" : ""}</label>
      <div className="password-field">
        <input
          id="apiKey"
          name="apiKey"
          type={visible ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder={model && !changed ? `已保存 ${model.hint}` : "粘贴对应服务商的 API Key"}
          required={!model || changed}
        />
        <button
          type="button"
          className="secondary"
          aria-pressed={visible}
          onClick={() => setVisible(!visible)}
        >
          {visible ? "隐藏" : "显示"}
        </button>
      </div>
      {changed && (
        <p className="field-hint">接口或服务商已变更，请填写对应密钥；不会沿用旧服务商的密钥。</p>
      )}
      <p className="field-hint">
        密钥加密保存，已有密钥不会回传到浏览器。测试连接会发起一次小额模型请求，测试成功后仍需保存。
      </p>
      <div className="form-footer">
        <SubmitButton pendingLabel="正在处理…">保存模型配置</SubmitButton>
        <SubmitButton formAction={testModelAction} className="secondary" pendingLabel="正在处理…">
          测试连接
        </SubmitButton>
      </div>
    </form>
  );
}
