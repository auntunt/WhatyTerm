/**
 * verdictScore.js
 * 把 Validator 的多维结论（passed/compiles/tested/criteriaMet/confidence）折算成一个可比较的分数，
 * 供「自主版 Orca」扇出挑赢家用——「挑赢家」本质就是「比较各候选的验收评分」。
 *
 * 设计目标：让"真正通过且置信度高、构建测试都过"的候选稳定胜出，
 * 让"没通过 / 置信度低 / 没跑测试" 的候选落后。分数范围约 [0, 100]。
 */

/**
 * @param {object} v verdict：{ passed, confidence, compiles, tested, criteriaMet }
 *   compiles/tested/criteriaMet 可为 true|false|null(不适用/未知)
 * @returns {number} 0~100 的分数，越高越好
 */
export function scoreVerdict(v = {}) {
  if (!v || typeof v !== 'object') return 0;

  const confidence = clamp01(typeof v.confidence === 'number' ? v.confidence : 0);
  let score = 0;

  // 1) 是否整体通过：主导项（0 或 50）
  //    未通过的候选无论其它维度多好，都应显著低于任一通过的候选。
  if (v.passed) score += 50;

  // 2) 置信度：0~25 分（置信度是验收可信度的核心，权重高）
  score += confidence * 25;

  // 3) 构建/测试/逐条标准：各 true 加分、false 扣分、null 不计（不适用不惩罚）
  score += triState(v.compiles, 8, -12);   // 编不过是硬伤，扣得重
  score += triState(v.tested, 10, -12);    // 测试失败是硬伤
  score += triState(v.criteriaMet, 7, -8);

  return clamp(score, 0, 100);
}

/** 在多个候选结论里挑最高分；并列时取 index 最小（稳定、可复现） */
export function pickWinner(candidates = []) {
  let best = null;
  for (const c of candidates) {
    if (!c || c.score == null) continue;
    if (!best || c.score > best.score) best = c;
  }
  return best;
}

function triState(val, plus, minus) {
  if (val === true) return plus;
  if (val === false) return minus;
  return 0; // null / undefined：不适用，不加不减
}

function clamp01(n) { return clamp(n, 0, 1); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
