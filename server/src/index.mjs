import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, initDb, bumpRevision, currentRevision } from './db.mjs';
import { loadConfig, computeResults } from './scoring.mjs';
import { seedDemo } from './seed.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '5mb' }));

const db = getDb();
initDb(db);
if (process.env.SEED === '1') seedDemo(db);

// ---------- 工具 ----------
function badRequest(res, message) {
  return res.status(400).json({ error: message });
}
/** 修订号核对：导入/发布等操作须基于当前赛事修订，过期返回当前修订。
 *  通过返回 true；过期/非法时已写出响应并返回 false。空库修订为 0。 */
function checkRevision(req, res) {
  const expectedRaw = req.body?.expectedRevision ?? req.query?.expectedRevision;
  const expected = Number(expectedRaw);
  if (expectedRaw == null || !Number.isInteger(expected) || expected < 0) {
    res.status(400).json({ error: '缺少 expectedRevision' });
    return false;
  }
  const row = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  const cur = row ? row.revision : 0;
  if (expected !== cur) {
    res.status(409).json({ error: '赛事已修订，请刷新后重试', currentRevision: cur });
    return false;
  }
  return true;
}

// ---------- 赛事配置 ----------
app.get('/api/event', (req, res) => {
  const cfg = loadConfig(db);
  if (!cfg) return res.json({ configured: false, revision: 0 });
  res.json({
    configured: true,
    id: cfg.id,
    name: cfg.name,
    startPoint: cfg.start_point,
    finishPoint: cfg.finish_point,
    finishCutoff: cfg.finish_cutoff,
    revision: cfg.revision,
    groups: cfg.groups.map((g) => ({
      seq: g.seq,
      name: g.name,
      cutoffSecs: g.cutoff_secs,
      points: g.points,
    })),
  });
});

/** 主办方设置/重设关卡组（整体替换；历史发布版已冻结配置，不受影响） */
app.post('/api/setup', (req, res) => {
  if (!checkRevision(req, res)) return;
  const { name, startPoint, finishPoint, finishCutoff, groups } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return badRequest(res, '赛事名称必填');
  if (typeof startPoint !== 'string' || !startPoint.trim()) return badRequest(res, '起点必填');
  if (typeof finishPoint !== 'string' || !finishPoint.trim()) return badRequest(res, '终点必填');
  if (startPoint === finishPoint) return badRequest(res, '起点与终点不能相同');
  if (!Number.isInteger(finishCutoff) || finishCutoff < 0) return badRequest(res, '终点截止秒数须为非负整数');
  if (!Array.isArray(groups) || groups.length === 0) return badRequest(res, '至少设置一个关卡组');

  const normGroups = [];
  const allPoints = new Set();
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || typeof g.name !== 'string' || !g.name.trim()) return badRequest(res, `第 ${i + 1} 组名称非法`);
    const cutoff = g.cutoffSecs == null ? null : g.cutoffSecs;
    if (cutoff != null && (!Number.isInteger(cutoff) || cutoff < 0))
      return badRequest(res, `「${g.name}」截止秒数须为非负整数或留空`);
    if (!Array.isArray(g.points) || g.points.length === 0)
      return badRequest(res, `「${g.name}」至少一个点位`);
    const pts = [];
    for (const p of g.points) {
      if (typeof p !== 'string' || !p.trim()) return badRequest(res, `「${g.name}」存在非法点位`);
      if (pts.includes(p)) return badRequest(res, `「${g.name}」点位 ${p} 重复`);
      if (allPoints.has(p)) return badRequest(res, `点位 ${p} 在多个组中出现`);
      if (p === startPoint || p === finishPoint) return badRequest(res, `点位 ${p} 不能与起点/终点相同`);
      pts.push(p);
      allPoints.add(p);
    }
    normGroups.push({ name: g.name.trim(), cutoffSecs: cutoff, points: pts });
  }

  const rev = db.transaction(() => {
    db.prepare('DELETE FROM group_point').run();
    db.prepare('DELETE FROM checkpoint_group').run();
    db.prepare(
      `INSERT INTO event (id, name, start_point, finish_point, finish_cutoff, revision)
       VALUES (1, @name, @sp, @fp, @fc, 0)
       ON CONFLICT(id) DO UPDATE SET
         name=@name, start_point=@sp, finish_point=@fp, finish_cutoff=@fc`
    ).run({ name: name.trim(), sp: startPoint.trim(), fp: finishPoint.trim(), fc: finishCutoff });
    const insG = db.prepare('INSERT INTO checkpoint_group (seq, name, cutoff_secs) VALUES (?, ?, ?)');
    const insP = db.prepare('INSERT INTO group_point (group_id, point, seq) VALUES (?, ?, ?)');
    normGroups.forEach((g, i) => {
      const gid = insG.run(i + 1, g.name, g.cutoffSecs).lastInsertRowid;
      g.points.forEach((p, j) => insP.run(gid, p, j + 1));
    });
    // 空库（修订 0）首次设置落为修订 #1；之后每次修改继续推进
    return bumpRevision(db);
  })();
  res.json({ ok: true, revision: rev });
});

