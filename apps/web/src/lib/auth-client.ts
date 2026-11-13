import { createAuthClient } from "better-auth/react";

/**
 * 浏览器侧客户端。默认以当前站点为 baseURL，走 /api/auth/*。
 */
export const authClient = createAuthClient();
