/**
 * ProviderHelper.js
 * getCurrentProvider / getAllProviders / CLAUDE_PROVIDER_PRIORITY 的独立模块。
 *
 * 重型运行时依赖（sessionManager、sessionRelay 等）通过 createProviderHelper(deps)
 * 工厂函数注入，避免循环依赖。
 *
 * 使用方式：
 *   import { createProviderHelper } from './services/ProviderHelper.js';
 *   const providerHelper = createProviderHelper({
 *     sessionManager, sessionRelay, maskApiKey,
 *     readClaudeProcessEnv, getClaudeProcStartEpoch,
 *     getTmuxPrefix, execAsync
 *   });
 *   const provider = await providerHelper.getCurrentProvider('claude', workingDir);
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import os from 'os';
import path from 'path';

// ── 优先级列表（模块级单例，可通过 loadProviderPriority() 刷新）──────
export const CLAUDE_PROVIDER_PRIORITY = [
  '88codepaid',
  'FoxCode',
];

/**
 * 从配置文件加载供应商优先级，更新 CLAUDE_PROVIDER_PRIORITY。
 * 在服务启动时调用一次即可。
 */
export function loadProviderPriority() {
  const configPath = path.join(os.homedir(), '.webtmux', 'provider-priority.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      if (config.claude && Array.isArray(config.claude)) {
        CLAUDE_PROVIDER_PRIORITY.length = 0;
        CLAUDE_PROVIDER_PRIORITY.push(...config.claude);
        console.log('[ProviderPriority] 已加载配置:', config.claude);
      }
    } catch (e) {
      console.error('[ProviderPriority] 加载配置失败:', e);
    }
  }
}

/**
 * 获取所有可用的供应商列表（用于自动切换）
 */
export function getAllProviders(appType) {
  const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (!existsSync(ccSwitchDbPath)) return [];
  try {
    const db = new Database(ccSwitchDbPath, { readonly: true });
    const rows = db.prepare('SELECT * FROM providers WHERE app_type = ?').all(appType);
    db.close();
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      settingsConfig: row.settings_config
    }));
  } catch (err) {
    console.error('[getAllProviders] 数据库读取失败:', err);
    return [];
  }
}

/**
 * 工厂函数：注入运行时重型依赖，返回包含 getCurrentProvider 的对象。
 *
 * @param {object} deps
 * @param {object} deps.sessionManager
 * @param {object} deps.sessionRelay
 * @param {Function} deps.maskApiKey
 * @param {Function} deps.readClaudeProcessEnv
 * @param {Function} deps.getClaudeProcStartEpoch
 * @param {Function} deps.getTmuxPrefix
 * @param {Function} deps.execAsync
 */
