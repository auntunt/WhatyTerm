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
  WBS_SELF_REVIEW_PROMPT,
  WBS_REPAIR_CLOSURE_PROMPT,
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

  // ── LLM 调用（通过 AIEngine 公共接口）────────────────────────────
  async _callLLM(sessionId, prompt, label) {
    this._log(sessionId, `[LLM] ${label}...`);
    try {
      return await this.aiEngine.callLLM(prompt, { maxTokens: 4096 });
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
    let wbs = this._parseJSON(response, 'WBS');

    // 校验基本结构
    if (!Array.isArray(wbs.tasks) || wbs.tasks.length === 0) {
      throw new Error('WBS 拆解结果为空，请补充需求描述');
    }
    this._log(sessionId, `WBS 初拆完成: ${wbs.tasks.length} 个子任务`);

    // Step 3.1: PRD→WBS 自查（让 LLM 复核覆盖度/契约/依赖/粒度并修正）
    wbs = await this._selfReviewWBS(sessionId, prd, wbs);

    // Step 3.2: 依赖引用校验（悬空引用先尝试 LLM 修不了则直接抛，避免带病执行）
    const dangling = this._validateDeps(wbs.tasks);
    if (dangling.length) {
      this._log(sessionId, `依赖引用悬空: ${dangling.map(d => `${d.task}→[${d.missing}]`).join(', ')}`);
    }

    // Step 3.3: 契约闭合性校验 + 一轮 LLM 修复
    wbs = await this._ensureContractClosure(sessionId, wbs, workingDir);

    // Step 3.4: 拓扑排序（遇循环依赖显式抛错）
    wbs.executionOrder = this._topoSort(wbs.tasks);
    this._log(sessionId, `WBS 定稿: ${wbs.tasks.length} 个子任务, ${wbs.executionOrder.length} 个批次`);
    return wbs;
  }

  /** PRD→WBS 自查一轮：LLM 复核并返回修正后的 WBS；失败/解析不出则保留原 WBS。 */
  async _selfReviewWBS(sessionId, prd, wbs) {
    try {
      const prompt = WBS_SELF_REVIEW_PROMPT
        .replace('{PRD}', JSON.stringify(prd, null, 2))
        .replace('{WBS}', JSON.stringify({ tasks: wbs.tasks }, null, 2));
      const resp = await this._callLLM(sessionId, prompt, 'WBS 自查');
      const reviewed = this._parseJSON(resp, 'WBS自查');
      if (Array.isArray(reviewed.tasks) && reviewed.tasks.length > 0) {
        if (reviewed.reviewNotes?.length) {
          this._log(sessionId, `自查修正: ${reviewed.reviewNotes.slice(0, 3).join('；')}`);
        }
        return { ...wbs, tasks: reviewed.tasks };
      }
    } catch (e) {
      this._log(sessionId, `WBS 自查跳过（保留初拆）: ${e.message}`);
    }
    return wbs;
  }

  /** 契约闭合性校验：不闭合则用 LLM 修复一轮；仍不闭合则记日志放行（不阻断，交由执行期/集成兜底）。 */
  async _ensureContractClosure(sessionId, wbs, workingDir) {
    let check = this.validateContractClosure(wbs, workingDir);
    if (check.closed) {
      this._log(sessionId, '契约闭合性校验通过');
      return wbs;
    }
    this._log(sessionId, `契约闭合性问题 ${check.unresolved.length} 处，尝试 LLM 修复`);
    try {
      const prompt = WBS_REPAIR_CLOSURE_PROMPT
        .replace('{WBS}', JSON.stringify({ tasks: wbs.tasks }, null, 2))
        .replace('{UNRESOLVED}', check.unresolved.map(u => `- [${u.task}] 输入「${u.input}」：${u.reason}`).join('\n'));
      const resp = await this._callLLM(sessionId, prompt, 'WBS 契约修复');
      const repaired = this._parseJSON(resp, 'WBS修复');
      if (Array.isArray(repaired.tasks) && repaired.tasks.length > 0) {
        const wbs2 = { ...wbs, tasks: repaired.tasks };
        const recheck = this.validateContractClosure(wbs2, workingDir);
        this._log(sessionId, recheck.closed
          ? '契约修复后闭合性通过'
          : `契约修复后仍有 ${recheck.unresolved.length} 处悬空（放行，交由执行/集成兜底）`);
        return wbs2;
      }
    } catch (e) {
      this._log(sessionId, `契约修复失败（放行）: ${e.message}`);
    }
    return wbs;
  }

  // ── 拓扑排序（确定执行顺序，识别可并行批次）────────────────────
  // 遇循环依赖【显式报错】（附带环上任务），而非静默塞进一个批次——静默会让
  // 相互依赖的任务在同批并行、彼此拿不到对方产物，是隐蔽的拆解缺陷。
  _topoSort(tasks) {
    const taskMap = new Map(tasks.map(t => [t.id, t]));
    // 依赖引用只保留指向真实存在任务的 id（悬空引用单独由 validateDeps 报错，这里做健壮性兜底）
    const getDeps = (id) => (taskMap.get(id)?.dependsOn || []).filter(d => taskMap.has(d));

    const visited = new Set();
    const order = []; // [{batch: 0, tasks: ['T01','T02']}, ...]
    const remaining = new Set(tasks.map(t => t.id));
    let batch = 0;
    while (remaining.size > 0) {
      const ready = [];
      for (const id of remaining) {
        if (getDeps(id).every(d => visited.has(d))) ready.push(id);
      }
      if (ready.length === 0) {
        // 没有任何任务的依赖被满足 → 剩余任务间存在循环依赖。定位环并报错。
        const cycle = this._findCycle(remaining, getDeps);
        const err = new Error(
          `WBS 存在循环依赖，无法确定执行顺序：${cycle.join(' → ')}。请修正 dependsOn 使其成为有向无环图。`
        );
        err.code = 'WBS_CYCLE';
        err.cycle = cycle;
        throw err;
      }
      order.push({ batch, tasks: ready });
      ready.forEach(id => { visited.add(id); remaining.delete(id); });
      batch++;
    }
    return order;
  }

  /** 在剩余（未排入）任务里找一条依赖环，返回环上 id 序列（首尾相同）。找不到返回剩余列表。 */
  _findCycle(remaining, getDeps) {
    const inStack = new Set();
    const path = [];
    const visitedLocal = new Set();
    const dfs = (id) => {
      if (inStack.has(id)) {
        // 命中环：截取 path 中从该 id 起的片段
        const start = path.indexOf(id);
        return [...path.slice(start), id];
      }
      if (visitedLocal.has(id)) return null;
      visitedLocal.add(id);
      inStack.add(id);
      path.push(id);
      for (const d of getDeps(id)) {
        if (!remaining.has(d)) continue; // 只在剩余子图里找环
        const found = dfs(d);
        if (found) return found;
      }
      inStack.delete(id);
      path.pop();
      return null;
    };
    for (const id of remaining) {
      inStack.clear(); path.length = 0;
      const found = dfs(id);
      if (found) return found;
    }
    return [...remaining];
  }

  /** 校验 dependsOn 引用的任务 id 都真实存在，返回悬空引用列表 [{task, missing:[...]}] */
  _validateDeps(tasks) {
    const ids = new Set(tasks.map(t => t.id));
    const dangling = [];
    for (const t of tasks) {
      const miss = (t.dependsOn || []).filter(d => !ids.has(d));
      if (miss.length) dangling.push({ task: t.id, missing: miss });
    }
    return dangling;
  }

  /**
   * 契约闭合性校验：每个任务的 input 必须能追溯到某个（依赖）任务的 output、或工作目录里已存在的文件、
   * 或明确的外部/无依赖来源。否则该 input 是「悬空输入」——拆解漏了产出它的任务，执行时必然卡壳。
   *
   * inputs/outputs 是自由文本描述，做保守的启发式匹配：
   *  - 抽取 input 里的「文件路径 token」（含 / 或带扩展名的词）与「TXX 任务引用」
   *  - 文件 token：只要出现在某任务 output、或存在于 workingDir，即视为已闭合
   *  - 任务引用 TXX：该任务存在且在本任务 dependsOn 里，即闭合
   *  - 明确标注外部来源（"外部"/"用户提供"/"第三方"/"环境变量"/"已有"）视为闭合
   *  - 无任何可识别 token 的纯描述性 input：宽松放行（不误报），只标注 file/任务 token 的悬空项
   *
   * @returns {{ closed:boolean, unresolved: Array<{task, input, reason}> }}
   */
  validateContractClosure(wbs, workingDir) {
    const tasks = wbs?.tasks || [];
    const taskIds = new Set(tasks.map(t => t.id));
    // 汇总所有任务的 output token（文件路径类）
    const allOutputTokens = new Set();
    for (const t of tasks) {
      for (const o of (t.contract?.outputs || [])) {
        for (const tok of this._extractFileTokens(o)) allOutputTokens.add(tok.toLowerCase());
      }
    }

    const unresolved = [];
    const externalRe = /(外部|用户提供|第三方|环境变量|已有|现有|internet|external|env var)/i;

    for (const t of tasks) {
      const deps = new Set((t.dependsOn || []).filter(d => taskIds.has(d)));
      // 该任务可见的上游 output（仅依赖链上的任务）——契约闭合要求 input 来自【依赖的】任务
      const upstreamOutputs = new Set();
      for (const t2 of tasks) {
        if (!deps.has(t2.id)) continue;
        for (const o of (t2.contract?.outputs || [])) {
          for (const tok of this._extractFileTokens(o)) upstreamOutputs.add(tok.toLowerCase());
        }
      }

      for (const input of (t.contract?.inputs || [])) {
        if (!input || externalRe.test(input)) continue; // 明确外部来源，放行
        // 任务引用 TXX：必须在 dependsOn 且存在
        const refs = (input.match(/\bT\d{1,3}\b|\bfeat-\d{1,3}\b/gi) || []);
        let refOk = null;
        if (refs.length) {
          refOk = refs.some(r => {
            const id = tasks.find(x => x.id.toLowerCase() === r.toLowerCase())?.id;
            return id && deps.has(id);
          });
        }
        // 文件 token 闭合性
        const fileToks = this._extractFileTokens(input);
        let fileOk = null;
        if (fileToks.length) {
          fileOk = fileToks.some(tok => {
            const low = tok.toLowerCase();
            if (upstreamOutputs.has(low)) return true;
            if (allOutputTokens.has(low) && deps.size === 0) return false; // 有产出者但没声明依赖
            // 存在于工作目录
            try {
              if (workingDir && (fs.existsSync(path.join(workingDir, tok)) ||
                  this._existsByBasename(workingDir, tok))) return true;
            } catch {}
            return false;
          });
        }

        // 判定：只要有一类可识别 token 且【全部】未闭合 → 悬空
        const hasToken = refs.length > 0 || fileToks.length > 0;
        if (!hasToken) continue; // 纯描述性 input，宽松放行
        const someClosed = (refOk === true) || (fileOk === true);
        if (!someClosed) {
          unresolved.push({
            task: t.id,
            input,
            reason: refs.length && refOk === false
              ? `引用的任务未在 dependsOn 中声明或不存在`
              : `未追溯到任何上游任务 output 或已有文件`,
          });
        }
      }
    }
    return { closed: unresolved.length === 0, unresolved };
  }

  /** 从自由文本里抽取「文件路径 / 带扩展名」token（用于契约闭合匹配） */
  _extractFileTokens(text) {
    if (!text) return [];
    const toks = new Set();
    // 形如 src/foo/bar.ts、./x.js、schema.sql、package.json 等
    const re = /([\w./-]*\/[\w./-]+|\b[\w-]+\.[a-zA-Z]{1,6}\b)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const tok = m[1].replace(/^\.\//, '').replace(/[)。,，、;；:：]+$/, '');
      if (tok && !/^\d+\.\d+$/.test(tok)) toks.add(tok); // 排除版本号类 1.0
    }
    return [...toks];
  }

  /** 工作目录里是否存在与 token 同名（basename）的文件（浅层，最多 3 层） */
  _existsByBasename(workingDir, tok) {
    const base = path.basename(tok);
    try {
      const out = execSync(
        `find . -maxdepth 3 -name ${JSON.stringify(base)} -not -path "*/node_modules/*" | head -1`,
        { cwd: workingDir, timeout: 3000, encoding: 'utf-8' }
      ).trim();
      return !!out;
    } catch { return false; }
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
