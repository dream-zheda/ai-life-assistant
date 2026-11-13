"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { prisma } from "../server/db";
import {
  ConstraintNotFoundError,
  deleteConstraintById,
  deleteConstraintGroup,
  updateConstraintGroup,
} from "../server/constraints";
import { createInvite } from "../server/invites";
import { revokeInvite } from "../server/invite-admin";
import {
  clearModelConfig,
  loadModelConfig,
  ModelConfigError,
  PROVIDER_PRESETS,
  resolveModelInput,
  saveModelConfig,
  testModelConfig,
  type ProviderId,
} from "../server/model-config";
import { generateTodayPlan } from "../server/planning";
import { activatePlanVersion } from "../server/plan-activation";
import { parseSettingsForm, saveUserSettings, SettingsError } from "../server/settings";
import { getCurrentUser, requireAdmin } from "../server/session";
import { recordProgress } from "../server/progress";
import { saveGoal } from "../server/goals";
import { savePersonalSituation } from "../server/onboarding";

/**
 * 服务端动作。
 *
 * 刻意不用 API route：页面与写操作同仓同文件，P1 阶段更少样板。
 * 所有动作都从服务端会话取 userId —— 不接受表单传入的 userId。
 */

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

export async function saveOnboarding(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  try {
    await savePersonalSituation(user.id, user.timeZone, formData);
  } catch (error) {
    redirect(
      `/onboarding?error=${encodeURIComponent(error instanceof Error ? error.message : "保存失败")}`,
    );
  }
  revalidatePath("/today");
  revalidatePath("/goals");
  revalidatePath("/onboarding");
  redirect("/onboarding?saved=1");
}

export async function updateConstraintAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const groupId = text(formData, "groupId");
  if (groupId.length === 0) redirect("/onboarding?error=缺少分组 ID");

  const repeatValues = ["daily", "weekdays", "weekends", "weekly"] as const;
  const repeat = repeatValues.find((value) => value === text(formData, "repeat"));

  if (repeat === undefined) {
    redirect("/onboarding?error=重复方式不合法");
  }

  try {
    await updateConstraintGroup({
      userId: user.id,
      timeZone: user.timeZone,
      groupId,
      draft: {
        title: text(formData, "title"),
        startTime: text(formData, "startTime"),
        endTime: text(formData, "endTime"),
        repeat,
        ...(repeat === "weekly" ? { weekday: Number.parseInt(text(formData, "weekday"), 10) } : {}),
      },
    });
  } catch (error) {
    const message =
      error instanceof ConstraintNotFoundError
        ? "这组安排不存在或不属于你"
        : error instanceof Error
          ? error.message
          : "保存失败";
    redirect(`/constraints/${encodeURIComponent(groupId)}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/onboarding");
  revalidatePath("/today");
  redirect("/onboarding?saved=1");
}

export async function deleteConstraintAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const groupId = text(formData, "groupId");
  const constraintId = text(formData, "constraintId");

  if (groupId.length > 0) {
    await deleteConstraintGroup(user.id, groupId);
  } else if (constraintId.length > 0) {
    await deleteConstraintById(user.id, constraintId);
  }

  revalidatePath("/onboarding");
  revalidatePath("/today");
  redirect("/onboarding?deleted=1");
}

export async function saveSettingsAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();

  try {
    const input = parseSettingsForm(formData);
    await saveUserSettings(user.id, input);
  } catch (error) {
    const message = error instanceof SettingsError ? error.message : "设置保存失败";
    redirect(`/settings?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/settings");
  revalidatePath("/today");
  redirect("/settings?saved=1");
}

export async function deleteAccountAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const confirm = text(formData, "confirm");

  // 危险操作要求逐字确认，防止误点
  if (confirm !== "删除我的账号") {
    redirect(`/settings?error=${encodeURIComponent("请在下框输入「删除我的账号」以确认")}`);
  }

  // 级联删除：计划、条目、进度、记忆、会话、提醒、绑定、设置都会一起消失
  await prisma.user.delete({ where: { id: user.id } });

  redirect("/sign-in?deleted=1");
}

export async function createInviteAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const email = text(formData, "email");
  const hoursRaw = Number.parseInt(text(formData, "expiresInHours"), 10);
  const expiresInHours = Number.isFinite(hoursRaw) ? Math.min(720, Math.max(1, hoursRaw)) : 72;

  let token: string;
  try {
    const created = await createInvite({
      createdByEmail: admin.email,
      expiresInHours,
      ...(email.length === 0 ? {} : { email }),
    });

    token = created.token;
  } catch (error) {
    const message = error instanceof Error ? error.message : "创建邀请码失败";
    redirect(`/admin/invites?error=${encodeURIComponent(message)}`);
  }
  revalidatePath("/admin/invites");
  // redirect 通过抛异常实现，必须放在 catch 外，避免成功被误判为失败。
  redirect(`/admin/invites?created=${encodeURIComponent(token)}`);
}

export async function revokeInviteAction(formData: FormData): Promise<void> {
  await requireAdmin();
  const id = text(formData, "inviteId");
  if (id.length === 0) redirect("/admin/invites?error=缺少邀请码 ID");

  const result = await revokeInvite(id);
  revalidatePath("/admin/invites");

  if (result.ok) redirect("/admin/invites?revoked=1");

  const message =
    result.reason === "used"
      ? "已使用的邀请码不能撤销（它是审计记录）"
      : result.reason === "expired"
        ? "已过期的邀请码无需撤销"
        : "邀请码不存在";
  redirect(`/admin/invites?error=${encodeURIComponent(message)}`);
}

