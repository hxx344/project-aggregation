import type { Project, Snapshot } from './types';

export const statusText: Record<Snapshot['state'], string> = { unconfigured: '待配置', online: '已连接', stale: '数据过期', offline: '连接中断', unauthorized: '需要登录', disabled: '已停用', partial: '部分数据异常' };
export type Notice = { title: string; detail?: string; tone: 'success' | 'warning' | 'error' | 'info' };

export function checkNotice(project: Project, snapshot: Snapshot): Notice {
  const link = project.adapter === 'link' && snapshot.state === 'online';
  const tone = link ? 'info' : snapshot.state === 'online' ? 'success' : snapshot.state === 'offline' ? 'error' : ['partial', 'stale', 'unauthorized'].includes(snapshot.state) ? 'warning' : 'info';
  return {
    title: `${project.name}：${link ? '网页入口已配置，未检测可达性' : statusText[snapshot.state]}`,
    detail: snapshot.message.trim() || (tone === 'warning' || tone === 'error' ? '上游未提供具体原因，请进入项目查看运行状态。' : undefined),
    tone,
  };
}
