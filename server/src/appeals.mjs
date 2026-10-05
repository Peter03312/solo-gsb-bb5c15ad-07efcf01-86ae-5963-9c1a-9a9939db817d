// 整案申诉：一次预演/确认绑定同一赛事修订号与同一操作集合。
//
// 同一申诉可对多条现有打卡逐条「作废 void」或「更正 correct」（含原因）：
//  - 更正须给出新点位与非负整数秒数，且新值须与现值不同；
//  - 已作废打卡不得更正（但作废是幂等判定中明确拒绝的目标）；
//  - 同一打卡在整案中不得重复指定；
//  - 缺失打卡或任一操作无效 => 整案拒绝（绝不部分生效）。
//
// 预演只基于当前数据库的内存快照核算，绝不改动打卡、审计、修订号与历史发布版。
// 确认在单事务内复核同一修订号 + 同一操作集合（指纹绑定），逐条落库审计，
// 修订号只推进一次。
import { createHash } from 'node:crypto';
import { bumpRevision } from './db.mjs';
import { computeResultsOnReadings } from './scoring.mjs';

/**
 * 解析并逐条校验操作集合（不触碰数据库）。
 * 成功返回 { operations: [{ punchId, action, reason, newPoint?, newSeconds? }] }；
 * 任一非法返回 { error }（错误信息可直接响应 400）。
 */
export function parseOperations(body) {
  const raw = body?.operations;
  if (!Array.isArray(raw) || raw.length === 0)
    return { error: 'operations 须为非空数组（整案至少处理一条打卡）' };
  const operations = [];
  const seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const op = raw[i];
    const where = `第 ${i + 1} 条操作`;
    const id = Number(op?.punchId);
    if (!Number.isInteger(id) || id <= 0)
      return { error: `${where}: punchId 必须是正整数` };
    if (seen.has(id))
      return { error: `打卡 #${id} 在整案中被重复指定，同一打卡只能处理一次` };
    seen.add(id);
    if (op.action !== 'void' && op.action !== 'correct')
      return { error: `${where}（打卡 #${id}）: action 须为 void 或 correct` };
    if (typeof op.reason !== 'string' || !op.reason.trim())
      return { error: `${where}（打卡 #${id}）: 必须填写处理原因（留痕）` };
    const norm = { punchId: id, action: op.action, reason: op.reason.trim() };
    if (op.action === 'correct') {
      const newPoint = typeof op.newPoint === 'string' ? op.newPoint.trim() : '';
      const newSeconds = op.newSeconds;
      if (!newPoint) return { error: `${where}（打卡 #${id}）: 更正后的点位必填` };
      if (!Number.isInteger(newSeconds) || newSeconds < 0)
        return { error: `${where}（打卡 #${id}）: 更正后的秒数须为非负整数` };
      norm.newPoint = newPoint;
      norm.newSeconds = newSeconds;
    }
    operations.push(norm);
  }
  return { operations };
}

