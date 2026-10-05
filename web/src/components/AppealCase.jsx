import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { fmtTime } from './Results.jsx';

const KIND_LABEL = { start: '出发', enroute: '途中', finish: '终点' };
const STATUS_LABEL = {
  ok: { text: '完成', cls: 'ok' },
  group_dnf: { text: '组未完成', cls: 'dnf' },
  finish_dnf: { text: '终点超时', cls: 'dnf' },
  no_start: { text: '无出发', cls: 'bad' },
  bad_start: { text: '出发异常', cls: 'bad' },
};

function ChainChips({ chain }) {
  return (
    <span className="chain">
      {chain.map((c, i) => (
        <React.Fragment key={c.record_no}>
          {i > 0 && <span className="arrow">→</span>}
          <span className="chip" title={`记录号 ${c.record_no}，${c.seconds}s`}>
            {c.point}<small>{c.seconds}s</small>
          </span>
        </React.Fragment>
      ))}
      {chain.length === 0 && <span className="muted">（无）</span>}
    </span>
  );
}

function ResultCell({ r }) {
  if (!r) return <span className="muted">—</span>;
  const st = STATUS_LABEL[r.status] || { text: r.status, cls: 'bad' };
  return (
    <div>
      <span className={`badge ${st.cls}`}>{st.text}</span>{' '}
      {r.elapsed != null ? <b>{fmtTime(r.elapsed)}（{r.elapsed}s）</b> : <span className="muted">无成绩</span>}
      {' '}名次 <b>{r.rank ?? '—'}</b>
      {(r.failAt || r.detail) && (
        <div className="muted small">{r.failAt ? <><b>{r.failAt}</b>：{r.detail}</> : r.detail}</div>
      )}
    </div>
  );
}

