import type { PerpetualExchange } from './perpetual-types.ts';

export interface PerpetualVenueHealth extends PerpetualExchange {
  sourceLagMs: number | null; sourceLagObservedAt?: number | null;
  reconnects: number; rejectedFuture: number; lastProtocolError: string | null;
}
export interface PerpetualDiagnostics {
  generatedAt: number; cpuPercent: number; rssMb: number; eventLoopP99Ms: number;
  messagesPerSecond: number; lastWriteMs: number; lastPublishMs: number;
  pendingWrites: number; quotes: number; clients: number; connections: number;
  lastPatchVisitedQuotes: number; storageError: string | null;
  observations?: number; pendingObservations?: number;
  collection?: { observationIntervalMs: number; discoveryIntervalMs: number; marketMetricsIntervalMs: number; auxiliaryBookIntervalMs: number };
  venues: PerpetualVenueHealth[];
  events: { id: number; exchange: string; kind: string; reason: string; at: number }[];
}

/** Explanations reuse existing measurements; a fresh heartbeat cannot prove a fresh book. */
export function venueHealthReason(venue: PerpetualVenueHealth, now: number): string {
  if (venue.error) return venue.error;
  if (venue.lastProtocolError) return `最近接口反馈：${venue.lastProtocolError}`;
  if (!venue.marketCount) return '等待合约目录';
  if (!venue.lastMessageAt) return '已发现合约，等待首批有效行情';
  if (venue.sourceLagMs !== null && venue.sourceLagMs < -5_000 && (!venue.sourceLagObservedAt || now - venue.sourceLagObservedAt <= 30_000)) return '源时间领先服务器，请核对服务器时钟';
  if (now - venue.lastMessageAt > 30_000) return '超过 30 秒未收到有效行情，检查连接及上游接口';
  if (venue.status && venue.status !== 'live') return '平台连接未在线，保留的盘口仅供核对';
  if ((venue.staleBookCount ?? 0) > 0) return '连接仍有数据，部分买卖盘口超过 30 秒未确认';
  if ((venue.missingBookCount ?? 0) > 0) return '部分合约尚无完整买卖盘口';
  return '盘口更新正常';
}