// ---------- 打卡导入 ----------
/**
 * 整批校验：负秒数、同记录号异「原始内容」=> 整批拒绝（事务回滚）。
 * 同号判定以该记录号【首次入库时】的原始读数（bib/point/seconds/kind）为准，
 * 不看裁判更正后的现值：
 *  - 原始内容一致 => 幂等跳过，绝不覆盖现值、作废状态与审计留痕；
 *  - 原始内容不一致（批内或库内）=> 整批拒绝；即使批次混有新记录也不部分入库。
 */
app.post('/api/punches/import', (req, res) => {
  if (!checkRevision(req, res)) return;
  if (!loadConfig(db)) return badRequest(res, '赛事尚未配置，请先设置关卡组');
  const { punches } = req.body || {};
  if (!Array.isArray(punches) || punches.length === 0) return badRequest(res, 'punches 须为非空数组');

  const rows = [];
  const seen = new Map();
  for (let i = 0; i < punches.length; i++) {
    const p = punches[i];
    const where = `第 ${i + 1} 条`;
    if (!p || typeof p.recordNo !== 'string' || !p.recordNo.trim()) return badRequest(res, `${where}: recordNo 必填`);
    if (typeof p.bib !== 'string' || !p.bib.trim()) return badRequest(res, `${where}: bib 必填`);
    if (typeof p.point !== 'string' || !p.point.trim()) return badRequest(res, `${where}: point 必填`);
    if (!Number.isInteger(p.seconds) || p.seconds < 0)
      return badRequest(res, `${where}（记录号 ${p.recordNo}）: 秒数须为非负整数，负秒数整批拒绝`);
    if (!['start', 'enroute', 'finish'].includes(p.kind))
      return badRequest(res, `${where}: kind 须为 start/enroute/finish`);
    const row = {
      record_no: p.recordNo.trim(), bib: p.bib.trim(), point: p.point.trim(),
      seconds: p.seconds, kind: p.kind, name: typeof p.name === 'string' ? p.name.trim() : null,
    };
    if (seen.has(row.record_no)) {
      const prev = seen.get(row.record_no);
      if (prev.bib !== row.bib || prev.point !== row.point || prev.seconds !== row.seconds || prev.kind !== row.kind)
        return badRequest(res, `记录号 ${row.record_no} 在批次内出现且原始内容不一致，整批拒绝`);
      continue; // 批次内完全重复，幂等忽略
    }
    seen.set(row.record_no, row);
    rows.push(row);
  }

  // 与库中「首次入库原始读数」比对：更正后的现值不参与冲突判定。
  const existing = db.prepare(
    'SELECT record_no, orig_bib, orig_point, orig_seconds, orig_kind FROM punch WHERE record_no = ?'
  );
  for (const r of rows) {
    const ex = existing.get(r.record_no);
    if (ex && (ex.orig_bib !== r.bib || ex.orig_point !== r.point ||
               ex.orig_seconds !== r.seconds || ex.orig_kind !== r.kind))
      return badRequest(res, `记录号 ${r.record_no} 已存在但原始内容不同，整批拒绝`);
  }

  let inserted = 0;
  const present = new Set(
    db.prepare(`SELECT record_no FROM punch WHERE record_no IN (${rows.map(() => '?').join(',')})`)
      .all(...rows.map((r) => r.record_no))
      .map((x) => x.record_no)
  );
  const toInsert = rows.filter((r) => !present.has(r.record_no));
  // 仅当确有新记录时才写库/推进修订；全部幂等跳过时为只读操作，修订号不变。
  let revision = currentRevision(db);
  if (toInsert.length > 0) {
    revision = db.transaction(() => {
      const insRunner = db.prepare('INSERT INTO runner (bib, name) VALUES (?, ?) ON CONFLICT(bib) DO UPDATE SET name = COALESCE(excluded.name, runner.name)');
      const insPunch = db.prepare(
        `INSERT INTO punch (record_no, bib, point, seconds, kind, orig_bib, orig_point, orig_seconds, orig_kind)
         VALUES (@record_no, @bib, @point, @seconds, @kind, @bib, @point, @seconds, @kind)`
      );
      for (const r of toInsert) {
        insRunner.run(r.bib, r.name);
        inserted += insPunch.run(r).changes;
      }
      return bumpRevision(db);
    })();
  }
  res.json({ ok: true, inserted, skipped: rows.length - inserted, revision });
});

