import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderKanban, LoaderCircle, RefreshCw, Settings2 } from 'lucide-react';
import { api, ApiError } from './api';
import type { Project } from './types';
import { navigation } from './hub-state';
import type { FramePhase, NavigationQuery } from './hub-state';

export default function ProjectPage({ project, active, query, onEdit, onExpired, onStatus, onChanged, onNavigate }: { project: Project; active: boolean; query?: NavigationQuery; onEdit: () => void; onExpired: () => void; onStatus: (value: FramePhase) => void; onChanged: () => void; onNavigate: (id: string, query: NavigationQuery) => void }) {
  const proxied = project.accessMode === 'proxy';
  const embedded = proxied || project.mode === 'embed';
  const accessible = project.enabled && !!(proxied ? project.apiUrl : project.url);
  const [source, setSource] = useState<{ url: string; attempt: number } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loading, setLoading] = useState(accessible && embedded);
  const [documentLoad, setDocumentLoad] = useState(0);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [error, setError] = useState('');
  const [openingTab, setOpeningTab] = useState(false);
  const pendingTabs = useRef(new Map<AbortController, Window>());
  const frame = useRef<HTMLIFrameElement>(null);
  const connected = useRef(false);
  const acknowledged = useRef(false);
  const sentNavigation = useRef('');
  const latest = useRef({ active, query, onStatus, onChanged, onNavigate });
  latest.current = { active, query, onStatus, onChanged, onNavigate };
  const post = (value: object) => { if (proxied && source) frame.current?.contentWindow?.postMessage({ channel: 'project-hub', version: 1, ...value }, new URL(source.url).origin); };
  function synchronize() {
    if (!connected.current) return;
    post({ type: 'activity', active: latest.current.active && document.visibilityState === 'visible' });
    const next = latest.current.query;
    const key = next === undefined ? '' : JSON.stringify(next);
    if (!latest.current.active) { sentNavigation.current = ''; return; }
    if (next !== undefined && key !== sentNavigation.current) { sentNavigation.current = key; post({ type: 'navigate', projectId: project.id, query: next }); }
  }
  useEffect(() => {
    if (!proxied || !source) return;
    const origin = new URL(source.url).origin;
    function message(event: MessageEvent) {
      if (event.origin !== origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.channel !== 'project-hub' || data.version !== 1) return;
      if (data.type === 'ready' && data.role === 'module') {
        const supportsActivity = Array.isArray(data.capabilities) && data.capabilities.includes('activity');
        // A new document can probe before its load event. Answer again after a
        // previous connection, without looping with unsupported legacy peers.
        const acknowledge = !acknowledged.current || (!supportsActivity && connected.current);
        if (!supportsActivity) { connected.current = false; sentNavigation.current = ''; setBridgeReady(false); }
        if (acknowledge) { acknowledged.current = true; post({ type: 'ready', role: 'host', capabilities: ['activity', 'navigate', 'changed'] }); }
        if (!supportsActivity) return;
        connected.current = true; setBridgeReady(true); setLoading(false); latest.current.onStatus('ready');
        synchronize();
      } else if (connected.current && data.type === 'changed' && data.scope === 'summary') latest.current.onChanged();
      else if (connected.current && latest.current.active && document.visibilityState === 'visible' && data.type === 'navigate') {
        const target = navigation(data); if (target) latest.current.onNavigate(target.projectId, target.query);
      }
    }
    window.addEventListener('message', message); document.addEventListener('visibilitychange', synchronize);
    return () => { window.removeEventListener('message', message); document.removeEventListener('visibilitychange', synchronize); };
  }, [proxied, source]);
  useEffect(synchronize, [active, query, source]);

  useEffect(() => {
    const pending = pendingTabs.current;
    return () => { for (const [controller, tab] of pending) { controller.abort(); tab.close(); } pending.clear(); };
  }, []);

  useEffect(() => {
    if (!accessible || !embedded) { latest.current.onStatus('unsupported'); return; }
    const controller = new AbortController();
    connected.current = false; acknowledged.current = false; sentNavigation.current = ''; setDocumentLoad(0); setBridgeReady(false); latest.current.onStatus('loading');
    setSource(null); setError(''); setLoading(true);
    const request = proxied
      ? api<{ url: string }>(`/api/projects/${encodeURIComponent(project.id)}/launch`, { method: 'POST', signal: controller.signal })
      : Promise.resolve({ url: project.url });
    void request.then(result => {
      if (!controller.signal.aborted) setSource({ url: result.url, attempt });
    }).catch(reason => {
      if (controller.signal.aborted) return;
      setLoading(false);
      latest.current.onStatus('failed');
      if (reason instanceof ApiError && reason.status === 401) onExpired();
      else setError(reason instanceof Error ? reason.message : '项目页面暂时无法打开，请重试或检查连接设置。');
    });
    return () => controller.abort();
  }, [accessible, embedded, proxied, project.id, project.url, attempt, onExpired]);

  useEffect(() => {
    if (!source || !loading) return;
    const timer = setTimeout(() => { setLoading(false); setError('项目页面加载超时，请重新载入或检查该项目服务。'); latest.current.onStatus('failed'); }, 30_000);
    return () => clearTimeout(timer);
  }, [source, loading]);
  useEffect(() => {
    if (!documentLoad || bridgeReady) return;
    const timer = setTimeout(() => latest.current.onStatus('unsupported'), proxied ? 3000 : 0);
    return () => clearTimeout(timer);
  }, [documentLoad, bridgeReady, proxied]);

  function loaded() {
    setLoading(false); setDocumentLoad(value => value + 1);
    // WindowProxy survives iframe navigation: revalidate this document even
    // when an earlier document (or its ready-before-load event) was connected.
    connected.current = false; acknowledged.current = false; sentNavigation.current = ''; setBridgeReady(false);
    setError(value => value === '项目页面加载超时，请重新载入或检查该项目服务。' ? '' : value);
    post({ type: 'ready', role: 'host', capabilities: ['activity', 'navigate', 'changed'] });
  }

  async function openInTab() {
    const tab = window.open('about:blank', '_blank');
    if (!tab) { setError('浏览器阻止了新窗口，请允许此页面打开新窗口后重试。'); return; }
    tab.opener = null;
    tab.document.title = '正在打开' + project.name;
    tab.document.body.textContent = '正在打开' + project.name + '…';
    const controller = new AbortController();
    pendingTabs.current.set(controller, tab);
    setOpeningTab(true); setError('');
    try {
      const result = proxied
        ? await api<{ url: string }>(`/api/projects/${encodeURIComponent(project.id)}/launch`, { method: 'POST', signal: controller.signal })
        : { url: project.url };
      if (!controller.signal.aborted && !tab.closed) tab.location.replace(result.url);
    } catch (reason) {
      tab.close();
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) onExpired();
      else setError(reason instanceof Error ? reason.message : '项目页面暂时无法打开');
    } finally {
      pendingTabs.current.delete(controller);
      if (!controller.signal.aborted) setOpeningTab(false);
    }
  }

  return <section className="project-screen" hidden={!active} aria-label={project.name}>
    <h1 className="visually-hidden">{project.name}</h1>
    <div className="original-page-toolbar">
      <span className="original-page-loading" role="status">{loading ? <><LoaderCircle size={15} className="spin" />正在打开项目…</> : null}</span>
      <div className="original-page-actions">
        {accessible && embedded ? <button className="button ghost" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={16} />重新载入</button> : null}
        {accessible ? <button className="button ghost" disabled={openingTab} onClick={() => void openInTab()}>{openingTab ? <LoaderCircle size={16} className="spin" /> : <ExternalLink size={16} />}单独打开</button> : null}
        <button className="button ghost" onClick={onEdit}><Settings2 size={16} />连接设置</button>
      </div>
    </div>
    {error ? <div className="error-box original-page-error" role="alert">{error}</div> : null}
    {!accessible ? <div className="empty-state original-page-placeholder"><FolderKanban size={32} /><h2>{project.enabled ? '请先设置项目地址' : '项目已停用'}</h2><p>{project.enabled ? '保存连接设置后，即可在这里打开原始页面。' : '在连接设置中启用后，可继续访问原始页面。'}</p><button className="button secondary" onClick={onEdit}>连接设置</button></div>
      : !embedded ? <div className="empty-state original-page-placeholder"><ExternalLink size={32} /><h2>{project.name}</h2><p>此项目设为在新窗口打开。</p><button className="button primary" disabled={openingTab} onClick={() => void openInTab()}>打开原始页面</button></div>
        : source ? <iframe ref={frame} key={`${source.attempt}:${source.url}`} className="original-project-frame" title={project.name + '原始页面'} src={source.url} loading="eager" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" onLoad={loaded} />
          : <div className="empty-state original-page-placeholder">{loading ? <LoaderCircle size={28} className="spin" /> : <button className="button secondary" onClick={() => setAttempt(value => value + 1)}>重新载入</button>}</div>}
  </section>;
}
