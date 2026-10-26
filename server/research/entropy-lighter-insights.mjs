// Read-only interpretation of one report and the parameters captured in its session.
// A research shortlist never authorizes an order or changes the paper simulator.
const SYMBOLS = ['SNDK', 'ANTH'];
const VENUES = ['entropy', 'lighter'];
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonnegative = (value) => finite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const nullable = (value) => finite(value) ? value : null;
const researchQuality = (value) => value === null || value === 'stale_receive' || value === 'stale_source';
const caveat = '余量是入场价差减去整轮成本预算，假设平仓时基差收敛，并非已实现收益。入场价已计滑点；整轮预算含四次手续费、退出两腿滑点和资金费准备。返佣仅按 Entropy 整轮手续费计算，属于未到账假设。连续样本可能相关，尚未回测，不能视为获利概率。';

function directionValid(row) {
  return row && VENUES.includes(row.buy) && VENUES.includes(row.sell) && row.buy !== row.sell;
}

function knownCosts(evaluation) {
  return evaluation && nonnegative(evaluation.costs?.feesRoundTripCash) && nonnegative(evaluation.costs?.totalReserveCash)
    && finite(evaluation.surplusBeforeRebateCash) && finite(evaluation.surplusBeforeRebateBps);
}

function evaluationScore(row) {
  const evaluation = row?.latest;
  return knownCosts(evaluation) ? evaluation.surplusBeforeRebateBps : finite(evaluation?.grossBps) ? evaluation.grossBps : -Infinity;
}

function recent(at, now, windowMs) {
  return finite(at) && finite(now) && now >= at - 100 && now - at <= windowMs;
}

function studyRows(source, scenarios) {
  return Object.values(source || {}).filter(directionValid)
    .filter((row) => !row.scenario || scenarios.some((scenario) => scenario?.name === row.scenario.name
      && scenario.entropyMs === row.scenario.entropyMs && scenario.lighterMs === row.scenario.lighterMs));
}

function delayedRow(row) {
  const validCounts = ['attempts', 'completed', 'failed', 'costed', 'passedAfterCosts'].every((key) => count(row[key]))
    && row.completed + row.failed <= row.attempts && row.costed <= row.completed && row.passedAfterCosts <= row.costed;
  const completionRate = validCounts && row.attempts > 0 ? row.completed / row.attempts : null;
  const passRate = validCounts && row.costed > 0 ? row.passedAfterCosts / row.costed : null;
  return { ...row, name: row.scenario.name, completionRate, passRate,
    meanSurplusBps: validCounts && row.costed > 0 && finite(row.sumSurplusBps) ? row.sumSurplusBps / row.costed : null,
    sampleReady: Boolean(validCounts && row.costed >= 30 && finite(row.qualitySpanMs) && row.qualitySpanMs >= 300000
      && completionRate >= 0.8 && passRate >= 0.75) };
}

function paperState(report) {
  const rows = Object.values(report?.paper || {});
  const summarizedOpen = rows.reduce((sum, row) => sum + (count(row?.openTasks) ? row.openTasks : 0), 0);
  const openTasks = Math.max(Array.isArray(report?.openPaperTasks) ? report.openPaperTasks.length : 0, summarizedOpen);
  return { scope: 'all_symbols', openTasks,
    unresolved: Boolean(openTasks || report?.paperSuspendedReason || rows.some((row) => nonnegative(row?.unresolved) && row.unresolved > 0)) };
}

function quoteState(report, symbol, reportAgeMs, windowMs) {
  const quotes = Array.isArray(report.latestQuotes) ? report.latestQuotes : [];
  const rows = VENUES.map((venue) => quotes.find((row) => row?.venue === venue && row.symbol === symbol));
  if (rows.some((row) => !row)) return '两侧当前报价尚未齐全';
  if (rows.some((row) => !nonnegative(row.receiveAgeMs) || reportAgeMs === null || row.receiveAgeMs + reportAgeMs > windowMs)) return '两侧报价未在当前观察窗口内持续更新';
  if (rows.some((row) => !researchQuality(row.executionQuality))) return '最近采样时的盘口存在时效以外的执行质量问题';
  if (rows.some((row) => row.sourceClockUncertain !== false)) return '行情源时间仍有不确定性';
  return null;
}

