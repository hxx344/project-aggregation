import { useEffect, useRef, useState } from 'react';
import { Activity, Download, Pause, Play, RotateCcw } from 'lucide-react';
import { createDiagnosticFetch } from './request-diagnostics';

interface RequestLog {
  id: number;
  url: string;
  method: string;
  status: number;
  duration: number;
  timestamp: number;
  size: number | null;
}

interface RequestStats {
  total: number;
  failed: number;
  avgDuration: number;
  maxDuration: number;
  totalSize: number;
  byEndpoint: Record<string, { count: number; avgDuration: number; failed: number }>;
}

export default function DiagnosticPage() {
  const [monitoring, setMonitoring] = useState(false);
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const idCounter = useRef(0);

  useEffect(() => {
    if (!monitoring) return;

    let active = true;
    const originalFetch = window.fetch;
    const observedFetch = createDiagnosticFetch(originalFetch.bind(window), entry => {
      if (!active) return;
      const log = { ...entry, id: ++idCounter.current };
      setLogs(prev => [log, ...prev].slice(0, 100));
    });
    window.fetch = observedFetch;

    return () => {
      active = false;
      if (window.fetch === observedFetch) window.fetch = originalFetch;
    };
  }, [monitoring]);

  const stats: RequestStats = logs.reduce((acc, log) => {
    const endpoint = new URL(log.url, location.origin).pathname;
    if (!acc.byEndpoint[endpoint]) {
      acc.byEndpoint[endpoint] = { count: 0, avgDuration: 0, failed: 0 };
    }

    const ep = acc.byEndpoint[endpoint];
    ep.count++;
    ep.avgDuration = (ep.avgDuration * (ep.count - 1) + log.duration) / ep.count;
    if (log.status === 0 || log.status >= 400) ep.failed++;

    acc.total++;
    if (log.status === 0 || log.status >= 400) acc.failed++;
    acc.avgDuration = (acc.avgDuration * (acc.total - 1) + log.duration) / acc.total;
    acc.maxDuration = Math.max(acc.maxDuration, log.duration);
    acc.totalSize += log.size ?? 0;

    return acc;
  }, { total: 0, failed: 0, avgDuration: 0, maxDuration: 0, totalSize: 0, byEndpoint: {} } as RequestStats);

  const exportData = () => {
    const data = {
      capturedAt: new Date().toISOString(),
      measurement: { duration: 'fetch start to response headers; excludes body transfer', size: 'Content-Length when provided; null means unknown', scope: 'latest 100 completed fetch calls in the workbench window' },
      duration: logs.length > 0 ? (logs[0].timestamp - logs[logs.length - 1].timestamp) / 1000 : 0,
      stats,
      logs: logs.map(l => ({
        ...l,
        timestamp: new Date(l.timestamp).toISOString(),
      })),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `diagnostic-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  };

  const formatTime = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  return (
    <div className="diagnostic-page">
      <div className="diagnostic-controls">
        <button
          className={`button ${monitoring ? 'danger' : 'primary'}`}
          onClick={() => setMonitoring(!monitoring)}
        >
          {monitoring ? <><Pause size={18} />停止监控</> : <><Play size={18} />开始监控</>}
        </button>
        <button
          className="button secondary"
          onClick={() => setLogs([])}
          disabled={logs.length === 0}
        >
          <RotateCcw size={18} />清空记录
        </button>
        <button
          className="button secondary"
          onClick={exportData}
          disabled={logs.length === 0}
        >
          <Download size={18} />导出数据
        </button>
      </div>

      {monitoring && (
        <div className="diagnostic-notice">
          <Activity size={18} className="pulse" />
          <span>正在记录工作台页面的 fetch 请求；切换页面后继续监控。</span>
        </div>
      )}
      <p className="diagnostic-explanation">显示最近 100 条记录。等待时间截至收到响应头，不含正文下载；大小取响应声明值，未提供时显示 —。不含内嵌项目、EventSource 和 WebSocket 流量。</p>

      <div className="diagnostic-stats">
        <div className="stat-card">
          <span className="stat-label">总请求数</span>
          <span className="stat-value">{stats.total}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">失败请求</span>
          <span className="stat-value error">{stats.failed}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">平均响应等待</span>
          <span className="stat-value">{stats.total > 0 ? formatTime(Math.round(stats.avgDuration)) : '—'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">最大响应等待</span>
          <span className="stat-value">{stats.maxDuration > 0 ? formatTime(stats.maxDuration) : '—'}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">已知声明大小合计</span>
          <span className="stat-value">{formatSize(stats.totalSize)}</span>
        </div>
      </div>

      {Object.keys(stats.byEndpoint).length > 0 && (
        <div className="diagnostic-endpoints">
          <h3>接口统计</h3>
          <table className="diagnostic-table">
            <thead>
              <tr>
                <th>接口</th>
                <th>请求数</th>
                <th>失败数</th>
                <th>平均响应等待</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(stats.byEndpoint)
                .sort(([, a], [, b]) => b.count - a.count)
                .map(([endpoint, data]) => (
                  <tr key={endpoint}>
                    <td><code>{endpoint}</code></td>
                    <td>{data.count}</td>
                    <td className={data.failed > 0 ? 'error' : ''}>{data.failed}</td>
                    <td>{formatTime(Math.round(data.avgDuration))}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="diagnostic-logs">
        <h3>请求记录 <span className="log-count">({logs.length})</span></h3>
        {logs.length === 0 ? (
          <div className="empty-state">
            <Activity size={32} />
            <p>{monitoring ? '等待请求…' : '点击"开始监控"查看实时请求'}</p>
          </div>
        ) : (
          <table className="diagnostic-table compact">
            <thead>
              <tr>
                <th>时间</th>
                <th>方法</th>
                <th>URL</th>
                <th>状态</th>
                <th>响应等待</th>
                <th>声明大小</th>
              </tr>
            </thead>
            <tbody>
              {logs.map(log => (
                <tr key={log.id} className={log.status === 0 || log.status >= 400 ? 'error-row' : ''}>
                  <td>{new Date(log.timestamp).toLocaleTimeString('zh-CN')}</td>
                  <td><code>{log.method}</code></td>
                  <td className="url-cell" title={log.url}>{new URL(log.url, location.origin).pathname}</td>
                  <td className={log.status === 0 ? 'error' : log.status >= 400 ? 'warning' : log.status >= 300 ? 'info' : 'success'}>
                    {log.status === 0 ? '失败' : log.status}
                  </td>
                  <td className={log.duration > 3000 ? 'error' : log.duration > 1000 ? 'warning' : ''}>
                    {formatTime(log.duration)}
                  </td>
                  <td>{log.size === null ? '—' : formatSize(log.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
