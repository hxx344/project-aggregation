import { randomUUID } from 'node:crypto';
import { HttpError } from '../http-common.mjs';

export const publicDeliveryReviews = value => Array.isArray(value) ? value.slice(-5).filter(item => item && typeof item.id === 'string' && typeof item.at === 'string'
  && typeof item.note === 'string' && item.note.length <= 500 && typeof item.source === 'string' && item.source.length <= 200)
  .map(({ id, at, note, source }) => ({ id, at, actor: 'authenticated_admin', note, source })) : [];

/** A review is a human statement, never a channel acknowledgement. */
export function deliveryReview(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['id', 'note', 'source'].includes(key))
    || typeof input.id !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(input.id)
    || typeof input.note !== 'string' || !input.note.trim() || input.note.length > 500
    || typeof input.source !== 'string' || !input.source.trim() || input.source.length > 200) throw new HttpError(400, '请提供投递编号、核对说明（最多500字）与证据来源（最多200字）');
  if (/(?:private.?key|secret|signature|authorization|password)\s*[:=]|\/bot\/v2\/hook\//i.test(`${input.note} ${input.source}`)) throw new HttpError(400, '核对说明不可包含凭据或完整签名');
  return { id: randomUUID(), at: new Date(now).toISOString(), actor: 'authenticated_admin', note: input.note.trim(), source: input.source.trim() };
}
