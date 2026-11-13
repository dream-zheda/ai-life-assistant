import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * 对称加密，用于存放用户自己的模型 API Key。
 *
 * 为什么必须加密：`llm_api_key_cipher` 一旦明文入库，任何能读备份或读库的人
 * 都能拿它去花用户的额度。加密后，光有数据库副本还不够，还得有进程密钥。
 *
 * 密钥来源：`BETTER_AUTH_SECRET`（用 scrypt 派生，加固定盐）。
 * 这意味着**换了 BETTER_AUTH_SECRET 就必须重新填一次 Key**——这是有意的取舍：
 * 宁可让用户重填，也不要为了"迁移方便"把密钥留在两个地方。
 */

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT = "life-assistant-llm-credential";

function deriveKey(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

function currentSecret(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret === undefined || secret.length === 0) {
    throw new Error("缺少 BETTER_AUTH_SECRET，无法加密模型凭据");
  }
  return secret;
}

/** 返回 base64(iv | tag | ciphertext)。 */
export function encryptSecret(plain: string): string {
  const key = deriveKey(currentSecret());
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

/** 解密失败返回 null（换了密钥、数据被改过、格式不对都在这里收口）。 */
export function decryptSecret(payload: string): string | null {
  try {
    const raw = Buffer.from(payload, "base64");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;

    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(ALGORITHM, deriveKey(currentSecret()), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    return null;
  }
}

/** 只保留末四位，用于界面显示"已配置 sk-…abcd"。 */
export function hintOf(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}
