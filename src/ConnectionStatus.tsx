import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { api } from './api';
import { checkConnectionHealth, createConnectionMonitor, initialConnectionState } from './connection-quality';
import type { ConnectionQuality } from './connection-quality';
import { createLocalRouteMonitor, initialLocalRoute, LOCAL_ROUTE_ORIGIN } from './local-route';
import LocalRouteDetails, { localRouteLabel } from './LocalRouteDetails';

const labels: Record<ConnectionQuality, string> = {
  checking: '检测中', good: '良好', fair: '一般', slow: '较慢', unreachable: '无法连接', offline: '本机离线', paused: '已暂停',
};

export default function ConnectionStatus() {
  const [state, setState] = useState(initialConnectionState);
  const [route, setRoute] = useState(initialLocalRoute);
  useEffect(() => {
    const monitor = createConnectionMonitor({ probe: signal => checkConnectionHealth(api, signal), onChange: setState });
    const sync = () => monitor.sync({ online: navigator.onLine, visible: !document.hidden });
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      monitor.dispose();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, []);
  useEffect(() => {
    const monitor = createLocalRouteMonitor({ onChange: setRoute });
    const sync = () => monitor.sync({ supported: location.origin === LOCAL_ROUTE_ORIGIN, online: navigator.onLine, visible: !document.hidden });
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      monitor.dispose();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, []);
  const label = labels[state.quality];
  return <details className={`connection-status connection-${state.quality}`}>
    <summary aria-label={`本机到服务器：${label}${state.latencyMs !== null ? `，${state.latencyMs} 毫秒` : ''}，${localRouteLabel(route)}`}>
      <Activity size={15} aria-hidden="true" /><span className="connection-label">本机 → 服务器</span>
      <span role="status">{label}</span>{state.latencyMs !== null ? <span className="connection-latency">{state.latencyMs} ms</span> : null}
      <span className={`connection-route ${route.state === 'direct' ? 'verified' : ''}`} role="status">{localRouteLabel(route)}</span>
    </summary>
    <div className="connection-details">
      <strong>本机 → 工作台服务器</strong>
      <p>当前浏览器到工作台服务器的 HTTP 往返耗时，包含网络传输和服务响应时间。</p>
      {state.quality === 'unreachable' ? <p className="connection-problem">本次探测失败或超过 3 秒未响应，将自动重试。</p> : state.quality === 'offline' ? <p className="connection-problem">浏览器报告本机离线，网络恢复后自动重测。</p> : null}
      <p>良好 ≤150 ms · 一般 ≤500 ms · 较慢 &gt;500 ms</p>
      <p>前台每 10 秒检测，后台暂停；返回页面时重新检测。</p>
      {state.checkedAt !== null ? <small>最近检测 {new Date(state.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })}</small> : null}
      <LocalRouteDetails route={route} />
    </div>
  </details>;
}
