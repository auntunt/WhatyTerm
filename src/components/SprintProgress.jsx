import React, { useState, useEffect } from 'react';
import RalphOffice from './RalphOffice';
import './SprintProgress.css';

const SprintProgress = ({ socket, sessionId, goal }) => {
  const [progress, setProgress] = useState(null);
  const [collapsed, setCollapsed] = useState(true);
  const [planning, setPlanning] = useState(false);
  // Ralph 自主模式状态
  const [ralphRunning, setRalphRunning] = useState(false);
  const [ralphPhase, setRalphPhase] = useState('idle');
  const [ralphTask, setRalphTask] = useState(null);
  const [ralphLogs, setRalphLogs] = useState([]);
  // 向导异步拆分状态 + 任务确认
  const [planningStatus, setPlanningStatus] = useState(null); // null|running|done|failed
  const [planError, setPlanError] = useState('');
  const [enabledTasks, setEnabledTasks] = useState({});       // featureId -> bool（待确认勾选）
  const [pauseEach, setPauseEach] = useState(false);
  const [starting, setStarting] = useState(false);
  // 扇出（自主版 Orca）：同一任务并行 N 候选竞标，自动挑最高分 merge
  const [fanoutN, setFanoutN] = useState(1);            // 候选数（1=不扇出）
  const [fanoutClis, setFanoutClis] = useState([]);     // 多 CLI 竞标列表（空=同 CLI 多跑）
  const [fanoutState, setFanoutState] = useState(null); // 当前任务候选实时进度/得分
  // Stage 4：blocked 介入 + 成本
  const [cost, setCost] = useState(null);               // { summary, byProvider }
  const [snapshot, setSnapshot] = useState(null);       // 当前查看的失败快照
  const [editing, setEditing] = useState(null);         // 正在改需求的任务 { id, description }
  // 执行实时反馈
  const [ralphElapsed, setRalphElapsed] = useState(0); // 当前阶段已运行毫秒
  const [ralphBytes, setRalphBytes] = useState(0);     // 当前阶段输出字节
  const [ralphStream, setRalphStream] = useState([]);  // CLI 实时输出行
  const [officeView, setOfficeView] = useState('anim'); // anim|raw 执行可视化视图
  const [theater, setTheater] = useState(false);        // 剧场模式全屏

  useEffect(() => {
    setProgress(null);
    setPlanning(false);
    setRalphRunning(false);
    setRalphPhase('idle');
    setRalphTask(null);
    setRalphLogs([]);
    setPlanningStatus(null);
    setPlanError('');
    setEnabledTasks({});
    setRalphElapsed(0);
    setRalphBytes(0);
    setRalphStream([]);
    setFanoutState(null);
    setCost(null);
    setSnapshot(null);
    setEditing(null);
    if (!socket || !sessionId) return;

    socket.emit('progress:get', sessionId);
    socket.emit('ralph:status', { sessionId });

    // 收到 features 时初始化勾选（默认全选未完成的任务）
    const initEnabled = (progress) => {
      if (!progress?.features) return;
      setEnabledTasks(prev => {
        const en = { ...prev };
        progress.features.forEach(f => { if (en[f.id] === undefined) en[f.id] = f.status !== 'completed'; });
        return en;
      });
    };
    const handleData = (data) => {
      if (data.sessionId === sessionId) {
        setProgress(data.progress);
        setPlanning(false);
        initEnabled(data.progress);
      }
    };
    const handleUpdated = (data) => {
      if (data.sessionId === sessionId) {
        setProgress(data.progress);
        initEnabled(data.progress);
      }
    };
    // 向导后台拆分进度
    const handlePlanning = (data) => {
      if (data.sessionId !== sessionId) return;
      setPlanningStatus(data.status);
      if (data.status === 'running') { setPlanError(''); setCollapsed(false); }
      if (data.status === 'failed') setPlanError(data.error || '拆分失败');
      if (data.status === 'done') socket.emit('progress:get', sessionId);
    };
    const handleRalphState = (data) => {
      if (data.sessionId !== sessionId) return;
      setRalphRunning(!!data.running);
      if (data.phase) setRalphPhase(data.phase);
      if (data.currentTask !== undefined) setRalphTask(data.currentTask);
      // 阶段切换：清空上一阶段的实时输出与计时
      setRalphStream([]); setRalphElapsed(0); setRalphBytes(0);
      // 状态变化时刷新进度
      socket.emit('progress:get', sessionId);
    };
    const handleRalphLog = (data) => {
      if (data.sessionId !== sessionId) return;
      setRalphLogs(prev => [...prev.slice(-49), data.line]);
    };
    // CLI 实时输出流（headless 输出 + 运行计时 + 输出量）
    const handleRalphProgress = (data) => {
      if (data.sessionId !== sessionId) return;
      if (typeof data.elapsedMs === 'number') setRalphElapsed(data.elapsedMs);
      if (typeof data.bytes === 'number') setRalphBytes(data.bytes);
      if (data.lines?.length) setRalphStream(prev => [...prev, ...data.lines].slice(-60));
    };
    // 扇出候选实时进度：维护每候选的阶段/得分，供面板显示各候选竞标情况
    const handleRalphFanout = (data) => {
      if (data.sessionId !== sessionId) return;
      setFanoutState(prev => {
        if (data.phase === 'start') {
          const cands = {};
          (data.candidates || []).forEach(c => { cands[c.index] = { ...c, phase: 'queued' }; });
          return { taskId: data.taskId, cands, winner: null, done: false };
        }
        if (data.phase === 'done') {
          return prev ? { ...prev, winner: data.winner, merged: data.merged, done: true,
            results: data.results } : prev;
        }
        if (!prev) return prev;
        const cands = { ...prev.cands };
        const idx = data.index;
        if (idx != null) {
          cands[idx] = { ...(cands[idx] || { index: idx }),
            aiType: data.aiType || cands[idx]?.aiType,
            phase: data.phase,
            ...(data.score != null ? { score: data.score, passed: data.passed, confidence: data.confidence } : {}),
          };
        }
        return { ...prev, cands };
      });
    };

    // Stage 4：任务被 blocked → 刷新进度并拉取成本
    const handleRalphBlocked = (data) => {
      if (data.sessionId !== sessionId) return;
      socket.emit('progress:get', sessionId);
      socket.emit('ralph:cost', { sessionId });
    };
    const handleCost = (data) => {
      if (data.sessionId !== sessionId) return;
      setCost({ summary: data.summary, byProvider: data.byProvider });
    };
    const handleSnapshot = (data) => {
      if (data.sessionId !== sessionId) return;
      setSnapshot(data.snapshot || { empty: true });
    };

    socket.on('progress:data', handleData);
    socket.on('progress:updated', handleUpdated);
    socket.on('ralph:state', handleRalphState);
    socket.on('ralph:log', handleRalphLog);
    socket.on('ralph:planning', handlePlanning);
    socket.on('ralph:progress', handleRalphProgress);
    socket.on('ralph:fanout', handleRalphFanout);
    socket.on('ralph:blocked', handleRalphBlocked);
    socket.on('ralph:cost', handleCost);
    socket.on('ralph:task:snapshot', handleSnapshot);
    // 初次挂载拉一次成本
    socket.emit('ralph:cost', { sessionId });

    return () => {
      socket.off('progress:data', handleData);
      socket.off('progress:updated', handleUpdated);
      socket.off('ralph:state', handleRalphState);
      socket.off('ralph:log', handleRalphLog);
      socket.off('ralph:planning', handlePlanning);
      socket.off('ralph:progress', handleRalphProgress);
      socket.off('ralph:fanout', handleRalphFanout);
      socket.off('ralph:blocked', handleRalphBlocked);
      socket.off('ralph:cost', handleCost);
      socket.off('ralph:task:snapshot', handleSnapshot);
    };
  }, [socket, sessionId]);

  const rePlan = (e) => {
    e.stopPropagation();
    if (!goal || planning) return;
    setPlanning(true);
    socket.emit('progress:plan', { sessionId, goal });
    // planning 状态在收到 progress:data 时自动清除
    setTimeout(() => setPlanning(false), 30000);
  };

  const toggleEvaluator = () => {
    const enabled = !progress.evaluatorConfig?.enabled;
    socket.emit('evaluator:toggle', { sessionId, enabled });
    setProgress(prev => ({
      ...prev,
      evaluatorConfig: { ...prev.evaluatorConfig, enabled }
    }));
  };

  // Ralph 自主模式：拆分（带验收标准）
  const ralphPlan = (e) => {
    e.stopPropagation();
    if (!goal || planning) return;
    setPlanning(true);
    socket.emit('ralph:plan', { sessionId, goal });
    setTimeout(() => setPlanning(false), 60000);
  };

  // Ralph 自主模式：启动/停止
  const toggleRalph = (e) => {
    e.stopPropagation();
    if (ralphRunning) {
      socket.emit('ralph:stop', { sessionId });
    } else {
      socket.emit('ralph:start', { sessionId, maxIterations: 100 });
      setRalphRunning(true);
    }
  };

  // Ralph 自主模式：暂停/继续
  const togglePause = (e) => {
    e.stopPropagation();
    if (ralphPhase === 'paused') {
      socket.emit('ralph:resume', { sessionId });
    } else {
      socket.emit('ralph:stop', { sessionId }); // 无单独暂停指令时，停止即中断
    }
  };

  // 任务确认：勾选/取消某任务
  const toggleTask = (id, e) => {
    e.stopPropagation();
    setEnabledTasks(prev => ({ ...prev, [id]: !prev[id] }));
  };

  // ── Stage 4：blocked 任务介入操作 ──
  const skipTask = (taskId, mode) => socket.emit('ralph:task:skip', { sessionId, taskId, mode });
  const retryTask = (taskId) => socket.emit('ralph:task:retry', { sessionId, taskId });
  const viewSnapshot = (taskId) => { setSnapshot(null); socket.emit('ralph:task:snapshot', { sessionId, taskId }); };
  const openEdit = (f) => setEditing({ id: f.id, name: f.name, description: f.description || '' });
  const submitEdit = () => {
    if (!editing) return;
    socket.emit('ralph:task:edit', {
      sessionId, taskId: editing.id, name: editing.name, description: editing.description,
    });
    setEditing(null);
  };

  // 组装扇出配置：{count, clis}。count<=1 且无多 CLI → null（不扇出，保持原行为）
  const buildFanout = () => {
    const count = Math.max(1, parseInt(fanoutN, 10) || 1);
    const clis = fanoutClis.filter(Boolean);
    if (count <= 1 && clis.length <= 1) return null;
    return { count, clis };
  };

  // 确认任务清单并开始自主开发（走向导执行入口，带 git 干净护栏）
  const startRalphWizard = (e) => {
    e.stopPropagation();
    if (starting || ralphRunning) return;
    const ids = (progress?.features || []).filter(f => enabledTasks[f.id]).map(f => f.id);
    if (ids.length === 0) { setPlanError('请至少勾选一个任务'); return; }
    setPlanError('');
    const fanout = buildFanout();
    const doStart = (ignoreDirty) => {
      setStarting(true);
      socket.emit('ralph:wizard:start',
        { sessionId, enabledTaskIds: ids, pauseAfterEachTask: pauseEach, ignoreDirty, fanout },
        (res) => {
          setStarting(false);
          if (res?.blocked === 'dirty') {
            if (window.confirm('工作区有未提交改动，仍要开始吗？\n\n' + (res.files || []).join('\n'))) doStart(true);
            return;
          }
          if (res?.error) { setPlanError(res.error); return; }
          // started：ralph:state 事件会把面板切到执行态
        });
    };
    doStart(false);
  };

  // 断点继续：从未完成任务接着跑（getNextTask 天然跳过已完成，不切分支、不重做）
  const resumeRalph = (e) => {
    e.stopPropagation();
    if (ralphRunning) return;
    socket.emit('ralph:start', { sessionId, maxIterations: 100 });
    setRalphRunning(true);
  };

  const fmtTime = (ms) => {
    const s = Math.floor((ms || 0) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const fmtBytes = (b) => (!b ? '0B' : b < 1024 ? `${b}B` : `${(b / 1024).toFixed(1)}KB`);
  const fmtNum = (n) => {
    n = Number(n) || 0;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  };

  if (!progress?.features?.length) {
    // 向导后台拆分中：即使还没任务清单也显示状态（用户此时已在会话窗口，可自由切换）
    if (planningStatus === 'running') {
      return (
        <div className="sprint-progress">
          <div className="sprint-header">
            <div className="sprint-title">
              <span className="sprint-icon">⏳</span>
              <span>正在分析需求、设计技术方案与拆分任务…（可切到其他会话，完成后回来查看）</span>
            </div>
          </div>
        </div>
      );
    }
    if (planningStatus === 'failed') {
      return (
        <div className="sprint-progress">
          <div className="sprint-header" onClick={ralphPlan} style={{ cursor: 'pointer' }}>
            <div className="sprint-title">
              <span className="sprint-icon">⚠️</span>
              <span>{planError || '拆分失败'} · 点击重试</span>
            </div>
          </div>
        </div>
      );
    }
    if (!goal || goal.length < 3) return null;
    return (
      <div className="sprint-progress">
        <div className="sprint-header" onClick={rePlan} style={{ cursor: planning ? 'wait' : 'pointer' }}>
          <div className="sprint-title">
            <span className="sprint-icon">📋</span>
            <span>{planning ? '正在分析项目并规划...' : '点击生成 Sprint 规划'}</span>
          </div>
        </div>
      </div>
    );
  }

  const total = progress.features.length;
  const completed = progress.features.filter(f => f.status === 'completed').length;
  const percent = Math.round(completed / total * 100);
  const current = progress.features.find(f => f.status === 'in_progress')
    || progress.features.find(f => f.status === 'pending');

  // 断点续跑判定：自主模式 + 有未完成 + 当前没在跑 + 已跑过一部分 = 中断态
  const unfinished = progress.features.filter(f => !f.blocked && f.status !== 'completed').length;
  const isAutonomous = progress.mode === 'autonomous';
  const hasStarted = completed > 0 || progress.features.some(f => f.status === 'in_progress');
  const isInterrupted = isAutonomous && unfinished > 0 && !ralphRunning && hasStarted;

  return (
    <div className="sprint-progress">
      <div className="sprint-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="sprint-title">
          <span className="sprint-icon">📋</span>
          <span>Sprint 进度</span>
          <span className="sprint-badge">{completed}/{total}</span>
        </div>
        <div className="sprint-bar-mini">
          <div className="sprint-bar-fill" style={{ width: `${percent}%` }} />
        </div>
        <button className="sprint-replan-btn" onClick={rePlan} disabled={planning}
          title="重新分析项目并规划">
          {planning ? '⏳' : '🔄'}
        </button>
        <span className="sprint-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>

      {!collapsed && (
        <div className="sprint-body">
          <div className="sprint-features">
            {progress.features.map((f, i) => (
              <div key={f.id} className={`sprint-feature ${f.blocked ? 'blocked' : f.status}`}>
                {!ralphRunning && f.status !== 'completed' ? (
                  <input
                    type="checkbox"
                    className="feature-check"
                    checked={!!enabledTasks[f.id]}
                    onChange={(e) => toggleTask(f.id, e)}
                    onClick={(e) => e.stopPropagation()}
                    title="勾选要执行的任务"
                  />
                ) : (
                  <span className="feature-status-icon">
                    {f.blocked ? '🚫' :
                     f.status === 'completed' ? '✅' :
                     f.status === 'in_progress' ? '🔨' : '⬜'}
                  </span>
                )}
                <span className="feature-name">{f.name}</span>
                {f.retryCount > 0 && !f.blocked && (
                  <span className="feature-retry" title={f.validationNotes || ''}>↻{f.retryCount}</span>
                )}
              </div>
            ))}
          </div>
          {current && (
            <div className="sprint-current">
              当前: <strong>{current.name}</strong>
            </div>
          )}
          <div className="sprint-footer">
            <label className="evaluator-toggle">
              <input
                type="checkbox"
                checked={progress.evaluatorConfig?.enabled || false}
                onChange={toggleEvaluator}
              />
              <span>Evaluator 对抗评估</span>
            </label>
            {progress.sprint?.completionCriteria && (
              <div className="sprint-criteria" title={progress.sprint.completionCriteria}>
                目标: {progress.sprint.completionCriteria.substring(0, 40)}...
              </div>
            )}
          </div>

          {/* Ralph 自主模式控制区 */}
          <div className="ralph-panel">
            {planError && <div className="ralph-plan-error">⚠️ {planError}</div>}
            {/* 中断态：一键断点继续（从未完成任务接着跑，不重做已完成） */}
            {isInterrupted && (
              <div className="ralph-resume-banner">
                <span className="ralph-resume-text">⏸ 上次自主开发未完成 · 已完成 {completed}/{total}</span>
                <button className="ralph-start-btn" onClick={resumeRalph}
                  title="从未完成任务接着跑，已完成的不重做">🔄 断点继续</button>
              </div>
            )}
            {/* 全新待确认态：勾选任务 + 开始自主开发（刚拆分完、未开始） */}
            {!ralphRunning && !isInterrupted && (
              <>
                <div className="ralph-confirm-row">
                  <button className="ralph-start-btn" onClick={startRalphWizard} disabled={starting}
                    title="确认勾选的任务并开始自主开发（Developer→Validator 循环，带 git 干净护栏）">
                    {starting ? '⏳ 启动中…' : '🚀 开始自主开发'}
                  </button>
                  <label className="ralph-pause-toggle" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={pauseEach} onChange={(e) => setPauseEach(e.target.checked)} />
                    <span>每个任务后暂停</span>
                  </label>
                </div>
                {/* 扇出（自主版 Orca）：同任务并行多候选竞标，自动挑最高分 merge */}
                <div className="ralph-fanout-row" onClick={(e) => e.stopPropagation()}
                  title="同一任务并行派 N 个候选，各自实跑验收打分，自动选最高分合并回来">
                  <span className="ralph-fanout-label">⚔️ 扇出竞标</span>
                  <select value={fanoutN} onChange={(e) => setFanoutN(parseInt(e.target.value, 10))}>
                    <option value={1}>关闭</option>
                    <option value={2}>2 候选</option>
                    <option value={3}>3 候选</option>
                    <option value={4}>4 候选</option>
                  </select>
                  {fanoutN > 1 && (
                    <span className="ralph-fanout-clis">
                      {['claude', 'codex', 'gemini', 'grok'].map(c => (
                        <label key={c} className="ralph-fanout-cli">
                          <input type="checkbox" checked={fanoutClis.includes(c)}
                            onChange={(e) => setFanoutClis(prev =>
                              e.target.checked ? [...prev, c] : prev.filter(x => x !== c))} />
                          {c}
                        </label>
                      ))}
                      <span className="ralph-fanout-hint">
                        {fanoutClis.length ? '多 CLI 竞标' : '同 CLI 多跑'}
                      </span>
                    </span>
                  )}
                </div>
              </>
            )}
            {/* 扇出竞标实时看板：各候选阶段 + 得分 + 赢家 */}
            {fanoutState && (ralphRunning || fanoutState.done) && (
              <div className="ralph-fanout-board" onClick={(e) => e.stopPropagation()}>
                <div className="ralph-fanout-board-title">
                  ⚔️ 候选竞标{fanoutState.done && fanoutState.winner
                    ? ` · 赢家 c${fanoutState.winner.index}(${fanoutState.winner.aiType}) ${fanoutState.merged ? '已合并' : '未合并'}`
                    : '（进行中）'}
                </div>
                <div className="ralph-fanout-cands">
                  {Object.values(fanoutState.cands || {}).map(c => (
                    <div key={c.index}
                      className={`ralph-fanout-cand ${fanoutState.winner?.index === c.index ? 'winner' : ''}`}>
                      <span className="rfc-name">c{c.index} · {c.aiType}</span>
                      <span className="rfc-phase">{
                        c.phase === 'developing' ? '👨‍💻 开发' :
                        c.phase === 'validating' ? '🔍 验证' :
                        c.phase === 'scored' ? `✓ ${Number(c.score).toFixed(1)}分` :
                        c.phase === 'dev_failed' ? '✗ 失败' : '⏳ 排队'
                      }</span>
                      {c.phase === 'scored' && (
                        <span className={`rfc-score ${c.passed ? 'pass' : 'fail'}`}>
                          {c.passed ? '通过' : '未过'} · 置信{Math.round((c.confidence || 0) * 100)}%
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Stage 4：blocked 任务人工介入面板 */}
            {(() => {
              const blockedTasks = (progress?.features || []).filter(f => f.blocked && !f.excluded);
              if (!blockedTasks.length) return null;
              return (
                <div className="ralph-blocked-panel" onClick={(e) => e.stopPropagation()}>
                  <div className="ralph-blocked-title">🚧 {blockedTasks.length} 个任务被阻塞，需要介入</div>
                  {blockedTasks.map(f => (
                    <div key={f.id} className="ralph-blocked-item">
                      <div className="rbi-head">
                        <span className="rbi-id">{f.id}</span> {f.name}
                      </div>
                      {f.validationNotes && <div className="rbi-reason">失败原因：{f.validationNotes}</div>}
                      <div className="rbi-actions">
                        <button onClick={() => retryTask(f.id)} title="解除阻塞并重试">↻ 重试</button>
                        <button onClick={() => openEdit(f)} title="修改需求/验收标准后重试">✎ 改需求</button>
                        <button onClick={() => skipTask(f.id, 'skip')} title="当作完成跳过，解锁依赖它的后续任务">⤼ 跳过</button>
                        <button onClick={() => skipTask(f.id, 'exclude')} title="彻底排除该任务">✕ 排除</button>
                        {f.hasSnapshot && <button onClick={() => viewSnapshot(f.id)} title="查看失败快照">🔍 快照</button>}
                      </div>
                      {editing?.id === f.id && (
                        <div className="rbi-edit">
                          <input value={editing.name}
                            onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="任务标题" />
                          <textarea value={editing.description} rows={3}
                            onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                            placeholder="需求/技术设计描述" />
                          <div className="rbi-edit-actions">
                            <button onClick={() => setEditing(null)}>取消</button>
                            <button className="primary" onClick={submitEdit}>保存并重试</button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              );
            })()}
            {/* 失败快照查看 */}
            {snapshot && (
              <div className="ralph-snapshot" onClick={(e) => e.stopPropagation()}>
                <div className="ralph-snapshot-head">
                  <span>失败快照{snapshot.featureId ? ` · ${snapshot.featureId}` : ''}</span>
                  <button onClick={() => setSnapshot(null)}>✕ 关闭</button>
                </div>
                {snapshot.empty ? (
                  <div className="ralph-snapshot-empty">无快照数据</div>
                ) : (
                  <>
                    <div className="ralph-snapshot-section">📝 Validator 全文</div>
                    <pre className="ralph-snapshot-pre">{snapshot.validatorOutput || '（无）'}</pre>
                    <div className="ralph-snapshot-section">🔧 工作区 diff</div>
                    <pre className="ralph-snapshot-pre">{snapshot.diff || '（无改动）'}</pre>
                  </>
                )}
              </div>
            )}
            {/* 成本 / token 统计 */}
            {cost?.summary?.total_tokens > 0 && (
              <div className="ralph-cost" onClick={(e) => e.stopPropagation()}>
                <span className="ralph-cost-item">🎫 {fmtNum(cost.summary.total_tokens)} tokens</span>
                <span className="ralph-cost-item">↑ {fmtNum(cost.summary.total_input)} 输入</span>
                <span className="ralph-cost-item">↓ {fmtNum(cost.summary.total_output)} 输出</span>
                <span className="ralph-cost-item">🔁 {fmtNum(cost.summary.request_count)} 次请求</span>
              </div>
            )}
            <div className="ralph-controls">
              <button className="ralph-replan-btn" onClick={ralphPlan} disabled={planning}
                title="按需求文档/设计文档拆分为带验收标准的可执行任务">
                {planning ? '⏳ 拆分中' : '🧩 重新拆分'}
              </button>
              <button className={`ralph-run-btn ${ralphRunning ? 'running' : ''}`} onClick={toggleRalph}
                title={ralphRunning ? '停止自主执行' : '直接启动（跳过确认）'}>
                {ralphRunning ? '⏹ 停止自主' : '🤖 直接执行'}
              </button>
              {ralphRunning && ralphPhase === 'paused' && (
                <button className="ralph-resume-btn" onClick={togglePause} title="继续执行下一个任务">
                  ▶ 继续
                </button>
              )}
              {ralphRunning && (
                <span className={`ralph-phase ralph-phase-${ralphPhase}`}>
                  {ralphPhase === 'developing' ? '👨‍💻 开发中' :
                   ralphPhase === 'validating' ? '🔍 验证中' :
                   ralphPhase === 'paused' ? '⏸ 已暂停' :
                   ralphPhase === 'done' ? '✅ 完成' : '⏳ 调度中'}
                  {ralphTask && <em> · {ralphTask.name}</em>}
                  {(ralphPhase === 'developing' || ralphPhase === 'validating') && (
                    <span className="ralph-meter"> · ⏱ {fmtTime(ralphElapsed)} · {fmtBytes(ralphBytes)}
                      <span className="ralph-pulse" /></span>
                  )}
                </span>
              )}
            </div>
            {/* 执行可视化：默认像素办公室动画，可切原始 CLI 输出流 */}
            {ralphRunning && (
              <>
                <div className="ralph-view-switch">
                  <button className={officeView === 'anim' ? 'active' : ''} onClick={() => setOfficeView('anim')}>🏭 动画</button>
                  <button className={officeView === 'raw' ? 'active' : ''} onClick={() => setOfficeView('raw')}>📜 原始输出</button>
                </div>
                {officeView === 'anim' ? (
                  <RalphOffice
                    features={progress.features}
                    phase={ralphPhase}
                    currentTaskId={ralphTask?.id || progress.features.find(f => f.status === 'in_progress')?.id}
                    elapsed={ralphElapsed}
                    completed={completed}
                    total={total}
                    theater={theater}
                    onToggleTheater={() => setTheater(t => !t)}
                  />
                ) : (
                  ralphStream.length > 0 && (
                    <div className="ralph-stream" ref={el => { if (el) el.scrollTop = el.scrollHeight; }}>
                      {ralphStream.slice(-30).map((l, i) => (
                        <div key={i} className="ralph-stream-line">{l}</div>
                      ))}
                    </div>
                  )
                )}
              </>
            )}
            {ralphLogs.length > 0 && (
              <div className="ralph-logs">
                {ralphLogs.slice(-8).map((l, i) => (
                  <div key={i} className="ralph-log-line">{l}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default SprintProgress;
