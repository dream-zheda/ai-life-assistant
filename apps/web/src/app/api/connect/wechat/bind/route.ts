import { bindCurrentBridgeAccount } from "../../../../../server/wechat-connect";
import { getOptionalUser } from "../../../../../server/session";

/**
 * 绑定：服务端自己去读桥接状态，**不接受前端传来的 wxid**。
 * 否则用户可以把自己名下的绑定改成任意别人的账号，等于冒充收消息。
 */
export async function POST(): Promise<Response> {
  const user = await getOptionalUser();
  if (user === null) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const result = await bindCurrentBridgeAccount(user.id);
  if (!result.ok) {
    return Response.json({ error: result.reason }, { status: 409 });
  }

  return Response.json({ ok: true });
}
