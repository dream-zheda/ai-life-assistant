import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, hintOf } from "../src/server/crypto";
import { prisma } from "../src/server/db";
import { exportUserData } from "../src/server/export";
import {
  clearModelConfig,
  loadModelConfig,
  looksLikeWrongSecret,
  ModelConfigError,
  modelConfigSummary,
  saveModelConfig,
  testModelConfig,
  validateModelInput,
} from "../src/server/model-config";

/**
 * 模型凭据的加密存储与读取。
 *
 * 这一组的核心不是"能存"，而是"存进去以后拿不出来"：
 * 数据库副本、导出的 JSON、界面摘要，都不能包含明文 Key。
 */

const USER = "int-model-config-user";
const SECRET = "test-better-auth-secret-for-crypto";
const PLAINTEXT_KEY = "sk-very-secret-key-should-never-leak-1234";

beforeAll(async () => {
  process.env["BETTER_AUTH_SECRET"] = SECRET;
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.user.create({ data: { id: USER, email: "model@int.test", timeZone: "Asia/Shanghai" } });
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.$disconnect();
});

describe("crypto", () => {
  it("加密后可解回原文", () => {
    const cipher = encryptSecret("hello-key");
    expect(cipher).not.toContain("hello-key");
    expect(decryptSecret(cipher)).toBe("hello-key");
  });

  it("同一明文两次加密结果不同（IV 随机）", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("换密钥后解不开，返回 null 而不是抛错", () => {
    const cipher = encryptSecret("k");
    process.env["BETTER_AUTH_SECRET"] = "another-secret";
    expect(decryptSecret(cipher)).toBeNull();
    process.env["BETTER_AUTH_SECRET"] = SECRET;
  });

  it("被篡改的密文解不开", () => {
    const cipher = encryptSecret("k");
    const bytes = Buffer.from(cipher, "base64");
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    expect(decryptSecret(bytes.toString("base64"))).toBeNull();
  });

  it("只显示末四位", () => {
    expect(hintOf("sk-abcdefgh1234")).toBe("••••1234");
    expect(hintOf("ab")).toBe("••••");
  });
});

describe("模型配置", () => {
  it("保存后可读回明文，但摘要里只有末四位", async () => {
    await saveModelConfig(USER, {
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      apiKey: PLAINTEXT_KEY,
    });

    const loaded = await loadModelConfig(USER);
    expect(loaded?.apiKey).toBe(PLAINTEXT_KEY);

    const summary = await modelConfigSummary(USER);
    expect(summary?.hint).toBe("••••1234");
    expect(JSON.stringify(summary)).not.toContain(PLAINTEXT_KEY);
  });

  it("库里存的是密文，不是明文", async () => {
    const row = await prisma.userSettings.findUniqueOrThrow({ where: { userId: USER } });
    expect(row.llmApiKeyCipher).not.toBeNull();
    expect(row.llmApiKeyCipher).not.toContain(PLAINTEXT_KEY);
    expect(JSON.stringify(row)).not.toContain(PLAINTEXT_KEY);
  });

  it("导出的个人数据里不含 Key（明文或密文都不该出现）", async () => {
    const payload = await exportUserData(USER);
    const json = JSON.stringify(payload);

    expect(json).not.toContain(PLAINTEXT_KEY);
    expect(json).not.toContain("llmApiKeyCipher");
    expect(json).not.toContain("llmApiKeyHint");
  });

  it("清除后读回为 null", async () => {
    await clearModelConfig(USER);
    expect(await loadModelConfig(USER)).toBeNull();
    expect(await modelConfigSummary(USER)).toBeNull();
  });

  it("校验拦住明显的填错", () => {
    expect(() =>
      validateModelInput({ baseUrl: "api.deepseek.com", modelId: "x", apiKey: "sk-12345678" }),
    ).toThrow(ModelConfigError);

    expect(() =>
      validateModelInput({ baseUrl: "http://api.example.com", modelId: "x", apiKey: "sk-12345678" }),
    ).toThrow(/https/);

    expect(() =>
      validateModelInput({ baseUrl: "https://api.example.com", modelId: "  ", apiKey: "sk-12345678" }),
    ).toThrow(/模型名/);

    expect(() =>
      validateModelInput({ baseUrl: "https://api.example.com", modelId: "m", apiKey: "short" }),
    ).toThrow(/不完整/);

    // 本地地址允许 http（自建代理常见）
    expect(() =>
      validateModelInput({ baseUrl: "http://127.0.0.1:8080/v1", modelId: "m", apiKey: "sk-12345678" }),
    ).not.toThrow();
  });

  it("把网址或邮箱填进 Key 框时能识别出来（真实踩过的坑）", () => {
    // 用户实际填的：DeepSeek 官网地址。服务商只回 "Your api key: ****.com is invalid"
    expect(looksLikeWrongSecret("https://platform.deepseek.com")).toBe(true);
    expect(looksLikeWrongSecret("platform.deepseek.com")).toBe(true);
    expect(looksLikeWrongSecret("someone@example.com")).toBe(true);
    expect(looksLikeWrongSecret("sk abc def")).toBe(true);

    expect(looksLikeWrongSecret("sk-0123456789abcdef0123456789abcdef")).toBe(false);
    expect(looksLikeWrongSecret("sk-proj-AbC-123_456")).toBe(false);
  });

  it("填成网址时直接拒绝，不发请求", async () => {
    const result = await testModelConfig({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      apiKey: "https://platform.deepseek.com",
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("malformed");
    expect(result.ok === false && result.message).toContain("网址");
  });

  it("保存时也会拦住网址", () => {
    expect(() =>
      validateModelInput({
        baseUrl: "https://api.deepseek.com/v1",
        modelId: "deepseek-chat",
        apiKey: "https://platform.deepseek.com",
      }),
    ).toThrow(/网址/);
  });
});
