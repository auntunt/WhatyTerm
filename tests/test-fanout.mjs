/**
 * 阶段 2「扇出 + 自动挑赢家」单元测试
 * 运行: node tests/test-fanout.mjs
 *
 * 覆盖：
 *  1. verdictScore：多维结论折算分数 + pickWinner 排序（含并列取最小 index）
 *  2. WorktreeManager：真实临时 git 仓库上 create → commit → merge winner → cleanup
 *  3. RalphEngine._runDeveloperFanout：mock aiEngine，验证赢家选择 + merge 落地
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import { scoreVerdict, pickWinner } from '../server/services/util/verdictScore.js';
import { WorktreeManager } from '../server/services/WorktreeManager.js';
import RalphEngine from '../server/services/RalphEngine.js';

const results = { passed: 0, failed: 0, errors: [] };
function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); results.passed++; }
  catch (err) { console.log(`❌ ${name}\n   错误: ${err.message}`); results.failed++; results.errors.push({ name, error: err.message }); }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); results.passed++; }
  catch (err) { console.log(`❌ ${name}\n   错误: ${err.message}`); results.failed++; results.errors.push({ name, error: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}: 期望 ${b}, 实际 ${a}`); }

// ── 1. verdictScore ────────────────────────────────────────────
console.log('\n=== verdictScore ===');

test('通过 + 高置信 + 构建测试都过 → 高分(>85)', () => {
  const s = scoreVerdict({ passed: true, confidence: 0.95, compiles: true, tested: true, criteriaMet: true });
  assert(s > 85, `实际 ${s}`);
});

test('未通过的候选分数 < 任一通过候选', () => {
  const pass = scoreVerdict({ passed: true, confidence: 0.5, compiles: null, tested: null, criteriaMet: null });
  const fail = scoreVerdict({ passed: false, confidence: 1.0, compiles: true, tested: true, criteriaMet: true });
  assert(pass > fail, `通过(${pass}) 应 > 未通过(${fail})`);
});

test('测试失败(tested=false)显著扣分', () => {
  const good = scoreVerdict({ passed: true, confidence: 0.9, tested: true });
  const bad = scoreVerdict({ passed: true, confidence: 0.9, tested: false });
  assert(good - bad >= 20, `差值 ${good - bad}`);
});

test('null 维度不惩罚（不适用）', () => {
  const withNull = scoreVerdict({ passed: true, confidence: 0.8, compiles: null, tested: null, criteriaMet: null });
  const withTrue = scoreVerdict({ passed: true, confidence: 0.8, compiles: true, tested: true, criteriaMet: true });
  assert(withTrue > withNull, '全 true 应高于全 null');
  assert(withNull >= 50, `通过项至少含 50 主导分, 实际 ${withNull}`);
});

test('pickWinner 取最高分', () => {
  const w = pickWinner([{ idx: 0, score: 30 }, { idx: 1, score: 90 }, { idx: 2, score: 60 }]);
  eq(w.idx, 1, '赢家 index');
});

test('pickWinner 并列取最小 index（稳定）', () => {
  const w = pickWinner([{ idx: 0, score: 80 }, { idx: 1, score: 80 }]);
  eq(w.idx, 0, '并列取最小 index');
});

test('空/非法 verdict → 0 分', () => {
  eq(scoreVerdict(null), 0, 'null');
  eq(scoreVerdict(undefined), 0, 'undefined');
  eq(scoreVerdict({}), 0, '空对象未通过');
});

// ── 2. WorktreeManager（真实临时 git 仓库）───────────────────────
console.log('\n=== WorktreeManager ===');

function mkTempRepo() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'wt-test-'));
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@test.local']);
  git(['config', 'user.name', 'test']);
  git(['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(join(dir, 'README.md'), '# base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

await testAsync('createWorktrees 建出 N 个独立目录+分支', async () => {
  const repo = mkTempRepo();
  const wtm = new WorktreeManager();
  const r = await wtm.createWorktrees(repo, { count: 3, tag: 'a' });
  try {
    assert(r.ok, `建 worktree 失败: ${r.error}`);
    eq(r.worktrees.length, 3, '候选数');
    for (const wt of r.worktrees) assert(fs.existsSync(wt.dir), `目录存在 ${wt.dir}`);
    eq(r.baseBranch, 'main', 'base 分支');
  } finally {
    await wtm.cleanup(repo, r);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

await testAsync('候选改动 commit → merge winner 落到 base', async () => {
  const repo = mkTempRepo();
  const wtm = new WorktreeManager();
  const r = await wtm.createWorktrees(repo, { count: 2, tag: 'b' });
  try {
    // 候选 c1 写文件并提交
    const c1 = r.worktrees[1];
    fs.writeFileSync(join(c1.dir, 'feature.txt'), 'winner work\n');
    const committed = await wtm.commitAll(c1.dir, 'feat: winner');
    assert(committed, '应有新提交');
    assert(await wtm.hasCommitsAhead(c1.dir, r.baseRef), 'c1 应领先 base');

    // merge 回 base
    const m = await wtm.mergeWinner(repo, c1.branch);
    assert(m.ok, `merge 失败: ${m.error}`);
    assert(fs.existsSync(join(repo, 'feature.txt')), 'base 应出现赢家文件');
  } finally {
    await wtm.cleanup(repo, r);
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

await testAsync('cleanup 移除 worktree 且删除败者分支', async () => {
  const repo = mkTempRepo();
  const wtm = new WorktreeManager();
  const r = await wtm.createWorktrees(repo, { count: 2, tag: 'c' });
  const branches0 = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf-8' });
  assert(branches0.includes('fanout/c/c0'), '建后应有候选分支');
  await wtm.cleanup(repo, r);
  const branches1 = execFileSync('git', ['branch', '--list'], { cwd: repo, encoding: 'utf-8' });
  assert(!branches1.includes('fanout/c/c0'), '清理后候选分支应删除');
  for (const wt of r.worktrees) assert(!fs.existsSync(wt.dir), '目录应删除');
  fs.rmSync(repo, { recursive: true, force: true });
});

await testAsync('非 git 目录 → createWorktrees 报错', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'notgit-'));
  const wtm = new WorktreeManager();
  const r = await wtm.createWorktrees(dir, { count: 2, tag: 'd' });
  assert(!r.ok, '非 git 仓库应失败');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 3. _runDeveloperFanout 赢家选择（mock aiEngine）───────────────
console.log('\n=== _runDeveloperFanout ===');

await testAsync('两候选竞标：高分者胜出并 merge', async () => {
  const repo = mkTempRepo();

  // mock aiEngine：Developer 阶段按 cwd 写不同内容；Validator 阶段按 cwd 返回不同评分
  // 约定：候选 c0 目录名以 c0 结尾 → 低分；c1 → 高分（passed + 高置信 + 测试过）
  const aiEngine = {
    async generateTextViaCLI(prompt, opts) {
      const isValidate = /专职 QA|唯一职责/.test(prompt);
      const isC1 = /c1$/.test(opts.cwd || '');
      if (!isValidate) {
        // Developer：写一个文件（制造改动，供兜底 commit）
        fs.writeFileSync(join(opts.cwd, `impl-${isC1 ? 'c1' : 'c0'}.txt`), 'work\n');
        return 'done';
      }
      // Validator：返回结构化评分
      if (isC1) {
        return '构建通过、测试全过。\n===VALIDATION===\n{"passed":true,"compiles":true,"tested":true,"criteria_met":true,"confidence":0.95,"notes":"ok"}\n===VALIDATION===';
      }
      return '实现不完整。\n===VALIDATION===\n{"passed":false,"compiles":true,"tested":false,"criteria_met":false,"confidence":0.5,"notes":"缺测试"}\n===VALIDATION===';
    }
  };

  const io = { emit() {} };
  const sessionManager = { getSession: () => null };
  const engine = new RalphEngine(sessionManager, io, aiEngine);

  const session = { id: 's1', aiType: 'claude', workingDir: repo };
  const task = { id: 'T1', name: '示例任务', description: 'x', priority: 'high', acceptanceCriteria: ['能跑'] };
  const state = { stop: false, iteration: 1, phase: 'idle', fanout: null };
  engine.running.set('s1', state);

  const fanout = { candidates: ['claude', 'claude'] };
  const verdict = await engine._runDeveloperFanout('s1', session, state, task, fanout);

  assert(verdict, '应返回赢家 verdict');
  eq(verdict.passed, true, '赢家应通过');
  // 赢家(c1)的改动应 merge 回 base
  assert(fs.existsSync(join(repo, 'impl-c1.txt')), 'base 应含赢家 c1 的改动');
  assert(!fs.existsSync(join(repo, 'impl-c0.txt')), 'base 不应含败者 c0 的改动');

  engine.running.delete('s1');
  fs.rmSync(repo, { recursive: true, force: true });
});

await testAsync('全部候选未通过：不 merge，返回失败 verdict 触发重试', async () => {
  const repo = mkTempRepo();
  const aiEngine = {
    async generateTextViaCLI(prompt, opts) {
      const isValidate = /专职 QA|唯一职责/.test(prompt);
      if (!isValidate) { fs.writeFileSync(join(opts.cwd, 'x.txt'), 'w\n'); return 'done'; }
      return '===VALIDATION===\n{"passed":false,"compiles":false,"tested":false,"criteria_met":false,"confidence":0.3,"notes":"编译失败"}\n===VALIDATION===';
    }
  };
  const engine = new RalphEngine({ getSession: () => null }, { emit() {} }, aiEngine);
  const session = { id: 's2', aiType: 'claude', workingDir: repo };
  const task = { id: 'T2', name: 't', description: 'x', priority: 'high', acceptanceCriteria: [] };
  const state = { stop: false, iteration: 1, phase: 'idle', fanout: null };
  engine.running.set('s2', state);

  const verdict = await engine._runDeveloperFanout('s2', session, state, task, { candidates: ['claude', 'claude'] });
  assert(verdict && verdict.passed === false, '应返回未通过 verdict');
  // base 上不应引入任何候选文件（未 merge）
  eq(fs.existsSync(join(repo, 'x.txt')), false, 'base 不应被污染');

  engine.running.delete('s2');
  fs.rmSync(repo, { recursive: true, force: true });
});

await testAsync('非 git 工作目录 → 扇出返回 null（上层回退单候选）', async () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'nofan-'));
  const engine = new RalphEngine({ getSession: () => null }, { emit() {} }, { generateTextViaCLI: async () => 'x' });
  const state = { stop: false, iteration: 1, phase: 'idle', fanout: null };
  engine.running.set('s3', state);
  const verdict = await engine._runDeveloperFanout('s3', { id: 's3', aiType: 'claude', workingDir: dir },
    state, { id: 'T3', name: 't', description: 'x', priority: 'high' }, { candidates: ['claude', 'claude'] });
  eq(verdict, null, '非 git 应返回 null');
  engine.running.delete('s3');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── _normalizeFanout ─────────────────────────────────────────
console.log('\n=== _normalizeFanout ===');
const eng = new RalphEngine({ getSession: () => null }, { emit() {} }, {});

test('count<2 且无 clis → null（不扇出）', () => {
  eq(eng._normalizeFanout({ count: 1 }), null, 'count=1');
  eq(eng._normalizeFanout(null), null, 'null');
  eq(eng._normalizeFanout({ clis: ['claude'] }), null, '单 CLI');
});

test('count=3 无 clis → 3 个 null 占位候选', () => {
  const f = eng._normalizeFanout({ count: 3 });
  eq(f.candidates.length, 3, '候选数');
  assert(f.candidates.every(c => c === null), '占位为 null（后续填会话默认 CLI）');
});

test('多 CLI + count 补足：循环填充', () => {
  const f = eng._normalizeFanout({ count: 4, clis: ['claude', 'codex'] });
  eq(f.candidates.length, 4, '补足到 count');
  eq(f.candidates[2], 'claude', '循环填充');
  eq(f.candidates[3], 'codex', '循环填充');
});

test('候选上限 8', () => {
  const f = eng._normalizeFanout({ count: 99 });
  eq(f.candidates.length, 8, '封顶 8');
});

// ── 汇总 ─────────────────────────────────────────────────────
console.log(`\n========== 结果: ${results.passed} 通过, ${results.failed} 失败 ==========`);
if (results.failed > 0) {
  for (const e of results.errors) console.log(`  ✗ ${e.name}: ${e.error}`);
  process.exit(1);
}
