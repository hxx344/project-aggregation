import { DatabaseSync, backup, type StatementSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Value = string | number | null | Uint8Array;
type Prepare = (sql: string) => StatementSync;
class Statement {
  private prepare: Prepare;
  private sql: string;
  private values: Value[];
  constructor(prepare: Prepare, sql: string, values: Value[] = []) {
    this.prepare = prepare; this.sql = sql; this.values = values;
  }
  bind(...values: Value[]) { return new Statement(this.prepare, this.sql, values); }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.prepare(this.sql).get(...this.values) as T | undefined) ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.prepare(this.sql).all(...this.values) as T[] };
  }
  execute() {
    const result = this.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
  async run() { return this.execute(); }
}

export function openDatabase(filename: string, migrations = resolve('drizzle')) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const connection = new DatabaseSync(filename);
  connection.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  connection.exec('CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, hash TEXT NOT NULL)');
  for (const name of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(resolve(migrations, name), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const applied = connection.prepare('SELECT hash FROM _schema_migrations WHERE name = ?').get(name);
    if (applied) {
      if (applied.hash !== hash) throw new Error('数据库迁移文件已改变，请恢复原迁移文件');
      continue;
    }
    connection.exec('BEGIN IMMEDIATE');
    try {
      connection.exec(sql);
      connection.prepare('INSERT INTO _schema_migrations (name, hash) VALUES (?, ?)').run(name, hash);
      connection.exec('COMMIT');
    } catch (error) { connection.exec('ROLLBACK'); connection.close(); throw error; }
  }
  // Cache compiled SQL only. Each wrapper owns its bindings and every call still
  // reads the current database. A bounded cache also handles dynamic query text.
  const statements = new Map<string, StatementSync>();
  const prepare: Prepare = sql => {
    let statement = statements.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      if (statements.size >= 128) statements.delete(statements.keys().next().value!);
      statements.set(sql, statement);
    }
    return statement;
  };
  return {
    prepare: (sql: string) => new Statement(prepare, sql),
    async batch(statements: Statement[]) {
      connection.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map(statement => statement.execute());
        connection.exec('COMMIT');
        return results;
      } catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
    close: () => { statements.clear(); connection.close(); },
    async backup(destination: string) {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      await backup(connection, destination);
    },
  };
}

let database: ReturnType<typeof openDatabase> | undefined;
export function db() {
  return database ??= openDatabase(resolve(process.env.ASSET_DATA_DIR || '.data', 'ledger.sqlite'));
}
