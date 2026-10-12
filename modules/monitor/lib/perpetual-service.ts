/** Stateless previews do not own a long-lived feed. Production Node serves the same path. */
export async function loadPerpetualSnapshot() {
  return {
    schemaVersion: 1, monitorId: 'perpetual', status: 'unavailable', generatedAt: Date.now(),
    staleAfterMs: 30_000, exchanges: [], quotes: [],
    note: '合约 WebSocket 采集需要常驻后台。请使用 Linux 一键部署，或在 Windows 构建后运行 npm run start:windows。',
  };
}
