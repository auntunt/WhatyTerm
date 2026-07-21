import { Router } from 'express';

/**
 * 创建认证路由
 * @param {{ authService: object, isLocalRequest: function }} deps
 * @returns {Router}
 */
export function createAuthRouter({ authService, isLocalRequest }) {
  const router = Router();

  // GET /status → 原 GET /api/auth/status
  router.get('/status', (req, res) => {
    // 认证已禁用，始终返回已认证状态
    res.json({
      enabled: false,
      authenticated: true,
      isLocal: true,
      requirePasswordSetup: false,
    });
  });

  // POST /login → 原 POST /api/auth/login
  router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const result = authService.authenticate(username, password);

    if (result.success) {
      req.session.authenticated = true;
      req.session.username = username;
      res.json({ success: true });
    } else {
      res.status(401).json({ success: false, error: result.error });
    }
  });

  // POST /logout → 原 POST /api/auth/logout
  router.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
  });

  // POST /setup → 原 POST /api/auth/setup
  router.post('/setup', (req, res) => {
    // 设置密码（需要已登录或首次设置，本机访问自动放行）
    const isLocal = isLocalRequest(req);
    if (authService.isAuthRequired() && !isLocal && !req.session?.authenticated) {
      return res.status(401).json({ error: '需要登录' });
    }

    const { username, password, disable } = req.body;

    if (disable) {
      authService.disableAuth();
      req.session.authenticated = true;  // 禁用后自动登录
      return res.json({ success: true, message: '认证已禁用' });
    }

    if (!password || password.length < 4) {
      return res.status(400).json({ error: '密码至少 4 位' });
    }

    authService.setPassword(username, password);
    req.session.authenticated = true;
    res.json({ success: true, message: '密码已设置' });
  });

  return router;
}
