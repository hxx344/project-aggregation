import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import './backup-readiness.css';

type RetrievalState = 'unchecked' | 'retrieved' | 'missing';
type Drill = { kind: 'none' | 'ci-fixture' | 'independent'; result: 'not-run' | 'passed' | 'failed' | 'unknown'; at: string | null; isolation: 'unknown' | 'isolated' | 'not-isolated'; durationSeconds: number | null; coverage: string[] };
type Declaration = { checkedAt: string; retrieval: Record<'package' | 'dataKey' | 'secretsKey', RetrievalState>; drill: Drill };
type Archive = { digest: string; checkpointId: string; commit: string; completedAt: string; verifiedAt: string; unresolvedDependencyCount: number | null };
type Run = { id: string; origin: string; status: string; phase: string; error: string | null; notification: string | null; retention: string | null; archive?: Archive; declaration: Declaration | null };
type Snapshot = { availability: string; observedAt?: string; ledgerAvailability: string; ledgerRevision: number; schedule: { enabled: boolean; blockedByUnknown?: boolean; start?: string; end?: string; timezone?: string; keep?: number }; runs: Run[] };
const date = (value?: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未记录';
const labels: Record<string, string> = { running: '进行中', unknown: '结果未知，须人工核对', failed: '失败', complete: '归档完成', unchecked: '待取回核验', retrieved: '已取回核验', missing: '材料缺失', 'not-run': '未演练', passed: '成功', 'ci-fixture': 'CI 夹具', independent: '该备份的独立演练', none: '未演练', isolated: '已隔离', 'not-isolated': '未隔离', acknowledged: 'HTTP 已受理（不代表最终送达）', removed: '已按保留策略移除', deleting: '删除中，结果待核对', 'delete-failed': '删除失败' };
const emptyDrill = (): Drill => ({ kind: 'none', result: 'not-run', at: null, isolation: 'unknown', durationSeconds: null, coverage: [] });

function DeclarationForm({ run, revision, onSaved, onExpired }: { run: Run & { archive: Archive }; revision: number; onSaved: (snapshot: Snapshot) => void; onExpired: () => void }) {
  const [retrieval, setRetrieval] = useState<Declaration['retrieval']>(run.declaration?.retrieval ?? { package: 'unchecked', dataKey: 'unchecked', secretsKey: 'unchecked' });
  const [drill, setDrill] = useState<Drill>(run.declaration?.drill ?? emptyDrill());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true); setError('');
    try {
      onSaved(await api<Snapshot>('/api/system/backup-readiness', { method: 'POST', body: JSON.stringify({ digest: run.archive.digest, commit: run.archive.commit, backupAt: run.archive.completedAt, retrieval, drill, expectedRevision: revision }) }));
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onExpired();
      setError(reason instanceof ApiError && reason.status === 409 ? '备份或台账已变化，请刷新后核对再保存。' : reason instanceof Error ? reason.message : '登记失败，请刷新核对');
    } finally { setPending(false); }
  }
  return <form onSubmit={event => void save(event)} className="backup-readiness-form">
    <p>以下均为人工声明。请分别核验包、数据密钥与秘密材料密钥；此处不接收密钥正文。</p>
    <fieldset disabled={pending}><legend>取回核验</legend>
      {(['package', 'dataKey', 'secretsKey'] as const).map(key => <label key={key}>{({ package: '备份包', dataKey: '数据密钥', secretsKey: '秘密材料密钥' })[key]}
        <select aria-label={({ package: '备份包', dataKey: '数据密钥', secretsKey: '秘密材料密钥' })[key]} value={retrieval[key]} onChange={event => setRetrieval(previous => ({ ...previous, [key]: event.target.value as RetrievalState }))}>
          {(['unchecked', 'retrieved', 'missing'] as const).map(state => <option key={state} value={state}>{labels[state]}</option>)}
        </select></label>)}
    </fieldset>
    <fieldset disabled={pending}><legend>恢复演练记录（人工登记）</legend>
      <label>依据 <select aria-label="依据" value={drill.kind} onChange={event => setDrill(event.target.value === 'none' ? emptyDrill() : { ...drill, kind: event.target.value as Drill['kind'], result: 'unknown' })}>
        {(['none', 'ci-fixture', 'independent'] as const).map(value => <option key={value} value={value}>{labels[value]}</option>)}
      </select></label>{drill.kind !== 'none' ? <>
        <label> 结果 <select aria-label="结果" value={drill.result} onChange={event => setDrill({ ...drill, result: event.target.value as Drill['result'] })}>{(['unknown', 'passed', 'failed'] as const).map(value => <option key={value} value={value}>{value === 'failed' ? '演练失败' : labels[value]}</option>)}</select></label>
        <label> 隔离状态 <select aria-label="隔离状态" value={drill.isolation} onChange={event => setDrill({ ...drill, isolation: event.target.value as Drill['isolation'] })}>{(['unknown', 'isolated', 'not-isolated'] as const).map(value => <option key={value} value={value}>{value === 'unknown' ? '未知' : labels[value]}</option>)}</select></label>
        <p><label>演练时间 <input aria-label="演练时间" type="datetime-local" value={drill.at ? localInput(drill.at) : ''} onChange={event => setDrill({ ...drill, at: event.target.value ? new Date(event.target.value).toISOString() : null })} /></label>
          <label> 耗时（秒） <input aria-label="耗时（秒）" type="number" min="0" max="604800" value={drill.durationSeconds ?? ''} onChange={event => setDrill({ ...drill, durationSeconds: event.target.value === '' ? null : Number(event.target.value) })} /></label></p>
        <p>覆盖范围：{['hub', 'monitor', 'asset', 'crossex', 'greeks', 'aster', 'credentials'].map(module => <label key={module} style={{ marginRight: 12 }}><input type="checkbox" checked={drill.coverage.includes(module)} onChange={event => setDrill({ ...drill, coverage: event.target.checked ? [...drill.coverage, module] : drill.coverage.filter(item => item !== module) })} />{module === 'credentials' ? '凭据解密' : module}</label>)}</p>
      </> : null}
    </fieldset>
    {error ? <p role="alert">{error}</p> : null}
    <button type="submit" className="button secondary" disabled={pending}>{pending ? '正在登记…' : '保存人工核验记录'}</button>
  </form>;
}

