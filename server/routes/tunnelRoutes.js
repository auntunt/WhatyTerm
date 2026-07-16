import { Router } from 'express';

/**
 * 创建隧道路由（Cloudflare + FRP tunnel URL 管理）
 * @param {{ frpTunnel: object, cloudflareTunnel: object, AI_SETTINGS_PATH: string, existsSync: function, readFileSync: function, writeFileSync: function }} deps
 * @returns {Router}
 */
export function createTunnelRouter({ frpTunnel, cloudflareTunnel, AI_SETTINGS_PATH, existsSync, readFileSync, writeFileSync }) {
  const router = Router();

  // GET /url → 原 GET /api/tunnel/url
  router.get('/url', (req, res) => {
    try {
      // 优先返回当前活动的隧道 URL
      const frpUrl = frpTunnel.getUrl ? frpTunnel.getUrl() : null;
      const cloudflareUrl = cloudflareTunnel.getUrl ? cloudflareTunnel.getUrl() : null;

      if (frpUrl) {
        return res.json({ tunnelUrl: frpUrl });
      }
      if (cloudflareUrl) {
        return res.json({ tunnelUrl: cloudflareUrl });
      }

      // 如果没有活动隧道，从文件读取保存的 URL
      if (existsSync(AI_SETTINGS_PATH)) {
        const settings = JSON.parse(readFileSync(AI_SETTINGS_PATH, 'utf-8'));
        res.json({ tunnelUrl: settings.tunnelUrl || '' });
      } else {
        res.json({ tunnelUrl: '' });
      }
    } catch (err) {
      res.json({ tunnelUrl: '' });
    }
  });

  // POST /url → 原 POST /api/tunnel/url
  router.post('/url', (req, res) => {
    const { tunnelUrl } = req.body;
    try {
      let settings = {};
      if (existsSync(AI_SETTINGS_PATH)) {
        settings = JSON.parse(readFileSync(AI_SETTINGS_PATH, 'utf-8'));
      }
      settings.tunnelUrl = tunnelUrl;
      writeFileSync(AI_SETTINGS_PATH, JSON.stringify(settings, null, 2));
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

/**
 * 创建 FRP 状态路由
 * @param {{ frpTunnel: object }} deps
 * @returns {Router}
 */
export function createFrpRouter({ frpTunnel }) {
  const router = Router();

  // GET /status → 原 GET /api/frp/status
  router.get('/status', async (req, res) => {
    try {
      const status = await frpTunnel.getStatus();
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