function leaderInsights(report) {
  const rows = Object.entries(report?.leaderMarkouts || {}).flatMap(([key, row]) => {
    const [symbol, follower, horizon] = key.split(':');
    if (!SYMBOLS.includes(symbol) || !VENUES.includes(follower) || !count(row?.samples) || !finite(Number(horizon))) return [];
    return [{ symbol, follower, horizonMs: Number(horizon), samples: row.samples,
      directionHitRate: nullable(row.directionHitRate), meanSignedMoveBps: nullable(row.meanSignedMoveBps) }];
  });
  // One signal contributes several horizons and followers; adding them would overstate evidence.
  const samples = Math.max(0, ...rows.map((row) => row.samples));
  return { status: 'unproven', title: '领先策略待验证', samples, rows,
    reason: samples < 30 ? 'Binance 目前只有本地接收时钟下的相对变动观察，单一组合样本不足，尚不能判断可交易的领先优势。'
      : '已有本地接收时钟下的相对变动观察，但没有成本、下单延迟和真实执行证据，尚未证明可交易的领先优势。',
    nextSteps: ['按标的、跟随平台和观察时长分别积累样本，不能把多个窗口相加当作独立样本。', '先补齐成本与延迟后的纸面执行检验，再判断是否继续研究领先策略。'] };
}

