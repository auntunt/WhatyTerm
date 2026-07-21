/**
 * DeliveryEngine.js
 * 三层 Loop 编排器：micro / meso / macro
 *
 * 架构：
 *   DeliveryEngine（本文件）
 *   ├── ProjectDecomposer  → 需求 → PRD → WBS → 接口契约
 *   ├── RalphEngine（复用）→ 每个子任务的 micro loop（执行+验证+重试）
 *   └── IntegrationRunner  → meso loop（集成验证）
 *
 * Loop 层次：
 *   macro: 需求层  — 集成失败定位到 design_flaw/requirement_gap 时触发
 *   meso:  集成层  — 所有子任务完成后，跑集成验证
 *   micro: 子任务层 — RalphEngine 内部：执行→Validator→失败→重试(MAX_RETRY=5)
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import progressManager from '../ProgressManager.js';
import { ProjectDecomposer } from './ProjectDecomposer.js';
import { INTEGRATION_PROMPT, MACRO_REPAIR_PROMPT } from './prompts.js';
import { detectInstallCmd, detectBuildCmd, detectTestCmd } from '../util/projectCommands.js';

const MESO_MAX_RETRY = 3;   // 集成层最多重试 3 次
const MACRO_MAX_RETRY = 2;  // 需求层最多回退修复 2 次

export class DeliveryEngine {
  constructor(sessionManager, ralphEngine, aiEngine, io) {
    this.sessionManager = sessionManager;
    this.ralphEngine = ralphEngine;
    this.aiEngine = aiEngine;
    this.io = io;
    this.decomposer = new ProjectDecomposer(aiEngine, io);
    this.running = new Map(); // sessionId -> state
  }

  isRunning(sessionId) { return this.running.has(sessionId); }

  stop(sessionId) {
    const s = this.running.get(sessionId);
    if (s) s.stop = true;
  }

  _emit(sessionId, event, data) {
    this.io?.emit(event, { sessionId, ...data });
  }

  _log(sessionId, msg) {
    console.log(`[DeliveryEngine] ${sessionId.slice(0, 8)}: ${msg}`);
    this._emit(sessionId, 'delivery:log', { line: msg, ts: Date.now() });
  }

  // ── 主入口：完整交付流程 ──────────────────────────────────────────
  async deliver(sessionId, { requirement, clarification, workingDir, aiType, providerId }) {
    if (this.running.has(sessionId)) {
      this._log(sessionId, '已在运行，忽略重复启动');
      return;
    }
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this._log(sessionId, '会话不存在');
      return;
    }

    const state = {
      stop: false,
      phase: 'idle',
      macroRetry: 0,
      mesoRetry: 0,
      wbs: null,
      prd: null,
    };
    this.running.set(sessionId, state);
    this._emit(sessionId, 'delivery:state', { running: true, phase: 'starting' });

    try {
      await this._macroLoop(sessionId, session, state, {
        requirement, clarification, workingDir, aiType, providerId
      });
    } catch (err) {
      this._log(sessionId, `交付异常终止: ${err.message}`);
      this._emit(sessionId, 'delivery:state', { running: false, phase: 'error', error: err.message });
    } finally {
      this.running.delete(sessionId);
    }
  }

  // ── Macro Loop：需求层 ────────────────────────────────────────────
  async _macroLoop(sessionId, session, state, opts) {
    while (state.macroRetry <= MACRO_MAX_RETRY) {
      if (state.stop) return;

      // Step 1: 拆解需求（首次或 PRD 需要更新时）
      if (!state.wbs) {
        this._setPhase(sessionId, state, 'decomposing');
        const { prd, wbs } = await this.decomposer.decompose(sessionId, opts);
        state.prd = prd;
        state.wbs = wbs;
      }

      // Step 2: 把 WBS 任务加载进 ProgressManager
      this._loadWBSIntoProgress(sessionId, state.wbs);
      this._emit(sessionId, 'delivery:wbs', {
        prd: state.prd,
        tasks: state.wbs.tasks,
        executionOrder: state.wbs.executionOrder,
      });

      // Step 3: Micro Loop（按批次执行子任务）
      this._setPhase(sessionId, state, 'executing');
      const execResult = await this._executeInBatches(sessionId, session, state, opts);
      if (state.stop) return;

      if (!execResult.allDone) {
        this._log(sessionId, `部分任务未完成: ${execResult.blocked.join(', ')} 被阻塞`);
        // blocked 任务交给用户决策，继续走集成
      }

      // Step 4: Meso Loop（集成验证）
      this._setPhase(sessionId, state, 'integrating');
      const mesoResult = await this._mesoLoop(sessionId, session, state, opts);
      if (state.stop) return;

      if (mesoResult.passed) {
        this._log(sessionId, '✓ 集成验证通过，交付完成');
        this._setPhase(sessionId, state, 'done');
        this._emit(sessionId, 'delivery:state', { running: false, phase: 'done' });
        return;
      }

      // Meso 失败：分析根因，决定是否需要 macro 回退
      const analysis = await this._analyzeMesoFailure(sessionId, state, mesoResult.error);
      if (state.stop) return;

      if (analysis.failureType === 'design_flaw' || analysis.failureType === 'requirement_gap') {
        state.macroRetry++;
        if (state.macroRetry > MACRO_MAX_RETRY) {
          this._log(sessionId, `已达 macro 最大重试 (${MACRO_MAX_RETRY})，需要人工介入`);
          this._emit(sessionId, 'delivery:state', {
            running: false, phase: 'escalated',
            reason: analysis.rootCause, analysis
          });
          return;
        }
        this._log(sessionId, `Macro 回退 (第${state.macroRetry}次): ${analysis.rootCause}`);
        this._emit(sessionId, 'delivery:macro_repair', { analysis, retry: state.macroRetry });

        // 更新受影响的任务契约，重置 WBS（仅受影响部分）
        this._applyMacroRepair(sessionId, state, analysis);
        state.mesoRetry = 0;
        continue; // 重新进入 macro loop
      }

      // interface_mismatch / implementation_bug → 局部重跑，不重新拆解
      this._log(sessionId, `局部修复: ${analysis.affectedTasks.join(', ')}`);
      this._resetAffectedTasks(sessionId, analysis.affectedTasks);
      state.macroRetry++; // 消耗一次 macro 额度（防止无限循环）
    }

    this._log(sessionId, '已达最大重试次数，需要人工介入');
    this._emit(sessionId, 'delivery:state', { running: false, phase: 'escalated' });
  }

  // ── 按批次执行子任务（micro loop 由 RalphEngine 负责）────────────
  async _executeInBatches(sessionId, session, state, opts) {
    const { executionOrder, tasks } = state.wbs;
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const blocked = [];
    const completed = [];

    for (const { batch, tasks: batchTaskIds } of executionOrder) {
      if (state.stop) break;
      this._log(sessionId, `批次 ${batch}: 执行 ${batchTaskIds.join(', ')}`);

      // 同批次内可并行，用 Promise.allSettled
      const batchResults = await Promise.allSettled(
        batchTaskIds.map(taskId => this._executeTask(sessionId, session, taskMap.get(taskId), opts))
      );

      for (let i = 0; i < batchTaskIds.length; i++) {
        const taskId = batchTaskIds[i];
        const r = batchResults[i];
        if (r.status === 'fulfilled' && r.value?.passed) {
          completed.push(taskId);
          this._log(sessionId, `✓ ${taskId} 完成`);
        } else {
          blocked.push(taskId);
          const reason = r.reason?.message || r.value?.reason || '未知';
          this._log(sessionId, `✗ ${taskId} 失败/阻塞: ${reason}`);
        }
        this._emit(sessionId, 'delivery:task_done', {
          taskId, passed: !blocked.includes(taskId)
        });
      }
    }

    return { allDone: blocked.length === 0, completed, blocked };
  }

  // ── 执行单个子任务（包装 RalphEngine micro loop）────────────────
  async _executeTask(sessionId, session, task, opts) {
    if (!task) return { passed: false, reason: '任务不存在' };

    this._log(sessionId, `  → 执行 ${task.id}: ${task.name}`);
    this._emit(sessionId, 'delivery:task_start', { taskId: task.id, taskName: task.name });

    // 把接口契约注入到任务描述，确保上下文隔离
    const enrichedTask = this._buildIsolatedTaskContext(task, session);

    try {
      await this._runMicroLoop(sessionId, session, enrichedTask, opts);
      return { passed: true };
    } catch (err) {
      return { passed: false, reason: err.message };
    }
  }

  // ── Micro Loop：直接调用 RalphEngine 的 developer+validator ───────
  async _runMicroLoop(sessionId, session, task, opts) {
    const taskSessionId = sessionId + ':micro:' + task.id;

    // 用 setMode + setFeatures 初始化独立进度状态
    progressManager.setMode(taskSessionId, 'autonomous');
    progressManager.setFeatures(taskSessionId, [task]);

    // RalphEngine.start 会从 progressManager 取任务，逐个执行 developer→validator
    // 任务队列只有一个，完成后自动退出
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`任务 ${task.id} 超时（30分钟）`)),
        30 * 60 * 1000
      );

      // 监听 ralph:state 事件判断完成/失败
      const onState = ({ sessionId: sid, phase, running }) => {
        if (sid !== taskSessionId) return;
        if (!running && phase === 'done') {
          clearTimeout(timeout);
          this.io?.off('ralph:state', onState);
          resolve();
        } else if (!running && phase === 'stopped') {
          clearTimeout(timeout);
          this.io?.off('ralph:state', onState);
          // 检查是否有被 blocked 的任务
          const prog = progressManager.loadProgress(taskSessionId);
          const blocked = prog?.features?.find(f => f.blocked);
          if (blocked) {
            reject(new Error(`任务 ${task.id} 验证失败超过最大重试次数`));
          } else {
            resolve();
          }
        }
      };

      this.io?.on('ralph:state', onState);

      // 启动 ralph（非阻塞）
      this.ralphEngine.start(taskSessionId, { maxIterations: 10 }).catch(err => {
        clearTimeout(timeout);
        this.io?.off('ralph:state', onState);
        reject(err);
      });
    });
  }

  // ── Meso Loop：集成验证 ───────────────────────────────────────────
  async _mesoLoop(sessionId, session, state, opts) {
    for (let attempt = 1; attempt <= MESO_MAX_RETRY; attempt++) {
      if (state.stop) return { passed: false, error: 'stopped' };
      this._log(sessionId, `集成验证 (第${attempt}次)...`);
      this._emit(sessionId, 'delivery:meso', { attempt });

      const result = await this._runIntegration(sessionId, session, state, opts);
      if (result.passed) return { passed: true };

      this._log(sessionId, `集成验证失败 (${attempt}/${MESO_MAX_RETRY}): ${result.error}`);

      if (attempt < MESO_MAX_RETRY) {
        // 定位失败模块，局部重跑
        const failedTask = result.failedTaskId;
        if (failedTask) {
          this._log(sessionId, `  局部重跑: ${failedTask}`);
          this._resetAffectedTasks(sessionId, [failedTask]);
          const taskMap = new Map(state.wbs.tasks.map(t => [t.id, t]));
          await this._executeTask(sessionId, session, taskMap.get(failedTask), opts);
        }
      }
    }
    return { passed: false, error: `集成验证连续失败 ${MESO_MAX_RETRY} 次` };
  }

  // ── 运行集成验证 ──────────────────────────────────────────────────
  async _runIntegration(sessionId, session, state, opts) {
    const completedTasks = state.wbs.tasks
      .filter(t => {
        const prog = progressManager.getFeatureStatus(sessionId, t.id);
        return prog?.status === 'completed';
      })
      .map(t => `${t.id}: ${t.name}\n  输出: ${(t.contract?.outputs || []).join(', ')}`);

    const techStack = JSON.stringify(state.prd?.techStack || {});
    const installCmd = this._detectInstallCmd(session.workingDir);
    const buildCmd = this._detectBuildCmd(session.workingDir);
    const testCmd = this._detectTestCmd(session.workingDir);

    const prompt = INTEGRATION_PROMPT
      .replace('{WORKING_DIR}', session.workingDir || '.')
      .replace('{TECH_STACK}', techStack)
      .replace('{COMPLETED_TASKS}', completedTasks.join('\n'))
      .replace('{INSTALL_CMD}', installCmd)
      .replace('{BUILD_CMD}', buildCmd || '（无构建步骤）')
      .replace('{TEST_CMD}', testCmd || '（无测试）');

    const output = await this._runHeadlessPrompt(sessionId, session, prompt, opts);

    if (output?.includes('INTEGRATION: PASS')) {
      return { passed: true };
    }
    const failMatch = output?.match(/INTEGRATION: FAIL - (T\d+)? ?-? ?(.+)/);
    return {
      passed: false,
      failedTaskId: failMatch?.[1] || null,
      error: failMatch?.[2] || output?.slice(-300) || '未知错误',
    };
  }

  // ── Macro 失败分析 ────────────────────────────────────────────────
  async _analyzeMesoFailure(sessionId, state, failureInfo) {
    this._log(sessionId, 'Macro 根因分析...');
    const completedOutputs = state.wbs.tasks
      .filter(t => progressManager.getFeatureStatus(sessionId, t.id)?.status === 'completed')
      .map(t => `${t.id}: ${JSON.stringify(t.contract?.outputs || [])}`).join('\n');

    const prompt = MACRO_REPAIR_PROMPT
      .replace('{FAILURE_INFO}', failureInfo)
      .replace('{WBS_TASKS}', JSON.stringify(state.wbs.tasks.map(t => ({ id: t.id, name: t.name, contract: t.contract })), null, 2))
      .replace('{COMPLETED_OUTPUTS}', completedOutputs);

    try {
      const response = await this.decomposer._callLLM(sessionId, prompt, 'Macro 分析');
      return this.decomposer._parseJSON(response, 'Macro 分析');
    } catch {
      // 解析失败，保守处理为 implementation_bug
      return { failureType: 'implementation_bug', affectedTasks: [], rootCause: failureInfo };
    }
  }

  // ── 辅助：把 WBS 加载进 ProgressManager ──────────────────────────
  _loadWBSIntoProgress(sessionId, wbs) {
    const features = wbs.tasks.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      priority: t.type === 'design' ? 'high' : 'medium',
      branch: '',
      acceptanceCriteria: t.contract?.acceptanceCriteria || [],
      status: 'pending',
      retryCount: 0,
    }));
    progressManager.setFeatures(sessionId, features);
  }

  // ── 辅助：构建上下文隔离的任务描述 ──────────────────────────────
  _buildIsolatedTaskContext(task, session) {
    const contract = task.contract || {};
    return {
      ...task,
      description: [
        `## 任务: ${task.name}`,
        ``,
        `### 你的输入（依赖项）`,
        ...(contract.inputs || ['无']).map(i => `- ${i}`),
        ``,
        `### 你的输出（必须产出）`,
        ...(contract.outputs || ['见需求描述']).map(o => `- ${o}`),
        ``,
        `### 需求与技术设计`,
        task.description,
        ``,
        `### 验收标准（必须全部通过）`,
        ...(contract.acceptanceCriteria || []).map(c => `- ${c}`),
        ``,
        `### 明确不包含（禁止实现）`,
        ...(contract.notIncluded || ['无']).map(n => `- ${n}`),
      ].join('\n'),
    };
  }

  // ── 辅助：重置受影响任务为 pending ───────────────────────────────
  _resetAffectedTasks(sessionId, taskIds) {
    for (const id of taskIds) {
      progressManager.updateFeatureStatus(sessionId, id, { status: 'pending', retryCount: 0 });
    }
  }

  // ── 辅助：应用 macro 修复（更新受影响任务的契约）────────────────
  _applyMacroRepair(sessionId, state, analysis) {
    for (const taskId of (analysis.needsContractUpdate || [])) {
      const task = state.wbs.tasks.find(t => t.id === taskId);
      if (task) {
        this._log(sessionId, `  更新契约: ${taskId} (等待 LLM 重新生成)`);
        // 标记需要重新生成契约，下次 decompose 时处理
        task._needsContractRegen = true;
      }
    }
    // 若需要 PRD 更新，清空 wbs 触发重新拆解
    if (analysis.needsPRDUpdate) {
      state.wbs = null;
      this._log(sessionId, '  PRD 需要更新，将重新拆解');
    } else {
      // 只重置受影响的任务
      this._resetAffectedTasks(sessionId, analysis.affectedTasks);
    }
  }

  // ── 辅助：运行 headless prompt（集成验证不需要写文件，只需 LLM 分析）─
  async _runHeadlessPrompt(sessionId, session, prompt, opts) {
    try {
      return await this.aiEngine.callLLM(prompt, { maxTokens: 2048 });
    } catch (err) {
      this._log(sessionId, `headless prompt 失败: ${err.message}`);
      return null;
    }
  }

  _setPhase(sessionId, state, phase) {
    state.phase = phase;
    this._emit(sessionId, 'delivery:state', { running: true, phase });
  }

  // ── 检测构建/测试命令（委托共享工具模块）─────────────────────────
  _detectInstallCmd(workingDir) { return detectInstallCmd(workingDir); }
  _detectBuildCmd(workingDir) { return detectBuildCmd(workingDir); }
  _detectTestCmd(workingDir) { return detectTestCmd(workingDir); }
}
