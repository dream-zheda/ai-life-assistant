"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { issueQqLinkCode, QqBindingError, unlinkQq } from "@life/db";
import { getCurrentUser } from "../../../server/session";
import { loadQqStatus } from "./qq-connect";

export type LinkCodeState = { code?: string; expiresAt?: string; error?: string };
export async function issueLinkCodeAction(_previous: LinkCodeState): Promise<LinkCodeState> {
  const user = await getCurrentUser();
  const status = await loadQqStatus();
  if (!status.configured || !status.reachable) return { error: "机器人暂未上线，请稍后再试。" };
  try { return await issueQqLinkCode(user.id, status.botUserId); }
  catch (error) { return { error: error instanceof QqBindingError ? error.message : "暂时无法领取绑定码，请稍后再试。" }; }
}

export async function unlinkQqAction(): Promise<void> {
  const user = await getCurrentUser();
  await unlinkQq(user.id);
  revalidatePath("/connect");
  revalidatePath("/connect/qq");
  redirect("/connect/qq?unlinked=1");
}
