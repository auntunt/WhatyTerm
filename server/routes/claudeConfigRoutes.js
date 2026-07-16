import { Router } from 'express';
import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import os from 'os';
import path from 'path';
import { getAllProviders, CLAUDE_PROVIDER_PRIORITY, loadProviderPriority } from '../services/ProviderHelper.js';

/**
 * createClaudeConfigRouter
 * @param {object} deps
 * @param {object} deps.providerHelper  - createProviderHelper(...) 实例，含 getCurrentProvider
 * @param {object} deps.sessionManager
 * @param {object} deps.io              - Socket.IO server 实例
 */
export function createClaudeConfigRouter({ providerHelper, sessionManager, io }) {
  const router = Router();
  const { getCurrentProvider } = providerHelper;

  // POST /api/claude-code/config
  // 同步全局 Claude Code 配置到项目级别 settings.local.json
  router.post('/config', async (req, res) => {
    try {
      const { projectPath } = req.body;
      if (!projectPath) {
        return res.status(400).json({ error: '必须指定项目路径，不允许修改全局配置' });
      }

      const globalConfigPath = join(os.homedir(), '.claude', 'settings.json');
      if (!existsSync(globalConfigPath)) {
        return res.status(400).json({ error: '全局配置文件不存在: ~/.claude/settings.json' });
      }

      let globalConfig;
      try {
        globalConfig = JSON.parse(readFileSync(globalConfigPath, 'utf-8'));
      } catch (e) {
        return res.status(400).json({ error: '读取全局配置失败: ' + e.message });
      }

      let dbEnv = {};
      try {
        const db = new Database(path.join(os.homedir(), '.cc-switch', 'cc-switch.db'), { readonly: true });
        const row = db.prepare("SELECT settings_config FROM providers WHERE app_type='claude' AND is_current=1").get();
        db.close();
        if (row) {
          const sc = JSON.parse(row.settings_config);
          if (sc.env && Object.keys(sc.env).length > 0) dbEnv = sc.env;
        }
      } catch {
        console.log('[Claude Code Config] 读取 CC Switch DB 失败，使用全局配置');
      }

      const mergedEnv = Object.keys(dbEnv).length > 0 ? dbEnv : (globalConfig.env || {});
      const isOAuth = !mergedEnv.ANTHROPIC_BASE_URL;

      const projectClaudeDir = join(projectPath, '.claude');
      if (!existsSync(projectClaudeDir)) mkdirSync(projectClaudeDir, { recursive: true });

      const configPath = join(projectClaudeDir, 'settings.local.json');
      let config = {};
      if (existsSync(configPath)) {
        try { config = JSON.parse(readFileSync(configPath, 'utf-8')); }
        catch (e) { console.error('[Claude Code Config] 读取项目配置失败:', e.message); }
      }

      const localPermissions = config.permissions;

      if (isOAuth) {
        config.env = {};
        config._localProvider = 'oauth';
      } else {
        config.env = { ...mergedEnv };
        config._localProvider = 'relay';
      }

      if (globalConfig.model) config.model = globalConfig.model;
      if (globalConfig.alwaysThinkingEnabled !== undefined) config.alwaysThinkingEnabled = globalConfig.alwaysThinkingEnabled;
      if (globalConfig.CLAUDE_CODE_MAX_OUTPUT_TOKENS !== undefined) config.CLAUDE_CODE_MAX_OUTPUT_TOKENS = globalConfig.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
      if (globalConfig.MAX_THINKING_TOKENS !== undefined) config.MAX_THINKING_TOKENS = globalConfig.MAX_THINKING_TOKENS;
      if (globalConfig.maxContextTokens !== undefined) config.maxContextTokens = globalConfig.maxContextTokens;
      if (globalConfig.enabledPlugins) config.enabledPlugins = { ...globalConfig.enabledPlugins };

      if (localPermissions || globalConfig.permissions) {
        config.permissions = {
          allow: [...(localPermissions?.allow || []), ...(globalConfig.permissions?.allow || [])].filter((v, i, a) => a.indexOf(v) === i),
          deny:  [...(localPermissions?.deny  || []), ...(globalConfig.permissions?.deny  || [])].filter((v, i, a) => a.indexOf(v) === i),
          ask:   [...(localPermissions?.ask   || []), ...(globalConfig.permissions?.ask   || [])].filter((v, i, a) => a.indexOf(v) === i),
        };
      }

      writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`[Claude Code Config] 已同步全局配置到项目: ${configPath}`);

      const provider = await getCurrentProvider('claude', projectPath);
      console.log(`[Claude Code Config] 新的供应商信息: configSource=${provider.configSource}`);

      for (const sessionData of sessionManager.listSessions()) {
        const session = sessionManager.getSession(sessionData.id);
        if (session && session.workingDir === projectPath) {
          session.claudeProvider = provider;
          sessionManager.updateSession(session);
          io.emit('session:updated', { id: session.id, claudeProvider: provider });
          console.log(`[Claude Code Config] 已更新会话 ${session.name} 的供应商信息`);
        }
      }
      io.emit('sessions:updated', sessionManager.listSessions());
      res.json({ success: true, path: configPath, provider });
    } catch (err) {
      console.error('[Claude Code Config] 同步失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /api/claude-code/config/local
  router.delete('/config/local', async (req, res) => {
    try {
      const { projectPath } = req.body;
      if (!projectPath) return res.status(400).json({ error: '缺少 projectPath 参数' });

      const localConfigPath = join(projectPath, '.claude', 'settings.local.json');
      if (!existsSync(localConfigPath)) {
        return res.json({ success: true, message: '本地配置文件不存在，已使用全局配置' });
      }

      unlinkSync(localConfigPath);
      console.log('[Claude Code Config] 已删除本地配置:', localConfigPath);

      const provider = await getCurrentProvider('claude', projectPath);
      console.log(`[Claude Code Config] 删除后的供应商信息: configSource=${provider.configSource}`);

      for (const sessionData of sessionManager.listSessions()) {
        const session = sessionManager.getSession(sessionData.id);
        if (session && session.workingDir === projectPath) {
          session.claudeProvider = provider;
          sessionManager.updateSession(session);
          io.emit('session:updated', { id: session.id, claudeProvider: provider });
          console.log(`[Claude Code Config] 已更新会话 ${session.name} 的供应商信息`);
        }
      }
      io.emit('sessions:updated', sessionManager.listSessions());
      res.json({ success: true, message: '已删除本地配置，恢复使用全局配置', provider });
    } catch (err) {
      console.error('[Claude Code Config] 删除本地配置失败:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/claude-code/config
  router.get('/config', (req, res) => {
    try {
      const configPath = join(os.homedir(), '.claude', 'settings.json');
      if (!existsSync(configPath)) return res.json({ exists: false });
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      res.json({
        exists: true,
        apiUrl: config.env?.ANTHROPIC_BASE_URL || '',
        apiKey: config.env?.ANTHROPIC_AUTH_TOKEN ? '***已配置***' : '',
        path: configPath,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * createProviderPriorityRouter
 * @param {object} deps
 * @param {object} deps.PRIORITY_LIST  - CLAUDE_PROVIDER_PRIORITY 数组引用
 */
export function createProviderPriorityRouter({ PRIORITY_LIST }) {
  const router = Router();

  // GET /api/provider-priority
  router.get('/', async (req, res) => {
    try {
      const providers = await getAllProviders('claude');
      const configPath = path.join(os.homedir(), '.webtmux', 'provider-priority.json');
      let priority = [...PRIORITY_LIST];
      if (existsSync(configPath)) {
        try {
          const config = JSON.parse(readFileSync(configPath, 'utf8'));
          priority = config.claude || priority;
        } catch (e) {
          console.error('[ProviderPriority] 读取配置失败:', e);
        }
      }
      res.json({ success: true, providers: providers.map(p => ({ id: p.id, name: p.name })), priority });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/provider-priority
  router.post('/', (req, res) => {
    try {
      const { priority } = req.body;
      if (!Array.isArray(priority)) {
        return res.status(400).json({ error: '优先级必须是数组' });
      }
      const configDir = path.join(os.homedir(), '.webtmux');
      const configPath = path.join(configDir, 'provider-priority.json');
      if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify({ claude: priority, updatedAt: new Date().toISOString() }, null, 2));
      PRIORITY_LIST.length = 0;
      PRIORITY_LIST.push(...priority);
      console.log('[ProviderPriority] 已保存供应商优先级:', priority);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
