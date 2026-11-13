import { createDecipheriv, scryptSync } from "node:crypto";
import { createOpenAiCompatibleAdapter, type LlmAdapter, type ModelRef } from "@life/llm";
import { prisma } from "./db";

function decryptSecret(payload: string): string | null {
  try {
    const raw = Buffer.from(payload, "base64");
    if (raw.length <= 28) return null;
    const secret = process.env.BETTER_AUTH_SECRET;
    if (!secret) return null;
    const decipher = createDecipheriv("aes-256-gcm", scryptSync(secret, "life-assistant-llm-credential", 32), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch { return null; }
}

export async function resolveUserChatModel(userId: string): Promise<{ adapter: LlmAdapter; ref: ModelRef } | null> {
  const settings = await prisma.userSettings.findUnique({ where: { userId }, select: {
    llmProvider: true, llmBaseUrl: true, llmModel: true, llmApiKeyCipher: true,
  } });
  if (!settings?.llmApiKeyCipher || !settings.llmBaseUrl || !settings.llmModel) return null;
  const apiKey = decryptSecret(settings.llmApiKeyCipher);
  if (!apiKey) return null;
  const providerId = settings.llmProvider ?? "custom";
  return {
    adapter: createOpenAiCompatibleAdapter({ providerId, baseUrl: settings.llmBaseUrl, apiKey }),
    ref: { providerId, modelId: settings.llmModel },
  };
}
