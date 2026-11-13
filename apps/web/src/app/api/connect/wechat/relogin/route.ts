import { getOptionalUser } from "../../../../../server/session";
import { restartBridgeLogin } from "../../../../../server/wechat-connect";

/** 二维码过期或登录被拒之后，让桥接服务重新拉起登录流程。 */
export async function POST(): Promise<Response> {
  const user = await getOptionalUser();
  if (user === null) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const ok = await restartBridgeLogin();
  return Response.json({ ok }, { status: ok ? 200 : 502 });
}
