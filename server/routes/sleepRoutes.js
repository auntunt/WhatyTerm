import { Router } from 'express';

/**
 * 创建睡眠防止路由
 * @param {{ sleepPrevention: object }} deps
 * @returns {Router}
 */
export function createSleepRouter({ sleepPrevention }) {
  const router = Router();

  // GET / → 原 GET /api/sleep-prevention
  router.get('/', (req, res) => {
    res.json(sleepPrevention.status);
  });

  // POST /toggle → 原 POST /api/sleep-prevention/toggle
  router.post('/toggle', (req, res) => {
    if (sleepPrevention.isActive) {
      sleepPrevention.release();
    } else {
      sleepPrevention.prevent('手动开启');
    }
    res.json(sleepPrevention.status);
  });

  return router;
}
