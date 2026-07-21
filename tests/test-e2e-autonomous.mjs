/**
 * 端到端集成回归：驱动真实 RalphEngine.start() 主循环跑通一个多任务项目。
 * 运行: node tests/test-e2e-autonomous.mjs
 *
 * 用「命令行番茄钟」类的迷你多任务清单，在真实临时 git 仓库上跑：
 *   - mock 一个 CLI（generateTextViaCLI）：Developer 真写文件、Validator 按文件内容真打分
 *   - 覆盖三条主链路：
 *       (A) 扇出任务：2 候选并行 → 高分者 merge 回 base → 任务完成
 *       (B) 普通任务：单候选 tmux 路径被绕过（提供 exec.cwd 时走 spawn），验证完成
 *       (C) blocked → 失败快照 → 人工介入(unblockAndRetry) → 重跑通过 的闭环
 *
 * 不连真实 LLM / 不起 tmux：Session.write 与 headless 用 mock，聚焦编排正确性。
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';

import RalphEngine from '../server/services/RalphEngine.js';
import progressManager from '../server/services/ProgressManager.js';

const results = { passed: 0, failed: 0, errors: [] };
function test(name, ok, detail) {
  if (ok) { console.log(`✅ ${name}`); results.passed++; }
  else { console.log(`❌ ${name}${detail ? ' — ' + detail : ''}`); results.failed++; results.errors.push({ name, detail }); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mkRepo() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'e2e-pomo-'));
  const git = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  git(['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(join(dir, 'README.md'), '# pomodoro cli\n');
  git(['add', '-A']); git(['commit', '-q', '-m', 'init']);
  return dir;
}

/**
 * mock CLI：根据 prompt 是 Developer 还是 Validator、以及任务 id，产生真实副作用与评分。
 * @param controls 每个任务的行为控制：{ [taskId]: { failUntilRetryCount } }
 */
