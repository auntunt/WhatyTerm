# GOAL：把 WhatyTerm 升级为「自主版 Orca」

## 一句话目标
在现有「一句话/PRD → 无人值守交付」的自主 harness 之上，引入 Orca 式的「同一任务扇出多候选、自动挑赢家」能力，同时把验收、拆解、可观测三处做扎实，让单任务成功率与整体交付可信度显著提升。

## 背景与定位
- WhatyTerm 现状：强在**自主 loop**（micro/meso/macro 三层重试），harness 是为驱动 loop 服务。
- Orca（stablyai）：强在**并行扇出**（一个 prompt → N 个 agent，各自 git worktree，人挑赢家 merge），故意不做自主决策。
- 两者正交。本目标 = 取 Orca 的「扇出+挑赢家」，把其中「挑赢家」这一步从人工自动化进 loop，成为「自主版 Orca」。
- 关键依赖：**验收可信度是扇出的前置**——「挑赢家」本质就是「比较各候选的验收评分」。所以先做验收，再做扇出。

## 四个阶段（按依赖顺序）

### 阶段 1 · 验收可信度（基石）— ✅ 已完成
把 Validator 从「让 LLM 看代码猜、正则抓 PASS/FAIL」升级为「强制实际运行 build/test + 输出多维结构化评分」。
- 新增 `server/services/util/projectCommands.js`：检测 install/build/test 命令（js/py/go/rust）。
- `ralph/prompts.js` VALIDATOR_PROMPT：注入真实命令、要求实跑、输出 `===VALIDATION===` JSON（passed/compiles/tested/criteria_met/confidence/notes）。
- `RalphEngine._runValidator`：新增 `_parseVerdict`（JSON 优先，回退兼容旧文本格式）、写入 `progressManager.addEvaluation`、`confidence < 0.6` 即使判过也降级重试。
- 验收：解析器与命令检测已单测通过；端到端实跑回归待在真实环境用番茄钟类用例确认。

### 阶段 2 · 扇出 + 自动挑赢家（依赖阶段 1）— 待做
同一任务并行派 N 个候选竞标，各自跑阶段 1 的评分，自动选最高分 merge 回主分支。
- 新增 `WorktreeManager`：一个任务开 N 个 `git worktree`（各自独立目录+分支），跑完清理。
- fanout 配置 `{ count: N, clis: [...] }`，**两者都支持**：同 CLI 多跑、或多 CLI（claude+codex+grok…）竞标，任意组合。
- `_execHeadless` 支持传入 `cwd` 与 `aiType` 覆盖（现硬绑 session）。
- `RalphEngine._runDeveloperFanout`：N 候选并行 → 各自 Validator 打分 → 选最高分 merge，其余丢弃；前端可看各候选实时进度+得分。
- 隐患修复：`DeliveryEngine._executeInBatches` 批次内并行不同任务却共享同一 workingDir，需靠 worktree 隔离。

### 阶段 3 · 拆解质量（独立，决定全局上限）— 待做
- WBS 契约闭合性校验：每个任务的 input 必须能追溯到某任务 output 或外部已有文件，否则回退让 LLM 补。
- `_topoSort` 遇循环依赖显式报错，而非静默塞进一个批次。
- PRD → WBS 之间加一轮 self-review，让 LLM 自查拆解是否合理。

### 阶段 4 · 可观测与干预（横切）— 待做
- blocked 任务人工介入面板：跳过 / 改需求 / 手动修 / 重试。
- token / 成本实时统计接入面板（复用 `TokenStatsService`）。
- 失败快照：blocked 时保存 worktree diff + Validator 全文，供事后诊断。

## 实施策略
- 先做阶段 1 + 2（自主版 Orca 的核心，能立刻看到单任务成功率提升），跑通后再做 3 + 4。
- 不四条线同时铺开；每阶段结束用「命令行番茄钟」类用例做回归。

## 完成标准（Definition of Done）
1. 一句话需求可无人值守跑通，且每个任务由「实跑 build/test 的多维评分」验收，而非文本猜测。
2. 关键任务支持扇出 N 候选，自动选最优 merge，全程可在面板观看各候选进度与得分。
3. 拆解产物（WBS/契约）通过闭合性校验，macro 回退次数明显下降。
4. blocked 任务能在面板人工介入；成本与失败快照可见。
