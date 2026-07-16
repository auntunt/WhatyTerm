/**
 * ProjectDecomposer.js
 * 需求澄清 → PRD → WBS → 接口契约
 *
 * 使用 AIEngine 做 LLM 调用，输出结构化任务包供 DeliveryEngine 消费。
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import {
  DECOMPOSE_CLARIFY_PROMPT,
  DECOMPOSE_PRD_PROMPT,
  DECOMPOSE_WBS_PROMPT,
} from './prompts.js';

export class ProjectDecomposer {
  constructor(aiEngine, io) {
    this.aiEngine = aiEngine;
    this.io = io;
  }

  _emit(sessionId, event, data) {
    this.io?.emit(event, { sessionId, ...data });
  }

  _log(sessionId, msg) {
    console.log(`[Decomposer] ${sessionId.slice(0, 8)}: ${msg}`);
    this._emit(sessionId, 'delivery:log', { line: msg, ts: Date.now() });
  }

  // ── 项目上下文扫描（复用 PlannerService 的思路）────────────────
  _scanProject(workingDir) {
    const parts = [];
    if (!workingDir || !fs.existsSync(workingDir)) return '';
    try {
      const tree = execSync(
        'find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/dist/*" | head -50',
        { cwd: workingDir, timeout: 5000, encoding: 'utf-8' }
      ).trim();
      if (tree) parts.push(`文件结构:\n${tree}`);
    } catch {}
    for (const f of ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'README.md']) {
      const fp = path.join(workingDir, f);
      if (fs.existsSync(fp)) {
        try { parts.push(`${f}:\n${fs.readFileSync(fp, 'utf-8').slice(0, 600)}`); } catch {}
        break;
      }
    }
    return parts.join('\n\n');
  }

  // ── LLM 调用（借用 AIEngine 的 provider 管理）────────────────────
  async _callLLM(sessionId, prompt, label) {
    this._log(sessionId, `[LLM] ${label}...`);
    try {
      const result = await this.aiEngine.callProvider({
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 4096,
        sessionId,
      });
      return result?.content || result?.text || String(result || '');
    } catch (err) {
      this._log(sessionId, `[LLM] ${label} 失败: ${err.message}`);
      throw err;
    }
  }

  // ── 安全 JSON 解析 ────────────────────────────────────────────────
  _parseJSON(text, label) {
    const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      // 尝试提取第一个 { ... }
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch {}
      }
      throw new Error(`${label} JSON 解析失败: ${cleaned.slice(0, 200)}`);
    }
  }

  // ── Step 1: 需求澄清 ──────────────────────────────────────────────
  async checkClarification(sessionId, requirement, workingDir) {
    const projectCtx = this._scanProject(workingDir);
    const prompt = DECOMPOSE_CLARIFY_PROMPT
      .replace('{REQUIREMENT}', requirement)
      .replace('{PROJECT_CONTEXT}', projectCtx || '（无现有项目）');

    const response = await this._callLLM(sessionId, prompt, '需求澄清检查');

    if (response.includes('CLARIFY: SUFFICIENT')) {
      return { sufficient: true, questions: [] };
    }
    // 解析问题列表
    const questions = [];
    const lines = response.split('\n');
    for (const line of lines) {
      const m = line.match(/^Q\d+:\s*(.+)/);
      if (m) questions.push(m[1].trim());
    }
    return { sufficient: false, questions };
  }

  // ── Step 2: 生成 PRD ──────────────────────────────────────────────
  async generatePRD(sessionId, requirement, clarification, workingDir) {
    this._log(sessionId, '生成 PRD...');
    const projectCtx = this._scanProject(workingDir);
    const prompt = DECOMPOSE_PRD_PROMPT
      .replace('{REQUIREMENT}', requirement)
      .replace('{CLARIFICATION}', clarification || '（用户未补充）')
      .replace('{PROJECT_CONTEXT}', projectCtx || '（新项目）');

    const response = await this._callLLM(sessionId, prompt, 'PRD 生成');
    const prd = this._parseJSON(response, 'PRD');
    this._log(sessionId, `PRD 生成完成: ${prd.projectName}`);
    return prd;
  }

  // ── Step 3: WBS 拆解 + 接口契约 ──────────────────────────────────
  async generateWBS(sessionId, prd, workingDir) {
    this._log(sessionId, 'WBS 拆解...');
    const projectCtx = this._scanProject(workingDir);
    const prompt = DECOMPOSE_WBS_PROMPT
      .replace('{PRD}', JSON.stringify(prd, null, 2))
      .replace('{PROJECT_CONTEXT}', projectCtx || '（新项目）');

    const response = await this._callLLM(sessionId, prompt, 'WBS 拆解');
    const wbs = this._parseJSON(response, 'WBS');

    // 校验基本结构
    if (!Array.isArray(wbs.tasks) || wbs.tasks.length === 0) {
      throw new Error('WBS 拆解结果为空，请补充需求描述');
    }
    this._log(sessionId, `WBS 拆解完成: ${wbs.tasks.length} 个子任务`);

    // 标注执行顺序（拓扑排序）
    wbs.executionOrder = this._topoSort(wbs.tasks);
    return wbs;
  }

  // ── 拓扑排序（确定执行顺序，识别可并行批次）────────────────────
  _topoSort(tasks) {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    const visited = new Set();
    const order = []; // [{batch: 0, tasks: ['T01','T02']}, ...]

    const getDeps = (id) => taskMap.get(id)?.dependsOn || [];

    // 按批次分组（同批次内无依赖关系，可并行）
    const remaining = new Set(tasks.map(t => t.id));
    let batch = 0;
    while (remaining.size > 0) {
      const ready = [];
      for (const id of remaining) {
        const deps = getDeps(id);
        if (deps.every(d => visited.has(d))) {
          ready.push(id);
        }
      }
      if (ready.length === 0) {
        // 有循环依赖，把剩余全部加进来
        ready.push(...remaining);
      }
      order.push({ batch, tasks: ready });
      ready.forEach(id => { visited.add(id); remaining.delete(id); });
      batch++;
    }
    return order;
  }

  // ── 完整分解流程（供外部调用）────────────────────────────────────
  async decompose(sessionId, { requirement, clarification, workingDir }) {
    this._emit(sessionId, 'delivery:phase', { phase: 'decomposing', step: 'prd' });
    const prd = await this.generatePRD(sessionId, requirement, clarification, workingDir);

    this._emit(sessionId, 'delivery:phase', { phase: 'decomposing', step: 'wbs' });
    const wbs = await this.generateWBS(sessionId, prd, workingDir);

    // 持久化到 .webtmux/delivery/<sessionId>/
    this._saveDeliveryPlan(sessionId, { prd, wbs, requirement, clarification });

    this._emit(sessionId, 'delivery:phase', { phase: 'decomposed' });
    return { prd, wbs };
  }

  // ── 持久化拆解结果 ────────────────────────────────────────────────
  _saveDeliveryPlan(sessionId, plan) {
    const dir = path.join(process.env.HOME || '~', '.webtmux', 'delivery', sessionId);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
    } catch (e) {
      console.error('[Decomposer] 保存拆解结果失败:', e.message);
    }
  }

  loadDeliveryPlan(sessionId) {
    const file = path.join(process.env.HOME || '~', '.webtmux', 'delivery', sessionId, 'plan.json');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }
}
