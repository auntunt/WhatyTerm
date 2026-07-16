/**
 * 轻量内置速率限制中间件（无外部依赖）
 *
 * 用法：
 *   import { createRateLimiter, apiLimiter, authLimiter } from './middleware/rateLimiter.js';
 *   app.use('/api/', apiLimiter);
 *   app.use('/api/auth/', authLimiter);
 */

/**
 * 创建一个基于 IP 的滑动窗口速率限制器
 * @param {object} options
 * @param {number} options.windowMs   - 时间窗口（毫秒），默认 60000（1分钟）
 * @param {number} options.max        - 窗口内最大请求数，默认 100
 * @param {string} options.message    - 触发限制时的提示信息
 * @param {boolean} options.skipLocal - 是否跳过本地请求（127.0.0.1 / ::1），默认 true
 */
export function createRateLimiter({
  windowMs = 60_000,
  max = 100,
  message = '请求过于频繁，请稍后再试',
  skipLocal = true,
} = {}) {
  // Map<ip, number[]>  每个 IP 的请求时间戳队列
  const store = new Map();

  // 定期清理过期条目，防止内存泄漏
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of store.entries()) {
      const fresh = timestamps.filter(t => now - t < windowMs);
      if (fresh.length === 0) {
        store.delete(ip);
      } else {
        store.set(ip, fresh);
      }
    }
  }, windowMs);
  // 不阻止进程退出
  if (cleanupInterval.unref) cleanupInterval.unref();

  return function rateLimiter(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    // 跳过本地回环地址
    if (skipLocal && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) {
      return next();
    }

    const now = Date.now();
    const timestamps = store.get(ip) || [];

    // 滑动窗口：只保留窗口内的时间戳
    const recent = timestamps.filter(t => now - t < windowMs);

    if (recent.length >= max) {
      const retryAfter = Math.ceil((recent[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: message, retryAfter });
    }

    recent.push(now);
    store.set(ip, recent);

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(max - recent.length));
    next();
  };
}

// ── 预设限制器 ────────────────────────────────────────────────────

/** 通用 API 限制：每分钟 120 次（约 2次/秒） */
export const apiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'API 请求过于频繁，请稍后再试',
});

/** 认证接口限制：每分钟 10 次，防止暴力破解 */
export const authLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 10,
  message: '登录尝试过于频繁，请 1 分钟后再试',
  skipLocal: false,  // 认证接口即使本地也限速
});

/** AI 分析接口限制：每分钟 30 次，防止恶意触发 LLM 调用 */
export const aiLimiter = createRateLimiter({
  windowMs: 60_000,
  max: 30,
  message: 'AI 分析请求过于频繁，请稍后再试',
});
