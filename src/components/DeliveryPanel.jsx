import React, { useState, useEffect, useRef } from 'react';
import './DeliveryPanel.css';

// DeliveryEngine 三层 loop（macro/meso/micro）前端面板
// 消费 delivery:* 事件：需求澄清 → 启动交付 → 集成验证进度可视化
// 与 SprintProgress 共存：仅负责“需求→拆解→集成验证”的三层编排视图
const PHASE_LABEL = {
  idle: '待启动',
  starting: '⏳ 启动中',
  decomposing: '🧩 拆解需求',
  executing: '👨‍💻 执行子任务',
  integrating: '🔍 集成验证',
  done: '✅ 交付完成',
  error: '⚠️ 异常终止',
  escalated: '🚨 需人工介入',
  stopped: '⏹ 已停止',
  already_running: '▶ 已在运行',
};

const DeliveryPanel = ({ socket, sessionId }) => {
  const [collapsed, setCollapsed] = useState(true);
  const [requirement, setRequirement] = useState('');
  const [clarification, setClarification] = useState('');
  const [checking, setChecking] = useState(false);
  const [clarify, setClarify] = useState(null); // { sufficient, questions } | null
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState('idle');
  const [error, setError] = useState('');
  const [escalation, setEscalation] = useState(null); // { reason, analysis }
  const [tasks, setTasks] = useState([]); // WBS 任务 [{id, name, status}]
  const [mesoAttempt, setMesoAttempt] = useState(0);
  const [macroRetry, setMacroRetry] = useState(0);
  const [logs, setLogs] = useState([]);
  const logsRef = useRef(null);

  useEffect(() => {
    // 会话切换时重置本地状态并查询当前交付状态
    setCollapsed(true);
    setRequirement('');
    setClarification('');
    setChecking(false);
    setClarify(null);
    setRunning(false);
    setPhase('idle');
    setError('');
    setEscalation(null);
    setTasks([]);
    setMesoAttempt(0);
    setMacroRetry(0);
    setLogs([]);
    if (!socket || !sessionId) return;

    socket.emit('delivery:status', { sessionId });

    const forSession = (data, fn) => { if (data?.sessionId === sessionId) fn(data); };

    const onClarify = (d) => forSession(d, (data) => {
      setChecking(false);
      setClarify({ sufficient: !!data.sufficient, questions: data.questions || [] });
    });
    const onState = (d) => forSession(d, (data) => {
      if (typeof data.running === 'boolean') setRunning(data.running);
      if (data.phase) setPhase(data.phase);
      if (data.error) setError(data.error);
      if (data.phase === 'escalated') setEscalation({ reason: data.reason, analysis: data.analysis });
      // status 查询回包可能带已保存的 plan
      if (data.plan?.wbs?.tasks) {
        setTasks(data.plan.wbs.tasks.map(t => ({ id: t.id, name: t.name, status: 'pending' })));
      }
      if (data.running) setCollapsed(false);
    });
    const onError = (d) => forSession(d, (data) => {
      setError(data.error || '未知错误');
      setChecking(false);
    });
    const onWbs = (d) => forSession(d, (data) => {
      const list = (data.tasks || []).map(t => ({ id: t.id, name: t.name, status: 'pending' }));
      setTasks(list);
    });
    const onTaskStart = (d) => forSession(d, (data) => {
      setTasks(prev => prev.map(t => t.id === data.taskId ? { ...t, status: 'in_progress' } : t));
    });
    const onTaskDone = (d) => forSession(d, (data) => {
      setTasks(prev => prev.map(t => t.id === data.taskId
        ? { ...t, status: data.passed ? 'completed' : 'blocked' } : t));
    });
    const onMeso = (d) => forSession(d, (data) => setMesoAttempt(data.attempt || 0));
    const onMacroRepair = (d) => forSession(d, (data) => setMacroRetry(data.retry || 0));
    const onLog = (d) => forSession(d, (data) => {
      setLogs(prev => [...prev.slice(-99), data.line]);
    });
    const onPlan = (d) => forSession(d, (data) => {
      if (data.plan?.wbs?.tasks) {
        setTasks(data.plan.wbs.tasks.map(t => ({ id: t.id, name: t.name, status: 'pending' })));
      }
    });

    socket.on('delivery:clarify_result', onClarify);
    socket.on('delivery:state', onState);
    socket.on('delivery:error', onError);
    socket.on('delivery:wbs', onWbs);
    socket.on('delivery:task_start', onTaskStart);
    socket.on('delivery:task_done', onTaskDone);
    socket.on('delivery:meso', onMeso);
    socket.on('delivery:macro_repair', onMacroRepair);
    socket.on('delivery:log', onLog);
    socket.on('delivery:plan', onPlan);

    return () => {
      socket.off('delivery:clarify_result', onClarify);
      socket.off('delivery:state', onState);
      socket.off('delivery:error', onError);
      socket.off('delivery:wbs', onWbs);
      socket.off('delivery:task_start', onTaskStart);
      socket.off('delivery:task_done', onTaskDone);
      socket.off('delivery:meso', onMeso);
      socket.off('delivery:macro_repair', onMacroRepair);
      socket.off('delivery:log', onLog);
      socket.off('delivery:plan', onPlan);
    };
  }, [socket, sessionId]);

  // 日志自动滚到底
  useEffect(() => {
    if (logsRef.current) logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logs]);

  const checkClarify = () => {
    if (!requirement.trim() || checking || running) return;
    setError('');
    setChecking(true);
    setClarify(null);
    socket.emit('delivery:check_clarify', { sessionId, requirement: requirement.trim() });
  };

  const startDelivery = () => {
    if (!requirement.trim() || running) return;
    setError('');
    setEscalation(null);
    setTasks([]);
    setMesoAttempt(0);
    setMacroRetry(0);
    setLogs([]);
    setRunning(true);
    setPhase('starting');
    socket.emit('delivery:start', {
      sessionId,
      requirement: requirement.trim(),
      clarification: clarification.trim(),
    });
  };

  const stopDelivery = () => {
    socket.emit('delivery:stop', { sessionId });
  };

  const completed = tasks.filter(t => t.status === 'completed').length;
  const total = tasks.length;
  const percent = total ? Math.round(completed / total * 100) : 0;
  const isTerminal = ['done', 'error', 'escalated', 'stopped'].includes(phase);

  return (
    <div className="delivery-panel">
      <div className="delivery-header" onClick={() => setCollapsed(!collapsed)}>
        <div className="delivery-title">
          <span className="delivery-icon">🚚</span>
          <span>三层交付</span>
          <span className={`delivery-phase-badge phase-${phase}`}>{PHASE_LABEL[phase] || phase}</span>
        </div>
        {total > 0 && (
          <div className="delivery-bar-mini">
            <div className="delivery-bar-fill" style={{ width: `${percent}%` }} />
          </div>
        )}
        {total > 0 && <span className="delivery-count">{completed}/{total}</span>}
        <span className="delivery-toggle">{collapsed ? '▶' : '▼'}</span>
      </div>

      {!collapsed && (
        <div className="delivery-body">
          {/* 需求输入区（未运行时可编辑） */}
          {!running && (
            <div className="delivery-input-area">
              <textarea
                className="delivery-requirement"
                placeholder="描述要交付的需求，将自动拆解为 PRD → WBS → 子任务并逐层验证…"
                value={requirement}
                onChange={(e) => setRequirement(e.target.value)}
                rows={3}
              />
              <div className="delivery-actions">
                <button className="delivery-btn" onClick={checkClarify}
                  disabled={!requirement.trim() || checking}
                  title="先检查需求是否清晰，避免带着歧义启动">
                  {checking ? '⏳ 检查中' : '🔎 检查需求'}
                </button>
                <button className="delivery-btn primary" onClick={startDelivery}
                  disabled={!requirement.trim()}
                  title="启动完整三层交付（macro/meso/micro）">
                  🚀 开始交付
                </button>
              </div>
            </div>
          )}

          {/* 澄清结果 */}
          {clarify && !running && (
            clarify.sufficient ? (
              <div className="delivery-clarify sufficient">✓ 需求已足够清晰，可直接开始交付</div>
            ) : (
              <div className="delivery-clarify">
                <div className="delivery-clarify-title">🤔 建议补充以下信息后再启动：</div>
                <ul className="delivery-questions">
                  {clarify.questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
                <textarea
                  className="delivery-clarification"
                  placeholder="在此补充澄清说明（将随需求一起传给拆解器）…"
                  value={clarification}
                  onChange={(e) => setClarification(e.target.value)}
                  rows={2}
                />
              </div>
            )
          )}

          {/* 运行控制 */}
          {running && (
            <div className="delivery-run-bar">
              <span className={`delivery-run-phase phase-${phase}`}>{PHASE_LABEL[phase] || phase}</span>
              {macroRetry > 0 && <span className="delivery-retry" title="macro 回退次数">↻macro×{macroRetry}</span>}
              {phase === 'integrating' && mesoAttempt > 0 && (
                <span className="delivery-retry" title="集成验证轮次">集成 #{mesoAttempt}</span>
              )}
              <button className="delivery-btn stop" onClick={stopDelivery}>⏹ 停止</button>
            </div>
          )}

          {error && <div className="delivery-error">⚠️ {error}</div>}

          {escalation && (
            <div className="delivery-escalation">
              <div className="delivery-escalation-title">🚨 需要人工介入</div>
              {escalation.reason && <div className="delivery-escalation-reason">{escalation.reason}</div>}
              {escalation.analysis?.rootCause && (
                <div className="delivery-escalation-root">根因: {escalation.analysis.rootCause}</div>
              )}
            </div>
          )}

          {/* WBS 任务清单 */}
          {tasks.length > 0 && (
            <div className="delivery-tasks">
              {tasks.map(t => (
                <div key={t.id} className={`delivery-task ${t.status}`}>
                  <span className="delivery-task-icon">
                    {t.status === 'completed' ? '✅' :
                     t.status === 'blocked' ? '🚫' :
                     t.status === 'in_progress' ? '🔨' : '⬜'}
                  </span>
                  <span className="delivery-task-name">{t.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* 交付日志 */}
          {logs.length > 0 && (
            <div className="delivery-logs" ref={logsRef}>
              {logs.slice(-40).map((l, i) => (
                <div key={i} className="delivery-log-line">{l}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DeliveryPanel;
