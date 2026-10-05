// 端到端断言：需在独立干净数据库上启动的服务器上运行（SEED=1）。
// 用法：node server/e2e-test.mjs http://localhost:3000
const BASE = process.argv[2] || 'http://localhost:3000';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
async function call(path, opts) {
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  let body = null;
  try { body = await res.json(); } catch {}
  return { status: res.status, body };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

const resultsByBib = async () => {
  const r = await call('/api/results');
  return new Map(r.body.results.map(x => [x.bib, x]));
};
const rev = async () => (await call('/api/event')).body.revision;

console.log('1) 种子赛事与初始排名');
{
  const ev = (await call('/api/event')).body;
  ok('赛事已配置', ev.configured);
  const seedRev = await rev();
  ok('种子完成后修订号为 1（配置与演示读数在同一初始事务落库）', seedRev === 1, `rev=${seedRev}`);
  const rs = await resultsByBib();
  ok('001 完成 910 第一', rs.get('001').status === 'ok' && rs.get('001').elapsed === 910 && rs.get('001').rank === 1);
  ok('001 最早链排除逆序 A1@820/取 A2@300', JSON.stringify(rs.get('001').chain.map(c => c.point)) === JSON.stringify(['S','A2','B1','F']));
  ok('004/006 同耗时 1000 并列第 2', rs.get('004').rank === 2 && rs.get('006').rank === 2 && rs.get('004').elapsed === 1000);
  ok('004 多余点 ZZ@99999 不入链', rs.get('004').chain.every(c => c.point !== 'ZZ'));
  ok('002 终点超时并给出秒数', rs.get('002').status === 'finish_dnf' && rs.get('002').failAt === '终点' && /1850/.test(rs.get('002').detail));
  ok('003 首个未完成组=湖畔组', rs.get('003').status === 'group_dnf' && rs.get('003').failAt === '湖畔组');
  ok('005 出发不唯一', rs.get('005').status === 'bad_start');
}

console.log('2) 整批拒绝规则');
{
  const r0 = await rev();
  const neg = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'B1', bib: '050', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'B2', bib: '050', point: 'A1', seconds: -3, kind: 'enroute' },
  ]})});
  ok('负秒数 400 整批拒绝', neg.status === 400 && /负秒数/.test(neg.body.error));
  const dupDb = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0001', bib: '001', point: 'S', seconds: 999, kind: 'start' },
  ]})});
  ok('同记录号异内容（与库冲突）400', dupDb.status === 400 && /R0001/.test(dupDb.body.error));
  const dupBatch = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'B9', bib: '050', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'B9', bib: '050', point: 'F', seconds: 5, kind: 'finish' },
  ]})});
  ok('批次内同记录号异内容 400', dupBatch.status === 400 && /B9/.test(dupBatch.body.error));
  const after = await call('/api/punches?bib=050');
  ok('整批回滚：050 无任何打卡', after.body.punches.length === 0);
}

console.log('3) 修订号乐观锁');
{
  const r0 = await rev();
  const stale = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0 + 999, punches: [
    { recordNo: 'S1', bib: '060', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('过期修订 409 且返回当前修订', stale.status === 409 && stale.body.currentRevision === r0);
  const missing = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ punches: [] })});
  ok('缺 expectedRevision 400', missing.status === 400);
}

console.log('4) 合法导入与幂等');
{
  const r0 = await rev();
  const imp = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, punches: [
    { recordNo: 'R0001', bib: '001', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'E1', bib: '008', name: '测试选手', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'E2', bib: '008', point: 'A2', seconds: 150, kind: 'enroute' },
    { recordNo: 'E3', bib: '008', point: 'B1', seconds: 600, kind: 'enroute' },
    { recordNo: 'E4', bib: '008', point: 'F', seconds: 777, kind: 'finish' },
  ]})});
  ok('导入成功，4 新增 1 跳过', imp.status === 200 && imp.body.inserted === 4 && imp.body.skipped === 1);
  ok('导入后修订号 +1', imp.body.revision === r0 + 1);
  const rs = await resultsByBib();
  ok('008 完成 777（B1 恰在组截止 600 有效；终点 777<=1800）', rs.get('008').elapsed === 777 && rs.get('008').rank === 1);
}

