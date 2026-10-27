/**
 * The store: a single SQLite file, opened through `node:sqlite`.
 *
 * `node:sqlite` ships with Node 22.5+ and needs no native build, which is the
 * whole reason this plugin has zero dependencies and no install step. It is
 * still marked experimental, so the warning it prints on first use is expected.
 *
 * Everything the rest of the plugin does goes through the small surface below:
 * `all` / `get` / `run` for statements and `tx` for a transaction. Nothing else
 * touches the driver, so swapping it out later means editing this one file.
 */

import { DatabaseSync } from 'node:sqlite'
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { MIGRATIONS, SCHEMA_VERSION } from './schema.js'

/** 迁移前自动备份保留几份。够覆盖「最后一次升级前」，又不至于把盘塞满。 */
export const BACKUP_KEEP = 5

/** Open (creating if needed) the plugin's database and bring it up to date. */
export function openStore({ dataDir, logger = console }) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, 'amazon-ops.db')

  const db = new DatabaseSync(file)
  // WAL keeps a reader (the page polling state) from blocking the writer (a
  // collection task), and survives the process being killed mid-write.
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  // Wait rather than throw when another connection holds the write lock.
  db.exec('PRAGMA busy_timeout = 5000')

  const { applied, backup } = migrate(db, logger, { file, dataDir })

  const store = {
    file,
    raw: db,
    appliedMigrations: applied,
    /** 本次打开时、迁移前自动做的那份备份（没做备份就是 null）。 */
    preMigrationBackup: backup,

    all(sql, params = []) {
      return db.prepare(sql).all(...params)
    },

    get(sql, params = []) {
      return db.prepare(sql).get(...params)
    },

    run(sql, params = []) {
      return db.prepare(sql).run(...params)
    },

    exec(sql) {
      db.exec(sql)
    },

    /** Run `fn` inside a transaction; a throw rolls the whole thing back. */
    tx(fn) {
      db.exec('BEGIN')
      try {
        const result = fn()
        db.exec('COMMIT')
        return result
      } catch (error) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* the transaction was already rolled back by SQLite */
        }
        throw error
      }
    },

    close() {
      db.close()
    },
  }

  return store
}

/**
 * 把当前库整份拷到 `<dataDir>/backups/`，并只保留最近 `keep` 份。
 *
 * ⚠️ 必须先 `wal_checkpoint(TRUNCATE)`：库里是 WAL 模式，还没 checkpoint 的页
 * 还在 `-wal` 文件里，**直接 copy 那个 `.db` 会得到一份旧数据甚至缺页的备份**。
 * checkpoint 之后 WAL 被清空、主文件才是完整的。
 *
 * 返回备份的绝对路径。
 */
export function backupStoreFile(db, file, dataDir, { keep = BACKUP_KEEP, at = new Date() } = {}) {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const dir = join(dataDir, 'backups')
  mkdirSync(dir, { recursive: true })

  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  const target = join(dir, `amazon-ops-v${version}-${stamp}.db`)
  copyFileSync(file, target)

  const kept = readdirSync(dir)
    .filter((name) => /^amazon-ops-v\d+-.*\.db$/.test(name))
    .sort()
  for (const name of kept.slice(0, Math.max(0, kept.length - keep))) {
    // 备份文件头里带着 journal_mode=WAL，所以谁打开过它（哪怕是只读打开），
    // 旁边就会多出 `-wal` / `-shm` 边车。只删 `.db` 会把这些边车留在目录里，
    // 越积越多，而且看着像还有备份在。一并清掉。
    for (const side of ['', '-wal', '-shm']) {
      rmSync(join(dir, name + side), { force: true })
    }
  }

  return target
}

/**
 * Apply every migration above the store's current `user_version`.
 *
 * Each step is its own transaction, so a failure leaves the store at the last
 * version that fully succeeded instead of half-migrated.
 *
 * 迁移是**唯一不可逆**的批量动作：48 步里任何一步写错，库就停在一个中间版本。
 * 所以只要有东西要升（`0 < current < SCHEMA_VERSION`），就先整份备份再动手。
 * 全新的空库（current === 0）不备份 —— 它没有数据可丢。
 */
function migrate(db, logger, { file, dataDir } = {}) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  const applied = []

  let backup = null
  if (file && dataDir && current > 0 && current < SCHEMA_VERSION) {
    backup = backupStoreFile(db, file, dataDir)
    logger?.info?.(`[amazon-ops] 迁移前已备份 v${current} → ${backup}`)
  }

  for (const step of MIGRATIONS) {
    if (step.version <= current) continue
    db.exec('BEGIN')
    try {
      db.exec(step.sql)
      // user_version takes a literal, not a binding, so the value is validated
      // as an integer here rather than interpolated from anywhere else.
      const version = Math.trunc(Number(step.version))
      if (!Number.isFinite(version) || version < 0) throw new Error(`bad migration version ${step.version}`)
      db.exec(`PRAGMA user_version = ${version}`)
      db.exec('COMMIT')
      applied.push(`${step.version}:${step.name}`)
      logger?.info?.(`[amazon-ops] migrated store to v${step.version} (${step.name})`)
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* nothing to roll back */
      }
      const hint = backup ? `（迁移前备份在 ${backup}，可拷回 data 目录回滚）` : ''
      throw new Error(`migration ${step.version} (${step.name}) failed: ${error.message}${hint}`)
    }
  }

  return { applied, backup }
}

/** ISO-8601 UTC, the only timestamp format this store writes. */
export function nowIso() {
  return new Date().toISOString()
}
