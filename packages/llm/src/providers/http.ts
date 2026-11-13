import { AppError } from "@life/shared";

/** 读取错误响应体，截断后用于日志与排查；不把完整响应写进用户可见错误。 */
export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 500);
  } catch {
    return "";
  }
}

export function upstreamError(status: number, body: string, providerId: string): AppError {
  // 408 / 429 / 5xx 视为可重试；4xx 其余是请求本身的问题，重试无用
  const retryable = status === 408 || status === 429 || status >= 500;
  return new AppError("LLM_UPSTREAM_FAILED", `${providerId} 返回 HTTP ${status}`, {
    details: { status, body },
    retryable,
  });
}

export function networkError(error: unknown, providerId: string): AppError {
  const message = error instanceof Error ? error.message : String(error);
  return new AppError("LLM_UPSTREAM_FAILED", `${providerId} 请求失败：${message}`, {
    retryable: true,
    cause: error,
  });
}

export function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}