console.log('5) 作废/更正留痕并重算');
{
  // 005 两条出发：R0040 id=20, R0041 id=21
  const noReason = await call('/api/punches/21/void', { method: 'POST', body: JSON.stringify({}) });
  ok('作废无原因 400', noReason.status === 400);
  const v = await call('/api/punches/21/void', { method: 'POST', body: JSON.stringify({ reason: '设备重复上报' }) });
  ok('作废成功并推进修订', v.status === 200);
  const rs1 = await resultsByBib();
  ok('作废重复出发后 005 以 980 完成', rs1.get('005').status === 'ok' && rs1.get('005').elapsed === 980);
  const neg = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: 'x', newPoint: 'A1', newSeconds: -1 }) });
  ok('更正为负秒数 400', neg.status === 400);
  const c = await call('/api/punches/17/correct', { method: 'POST', body: JSON.stringify({ reason: '现场记录更正', newPoint: 'B2', newSeconds: 700 }) });
  ok('更正成功', c.status === 200);
  const rs2 = await resultsByBib();
  // 004 原有 A1@400, B2@720；把 ZZ 改为 B2@700 后，组2取更早的 B2@700，终点仍 F@1000
  const chain4 = rs2.get('004').chain.map(x => `${x.point}@${x.seconds}`);
  ok('004 链采用更正后的更早 B2@700', chain4.includes('B2@700') && !chain4.includes('B2@720'), chain4.join(' '));
  const audits = (await call('/api/punches?bib=004')).body.audits;
  const a = audits.find(x => x.action === 'correct');
  ok('审计保留原值 ZZ@99999', a && a.origPoint === 'ZZ' && a.origSeconds === 99999 && a.newPoint === 'B2' && a.reason === '现场记录更正');
}

