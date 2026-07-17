import { Router } from 'express';

/**
 * createSessionAnalyzeRouter
 * @param {{ sessionManager, aiEngine, getHookServer, progressManager }} deps
 *   getHookServer: 惰性获取 hookServer 实例（构造时 hookServer 尚未初始化，避免 TDZ）
 * @returns {Router}
 */
export function createSessionAnalyzeRouter({ getSessionManager, getAiEngine, getHookServer, progressManager }) {
  const router = Router();

  // GET /api/sessions/:sessionId/hook-activity  →  router.get('/:sessionId/hook-activity')
  router.get('/:sessionId/hook-activity', (req, res) => {
    const sessionManager = getSessionManager();
    const session = sessionManager.getSession(req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'session not found' });

    const workingDir = session.workingDir || '';
    const hookServer = getHookServer();
    const rawLog = hookServer ? hookServer.recentLogs(100) : '';
    const lines = rawLog.split('\n').filter(Boolean);

    // 解析日志行：`ISO_TS [EVENT] tool=X file=Y cwd=Z`
    const events = lines.map(line => {
      const m = line.match(/^(\S+) \[(\w+)\](?: tool=(\S+))?(?: file=(\S+))?(?: cwd=(.+))?$/);
      if (!m) return null;
      return { ts: m[1], event: m[2], tool: m[3], file: m[4], cwd: m[5] };
    }).filter(Boolean);

    // 过滤属于当前 session 的事件（cwd 前缀匹配）
    const sessionEvents = workingDir
      ? events.filter(e => e.cwd && e.cwd.startsWith(workingDir))
      : events;

    const last = sessionEvents[sessionEvents.length - 1];
    const lastStop = [...sessionEvents].reverse().find(e => e.event === 'Stop');
    const lastTool = [...sessionEvents].reverse().find(e => e.event === 'PostToolUse' && e.tool);

    // 映射成面板字段
    const toolLabel = {
      Edit: '编辑文件', Write: '写入文件', Bash: '执行命令',
      Read: '读取文件', WebFetch: '网络请求', WebSearch: '网络搜索',
    };

    let currentState = '无近期活动';
    let recentAction = '无';
    let needsAction = false;

    if (!last) {
      currentState = '尚未收到 Hook 事件';
    } else if (last.event === 'Stop') {
      currentState = 'Claude Code 已停止，等待指令';
      needsAction = true;
      recentAction = lastTool
        ? `${toolLabel[lastTool.tool] || lastTool.tool}${lastTool.file ? ': ' + lastTool.file.split('/').pop() : ''}`
        : '无';
    } else if (last.event === 'PreToolUse') {
      const tl = toolLabel[last.tool] || last.tool || '工具';
      currentState = `正在${tl}${last.file ? '：' + last.file.split('/').pop() : ''}`;
      recentAction = last.tool || '未知工具';
    } else if (last.event === 'PostToolUse') {
      const tl = toolLabel[last.tool] || last.tool || '工具';
      currentState = `${tl}完成，继续处理中`;
      recentAction = `${tl}${last.file ? '：' + last.file.split('/').pop() : ''}`;
    }

    // 最近 10 条工具调用（用于面板展示）
    const recentTools = sessionEvents
      .filter(e => e.event === 'PostToolUse' && e.tool)
      .slice(-10)
      .map(e => ({ tool: e.tool, file: e.file, ts: e.ts }));

    res.json({
      sessionId: req.params.sessionId,
      currentState,
      recentAction,
      needsAction,
      actionType: needsAction ? 'wait' : null,
      suggestedAction: null,
      workingDir,
      recentTools,
      hookEventCount: sessionEvents.length,
      lastEventTime: last?.ts || null,
      updatedAt: Date.now(),
      _source: 'hooks',
    });
  });

  // POST /api/sessions/:sessionId/analyze-now  →  router.post('/:sessionId/analyze-now')
  router.post('/:sessionId/analyze-now', async (req, res) => {
    try {
      const sessionManager = getSessionManager();
      const aiEngine = getAiEngine();
      const session = sessionManager?.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      const terminalContent = session.getScreenContent?.() || '';
      if (!terminalContent || terminalContent.length < 10) {
        return res.json({
          currentState: '终端无内容',
          needsAction: false,
          updatedAt: Date.now(),
          _source: 'analyze-now',
        });
      }

      const sessionData = session.toJSON?.() || {};
      const projectContext = {
        projectPath: session.workingDir || sessionData.workingDir,
        projectDesc: session.projectDesc || sessionData.projectDesc,
        workingDir: session.workingDir || sessionData.workingDir,
        goal: session.goal || sessionData.goal,
        progress: progressManager.loadProgress(session.id),
      };

      // 先尝试规则判断，规则无法判断时调用 AI 分析
      const result = await aiEngine.analyzeStatus(
        terminalContent,
        sessionData.aiType || 'claude',
        session.id,
        session.tmuxSessionName,
        projectContext,
        sessionData.monitorPluginId
      );

      if (!result) {
        return res.json({
          currentState: '无法分析（终端状态不明确）',
          needsAction: false,
          updatedAt: Date.now(),
          _source: 'analyze-now',
        });
      }

      res.json({ ...result, updatedAt: Date.now(), _source: 'analyze-now' });
    } catch (err) {
      console.error('[analyze-now] 失败:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
