/**
 * 通道策略与「主动推送窗口」。
 *
 * 背景（P0 核验结论，见 docs/P0-仓库核验记录.md §4.1）：
 * 不同微信通道对「能不能主动推送」的规则完全不同，所以这件事不能等发送失败再补救，
 * 必须在数据模型里表达。本模块把它做成纯函数，与具体通道实现解耦。
 */

export type ChannelId =
  | "personal-wechat"
  | "wechat-personal-protocol"
  | "qq-onebot"
  | "official-account-subscription"
  | "official-account-service"
  | "wecom-app"
  | "wecom-kf";

export type ChannelPolicy = {
  id: ChannelId;
  label: string;
  /**
   * 用户最后一条入站消息之后，允许主动推送的时长（毫秒）。
   * null 表示平台不限制主动推送。
   */
  proactiveWindowMs: number | null;
  /** 是否需要对方先关注/加入通讯录，才能收到消息。 */
  requiresRecipientOptIn: boolean;
  /** 无法主动推送时是否需要降级到其他渠道。 */
  needsFallback: boolean;
  notes: string;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * 已核验的通道策略。
 *
 * 只有 official-account-service 的「可随时主动推送」在 CowAgent 文档中被明确写出；
 * 其余标 wait-verified 的条目在 P0 记录里仍是「文档未明确 / 待实测」。
 */
export const CHANNEL_POLICIES: Record<ChannelId, ChannelPolicy> = {
  "personal-wechat": {
    id: "personal-wechat",
    label: "个人微信（扫码登录，走腾讯官方接口）",
    // 24 小时窗口来自 CowAgent 文档明确说明；AstrBot/weclaws 文档未提，按更严的一侧设计。
    // ⚠️ 这个数字本身未经我们实测，见 ADR-002「待复核」一节。
    proactiveWindowMs: DAY,
    requiresRecipientOptIn: false,
    needsFallback: true,
    notes: "超窗口后定时推送会失败，直到用户再发一条消息。风险最高的通道。",
  },
  "wechat-personal-protocol": {
    id: "wechat-personal-protocol",
    label: "个人微信（用户自备账号，协议登录）",
    // AI 是这个账号的好友，发消息就是普通聊天，没有平台窗口
    proactiveWindowMs: null,
    requiresRecipientOptIn: true,
    needsFallback: true,
    notes:
      "能随时推送，但它违反《微信个人账号使用规范》1.2.6（第三方登录），" +
      "账号可能被限制功能直至永久封禁。必须配降级通道。见 ADR-009。",
  },
  "qq-onebot": {
    id: "qq-onebot",
    label: "QQ（NapCat / OneBot 11）",
    // 以好友身份发消息，没有平台窗口限制
    proactiveWindowMs: null,
    requiresRecipientOptIn: true,
    needsFallback: true,
    notes:
      "技术上比微信网页协议可靠（NapCat 挂在 QQNT 上，社区仍在维护），" +
      "但同样属于协议登录、违反 QQ 用户协议，账号可能被封。建议用小号。",
  },
  "official-account-subscription": {
    id: "official-account-subscription",
    label: "个人订阅号",
    // 完全不能主动推，等价于窗口长度为 0
    proactiveWindowMs: 0,
    requiresRecipientOptIn: true,
    needsFallback: true,
    notes: "只能先回占位消息，等用户再发一条才取回内容。不适合做提醒通道。",
  },
  "official-account-service": {
    id: "official-account-service",
    label: "认证企业服务号（需客服 API 权限）",
    proactiveWindowMs: null,
    requiresRecipientOptIn: true,
    needsFallback: false,
    notes: "文档中唯一被明确写为可主动推送的微信路径。需企业主体 + 微信认证。",
  },
  "wecom-app": {
    id: "wecom-app",
    label: "企业微信自建应用",
    proactiveWindowMs: null,
    requiresRecipientOptIn: true,
    needsFallback: false,
    notes: "可主动推送，但收件人必须是企业通讯录成员（未认证默认 200 人上限）。待实测配额。",
  },
  "wecom-kf": {
    id: "wecom-kf",
    label: "微信客服",
    proactiveWindowMs: null,
    requiresRecipientOptIn: false,
    needsFallback: false,
    notes: "主动推送配额与窗口需实测，P0 未核实。",
  },
};

export function getChannelPolicy(id: ChannelId): ChannelPolicy {
  return CHANNEL_POLICIES[id];
}

export type DeliveryWindow =
  | { kind: "unrestricted" }
  | { kind: "open"; expiresAt: Date }
  | { kind: "closed"; reason: "never_contacted" | "window_expired" };

/**
 * 计算当前是否可以主动推送。
 *
 * @param policy 通道策略
 * @param lastInboundAt 该用户在本通道上最后一次给我们发消息的时间；null 表示从未发过
 * @param now 当前时间
 */
export function evaluateDeliveryWindow(
  policy: ChannelPolicy,
  lastInboundAt: Date | null,
  now: Date,
): DeliveryWindow {
  if (policy.proactiveWindowMs === null) {
    return { kind: "unrestricted" };
  }

  if (lastInboundAt === null) {
    return { kind: "closed", reason: "never_contacted" };
  }

  const expiresAt = new Date(lastInboundAt.getTime() + policy.proactiveWindowMs);
  if (now.getTime() >= expiresAt.getTime()) {
    return { kind: "closed", reason: "window_expired" };
  }

  return { kind: "open", expiresAt };
}

export type DeliveryDecision =
  | { action: "send"; expiresAt: Date | null }
  | { action: "fallback"; reason: "never_contacted" | "window_expired"; hint: string };

/**
 * 决定一条「主动提醒」该怎么发。
 *
 * 这是产品最关键的一处判断：窗口关闭时不能假装发得出去。
 * 早报在窗口关闭时只有两条路——降级到其他渠道，或放弃并告知用户。
 */
export function decideProactiveDelivery(
  policy: ChannelPolicy,
  lastInboundAt: Date | null,
  now: Date,
): DeliveryDecision {
  const window = evaluateDeliveryWindow(policy, lastInboundAt, now);

  if (window.kind === "unrestricted") {
    return { action: "send", expiresAt: null };
  }

  if (window.kind === "open") {
    return { action: "send", expiresAt: window.expiresAt };
  }

  const hint =
    window.reason === "never_contacted"
      ? "用户还没有在微信上给助手发过消息，无法主动推送；需要先引导用户发一条消息"
      : "已超过平台允许的主动推送窗口，需要用户主动发一条消息才能恢复";

  return { action: "fallback", reason: window.reason, hint };
}
