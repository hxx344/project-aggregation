import { compareDecimals } from './trading-decimal.mjs';

const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const positive = value => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) > 0;
const sameLeg = (a, b) => a.exchange === b.exchange && a.symbol === b.symbol && a.side === b.side;
const wallet = value => typeof value === 'string' && /^0x[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
const result = (state, reason, checkedAt = null, validUntil = null) => ({ state, reason, checkedAt, validUntil });

function positionEvidence(source, position, now, staleMs) {
  const stamps = [time(source.fetchedAt), ...(Object.hasOwn(position, 'riskFetchedAt') ? [time(position.riskFetchedAt)] : [])];
  if (!source.connected || source.state !== 'live' || source.error || stamps.some(at => at === null || at > now + 1000 || now - at > staleMs)) return { reason: '仓位数据不可用或已过期，等待重新读取', until: null };
  if (!positive(position.markPrice)) return { reason: '缺少有效标记价', until: null };
  if (position.liquidationKnown === false) return { reason: '强平价缺失或无效，无法确认强平风险', until: null };
  if (!positive(position.liquidationPrice)) return { reason: '缺少有效强平价', until: null };
  return { reason: null, until: Math.min(...stamps) + staleMs };
}

function accountMatch(source, position, connection) {
  const proof = source.executionBinding;
  if (source.origin !== 'execution' || !proof || !Number.isSafeInteger(proof.revision)) return result('unknown', '仓位尚未取得下单单元的账户证明');
  if (proof.revision !== connection.revision || proof.accountMode !== connection.accountMode) return result('unknown', '下单连接已变化，等待当前连接的仓位核验');
  if (['binance', 'okx'].includes(position.exchange)) {
    if (!/^[1-9][0-9]{0,39}$/.test(proof.identity ?? '') || !/^[1-9][0-9]{0,39}$/.test(connection.identity ?? '')) return result('unknown', '执行账户 UID 尚未核验');
    if (proof.identity !== connection.identity) return result('unmatched', '规则绑定的是另一个账户');
    if (position.exchange === 'binance' && !['standard', 'portfolio-margin'].includes(proof.accountMode)) return result('unknown', 'Binance 执行账户范围尚未核验');
  }
  if (position.exchange === 'okx') {
    if (!['cross', 'isolated'].includes(position.marginMode) || position.marginMode !== connection.accountMode) return result('unmatched', '仓位保证金范围与规则连接不一致');
  } else if (['hyperliquid', 'rh-lighter'].includes(position.exchange)) {
    if (!wallet(proof.identity) || !wallet(connection.identity)) return result('unknown', '账户地址证据缺失');
    if (wallet(proof.identity) !== wallet(connection.identity)) return result('unmatched', '规则绑定的是另一个钱包');
    if (position.exchange === 'rh-lighter') {
      // connect() produces this label from the verified account/key indexes.
      // It is never user-entered text and contains no signing material.
      const label = /^(\d{1,16})#(\d{1,3})$/.exec(connection.keyLabel ?? '');
      const index = label ? Number(label[1]) : NaN;
      const keyIndex = label ? Number(label[2]) : NaN;
      if (!Number.isSafeInteger(index) || index < 1 || !Number.isInteger(keyIndex) || keyIndex < 4 || keyIndex > 254 || keyIndex === 157 || !Number.isSafeInteger(position.account)) return result('unknown', '子账户索引尚未核验');
      if (proof.accountIndex !== index || position.account !== index) return result('unmatched', '该钱包下的另一子账户未被此规则覆盖');
    }
  } else if (position.exchange !== 'binance') return result('unknown', '此来源尚无可用的账户证明');
  return null;
}

/** Pure display projection. It never grants execution permission or performs IO. */
export function positionProtection({ source, position, alerts, reduction, now, staleMs }) {
  const evidence = positionEvidence(source, position, now, staleMs);
  let alert;
  if (!alerts.config.enabled) alert = result('disabled', '强平预警未启用', source.fetchedAt);
  else if (!alerts.channel.configured || alerts.channel.error || alerts.error) alert = result('blocked', alerts.channel.error || alerts.error || '预警机器人不可用', source.fetchedAt);
  else if (evidence.reason) alert = result('blocked', evidence.reason, source.fetchedAt);
  else alert = result('ready', '强平距离达到阈值时提醒', source.fetchedAt, new Date(evidence.until).toISOString());

  const checkedAt = reduction?.live?.checkedAt ?? reduction?.checkedAt ?? null;
  const status = (state, reason, until = null) => ({ alert, reduction: result(state, reason, checkedAt, until) });
  if (!reduction) return status('unknown', '自动减仓覆盖暂时无法读取');
  const matches = reduction.config?.legs.filter(leg => sameLeg(leg, position)) ?? [];
  if (!matches.length) return status('unconfigured', '没有包含该合约与方向的减仓规则');
  if (matches.length !== 1) return status('unknown', '规则腿无法唯一对应');
  if (!reduction.config.enabled && !reduction.bindings) return status('disabled', reduction.state.reason || '配置包含该合约但未启用，启用时需重新核验账户');
  const connection = reduction.connections.find(item => item.exchange === position.exchange);
  if (!connection?.connected || !connection.identity) return status('unknown', '实盘账户未连接或尚未核验');
  const match = accountMatch(source, position, connection);
  if (match) return { alert, reduction: { ...match, checkedAt } };
  if (source.positions.filter(row => sameLeg(row, position) && row.account === position.account).length !== 1) return status('unknown', '同合约同方向存在多条仓位，无法唯一核对');
  const binding = reduction.bindings?.[position.exchange];
  if (!binding || binding.revision !== connection.revision || binding.identity !== connection.identity) return status('unknown', '规则的账户绑定已失效或尚未保存，请重新核验');
  for (const leg of reduction.config.legs) {
    const current = reduction.connections.find(item => item.exchange === leg.exchange), saved = reduction.bindings?.[leg.exchange];
    if (!current?.connected || !saved || saved.revision !== current.revision || saved.identity !== current.identity) return status('unknown', '规则另一腿的账户连接已变化或不可用，等待重新核验');
    if (current.writeProtection && (!current.writeProtection.identityVerified || current.writeProtection.reason)) return status('blocked', '规则账户写入保护尚未就绪，请核对实盘连接');
  }
  if (reduction.maintenance) return status('blocked', '系统处于维护状态');
  if (reduction.available !== true) return status('unknown', '执行服务未持有有效运行资格');
  if (reduction.state.phase === 'reducing' && reduction.job && ['queued', 'running', 'stopping'].includes(reduction.job.status)) return status('running', '当前批次状态请在减仓执行进度核对');
  if (!reduction.config.enabled) return status('disabled', reduction.state.reason || '规则未启用；仅保留配置');
  if (reduction.state.phase !== 'armed' || reduction.state.reason) return status('blocked', reduction.state.reason || '执行状态尚未恢复到监测中');
  if (reduction.locked) return status('blocked', '规则合约仍有未结束任务');
  if (evidence.reason) return status('blocked', evidence.reason);
  if (reduction.live?.warning) return status('blocked', reduction.live.warning);
  const until = time(reduction.live?.validUntil), checked = time(checkedAt);
  if (until === null || checked === null) return status('pending', '等待账户、数量和分批限制核验');
  if (checked > now + 1000) return status('stale', '核验时间无效，等待重新核验');
  const legs = reduction.live.legs.filter(leg => sameLeg(leg, position));
  try {
    if (legs.length !== 1 || compareDecimals(legs[0].quantity, position.quantity) !== 0) return status('pending', '仓位数量与最近核验不一致，等待重新核对');
  } catch { return status('unknown', '持仓数量无法核对'); }
  // Monitoring health is not executable market evidence. Keep the original
  // quote deadline, and report the scheduler's separate bounded health window.
  const monitorUntil = Math.min(time(reduction.monitorUntil) ?? 0, evidence.until);
  if (until <= now) return monitorUntil > now
    ? status('monitoring', '规则持续监测；上次行情已到期，下单前会重新核验', new Date(monitorUntil).toISOString())
    : status('stale', '执行单元尚未更新核验结果，请查看自动减仓状态');
  const protectedState = status('ready', '已关联下单账户，最近核验通过；发送前仍会重新检查', new Date(Math.min(until, evidence.until)).toISOString());
  if (monitorUntil > now) protectedState.reduction.monitorUntil = new Date(monitorUntil).toISOString();
  return protectedState;
}
