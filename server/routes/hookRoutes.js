import { Router } from 'express';

/**
 * createHookRouter
 * @param {{ hookServer, sessionManager, isLocalRequest }} deps
 * @returns {Router}
 */
export function createHookRouter({ hookServer, sessionManager, isLocalRequest }) {
  const router = Router();

  // POST /hooks  →  router.post('/')
  router.post('/', (req, res) => {
    if (!hookServer?.validateToken(req.headers['x-webtmuxtoken'])) {
      return res.status(403).end();
    }
    try {
      const event = req.body || {};
      const envHeader = req.headers['x-webtmux-effective-env'];
      if (typeof envHeader === 'string') {
        const kv = {};
        for (const part of envHeader.split(';')) {
          const eq = part.indexOf('=');
          if (eq > 0) kv[part.slice(0, eq)] = part.slice(eq + 1).trim();
        }
        event._effectiveEnv = {
          baseUrl: (kv.url || '').replace(/\/+$/, ''),
          model: kv.model || '',
          tokenPrefix: kv.tok || '',
          keyPrefix: kv.key || '',
        };
      }
      const paneHeader = req.headers['x-webtmux-tmux-pane'];
      if (typeof paneHeader === 'string' && /^%\d+$/.test(paneHeader.trim())) {
        event._tmuxPane = paneHeader.trim();
      }
      hookServer.dispatch(event);
    } catch {}
    res.status(200).end();
  });

  // GET /hooks/status  →  router.get('/status')
  router.get('/status', (req, res) => {
    if (!hookServer) return res.json({ status: 'not_initialized' });
    const logs = hookServer.recentLogs(50);
    const scriptPath = `${process.env.HOME}/.webtmux/hooks/pre-tool.sh`;
    res.json({
      status: 'ok',
      port: hookServer.serverPort,
      logFile: hookServer.logPath,
      recentEvents: logs,
      tip: `也可以运行: tail -f ${hookServer.logPath}`,
    });
  });

  return router;
}
