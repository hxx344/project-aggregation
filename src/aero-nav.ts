// Aero 模块的标签：仓位、行情、配置。地址栏 ?view=aero&tab=…，旧链接 view=aero-safe / view=aero-market 仍可打开。
export type AeroTab = 'positions' | 'market' | 'config';
export const AERO_TABS: { id: AeroTab; label: string }[] = [{ id: 'positions', label: '仓位' }, { id: 'market', label: '行情' }, { id: 'config', label: '配置' }];

export function aeroTabOf(search: string): AeroTab {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  if (tab === 'positions' || tab === 'market' || tab === 'config') return tab;
  return params.get('view') === 'aero-market' || params.has('pool') ? 'market' : 'positions';
}

// 切换标签（App 与 Aero 页面监听 popstate）；池详情的 pool 参数只属于行情标签，切走时去掉。
export function openAeroTab(tab: AeroTab) {
  history.pushState(null, '', `${location.pathname}?view=aero&tab=${tab}`);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
