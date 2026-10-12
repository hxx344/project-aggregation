import type { LocalRouteState } from './local-route';

const reasons: Record<string, string> = {
  'not-connected': '未连接本机线路检测程序，暂时无法确认是否直连。',
  'unsupported-origin': '本机检测目前支持 Windows 上通过 http://hub.localhost:3100 访问的 SSH 转发入口。',
  'checking': '正在核对本机 SSH 连接、出站网卡和 Clash 状态。',
  'paused': '页面在后台，线路检测已暂停；返回后重新核对。',
  'offline': '本机已离线，联网后重新核对线路。',
  'ssh-not-found': '没有找到本机 3100 端口对应的 SSH 转发进程。',
  'target-mismatch': 'SSH 连接与检测程序配置的服务器不一致，或使用了跳板、代理转发。',
  'multiple-connections': '存在多个可能的 SSH 连接，无法确认当前页面对应的线路。',
  'source-mismatch': 'SSH 连接的源地址与当前出站路由不一致，需要重新确认。',
  'non-physical-interface': '当前使用虚拟网络接口，不能确认是否绕过 VPN。',
  'clash-unavailable': '未能读取 Clash 的实际状态，无法确认是否直连。',
  'clash-tun-enabled': 'Clash TUN 已开启，需要进一步核对实际分流，不能确认直连。',
  'clash-proxy': '发现 Clash 代理链，当前连接不能确认为本机直连。',
  'probe-failed': '本机检测未完成，稍后自动重试。',
  'probe-timeout': '本机线路检测超时，稍后自动重试。',
};

export function localRouteLabel(route: LocalRouteState) {
  return route.state === 'direct' ? 'SSH 直连' : route.state === 'checking' ? '线路检测中' : '线路未确认';
}

export default function LocalRouteDetails({ route }: { route: LocalRouteState }) {
  return <section className="local-route-details" aria-label="SSH 线路详情">
    <strong>{localRouteLabel(route)}</strong>
    <p>{route.state === 'direct' ? '已核对本机 SSH 连接使用物理网卡，Clash TUN 关闭，未发现该连接的代理链。此结论仅描述本机到服务器的 SSH 线路。' : reasons[route.reason] || '现有线路信息不足，无法确认是否直连。'}</p>
    {route.server ? <small>SSH 目标 {route.server.includes(':') ? `[${route.server}]` : route.server}:{route.sshPort}</small> : null}
    {route.checkedAt ? <small>线路检测 {new Date(route.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}</small> : null}
    {route.reason === 'not-connected' ? <>
      <p>在本机项目目录启动检测程序，并保持运行：</p>
      <code>powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-local-route.ps1 -Server &lt;服务器IP&gt;</code>
      <p>若浏览器询问本地网络访问权限，请允许此工作台访问本机检测程序。</p>
    </> : null}
  </section>;
}
