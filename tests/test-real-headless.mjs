/**
 * 真实端到端：用真实 AIEngine + 真实 claude CLI，在临时 git 仓库跑一轮
 * RalphEngine Developer→Validator，验证修复后 headless 执行不再空转/Execution error。
 * 运行: node tests/test-real-headless.mjs
 * 需要：本机已装 claude CLI，且下方 provider 可用。
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';

import RalphEngine from '../server/services/RalphEngine.js';
import { AIEngine } from '../server/services/AIEngine.js';
import progressManager from '../server/services/ProgressManager.js';
import { WorktreeManager } from '../server/services/WorktreeManager.js';

// 取一个可用 provider 的真实 env（直连，不经 relay）
function realProviderEnv() {
  const db = new Database(join(os.homedir(), '.cc-switch/cc-switch.db'), { readonly: true });
  const row = db.prepare("SELECT settings_config FROM providers WHERE name='公司提供api' AND app_type='claude' LIMIT 1").get();
  db.close();
  const cfg = JSON.parse(row.settings_config);
  const e = cfg.env || {};
  return {
    ANTHROPIC_BASE_URL: e.ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: e.ANTHROPIC_AUTH_TOKEN || null,
    ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY || null,
  };
}

function mkRepo() {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'real-hl-'));
  const git = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });
  git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
  git(['checkout', '-q', '-b', 'main']);
  fs.writeFileSync(join(dir, 'README.md'), '# hello project\n');
  git(['add', '-A']); git(['commit', '-q', '-m', 'init']);
  return dir;
}

async function main() {
  const providerEnv = realProviderEnv();
  console.log('[test] provider:', providerEnv.ANTHROPIC_BASE_URL, '| key:', !!(providerEnv.ANTHROPIC_AUTH_TOKEN || providerEnv.ANTHROPIC_API_KEY));

  const repo = mkRepo();
  const sessionId = `real-${Date.now().toString(36)}`;
  console.log('[test] repo:', repo);

  const features = [
    { id: 'feat-001', name: '创建 hello.txt', description: '在项目根目录创建一个文件 hello.txt，内容为一行文字：hello from ralph。不要做其它任何事。', priority: 1, dependsOn: [], acceptanceCriteria: ['hello.txt 文件存在且包含 hello'] },
  ];
  progressManager.createProgress(sessionId, '真实 headless 冒烟');
  progressManager.setFeatures(sessionId, features);

  const events = [];
  const io = { emit: (ev, data) => { events.push({ ev, ...data }); } };
  const aiEngine = new AIEngine();
  const session = { id: sessionId, aiType: 'claude', workingDir: repo, tmuxSessionName: 'x', write() {} };
  const sessionManager = { getSession: () => session, updateSession: () => {} };

  const engine = new RalphEngine(sessionManager, io, aiEngine);
  engine.ensureProvider = async () => true;            // 直连模式，无需 relay
  engine.resolveProviderEnv = () => providerEnv;       // 真实供应商 env 注入 spawn

  // 把普通任务导向 spawn（无 tmux 环境），走真实 claude
  const wtm = new WorktreeManager({ log: () => {} });
  engine._runSingle = async function (sid, sess, state, task, i, maxIter) {
    const created = await wtm.createWorktrees(sess.workingDir, { count: 1, tag: `${task.id}-s` });
    if (!created.ok) { console.log('[test] worktree 创建失败:', created.error); return null; }
    const wt = created.worktrees[0];              // { index, dir, branch }
    const exec = { cwd: wt.dir, aiType: 'claude', providerEnv, label: '单候选' };
    const devOk = await this._runDeveloper(sid, sess, task, exec);
    if (!devOk) { await wtm.cleanup(sess.workingDir, created).catch(() => {}); return { passed: false, notes: 'developer 无输出' }; }
    const verdict = await this._runValidator(sid, sess, task, exec, true);
    // 合并回 base（简化：直接把 worktree 的 hello.txt 拷回）
    try {
      const f = join(wt.dir, 'hello.txt');
      if (fs.existsSync(f)) fs.copyFileSync(f, join(sess.workingDir, 'hello.txt'));
    } catch {}
    await wtm.cleanup(sess.workingDir, created).catch(() => {});
    return verdict;
  };

  console.log('[test] 启动 RalphEngine...');
  const t0 = Date.now();
  await engine.start(sessionId, { maxIterations: 3 });
  // 等 loop 结束
  for (let i = 0; i < 120 && engine.isRunning(sessionId); i++) await new Promise(r => setTimeout(r, 1000));
  console.log(`[test] 结束，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);

  const helloPath = join(repo, 'hello.txt');
  const exists = fs.existsSync(helloPath);
  const content = exists ? fs.readFileSync(helloPath, 'utf-8') : '';
  console.log('\n========== 结果 ==========');
  console.log('hello.txt 存在:', exists);
  console.log('内容:', JSON.stringify(content));
  const prog = progressManager.loadProgress(sessionId);
  console.log('任务状态:', prog?.features?.map(f => `${f.id}:${f.status}`).join(', '));
  const ok = exists && /hello/i.test(content);
  console.log(ok ? '\n✅ 真实 headless 端到端通过：claude 实际执行并产出内容' : '\n❌ 未产出预期内容');
  process.exit(ok ? 0 : 1);
}

main().catch(e => { console.error('[test] 异常:', e); process.exit(1); });
