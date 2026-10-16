/**
 * 统一错误类型定义
 */

export interface APIError extends Error {
  status?: number;
  code?: string;
}

/**
 * 将错误转换为 SSE 错误数据格式
 */
export function errorToSSE(code: string, message: string): string {
  return `data: ${JSON.stringify({ error: { code, message } })}\n\n`;
}

/**
 * 业务错误码定义
 */
export const ERROR_CODES = {
  // 客户端错误
  INVALID_BODY: "INVALID_BODY",
  INVALID_MESSAGES: "INVALID_MESSAGES",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  INVALID_ROLE: "INVALID_ROLE",

  // 服务端错误
  MISSING_API_KEY: "MISSING_API_KEY",
  INVALID_API_KEY: "INVALID_API_KEY",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  MODEL_ERROR: "MODEL_ERROR",
  MODEL_SERVER_ERROR: "MODEL_SERVER_ERROR",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  INVALID_REQUEST: "INVALID_REQUEST",
} as const;
