import { loadBinding, loadConnectState } from "../../../../../server/wechat-connect";
import { getOptionalUser } from "../../../../../server/session";

/** 扫码状态轮询接口。未登录一律 401，不泄露任何绑定信息。 */
export async function GET(): Promise<Response> {
  const user = await getOptionalUser();
  if (user === null) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const [state, binding] = await Promise.all([loadConnectState(), loadBinding(user.id)]);
  return Response.json(
    { state, binding },
    { headers: { "cache-control": "no-store" } },
  );
}
