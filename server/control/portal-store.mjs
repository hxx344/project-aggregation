import { immediate } from './schema.mjs';

// Portal tickets and grants in hub.sqlite, shared by every API instance
// (docs/api-dual-slot.md 4.3). Rows are keyed by the token's SHA-256 digest;
// the browser keeps the token itself. Callers pass the Portal's clock.
const PRUNE_BATCH = 500;
const record = row => row && { projectId: row.project_id, sessionId: row.session_id, revision: row.revision, expires: row.expires };

export function createPortalStore({ db, stmt }) {
  const live = (table, now) => stmt.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE expires>?`).get(now).n;
  return {
    // Stores a ticket unless `limit` unexpired tickets, or grants counting `held` kept elsewhere, exist; false when refused.
    issueTicket: (digest, { projectId, sessionId, revision, destination, expires }, now, limit, held = 0) => immediate(db, () => {
      if (live('portal_tickets', now) >= limit || live('portal_grants', now) + held >= limit) return false;
      stmt.prepare('INSERT INTO portal_tickets(digest,project_id,session_id,revision,destination,expires) VALUES (?,?,?,?,?,?)').run(digest, projectId, sessionId, revision, destination, expires);
      return true;
    }),
    // Removes and returns an unexpired ticket of the project: of concurrent callers, only one gets it.
    // A ticket presented to another project's host stays for its own.
    takeTicket: (digest, projectId, now) => immediate(db, () => {
      const row = stmt.prepare('DELETE FROM portal_tickets WHERE digest=? AND project_id=? RETURNING *').get(digest, projectId);
      return row && row.expires > now ? { ...record(row), destination: row.destination } : null;
    }),
    issueGrant: (digest, { projectId, sessionId, revision, expires }, now, limit, held = 0) => immediate(db, () => {
      if (live('portal_grants', now) + held >= limit) return false;
      stmt.prepare('INSERT INTO portal_grants(digest,project_id,session_id,revision,expires) VALUES (?,?,?,?,?)').run(digest, projectId, sessionId, revision, expires);
      return true;
    }),
    grant: digest => { const row = stmt.prepare('SELECT * FROM portal_grants WHERE digest=?').get(digest); return row ? { ...record(row), digest } : null; },
    liveGrants: now => live('portal_grants', now),
    // Every stored grant with its digest, for the Portal's liveness sweep.
    grants: () => stmt.prepare('SELECT * FROM portal_grants').all().map(row => ({ ...record(row), digest: row.digest })),
    revokeGrants: digests => immediate(db, () => { for (const digest of digests) stmt.prepare('DELETE FROM portal_grants WHERE digest=?').run(digest); }),
    // The same without waiting for another writer: throws at once while the database is busy.
    tryRevokeGrants: digests => {
      const { timeout } = db.prepare('PRAGMA busy_timeout').get();
      db.exec('PRAGMA busy_timeout=0');
      try { return immediate(db, () => { for (const digest of digests) stmt.prepare('DELETE FROM portal_grants WHERE digest=?').run(digest); }); }
      finally { db.exec(`PRAGMA busy_timeout=${Number(timeout)}`); }
    },
    // Deletes at most PRUNE_BATCH expired rows of each table per call.
    prune: now => {
      for (const table of ['portal_tickets', 'portal_grants']) stmt.prepare(`DELETE FROM ${table} WHERE digest IN (SELECT digest FROM ${table} WHERE expires<=? LIMIT ${PRUNE_BATCH})`).run(now);
    },
  };
}
