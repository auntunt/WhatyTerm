/**
 * 阶段 3「拆解质量」单元测试
 * 运行: node tests/test-decompose-quality.mjs
 *
 * 覆盖：
 *  1. _topoSort：DAG 正确分批；循环依赖显式抛错（附带环）；悬空依赖健壮兜底
 *  2. _validateDeps：检出悬空 dependsOn 引用
 *  3. validateContractClosure：检出悬空输入；可追溯到上游 output / 已有文件 / 外部来源时放行
 *  4. generateWBS 集成：mock LLM 走完 自查→依赖校验→契约闭合→拓扑，循环依赖时抛错
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import os from 'os';

import { ProjectDecomposer } from '../server/services/delivery/ProjectDecomposer.js';

const results = { passed: 0, failed: 0, errors: [] };
function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); results.passed++; }
  catch (err) { console.log(`❌ ${name}\n   错误: ${err.message}`); results.failed++; results.errors.push({ name, error: err.message }); }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); results.passed++; }
  catch (err) { console.log(`❌ ${name}\n   错误: ${err.message}`); results.failed++; results.errors.push({ name, error: err.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '不相等'}: 期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)}`); }

const dec = new ProjectDecomposer({ callLLM: async () => '{}' }, { emit() {} });

// ── 1. _topoSort ────────────────────────────────────────────────
console.log('\n=== _topoSort ===');

test('DAG 正确分批（依赖靠后批次）', () => {
  const order = dec._topoSort([
    { id: 'T01', dependsOn: [] },
    { id: 'T02', dependsOn: ['T01'] },
    { id: 'T03', dependsOn: ['T01'] },
    { id: 'T04', dependsOn: ['T02', 'T03'] },
  ]);
  eq(order[0].tasks.sort().join(','), 'T01', '批次0');
  eq(order[1].tasks.sort().join(','), 'T02,T03', '批次1 并行');
  eq(order[2].tasks.join(','), 'T04', '批次2');
});

test('循环依赖 → 抛错并带 cycle', () => {
  let thrown = null;
  try {
    dec._topoSort([
      { id: 'A', dependsOn: ['C'] },
      { id: 'B', dependsOn: ['A'] },
      { id: 'C', dependsOn: ['B'] },
    ]);
  } catch (e) { thrown = e; }
  assert(thrown, '应抛错');
  eq(thrown.code, 'WBS_CYCLE', 'error code');
  assert(Array.isArray(thrown.cycle) && thrown.cycle.length >= 3, `环应包含节点, 实际 ${thrown.cycle}`);
  // 环首尾应相同
  eq(thrown.cycle[0], thrown.cycle[thrown.cycle.length - 1], '环首尾闭合');
});

test('无依赖任务全在批次0', () => {
  const order = dec._topoSort([{ id: 'X', dependsOn: [] }, { id: 'Y', dependsOn: [] }]);
  eq(order.length, 1, '单批次');
  eq(order[0].tasks.length, 2, '两任务并行');
});

test('悬空依赖被忽略（不误判为环）', () => {
  // T02 依赖不存在的 T99，getDeps 过滤后视为无依赖 → 不应抛环
  const order = dec._topoSort([
    { id: 'T01', dependsOn: [] },
    { id: 'T02', dependsOn: ['T99'] },
  ]);
  assert(order.length >= 1, '应能排出顺序');
});

// ── 2. _validateDeps ────────────────────────────────────────────
console.log('\n=== _validateDeps ===');

test('检出悬空 dependsOn 引用', () => {
  const d = dec._validateDeps([
    { id: 'T01', dependsOn: [] },
    { id: 'T02', dependsOn: ['T01', 'T88'] },
  ]);
  eq(d.length, 1, '一处悬空');
  eq(d[0].task, 'T02', '任务');
  eq(d[0].missing.join(','), 'T88', '缺失引用');
});

test('全部引用有效 → 无悬空', () => {
  const d = dec._validateDeps([
    { id: 'T01', dependsOn: [] },
    { id: 'T02', dependsOn: ['T01'] },
  ]);
  eq(d.length, 0, '无悬空');
});

// ── 3. validateContractClosure ──────────────────────────────────
console.log('\n=== validateContractClosure ===');

test('input 追溯到上游任务 output → 闭合', () => {
  const wbs = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: ['无'], outputs: ['src/schema.ts'] } },
    { id: 'T02', dependsOn: ['T01'], contract: { inputs: ['T01 输出的 src/schema.ts'], outputs: ['src/service.ts'] } },
  ] };
  const r = dec.validateContractClosure(wbs, null);
  assert(r.closed, `应闭合, 实际未闭合: ${JSON.stringify(r.unresolved)}`);
});

test('悬空输入（无产出者、无依赖）→ 检出', () => {
  const wbs = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: ['src/mystery.ts 里的类型'], outputs: ['src/a.ts'] } },
  ] };
  const r = dec.validateContractClosure(wbs, null);
  assert(!r.closed, '应检出悬空');
  eq(r.unresolved[0].task, 'T01', '悬空任务');
});

test('引用了 output 但没声明 dependsOn → 检出', () => {
  const wbs = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: [], outputs: ['src/schema.ts'] } },
    { id: 'T02', dependsOn: [], contract: { inputs: ['src/schema.ts'], outputs: ['src/x.ts'] } },
  ] };
  const r = dec.validateContractClosure(wbs, null);
  assert(!r.closed, 'T02 用了 schema 但未依赖 T01，应检出');
});

test('明确外部来源 → 放行', () => {
  const wbs = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: ['外部提供的 config.json'], outputs: ['src/a.ts'] } },
  ] };
  const r = dec.validateContractClosure(wbs, null);
  assert(r.closed, '外部来源应放行');
});

test('纯描述性输入（无文件/任务 token）→ 宽松放行', () => {
  const wbs = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: ['用户的功能设想'], outputs: ['src/a.ts'] } },
  ] };
  const r = dec.validateContractClosure(wbs, null);
  assert(r.closed, '无 token 描述应放行');
});

test('input 追溯到工作目录已有文件 → 闭合', () => {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'cc-'));
  fs.mkdirSync(join(dir, 'src'), { recursive: true });
  fs.writeFileSync(join(dir, 'src', 'existing.ts'), '// x');
  const wbs = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: ['已在 src/existing.ts 的工具函数'], outputs: ['src/a.ts'] } },
  ] };
  // 注：inputs 含"已"字，命中外部/已有正则；再单独验一个不含"已"的
  const wbs2 = { tasks: [
    { id: 'T01', dependsOn: [], contract: { inputs: ['src/existing.ts 的工具函数'], outputs: ['src/a.ts'] } },
  ] };
  const r = dec.validateContractClosure(wbs2, dir);
  assert(r.closed, `工作目录已有文件应闭合: ${JSON.stringify(r.unresolved)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 4. generateWBS 集成（mock LLM）──────────────────────────────
console.log('\n=== generateWBS 集成 ===');

// 构造一个按 label 返回不同 JSON 的 mock aiEngine
function mockDecomposer(responder) {
  const aiEngine = { callLLM: async (prompt) => responder(prompt) };
  return new ProjectDecomposer(aiEngine, { emit() {} });
}

await testAsync('走完 自查→契约→拓扑，产出 executionOrder', async () => {
  const goodTasks = [
    { id: 'T01', name: '建 schema', type: 'design', description: 'd', dependsOn: [],
      contract: { inputs: ['无'], outputs: ['src/schema.ts'], acceptanceCriteria: ['文件存在'], notIncluded: [] } },
    { id: 'T02', name: '建 service', type: 'implement', description: 'd', dependsOn: ['T01'],
      contract: { inputs: ['T01 输出的 src/schema.ts'], outputs: ['src/service.ts'], acceptanceCriteria: ['npm test 通过'], notIncluded: [] } },
  ];
  const d = mockDecomposer((prompt) => {
    if (/自查|评审清单/.test(prompt)) return JSON.stringify({ tasks: goodTasks, reviewNotes: ['无需修改'] });
    // 初拆
    return JSON.stringify({ tasks: goodTasks });
  });
  const wbs = await d.generateWBS('sid-xxxxxxxx', { projectName: 'p', mustHave: ['x'] }, null);
  eq(wbs.tasks.length, 2, '任务数');
  assert(Array.isArray(wbs.executionOrder), '有 executionOrder');
  eq(wbs.executionOrder[0].tasks.join(','), 'T01', '批次0=T01');
});

await testAsync('自查引入循环依赖 → generateWBS 抛 WBS_CYCLE', async () => {
  const cyc = [
    { id: 'T01', name: 'a', dependsOn: ['T02'], contract: { inputs: [], outputs: ['a.ts'] } },
    { id: 'T02', name: 'b', dependsOn: ['T01'], contract: { inputs: [], outputs: ['b.ts'] } },
  ];
  const d = mockDecomposer((prompt) => {
    if (/自查|评审清单/.test(prompt)) return JSON.stringify({ tasks: cyc });
    return JSON.stringify({ tasks: cyc });
  });
  let thrown = null;
  try { await d.generateWBS('sid-yyyyyyyy', { projectName: 'p' }, null); }
  catch (e) { thrown = e; }
  assert(thrown && thrown.code === 'WBS_CYCLE', `应抛循环依赖错, 实际 ${thrown?.message}`);
});

await testAsync('契约不闭合 → 触发修复 prompt，修复后闭合', async () => {
  const broken = [
    { id: 'T01', name: 'svc', dependsOn: [], contract: { inputs: ['src/schema.ts 的类型'], outputs: ['src/service.ts'] } },
  ];
  const fixed = [
    { id: 'T00', name: 'schema', dependsOn: [], contract: { inputs: ['无'], outputs: ['src/schema.ts'] } },
    { id: 'T01', name: 'svc', dependsOn: ['T00'], contract: { inputs: ['T00 输出的 src/schema.ts'], outputs: ['src/service.ts'] } },
  ];
  let repairCalled = false;
  const d = mockDecomposer((prompt) => {
    if (/契约闭合性.*问题|悬空输入/.test(prompt)) { repairCalled = true; return JSON.stringify({ tasks: fixed }); }
    if (/自查|评审清单/.test(prompt)) return JSON.stringify({ tasks: broken }); // 自查原样返回（保留问题）
    return JSON.stringify({ tasks: broken });
  });
  const wbs = await d.generateWBS('sid-zzzzzzzz', { projectName: 'p' }, null);
  assert(repairCalled, '应触发契约修复');
  eq(wbs.tasks.length, 2, '修复后 2 任务');
  const check = d.validateContractClosure(wbs, null);
  assert(check.closed, '修复后应闭合');
});

// ── 汇总 ────────────────────────────────────────────────────────
console.log(`\n========== 结果: ${results.passed} 通过, ${results.failed} 失败 ==========`);
if (results.failed > 0) {
  for (const e of results.errors) console.log(`  ✗ ${e.name}: ${e.error}`);
  process.exit(1);
}
