/**
 * 阶段 4「可观测与干预」单元测试
 * 运行: node tests/test-intervention.mjs
 *
 * 覆盖 ProgressManager 的人工介入 + 失败快照方法：
 *  - skipTask（skip 解锁下游 / exclude 排除）
 *  - unblockAndRetry
 *  - updateTaskRequirement
 *  - saveFailureSnapshot / getFailureSnapshot 往返
 *  - getNextTask 在介入后的行为（skip 解锁依赖、exclude 不解锁）
 */

import progressManager from '../server/services/ProgressManager.js';

const results = { passed: 0, failed: 0, errors: [] };
function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); results.passed++; }
  catch (err) { console.log(`❌ ${name}\n   错误: ${err.message}`); results.failed++; results.errors.push({ name, error: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}: 期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)}`); }

// 每个测试用独立 sessionId，结束清理
let seq = 0;
function freshSession(features) {
  const sid = `test-intervention-${Date.now().toString(36)}-${seq++}`;
  progressManager.createProgress(sid, 'test goal');
  progressManager.setFeatures(sid, features);
  return sid;
}
function cleanup(sid) { progressManager.deleteProgress(sid); }

// ── skipTask ────────────────────────────────────────────────────
console.log('\n=== skipTask ===');

test('skip：blocked 任务当完成跳过，解锁依赖它的下游', () => {
  const sid = freshSession([
    { id: 'T1', name: 'a', dependsOn: [] },
    { id: 'T2', name: 'b', dependsOn: ['T1'] },
  ]);
  // T1 被 blocked
  progressManager.updateFeatureStatus(sid, 'T1', { blocked: true, status: 'pending' });
  // 此时 T2 依赖 T1（未完成）→ 不可执行；T1 blocked → 不可执行 ⇒ 无可执行任务
  assert(progressManager.getNextTask(sid) === null, 'blocked 未解锁前无可执行任务');
  // skip T1 → 视为完成，解锁 T2
  progressManager.skipTask(sid, 'T1', 'skip');
  const next = progressManager.getNextTask(sid);
  eq(next?.id, 'T2', 'skip 后 T2 可执行');
  const t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  eq(t1.status, 'completed', 'T1 标记完成');
  assert(t1.skipped === true, 'T1 打 skipped 标记');
  cleanup(sid);
});

test('exclude：排除任务保持 blocked，不解锁下游', () => {
  const sid = freshSession([
    { id: 'T1', name: 'a', dependsOn: [] },
    { id: 'T2', name: 'b', dependsOn: ['T1'] },
  ]);
  progressManager.updateFeatureStatus(sid, 'T1', { blocked: true, status: 'pending' });
  progressManager.skipTask(sid, 'T1', 'exclude');
  const t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  assert(t1.blocked === true, 'exclude 保持 blocked');
  assert(t1.excluded === true, 'excluded 标记');
  // T2 依赖未完成的 T1 → 仍不可执行
  assert(progressManager.getNextTask(sid) === null, 'exclude 不解锁下游');
  cleanup(sid);
});

// ── unblockAndRetry ─────────────────────────────────────────────
console.log('\n=== unblockAndRetry ===');

test('解除阻塞并重试：清 blocked、retryCount 归零、status=pending', () => {
  const sid = freshSession([{ id: 'T1', name: 'a', dependsOn: [] }]);
  progressManager.recordValidationFailure(sid, 'T1', '失败原因', 1); // maxRetry=1 → 立即 blocked
  let t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  assert(t1.blocked === true, '先 blocked');
  progressManager.unblockAndRetry(sid, 'T1');
  t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  eq(t1.blocked, false, '解除 blocked');
  eq(t1.retryCount, 0, 'retryCount 归零');
  eq(t1.status, 'pending', 'status=pending');
  eq(progressManager.getNextTask(sid)?.id, 'T1', '重新可执行');
  cleanup(sid);
});

// ── updateTaskRequirement ───────────────────────────────────────
console.log('\n=== updateTaskRequirement ===');

test('修改需求：更新 name/description/acceptanceCriteria', () => {
  const sid = freshSession([{ id: 'T1', name: '旧标题', description: '旧描述', acceptanceCriteria: ['旧'] }]);
  progressManager.updateTaskRequirement(sid, 'T1', {
    name: '新标题', description: '新描述', acceptanceCriteria: ['新1', '新2'],
  });
  const t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  eq(t1.name, '新标题', 'name');
  eq(t1.description, '新描述', 'description');
  eq(t1.acceptanceCriteria.join(','), '新1,新2', 'acceptanceCriteria');
  cleanup(sid);
});

test('修改需求：未传字段保持不变', () => {
  const sid = freshSession([{ id: 'T1', name: '标题', description: '描述' }]);
  progressManager.updateTaskRequirement(sid, 'T1', { description: '只改描述' });
  const t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  eq(t1.name, '标题', 'name 不变');
  eq(t1.description, '只改描述', 'description 改了');
  cleanup(sid);
});

// ── 失败快照 ─────────────────────────────────────────────────────
console.log('\n=== 失败快照 ===');

test('saveFailureSnapshot / getFailureSnapshot 往返', () => {
  const sid = freshSession([{ id: 'T1', name: 'a' }]);
  progressManager.saveFailureSnapshot(sid, 'T1', {
    diff: 'diff --git a/x b/x\n+new line',
    validatorOutput: 'VALIDATION FAIL 详细输出',
    reason: '测试未通过',
  });
  const snap = progressManager.getFailureSnapshot(sid, 'T1');
  assert(snap, '应能读回快照');
  eq(snap.featureId, 'T1', 'featureId');
  assert(snap.diff.includes('new line'), 'diff 内容');
  assert(snap.validatorOutput.includes('VALIDATION FAIL'), 'validator 全文');
  eq(snap.reason, '测试未通过', 'reason');
  // feature 应打 hasSnapshot 标记
  const t1 = progressManager.loadProgress(sid).features.find(f => f.id === 'T1');
  assert(t1.hasSnapshot === true, 'hasSnapshot 标记');
  cleanup(sid);
});

test('getFailureSnapshot 不存在 → null', () => {
  const sid = freshSession([{ id: 'T1', name: 'a' }]);
  eq(progressManager.getFailureSnapshot(sid, 'T1'), null, '无快照返回 null');
  cleanup(sid);
});

test('快照大字段截断（不超过 ~200KB）', () => {
  const sid = freshSession([{ id: 'T1', name: 'a' }]);
  const huge = 'x'.repeat(300000);
  progressManager.saveFailureSnapshot(sid, 'T1', { diff: huge, validatorOutput: huge });
  const snap = progressManager.getFailureSnapshot(sid, 'T1');
  assert(snap.diff.length <= 200000, `diff 截断, 实际 ${snap.diff.length}`);
  assert(snap.validatorOutput.length <= 200000, 'validator 截断');
  cleanup(sid);
});

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n========== 结果: ${results.passed} 通过, ${results.failed} 失败 ==========`);
if (results.failed > 0) {
  for (const e of results.errors) console.log(`  ✗ ${e.name}: ${e.error}`);
  process.exit(1);
}
