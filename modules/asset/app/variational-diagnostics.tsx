'use client';

import { useState } from 'react';
import type { VariationalDiagnosticComparisonReport, VariationalDiagnosticOutcome, VariationalDiagnosticResult } from '@/lib/variational-diagnostic-types';

const outcomeLabels: Record<VariationalDiagnosticOutcome, string> = {
  ok: '响应结构符合预期',
  challenge: '遇到 Cloudflare 浏览器验证',
  unauthorized: '接口返回未授权',
  forbidden: '接口拒绝访问',
  rate_limited: '接口请求受限',
  redirect: '接口返回重定向',
  html: '接口返回 HTML 页面',
  invalid_data: '响应数据不符合预期',
  timeout: '接口请求超时',
  network_error: '网络请求失败',
  cancelled: '测试已取消',
  client_unavailable: 'Python 3 不可用',
  client_error: 'Python 诊断客户端运行失败',
};

const contentTypeLabels = { json: 'JSON', html: 'HTML', other: '其他', missing: '未提供 Content-Type' };
const endpointNames = { session: '登录接口', portfolio: '资产接口' };
const clientNames = { 'asset-node': 'Asset · Node.js', 'grid-python': 'Var Grid · Python 请求方式' };
const clientErrors = {
  client_unavailable: '服务器未找到可用的 Python 3，未执行此接口测试；这不表示上游网络请求失败。',
  client_error: '服务器上的 Python 诊断客户端未能完成运行，无法判断这组接口结果；这不同于上游网络请求失败。',
};

function challengeLabel(result: VariationalDiagnosticResult) {
  return result.challenge ? '检出浏览器验证' : result.status === null ? '未获得响应' : '未检出浏览器验证';
}

function structureLabel(result: VariationalDiagnosticResult) {
  return result.structureOk === null ? '未验证' : result.structureOk ? '符合预期' : '不符合预期';
}

function diagnosticText(report: VariationalDiagnosticComparisonReport) {
  return JSON.stringify({
    checkedAt: report.checkedAt,
    clients: report.clients.map(clientReport => ({
      client: clientReport.client,
      results: clientReport.results.map(result => ({
        endpoint: result.endpoint,
        path: result.path,
        status: result.status,
        contentType: result.contentType,
        challenge: result.challenge,
        elapsedMs: result.elapsedMs,
        structureOk: result.structureOk,
        outcome: result.outcome,
      })),
    })),
  }, null, 2);
}

export function VariationalDiagnostics({ report }: { report: VariationalDiagnosticComparisonReport }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const text = diagnosticText(report);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('fallback');
    }
  }

  return <div className="diagnostic-results">
    <p className="help" role="status">测试完成 · {new Date(report.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}（北京时间）</p>
    {report.clients.map(clientReport => <section className="diagnostic-client" key={clientReport.client} aria-label={clientNames[clientReport.client]}>
      <h3 className="diagnostic-client-title">{clientNames[clientReport.client]}</h3>
      <div className="diagnostic-endpoints">
        {clientReport.results.map(result => <article className="diagnostic-endpoint" key={result.endpoint}>
          <div className="diagnostic-heading"><h4>{endpointNames[result.endpoint]}</h4><span className={`status${result.outcome === 'ok' ? ' live' : ' amber'}`}>{result.status === null ? '无 HTTP 响应' : `HTTP ${result.status}`}</span></div>
          <code className="diagnostic-path">{result.path}</code>
          <p className={result.outcome === 'ok' ? 'good-text' : 'diagnostic-outcome'}>{outcomeLabels[result.outcome]}</p>
          {(result.outcome === 'client_unavailable' || result.outcome === 'client_error') && <p className="help">{clientErrors[result.outcome]}</p>}
          <dl>
            <div><dt>Cloudflare 挑战</dt><dd>{challengeLabel(result)}</dd></div>
            <div><dt>响应格式</dt><dd>{result.contentType === null ? '未获得响应' : contentTypeLabels[result.contentType]}</dd></div>
            <div><dt>数据结构</dt><dd>{structureLabel(result)}</dd></div>
            <div><dt>耗时</dt><dd>{result.elapsedMs.toLocaleString('zh-CN')} ms</dd></div>
          </dl>
        </article>)}
      </div>
    </section>)}
    <p className="help">Python 组沿用 Var Grid 的登录请求方式测试登录与资产接口，正式资产同步也使用这套 Python 请求方式。登录响应符合预期不代表资产接口可用；测试未覆盖 Grid 行情或报价。</p>
    <div className="diagnostic-copy"><button type="button" className="button" onClick={() => void copy()}>复制诊断结果</button>{copyState === 'copied' && <span className="help good-text" role="status">已复制</span>}</div>
    {copyState === 'fallback' && <label className="diagnostic-fallback">诊断结果文本<span className="help" role="status">浏览器无法自动复制，请选中下方文本后复制。</span><textarea readOnly rows={10} value={text} onFocus={event => event.currentTarget.select()} spellCheck={false}/></label>}
  </div>;
}
