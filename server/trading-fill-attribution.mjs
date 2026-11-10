import { createHash } from 'node:crypto';
import { createStatementCache } from './db-cache.mjs';

const digest = (exchange, identity) => createHash('sha256').update(`${exchange}:${identity}`).digest('hex');
const key = (exchange, symbol, orderId) => JSON.stringify([exchange, symbol, orderId]);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const revision = value => Number.isSafeInteger(value) && value >= 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
const nativeLeg = leg => leg.exchange === 'rh-lighter' && leg.symbol === 'ANTHROPIC' ? 'rh'
  : leg.exchange === 'hyperliquid' && leg.symbol === 'xyz:ANT' ? 'xyz' : leg.exchange === 'hyperliquid' && leg.symbol === 'io:ANTH' ? 'io' : null;

/** Read-only attribution. No network, credentials, inferred pairing or cached execution state.
 * Only requested order ids are projected; statements are reused on this DB connection.
 * Account revisions in consumed previews preserve evidence across resumed job phases. */
export function createFillAttribution({ db, stmt = createStatementCache(db) }) {
  return function attribute(data, nativeSource, nativeBindings = []) {
    const ids = new Set();
    for (const source of data.sources) for (const exchange of source.data?.exchanges ?? []) for (const account of exchange.accounts) {
      for (const scope of account.scopes) for (const fill of scope.fills) {
        if (typeof fill.orderId === 'string' && fill.orderId.length > 0 && fill.orderId.length <= 200) ids.add(fill.orderId);
      }
    }
    const rows = ids.size ? stmt.prepare(`SELECT job_id,json AS order_json FROM execution_orders
      WHERE json_extract(json,'$.remoteId') IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...ids])) : [];
    // A batch can contain thousands of fills/orders. Read and parse each task once,
    // including its event history, instead of duplicating it in every joined row.
    const jobIds = [...new Set(rows.map(row => row.job_id))];
    const jobData = new Map(jobIds.length ? stmt.prepare(`SELECT id,json FROM execution_jobs
      WHERE id IN (SELECT value FROM json_each(?)) AND json_extract(json,'$.plan.market')='anthropic'`)
      .all(JSON.stringify(jobIds)).map(row => [row.id, parse(row.json)]) : []);
    const candidates = new Map(), jobs = new Map();
    for (const row of rows) {
      const job = jobData.get(row.job_id), order = parse(row.order_json);
      if (!job || !order || !uuid(job.id) || order.jobId !== job.id || !revision(order.accountRevision) || !revision(order.phase) || !revision(order.batch)) continue;
      // Resuming replaces plan.legs with only the unfilled remainder; totals is the original combination.
      const legs = job.totals;
      if (!Array.isArray(legs) || legs.length !== 2 || legs[0].side === legs[1].side) continue;
      const native = legs.find(leg => nativeLeg(leg)), cex = legs.find(leg => ['binance', 'okx'].includes(leg.exchange) && leg.symbol === 'ANTHROPICUSDT');
      if (!native || !cex || !legs.some(leg => leg.id === order.legId && leg.exchange === order.exchange && leg.symbol === order.spec?.symbol)) continue;
      const symbol = order.exchange === 'okx' ? order.spec.instrumentId : order.spec.symbol;
      if (!symbol || typeof order.remoteId !== 'string') continue;
      const item = { job, order, association: { jobId: job.id, phase: order.phase, batch: order.batch, comparisonLeg: nativeLeg(native), cex: cex.exchange } };
      const identity = key(order.exchange, symbol, order.remoteId);
      const list = candidates.get(identity) ?? []; list.push(item); candidates.set(identity, list);
      jobs.set(job.id, [job.plan]);
    }
    if (jobs.size) for (const row of stmt.prepare('SELECT consumed,json FROM execution_previews WHERE consumed IN (SELECT value FROM json_each(?))').all(JSON.stringify([...jobs.keys()]))) {
      const plan = parse(row.json); if (plan) jobs.get(row.consumed).push(plan);
    }
    const current = new Map(jobs.size ? stmt.prepare('SELECT exchange,revision,identity,account_mode FROM execution_accounts').all().map(row => [row.exchange, row]) : []);
    const accountProofs = new Map();
    const accountFor = ({ job, order }) => {
      const proofKey = key(job.id, order.exchange, order.accountRevision);
      if (accountProofs.has(proofKey)) return accountProofs.get(proofKey);
      const proofs = (jobs.get(job.id) ?? []).flatMap(plan => plan.connections ?? []).filter(connection =>
        connection.exchange === order.exchange && connection.revision === order.accountRevision && typeof connection.identity === 'string' && connection.identity);
      const live = current.get(order.exchange);
      if (live?.revision === order.accountRevision && live.identity) proofs.push({ identity: live.identity, accountMode: live.account_mode });
      const identities = new Set(proofs.map(proof => JSON.stringify([proof.identity, proof.accountMode])));
      const proof = identities.size === 1 ? proofs[0] : null;
      accountProofs.set(proofKey, proof); return proof;
    };
    return { ...data, sources: data.sources.map(source => !source.data ? source : { ...source, data: { ...source.data,
      exchanges: source.data.exchanges.map(exchange => ({ ...exchange, accounts: exchange.accounts.map(account => ({ ...account,
        scopes: account.scopes.map(scope => {
          const { accountIdentity, ...publicScope } = scope;
          const binding = source === nativeSource ? nativeBindings.find(row => row.exchange === exchange.id && row.connected && row.identity) : null;
          return { ...publicScope, fills: scope.fills.map(fill => {
            const { execution: _untrusted, attribution: _untrustedReason, ...plain } = fill;
            const owned = (candidates.get(key(exchange.id, fill.symbol, fill.orderId)) ?? []).filter(candidate => {
              const { order } = candidate, proof = accountFor(candidate);
              if (!proof) return false;
              if (binding) return proof.identity === binding.identity && order.accountRevision === binding.revision;
              if (!['binance', 'okx'].includes(exchange.id) || accountIdentity !== digest(exchange.id, proof.identity)) return false;
              return exchange.id !== 'binance' || scope.id === (proof.accountMode === 'portfolio-margin' ? 'pm-um' : proof.accountMode === 'standard' ? 'um' : null);
            });
            const matches = owned.filter(({ order }) => order.spec.side === fill.side
              && (order.spec.positionSide === 'BOTH' ? 'net' : order.spec.positionSide?.toLowerCase()) === fill.positionSide);
            // Only disclose a direction mismatch after account ownership is proven. Missing,
            // foreign-account and wrong-contract candidates deliberately share one public reason.
            const reason = !fill.orderId ? 'missing-order' : matches.length === 1 ? 'matched'
              : matches.length > 1 ? 'ambiguous' : owned.length ? 'direction-mismatch' : 'insufficient-evidence';
            const attribution = { reason, updatedAt: data.generatedAt ?? source.data.generatedAt ?? null };
            return matches.length === 1 ? { ...plain, execution: matches[0].association, attribution } : { ...plain, attribution };
          }) };
        }),
      })) })),
    } }) };
  };
}
