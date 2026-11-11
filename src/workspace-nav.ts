import type { Category } from './types';

// 主导航按统一平台方案第 2 节的工作区分组；只决定菜单归属，不改路由与数据来源。
export type WorkspaceId = 'overview' | 'market' | 'trading' | 'strategy' | 'options' | 'onchain' | 'research' | 'other';
export type NativeView = 'overview' | 'trading' | 'aero' | 'cost-lab';

export const workspaceOrder: readonly WorkspaceId[] = ['overview', 'market', 'trading', 'strategy', 'options', 'onchain', 'research', 'other'];

export const workspaceLabels: Record<WorkspaceId, string> = {
  overview: '总览与资产', market: '市场与机会', trading: '交易中心', strategy: '策略与风险',
  options: '期权', onchain: '链上', research: '研究室', other: '其他',
};

export const nativeViewWorkspace: Record<NativeView, WorkspaceId> = { overview: 'overview', trading: 'trading', aero: 'onchain', 'cost-lab': 'research' };

const builtinWorkspace: Readonly<Record<string, WorkspaceId>> = { asset: 'overview', monitor: 'market', crossex: 'trading', aster: 'strategy', greeks: 'options' };
const categoryWorkspace: Record<Category, WorkspaceId> = { assets: 'overview', monitoring: 'market', trading: 'trading', other: 'other' };

export function projectWorkspace(project: { id: string; category: Category }): WorkspaceId {
  return Object.hasOwn(builtinWorkspace, project.id) ? builtinWorkspace[project.id] : categoryWorkspace[project.category];
}

export type WorkspaceGroup<P> = { id: WorkspaceId; label: string; views: NativeView[]; projects: P[] };

// 原生页面在前、模块按传入顺序在后；没有任何入口的工作区不显示。
export function workspaceGroups<P extends { project: { id: string; category: Category } }>(items: readonly P[]): WorkspaceGroup<P>[] {
  const views = (Object.keys(nativeViewWorkspace) as NativeView[]);
  return workspaceOrder.map(id => ({
    id, label: workspaceLabels[id],
    views: views.filter(view => nativeViewWorkspace[view] === id),
    projects: items.filter(item => projectWorkspace(item.project) === id),
  })).filter(group => group.views.length || group.projects.length);
}
