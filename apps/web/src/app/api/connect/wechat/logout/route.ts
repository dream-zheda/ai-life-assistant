import { disconnectWechat } from "../../../../../server/wechat-connect";
import { getOptionalUser } from "../../../../../server/session";

export async function POST(): Promise<Response> {
  const user = await getOptionalUser();
  if (user === null) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const result = await disconnectWechat(user.id);
  return Response.json({ ok: true, bridgeLoggedOut: result.bridgeLoggedOut });
}