console.log('6) 发布冻结与历史版不可变');
{
  const before = await resultsByBib();
  const v005 = before.get('005').elapsed;
  const r0 = await rev();
  const pub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r0, note: '冻结首版' }) });
  ok('发布 v1 成功', pub.status === 200 && pub.body.version === 1);
  const stalePub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r0 }) });
  ok('发布后旧修订再发布 409', stalePub.status === 409);
  const snap = (await call('/api/publications/1')).body;
  ok('v1 快照 005 成绩=' + v005, snap.results.find(x => x.bib === '005').elapsed === v005);
  ok('v1 快照不含作废读数（005 仅 4 条）', snap.readings.filter(x => x.bib === '005').length === 4);

  // 发布之后：更正 001 的 A2@300 -> A1@250，再发布 v2
  const p1 = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  const r1 = await rev();
  const cor = await call(`/api/punches/${p1.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '发布后申诉更正', newPoint: 'A1', newSeconds: 250 }) });
  ok('发布后更正成功', cor.status === 200);
  const r2 = await rev();
  const pub2 = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, note: '第二版' }) });
  ok('发布 v2', pub2.status === 200 && pub2.body.version === 2);
  const snap1 = (await call('/api/publications/1')).body;
  const snap2 = (await call('/api/publications/2')).body;
  ok('v1 历史版读数仍是旧 A2@300', snap1.readings.find(x => x.record_no === 'R0003').point === 'A2' && snap1.readings.find(x => x.record_no === 'R0003').seconds === 300);
  ok('v2 读数为更正后 A1@250', snap2.readings.find(x => x.record_no === 'R0003').point === 'A1' && snap2.readings.find(x => x.record_no === 'R0003').seconds === 250);
  ok('v1/v2 配置均已冻结', snap1.config.groups.length === 2 && snap2.config.groups.length === 2);
  const list = (await call('/api/publications')).body.publications;
  ok('版本列表按版本倒序', list[0].version === 2 && list[1].version === 1);
}

console.log('7) 更正/作废后的重导语义（按首次入库原始读数判定）');
{
  const rNow = await rev();

  // 7.1 R0003 已更正为 A1@250；用最初读数 A2@300 重导 => 幂等跳过，现值/审计不动
  const sameOrig = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rNow, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 300, kind: 'enroute' },
  ]})});
  ok('更正后按原始读数重导：200 跳过 0 新增', sameOrig.status === 200 && sameOrig.body.inserted === 0 && sameOrig.body.skipped === 1);
  ok('全部跳过时修订号不变', sameOrig.body.revision === rNow);
  const p3 = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  ok('跳过不覆盖裁判现值（仍 A1@250）', p3.point === 'A1' && p3.seconds === 250);
  ok('API 返回首次入库原始读数 A2@300', p3.orig_point === 'A2' && p3.orig_seconds === 300);
  const rs = await resultsByBib();
  ok('实时成绩沿用裁判现值（001 链含 A1@250，耗时仍 910）',
    rs.get('001').chain.some(c => c.point === 'A1' && c.seconds === 250) && rs.get('001').elapsed === 910);

  // 7.2 与更正现值一致但与原始读数不同 => 仍按冲突整批拒绝（不能错误跳过）
  const matchCurrent = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rNow, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A1', seconds: 250, kind: 'enroute' },
  ]})});
  ok('同号但仅与现值一致、异于原始读数：400', matchCurrent.status === 400 && /R0003/.test(matchCurrent.body.error));

  // 7.3 冲突批次混有新记录 => 整批拒绝，不部分入库
  const mixed = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: rNow, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 999, kind: 'enroute' },
    { recordNo: 'N1', bib: '070', name: '不应入库', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('冲突+新记录混批 400 且不部分入库', mixed.status === 400);
  const afterMixed = await call('/api/punches?bib=070');
  ok('混批回滚：070 无 runner/打卡', afterMixed.body.punches.length === 0);
  const rAfterMixed = await rev();
  ok('混批拒绝后修订号不变', rAfterMixed === rNow);

  // 7.4 多次更正后仍按最初读数判断：把 002 的 R0011 再更正一次 A1@200 -> A2@260
  const r0 = await rev();
  const target = (await call('/api/punches?bib=002')).body.punches.find(x => x.record_no === 'R0011');
  const c1 = await call(`/api/punches/${target.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '第一次更正', newPoint: 'A1', newSeconds: 210 }) });
  ok('第二次更正（中间值 A1@210）成功', c1.status === 200);
  const c2 = await call(`/api/punches/${target.id}/correct`, { method: 'POST', body: JSON.stringify({ reason: '第二次更正', newPoint: 'A2', newSeconds: 260 }) });
  ok('第三次更正（现值 A2@260）成功', c2.status === 200);
  const r1 = await rev();
  const reOrig = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, punches: [
    { recordNo: 'R0011', bib: '002', point: 'A1', seconds: 200, kind: 'enroute' },
  ]})});
  ok('多次更正后按最初读数 A1@200 重导：跳过', reOrig.status === 200 && reOrig.body.skipped === 1);
  const reMiddle = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r1, punches: [
    { recordNo: 'R0011', bib: '002', point: 'A1', seconds: 210, kind: 'enroute' },
  ]})});
  ok('用中间更正值 A1@210 重导：400 拒绝', reMiddle.status === 400 && /R0011/.test(reMiddle.body.error));
  const audits2 = (await call('/api/punches?bib=002')).body.audits.filter(a => a.punchId === target.id);
  ok('重导未新增审计（仍为 2 条更正）', audits2.length === 2);

  // 7.5 作废记录重导原始读数：跳过且不恢复有效状态
  const r2 = await rev();
  const voided = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r2, punches: [
    { recordNo: 'R0041', bib: '005', point: 'S', seconds: 5, kind: 'start' },
  ]})});
  ok('已作废记录按原始读数重导：跳过', voided.status === 200 && voided.body.inserted === 0 && voided.body.skipped === 1);
  const p41 = (await call('/api/punches?bib=005')).body.punches.find(x => x.record_no === 'R0041');
  ok('跳过后仍为 voided、原因保留', p41.status === 'voided' && /设备重复上报/.test(p41.void_reason || ''));

  // 7.6 历史发布版保持冻结：v1 读数不受此后更正/重导影响
  const snap1 = (await call('/api/publications/1')).body;
  ok('v1 历史版仍冻结在发布时读数（R0003=A2@300）',
    snap1.readings.find(x => x.record_no === 'R0003').point === 'A2' &&
    snap1.readings.find(x => x.record_no === 'R0003').seconds === 300);

  // 7.7 过期修订重导：409 + currentRevision
  const r3 = await rev();
  const stale = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r3 - 1, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 300, kind: 'enroute' },
  ]})});
  ok('重导过期修订 409 并返回 currentRevision', stale.status === 409 && stale.body.currentRevision === r3);

  // 7.8 原始批次（多条已更正/作废）+ 新记录混合：已有全部跳过，新记录入库，修订 +1
  const r4 = await rev();
  const batch = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r4, punches: [
    { recordNo: 'R0003', bib: '001', point: 'A2', seconds: 300, kind: 'enroute' },
    { recordNo: 'R0011', bib: '002', point: 'A1', seconds: 200, kind: 'enroute' },
    { recordNo: 'R0041', bib: '005', point: 'S', seconds: 5, kind: 'start' },
    { recordNo: 'N9', bib: '080', name: '新选手', point: 'S', seconds: 0, kind: 'start' },
  ]})});
  ok('原批次重导+新记录：3 跳过 1 新增', batch.status === 200 && batch.body.inserted === 1 && batch.body.skipped === 3);
  ok('有新增时修订号 +1', batch.body.revision === r4 + 1);
  const still = (await call('/api/punches?bib=001')).body.punches.find(x => x.record_no === 'R0003');
  ok('重导后裁判现值仍不被覆盖（A1@250）', still.point === 'A1' && still.seconds === 250);
}