export default function AppealCase({ event, onChanged, onError }) {
  const [data, setData] = useState(null);
  const [bib, setBib] = useState('');
  // 整案操作集合：punchId -> { action, reason, newPoint, newSeconds }
  const [ops, setOps] = useState(new Map());
  const [editing, setEditing] = useState(null); // { punch, mode }
  const [form, setForm] = useState({ reason: '', newPoint: '', newSeconds: '' });
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(null);

  const load = useCallback(() => {
    api.punches(bib || undefined).then(setData).catch(() => setData(null));
  }, [bib]);

  useEffect(() => { load(); }, [load]);

  const byBib = useMemo(() => {
    const m = new Map();
    for (const p of data?.punches || []) {
      if (!m.has(p.bib)) m.set(p.bib, { name: p.runner_name, punches: [] });
      m.get(p.bib).punches.push(p);
    }
    return [...m.entries()];
  }, [data]);

  const opCount = ops.size;

  const startEdit = (p, mode) => {
    setEditing({ punch: p, mode });
    const existing = ops.get(p.id);
    setForm({
      reason: existing?.reason || '',
      newPoint: mode === 'correct' ? (existing?.newPoint ?? p.point) : '',
      newSeconds: mode === 'correct' ? String(existing?.newSeconds ?? p.seconds) : '',
    });
  };

  const saveEdit = () => {
    const { punch, mode } = editing;
    const reason = form.reason.trim();
    if (!reason) { onError(new Error('必须填写处理原因')); return; }
    const next = new Map(ops);
    if (mode === 'void') {
      next.set(punch.id, { punch, action: 'void', reason });
    } else {
      const seconds = Number(form.newSeconds);
      const newPoint = form.newPoint.trim();
      if (!newPoint) { onError(new Error('更正后的点位必填')); return; }
      if (!Number.isInteger(seconds) || seconds < 0) {
        onError(new Error('更正后的秒数须为非负整数'));
        return;
      }
      next.set(punch.id, { punch, action: 'correct', reason, newPoint, newSeconds: seconds });
    }
    setOps(next);
    setEditing(null);
    setPreview(null);
    setDone(null);
  };

  const removeOp = id => {
    const next = new Map(ops);
    next.delete(id);
    setOps(next);
    setPreview(null);
  };

  const buildPayload = revision => ({
    expectedRevision: revision,
    operations: [...ops.values()].map(o => ({
      punchId: o.punch.id,
      action: o.action,
      reason: o.reason,
      ...(o.action === 'correct' ? { newPoint: o.newPoint, newSeconds: o.newSeconds } : {}),
    })),
  });

  const doPreview = async () => {
    setPreviewing(true);
    try {
      const r = await api.appealPreview(buildPayload(event.revision));
      setPreview(r);
      setDone(null);
    } catch (err) {
      setPreview(null);
      onError(err);
    } finally {
      setPreviewing(false);
    }
  };

  const doConfirm = async () => {
    if (!preview) return;
    setConfirming(true);
    try {
      const r = await api.appealConfirm({
        ...buildPayload(preview.revision),
        caseFingerprint: preview.caseFingerprint,
      });
      setDone(r);
      setOps(new Map());
      setPreview(null);
      await onChanged();
      load();
    } catch (err) {
      onError(err);
      setPreview(null);
    } finally {
      setConfirming(false);
    }
  };

  if (!event?.configured) return <p className="muted">请先配置赛事。</p>;

  return (
    <div className="panel">
      <h2>整案申诉复核（预演 → 确认）</h2>
      <p className="muted small">
        同一申诉可对<b>多条</b>现有打卡逐条指定「作废 / 更正」（含原因）：更正须填新点位与非负整数秒数；
        已作废打卡不得更正；同一打卡在整案中只能指定一次。提交前系统基于<b>当前赛事修订号</b>
        在内存中预演整案，给出处理前后所有受影响选手的成绩、名次、失败原因与有效链差异
        （包含仅因他人变化而名次改变的选手），<b>预演不改动任何数据</b>。确认时绑定预演的修订号与操作集合，
        赛事已变化将返回 409 须重新预演；全部变更与逐条审计单事务落库，修订号只推进一次，失败绝不部分生效。
      </p>

      <div className="filter">
        <input placeholder="按号码布筛选待处理打卡（留空显示全部）" value={bib} onChange={e => setBib(e.target.value)} />
        <button className="btn" onClick={load}>查询</button>
      </div>

      {opCount > 0 && (
        <div className="case-cart">
          <h3>本案操作集（{opCount} 条）· 绑定修订 #{event.revision}</h3>
          <table className="grid compact">
            <thead>
              <tr><th>号码布</th><th>记录号</th><th>处理</th><th>现值 → 新值</th><th>原因</th><th></th></tr>
            </thead>
            <tbody>
              {[...ops.values()].map(o => (
                <tr key={o.punch.id}>
                  <td>{o.punch.bib}</td>
                  <td>{o.punch.record_no}</td>
                  <td>
                    <span className={`badge ${o.action === 'void' ? 'bad' : 'warn'}`}>
                      {o.action === 'void' ? '作废' : '更正'}
                    </span>
                  </td>
                  <td>
                    {o.punch.point}@{o.punch.seconds}s
                    {o.action === 'correct' && <> → <b>{o.newPoint}@{o.newSeconds}s</b></>}
                    {o.action === 'void' && <> → <span className="muted">不参与核算</span></>}
                  </td>
                  <td className="muted small">{o.reason}</td>
                  <td><button className="btn small" onClick={() => removeOp(o.punch.id)}>移除</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="case-actions">
            <button className="btn primary" disabled={previewing} onClick={doPreview}>
              {previewing ? '预演中…' : `基于修订 #${event.revision} 预演整案`}
            </button>
            {preview && (
              <button className="btn danger" disabled={confirming} onClick={doConfirm}>
                {confirming ? '确认提交中…' : `确认提交（修订 #${preview.revision}，${preview.projections.length} 条一次落库）`}
              </button>
            )}
            <span className="muted small">预演只读；确认才推进修订号（恰好 +1）。</span>
          </div>
        </div>
      )}

      {done && (
        <div className="notice ok case-result">
          <div>
            ✓ 整案已确认：修订 #{done.revision}，{done.applied.length} 条变更与逐条审计已一次性落库。
            <button onClick={() => setDone(null)}>×</button>
          </div>
          <table className="grid compact">
            <thead><tr><th>号码布</th><th>记录号</th><th>处理</th><th>处理后</th></tr></thead>
            <tbody>
              {done.applied.map(a => (
                <tr key={a.punchId}>
                  <td>{a.bib}</td><td>{a.recordNo}</td>
                  <td><span className={`badge ${a.action === 'void' ? 'bad' : 'warn'}`}>{a.action === 'void' ? '作废' : '更正'}</span></td>
                  <td>
                    {a.action === 'void'
                      ? `${a.after.point}@${a.after.seconds}s 已作废`
                      : `${a.before.point}@${a.before.seconds}s → ${a.after.point}@${a.after.seconds}s`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <AffectedTable affected={done.affected} title="本次受影响选手最终结果（含仅名次变化）" />
        </div>
      )}

      {preview && (
        <div className="preview-box">
          <h3>预演结果（修订 #{preview.revision}，未落库）</h3>
          <p className="muted small">
            操作集合指纹 <code>{preview.caseFingerprint.slice(0, 16)}…</code>，确认时原样回传以绑定本预演。
          </p>
          <AffectedTable affected={preview.affected} title="处理前后对比 · 所有受影响选手" />
        </div>
      )}

      {byBib.map(([b, info]) => (
        <div key={b} className="bib-block">
          <h3>{b} · {info.name || '未命名'}</h3>
          <table className="grid compact">
            <thead>
              <tr><th>记录号</th><th>类型</th><th>点位</th><th>距发枪秒数</th><th>状态</th><th>加入整案</th></tr>
            </thead>
            <tbody>
              {info.punches.map(p => {
                const op = ops.get(p.id);
                const isEditing = editing?.punch?.id === p.id;
                return (
                  <React.Fragment key={p.id}>
                    <tr className={p.status === 'voided' ? 'row-void' : ''}>
                      <td>{p.record_no}</td>
                      <td>{KIND_LABEL[p.kind]}</td>
                      <td>{p.point}</td>
                      <td>{p.seconds}s（{fmtTime(p.seconds)}）</td>
                      <td>
                        {p.status === 'voided'
                          ? <span className="badge bad">已作废</span>
                          : <span className="badge ok">有效</span>}
                      </td>
                      <td>
                        {op ? (
                          <span className={`badge ${op.action === 'void' ? 'bad' : 'warn'}`}>
                            已加入：{op.action === 'void' ? '作废' : '更正'}
                          </span>
                        ) : isEditing ? null : (
                          p.status === 'active' && (
                            <>
                              <button className="btn small" onClick={() => startEdit(p, 'correct')}>更正</button>
                              <button className="btn small danger" onClick={() => startEdit(p, 'void')}>作废</button>
                            </>
                          )
                        )}
                      </td>
                    </tr>
                    {isEditing && (
                      <tr className="edit-row">
                        <td colSpan="6">
                          {editing.mode === 'correct' && (
                            <div className="inline-fields">
                              <label>新点位 <input value={form.newPoint} onChange={e => setForm({ ...form, newPoint: e.target.value })} /></label>
                              <label>新秒数 <input type="number" min="0" value={form.newSeconds} onChange={e => setForm({ ...form, newSeconds: e.target.value })} /></label>
                            </div>
                          )}
                          <div className="inline-fields">
                            <label className="grow">原因（必填，永久留痕）
                              <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="如：依据申诉照片更正" />
                            </label>
                            <button className="btn primary" onClick={saveEdit}>加入整案</button>
                            <button className="btn" onClick={() => setEditing(null)}>取消</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ))}
      {byBib.length === 0 && <p className="muted">暂无打卡记录。</p>}
    </div>
  );
}

function AffectedTable({ affected, title }) {
  return (
    <div>
      <h4>{title}（{affected.length} 人）</h4>
      <table className="grid compact">
        <thead>
          <tr>
            <th>号码布</th><th>姓名</th><th>触发</th>
            <th>处理前</th><th>处理后</th><th>有效链差异</th>
          </tr>
        </thead>
        <tbody>
          {affected.map(a => {
            const tags = [];
            if (a.directlyAffected) tags.push(<span key="d" className="badge warn">直接处理</span>);
            if (a.rankChanged) tags.push(<span key="r" className="badge">名次 {a.before?.rank ?? '—'} → {a.after?.rank ?? '—'}</span>);
            if (a.statusChanged) tags.push(<span key="s" className="badge bad">状态变化</span>);
            if (a.elapsedChanged) tags.push(<span key="e" className="badge">耗时变化</span>);
            if (a.failureChanged) tags.push(<span key="f" className="badge bad">失败原因变化</span>);
            if (a.chainChanged) tags.push(<span key="c" className="badge">链变化</span>);
            return (
              <tr key={a.bib}>
                <td>{a.bib}</td>
                <td>{a.name || '—'}</td>
                <td className="tag-cell">{tags.length ? tags : <span className="muted small">仅连带影响</span>}</td>
                <td><ResultCell r={a.before} /></td>
                <td><ResultCell r={a.after} /></td>
                <td className="chain-diff">
                  <ChainDiff d={a.chainDiff} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ChainDiff({ d }) {
  if (!d || (!d.added.length && !d.removed.length && !d.modified.length))
    return <span className="muted small">无差异</span>;
  return (
    <div className="small">
      {d.added.map(c => (
        <div key={`a${c.record_no}`} className="diff-add">＋ <ChainChips chain={[c]} /></div>
      ))}
      {d.modified.map(m => (
        <div key={`m${m.before.record_no}`} className="diff-mod">
          ✎ {m.before.point}@{m.before.seconds}s → {m.after.point}@{m.after.seconds}s
        </div>
      ))}
      {d.removed.map(c => (
        <div key={`r${c.record_no}`} className="diff-remove">－ {c.point}@{c.seconds}s</div>
      ))}
    </div>
  );
}
