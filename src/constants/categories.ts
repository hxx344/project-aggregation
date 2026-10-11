import type { Adapter, Category } from '../types';

export const categories: Record<Category, string> = {
  trading: '交易执行',
  monitoring: '市场监控',
  assets: '资产管理',
  other: '其他项目'
};

export const adapters: Record<Adapter, string> = {
  aster: 'Aster 交易工作台',
  monitor: 'Market Monitor',
  asset: '资产账本',
  standard: '标准概览接口',
  link: '仅网页入口'
};
