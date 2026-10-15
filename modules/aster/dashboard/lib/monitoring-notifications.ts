import type { NotificationType } from './desk-types';

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
    title: '最大杠杆额度 > 0',
    description: '最大杠杆的公开可用额度大于零时提醒，持续有额度不重复。',
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
