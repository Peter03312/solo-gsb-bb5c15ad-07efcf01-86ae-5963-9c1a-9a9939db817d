import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let _db = null;

export function getDb() {
  if (_db) return _db;
  const dbFile = process.env.DB_FILE || join(__dirname, '..', '..', 'data', 'orienteering.db');
  mkdirSync(dirname(dbFile), { recursive: true });
  _db = new Database(dbFile);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

export function initDb(db = getDb()) {
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  migratePunchOriginals(db);
}

/**
 * 旧库迁移：为 punch 增补「首次入库原始读数」列。
 * 首次入库后只有裁判更正会改 point/seconds，且每条 correct 审计的
 * orig_point/orig_seconds 记录的是「更正发生时的现值」；因此取最早一条
 * correct 审计即得最初读数（多次更正后仍准确）。无审计的记录原值即现值。
 * 幂等：列已存在时直接返回。
 */
function migratePunchOriginals(db) {
  const cols = db.prepare("PRAGMA table_info(punch)").all().map((c) => c.name);
  if (cols.includes('orig_point')) return;
  db.exec('ALTER TABLE punch ADD COLUMN orig_bib TEXT');
  db.exec('ALTER TABLE punch ADD COLUMN orig_point TEXT');
  db.exec('ALTER TABLE punch ADD COLUMN orig_seconds INTEGER');
  db.exec('ALTER TABLE punch ADD COLUMN orig_kind TEXT');
  db.prepare(
    `UPDATE punch
        SET orig_bib = bib,
            orig_point = COALESCE(
              (SELECT a.orig_point FROM punch_audit a
               WHERE a.punch_id = punch.id AND a.action = 'correct'
               ORDER BY a.id LIMIT 1), point),
            orig_seconds = COALESCE(
              (SELECT a.orig_seconds FROM punch_audit a
               WHERE a.punch_id = punch.id AND a.action = 'correct'
               ORDER BY a.id LIMIT 1), seconds),
            orig_kind = kind`
  ).run();
}

/** 推进赛事修订号并返回新值（任何配置/读数/更正变化都使旧修订过期） */
export const bumpRevision = db =>
  db.prepare('UPDATE event SET revision = revision + 1 WHERE id = 1 RETURNING revision').get().revision;

export function currentRevision(db = getDb()) {
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  return row ? row.revision : null;
}