/** 操作集合指纹：确认必须与预演绑定同一修订号 + 同一操作集合 */
export function fingerprint(expectedRevision, operations) {
  const canonical = JSON.stringify({
    expectedRevision,
    operations: operations.map((o) => ({
      punchId: o.punchId,
      action: o.action,
      reason: o.reason,
      newPoint: o.newPoint ?? null,
      newSeconds: o.newSeconds ?? null,
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * 基于数据库当前状态校验整案并在内存中预演。
 * 返回 { ok:true, operations, projections, before, after, affected }
 * 或 { ok:false,status,error,currentRevision? }。
 */
export function simulate(db, config, expectedRevision, operations) {
  const curRow = db.prepare('SELECT revision FROM event WHERE id = 1').get();
  const currentRevision = curRow ? curRow.revision : 0;
  if (expectedRevision !== currentRevision) {
    return {
      ok: false, status: 409,
      error: '赛事已修订，请基于当前修订号重新预演',
      currentRevision,
    };
  }

  // 整案目标打卡一次性取出；缺失任一 => 整案拒绝。
  const ids = operations.map((o) => o.punchId);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT id, record_no, bib, point, seconds, kind, status FROM punch WHERE id IN (${placeholders})`)
    .all(...ids);
  const byId = new Map(rows.map((p) => [p.id, p]));
  for (const op of operations) {
    const p = byId.get(op.punchId);
    if (!p)
      return { ok: false, status: 400, error: `打卡 #${op.punchId} 不存在，整案拒绝` };
    if (op.action === 'void' && p.status === 'voided')
      return { ok: false, status: 400, error: `打卡 #${op.punchId}（记录号 ${p.record_no}）已作废，不能重复作废，整案拒绝` };
    if (op.action === 'correct' && p.status === 'voided')
      return { ok: false, status: 400, error: `打卡 #${op.punchId}（记录号 ${p.record_no}）已作废，不得更正，整案拒绝` };
    if (
      op.action === 'correct' &&
      op.newPoint === p.point &&
      op.newSeconds === p.seconds
    )
      return {
        ok: false,
        status: 400,
        error: `打卡 #${op.punchId}（记录号 ${p.record_no}）新值与现值相同，无需更正，整案拒绝`,
      };
  }

  const runners = db.prepare('SELECT bib, name FROM runner ORDER BY bib').all();
  const allPunches = db
    .prepare('SELECT id, record_no, bib, point, seconds, kind, status FROM punch')
    .all()
    .map((p) => ({ ...p }));
  const before = indexByBib(computeResultsOnReadings(config, runners, allPunches));

  // 在内存副本上施加整案操作（预演不写库）
  const projById = new Map(byId.entries());
  for (const op of operations) {
    const p = allPunches.find((x) => x.id === op.punchId);
    const projection = {
      punchId: op.punchId,
      recordNo: p.record_no,
      bib: p.bib,
      action: op.action,
      reason: op.reason,
      before: {
        status: p.status,
        point: p.point,
        seconds: p.seconds,
        kind: p.kind,
      },
      after:
        op.action === 'void'
          ? { status: 'voided', point: p.point, seconds: p.seconds, kind: p.kind }
          : { status: 'active', point: op.newPoint, seconds: op.newSeconds, kind: p.kind },
    };
    projById.set(op.punchId, projection);
    if (op.action === 'void') p.status = 'voided';
    else {
      p.point = op.newPoint;
      p.seconds = op.newSeconds;
    }
  }
  const afterList = computeResultsOnReadings(config, runners, allPunches);
  const after = indexByBib(afterList);

  // 受影响选手：直接被处理打卡所属选手 + 成绩/名次/失败原因/有效链有任何差异者
  //（含仅因他人变化而名次改变的选手）。
  const directBibs = new Set(operations.map((o) => projById.get(o.punchId).bib));
  const affectedBibs = new Set(directBibs);
  for (const bib of before.keys()) {
    if (!resultEquals(before.get(bib), after.get(bib))) affectedBibs.add(bib);
  }
  const affected = [...affectedBibs].sort((x, y) => x.localeCompare(y)).map((bib) => {
    const b = before.get(bib);
    const a = after.get(bib);
    return {
      bib,
      name: (a || b)?.name ?? null,
      directlyAffected: directBibs.has(bib),
      before: summarize(b),
      after: summarize(a),
      rankChanged: (b?.rank ?? null) !== (a?.rank ?? null),
      statusChanged: (b?.status ?? null) !== (a?.status ?? null),
      elapsedChanged: (b?.elapsed ?? null) !== (a?.elapsed ?? null),
      failureChanged:
        (b?.failAt ?? null) !== (a?.failAt ?? null) ||
        (b?.detail ?? '') !== (a?.detail ?? ''),
      chainChanged: !chainsEqual(b?.chain ?? [], a?.chain ?? []),
      chainDiff: diffChains(b?.chain ?? [], a?.chain ?? []),
    };
  });

  return {
    ok: true,
    operations,
    projections: operations.map((o) => projById.get(o.punchId)),
    before: [...before.values()],
    after: afterList,
    affected,
  };
}

function indexByBib(list) {
  return new Map(list.map((r) => [r.bib, r]));
}

function summarize(r) {
  if (!r) return null;
  return {
    bib: r.bib,
    name: r.name,
    status: r.status,
    elapsed: r.elapsed,
    rank: r.rank ?? null,
    failAt: r.failAt ?? null,
    detail: r.detail ?? '',
    chain: r.chain ?? [],
  };
}

function chainsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function resultEquals(a, b) {
  if (!a || !b) return !a && !b;
  return (
    a.status === b.status &&
    (a.elapsed ?? null) === (b.elapsed ?? null) &&
    (a.rank ?? null) === (b.rank ?? null) &&
    (a.failAt ?? null) === (b.failAt ?? null) &&
    (a.detail ?? '') === (b.detail ?? '') &&
    chainsEqual(a.chain ?? [], b.chain ?? [])
  );
}

/** 以记录号对齐两条有效链，给出新增/移除/变化/不变条目 */
function diffChains(beforeChain, afterChain) {
  const bMap = new Map(beforeChain.map((c) => [c.record_no, c]));
  const aMap = new Map(afterChain.map((c) => [c.record_no, c]));
  const removed = [];
  const modified = [];
  const unchanged = [];
  for (const c of beforeChain) {
    const a = aMap.get(c.record_no);
    if (!a) removed.push(c);
    else if (a.point !== c.point || a.seconds !== c.seconds)
      modified.push({ before: c, after: a });
    else unchanged.push(a);
  }
  const added = afterChain.filter((c) => !bMap.has(c.record_no));
  return { removed, added, modified, unchanged };
}

/**
 * 确认提交：在单事务内复核修订号、操作集合指纹与全部业务规则，
 * 通过后一次性落库全部变更与逐条审计，修订号只推进一次。
 * 任何一步失败都抛错，由 better-sqlite3 整体回滚（绝不部分生效）。
 */
export function commitAppeal(db, config, { expectedRevision, operations, caseFingerprint }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT revision FROM event WHERE id = 1').get();
    const currentRevision = cur ? cur.revision : 0;
    if (expectedRevision !== currentRevision) {
      const err = new Error('赛事已修订，请刷新后基于最新修订号重新预演');
      err.status = 409;
      err.currentRevision = currentRevision;
      throw err;
    }
    if (caseFingerprint !== fingerprint(expectedRevision, operations)) {
      const err = new Error('操作集合与预演不一致（指纹不匹配），请重新预演整案');
      err.status = 409;
      err.currentRevision = currentRevision;
      throw err;
    }

    // 事务内重新校验当前数据状态（预演之后、确认之前数据可能已变）
    const sim = simulate(db, config, expectedRevision, operations);
    if (!sim.ok) {
      const err = new Error(sim.error);
      err.status = sim.status;
      if (sim.currentRevision != null) err.currentRevision = sim.currentRevision;
      throw err;
    }

    const voidStmt = db.prepare(
      "UPDATE punch SET status = 'voided', void_reason = ? WHERE id = ? AND status = 'active'"
    );
    const correctStmt = db.prepare(
      'UPDATE punch SET point = ?, seconds = ? WHERE id = ? AND status = \'active\''
    );
    const auditVoid = db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, reason)
       VALUES (?, 'void', ?, ?, ?)`
    );
    const auditCorrect = db.prepare(
      `INSERT INTO punch_audit (punch_id, action, orig_point, orig_seconds, new_point, new_seconds, reason)
       VALUES (?, 'correct', ?, ?, ?, ?, ?)`
    );

    for (const proj of sim.projections) {
      const { before, after } = proj;
      if (proj.action === 'void') {
        const r = voidStmt.run(proj.reason, proj.punchId);
        if (r.changes !== 1) throw new Error(`打卡 #${proj.punchId} 状态已变化，整案回滚`);
        auditVoid.run(proj.punchId, before.point, before.seconds, proj.reason);
      } else {
        const r = correctStmt.run(after.point, after.seconds, proj.punchId);
        if (r.changes !== 1) throw new Error(`打卡 #${proj.punchId} 状态已变化，整案回滚`);
        auditCorrect.run(
          proj.punchId, before.point, before.seconds,
          after.point, after.seconds, proj.reason
        );
      }
    }

    const revision = bumpRevision(db);
    // 提交后从已落库数据重算最新成绩（与事务内写入一致）
    const results = computeResultsOnReadings(
      config,
      db.prepare('SELECT bib, name FROM runner ORDER BY bib').all(),
      db.prepare('SELECT id, record_no, bib, point, seconds, kind, status FROM punch').all()
    );
    return {
      revision,
      applied: sim.projections.map((p) => ({
        punchId: p.punchId,
        recordNo: p.recordNo,
        bib: p.bib,
        action: p.action,
        before: p.before,
        after: p.after,
      })),
      affected: sim.affected,
      results,
    };
  })();
}
