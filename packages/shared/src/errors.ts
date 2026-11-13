/**
 * 统一错误模型。
 *
 * 约定（规划书 §11）：JSON 错误必须带稳定错误码与可展示说明，
 * 调用方靠 code 分支，不解析 message。
 */

export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "VERSION_CONFLICT"
  | "RATE_LIMITED"
  | "QUOTA_EXCEEDED"
  | "LLM_INVALID_OUTPUT"
  | "LLM_UPSTREAM_FAILED"
  | "CHANNEL_NOT_CONFIGURED"
  | "CHANNEL_SEND_FAILED"
  | "INTERNAL";

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly retryable: boolean;

  constructor(
    code: AppErrorCode,
    message: string,
    options: {
      status?: number;
      details?: Record<string, unknown>;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.status = options.status ?? defaultStatus(code);
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }

  /** 可直接返回给客户端的形状（不泄露堆栈与内部细节）。 */
  toResponse(): { code: AppErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

function defaultStatus(code: AppErrorCode): number {
  switch (code) {
    case "UNAUTHENTICATED":
      return 401;
    case "FORBIDDEN":
      return 403;
    case "NOT_FOUND":
      return 404;
    case "VALIDATION_FAILED":
      return 422;
    case "VERSION_CONFLICT":
      return 409;
    case "RATE_LIMITED":
      return 429;
    case "QUOTA_EXCEEDED":
      return 429;
    case "CHANNEL_NOT_CONFIGURED":
      return 503;
    case "INTERNAL":
    case "LLM_INVALID_OUTPUT":
    case "LLM_UPSTREAM_FAILED":
    case "CHANNEL_SEND_FAILED":
      return 500;
    default:
      return 500;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** 把任意异常收敛成 AppError，保证边界层只处理一种错误类型。 */
export function toAppError(value: unknown): AppError {
  if (isAppError(value)) return value;
  if (value instanceof Error) {
    return new AppError("INTERNAL", value.message, { cause: value });
  }
  return new AppError("INTERNAL", "Unknown error", { cause: value });
}
