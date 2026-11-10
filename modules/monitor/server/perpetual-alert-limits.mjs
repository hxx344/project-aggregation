export const PERPETUAL_ALERT_FILE_BYTES = 1_000_000;
// Leave at least 600 KB for the bounded rules, original delivery facts and
// subsequent sending -> confirmed/failed/unknown transitions. Notes cannot
// consume the space needed to persist a channel outcome.
export const PERPETUAL_REVIEW_BYTES = 400_000;
const encoded = value => `${JSON.stringify(value)}\n`;

export function boundedPerpetualAlertState(value) {
  const state = structuredClone(value);
  if (state.deliveryReviews !== undefined) {
    const retained = new Set(state.history.map(item => item.id));
    state.deliveryReviews = Object.fromEntries(Object.entries(state.deliveryReviews).filter(([id]) => retained.has(id))
      .map(([id, notes]) => [id, Array.isArray(notes) ? notes.slice(-5) : []]));
    if (Buffer.byteLength(encoded(state.deliveryReviews), 'utf8') > PERPETUAL_REVIEW_BYTES) {
      throw Object.assign(new Error('人工核对备注已达到 400 KB 保留预算，本次未保存；请待原投递记录过期后再记录。原始发送事实保持不变。'), { status: 413 });
    }
  }
  const body = encoded(state);
  if (Buffer.byteLength(body, 'utf8') > PERPETUAL_ALERT_FILE_BYTES) {
    throw Object.assign(new Error('机会提醒状态超过保存上限，本次未保存；原始发送事实保持不变。'), { status: 413 });
  }
  return { state, body };
}
