import { spawn } from 'child_process';
import os from 'os';

class SleepPreventionService {
  constructor() {
    this.caffeinateProcess = null;
    this.enabled = false;
    this.reason = '';
    this.activeSessionCount = 0;
  }

  get isActive() {
    return this.caffeinateProcess !== null && !this.caffeinateProcess.killed;
  }

  get status() {
    return {
      supported: os.platform() === 'darwin',
      active: this.isActive,
      enabled: this.enabled,
      reason: this.reason,
      activeSessionCount: this.activeSessionCount,
      pid: this.caffeinateProcess?.pid || null
    };
  }

  prevent(reason = '') {
    if (os.platform() !== 'darwin') return;
    if (this.isActive) return;

    try {
      // -d: 阻止显示器休眠（可选）
      // -i: 阻止系统空闲休眠
      // -s: 阻止系统休眠（包括合盖）
      this.caffeinateProcess = spawn('caffeinate', ['-dis'], {
        stdio: 'ignore',
        detached: false
      });

      this.caffeinateProcess.on('error', (err) => {
        console.error('[SleepPrevention] caffeinate 启动失败:', err.message);
        this.caffeinateProcess = null;
      });

      this.caffeinateProcess.on('exit', (code) => {
        console.log(`[SleepPrevention] caffeinate 退出 (code=${code})`);
        this.caffeinateProcess = null;
      });

      this.enabled = true;
      this.reason = reason;
      console.log(`[SleepPrevention] 已阻止休眠 (pid=${this.caffeinateProcess.pid}, 原因: ${reason})`);
    } catch (err) {
      console.error('[SleepPrevention] 启动失败:', err.message);
    }
  }

  release() {
    if (!this.caffeinateProcess) return;

    try {
      this.caffeinateProcess.kill('SIGTERM');
    } catch {}

    this.caffeinateProcess = null;
    this.enabled = false;
    this.reason = '';
    console.log('[SleepPrevention] 已释放休眠阻止');
  }

  update(sessions) {
    if (os.platform() !== 'darwin') return;

    // 统计有活跃 claude 进程的会话数
    let activeCount = 0;
    for (const session of sessions) {
      const content = session.getScreenContent?.() || '';
      const isRunning = /esc to interrupt|Cogitat|Brew|Bak|Wrangl|Form|Work/i.test(content);
      if (isRunning) activeCount++;
    }

    this.activeSessionCount = activeCount;

    if (activeCount > 0 && !this.isActive) {
      this.prevent(`${activeCount} 个会话运行中`);
    } else if (activeCount === 0 && this.isActive) {
      this.release();
    } else if (activeCount > 0 && this.isActive) {
      this.reason = `${activeCount} 个会话运行中`;
    }
  }

  destroy() {
    this.release();
  }
}

export default new SleepPreventionService();