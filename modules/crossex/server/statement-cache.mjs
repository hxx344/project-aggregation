// Cache only synchronous get/all/run statements, never query results or iterators.
export function createStatementCache(db, limit = 128) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Statement cache limit must be a positive integer');
  const statements = new Map();
  return {
    prepare(sql) {
      if (statements.has(sql)) return statements.get(sql);
      const statement = db.prepare(sql);
      if (statements.size >= limit) statements.delete(statements.keys().next().value);
      statements.set(sql, statement);
      return statement;
    },
    clear() { statements.clear(); },
  };
}
