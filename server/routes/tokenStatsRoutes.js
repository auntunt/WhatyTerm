import { Router } from 'express';

export function createTokenStatsRouter(tokenStatsService) {
  const router = Router();

  // 获取全局 Token 统计摘要
  router.get('/summary', (req, res) => {
    try {
      const summary = tokenStatsService.getGlobalSummary();
      res.json({ success: true, data: summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取今日 Token 统计
  router.get('/today', (req, res) => {
    try {
      const stats = tokenStatsService.getTodayStats();
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取最近 N 天的每日统计
  router.get('/daily', (req, res) => {
    try {
      const days = parseInt(req.query.days) || 7;
      const stats = tokenStatsService.getRecentDailyStats(days);
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取所有供应商的 Token 统计
  router.get('/providers', (req, res) => {
    try {
      const stats = tokenStatsService.getProviderStats();
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取指定供应商的 Token 统计
  router.get('/providers/:name', (req, res) => {
    try {
      const stats = tokenStatsService.getProviderStats(req.params.name);
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取供应商按时间统计
  router.get('/providers/:name/timeline', (req, res) => {
    try {
      const { granularity = 'day', startTime, endTime } = req.query;
      const stats = tokenStatsService.getProviderStatsByTime(
        req.params.name,
        granularity,
        startTime ? parseInt(startTime) : null,
        endTime ? parseInt(endTime) : null
      );
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取会话的 Token 统计
  router.get('/sessions/:sessionId', (req, res) => {
    try {
      const summary = tokenStatsService.getSessionSummary(req.params.sessionId);
      const byProvider = tokenStatsService.getSessionStats(req.params.sessionId);
      res.json({ success: true, data: { summary, byProvider } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取会话按时间统计
  router.get('/sessions/:sessionId/timeline', (req, res) => {
    try {
      const { granularity = 'hour', startTime, endTime } = req.query;
      const stats = tokenStatsService.getSessionStatsByTime(
        req.params.sessionId,
        granularity,
        startTime ? parseInt(startTime) : null,
        endTime ? parseInt(endTime) : null
      );
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 获取模型统计
  router.get('/models', (req, res) => {
    try {
      const { provider } = req.query;
      const stats = tokenStatsService.getModelStats(provider || null);
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