console.log('8) 整案申诉：预演（不落库）→ 绑定修订号与操作集合确认');
{
  // 全新受控场景：导入三名选手后发布冻结一版，再做整案
  let r = await rev();
  const imp = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r, punches: [
    // 090：组2 唯一打卡被误读为 ZZ@99999 => 当前湖畔组未完成（DNF）；
    // 整案更正为 B1@500 后将以 800s 完赛，把其后所有完赛者名次顶后
    { recordNo: 'A900', bib: '090', name: '整案选手', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'A901', bib: '090', point: 'ZZ', seconds: 99999, kind: 'enroute' },
    { recordNo: 'A902', bib: '090', point: 'A1', seconds: 300, kind: 'enroute' },
    { recordNo: 'A904', bib: '090', point: 'F', seconds: 800, kind: 'finish' },
    // 091：完成 900；090 更正完赛后 091 名次仅因他人变化而后退
    { recordNo: 'A910', bib: '091', name: '连带选手', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'A911', bib: '091', point: 'A2', seconds: 200, kind: 'enroute' },
    { recordNo: 'A912', bib: '091', point: 'B2', seconds: 600, kind: 'enroute' },
    { recordNo: 'A913', bib: '091', point: 'F', seconds: 900, kind: 'finish' },
    // 092：完成 1300，另含一条多余晚终点 A925（整案作废它，不影响其有效链与成绩）
    { recordNo: 'A920', bib: '092', name: '作废选手', point: 'S', seconds: 0, kind: 'start' },
    { recordNo: 'A921', bib: '092', point: 'A1', seconds: 320, kind: 'enroute' },
    { recordNo: 'A922', bib: '092', point: 'B2', seconds: 760, kind: 'enroute' },
    { recordNo: 'A923', bib: '092', point: 'F', seconds: 1300, kind: 'finish' },
    { recordNo: 'A925', bib: '092', point: 'XX', seconds: 1700, kind: 'enroute' }, // 无关点位，作废不影响成绩
  ]})});
  ok('导入 090/091/092 共 13 条', imp.status === 200 && imp.body.inserted === 13, JSON.stringify(imp.body));
  r = imp.body.revision;

  const pub = await call('/api/publications', { method: 'POST', body: JSON.stringify({ expectedRevision: r, note: '整案前冻结' }) });
  ok('整案前发布一版', pub.status === 200);
  const frozenVersion = pub.body.version;
  r = pub.body.revision;
  const revBeforeCase = r;

  const ids = new Map();
  for (const b of ['090', '091', '092']) {
    const d = (await call(`/api/punches?bib=${b}`)).body.punches;
    d.forEach(p => ids.set(p.record_no, p.id));
  }
  const idBad = ids.get('A901');   // 090 误读
  const idLate = ids.get('A925');  // 092 多余晚终点

  const before = await resultsByBib();
  ok('预演前：090 湖畔组未完成（DNF），091 以 900、092 以 1300 完赛',
    before.get('090').status === 'group_dnf' && before.get('090').failAt === '湖畔组' &&
    before.get('091').elapsed === 900 && before.get('092').elapsed === 1300);
  const rank091Before = before.get('091').rank;
  const rank092Before = before.get('092').rank;

  // 8.1 整案操作集合校验（任一非法 => 整案拒绝）
  const dup = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idBad, action: 'void', reason: 'x' },
    { punchId: idBad, action: 'correct', reason: 'y', newPoint: 'A2', newSeconds: 250 },
  ]})});
  ok('同一打卡重复指定：400 整案拒绝', dup.status === 400 && /重复指定/.test(dup.body.error));
  const missing = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: 999999, action: 'void', reason: 'x' },
  ]})});
  ok('缺失打卡：400 整案拒绝', missing.status === 400 && /不存在/.test(missing.body.error));
  const neg = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idBad, action: 'correct', reason: 'x', newPoint: 'A2', newSeconds: -1 },
  ]})});
  ok('更正负秒数：400', neg.status === 400 && /非负整数/.test(neg.body.error));
  const noPoint = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idBad, action: 'correct', reason: 'x', newPoint: '   ', newSeconds: 10 },
  ]})});
  ok('更正缺点位：400', noPoint.status === 400 && /点位必填/.test(noPoint.body.error));
  const noReason = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idBad, action: 'void', reason: '   ' },
  ]})});
  ok('缺少原因：400', noReason.status === 400);
  const badAction = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idBad, action: 'delete', reason: 'x' },
  ]})});
  ok('非法 action：400', badAction.status === 400 && /void 或 correct/.test(badAction.body.error));
  const stale = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r + 999, operations: [
    { punchId: idBad, action: 'void', reason: 'x' },
  ]})});
  ok('预演过期修订：409 并返回 currentRevision', stale.status === 409 && stale.body.currentRevision === r);
  const noRev = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ operations: [] })});
  ok('预演缺修订号/空操作集：400', noRev.status === 400);

  // 8.2 合法预演（更正 A901 为 B1@500 补全 090 的组2 => 090 以 800 完赛；作废 A925 不影响 092 链）
  const caseOps = [
    { punchId: idBad, action: 'correct', reason: '依据申诉照片更正误读', newPoint: 'B1', newSeconds: 500 },
    { punchId: idLate, action: 'void', reason: '申诉：多余晚终点作废' },
  ];
  const pv = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: caseOps })});
  ok('预演成功并返回指纹', pv.status === 200 && typeof pv.body.caseFingerprint === 'string' && pv.body.revision === r);
  ok('预演含两条逐条投影（before/after）',
    pv.body.projections.length === 2 &&
    pv.body.projections[0].before.point === 'ZZ' && pv.body.projections[0].after.point === 'B1' &&
    pv.body.projections[1].before.status === 'active' && pv.body.projections[1].after.status === 'voided');
  const af090 = pv.body.affected.find(a => a.bib === '090');
  ok('预演 090：group_dnf -> ok、耗时 800，有效链补齐 S/A1/B1/F',
    af090.directlyAffected && af090.statusChanged && af090.elapsedChanged && af090.chainChanged &&
    af090.before.status === 'group_dnf' && af090.before.failAt === '湖畔组' &&
    af090.after.status === 'ok' && af090.after.elapsed === 800 &&
    JSON.stringify(af090.after.chain.map(c => c.point)) === JSON.stringify(['S','A1','B1','F']) &&
    af090.chainDiff.added.some(c => c.record_no === 'A901' && c.point === 'B1' && c.seconds === 500),
    JSON.stringify(af090?.after));
  const af091 = pv.body.affected.find(a => a.bib === '091');
  ok('091 无打卡被处理，却因 090 完赛进入受影响名单（仅连带，名次后退 1 位）',
    af091 && af091.directlyAffected === false && af091.rankChanged &&
    af091.before.rank === rank091Before && af091.after.rank === rank091Before + 1 &&
    af091.elapsedChanged === false && af091.chainChanged === false &&
    af091.failureChanged === false);
  const af092 = pv.body.affected.find(a => a.bib === '092');
  ok('092 直接被作废：耗时与有效链不变（名次被 090 顶后 1 位）',
    af092.directlyAffected && af092.before.elapsed === 1300 && af092.after.elapsed === 1300 &&
    af092.after.rank === rank092Before + 1 && af092.chainChanged === false);
  // 090 以 800s 完赛插到榜首：此前所有完赛者（含种子选手 001）都仅因他人变化而后退 1 位
  const af001 = pv.body.affected.find(a => a.bib === '001');
  ok('001 无任何操作也在受影响名单：仅连带名次后退，成绩/失败原因/链均不变',
    af001 && af001.directlyAffected === false && af001.rankChanged &&
    af001.before.rank + 1 === af001.after.rank &&
    af001.elapsedChanged === false && af001.chainChanged === false &&
    af001.failureChanged === false);
  const cascadeBibs = ['001','004','006','091','092'];
  ok('所有被顶后的完赛者都在受影响名单中',
    cascadeBibs.every(b => pv.body.affected.some(a => a.bib === b && a.after.rank === a.before.rank + 1)));
  ok('未受影响的 DNF 选手（002/003）不在受影响名单',
    !pv.body.affected.some(a => a.bib === '002' || a.bib === '003'));
  const pre090 = await call('/api/punches?bib=090');
  const pre092 = await call('/api/punches?bib=092');
  ok('预演只读：修订号不变、A901 仍 ZZ、A925 仍 active、两名选手尚无审计',
    (await rev()) === r &&
    pre090.body.punches.find(p => p.record_no === 'A901').point === 'ZZ' &&
    pre092.body.punches.find(p => p.record_no === 'A925').status === 'active' &&
    pre090.body.audits.length === 0 && pre092.body.audits.length === 0);

  // 8.3 确认绑定：缺字段 / 指纹不符 / 赛事已变化
  const noFp = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({
    expectedRevision: r, operations: caseOps })});
  ok('确认缺 caseFingerprint：400', noFp.status === 400);
  const badFp = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({
    expectedRevision: r, caseFingerprint: 'nope', operations: caseOps })});
  ok('指纹不匹配（操作集合与预演不同）：409 要求重新预演', badFp.status === 409 && /重新预演/.test(badFp.body.error));
  // 他人先改动数据推进修订号（单条作废一张与本案无关的卡）
  const other = await call(`/api/punches/${ids.get('A911')}/void`, { method: 'POST', body: JSON.stringify({ reason: '他人变更' }) });
  ok('他人单条作废推进修订', other.status === 200);
  r = other.body.revision;
  const staleConfirm = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({
    expectedRevision: revBeforeCase, caseFingerprint: pv.body.caseFingerprint, operations: caseOps })});
  ok('确认时赛事已变化：409 且返回 currentRevision，要求重新预演',
    staleConfirm.status === 409 && staleConfirm.body.currentRevision === r);
  ok('过期确认未部分生效（A901 仍 ZZ、A925 仍 active、修订只 +1）',
    (await call('/api/punches?bib=090')).body.punches.find(p => p.record_no === 'A901').point === 'ZZ' &&
    (await call('/api/punches?bib=092')).body.punches.find(p => p.record_no === 'A925').status === 'active' &&
    (await rev()) === r);

  // 8.4 重新预演并成功确认：单事务、修订号只 +1、逐条审计
  const pv2 = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: caseOps })});
  ok('赛事变化后须用新修订号重新预演', pv2.status === 200 && pv2.body.revision === r);
  const conf = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({
    expectedRevision: r, caseFingerprint: pv2.body.caseFingerprint, operations: caseOps })});
  ok('确认成功', conf.status === 200, JSON.stringify(conf.body));
  ok('修订号只推进一次', conf.body.revision === r + 1);
  r = conf.body.revision;
  // 注意：确认发生在 8.3 他人作废 091 的 A911 之后，此时 091 已为组未完成；
  // 以重预演 pv2 的 after 名次为准核对连带变化（092 在新基线上同样被 090 顶后 1 位）。
  const pv2_092 = pv2.body.affected.find(a => a.bib === '092');
  ok('返回最新成绩：090=ok/800、092=ok/1300；091 因 A911 已作废为 group_dnf',
    (() => {
      const m = new Map(conf.body.results.map(x => [x.bib, x]));
      return m.get('090').status === 'ok' && m.get('090').elapsed === 800 &&
        m.get('090').chain.some(c => c.record_no === 'A901' && c.point === 'B1' && c.seconds === 500) &&
        m.get('092').status === 'ok' && m.get('092').elapsed === 1300 &&
        m.get('092').rank === pv2_092.after.rank &&
        m.get('091').status === 'group_dnf' && m.get('091').rank == null;
    })());
  const p090 = (await call('/api/punches?bib=090')).body;
  const p092 = (await call('/api/punches?bib=092')).body;
  ok('逐条审计一次性落库：090 一条更正（原值 ZZ@99999），092 一条作废',
    p090.audits.length === 1 && p090.audits[0].action === 'correct' &&
    p090.audits[0].origPoint === 'ZZ' && p090.audits[0].origSeconds === 99999 &&
    p090.audits[0].newPoint === 'B1' && p090.audits[0].newSeconds === 500 &&
    p090.audits[0].reason === '依据申诉照片更正误读' &&
    p092.audits.length === 1 && p092.audits[0].action === 'void' &&
    p092.audits[0].reason === '申诉：多余晚终点作废');
  ok('现值/状态正确：A901=B1@500 active；A925=voided 且带作废原因',
    p090.punches.find(p => p.record_no === 'A901').point === 'B1' &&
    p090.punches.find(p => p.record_no === 'A901').seconds === 500 &&
    p090.punches.find(p => p.record_no === 'A901').status === 'active' &&
    p092.punches.find(p => p.record_no === 'A925').status === 'voided' &&
    /多余晚终点/.test(p092.punches.find(p => p.record_no === 'A925').void_reason));

  // 8.5 已作废/重复/无变化的整案拒绝（确认后状态下）
  const voidedCorrect = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idLate, action: 'correct', reason: 'x', newPoint: 'F', newSeconds: 1700 },
  ]})});
  ok('已作废打卡更正：400 整案拒绝', voidedCorrect.status === 400 && /已作废/.test(voidedCorrect.body.error));
  const voidAgain = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idLate, action: 'void', reason: 'x' },
  ]})});
  ok('已作废打卡重复作废：400', voidAgain.status === 400);
  const sameVal = await call('/api/appeals/preview', { method: 'POST', body: JSON.stringify({ expectedRevision: r, operations: [
    { punchId: idBad, action: 'correct', reason: 'x', newPoint: 'B1', newSeconds: 500 },
  ]})});
  ok('更正新值与现值相同：400', sameVal.status === 400 && /无需更正/.test(sameVal.body.error));
  const noRevConfirm = await call('/api/appeals/confirm', { method: 'POST', body: JSON.stringify({ operations: [] })});
  ok('确认缺修订号：400', noRevConfirm.status === 400);

  // 8.6 首次入库原始读数仍用于重导判定；整案更正不改变 orig_*
  const reOrig = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r, punches: [
    { recordNo: 'A901', bib: '090', point: 'ZZ', seconds: 99999, kind: 'enroute' },
  ]})});
  ok('整案更正后按原始读数 ZZ@99999 重导：幂等跳过，不覆盖现值',
    reOrig.status === 200 && reOrig.body.inserted === 0 && reOrig.body.skipped === 1 &&
    reOrig.body.revision === r &&
    (await call('/api/punches?bib=090')).body.punches.find(p => p.record_no === 'A901').point === 'B1');
  const reCurrent = await call('/api/punches/import', { method: 'POST', body: JSON.stringify({ expectedRevision: r, punches: [
    { recordNo: 'A901', bib: '090', point: 'B1', seconds: 500, kind: 'enroute' },
  ]})});
  ok('用现值 B1@500（异于原始读数）重导：仍 400 整批拒绝', reCurrent.status === 400 && /A901/.test(reCurrent.body.error));

  // 8.7 历史发布版保持冻结
  const snap = (await call(`/api/publications/${frozenVersion}`)).body;
  ok('整案前发布版仍冻结：A901 为 ZZ@99999、A925 在有效读数中',
    snap.readings.some(x => x.record_no === 'A901' && x.point === 'ZZ' && x.seconds === 99999) &&
    snap.readings.some(x => x.record_no === 'A925'));
  const snap090 = snap.results.find(x => x.bib === '090');
  const snap091 = snap.results.find(x => x.bib === '091');
  ok('冻结版成绩不随后续整案改变（090 仍 group_dnf，091 名次为整案前值）',
    snap090.status === 'group_dnf' && snap090.elapsed == null && snap091.rank === rank091Before);
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
