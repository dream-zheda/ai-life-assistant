import { NextResponse } from "next/server";
import { getOptionalUser } from "../../../../../server/session";
import { loadQqBinding } from "../../../../connect/qq/qq-connect";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getOptionalUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  const binding = await loadQqBinding(user.id);
  return NextResponse.json(
    binding?.verified ? { verified: true, qqNumber: binding.qqNumber } : { verified: false },
    { headers: { "Cache-Control": "no-store" } },
  );
}
