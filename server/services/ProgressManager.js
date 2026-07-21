/**
 * ProgressManager - Harness 结构化进度追踪
 * 管理 ~/.webtmux/sessions/{sessionId}/progress.json
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

const WEBTMUX_DIR = path.join(os.homedir(), '.webtmux', 'sessions');

class ProgressManager {

  /** 获取 progress.json 路径 */
  getProgressPath(sessionId) {
    return path.join(WEBTMUX_DIR, sessionId, 'progress.json');
  }

  /** 确保目录存在 */
  _ensureDir(sessionId) {
    const dir = path.join(WEBTMUX_DIR, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 读取 progress.json，不存在返回 null */
  loadProgress(sessionId) {
    try {
      const filePath = this.getProgressPath(sessionId);
      if (!fs.existsSync(filePath)) return null;
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error(`[ProgressManager] 读取失败:`, err.message);
      return null;
    }
  }

  /** 原子写入 progress.json */
  saveProgress(sessionId, data) {
    try {
      this._ensureDir(sessionId);
      data.updatedAt = new Date().toISOString();
      const filePath = this.getProgressPath(sessionId);
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch (err) {
      console.error(`[ProgressManager] 写入失败:`, err.message);
      return false;
    }
  }

  /** 创建初始 progress（status: planning） */
  createProgress(sessionId, goal) {
    const data = {
      version: '1.1',
      sessionId,
      goal,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'planning',
      mode: 'interactive',        // 'interactive' | 'autonomous'（Ralph 自主模式）
      currentFeatureIndex: 0,
      sprint: null,
      features: [],
      patterns: [],               // Codebase Patterns（跨迭代学习，Ralph）
      archive: [],                // 归档历史（已完成轮次）
      evaluatorConfig: { enabled: false, strictMode: false }
    };
    this.saveProgress(sessionId, data);
    return data;
  }

  /** 设置 features（Planner 生成后调用） */
  setFeatures(sessionId, features, sprintContract) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    progress.features = features.map((f, i) => {
      const isCompleted = f.status === 'completed';
      return {
        id: f.id || `feat-${String(i + 1).padStart(3, '0')}`,
        name: f.name,
        description: f.description || '',
        priority: f.priority || i + 1,
        status: isCompleted ? 'completed' : 'pending',
        // Ralph 任务模型扩展字段
        acceptanceCriteria: Array.isArray(f.acceptanceCriteria) ? f.acceptanceCriteria : [],
        dependsOn: Array.isArray(f.dependsOn) ? f.dependsOn : [],
        branch: f.branch || '',
        retryCount: 0,
        blocked: false,
        validationNotes: '',
        passes: {
          implemented: isCompleted,
          compiles: isCompleted,
          tested: isCompleted
        },
        startedAt: isCompleted ? new Date().toISOString() : null,
        completedAt: isCompleted ? new Date().toISOString() : null,
        evaluations: []
      };
    });
    progress.sprint = {
      name: 'Sprint 1',
      startedAt: new Date().toISOString(),
      completionCriteria: sprintContract || '所有 feature 完成'
    };
    progress.status = 'in_progress';
    progress.currentFeatureIndex = 0;
    return this.saveProgress(sessionId, progress);
  }

  /** 更新单个 feature 状态 */
  updateFeatureStatus(sessionId, featureId, updates) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    Object.assign(feature, updates);
    if (updates.status === 'in_progress' && !feature.startedAt) {
      feature.startedAt = new Date().toISOString();
    }
    if (updates.status === 'completed') {
      feature.completedAt = new Date().toISOString();
    }
    return this.saveProgress(sessionId, progress);
  }

  /** 获取当前正在进行的 feature */
  getCurrentFeature(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress?.features?.length) return null;
    // 优先返回 in_progress 的
    const active = progress.features.find(f => f.status === 'in_progress');
    if (active) return active;
    // 否则返回第一个 pending 的
    return progress.features.find(f => f.status === 'pending') || null;
  }

  /** 推进到下一个 feature，返回下一个 feature 或 null */
  advanceToNext(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return null;
    const nextFeature = progress.features.find(f => f.status === 'pending');
    if (!nextFeature) {
      progress.status = 'completed';
      this.saveProgress(sessionId, progress);
      return null;
    }
    nextFeature.status = 'in_progress';
    nextFeature.startedAt = new Date().toISOString();
    progress.currentFeatureIndex = progress.features.indexOf(nextFeature);
    this.saveProgress(sessionId, progress);
    return nextFeature;
  }

  /** 添加评估记录 */
  addEvaluation(sessionId, featureId, evalResult) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    if (!Array.isArray(feature.evaluations)) feature.evaluations = [];
    feature.evaluations.push({
      timestamp: new Date().toISOString(),
      passed: evalResult.passed,
      confidence: evalResult.confidence || 0,
      summary: evalResult.feedback || ''
    });
    return this.saveProgress(sessionId, progress);
  }

  /** 检查是否所有 feature 都已完成 */
  isAllCompleted(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress?.features?.length) return false;
    return progress.features.every(f => f.status === 'completed');
  }

  /** 获取进度摘要 */
  getSummary(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return null;
    const total = progress.features.length;
    const completed = progress.features.filter(f => f.status === 'completed').length;
    const current = this.getCurrentFeature(sessionId);
    return {
      total, completed,
      percent: total > 0 ? Math.round(completed / total * 100) : 0,
      status: progress.status,
      currentFeature: current?.name || null
    };
  }

  /** 清理会话进度文件 */
  deleteProgress(sessionId) {
    try {
      const dir = path.join(WEBTMUX_DIR, sessionId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true });
      }
    } catch (err) {
      console.error(`[ProgressManager] 删除失败:`, err.message);
    }
  }

  // ───────── Ralph 自主模式扩展方法 ─────────

  /** 设置运行模式 'interactive' | 'autonomous' */
  setMode(sessionId, mode) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    progress.mode = mode;
    return this.saveProgress(sessionId, progress);
  }

  /** 取下一个可执行任务：非 blocked、非 completed、依赖已满足，按 priority 排序 */
  getNextTask(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress?.features?.length) return null;
    const doneIds = new Set(progress.features.filter(f => f.status === 'completed').map(f => f.id));
    const candidates = progress.features
      .filter(f => f.status !== 'completed' && !f.blocked)
      .filter(f => (f.dependsOn || []).every(d => doneIds.has(d)))
      .sort((a, b) => (a.priority || 999) - (b.priority || 999));
    return candidates[0] || null;
  }

  /** 验证失败：retryCount+1，记录原因，满 maxRetry 标记 blocked。返回 { blocked, retryCount } */
  recordValidationFailure(sessionId, featureId, notes, maxRetry = 5) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return null;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return null;
    feature.retryCount = (feature.retryCount || 0) + 1;
    feature.validationNotes = notes || '';
    feature.status = 'pending';
    if (feature.retryCount >= maxRetry) {
      feature.blocked = true;
    }
    this.saveProgress(sessionId, progress);
    return { blocked: feature.blocked, retryCount: feature.retryCount };
  }

  // ───────── Stage 4：blocked 任务人工介入 ─────────

  /** 跳过任务：标记为 completed 但记 skipped 标志（不再阻塞后续依赖），或彻底排除。
   * @param {string} mode 'skip'（当完成跳过，解锁下游）| 'exclude'（排除，保持 blocked 不解锁）
   */
  skipTask(sessionId, featureId, mode = 'skip') {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    if (mode === 'exclude') {
      feature.blocked = true;
      feature.status = 'pending';
      feature.skipped = false;
      feature.excluded = true;
    } else {
      // 当作完成跳过：下游依赖可继续（getNextTask 用 completed 判定依赖满足）
      feature.status = 'completed';
      feature.blocked = false;
      feature.skipped = true;
    }
    return this.saveProgress(sessionId, progress);
  }

  /** 解除阻塞并重试：清 blocked、retryCount 归零、status=pending，使其重新进入调度。 */
  unblockAndRetry(sessionId, featureId) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    feature.blocked = false;
    feature.excluded = false;
    feature.skipped = false;
    feature.retryCount = 0;
    feature.status = 'pending';
    return this.saveProgress(sessionId, progress);
  }

  /** 修改任务需求/验收标准（人工介入改需求后再重试）。传入字段才更新。 */
  updateTaskRequirement(sessionId, featureId, { name, description, acceptanceCriteria } = {}) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    const feature = progress.features.find(f => f.id === featureId);
    if (!feature) return false;
    if (typeof name === 'string' && name.trim()) feature.name = name.trim();
    if (typeof description === 'string') feature.description = description;
    if (Array.isArray(acceptanceCriteria)) feature.acceptanceCriteria = acceptanceCriteria;
    return this.saveProgress(sessionId, progress);
  }

  /** 失败快照目录 */
  _snapshotDir(sessionId) {
    return path.join(WEBTMUX_DIR, sessionId, 'snapshots');
  }

  /** 保存失败快照：worktree/工作区 diff + Validator 全文，供事后诊断。 */
  saveFailureSnapshot(sessionId, featureId, { diff = '', validatorOutput = '', reason = '' } = {}) {
    try {
      const dir = this._snapshotDir(sessionId);
      fs.mkdirSync(dir, { recursive: true });
      const snap = {
        featureId,
        reason,
        diff: (diff || '').slice(0, 200000),
        validatorOutput: (validatorOutput || '').slice(0, 200000),
        savedAt: new Date().toISOString(),
      };
      const safeId = String(featureId).replace(/[^a-zA-Z0-9._-]/g, '_');
      fs.writeFileSync(path.join(dir, `${safeId}.json`), JSON.stringify(snap, null, 2), 'utf-8');
      // 在 feature 上打标记，便于前端知道有快照可看
      const progress = this.loadProgress(sessionId);
      if (progress) {
        const feature = progress.features.find(f => f.id === featureId);
        if (feature) { feature.hasSnapshot = true; this.saveProgress(sessionId, progress); }
      }
      return true;
    } catch (err) {
      console.error('[ProgressManager] 保存失败快照失败:', err.message);
      return false;
    }
  }

  /** 读取失败快照 */
  getFailureSnapshot(sessionId, featureId) {
    try {
      const safeId = String(featureId).replace(/[^a-zA-Z0-9._-]/g, '_');
      const file = path.join(this._snapshotDir(sessionId), `${safeId}.json`);
      if (!fs.existsSync(file)) return null;
      return JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      return null;
    }
  }

  /** 追加一条 Codebase Pattern（去重） */
  addPattern(sessionId, pattern) {
    if (!pattern) return false;
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    if (!Array.isArray(progress.patterns)) progress.patterns = [];
    if (!progress.patterns.includes(pattern)) {
      progress.patterns.push(pattern);
    }
    return this.saveProgress(sessionId, progress);
  }

  /** 是否还有可执行任务 */
  hasRunnableTask(sessionId) {
    return this.getNextTask(sessionId) !== null;
  }

  /** 归档当前轮次（features + patterns），重置 features 供新一轮拆分 */
  archiveRound(sessionId) {
    const progress = this.loadProgress(sessionId);
    if (!progress) return false;
    if (!Array.isArray(progress.archive)) progress.archive = [];
    if (progress.features.length > 0) {
      progress.archive.push({
        archivedAt: new Date().toISOString(),
        goal: progress.goal,
        features: progress.features,
        patterns: progress.patterns || []
      });
    }
    progress.features = [];
    progress.patterns = [];
    progress.status = 'planning';
    progress.currentFeatureIndex = 0;
    return this.saveProgress(sessionId, progress);
  }
}

const progressManager = new ProgressManager();
export default progressManager;