export function createProviderHelper({
  sessionManager,
  sessionRelay,
  maskApiKey,
  readClaudeProcessEnv,
  getClaudeProcStartEpoch,
  getTmuxPrefix,
  execAsync,
}) {
  // ── 内部辅助 ──────────────────────────────────────────────────────

  function _extractProviderUrl(config) {
    if (config.env?.ANTHROPIC_BASE_URL) return config.env.ANTHROPIC_BASE_URL;
    if (config.baseURL) return config.baseURL;
    if (config.config && typeof config.config === 'string') {
      const m = config.config.match(/base_url\s*=\s*"([^"]+)"/);
      if (m) return m[1];
    }
    return '';
  }

  function _findProviderName(url, rows) {
    if (!url || !rows) return '未知供应商';
    const normalizedUrl = url.replace(/\/+$/, '').replace(/\/v\d+$/, '');
    const matches = [];
    for (const row of rows) {
      try {
        if (row.settings_config) {
          const config = JSON.parse(row.settings_config);
          const providerUrl = _extractProviderUrl(config).replace(/\/+$/, '').replace(/\/v\d+$/, '');
          if (normalizedUrl === providerUrl) matches.push(row);
        }
      } catch {}
    }
    if (matches.length === 0) return '未知供应商';
    const cur = matches.find(r => r.is_current);
    return (cur || matches[0]).name || '未命名';
  }

  // ── getCurrentProvider ────────────────────────────────────────────

  function getCurrentProvider(appType, workingDir = null, tmuxSessionName = null) {
    return new Promise(async (resolve) => {
      const ccSwitchDbPath = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

      let actualApiUrl = '';
      let actualApiKey = '';
      let actualModel = '';
      let configSource = 'global';
      let localIsOAuth = false;
      let localProviderId = '';
      let relayInfo = null;

      let globalApiUrl = '';
      let globalApiKey = '';
      let globalModel = '';

      const readOAuthEmail = () => {
        if (appType !== 'claude') return '';
        try {
          const j = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
          return j.oauthAccount?.emailAddress || '';
        } catch { return ''; }
      };

      const computeApiType = () =>
        appType === 'gemini' ? 'gemini' : (appType === 'claude' ? 'claude' : 'openai');

      let _procStartEpoch = 0;
      if (appType === 'claude' && tmuxSessionName) {
        _procStartEpoch = await getClaudeProcStartEpoch(tmuxSessionName);
      }
      let _staleChecked = false, _globalStale = false;
      const isGlobalStale = () => {
        if (_staleChecked) return _globalStale;
        _staleChecked = true;
        if (!_procStartEpoch) return false;
        try {
          const sp = path.join(os.homedir(), '.claude', 'settings.json');
          const mtime = existsSync(sp) ? Math.floor(statSync(sp).mtimeMs / 1000) : 0;
          if (mtime && _procStartEpoch < mtime - 2) _globalStale = true;
        } catch {}
        return _globalStale;
      };

      const buildGlobalInfo = (rows) => {
        if (!globalApiUrl) return null;
        return {
          name: _findProviderName(globalApiUrl, rows),
          url: globalApiUrl,
          apiKey: maskApiKey(globalApiKey),
          model: globalModel
        };
      };

      const buildResult = (extras) => {
        const url = extras.url !== undefined ? extras.url : '';
        const isOAuth = !url && appType === 'claude' && !!extras.exists;
        const cs = extras.configSource || 'global';
        return {
          id: extras.id,
          name: extras.name,
          url,
          apiKey: extras.apiKey !== undefined ? extras.apiKey : maskApiKey(''),
          model: extras.model !== undefined ? extras.model : '',
          apiType: extras.apiType || computeApiType(),
          app: appType,
          exists: !!extras.exists,
          configSource: cs,
          isOAuth,
          oauthEmail: isOAuth ? readOAuthEmail() : '',
          stale: cs === 'global' && !!extras.exists ? isGlobalStale() : false,
          ...(relayInfo ? { relay: { ...(relayInfo.stats || {}), providerName: relayInfo.providerName } } : {}),
          ...(extras.globalConfig !== undefined ? { globalConfig: extras.globalConfig } : {})
        };
      };

      // ── appType 分支读取配置 ──────────────────────────────────────
      if (appType === 'claude') {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        if (existsSync(claudeSettingsPath)) {
          try {
            const settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8'));
            globalApiUrl = settings.env?.ANTHROPIC_BASE_URL || '';
            globalApiKey = settings.env?.ANTHROPIC_AUTH_TOKEN || settings.env?.ANTHROPIC_API_KEY || '';
            globalModel = settings.model || '';
          } catch (e) {
            console.error('[getCurrentProvider] 读取 Claude 全局配置失败:', e);
          }
        }

        if (workingDir) {
          const localConfigPath = path.join(workingDir, '.claude', 'settings.local.json');
          if (existsSync(localConfigPath)) {
            try {
              const localSettings = JSON.parse(readFileSync(localConfigPath, 'utf8'));
              if (localSettings.env?.ANTHROPIC_BASE_URL) {
                actualApiUrl = localSettings.env.ANTHROPIC_BASE_URL;
                actualApiKey = localSettings.env?.ANTHROPIC_AUTH_TOKEN || localSettings.env?.ANTHROPIC_API_KEY || '';
                actualModel = localSettings.model || '';
                configSource = 'local';
                if (localSettings._localProviderId) localProviderId = localSettings._localProviderId;
              } else if (localSettings._localProvider) {
                configSource = 'local';
                actualModel = localSettings.model || '';
                if (localSettings._localProvider === 'oauth') localIsOAuth = true;
              }
            } catch (e) {
              console.error('[getCurrentProvider] 读取项目本地配置失败:', e.message);
            }
          }
        }

        if (!actualApiUrl && configSource !== 'local') {
          actualApiUrl = globalApiUrl;
          actualApiKey = globalApiKey;
          actualModel = globalModel;
          configSource = 'global';
        } else if (!actualApiUrl && configSource === 'local') {
          actualApiUrl = globalApiUrl;
          actualApiKey = globalApiKey;
        }

        const procEnv = await readClaudeProcessEnv(tmuxSessionName);
        if (procEnv && procEnv.ANTHROPIC_BASE_URL) {
          const procUrl = procEnv.ANTHROPIC_BASE_URL.replace(/\/+$/, '');
          const settingsUrl = actualApiUrl.replace(/\/+$/, '');
          if (procUrl === settingsUrl) {
            actualApiKey = procEnv.ANTHROPIC_AUTH_TOKEN || procEnv.ANTHROPIC_API_KEY || actualApiKey;
            actualModel = procEnv.ANTHROPIC_MODEL || actualModel;
            configSource = 'process';
          } else if (!actualApiUrl) {
            actualApiUrl = procUrl;
            actualApiKey = procEnv.ANTHROPIC_AUTH_TOKEN || procEnv.ANTHROPIC_API_KEY || '';
            actualModel = procEnv.ANTHROPIC_MODEL || '';
            configSource = 'process';
          }
        }

        if (!actualApiUrl && tmuxSessionName) {
          try {
            const { stdout: paneContent } = await execAsync(
              `${getTmuxPrefix()} capture-pane -t "${tmuxSessionName}" -p -S -30 2>/dev/null`,
              { encoding: 'utf-8', timeout: 3000 }
            );
            const baseUrlMatch = paneContent.match(/Anthropic base URL:\s+(https?:\/\/\S+)/i);
            if (baseUrlMatch) {
              actualApiUrl = baseUrlMatch[1].replace(/\/+$/, '');
              configSource = 'process';
              console.log(`[getCurrentProvider] 从终端内容解析到 base URL: ${actualApiUrl}`);
            }
          } catch {}
        }

        // 实测覆盖（statusProbe / effectiveEnv）
        {
          const liveSession = (tmuxSessionName && sessionManager)
            ? (() => {
                const sd = sessionManager.listSessions().find(s => s.tmuxSessionName === tmuxSessionName);
                return sd ? sessionManager.getSession(sd.id) : null;
              })()
            : null;
          const he = liveSession?.effectiveEnv;
          const sp = liveSession?.statusProbe;

          if (sp && Date.now() - sp.at < 30 * 60 * 1000) {
            if (sp.baseUrl) {
              actualApiUrl = sp.baseUrl;
              localIsOAuth = false;
              configSource = 'status';
            } else if (sp.isOAuth) {
              actualApiUrl = '';
              actualApiKey = '';
              localIsOAuth = true;
              configSource = 'status';
            }
            if (sp.model) actualModel = sp.model;
          }

          if (he && he.baseUrl && configSource !== 'status') {
            actualApiUrl = he.baseUrl;
            if (he.tokenPrefix || he.keyPrefix) actualApiKey = he.tokenPrefix || he.keyPrefix;
            localIsOAuth = false;
            configSource = 'hook';
          }
          if (he && he.model && !actualModel) actualModel = he.model;
        }

        // relay 识别
        {
          const relayMatch = (actualApiUrl || '').match(/^https?:\/\/127\.0\.0\.1:\d+\/relay\/([^/\s]+)/);
          if (relayMatch) {
            const relayTarget = sessionRelay.get(relayMatch[1]);
            if (relayTarget) {
              actualApiUrl = relayTarget.url;
              actualApiKey = relayTarget.key || actualApiKey;
              configSource = 'relay';
              if (relayTarget.providerId) localProviderId = relayTarget.providerId;
              const relayStats = sessionRelay.getStats(relayMatch[1]);
              if (relayStats?.lastModel) actualModel = relayStats.lastModel;
              relayInfo = { stats: relayStats, providerName: relayTarget.providerName };
            } else {
              configSource = 'relay-lost';
            }
          }
        }

        // 兜底：服务进程 env
        if (!actualApiUrl && process.env.ANTHROPIC_BASE_URL) {
          let dbPointsToOAuth = false;
          try {
            const checkDb = new Database(ccSwitchDbPath, { readonly: true });
            const curRow = checkDb.prepare('SELECT settings_config FROM providers WHERE app_type = ? AND is_current = 1').get(appType);
            checkDb.close();
            if (curRow) {
              const curSc = JSON.parse(curRow.settings_config || '{}');
              dbPointsToOAuth = !!curSc.useOAuth || !curSc.env?.ANTHROPIC_BASE_URL;
            }
          } catch {}
          if (!dbPointsToOAuth) {
            actualApiUrl = process.env.ANTHROPIC_BASE_URL.replace(/\/+$/, '');
            actualApiKey = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || actualApiKey;
            configSource = 'process';
            console.log(`[getCurrentProvider] 从服务进程 env 获取 base URL: ${actualApiUrl}`);
          }
        }

      } else if (appType === 'codex') {
        const codexConfigPath = path.join(os.homedir(), '.codex', 'config.toml');
        const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json');
        if (existsSync(codexConfigPath)) {
          try {
            const toml = readFileSync(codexConfigPath, 'utf8');
            const urlMatch = toml.match(/base_url\s*=\s*"([^"]+)"/);
            const modelMatch = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
            globalApiUrl = urlMatch ? urlMatch[1] : '';
            globalModel = modelMatch ? modelMatch[1] : '';
          } catch (e) {
            console.error('[getCurrentProvider] 读取 Codex 配置失败:', e.message);
          }
        }
        if (existsSync(codexAuthPath)) {
          try {
            const auth = JSON.parse(readFileSync(codexAuthPath, 'utf8'));
            globalApiKey = auth.OPENAI_API_KEY || auth.CODEX_API_KEY || '';
          } catch {}
        }
        actualApiUrl = globalApiUrl;
        actualApiKey = globalApiKey;
        actualModel = globalModel;
        configSource = 'global';

      } else if (appType === 'grok') {
        let grokEmail = '', grokModel = 'grok-build', grokUrl = '';
        try {
          const grokAuthPath = path.join(os.homedir(), '.grok', 'auth.json');
          if (existsSync(grokAuthPath)) {
            const auth = JSON.parse(readFileSync(grokAuthPath, 'utf8'));
            for (const v of Object.values(auth)) {
              if (v && typeof v === 'object' && v.email) { grokEmail = v.email; break; }
            }
          }
        } catch (e) {
          console.error('[getCurrentProvider] 读取 Grok auth 失败:', e.message);
        }
        try {
          const grokModelsPath = path.join(os.homedir(), '.grok', 'models_cache.json');
          if (existsSync(grokModelsPath)) {
            const mc = JSON.parse(readFileSync(grokModelsPath, 'utf8'));
            const firstModel = mc.models ? Object.values(mc.models)[0] : null;
            if (firstModel?.info) {
              grokModel = firstModel.info.model || grokModel;
              grokUrl = firstModel.info.base_url || '';
            }
          }
        } catch {}
        return resolve({
          id: 'grok', name: 'Grok (xAI)', url: grokUrl,
          apiKey: maskApiKey(grokEmail), model: grokModel,
          apiType: 'grok', app: 'grok', exists: !!grokEmail,
          configSource: 'global', isOAuth: true, oauthEmail: grokEmail
        });
      }

      // ── CC Switch DB 查询 ─────────────────────────────────────────
      if (!existsSync(ccSwitchDbPath)) {
        return resolve(buildResult({
          name: actualApiUrl ? '未知供应商' : '未配置',
          url: actualApiUrl, apiKey: maskApiKey(actualApiKey),
          model: actualModel, exists: !!actualApiUrl, configSource,
          globalConfig: configSource === 'local' ? buildGlobalInfo(null) : null
        }));
      }

      try {
        const db = new Database(ccSwitchDbPath, { readonly: true });
        console.log(`[getCurrentProvider] appType=${appType}, actualApiUrl="${actualApiUrl}", configSource=${configSource}, workingDir=${workingDir}`);

        if (actualApiUrl) {
          const rows = db.prepare('SELECT * FROM providers WHERE app_type = ?').all(appType);
          db.close();
          const globalInfo = configSource === 'local' ? buildGlobalInfo(rows) : null;

          if (!rows || rows.length === 0) {
            return resolve(buildResult({
              name: '未知供应商', url: actualApiUrl, apiKey: maskApiKey(actualApiKey),
              model: actualModel, exists: true, configSource, globalConfig: globalInfo
            }));
          }

          const normalizeUrl = (u) => u.replace(/\/+$/, '').replace(/\/v\d+$/, '');
          const normalizedActual = normalizeUrl(actualApiUrl);
          let urlMatches = [];
          for (const row of rows) {
            try {
              if (row.settings_config) {
                const config = JSON.parse(row.settings_config);
                const providerUrl = normalizeUrl(_extractProviderUrl(config));
                if (normalizedActual === providerUrl) {
                  const providerKey = config.env?.ANTHROPIC_AUTH_TOKEN || config.env?.ANTHROPIC_API_KEY || config.auth?.OPENAI_API_KEY || '';
                  urlMatches.push({ row, keyMatch: providerKey === actualApiKey });
                }
              }
            } catch {}
          }

          if (urlMatches.length > 0) {
            const idMatch = localProviderId && urlMatches.find(m => m.row.id === localProviderId);
            const currentMatch = urlMatches.find(m => m.row.is_current);
            const exactMatch = urlMatches.find(m => m.keyMatch);
            const bestRow = (idMatch || currentMatch || exactMatch || urlMatches[0]).row;
            return resolve(buildResult({
              id: bestRow.id, name: bestRow.name || '未命名',
              url: actualApiUrl, apiKey: maskApiKey(actualApiKey),
              model: actualModel, exists: true, configSource, globalConfig: globalInfo
            }));
          }

          return resolve(buildResult({
            name: '未知供应商', url: actualApiUrl, apiKey: maskApiKey(actualApiKey),
            model: actualModel, exists: true, configSource, globalConfig: globalInfo
          }));

        } else {
          // URL 为空，走 is_current / OAuth 判定路径
          const row = db.prepare('SELECT * FROM providers WHERE app_type = ? AND is_current = 1').get(appType);

          if (appType === 'claude' && localIsOAuth) {
            let oauthRow = null;
            try {
              const claudeRows = db.prepare('SELECT * FROM providers WHERE app_type = ?').all('claude');
              oauthRow = claudeRows.find(r => {
                try { const sc = JSON.parse(r.settings_config || '{}'); return !!sc.useOAuth || !sc.env?.ANTHROPIC_BASE_URL; }
                catch { return false; }
              });
            } catch {}
            db.close();
            return resolve(buildResult({
              id: oauthRow?.id, name: oauthRow?.name || 'Claude Official',
              url: '', model: actualModel, exists: true, configSource
            }));
          }

          if (appType === 'claude') {
            let hasOAuth = false;
            try {
              const cj = JSON.parse(readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
              hasOAuth = !!cj.oauthAccount;
            } catch {}
            if (hasOAuth) {
              let oauthRow = null;
              try {
                const claudeRows = db.prepare('SELECT * FROM providers WHERE app_type = ?').all('claude');
                oauthRow = claudeRows.find(r => {
                  try { const sc = JSON.parse(r.settings_config || '{}'); return !!sc.useOAuth || !sc.env?.ANTHROPIC_BASE_URL; }
                  catch { return false; }
                });
              } catch {}
              db.close();
              return resolve(buildResult({
                id: oauthRow?.id, name: oauthRow?.name || 'Claude Official',
                url: '', model: actualModel, exists: true,
                configSource: configSource === 'global' ? 'login' : configSource
              }));
            }
          }

          if (appType === 'claude' && row) {
            let currentSc = {};
            try { currentSc = JSON.parse(row.settings_config || '{}'); } catch {}
            const currentUrl = currentSc.env?.ANTHROPIC_BASE_URL || '';
            const currentIsOAuth = !!currentSc.useOAuth || !currentUrl;
            if (!currentIsOAuth) {
              db.close();
              return resolve(buildResult({
                id: row.id, name: row.name || '未命名',
                url: currentUrl, apiKey: maskApiKey(currentSc.env?.ANTHROPIC_AUTH_TOKEN || currentSc.env?.ANTHROPIC_API_KEY || ''),
                model: currentSc.model || '', exists: true, configSource
              }));
            }
          }

          db.close();
          if (!row) {
            return resolve(buildResult({ name: '未配置', url: '', exists: false, configSource: 'global' }));
          }

          let apiUrl = '', apiKey = '', model = '', apiType = 'openai';
          try {
            if (row.settings_config) {
              const config = JSON.parse(row.settings_config);
              if (appType === 'claude') {
                apiUrl = config.env?.ANTHROPIC_BASE_URL || config.baseURL || '';
                apiKey = config.env?.ANTHROPIC_AUTH_TOKEN || config.env?.ANTHROPIC_API_KEY || '';
                model = config.env?.ANTHROPIC_MODEL || config.model || '';
                apiType = 'claude';
              } else if (appType === 'codex') {
                apiUrl = config.env?.OPENAI_BASE_URL || config.baseURL || '';
                apiKey = config.env?.OPENAI_API_KEY || config.env?.OPENAI_AUTH_TOKEN || '';
                model = config.env?.OPENAI_MODEL || config.model || '';
                apiType = 'openai';
              } else if (appType === 'gemini') {
                apiUrl = config.env?.GEMINI_BASE_URL || config.baseURL || config.env?.BASE_URL || '';
                apiKey = config.env?.GEMINI_API_KEY || config.env?.API_KEY || '';
                model = config.env?.GEMINI_MODEL || config.model || '';
                apiType = 'gemini';
              }
            }
          } catch (parseError) {
            console.error(`[getCurrentProvider] 解析 ${appType} settings_config 失败:`, parseError);
          }

          resolve(buildResult({
            id: row.id, name: row.name || '未命名',
            url: apiUrl, apiKey: maskApiKey(apiKey),
            model, apiType, exists: true, configSource: 'global'
          }));
        }
      } catch (dbError) {
        console.error('[getCurrentProvider] 数据库读取失败:', dbError);
        return resolve(buildResult({
          name: actualApiUrl ? '未知供应商' : '未配置',
          url: actualApiUrl, apiKey: maskApiKey(actualApiKey),
          model: actualModel, exists: !!actualApiUrl, configSource
        }));
      }
    });
  }

  return { getCurrentProvider };
}