function symbolInsights({ symbol, report, simulation, live, reportAgeMs, windowMs, evidenceMaxAgeMs, now, paper, hasParameters, hasStudy, stopped }) {
  const scenarios = Array.isArray(simulation?.latencyScenarios) ? simulation.latencyScenarios : [];
  const source = report?.opportunityStudy?.bySymbol?.[symbol];
  const rawRows = studyRows(source?.raw, scenarios).filter((row) => row.scenario === null).sort((a, b) => evaluationScore(b) - evaluationScore(a));
  const delayed = studyRows(source?.latency, scenarios).filter((row) => row.scenario).map(delayedRow)
    .sort((a, b) => evaluationScore(b) - evaluationScore(a));
  const rawMetrics = rawRows[0] || null;
  const currentQuotes = report ? quoteState(report, symbol, reportAgeMs, windowMs) : '等待首次行情报告';
  const feesKnown = nonnegative(simulation?.entropyTakerFeeBps) && nonnegative(simulation?.lighterTakerFeeBps);
  const thresholdKnown = nonnegative(simulation?.minEntryEdgeBps);
  const blockers = [];
  if (!hasParameters) blockers.push('该报告未记录本次会话参数，不能套用后来保存的配置');
  if (!hasStudy) blockers.push('等待升级后的双向价差与延迟样本');
  if (stopped) blockers.push('采集未处于运行状态');
  else if (!live) blockers.push('报告与当前采集会话不匹配，或已超出观察窗口');
  if (currentQuotes) blockers.push(currentQuotes);
  if (hasParameters && !feesKnown) blockers.push('至少一侧手续费未知，成本和余量保持未知');
  if (hasParameters && !thresholdKnown) blockers.push('本次会话未记录有效的入场余量门槛');
  if (!Array.isArray(simulation?.verifiedSymbols) || !simulation.verifiedSymbols.includes(symbol)) blockers.push('跨平台合约的经济等价身份尚未核验');
  if (paper.unresolved) blockers.push('全局纸面模拟仍有在途或未决敞口，先核对现有任务');

  const eligible = delayed.find((row) => {
    const matchingRaw = rawRows.find((rawRow) => rawRow.buy === row.buy && rawRow.sell === row.sell);
    return row.sampleReady && knownCosts(row.latest) && row.latest.gatePassed === true
      && row.latest.sourceTimeUncertain === false && thresholdKnown && row.latest.surplusBeforeRebateBps >= simulation.minEntryEdgeBps
      && finite(row.lastAt) && row.lastAt <= row.latest.at && recent(row.latest.at, now, evidenceMaxAgeMs)
      && knownCosts(matchingRaw?.latest) && matchingRaw.latest.sourceTimeUncertain === false
      && finite(matchingRaw.lastAt) && matchingRaw.lastAt <= matchingRaw.latest.at
      && recent(matchingRaw.latest.at, now, evidenceMaxAgeMs);
  });
  const selectedRaw = eligible ? rawRows.find((row) => row.buy === eligible.buy && row.sell === eligible.sell) || rawMetrics : rawMetrics;
  const selectedDelayed = eligible || delayed.find((row) => row.buy === selectedRaw?.buy && row.sell === selectedRaw?.sell) || null;
  const selectedEvaluation = selectedRaw?.latest || null;
  const buyCash = selectedEvaluation && nonnegative(selectedEvaluation.buyNotional) ? selectedEvaluation.buyNotional : null;
  const sellCash = selectedEvaluation && nonnegative(selectedEvaluation.sellNotional) ? selectedEvaluation.sellNotional : null;
  const result = { status: 'waiting', title: '等待新样本', reason: '尚未取得本次会话的双向成本与延迟观察。',
    direction: selectedRaw ? { buy: selectedRaw.buy, sell: selectedRaw.sell } : null,
    raw: selectedEvaluation, rawMetrics: selectedRaw, delayed, bestDelayed: selectedDelayed,
    notional: { buyCash, sellCash, approxRoundTripTurnoverCash: buyCash === null || sellCash === null ? null : 2 * (buyCash + sellCash) },
    blockers, nextSteps: [], caveat };

  if (symbol === 'ANTH') {
    result.status = 'verify_equivalence';
    result.title = '先核验是否为同一经济标的';
    result.reason = '即使 ANTH 长期相差 2%–3%，也可能来自标的、合约权利或结算口径不同；目前不建议做基差收敛套利。';
    result.nextSteps = ['先逐项核对两侧合约的底层权益、乘数、计价与结算规则。', '经济等价核验完成后，再重新积累同一会话的成本与延迟证据。'];
    return result;
  }
  if (stopped) {
    result.status = 'stopped'; result.title = '采集已停止，保留历史观察';
    result.reason = '历史金额与样本仍可查看，恢复同一口径的新观察后再判断是否值得纸面验证。';
  } else if (!hasParameters || !hasStudy) {
    result.reason = !hasParameters ? '这份历史报告未记录会话参数，手续费与延迟假设未知；等待新会话样本。' : '等待新报告中的双向价差、整轮成本与延迟后余量。';
  } else if (!live && report) {
    result.status = 'stale'; result.title = '当前报告待更新';
    result.reason = '报告已超出观察窗口或不属于当前运行会话，暂时撤回策略筛选结论，保留历史数值。';
  } else if (!selectedEvaluation) {
    result.reason = '等待新报告中的双向价差、整轮成本与延迟后余量。';
  } else if (!recent(selectedEvaluation.at, now, evidenceMaxAgeMs)
    || (selectedDelayed?.latest && !recent(selectedDelayed.latest.at, now, evidenceMaxAgeMs))) {
    result.title = '最近研究样本待更新';
    result.reason = '最近研究样本已停更，保留历史数值，等待双腿重新同步。';
  } else if (!feesKnown || !knownCosts(selectedEvaluation)) {
    result.status = 'unknown_costs'; result.title = '成本未齐，暂不能判断优势';
    result.reason = '可见价差还不能当作可赚金额；至少一侧手续费或整轮预算未知，缺失值不会按零计算。';
  } else if (eligible && blockers.length === 0) {
    result.status = 'paper_candidate'; result.title = 'SNDK 值得进行纸面验证';
    result.reason = '至少一组延迟情景达到研究筛选门槛，最近采样的成本后余量也达标；这只支持继续做纸面验证。';
  } else if (knownCosts(selectedEvaluation) && selectedEvaluation.surplusBeforeRebateBps > 0 && selectedDelayed && knownCosts(selectedDelayed.latest) && selectedDelayed.latest.surplusBeforeRebateBps <= 0) {
    result.status = 'latency_erases_edge'; result.title = '速度吃掉了原本的优势';
    result.reason = '该买卖方向不考虑等待时的成本后余量为正，加入两侧延迟后转负；当前不建议推进这条价差策略。';
  } else if (selectedEvaluation.surplusBeforeRebateBps <= 0 && !delayed.some((row) => knownCosts(row.latest) && row.latest.surplusBeforeRebateBps > 0)) {
    result.status = 'no_edge'; result.title = '当前价差覆盖不了整轮成本';
    result.reason = '按两种买卖方向比较，最近已知的成本后余量没有优势；110% / 120% 返佣假设不会把它升级为策略候选。';
  } else if (!eligible) {
    result.status = 'insufficient_samples'; result.title = '有观察价值，证据还不够';
    result.reason = '继续筛选至少需要同一延迟情景 30 个源时间可信且成本完整的样本，这些有效样本跨度 5 分钟、全部观察完成率 80%、有效样本成本后达标率 75%，且最近采样余量达到会话门槛。';
  } else {
    result.status = 'blocked'; result.title = '先补齐当前验证条件';
    result.reason = blockers.join('；');
  }
  if (result.status === 'paper_candidate') {
    result.nextSteps = ['只继续纸面模拟；等待通过严格时效检查的新盘口，再由现有纸面执行门槛触发。', '逐笔核对延迟后成交、失败腿和退出成本，记录每腿金额与大致单轮周转，不外推每天成交额或每笔盈利。'];
  } else if (result.status === 'unknown_costs') {
    result.nextSteps = ['填写本次会话可核对的实际手续费，再重新开始采样。', '返佣保持单独的未到账情景，先看不含返佣的余量。'];
  } else if (result.status === 'latency_erases_edge' || result.status === 'no_edge') {
    result.nextSteps = ['继续比较两种买卖方向的成本后余量，优先观察更宽且能持续到延迟后的价差。', '先确认报价与成本口径，不从返佣假设推导盈利。'];
  } else {
    result.nextSteps = [...blockers.slice(0, 2), '积累同一会话的完整延迟样本，再判断是否值得纸面验证。'];
  }
  return result;
}

