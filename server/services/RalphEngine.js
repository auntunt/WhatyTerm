/**
 * Required Notice: Copyright (c) 2025 WhatyTerm (https://whatyterm.whaty.org)
 * SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
 * 本文件按 PolyForm Noncommercial 1.0.0 授权（见根目录 LICENSE）：
 * 非商业用途免费；商业用途需商业许可（见 LICENSE-COMMERCIAL）。
 *
 * RalphEngine - 自主软件工厂引擎（移植自 Ralph）
 *
 * 在可观看的 tmux 会话内，用 headless CLI 逐个执行任务队列：
 *   取任务 → Developer 执行 → Validator 逐条验收 → 失败退回重试/满5次blocked → 全部完成归档
 *
 * 复用 WebTmux 的会话/CLI 抽象，支持全部 6 种 CLI。结果用文件重定向 + DONE 标记捕获。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import progressManager from './ProgressManager.js';
import { DEVELOPER_PROMPT, VALIDATOR_PROMPT } from './ralph/prompts.js';
import { detectProjectCommands } from './util/projectCommands.js';
import { WorktreeManager } from './WorktreeManager.js';
import { scoreVerdict } from './util/verdictScore.js';

// 验收置信度阈值：低于此值即使 passed 也降级为存疑，触发重试
const MIN_CONFIDENCE = 0.6;

// 超时配置（毫秒）
const FIRST_TOKEN_TIMEOUT = 300 * 1000; // 大 prompt 经中转首字可能较慢，给 5 分钟
const IDLE_TIMEOUT = 180 * 1000;        // 输出中途静默容忍 3 分钟
const TOTAL_TIMEOUT = 30 * 60 * 1000;
const MAX_RETRY = 5;

// 生成短唯一标记（用于临时文件名 + DONE 标记）
let _uidCounter = 0;
function task_uid() {
  _uidCounter = (_uidCounter + 1) % 100000;
  return `${Date.now().toString(36)}${_uidCounter.toString(36)}`;
}

// headless CLI 命令模板
function headlessCmd(aiType, outFile) {
  switch (aiType) {
    case 'codex':
      return `codex exec --dangerously-bypass-approvals-and-sandbox`;
    case 'grok':
      return `grok -p --always-approve`;
    case 'gemini':
      return `gemini --yolo -p`;
    default: // claude / droid / opencode 走 claude 风格
      return `claude --print --dangerously-skip-permissions`;
  }
}

class RalphEngine {
  constructor(sessionManager, io, aiEngine = null) {
    this.sessionManager = sessionManager;
    this.io = io;
    this.aiEngine = aiEngine;   // 用于扇出候选的 spawn 式 headless 执行（各自独立 cwd/CLI/env）
    this.running = new Map();   // sessionId -> { stop: boolean, phase, iteration }
    this.tmpDir = path.join(os.tmpdir(), 'webtmux-ralph');
    try { fs.mkdirSync(this.tmpDir, { recursive: true }); } catch {}
    // resolveProviderEnv(session, aiType) → providerEnv：由 index.js 注入，
    // 供扇出候选用不同 CLI 竞标时拿到对应供应商的 spawn 环境变量。可选。
    this.resolveProviderEnv = null;
  }

  isRunning(sessionId) {
    return this.running.has(sessionId);
  }

  stop(sessionId) {
    const state = this.running.get(sessionId);
    if (state) state.stop = true;
  }

  _emit(sessionId, event, data) {
    if (this.io) this.io.emit(event, { sessionId, ...data });
  }

  _log(sessionId, msg) {
    console.log(`[RalphEngine] ${sessionId.slice(0, 8)}: ${msg}`);
    this._emit(sessionId, 'ralph:log', { line: msg, ts: Date.now() });
  }

  /** 启动自主循环（不阻塞调用方）
   * @param {object} options { maxIterations, branch, pauseAfterEachTask }
   */
  async start(sessionId, options = {}) {
    // 兼容旧签名 start(sessionId, maxIterations)
    if (typeof options === 'number') options = { maxIterations: options };
    const maxIterations = options.maxIterations || 100;
    const branch = options.branch || '';
    const pauseAfterEachTask = !!options.pauseAfterEachTask;
    // 扇出配置 { count, clis }：count>1 或 clis.length>1 时开启「自主版 Orca」多候选竞标。
    const fanout = this._normalizeFanout(options.fanout);

    if (this.running.has(sessionId)) {
      this._log(sessionId, '已在运行中，忽略重复启动');
      return;
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this._log(sessionId, '会话不存在，无法启动');
      return;
    }
    const state = { stop: false, paused: false, phase: 'idle', iteration: 0, pauseAfterEachTask, fanout };
    this.running.set(sessionId, state);
    progressManager.setMode(sessionId, 'autonomous');
    this._emit(sessionId, 'ralph:state', { running: true, phase: 'idle' });
    const fanoutDesc = fanout ? ` | 扇出 ${fanout.candidates.length} 候选[${fanout.candidates.join(',')}]` : '';
    this._log(sessionId, `自主模式启动 (CLI: ${session.aiType || 'claude'}, 最大迭代: ${maxIterations}${fanoutDesc})`);

    try {
      // 护栏2：自动切换到专属分支（隔离改动）
      if (branch) {
        const ok = await this._ensureBranch(sessionId, session, branch);
        if (state.stop) return;
        if (!ok) {
          this._log(sessionId, '建分支失败/超时，已中止本次自主运行（请确认工作目录是 git 仓库、且未过大导致 git 卡顿）');
          this._emit(sessionId, 'ralph:state', { running: false, phase: 'stopped' });
          return;
        }
      }
      await this._loop(sessionId, session, state, maxIterations);
    } catch (err) {
      this._log(sessionId, `循环异常终止: ${err.message}`);
    } finally {
      this.running.delete(sessionId);
      this._emit(sessionId, 'ralph:state', { running: false, phase: 'stopped' });
    }
  }

  /** 暂停后恢复执行 */
  resume(sessionId) {
    const state = this.running.get(sessionId);
    if (state && state.paused) {
      state.paused = false;
      this._log(sessionId, '收到继续指令，恢复执行');
      this._emit(sessionId, 'ralph:state', { running: true, phase: state.phase });
    }
  }

  /** 在会话内切换/创建专属分支。返回 true 成功、false 失败/超时 */
  async _ensureBranch(sessionId, session, branch) {
    this._log(sessionId, `切换到专属分支: ${branch}`);
    const safe = branch.replace(/[^a-zA-Z0-9/_.-]/g, '-');
    // 已存在则切换，不存在则创建
    const cmd = `git checkout ${this._sh(safe)} 2>/dev/null || git checkout -b ${this._sh(safe)}`;
    // 大仓库 git 操作可能较慢，给 60s；失败返回 null → 上层中止本次运行
    const out = await this._execShell(sessionId, session, cmd, '建分支', 60 * 1000);
    return out !== null;
  }

  /** 主循环：逐个任务 Developer → Validator */
  async _loop(sessionId, session, state, maxIterations) {
    for (let i = 1; i <= maxIterations; i++) {
      if (state.stop) { this._log(sessionId, '收到停止指令，退出循环'); return; }
      state.iteration = i;

      const task = progressManager.getNextTask(sessionId);
      if (!task) {
        this._log(sessionId, '没有可执行任务，全部完成或被阻塞');
        this._emit(sessionId, 'ralph:state', { running: false, phase: 'done' });
        return;
      }

      progressManager.updateFeatureStatus(sessionId, task.id, { status: 'in_progress' });

      let verdict;
      if (this._shouldFanout(state, session, task)) {
        // ── 扇出：N 候选并行竞标，各自 Developer→Validator 打分，赢家 merge 回来 ──
        this._log(sessionId, `迭代 ${i}/${maxIterations} - 扇出开发任务: ${task.name}`);
        verdict = await this._runDeveloperFanout(sessionId, session, state, task, state.fanout);
        if (state.stop) return;
        if (verdict === null) {
          // 扇出基础设施失败（如非 git 仓库/建 worktree 失败）→ 回退单候选常规流程
          // （_runSingle 内部的 Validator 已记录 evaluation，不再补记）
          this._log(sessionId, `任务 ${task.id} 扇出不可用，回退单候选执行`);
          verdict = await this._runSingle(sessionId, session, state, task, i, maxIterations);
          if (state.stop) return;
          if (verdict === null) { await this._sleep(2000); continue; }
        } else {
          // 扇出各候选打分时 recordEval=false，未写主进度；这里为赢家补记一条主进度 evaluation
          progressManager.addEvaluation(sessionId, task.id, {
            passed: verdict.passed, confidence: verdict.confidence, feedback: verdict.notes,
          });
        }
      } else {
        verdict = await this._runSingle(sessionId, session, state, task, i, maxIterations);
        if (state.stop) return;
        if (verdict === null) { await this._sleep(2000); continue; }
      }

      if (verdict.passed) {
        progressManager.updateFeatureStatus(sessionId, task.id, {
          status: 'completed',
          passes: { implemented: true, compiles: true, tested: true }
        });
        this._log(sessionId, `✓ 任务 ${task.id} 验证通过`);
      } else {
        const r = progressManager.recordValidationFailure(sessionId, task.id, verdict.notes, MAX_RETRY);
        if (r?.blocked) {
          this._log(sessionId, `✗ 任务 ${task.id} 已达最大重试(${MAX_RETRY})，标记 blocked 跳过`);
          // 失败快照：保存工作区 diff + Validator 全文，供事后诊断/人工介入
          await this._saveBlockedSnapshot(sessionId, session, task, verdict);
          this._emit(sessionId, 'ralph:blocked', {
            taskId: task.id, name: task.name, reason: verdict.notes || '验证反复失败',
          });
        } else {
          this._log(sessionId, `✗ 任务 ${task.id} 验证失败 (第${r?.retryCount}次)，退回重试: ${verdict.notes}`);
        }
      }

      this._setPhase(sessionId, state, 'idle', null);
      if (!progressManager.hasRunnableTask(sessionId)) {
        this._log(sessionId, '所有任务已解决（完成或阻塞），结束');
        this._emit(sessionId, 'ralph:state', { running: false, phase: 'done' });
        return;
      }

      // 护栏3：每任务完成后可暂停，等用户 review 再继续
      if (state.pauseAfterEachTask) {
        state.paused = true;
        this._setPhase(sessionId, state, 'paused', null);
        this._emit(sessionId, 'ralph:paused', { iteration: i });
        this._log(sessionId, '任务完成，已暂停（点继续执行下一个）');
        while (state.paused && !state.stop) {
          await this._sleep(500);
        }
        if (state.stop) { this._log(sessionId, '暂停中收到停止'); return; }
      }
      await this._sleep(1000);
    }
    this._log(sessionId, `已达最大迭代次数 ${maxIterations}`);
  }

  /**
   * 单候选常规执行：会话 tmux 内 Developer→Validator。
   * @returns {Promise<object|null>} verdict；开发阶段失败返回 null（调用方退回 pending 重试）
   */
  async _runSingle(sessionId, session, state, task, i, maxIterations) {
    this._setPhase(sessionId, state, 'developing', task);
    this._log(sessionId, `迭代 ${i}/${maxIterations} - 开发任务: ${task.name}`);
    const devOk = await this._runDeveloper(sessionId, session, task);
    if (state.stop) return null;
    if (!devOk) {
      this._log(sessionId, `任务 ${task.id} 开发阶段超时/失败，稍后重试`);
      progressManager.updateFeatureStatus(sessionId, task.id, { status: 'pending' });
      return null;
    }
    this._setPhase(sessionId, state, 'validating', task);
    this._log(sessionId, `迭代 ${i} - 验证任务: ${task.name}`);
    return await this._runValidator(sessionId, session, task);
  }

  /** 规范化扇出配置：{ count, clis } → { candidates:[aiType...] } 或 null（不扇出）
   * 支持「两者都支持」：同 CLI 多跑（count 复制会话 CLI）、多 CLI 竞标（clis 列表）、任意组合。
   */
  _normalizeFanout(raw) {
    if (!raw) return null;
    const clis = Array.isArray(raw.clis) ? raw.clis.filter(Boolean) : [];
    const count = Math.max(0, parseInt(raw.count, 10) || 0);
    let candidates = [];
    if (clis.length) {
      candidates = clis.slice(0, 8);
      // count 大于 clis 数量时，用 clis 循环补足到 count（同/多 CLI 组合）
      if (count > candidates.length) {
        for (let i = candidates.length; i < Math.min(count, 8); i++) {
          candidates.push(clis[i % clis.length]);
        }
      }
    } else if (count > 1) {
      // 仅给了数量：用会话默认 CLI 多跑（aiType 在 start 时才知道，占位 null，_shouldFanout 时填充）
      candidates = new Array(Math.min(count, 8)).fill(null);
    }
    if (candidates.length < 2) return null; // 少于 2 个候选没有竞标意义
    return { candidates };
  }

  /** 该任务是否走扇出：有扇出配置 + 是 git 仓库 + 注入了 aiEngine（spawn 依赖） */
  _shouldFanout(state, session, task) {
    if (!state.fanout || !this.aiEngine) return false;
    if (!session.workingDir) return false;
    // 候选里 null 占位用会话默认 CLI 填充（同 CLI 多跑场景）
    state.fanout.candidates = state.fanout.candidates.map(c => c || session.aiType || 'claude');
    return true;
  }

  /**
   * 扇出核心：N 候选各自在独立 worktree 里 Developer→Validator 打分，选最高分 merge 回 base。
   * @returns {Promise<object|null>} 赢家 verdict；基础设施失败（非 git/建 worktree 失败）返回 null
   */
  async _runDeveloperFanout(sessionId, session, state, task, fanout) {
    const wtm = new WorktreeManager({ log: (m) => this._log(sessionId, `[worktree] ${m}`) });
    const baseDir = session.workingDir;
    const tag = `${task.id}-${task_uid()}`.replace(/[^a-zA-Z0-9._-]/g, '-');

    const created = await wtm.createWorktrees(baseDir, { count: fanout.candidates.length, tag });
    if (!created.ok) {
      this._log(sessionId, `扇出建 worktree 失败: ${created.error}`);
      return null;
    }
    const { worktrees, baseRef, root } = created;
    this._setPhase(sessionId, state, 'developing', task);
    this._emit(sessionId, 'ralph:fanout', {
      taskId: task.id, phase: 'start',
      candidates: worktrees.map((w, i) => ({ index: i, aiType: fanout.candidates[i], branch: w.branch })),
    });

    // 各候选并行：Developer → 兜底 commit → Validator 打分
    const runCandidate = async (wt, idx) => {
      const aiType = fanout.candidates[idx] || session.aiType || 'claude';
      const label = `候选c${idx}(${aiType})`;
      const providerEnv = this._providerEnvFor(session, aiType);
      const exec = { cwd: wt.dir, aiType, providerEnv, label };
      try {
        this._emit(sessionId, 'ralph:fanout', { taskId: task.id, phase: 'developing', index: idx, aiType });
        const devOk = await this._runDeveloper(sessionId, session, task, exec);
        if (!devOk) {
          this._emit(sessionId, 'ralph:fanout', { taskId: task.id, phase: 'dev_failed', index: idx });
          return { idx, wt, aiType, score: 0, verdict: { passed: false, confidence: 0, notes: '开发阶段失败/超时' } };
        }
        // 兜底提交，确保改动落到候选分支（部分 CLI 不自行 commit）
        await wtm.commitAll(wt.dir, `feat: [${task.id}] ${task.name} (candidate c${idx}/${aiType})`);
        const hasWork = await wtm.hasCommitsAhead(wt.dir, baseRef);

        this._emit(sessionId, 'ralph:fanout', { taskId: task.id, phase: 'validating', index: idx, aiType });
        // 候选各自验收：不写主进度 evaluations（recordEval=false），避免多候选污染
        const verdict = await this._runValidator(sessionId, session, task, exec, false);
        let score = scoreVerdict(verdict);
        if (!hasWork) score = 0; // 没有任何提交的候选无效
        this._emit(sessionId, 'ralph:fanout', {
          taskId: task.id, phase: 'scored', index: idx, aiType,
          score, passed: verdict.passed, confidence: verdict.confidence,
        });
        return { idx, wt, aiType, score, verdict, hasWork };
      } catch (e) {
        this._log(sessionId, `${label} 异常: ${e.message}`);
        return { idx, wt, aiType, score: 0, verdict: { passed: false, confidence: 0, notes: e.message } };
      }
    };

    let results;
    try {
      results = await Promise.all(worktrees.map((wt, idx) => runCandidate(wt, idx)));
    } catch (e) {
      await wtm.cleanup(baseDir, { worktrees, root });
      this._log(sessionId, `扇出执行异常: ${e.message}`);
      return null;
    }

    if (this.running.get(sessionId)?.stop) {
      await wtm.cleanup(baseDir, { worktrees, root });
      return null;
    }

    // 挑赢家：最高分（并列取最小 index，稳定）
    const winner = results.reduce((best, r) => (!best || r.score > best.score ? r : best), null);
    this._log(sessionId,
      `扇出评分: ${results.map(r => `c${r.idx}(${r.aiType})=${r.score.toFixed(1)}`).join('  ')} → 赢家 c${winner.idx}`);

    let merged = false;
    if (winner && winner.score > 0 && winner.hasWork) {
      const m = await wtm.mergeWinner(baseDir, winner.wt.branch);
      if (m.ok) {
        merged = true;
        this._log(sessionId, `✓ 赢家 c${winner.idx}(${winner.aiType}) 已 merge 回 ${created.baseBranch || baseRef}`);
      } else {
        this._log(sessionId, `赢家 merge 失败: ${m.error}`);
        winner.verdict = { ...winner.verdict, passed: false, notes: `赢家 merge 失败: ${m.error}` };
      }
    } else {
      this._log(sessionId, `无有效赢家候选（全部得分为 0 或无提交）`);
    }

    this._emit(sessionId, 'ralph:fanout', {
      taskId: task.id, phase: 'done',
      winner: winner ? { index: winner.idx, aiType: winner.aiType, score: winner.score } : null,
      merged,
      results: results.map(r => ({ index: r.idx, aiType: r.aiType, score: r.score, passed: r.verdict?.passed })),
    });

    // 清理所有 worktree（保留赢家分支做审计快照）
    await wtm.cleanup(baseDir, { worktrees, root, keepBranch: merged ? winner.wt.branch : null });

    // 返回赢家 verdict；merge 失败/无赢家则以失败 verdict 触发重试
    return winner ? winner.verdict : { passed: false, confidence: 0, notes: '扇出无有效候选' };
  }

  /** 保存 blocked 任务的失败快照：工作区 git diff + Validator 全文。 */
  async _saveBlockedSnapshot(sessionId, session, task, verdict) {
    let diff = '';
    try {
      // 工作区相对 HEAD 的改动（含已暂存）；大仓库限长由 ProgressManager 截断
      diff = await this._execShell(sessionId, session, 'git diff HEAD 2>/dev/null | head -c 200000', '快照diff', 15000) || '';
    } catch {}
    try {
      progressManager.saveFailureSnapshot(sessionId, task.id, {
        diff,
        validatorOutput: verdict?.raw || verdict?.notes || '',
        reason: verdict?.notes || '',
      });
      this._log(sessionId, `已保存任务 ${task.id} 失败快照`);
    } catch (e) {
      this._log(sessionId, `保存失败快照失败: ${e.message}`);
    }
  }

  /** 取某 CLI 类型在本会话的 spawn 环境变量（多 CLI 竞标时用）。未注入 resolver 时返回空。 */
  _providerEnvFor(session, aiType) {
    if (typeof this.resolveProviderEnv === 'function') {
      try { return this.resolveProviderEnv(session, aiType) || {}; } catch { return {}; }
    }
    return {};
  }

  _setPhase(sessionId, state, phase, task) {
    state.phase = phase;
    this._emit(sessionId, 'ralph:state', {
      running: true, phase, iteration: state.iteration,
      currentTask: task ? { id: task.id, name: task.name } : null
    });
  }

  /** 构建任务上下文（项目 CLAUDE.md + patterns + 任务详情）
   * @param {object} [ctx] 可选执行上下文 { cwd } —— 扇出候选在自己的 worktree 目录里读 CLAUDE.md
   */
  _buildTaskContext(sessionId, session, task, ctx = {}) {
    const parts = [];
    const workDir = ctx.cwd || session.workingDir || '';
    const claudeMd = path.join(workDir, 'CLAUDE.md');
    try {
      if (workDir && fs.existsSync(claudeMd)) {
        parts.push(`# 项目上下文（CLAUDE.md）\n${fs.readFileSync(claudeMd, 'utf-8').substring(0, 4000)}`);
      }
    } catch {}
    const progress = progressManager.loadProgress(sessionId);
    if (progress?.patterns?.length) {
      parts.push(`# Codebase Patterns（复用经验）\n- ${progress.patterns.join('\n- ')}`);
    }
    const acList = Array.isArray(task.acceptanceCriteria)
      ? task.acceptanceCriteria
      : (typeof task.acceptanceCriteria === 'string' && task.acceptanceCriteria.trim())
        ? task.acceptanceCriteria.split('\n').map(s => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean)
        : [];
    const ac = acList.map(c => `- ${c}`).join('\n') || '- （未指定，按需求合理判断）';
    parts.push(
      `# 当前任务 [${task.id}] ${task.name}\n` +
      `优先级: ${task.priority}  分支: ${task.branch || '(当前分支)'}\n\n` +
      `## 需求与技术设计\n${task.description}\n\n## 验收标准\n${ac}`
    );
    return parts.join('\n\n---\n\n');
  }

  /** Developer 阶段：执行实现
   * @param {object} [exec] 执行上下文 { cwd, aiType, providerEnv, label } —— 提供 cwd 时走
   *   spawn 式（独立目录，供扇出并行）；否则走会话 tmux 内 headless。
   */
  async _runDeveloper(sessionId, session, task, exec = null) {
    const ctx = this._buildTaskContext(sessionId, session, task, exec || {});
    const prompt = `${ctx}\n\n---\n\n${DEVELOPER_PROMPT}\n\n立即开始执行当前任务，不要询问确认。`;
    const out = exec?.cwd
      ? await this._execSpawn(sessionId, session, prompt, exec, TOTAL_TIMEOUT)
      : await this._execHeadless(sessionId, session, prompt, '开发', TOTAL_TIMEOUT);
    if (out === null) return false;
    // 抓取 PATTERN: 学习并记录
    const m = out.match(/PATTERN:\s*(.+)/i);
    if (m) progressManager.addPattern(sessionId, m[1].trim().slice(0, 200));
    return true;
  }

  /** Validator 阶段：注入真实命令，解析结构化评分，写 evaluations，低置信度降级
   * @param {object} [exec] 执行上下文 { cwd, aiType, providerEnv }；提供 cwd 时在该目录验证（扇出候选）
   * @param {boolean} [recordEval=true] 是否写入 progress 的 evaluations（扇出候选各自打分，不污染主进度）
   */
  async _runValidator(sessionId, session, task, exec = null, recordEval = true) {
    const workDir = exec?.cwd || session.workingDir || '';
    const ctx = this._buildTaskContext(sessionId, session, task, exec || {});
    const cmds = detectProjectCommands(workDir);
    const prompt = VALIDATOR_PROMPT
      .replace('{INSTALL_CMD}', cmds.install || '（无）')
      .replace('{BUILD_CMD}', cmds.build || '（无）')
      .replace('{TEST_CMD}', cmds.test || '（无）');
    const fullPrompt = `${ctx}\n\n---\n\n${prompt}\n\n立即开始验证，不要询问确认。`;
    const out = exec?.cwd
      ? await this._execSpawn(sessionId, session, fullPrompt, exec, TOTAL_TIMEOUT * 2)
      : await this._execHeadless(sessionId, session, fullPrompt, '验证', TOTAL_TIMEOUT * 2);
    if (out === null) return { passed: false, notes: '验证阶段超时或无输出', confidence: 0 };

    const verdict = this._parseVerdict(out);
    verdict.raw = out; // 保留 Validator 全文，供失败快照诊断
    // 记录一条结构化评估（复用 ProgressManager.evaluations）
    if (recordEval) {
      progressManager.addEvaluation(sessionId, task.id, {
        passed: verdict.passed,
        confidence: verdict.confidence,
        feedback: verdict.notes,
      });
    }

    // 低置信度即使 passed 也降级为存疑 → 退回重试，避免"猜过"
    if (verdict.passed && verdict.confidence < MIN_CONFIDENCE) {
      this._log(sessionId, `任务 ${task.id} 判过但置信度偏低(${verdict.confidence})，降级为存疑重试`);
      return {
        passed: false,
        notes: `置信度不足(${verdict.confidence}<${MIN_CONFIDENCE})：${verdict.notes || '验收依据不充分'}`,
        confidence: verdict.confidence,
        raw: out,
      };
    }
    return verdict;
  }

  /**
   * 解析 Validator 输出。优先取 ===VALIDATION=== 包裹的 JSON；
   * 回退兼容旧的 VALIDATION: PASS/FAIL 文本格式。
   * 返回 { passed, confidence, notes, compiles, tested, criteriaMet }
   */
  _parseVerdict(out) {
    // 1) 结构化 JSON 块
    const block = out.match(/===VALIDATION===\s*([\s\S]*?)\s*===VALIDATION===/);
    if (block) {
      try {
        const j = JSON.parse(block[1].trim());
        const confidence = typeof j.confidence === 'number' ? Math.max(0, Math.min(1, j.confidence)) : 0.5;
        return {
          passed: !!j.passed,
          confidence,
          notes: (j.notes || '').toString().slice(0, 300),
          compiles: j.compiles ?? null,
          tested: j.tested ?? null,
          criteriaMet: j.criteria_met ?? null,
        };
      } catch { /* 落到回退解析 */ }
    }
    // 2) 回退：旧文本格式
    if (/VALIDATION:\s*PASS/i.test(out)) {
      return { passed: true, confidence: 0.5, notes: '(旧格式PASS，无结构化评分)', compiles: null, tested: null, criteriaMet: null };
    }
    const fail = out.match(/VALIDATION:\s*FAIL\s*-?\s*(.+)/i);
    if (fail) {
      return { passed: false, confidence: 0.5, notes: fail[1].trim().slice(0, 300), compiles: null, tested: null, criteriaMet: null };
    }
    // 3) 无任何明确结论：保守判失败
    return { passed: false, confidence: 0, notes: '未输出明确验证结论（缺少 VALIDATION 标记/JSON）', compiles: null, tested: null, criteriaMet: null };
  }

  _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  /**
   * 在会话 tmux 内执行一次 headless CLI 调用。
   * 机制：prompt 写临时文件，stdout/err 重定向到输出文件，命令尾部 echo DONE 标记。
   * 引擎轮询输出文件大小（检测活跃）+ DONE 标记（检测完成），三层超时兜底。
   * 返回输出文本，超时/失败返回 null。
   */
  async _execHeadless(sessionId, session, prompt, label, totalTimeout) {
    const aiType = session.aiType || 'claude';
    const tag = `${task_uid()}`;
    const promptFile = path.join(this.tmpDir, `prompt-${tag}.txt`);
    const outFile = path.join(this.tmpDir, `out-${tag}.txt`);
    const doneMarker = `__RALPH_DONE_${tag}__`;

    // 执行前确保供应商/relay 映射就绪：第三方供应商走本会话本地反代
    // (ANTHROPIC_BASE_URL=/relay/<sessionId>)，若服务重启后映射未重建、或会话从未在面板
    // 设过供应商，headless 的 claude 请求会拿到 502，CLI 打印 "Execution error"、输出为空。
    // ensureProvider 由 index.js 注入(幂等重设会话供应商，重建 relay 映射)。
    if (typeof this.ensureProvider === 'function') {
      try {
        const ok = await this.ensureProvider(session);
        if (ok === false) {
          this._log(sessionId, `${label}: 供应商/relay 映射未就绪，无法执行（请在面板为该会话选择供应商）`);
          return null;
        }
      } catch (e) {
        this._log(sessionId, `${label}: ensureProvider 失败 ${e.message}`);
      }
    }

    try {
      fs.writeFileSync(promptFile, prompt, 'utf-8');
    } catch (e) {
      this._log(sessionId, `${label}: 写入 prompt 文件失败 ${e.message}`);
      return null;
    }

    const cli = headlessCmd(aiType, outFile);
    // prompt 经 stdin 传入；CLI 输出重定向到 outFile；完成后把 DONE 标记+rc 追加到 outFile 末尾。
    // 用文件末尾的标记检测完成（而非屏幕），彻底避免命令回显里的 marker 造成误判。
    const shellCmd = `cat ${this._sh(promptFile)} | ${cli} > ${this._sh(outFile)} 2>&1; echo "${doneMarker} rc=$?" >> ${this._sh(outFile)}`;
    this._log(sessionId, `${label}: 启动 headless ${aiType}`);

    // 先把终端复位到干净 shell：若前台残留交互式 CLI（如被自动操作/历史误敲进去的
    // 交互式 claude），命令会落进对话框执行不了。发两次 Ctrl+C 中断，再回车清行，
    // 确保 shellCmd 是提交给 shell、而非某个 REPL。
    try {
      session.write('\x03');           // Ctrl+C：中断/退出交互提示
      await this._sleep(150);
      session.write('\x03');
      await this._sleep(150);
      session.write('\r');             // 回车：清掉可能的半行输入，回到 shell 提示符
      await this._sleep(200);
    } catch {}

    // 通过会话写入命令（用户可在 tmux 里观看）
    try {
      session.write(shellCmd + '\r');
    } catch (e) {
      this._log(sessionId, `${label}: 写入命令失败 ${e.message}`);
      return null;
    }

    const start = Date.now();
    let lastSize = 0;
    let lastEmitLen = 0; // 已推送给前端的字符数（实时输出流）
    let lastChangeAt = Date.now();
    let gotFirst = false;

    while (true) {
      const st = this.running.get(sessionId);
      if (st?.stop) { this._killInSession(session); return null; }

      // 检测完成：读输出文件末尾的 DONE 标记（CLI 完成后由 shell 追加到文件）
      // 不从屏幕检测，避免命令回显里的 marker 造成误判
      const rawOut = this._readOut(outFile);
      const doneMatch = rawOut.match(new RegExp(doneMarker + '\\s+rc=(\\d+)'));
      if (doneMatch) {
        const rc = doneMatch[1];
        // 去掉结果末尾的 DONE 标记行
        const result = rawOut.replace(new RegExp('\\n?' + doneMarker + '\\s+rc=\\d+\\s*$'), '');
        this._cleanup(promptFile, outFile);
        this._log(sessionId, `${label}: 完成 (rc=${rc}, ${Math.round((Date.now() - start) / 1000)}s)`);
        if (rc !== '0') {
          this._log(sessionId, `${label}: 进程返回非零退出码 rc=${rc}`);
          return null;
        }
        return result;
      }

      // 检测输出文件增长（活跃度）+ 实时推送新增输出（让前端看到 CLI 正在产出什么）
      let size = 0;
      try { size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0; } catch {}
      if (size > lastSize) {
        lastSize = size; lastChangeAt = Date.now(); gotFirst = true;
        // 新增文本：去掉 DONE 标记行、空行，限长，取最近若干行推送
        const fresh = rawOut.slice(lastEmitLen);
        lastEmitLen = rawOut.length;
        const lines = fresh.split('\n')
          .map(s => s.replace(/\s+$/, ''))
          .filter(s => s && !s.includes(doneMarker))
          .map(s => s.slice(0, 500));
        this._emit(sessionId, 'ralph:progress', {
          label, bytes: size, elapsedMs: Date.now() - start,
          lines: lines.slice(-20)
        });
      }

      const now = Date.now();
      const idle = now - lastChangeAt;
      if (now - start > totalTimeout) {
        this._log(sessionId, `${label}: 总时长超时 (${Math.round((now - start) / 1000)}s)`);
        this._killInSession(session); this._cleanup(promptFile, outFile); return null;
      }
      if (!gotFirst && idle > FIRST_TOKEN_TIMEOUT) {
        this._log(sessionId, `${label}: 首字响应超时`);
        this._killInSession(session); this._cleanup(promptFile, outFile); return null;
      }
      if (gotFirst && idle > IDLE_TIMEOUT) {
        this._log(sessionId, `${label}: 持续无输出超时`);
        this._killInSession(session); this._cleanup(promptFile, outFile); return null;
      }
      await this._sleep(1000);
    }
  }

  _readOut(outFile) {
    try { return fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf-8') : ''; }
    catch { return ''; }
  }

  /**
   * spawn 式 headless 执行：不进会话 tmux（那只有一个终端、无法并行），而是直接 spawn CLI
   * 子进程，指定独立 cwd（候选 worktree）+ aiType + providerEnv。供扇出并行竞标使用。
   * 复用 AIEngine.generateTextViaCLI（已实现 CLI 解析/供应商注入/超时）。
   * @param {object} exec { cwd, aiType, providerEnv, label }
   * @returns {Promise<string|null>} 输出文本，失败/无 aiEngine 返回 null
   */
  async _execSpawn(sessionId, session, prompt, exec, totalTimeout) {
    if (!this.aiEngine || typeof this.aiEngine.generateTextViaCLI !== 'function') {
      this._log(sessionId, `${exec.label || '候选'}: 未注入 aiEngine，无法 spawn 式执行`);
      return null;
    }
    const aiType = exec.aiType || session.aiType || 'claude';
    this._log(sessionId, `${exec.label || '候选'}: spawn ${aiType} @ ${path.basename(exec.cwd)}`);
    try {
      const out = await this.aiEngine.generateTextViaCLI(prompt, {
        cwd: exec.cwd,
        aiType,
        providerEnv: exec.providerEnv || {},
        timeout: totalTimeout,
      });
      return out || null;
    } catch (e) {
      this._log(sessionId, `${exec.label || '候选'}: spawn 执行异常 ${e.message}`);
      return null;
    }
  }

  _cleanup(...files) {
    for (const f of files) { try { fs.unlinkSync(f); } catch {} }
  }

  /** 中断会话内正在跑的 headless 进程（发 Ctrl+C） */
  _killInSession(session) {
    try { session.write('\x03'); } catch {}
  }

  /** shell 路径转义（路径在 tmpDir，无空格也兜底加引号） */
  _sh(p) { return `'${String(p).replace(/'/g, "'\\''")}'`; }

  /** 在会话内执行一条普通 shell 命令（如 git），用 DONE 标记+输出文件检测完成 */
  async _execShell(sessionId, session, cmd, label, timeout = 30000) {
    const tag = task_uid();
    const outFile = path.join(this.tmpDir, `sh-${tag}.txt`);
    const doneMarker = `__RALPH_DONE_${tag}__`;
    const shellCmd = `{ ${cmd} ; } > ${this._sh(outFile)} 2>&1; echo "${doneMarker} rc=$?" >> ${this._sh(outFile)}`;
    try { session.write(shellCmd + '\r'); } catch (e) {
      this._log(sessionId, `${label}: 写入命令失败 ${e.message}`);
      return null;
    }
    const start = Date.now();
    while (true) {
      const st = this.running.get(sessionId);
      if (st?.stop) return null;
      const raw = this._readOut(outFile);
      const m = raw.match(new RegExp(doneMarker + '\\s+rc=(\\d+)'));
      if (m) {
        this._cleanup(outFile);
        this._log(sessionId, `${label}: 完成 (rc=${m[1]})`);
        return m[1] === '0' ? raw.replace(new RegExp('\\n?' + doneMarker + '\\s+rc=\\d+\\s*$'), '') : null;
      }
      if (Date.now() - start > timeout) {
        this._log(sessionId, `${label}: 超时`);
        this._cleanup(outFile);
        return null;
      }
      await this._sleep(500);
    }
  }
}

export default RalphEngine;
