// 成绩核算核心：从出发后读数中选出「时间严格递增、依序通过各组、截止前到终点」
// 的最早有效链（贪心：每组取时间允许范围内最早的一条有效打卡）。
// 逆序打卡、多余打卡不作完成依据。

/** 读取当前赛事配置 */
export function loadConfig(db) {
  const ev = db.prepare('SELECT * FROM event WHERE id = 1').get();
  if (!ev) return null;
  const groups = db
    .prepare('SELECT id, seq, name, cutoff_secs FROM checkpoint_group ORDER BY seq')
    .all();
  for (const g of groups) {
    g.points = db
      .prepare('SELECT point FROM group_point WHERE group_id = ? ORDER BY seq')
      .all(g.id)
      .map((r) => r.point);
  }
  return { ...ev, groups };
}

/**
 * 计算所有选手成绩。
 * 返回按耗时排序的结果数组（无有效链排后），同耗时并列。
 */
export function computeResults(db, config = loadConfig(db)) {
  if (!config) return [];
  const runners = db.prepare('SELECT bib, name FROM runner ORDER BY bib').all();
  const punches = db
    .prepare('SELECT id, record_no, bib, point, seconds, kind, status FROM punch')
    .all();
  return computeResultsOnReadings(config, runners, punches);
}

/**
 * 纯内存核算：给定配置、选手与打卡快照（整案预演用，绝不触碰数据库）。
 * punches 字段需含 id/record_no/bib/point/seconds/kind/status。
 */
export function computeResultsOnReadings(config, runners, punches) {
  const byBib = new Map();
  for (const p of punches) {
    if (p.status !== 'active') continue;
    if (!byBib.has(p.bib)) byBib.set(p.bib, []);
    byBib.get(p.bib).push(p);
  }
  for (const list of byBib.values()) {
    list.sort((a, b) => (a.seconds !== b.seconds ? a.seconds - b.seconds : a.id - b.id));
  }
  const results = runners.map((r) =>
    computeRunnerFromReadings(config, r.bib, r.name ?? null, byBib.get(r.bib) ?? [])
  );
  return rankResults(results);
}

/** 排序并赋予并列名次（完成者按耗时升序；其余不排名） */
export function rankResults(results) {
  results.sort((a, b) => {
    if (a.elapsed == null && b.elapsed == null) return a.bib.localeCompare(b.bib);
    if (a.elapsed == null) return 1;
    if (b.elapsed == null) return -1;
    if (a.elapsed !== b.elapsed) return a.elapsed - b.elapsed;
    return a.bib.localeCompare(b.bib);
  });
  let rank = 0;
  let prevElapsed = null;
  results.forEach((r, i) => {
    if (r.elapsed != null) {
      if (r.elapsed !== prevElapsed) rank = i + 1;
      r.rank = rank;
      prevElapsed = r.elapsed;
    }
  });
  return results;
}

/**
 * 单个选手的有效链（数据库版，保留旧接口）。
 * 有效读数 = status='active'（作废/已被更正的旧读数不参与）。
 */
export function computeRunner(db, config, bib, name = null) {
  const punches = db
    .prepare(
      `SELECT id, record_no, point, seconds, kind FROM punch
       WHERE bib = ? AND status = 'active' ORDER BY seconds, id`
    )
    .all(bib);
  return computeRunnerFromReadings(config, bib, name, punches);
}

/** 单个选手的有效链：纯读数版，逻辑与数据库版严格一致 */
export function computeRunnerFromReadings(config, bib, name = null, punches) {
  const base = { bib, name, status: 'ok', elapsed: null, failAt: null, detail: '', rank: null, chain: [] };

  // 唯一出发打卡（kind=start）。途中再次经过起点的打卡属于多余打卡，不作出发依据。
  const starts = punches.filter((p) => p.kind === 'start');
  if (starts.length === 0)
    return { ...base, status: 'no_start', detail: '缺少出发打卡' };
  if (starts.length > 1)
    return { ...base, status: 'bad_start', detail: '出发打卡不唯一' };
  const start = starts[0];
  if (start.point !== config.start_point)
    return { ...base, status: 'bad_start', detail: `出发打卡点位非起点「${config.start_point}」` };

  const after = punches.filter((p) => p.id !== start.id && p.seconds >= start.seconds);
  let lastSeconds = start.seconds;
  const chain = [slim(start)];

  // 依序通过各组：每组选时间严格递增的最早一条（可替代点位任一即可）
  for (const g of config.groups) {
    const hit = after.find(
      (p) =>
        p.seconds > lastSeconds &&
        g.points.includes(p.point) &&
        (g.cutoff_secs == null || p.seconds <= g.cutoff_secs)
    );
    if (!hit) {
      // 区分：组截止前未到
      const reason =
        g.cutoff_secs == null
          ? `未按顺序通过「${g.name}」（无严格递增的组内有效打卡）`
          : `未在 ${g.cutoff_secs} 秒截止前通过「${g.name}」`;
      return { ...base, status: 'group_dnf', failAt: g.name, detail: reason, chain };
    }
    chain.push(slim(hit));
    lastSeconds = hit.seconds;
  }

  // 终点：严格递增且在终点截止前（含等于）
  const finish = after.find(
    (p) =>
      p.point === config.finish_point &&
      p.seconds > lastSeconds &&
      p.seconds <= config.finish_cutoff
  );
  if (!finish) {
    const late = after
      .filter((p) => p.point === config.finish_point && p.seconds > lastSeconds)
      .sort((a, b) => a.seconds - b.seconds)[0];
    const detail = late
      ? `终点超时：${late.seconds}s 超过截止 ${config.finish_cutoff}s`
      : `未在 ${config.finish_cutoff} 秒截止前到达终点`;
    return { ...base, status: 'finish_dnf', failAt: '终点', detail, chain };
  }
  chain.push(slim(finish));
  return { ...base, elapsed: finish.seconds - start.seconds, chain };
}

function slim(p) {
  return { record_no: p.record_no, point: p.point, seconds: p.seconds, kind: p.kind };
}
