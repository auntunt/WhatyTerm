import { Router } from 'express';

/**
 * createCliToolsRouter
 * @param {{ cliRegistry, cliLearner }} deps
 *   cliLearner 须同时承载原 processDetector 的能力（learn/unknown、learn/:processName），
 *   或由调用方将 processDetector 作为 cliLearner 的一部分传入。
 * @returns {Router}
 */
export function createCliToolsRouter({ cliRegistry, cliLearner }) {
  const router = Router();

  // GET /api/cli-tools  →  router.get('/')
  router.get('/', (req, res) => {
    try {
      const tools = cliRegistry.getAllTools();
      res.json({ success: true, tools });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cli-tools/learn/unknown  →  router.get('/learn/unknown')
  // ⚠️ 必须在 /:id 之前注册，否则 'unknown' 会被当成 id 参数
  router.get('/learn/unknown', (req, res) => {
    try {
      const unknownProcesses = cliLearner.getUnknownProcesses();
      res.json({ success: true, processes: unknownProcesses });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cli-tools/:id  →  router.get('/:id')
  router.get('/:id', (req, res) => {
    try {
      const tool = cliRegistry.getTool(req.params.id);
      if (!tool) {
        return res.status(404).json({ error: '工具不存在' });
      }
      res.json({ success: true, tool });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cli-tools  →  router.post('/')
  router.post('/', (req, res) => {
    try {
      const result = cliRegistry.registerTool(req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/cli-tools/:id  →  router.put('/:id')
  router.put('/:id', (req, res) => {
    try {
      const result = cliRegistry.updateTool(req.params.id, req.body);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/cli-tools/:id  →  router.delete('/:id')
  router.delete('/:id', (req, res) => {
    try {
      const result = cliRegistry.deleteTool(req.params.id);
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cli-tools/learn/:processName  →  router.post('/learn/:processName')
  router.post('/learn/:processName', (req, res) => {
    try {
      const result = cliLearner.learnFromUnknownProcess(
        req.params.processName,
        req.body
      );
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cli-tools/learn/url  →  router.post('/learn/url')
  router.post('/learn/url', async (req, res) => {
    try {
      const { url } = req.body;
      if (!url) {
        return res.status(400).json({ error: '缺少 URL 参数' });
      }
      const result = await cliLearner.learnAndRegister('url', { url });
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/cli-tools/learn/terminal  →  router.post('/learn/terminal')
  router.post('/learn/terminal', async (req, res) => {
    try {
      const { content, processName } = req.body;
      if (!content || !processName) {
        return res.status(400).json({ error: '缺少参数' });
      }
      const result = await cliLearner.learnAndRegister('terminal', { content, processName });
      if (!result.success) {
        return res.status(400).json({ error: result.error });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