export async function activatePlanAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const planVersionId = text(formData, "planVersionId");
  if (planVersionId.length === 0) redirect("/today?error=缺少计划版本");

  const result = await activatePlanVersion({ userId: user.id, planVersionId });

  revalidatePath("/today");

  if (!result.ok) {
    const message =
      result.reason === "empty"
        ? "这份计划是空的（还没有排任何安排）。通常是还没接入模型，先去「接入模型」填 API Key，再重新生成。"
        : result.reason === "expired"
          ? "这份计划里的安排都已经结束了，没法采纳。请重新生成一份。"
          : result.reason === "already_active"
            ? "这份计划已经在执行中。"
            : result.reason === "superseded"
              ? "这份计划已被新版本替代。"
              : "计划不存在或不属于你。";
    redirect(`/today?error=${encodeURIComponent(message)}`);
  }

  const params = new URLSearchParams({ activated: "1", dropped: String(result.droppedCount) });
  redirect(`/today?${params.toString()}`);
}

function parseProvider(raw: string): ProviderId {
  return raw === "deepseek" || raw === "openai" || raw === "custom" ? raw : "deepseek";
}

/** 从哪个页面提交就回到哪个页面（只允许白名单，避免开放跳转）。 */
function returnTo(formData: FormData): string {
  const next = text(formData, "next");
  if (next === "/onboarding") return "/onboarding";
  if (next === "/setup/model") return "/setup/model";
  return "/settings";
}

export async function saveModelConfigAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const back = returnTo(formData);

  const providerId = parseProvider(text(formData, "providerId"));
  const preset = PROVIDER_PRESETS[providerId];
  const baseUrl = text(formData, "baseUrl").trim() || preset.baseUrl;
  const modelId = text(formData, "modelId").trim() || preset.modelId;
  const typedKey = text(formData, "apiKey").trim();

  try {
    const config = resolveModelInput(
      { providerId, baseUrl, modelId, apiKey: typedKey },
      await loadModelConfig(user.id),
    );
    await saveModelConfig(user.id, config);
  } catch (error) {
    const message = error instanceof ModelConfigError ? error.message : "保存失败";
    redirect(`${back}?error=${encodeURIComponent(message)}`);
  }

  revalidatePath("/settings");
  revalidatePath("/setup/model");
  revalidatePath("/onboarding");
  revalidatePath("/today");
  redirect(`${back}?saved=model`);
}

export async function testModelAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const back = returnTo(formData);

  const providerId = parseProvider(text(formData, "providerId"));
  const preset = PROVIDER_PRESETS[providerId];
  const baseUrl = text(formData, "baseUrl").trim() || preset.baseUrl;
  const modelId = text(formData, "modelId").trim() || preset.modelId;
  const typedKey = text(formData, "apiKey").trim();

  let config;
  try {
    config = resolveModelInput(
      { providerId, baseUrl, modelId, apiKey: typedKey },
      await loadModelConfig(user.id),
    );
  } catch (error) {
    redirect(
      `${back}?error=${encodeURIComponent(error instanceof ModelConfigError ? error.message : "请检查模型配置")}`,
    );
  }
  const result = await testModelConfig(config);

  if (result.ok) {
    redirect(`${back}?test=ok&msg=${encodeURIComponent(`连通，模型返回：${result.model}`)}`);
  }
  redirect(`${back}?test=fail&msg=${encodeURIComponent(result.message)}`);
}

export async function clearModelConfigAction(): Promise<void> {
  const user = await getCurrentUser();
  await clearModelConfig(user.id);
  revalidatePath("/settings");
  revalidatePath("/today");
  redirect("/settings?saved=model");
}

export async function generatePlanAction(): Promise<void> {
  const user = await getCurrentUser();
  let result;
  try {
    result = await generateTodayPlan(user.id, user.timeZone);
  } catch {
    redirect(
      `/today?generated=0&error=${encodeURIComponent("生成暂时失败，请检查模型连接后重试。当前生效计划未更改。")}`,
    );
  }

  revalidatePath("/today");

  const params = new URLSearchParams({
    generated: result.ok ? "1" : "0",
    mode: result.mode,
    items: String(result.itemCount),
  });
  if (!result.ok)
    params.set("error", result.failureReason ?? "没有生成可用计划，请检查模型配置或补充个人情况。");
  redirect(`/today?${params.toString()}`);
}

export async function submitProgress(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  const planItemId = text(formData, "planItemId");
  const ratioText = text(formData, "ratio");
  if (!planItemId || !ratioText) redirect("/today?error=请提供完整的进度信息");
  try {
    await recordProgress(user.id, planItemId, Number(ratioText));
  } catch (error) {
    redirect(
      `/today?error=${encodeURIComponent(error instanceof Error ? error.message : "进度保存失败")}`,
    );
  }

  revalidatePath("/today");
  redirect("/today?saved=1");
}

export async function saveGoalAction(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  try {
    await saveGoal(user.id, {
      id: text(formData, "id"),
      title: text(formData, "title"),
      description: text(formData, "description"),
      priority: Number(text(formData, "priority")),
      state: text(formData, "state"),
      targetDate: text(formData, "targetDate"),
    });
  } catch (error) {
    redirect(
      `/goals?error=${encodeURIComponent(error instanceof Error ? error.message : "保存失败")}`,
    );
  }
  revalidatePath("/goals");
  revalidatePath("/onboarding");
  revalidatePath("/today");
  redirect("/goals?saved=1");
}
