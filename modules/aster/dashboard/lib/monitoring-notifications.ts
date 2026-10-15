import type { ListingCapacityRule, NotificationType } from './desk-types';

export const notificationTypes: {
  key: NotificationType;
  title: string;
  description: string;
}[] = [
  {
    key: 'new_listing',
    title: '新币上线',
    description: '发现 USD1 永续上新时通知，缺失额度补齐后再通知一次。',
  },
  {
    key: 'listing_capacity',
    title: '公开额度达标',
    description: '所选杠杆的公开可用额度超过设定值时提醒，持续达标不重复。',
  },
  {
    key: 'strategy_capacity',
    title: '策略额度达标',
    description: '仅策略品种有效；5x / 10x / 20x 公开额度超过账户门槛时提醒。',
  },
  {
    key: 'trade_summary',
    title: '普通开仓成交汇总',
    description: '普通开仓结束后按币种汇总；循环与迁移只记录本地历史。',
  },
  {
    key: 'position_imbalance',
    title: '仓位不平衡',
    description: '实盘多空数量差持续超限时提醒，恢复稳定后通知一次。',
  },
];

export type CapacityRuleDraft = {
  mode: 'maximum' | 'fixed';
  leverage: string;
  threshold: string;
};

export function capacityRuleDraft(
  rule: ListingCapacityRule,
): CapacityRuleDraft {
  return {
    mode: rule.listing_capacity_leverage === null ? 'maximum' : 'fixed',
    leverage: String(rule.listing_capacity_leverage ?? 20),
    threshold: rule.listing_capacity_threshold,
  };
}

export function parseCapacityRuleDraft(
  draft: CapacityRuleDraft,
): { rule: ListingCapacityRule; error: null } | { rule: null; error: string } {
  const leverage = draft.mode === 'maximum' ? null : Number(draft.leverage);
  if (
    draft.mode !== 'maximum' &&
    (!/^\d+$/.test(draft.leverage.trim()) ||
      !Number.isInteger(leverage) ||
      leverage === null ||
      leverage < 1 ||
      leverage > 10000)
  ) {
    return { rule: null, error: '通知杠杆请输入 1–10000 的整数。' };
  }
  const threshold = draft.threshold.trim();
  const match = /^\+?(?:\d+(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(
    threshold,
  );
  // Keep the decimal text intact. Only its exponent is converted to a number;
  // comparing or serializing the amount as a JS number would lose precision.
  if (
    !match ||
    threshold.length > 128 ||
    Math.abs(Number(match[3] ?? 0) - (match[1] ?? match[2] ?? '').length) > 100
  ) {
    return {
      rule: null,
      error:
        '额度阈值请输入有效的非负金额，最多 128 字符，精度或指数不超过 100 位。',
    };
  }
  return {
    rule: {
      listing_capacity_leverage: leverage,
      listing_capacity_threshold: threshold,
    },
    error: null,
  };
}

export function capacityRuleLabel(rule: ListingCapacityRule) {
  const leverage =
    rule.listing_capacity_leverage === null
      ? '最大杠杆'
      : `${rule.listing_capacity_leverage}x`;
  return `${leverage} · 公开额度 > ${rule.listing_capacity_threshold} USD1`;
}

export function applicableNotificationTypes(
  selected: readonly NotificationType[],
  strategyMarket: boolean,
  canWatch = true,
  hasExistingWatch = false,
): NotificationType[] {
  return notificationTypes
    .filter(
      (type) =>
        selected.includes(type.key) &&
        (strategyMarket || type.key !== 'strategy_capacity') &&
        (canWatch || hasExistingWatch || type.key !== 'listing_capacity'),
    )
    .map((type) => type.key);
}