function localInput(value: string) {
  const current = new Date(value);
  return new Date(current.getTime() - current.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function BackupReadiness({ onExpired }: { onExpired: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const callback = useRef(onExpired);
  const readGeneration = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  callback.current = onExpired;
  useEffect(() => {
    const controller = new AbortController();
    const generation = ++readGeneration.current;
    activeRead.current = controller;
    setError('');
    void api<Snapshot>('/api/system/backup-readiness', { signal: controller.signal }).then(value => { if (!controller.signal.aborted && generation === readGeneration.current) setSnapshot(value); }).catch(reason => {
      if (controller.signal.aborted || generation !== readGeneration.current) return;
      if (reason instanceof ApiError && reason.status === 401) callback.current();
      setError(reason instanceof Error ? reason.message : '读取失败');
    });
    return () => controller.abort();
  }, [revision]);
  const saved = (value: Snapshot) => { readGeneration.current += 1; activeRead.current?.abort(); setSnapshot(value); setError(''); };
  return <section className="backup-readiness" aria-labelledby="backup-readiness-title">
    <h2 id="backup-readiness-title">备份取回与恢复就绪</h2>
    <p>归档认证仅验证双密钥认证与密文摘要，不代表恢复成功。CI 夹具耗时不代表生产恢复时间。</p>
    <button className="button secondary" onClick={() => setRevision(value => value + 1)}>刷新备份台账</button>
    {error ? <p role="alert">{error}；已有内容可能过期。</p> : null}
    {!snapshot ? <p>正在读取…</p> : <>
      <p>本地计划：{snapshot.schedule.enabled ? `${snapshot.schedule.start}–${snapshot.schedule.end}（${snapshot.schedule.timezone}），保留 ${snapshot.schedule.keep} 个有效包` : '未启用'}。快照时间：{date(snapshot.observedAt)}。</p>
      {snapshot.schedule.blockedByUnknown ? <p role="alert">有中断任务的结果尚未确认，计划已停止新的冷备份，等待管理员核对。</p> : null}
      {snapshot.availability !== 'available' ? <p>{snapshot.availability === 'unconfigured' ? '尚未发布备份元数据。启用本地计划，或由管理员用 backup-register 登记已有本地包后可在此核验。' : '备份元数据不可读，无法确认当前状态。'}</p> : null}
      {snapshot.ledgerAvailability !== 'available' ? <p role="alert">历史人工台账不可读，已保留原记录并停止新登记。</p> : null}
      {snapshot.availability === 'available' && !snapshot.runs.length ? <p>尚无计划备份记录。</p> : null}
      {[...snapshot.runs].reverse().map(run => <article key={run.id}>
        <h3>{labels[run.status] ?? '未知'} · <code>{run.id}</code></h3>
        {run.error ? <p role="alert">阶段：{run.phase}；错误：{run.error}</p> : null}
        {run.notification ? <p>失败通知：{labels[run.notification] ?? '未知，不自动重发'}</p> : null}
        {run.retention ? <p>{labels[run.retention]}</p> : null}
        {run.archive ? <>
          <p>{run.origin === 'manual-registration' ? '管理员登记的本地包' : '本地计划备份'} · 完成于 {date(run.archive.completedAt)} · 代码版本 <code>{run.archive.commit}</code></p>
          <p style={{ overflowWrap: 'anywhere' }}>备份摘要：<code>{run.archive.digest}</code></p>
          <p>机器归档认证：通过（{date(run.archive.verifiedAt)}）。未闭合依赖：{run.archive.unresolvedDependencyCount ?? '未知'}。</p>
          <p>备份包：{labels[run.declaration?.retrieval.package ?? 'unchecked']}；数据密钥：{labels[run.declaration?.retrieval.dataKey ?? 'unchecked']}；秘密材料密钥：{labels[run.declaration?.retrieval.secretsKey ?? 'unchecked']}（人工声明）。</p>
          <p>人工核验时间：{date(run.declaration?.checkedAt)}。独立演练：{run.declaration?.drill.kind === 'independent' ? labels[run.declaration.drill.result] : '未登记'}。</p>
          {run.declaration?.drill.kind !== 'none' && run.declaration?.drill ? <p>登记依据：{labels[run.declaration.drill.kind]} · {labels[run.declaration.drill.result]} · {date(run.declaration.drill.at)} · {labels[run.declaration.drill.isolation]} · {run.declaration.drill.durationSeconds === null ? '耗时未知' : `${run.declaration.drill.durationSeconds} 秒`} · 覆盖：{run.declaration.drill.coverage.join('、') || '未知'}。</p> : null}
          {snapshot.ledgerAvailability === 'available' ? <details><summary>核对取回材料与演练记录</summary><DeclarationForm key={`${run.archive.digest}:${run.declaration?.checkedAt ?? ''}`} run={{ ...run, archive: run.archive }} revision={snapshot.ledgerRevision} onSaved={saved} onExpired={onExpired} /></details> : null}
        </> : <p>尚无可认证的归档证据；不据此认定备份可恢复。</p>}
      </article>)}
    </>}
  </section>;
}
