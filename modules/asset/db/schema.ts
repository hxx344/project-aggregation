import { sqliteTable, text, integer, primaryKey } from 'drizzle-orm/sqlite-core';
export const assets = sqliteTable('assets', { owner: text('owner').notNull(), id: text('id').notNull(), data: text('data').notNull() }, t => [primaryKey({columns:[t.owner,t.id]})]);
export const settings = sqliteTable('settings', { owner: text('owner').notNull(), key: text('key').notNull(), value: text('value').notNull() }, t => [primaryKey({columns:[t.owner,t.key]})]);
export const connections = sqliteTable('connections', { owner: text('owner').notNull(), exchange: text('exchange').notNull(), encrypted: text('encrypted').notNull(), updatedAt: text('updated_at').notNull() }, t => [primaryKey({columns:[t.owner,t.exchange]})]);
export const snapshots = sqliteTable('snapshots', { owner: text('owner').notNull(), date: text('date').notNull(), data: text('data').notNull() }, t => [primaryKey({columns:[t.owner,t.date]})]);
export const locks = sqliteTable('sync_locks', { owner:text('owner').primaryKey(), expires:integer('expires').notNull() });
export const authAttempts = sqliteTable('auth_attempts', { id: text('id').primaryKey(), startedAt: integer('started_at').notNull(), attempts: integer('attempts').notNull() });
