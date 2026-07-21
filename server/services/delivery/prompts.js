/**
 * delivery/prompts.js
 * DeliveryEngine 使用的 Prompt 模板
 * ProjectDecomposer（需求拆解）+ IntegrationRunner（集成验证）
 */

// ── ProjectDecomposer Prompts ─────────────────────────────────────

export const DECOMPOSE_CLARIFY_PROMPT = `你是一个需求分析专家。用户给了你一个项目需求，你需要判断信息是否足够拆解。

## 用户需求
{REQUIREMENT}

## 项目现状
{PROJECT_CONTEXT}

## 任务
判断以下关键信息是否已知，对于缺失的信息提出澄清问题（最多3个，按重要性排序）：
1. 交付物是什么？（代码/API/脚本/文档）
2. 技术栈是否有限制？
3. 完成标准是什么？（能跑通/通过测试/可部署）
4. 哪些功能是 must-have，哪些是 nice-to-have？

如果信息已经足够（用户需求描述清晰，项目现状能补充上下文），直接回复：
CLARIFY: SUFFICIENT

如果需要澄清，回复格式：
CLARIFY: NEEDED
Q1: <最重要的问题>
Q2: <次要问题>
Q3: <可选问题>

只输出上述格式，不要其他内容。`;

export const DECOMPOSE_PRD_PROMPT = `你是一个技术产品经理。根据用户需求和项目现状，生成一份结构化 PRD。

## 用户需求
{REQUIREMENT}

## 澄清补充
{CLARIFICATION}

## 项目现状
{PROJECT_CONTEXT}

## 输出格式（严格按此 JSON 格式输出，不要 markdown 包裹）
{
  "projectName": "项目名称",
  "objective": "一句话描述目标",
  "deliverables": ["交付物1", "交付物2"],
  "techStack": {
    "language": "语言",
    "framework": "框架",
    "database": "数据库或无",
    "runtime": "运行环境"
  },
  "mustHave": ["核心功能1", "核心功能2"],
  "niceToHave": ["可选功能1"],
  "acceptanceCriteria": ["可量化的验收标准1", "标准2"],
  "assumptions": ["假设1（未澄清的风险项）"]
}`;

export const DECOMPOSE_WBS_PROMPT = `你是一个软件架构师。根据 PRD 生成 WBS 任务分解和接口契约。

## PRD
{PRD}

## 项目现状
{PROJECT_CONTEXT}

## 拆分原则
- 每个子任务：1个独立模块，不超过300行代码，有明确输入/输出
- 禁止跨层：单个任务不同时涉及数据层和展示层
- 依赖显式化：每个任务标注依赖哪些任务的输出
- 并行优先：没有依赖关系的任务标记 canParallel: true

## 输出格式（严格 JSON，不要 markdown 包裹）
{
  "tasks": [
    {
      "id": "T01",
      "name": "任务名称",
      "type": "design|implement|test|integrate",
      "description": "详细的实现要求和技术设计",
      "dependsOn": [],
      "canParallel": true,
      "estimatedLines": 100,
      "contract": {
        "inputs": ["输入描述，如：T01 输出的 Schema 文件"],
        "outputs": ["输出文件路径或函数签名"],
        "acceptanceCriteria": ["可机器验证的完成标准1", "标准2"],
        "notIncluded": ["明确排除的功能，防止 scope creep"]
      }
    }
  ]
}

重要：acceptanceCriteria 必须可机器验证，如"通过 N 个单元测试"、"文件 X 存在且导出函数 Y"，不能是"功能正确"。`;

