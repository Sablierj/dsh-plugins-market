/**
 * 存储层：单文件 SQLite，走 `node:sqlite`（Node 24 自带，零依赖、无编译）。
 *
 * 唯一入口是 openStore()：它建库、跑迁移、给一个极小的语句面（all/get/run/tx）。
 * 其余模块只认这个面，将来换驱动只改这一个文件。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

export function openStore({ dataDir, logger = console } = {}) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'sif.db')
  const db = new DatabaseSync(file)

  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')

  db.exec('CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL)')
  const row = db.prepare('SELECT version FROM schema_meta LIMIT 1').get()
  let current = row?.version ?? 0

  const applied = []
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.exec('BEGIN')
    try {
      for (const statement of migration.statements) db.exec(statement)
      if (current === 0) db.prepare('INSERT INTO schema_meta (version) VALUES (?)').run(migration.version)
      else db.prepare('UPDATE schema_meta SET version = ?').run(migration.version)
      db.exec('COMMIT')
      current = migration.version
      applied.push(migration.version)
    } catch (error) {
      db.exec('ROLLBACK')
      throw new Error(`迁移 v${migration.version} 失败：${error.message}`)
    }
  }
  if (applied.length) logger.info?.(`[sif-ops] db migrated ${applied.join(', ')} → v${current}`)

  const store = {
    file,
    version: current,
    schemaVersion: SCHEMA_VERSION,
    raw: db,
    all: (sql, params = []) => db.prepare(sql).all(...params),
    get: (sql, params = []) => db.prepare(sql).get(...params),
    run: (sql, params = []) => db.prepare(sql).run(...params),
    exec: sql => db.exec(sql),
    /** 事务：抛错整体回滚。返回 fn 的结果。 */
    tx(fn) {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    close() {
      try {
        db.close()
      } catch {
        /* 已关 */
      }
    },
  }
  return store
}