// ---------- 查询 ----------
app.get('/api/punches', (req, res) => {
  const { bib } = req.query;
  const sql = `
    SELECT p.id, p.record_no, p.bib, r.name AS runner_name, p.point, p.seconds, p.kind,
           p.orig_point, p.orig_seconds,
           p.status, p.void_reason, p.created_at
    FROM punch p LEFT JOIN runner r ON r.bib = p.bib
    ${bib ? 'WHERE p.bib = ?' : ''}
    ORDER BY p.bib, p.seconds, p.id`;
  const punches = bib ? db.prepare(sql).all(bib) : db.prepare(sql).all();
  const auditRows = db.prepare(
    `SELECT a.* FROM punch_audit a JOIN punch p ON p.id = a.punch_id
     ${bib ? 'WHERE p.bib = ?' : ''} ORDER BY a.at, a.id`
  ).all(...(bib ? [bib] : []));
  const audits = auditRows.map((a) => ({
    id: a.id, punchId: a.punch_id, action: a.action, origPoint: a.orig_point, origSeconds: a.orig_seconds,
    newPoint: a.new_point, newSeconds: a.new_seconds, reason: a.reason, at: a.at,
  }));
  res.json({ punches, audits });
});

app.get('/api/results', (req, res) => {
  const cfg = loadConfig(db);
  if (!cfg) return res.json({ configured: false, results: [], groups: [] });
  const results = computeResults(db, cfg);
  res.json({
    configured: true,
    revision: cfg.revision,
    startPoint: cfg.start_point,
    finishPoint: cfg.finish_point,
    finishCutoff: cfg.finish_cutoff,
    groups: cfg.groups.map((g) => ({ name: g.name, seq: g.seq, cutoffSecs: g.cutoff_secs, points: g.points })),
    results,
  });
});

// ---------- 裁判：作废 / 更正 ----------
function auditBody(req, res) {
  const { reason, newPoint, newSeconds } = req.body || {};
  if (typeof reason !== 'string' || !reason.trim()) {
    res.status(400).json({ error: '必须填写处理原因（留痕）' });
    return null;
  }
  return { reason: reason.trim(), newPoint, newSeconds };
}

