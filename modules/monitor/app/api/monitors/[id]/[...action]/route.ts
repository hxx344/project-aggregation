import { getMonitor } from "../../../../../lib/monitors";
import { readMonitorData } from "../../../../../lib/monitor-service";
import { exchangeFromAction, supportsExchange } from "../../../../../lib/exchange-quotes";
import { OIL_CANDLE_ACTION } from "../../../../../modules/oil/intraday.mjs";
import { unavailablePerpetualOpportunities } from "../../../../../lib/perpetual-opportunities.ts";
import { fundingExchangeFromAction } from '../../../../../lib/exchange-funding-history.ts';
import { OIL_HEDGE_PRICES_ACTION } from '../../../../../lib/oil-hedge-prices.ts';
import { GOLD_OIL_EXCHANGES, parseGoldOilAction } from '../../../../../lib/gold-oil.ts';
import { unavailablePerpetualSummary } from '../../../../../lib/perpetual-summary.ts';

export async function GET(_request: Request, context: { params: Promise<{ id: string; action: string[] }> }) {
  const { id, action } = await context.params;
  const name = action.join("/");
  const monitor = getMonitor(id);
  const exchange = exchangeFromAction(name);
  const fundingExchange = fundingExchangeFromAction(name);
  const hedgePrices = name === OIL_HEDGE_PRICES_ACTION;
  const goldOil = id === 'cl-xau' ? parseGoldOilAction(name) : null;
  const capability = goldOil?.action ?? name;
  const headers = { "Cache-Control": "no-store" };
  if (!monitor) return Response.json({ error: "监控模块不存在" }, { status: 404, headers });
  if (id === 'oil' && name === 'exchanges/variational/session') return Response.json({ available: false, configured: false, revision: 0, expiresAt: null, updatedAt: null, status: 'unavailable', error: '当前为网页预览，连接常驻监控服务后可更新 Var token。' }, { headers });
  if (name === 'runtime') return Response.json({ available: false, monitorId: id, enabled: true, revision: 0, running: false, reason: '当前为网页预览，连接常驻监控服务后可控制开关。' }, { headers });
  if (id === 'perpetual' && name === 'summary') return Response.json(unavailablePerpetualSummary(), { headers });
  if (id === "perpetual" && name === "opportunities") return Response.json(unavailablePerpetualOpportunities(), { headers });
  if (id === "perpetual" && name === "opportunities-v2") return Response.json({ ...unavailablePerpetualOpportunities(), schemaVersion: 2, fx: null }, { headers });
  if (id === "perpetual" && name === "crossex-settings") return Response.json({ available: false, generatedAt: Date.now(), revision: 0, metadataRevision: 0, spotTransferPairs: [], config: { requireSpotTransfer: false, blockedBases: [] }, venues: [], error: "当前网页预览没有常驻后台，无法保存 CrossEx 推送筛选。" }, { headers });
  if (id === "perpetual" && name === "paper") return Response.json({ available: false, generatedAt: Date.now(), revision: 0, running: false, error: "当前为网页行情版，请通过 Linux 一键部署启用持仓跟踪。", positions: [] }, { headers });
  if (exchange && !supportsExchange(id, exchange)) return Response.json({ error: '模块不支持此接口' }, { status: 404, headers });
  if (fundingExchange && id !== 'oil') return Response.json({ error: '模块不支持此接口' }, { status: 404, headers });
  if (hedgePrices && id !== 'oil') return Response.json({ error: '模块不支持此接口' }, { status: 404, headers });
  if (goldOil?.action === 'status') return Response.json({ available: false, monitorId: id, oilType: goldOil.oilType, exchange: goldOil.exchange, source: GOLD_OIL_EXCHANGES[goldOil.exchange].name, reason: '当前为网页行情版。Linux 一键部署后可运行常驻监控并保存飞书告警。' }, { headers });
  if (["alerts", "status"].includes(name)) return Response.json({ available: false, monitorId: id, reason: "当前为网页行情版。Linux 一键部署后可运行常驻监控并保存飞书告警。" }, { headers });
  if ((!exchange && !fundingExchange && !hedgePrices && !["quote", "history", "funding", OIL_CANDLE_ACTION].includes(capability)) || !monitor.capabilities.includes(exchange || fundingExchange || hedgePrices ? "quote" : capability)) return Response.json({ error: "模块不支持此接口" }, { status: 404, headers });
  try { return Response.json(await readMonitorData(id, name), { headers }); }
  catch { return Response.json({ error: "行情暂不可用，请稍后重试" }, { status: 503, headers }); }
}
