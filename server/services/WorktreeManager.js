/**
 * Required Notice: Copyright (c) 2025 WhatyTerm (https://whatyterm.whaty.org)
 * SPDX-License-Identifier: LicenseRef-PolyForm-Noncommercial-1.0.0
 * 本文件按 PolyForm Noncommercial 1.0.0 授权（见根目录 LICENSE）：
 * 非商业用途免费；商业用途需商业许可（见 LICENSE-COMMERCIAL）。
 *
 * WorktreeManager —「自主版 Orca」扇出的隔离层
 *
 * 一个任务开 N 个 git worktree：每个候选拿到独立的目录 + 独立分支，从同一 base 分支切出。
 * 候选各自在自己的目录里改代码、提交（互不踩踏）；跑完由引擎挑赢家，把赢家分支 merge 回 base，
 * 其余 worktree 与分支清理丢弃。
 *
 * 用 execFile（非 shell 拼接）执行 git，避免命令注入；所有路径/分支名做白名单清洗。
 */

import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** 分支/标签名清洗：只留 git 允许且安全的字符 */
function sanitizeRef(s) {
  return String(s || '').replace(/[^a-zA-Z0-9/_.-]/g, '-').replace(/^[-/]+/, '') || 'x';
}

export class WorktreeManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.timeout=60000] 单条 git 命令超时（大仓库 worktree add/merge 可能较慢）
   * @param {(msg:string)=>void} [opts.log] 日志回调
   */
  constructor(opts = {}) {
    this.timeout = opts.timeout || 60 * 1000;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
  }

  /** 在指定仓库目录跑一条 git 命令，返回 { code, stdout, stderr } */
  _git(cwd, args) {
    return new Promise((resolve) => {
      execFile('git', args, { cwd, encoding: 'utf-8', timeout: this.timeout, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolve({
            code: err ? (err.code ?? 1) : 0,
            stdout: stdout || '',
            stderr: stderr || (err ? err.message : ''),
          });
        });
    });
  }

  /** 是否是 git 仓库 */
  async isGitRepo(dir) {
    if (!dir || !fs.existsSync(dir)) return false;
    const r = await this._git(dir, ['rev-parse', '--is-inside-work-tree']);
    return r.code === 0 && /true/.test(r.stdout);
  }

  /** 获取当前分支名（detached 时返回 null） */
  async currentBranch(dir) {
    const r = await this._git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const name = r.stdout.trim();
    return (r.code === 0 && name && name !== 'HEAD') ? name : null;
  }

  /**
   * 为一个任务创建 N 个 worktree。
   * @param {string} baseDir 主仓库（会话工作目录）
   * @param {object} cfg { count, tag, baseBranch }
   *   baseBranch 未指定时用 baseDir 的当前分支；再兜底为 HEAD。
   * @returns {Promise<{ ok:boolean, error?:string, baseBranch?:string, root?:string, worktrees?:Array<{index,dir,branch}> }>}
   */
  async createWorktrees(baseDir, cfg = {}) {
    const count = Math.max(1, Math.min(8, cfg.count || 1));
    const tag = sanitizeRef(cfg.tag || Date.now().toString(36));

    if (!(await this.isGitRepo(baseDir))) {
      return { ok: false, error: `不是 git 仓库: ${baseDir}` };
    }
    // base 分支：优先显式指定 → 当前分支 → HEAD（detached 也能切出新分支）
    let baseBranch = cfg.baseBranch ? sanitizeRef(cfg.baseBranch) : (await this.currentBranch(baseDir));
    const baseRef = baseBranch || 'HEAD';

    // worktree 根目录放到 os.tmpdir，避免污染项目内部（也不会被 base 分支的 git status 看见）
    const root = path.join(os.tmpdir(), 'webtmux-fanout', tag);
    try { fs.mkdirSync(root, { recursive: true }); } catch {}

    const worktrees = [];
    for (let i = 0; i < count; i++) {
      const branch = `fanout/${tag}/c${i}`;
      const dir = path.join(root, `c${i}`);
      // -b 新建分支并检出到 dir，从 baseRef 起点
      const r = await this._git(baseDir, ['worktree', 'add', '-b', branch, dir, baseRef]);
      if (r.code !== 0) {
        this.log(`worktree add 失败(c${i}): ${r.stderr.trim().slice(0, 200)}`);
        // 回滚已建的 worktree
        await this.cleanup(baseDir, { worktrees });
        return { ok: false, error: `git worktree add 失败: ${r.stderr.trim().slice(0, 200)}` };
      }
      worktrees.push({ index: i, dir, branch });
      this.log(`创建候选 c${i}: ${dir} (分支 ${branch})`);
    }
    return { ok: true, baseBranch: baseBranch || null, baseRef, root, worktrees };
  }

  /**
   * 把赢家候选的分支 merge 回 base 分支（在 baseDir 上执行）。
   * 赢家候选已在自己的 worktree 里 commit，其提交挂在自己的分支上；这里 no-ff merge 进来。
   * @returns {Promise<{ ok:boolean, error?:string }>}
   */
  async mergeWinner(baseDir, winnerBranch) {
    const branch = sanitizeRef(winnerBranch);
    const r = await this._git(baseDir, ['merge', '--no-ff', '--no-edit', branch]);
    if (r.code !== 0) {
      // 冲突/失败：中止 merge，保持 base 干净
      await this._git(baseDir, ['merge', '--abort']);
      return { ok: false, error: `merge 失败: ${(r.stderr || r.stdout).trim().slice(0, 300)}` };
    }
    return { ok: true };
  }

  /**
   * 清理：移除所有 worktree 目录，删除候选分支（keepBranch 除外）。
   * 幂等、尽力而为——单个失败不阻断其余清理。
   * @param {string} baseDir
   * @param {object} info { worktrees, root, keepBranch }
   */
  async cleanup(baseDir, info = {}) {
    const worktrees = info.worktrees || [];
    for (const wt of worktrees) {
      // 优先用 git worktree remove（git>=2.17）；旧版 git 无此子命令会报 usage 错误，
      // 此时直接删目录 + prune 兜底（兼容 git 2.15 等）。
      const r = await this._git(baseDir, ['worktree', 'remove', '--force', wt.dir]);
      if (r.code !== 0) {
        try { fs.rmSync(wt.dir, { recursive: true, force: true }); } catch {}
      }
    }
    // prune 掉残留登记（删目录后必须 prune，git 才认为该 worktree 已释放、允许删分支）
    try { await this._git(baseDir, ['worktree', 'prune']); } catch {}
    // 删除候选分支（保留赢家分支：其提交已 merge，可选保留做快照/审计）
    const keep = info.keepBranch ? sanitizeRef(info.keepBranch) : null;
    for (const wt of worktrees) {
      if (keep && wt.branch === keep) continue;
      try { await this._git(baseDir, ['branch', '-D', wt.branch]); } catch {}
    }
    // 删除 worktree 根目录
    if (info.root) {
      try { fs.rmSync(info.root, { recursive: true, force: true }); } catch {}
    }
  }

  /** 候选 worktree 里的改动摘要（供失败快照/审计） */
  async diffStat(dir, baseRef = 'HEAD') {
    const r = await this._git(dir, ['diff', '--stat', baseRef]);
    return r.stdout.trim();
  }

  /** 是否有未提交改动（含未跟踪文件） */
  async hasChanges(dir) {
    const r = await this._git(dir, ['status', '--porcelain']);
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  /**
   * 兜底把 worktree 里的全部改动提交到候选分支。
   * Developer 通常自己会 commit；但部分 CLI 可能忘了提交，导致赢家分支上没有改动、merge 空转。
   * 此方法在候选跑完后调用，确保工作成果落到分支上。返回 true=有新提交或本就干净。
   */
  async commitAll(dir, message) {
    if (!(await this.hasChanges(dir))) return false; // 无改动（可能 Developer 已自行提交）
    await this._git(dir, ['add', '-A']);
    const r = await this._git(dir, ['commit', '-m', message || 'fanout: candidate work', '--no-verify']);
    return r.code === 0;
  }

  /** 候选分支相对 base 是否有新提交（判断该候选是否真的产出了工作） */
  async hasCommitsAhead(dir, baseRef) {
    if (!baseRef) return true;
    const r = await this._git(dir, ['rev-list', '--count', `${baseRef}..HEAD`]);
    const n = parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) && n > 0;
  }
}

export default WorktreeManager;