function makeAiEngine(repoDir, controls, log) {
  // 跟踪每个任务被 Developer 处理的次数（用于模拟"前几次失败、介入后通过"）
  const devCounts = {};
  return {
    async generateTextViaCLI(prompt, opts) {
      const cwd = opts.cwd || repoDir;
      const isValidate = /专职 QA|唯一职责/.test(prompt);
      // 从 prompt 里抠出任务 id（_buildTaskContext 写了 "# 当前任务 [ID] 名称"）
      const m = prompt.match(/# 当前任务 \[([^\]]+)\]/);
      const taskId = m ? m[1] : 'unknown';
      const ctl = controls[taskId] || {};

      if (!isValidate) {
        devCounts[taskId] = (devCounts[taskId] || 0) + 1;
        // 写一个实现文件（真实副作用，供 Validator 检查 + 兜底 commit）
        const file = join(cwd, `${taskId}.txt`);
        const pass = !ctl.failUntilRetryCount || devCounts[taskId] > ctl.failUntilRetryCount;
        fs.writeFileSync(file, pass ? 'IMPLEMENTED OK\n' : 'TODO broken\n');
        return `已实现 ${taskId}`;
      }
      // Validator：读文件判定
      const file = join(cwd, `${taskId}.txt`);
      let ok = false;
      try { ok = fs.readFileSync(file, 'utf-8').includes('IMPLEMENTED OK'); } catch {}
      if (ok) {
        return `已核对。\n===VALIDATION===\n{"passed":true,"compiles":true,"tested":true,"criteria_met":true,"confidence":0.9,"notes":"${taskId} 通过"}\n===VALIDATION===`;
      }
      return `未通过。\n===VALIDATION===\n{"passed":false,"compiles":false,"tested":false,"criteria_met":false,"confidence":0.8,"notes":"${taskId} 实现不完整"}\n===VALIDATION===`;
    }
  };
}

// 用真实 tmux 会话不可行；提供一个把 headless 也导向 spawn 的假 session：
// 关键——RalphEngine 只有在 exec.cwd 存在时才走 _execSpawn。普通(非扇出)任务默认走 _execHeadless(tmux)。
// 为在无 tmux 环境测普通任务，这里把普通任务也强制带 cwd：直接让所有任务开扇出(count=1→不扇出)不行，
// 故本 e2e 对"普通任务"用 fanout=null 但 monkey-patch _runSingle 走 spawn。见下。

async function runScenario() {
  const repo = mkRepo();
  const sessionId = `e2e-${Date.now().toString(36)}`;

  // 任务清单（迷你番茄钟）：feat-001 扇出竞标；feat-002 依赖 001；feat-003 先 blocked 后介入通过
  const features = [
    { id: 'feat-001', name: '计时器核心', description: 'x', priority: 1, dependsOn: [], acceptanceCriteria: ['文件存在'] },
    { id: 'feat-002', name: 'start/pause 命令', description: 'x', priority: 2, dependsOn: ['feat-001'], acceptanceCriteria: ['文件存在'] },
    { id: 'feat-003', name: '状态持久化', description: 'x', priority: 3, dependsOn: ['feat-002'], acceptanceCriteria: ['文件存在'] },
  ];
  progressManager.createProgress(sessionId, '命令行番茄钟');
  progressManager.setFeatures(sessionId, features);

  // feat-003 前 5 次开发都失败（触发 MAX_RETRY=5 → blocked）；介入 unblock 后仍会重试，
  // 但介入的意义在于"清零 retry 让它再跑"，我们介入后放行让它通过。
  const controls = { 'feat-003': { failUntilRetryCount: 99 } }; // 一直失败 → 必然 blocked

  const events = [];
  const io = { emit: (ev, data) => events.push({ ev, ...data }) };

  const aiEngine = makeAiEngine(repo, controls, () => {});
  const sessionManager = { getSession: () => session, updateSession: () => {} };

  // 假 session：write 直接吞掉（无 tmux）。workingDir 指向真实 repo。
  const session = { id: sessionId, aiType: 'claude', workingDir: repo, tmuxSessionName: 'x', write() {} };
  sessionManager.getSession = () => session;

  const engine = new RalphEngine(sessionManager, io, aiEngine);
  // 无 relay 依赖
  engine.ensureProvider = async () => true;
  engine.resolveProviderEnv = () => ({});

  // 关键：普通(非扇出)任务默认走 _execHeadless(需真实 tmux)。测试环境无 tmux，
  // 故把 _runSingle 改为对每个任务临时开一个 worktree 走 spawn——等价于"扇出 1 候选"。
  // 这样普通链路也能在无 tmux 下端到端验证 Developer→Validator。
  const WorktreeManager = (await import('../server/services/WorktreeManager.js')).WorktreeManager;
  engine._runSingle = async function (sid, sess, state, task, i, maxIter) {
    const wtm = new WorktreeManager({ log: () => {} });
    const created = await wtm.createWorktrees(sess.workingDir, { count: 1, tag: `${task.id}-s` });
    if (!created.ok) return null;
    const wt = created.worktrees[0];
    const exec = { cwd: wt.dir, aiType: sess.aiType, providerEnv: {}, label: `单候选(${task.id})` };
    this._setPhase(sid, state, 'developing', task);
    const devOk = await this._runDeveloper(sid, sess, task, exec);
    if (!devOk) { await wtm.cleanup(sess.workingDir, created); return null; }
    await wtm.commitAll(wt.dir, `feat: ${task.id}`);
    this._setPhase(sid, state, 'validating', task);
    const verdict = await this._runValidator(sid, sess, task, exec, true);
    if (verdict.passed) await wtm.mergeWinner(sess.workingDir, wt.branch);
    await wtm.cleanup(sess.workingDir, created);
    return verdict;
  };

  // 启动：feat-001 扇出 2 候选，其余单候选。跑到没有可执行任务为止。
  await engine.start(sessionId, { maxIterations: 30, fanout: { count: 2, clis: [] } });

  // start() 是 async 且内部 loop 完整跑完才 resolve
  const prog1 = progressManager.loadProgress(sessionId);
  const byId = (id) => prog1.features.find(f => f.id === id);

  // 断言 A：feat-001 扇出完成，且 base 上出现其产物文件
  test('A1 feat-001 扇出后完成', byId('feat-001').status === 'completed', byId('feat-001').status);
  test('A2 feat-001 产物 merge 回 base', fs.existsSync(join(repo, 'feat-001.txt')));
  const fanoutDone = events.find(e => e.ev === 'ralph:fanout' && e.phase === 'done' && e.taskId === 'feat-001');
  test('A3 发出 ralph:fanout done 且有赢家', !!fanoutDone && !!fanoutDone.winner,
    fanoutDone ? JSON.stringify(fanoutDone.winner) : 'no event');

  // 断言 B：feat-002 依赖 001，单候选完成
  test('B1 feat-002 完成', byId('feat-002').status === 'completed', byId('feat-002').status);
  test('B2 feat-002 产物 merge 回 base', fs.existsSync(join(repo, 'feat-002.txt')));

  // 断言 C：feat-003 反复失败 → blocked + 失败快照 + ralph:blocked 事件
  test('C1 feat-003 被 blocked', byId('feat-003').blocked === true, `blocked=${byId('feat-003').blocked}`);
  const blockedEv = events.find(e => e.ev === 'ralph:blocked' && e.taskId === 'feat-003');
  test('C2 发出 ralph:blocked 事件', !!blockedEv);
  const snap = progressManager.getFailureSnapshot(sessionId, 'feat-003');
  test('C3 失败快照已保存（含 Validator 全文）', !!snap && /feat-003/.test(snap.validatorOutput || ''),
    snap ? 'saved' : 'missing');

  // 人工介入：修好该任务（放行）→ unblockAndRetry → 再跑一轮 → 通过
  controls['feat-003'] = { failUntilRetryCount: 0 }; // 之后开发即通过
  progressManager.unblockAndRetry(sessionId, 'feat-003');
  test('C4 介入后解除 blocked', byId2(sessionId, 'feat-003').blocked === false);

  await engine.start(sessionId, { maxIterations: 10, fanout: null });
  test('C5 介入并重跑后 feat-003 完成', byId2(sessionId, 'feat-003').status === 'completed',
    byId2(sessionId, 'feat-003').status);
  test('C6 feat-003 产物 merge 回 base', fs.existsSync(join(repo, 'feat-003.txt')));

  // 全部完成
  test('D 全部任务完成', progressManager.isAllCompleted(sessionId));

  // 清理
  progressManager.deleteProgress(sessionId);
  fs.rmSync(repo, { recursive: true, force: true });
}

function byId2(sid, id) {
  return progressManager.loadProgress(sid).features.find(f => f.id === id);
}

console.log('=== 端到端：命令行番茄钟 自主跑通 ===\n');
await runScenario();

console.log(`\n========== 结果: ${results.passed} 通过, ${results.failed} 失败 ==========`);
if (results.failed > 0) {
  for (const e of results.errors) console.log(`  ✗ ${e.name}${e.detail ? ': ' + e.detail : ''}`);
  process.exit(1);
}