export const WBS_SELF_REVIEW_PROMPT = `你是一个资深软件架构评审专家。下面是针对某 PRD 生成的 WBS 任务分解，请严格自查并给出修正后的完整 WBS。

## PRD
{PRD}

## 待评审的 WBS
{WBS}

## 评审清单（逐条检查，发现问题就在输出里修正）
1. **覆盖完整**：PRD 的每个 mustHave 是否都有对应任务？是否漏了测试任务、错误/边界处理、最后的"集成验证与收尾"任务？
2. **契约闭合**：每个任务 contract.inputs 是否都能追溯到某个【已在其 dependsOn 里声明的】上游任务的 outputs，或明确的已有文件/外部来源？发现悬空输入就补齐产出它的任务或修正 dependsOn。
3. **依赖正确**：dependsOn 只引用真实存在的任务 id；不存在循环依赖；较早任务不依赖较晚任务。
4. **粒度合理**：单个任务不超过 ~300 行、不跨数据层与展示层；过大的任务拆开，过碎的合并。
5. **验收可机器验证**：acceptanceCriteria 是可检查的事实/命令，不是"功能正常"。

## 输出格式（严格 JSON，与输入 WBS 同结构，不要 markdown 包裹，不要解释）
{
  "tasks": [ /* 修正后的完整任务数组，字段同输入 */ ],
  "reviewNotes": ["本次修正了哪些问题的简短列表"]
}`;

export const WBS_REPAIR_CLOSURE_PROMPT = `你是软件架构师。下面的 WBS 存在【契约闭合性】问题：某些任务的输入无法追溯到任何上游任务的输出或已有文件。

## 当前 WBS
{WBS}

## 检测到的悬空输入（必须全部解决）
{UNRESOLVED}

## 修正要求
对每个悬空输入，二选一：
 (a) 新增/调整一个上游任务，使其 outputs 明确产出该输入所需的文件/接口，并把当前任务的 dependsOn 指向它；
 (b) 若该输入本就是已有文件或外部来源，则在 inputs 文本中明确标注（如"已有的 X 文件"、"外部提供的 Y"）。
保持其余任务不变，不要引入循环依赖。

## 输出格式（严格 JSON，与输入 WBS 同结构，不要 markdown 包裹，不要解释）
{
  "tasks": [ /* 修正后的完整任务数组 */ ]
}`;

// ── IntegrationRunner Prompts ─────────────────────────────────────

export const INTEGRATION_PROMPT = `你是一个集成验证 Agent。所有子任务已完成，现在执行集成验证。

## 项目信息
工作目录：{WORKING_DIR}
技术栈：{TECH_STACK}

## 已完成的子任务
{COMPLETED_TASKS}

## 验证步骤（按顺序执行）
1. 确认所有输出文件存在
2. 运行依赖安装：{INSTALL_CMD}
3. 运行编译/类型检查：{BUILD_CMD}（如果有）
4. 运行端到端测试：{TEST_CMD}（如果有）
5. 执行冒烟测试：验证核心路径可以跑通

## 输出格式（最后单独一行）
全部通过：INTEGRATION: PASS
有失败：  INTEGRATION: FAIL - <失败的模块 task_id> - <错误原因简述>

只输出验证过程和结论，不要修复代码。`;

export const MACRO_REPAIR_PROMPT = `你是一个项目架构师。集成验证失败了，需要定位根因并制定最小修复方案。

## 失败信息
{FAILURE_INFO}

## WBS 任务列表
{WBS_TASKS}

## 已完成任务的输出
{COMPLETED_OUTPUTS}

## 分析要求
1. 判断失败类型：
   - interface_mismatch：接口不匹配（某个任务输出与另一个任务期望的输入不符）
   - implementation_bug：实现 bug（逻辑正确但运行报错）
   - design_flaw：设计缺陷（多个模块都有问题，根源在 WBS 设计）
   - requirement_gap：需求理解偏差

2. 确定最小修复范围（只列出需要重做的 task_id）

## 输出格式（严格 JSON）
{
  "failureType": "interface_mismatch|implementation_bug|design_flaw|requirement_gap",
  "rootCause": "根因描述",
  "affectedTasks": ["T02", "T03"],
  "repairStrategy": "修复策略说明",
  "needsPRDUpdate": false,
  "needsContractUpdate": ["T02"]
}`;
