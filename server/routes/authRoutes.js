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
    const status = authService.getStatus();
    const isLocal = isLocalRequest(req);
    const passwordNotSet = !authService.isAuthRequired();

    // 远程访问 + 未设置密码 = 需要先在本机设置密码
    const requirePasswordSetup = !isLocal && passwordNotSet;

    res.json({
      ...status,
      isLocal,
      requirePasswordSetup,
      // 本机访问视为已认证；远程访问且未设置密码则未认证
      authenticated: isLocal || (!requirePasswordSetup && req.session?.authenticated) || false
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

  // POST /online-login → 原 POST /api/auth/online-login（在线订阅账户登录）
  router.post('/online-login', async (req, res) => {
    const { email, password } = req.body;
    const ip = req.ip || req.connection.remoteAddress;

    if (authService.isLocked(ip)) {
      return res.status(429).json({ success: false, error: '登录尝试次数过多，请 15 分钟后再试' });
    }

    if (!email || !password) {
      return res.status(400).json({ success: false, error: '邮箱和密码必填' });
    }

    try {
      const result = await authService.verifyOnlineCredentials(email, password);

      if (result.valid) {
        authService.clearAttempts(ip);
        req.session.authenticated = true;
        req.session.username = email;
        req.session.userId = result.userId;
        req.session.onlineAuth = true;
        req.session.hasValidLicense = result.hasValidLicense;
        res.json({ success: true, user: { email: result.email, name: result.name, hasValidLicense: result.hasValidLicense } });
      } else {
        const remaining = authService.recordFailedAttempt(ip);
        res.status(401).json({ success: false, error: result.error || '邮箱或密码错误', remainingAttempts: remaining });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: '登录服务暂时不可用' });
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