export function buildResearchInsights({ report = null, serverNow, running = false, reportCurrent = false } = {}) {
  const observedAt = nullable(report?.observedAt);
  const asOf = nullable(report?.observation?.asOf);
  const windowMs = nonnegative(report?.observation?.silenceAfterMs) && report.observation.silenceAfterMs > 0 ? report.observation.silenceAfterMs : 10000;
  const validTime = observedAt !== null && finite(serverNow) && serverNow >= observedAt - 100;
  const reportAgeMs = validTime ? Math.max(0, serverNow - observedAt) : null;
  const stopped = Boolean(report && (running !== true || report.stopped === true));
  const live = Boolean(report && running === true && !report.stopped && reportCurrent === true && validTime
    && recent(asOf, serverNow, windowMs) && reportAgeMs <= windowMs);
  const simulation = report?.sessionConfig?.simulation;
  const intervalMs = nonnegative(report?.opportunityStudy?.sampleIntervalMs) && report.opportunityStudy.sampleIntervalMs > 0 ? report.opportunityStudy.sampleIntervalMs : 10000;
  const maxScenarioDelayMs = Math.max(0, ...(Array.isArray(simulation?.latencyScenarios) ? simulation.latencyScenarios : [])
    .flatMap((scenario) => [scenario?.entropyMs, scenario?.lighterMs]).filter(nonnegative));
  const evidenceMaxAgeMs = Math.max(10000, intervalMs + maxScenarioDelayMs + (nonnegative(simulation?.fillWaitMs) ? simulation.fillWaitMs : 0) + 5000);
  const hasParameters = Boolean(simulation && typeof simulation === 'object');
  const hasStudy = Boolean(report?.opportunityStudy?.bySymbol && typeof report.opportunityStudy.bySymbol === 'object');
  const paper = paperState(report);
  const bySymbol = Object.fromEntries(SYMBOLS.map((symbol) => [symbol, symbolInsights({ symbol, report, simulation,
    live, reportAgeMs, windowMs, evidenceMaxAgeMs, now: serverNow, paper, hasParameters, hasStudy, stopped })]));
  const main = bySymbol.SNDK;
  return { asOf, reportAgeMs, evidenceMaxAgeMs, reportCurrent: live,
    summary: { status: main.status, title: main.title, reason: main.reason }, bySymbol,
    leader: leaderInsights(report), paper };
}
