import { exportUserData } from "../../../server/export";
import { getOptionalUser } from "../../../server/session";

/**
 * 个人数据导出接口。
 *
 * 未登录返回 401；登录后返回该用户自己的 JSON 快照。
 * 不导出密码哈希、会话 token、OAuth 凭据（见 server/export.ts 的说明）。
 */
export async function GET(): Promise<Response> {
  const user = await getOptionalUser();
  if (user === null) {
    return new Response(JSON.stringify({ error: "未登录" }), {
      status: 401,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  const payload = await exportUserData(user.id);
  const filename = `life-assistant-export-${payload.exportedAt.slice(0, 10)}.json`;

  return new Response(JSON.stringify(payload, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      // 导出内容包含个人数据，禁止任何中间层缓存
      "cache-control": "no-store",
    },
  });
}
