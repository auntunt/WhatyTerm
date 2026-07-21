/**
 * 最小验证：真实 AIEngine.generateTextViaCLI + 真实 claude，在临时 git 仓库里干活。
 * 这是 RalphEngine spawn 路径的核心。验证修复后的 CLI 解析 + provider env 能让 claude 真正执行。
 * 运行: node tests/test-real-cli.mjs
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { AIEngine } from '../server/services/AIEngine.js';

function realProviderEnv() {
  const db = new Database(join(os.homedir(), '.cc-switch/cc-switch.db'), { readonly: true });
  const row = db.prepare("SELECT settings_config FROM providers WHERE name='公司提供api' AND app_type='claude' LIMIT 1").get();
  db.close();
  const e = JSON.parse(row.settings_config).env || {};
  return { ANTHROPIC_BASE_URL: e.ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN: e.ANTHROPIC_AUTH_TOKEN || null, ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY || null };
}

const dir = fs.mkdtempSync(join(os.tmpdir(), 'real-cli-'));
const git = (a) => execFileSync('git', a, { cwd: dir, encoding: 'utf-8' });
git(['init', '-q']); git(['config', 'user.email', 't@t']); git(['config', 'user.name', 't']);
fs.writeFileSync(join(dir, 'README.md'), '# test\n');

const providerEnv = realProviderEnv();
console.log('[test] provider:', providerEnv.ANTHROPIC_BASE_URL, '| repo:', dir);

const ai = new AIEngine();
const prompt = '在当前目录创建一个文件 hello.txt，内容恰好是一行：hello from ralph。用你的文件写入工具创建它。完成后只回复“done”，不要做其它任何事。';
console.log('[test] 调用真实 claude...');
const t0 = Date.now();
const out = await ai.generateTextViaCLI(prompt, { cwd: dir, aiType: 'claude', providerEnv, timeout: 120000 });
console.log(`[test] claude 返回，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
console.log('[test] CLI 输出:', JSON.stringify((out || '').slice(0, 200)));

const f = join(dir, 'hello.txt');
const exists = fs.existsSync(f);
const content = exists ? fs.readFileSync(f, 'utf-8') : '';
console.log('\n========== 结果 ==========');
console.log('hello.txt 存在:', exists, '| 内容:', JSON.stringify(content));
const ok = exists && /hello/i.test(content);
console.log(ok ? '\n✅ 真实 CLI 执行通过：claude 实际创建了文件（修复后 headless/spawn 链路可用）'
              : '\n❌ claude 未创建文件（CLI 输出见上，判断是否 provider/权限问题）');
process.exit(ok ? 0 : 1);