app.post('/api/punches/:id/void', (req, res) => {
  const body = auditBody(req, res);
  if (!body) return;
  const p = db.prepare('SELECT * FROM punch WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '打卡不存在' });
  if (p.status === 'voided') return badRequest(res, '该打卡已作废');
  const revision = db.transaction(() => {
    db.prepare("UPDATE punch SET status = 'voided', void_reason = ? WHERE id = ?").run(body.reason, p.id);
    db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, reason)
       VALUES (?, 'void', ?, ?, ?)`
    ).run(p.id, p.point, p.seconds, body.reason);
    return bumpRevision(db);
  })();
  res.json({ ok: true, revision });
});

app.post('/api/punches/:id/correct', (req, res) => {
  const body = auditBody(req, res);
  if (!body) return;
  const p = db.prepare('SELECT * FROM punch WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: '打卡不存在' });
  if (p.status === 'voided') return badRequest(res, '已作废打卡不能更正，请先确认数据来源');

  const newPoint = typeof body.newPoint === 'string' ? body.newPoint.trim() : null;
  const newSeconds = body.newSeconds;
  if (!newPoint) return badRequest(res, '更正后的点位必填');
  if (!Number.isInteger(newSeconds) || newSeconds < 0) return badRequest(res, '更正后的秒数须为非负整数');
  if (newPoint === p.point && newSeconds === p.seconds) return badRequest(res, '新值与现值相同，无需更正');

  const revision = db.transaction(() => {
    db.prepare('UPDATE punch SET point = ?, seconds = ? WHERE id = ?').run(newPoint, newSeconds, p.id);
    db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, new_point, new_seconds, reason)
       VALUES (?, 'correct', ?, ?, ?, ?, ?)`
    ).run(p.id, p.point, p.seconds, newPoint, newSeconds, body.reason);
    return bumpRevision(db);
  })();
  res.json({ ok: true, revision });
});

// ---------- 发布（冻结） ----------
app.post('/api/publications', (req, res) => {
  if (!checkRevision(req, res)) return;
  const cfg = loadConfig(db);
  if (!cfg) return badRequest(res, '赛事尚未配置');
  const note = typeof req.body?.note === 'string' ? req.body.note.trim() : null;

  const result = db.transaction(() => {
    const versionRow = db
      .prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM publication')
      .get();
    const version = versionRow.v;
    const results = computeResults(db, cfg);
    const readings = db
      .prepare(
        `SELECT p.record_no, p.bib, r.name AS runner_name, p.point, p.seconds, p.kind
         FROM punch p LEFT JOIN runner r ON r.bib = p.bib
         WHERE p.status = 'active' ORDER BY p.bib, p.seconds, p.id`
      )
      .all();
    const configJson = JSON.stringify({
      name: cfg.name, startPoint: cfg.start_point, finishPoint: cfg.finish_point,
      finishCutoff: cfg.finish_cutoff,
      groups: cfg.groups.map((g) => ({ seq: g.seq, name: g.name, cutoffSecs: g.cutoff_secs, points: g.points })),
    });
    const readingsJson = JSON.stringify(readings);
    const resultsJson = JSON.stringify(results);
    db.prepare(
      `INSERT INTO publication (version, event_revision, note, config_json, readings_json, results_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(version, cfg.revision, note, configJson, readingsJson, resultsJson);
    const insR = db.prepare(
      `INSERT INTO published_result (publication_version, bib, name, status, elapsed, fail_at, detail, rank_no)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of results)
      insR.run(version, r.bib, r.name, r.status, r.elapsed, r.failAt ?? null, r.detail, r.rank ?? null);
    // 发布本身冻结快照；继续推进修订号，使旧页面的导入/发布请求走过期核对
    const rev = bumpRevision(db);
    return { version, rev };
  })();
  res.json({ ok: true, version: result.version, revision: result.rev });
});

app.get('/api/publications', (req, res) => {
  const rows = db
    .prepare('SELECT version, event_revision, published_at, note FROM publication ORDER BY version DESC')
    .all();
  res.json({ publications: rows });
});

app.get('/api/publications/:version', (req, res) => {
  const v = Number(req.params.version);
  const row = db
    .prepare('SELECT * FROM publication WHERE version = ?')
    .get(v);
  if (!row) return res.status(404).json({ error: '发布版不存在' });
  res.json({
    version: row.version,
    eventRevision: row.event_revision,
    publishedAt: row.published_at,
    note: row.note,
    config: JSON.parse(row.config_json),
    readings: JSON.parse(row.readings_json),
    results: JSON.parse(row.results_json),
  });
});

// ---------- 静态前端（生产容器） ----------
const distDir = process.env.WEB_DIST || join(__dirname, '..', '..', 'web', 'dist');
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(join(distDir, 'index.html')));
} else {
  app.get('/', (req, res) =>
    res.status(200).send('后端已启动；生产环境请先构建前端（web/dist），或使用 docker compose 一键启动。')
  );
}

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`定向越野复核系统已启动: http://localhost:${PORT}`);
});
