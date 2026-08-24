# 第五部分：评测闭环与作品集交付

这一部分完成阶段 14～15。没有 evaluation，context、retry、prompt 或 Tool 的“优化”只能靠主观体验判断；没有可复现交付，评测数字也无法成为可信的简历证据。

## 阶段 14：建立 Evaluation Harness

### 14.1 分开两类评测

不要把所有测试都称为 eval。

| 类型 | 是否调用真实模型 | 主要回答的问题 |
|---|---:|---|
| Runtime conformance | 否 | loop、并发、恢复、compaction 是否符合不变量 |
| Agent capability eval | 是 | 某模型和 harness 配置能否完成真实 Coding 任务 |

前者必须进入 `bun run check`，快速、确定、免费。后者单独运行，允许模型随机性、费用和较长耗时。

### 14.2 Eval task 结构

```text
evals/
├── tasks/
│   ├── fix-add/
│   │   ├── task.yaml
│   │   ├── prompt.md
│   │   ├── fixture/
│   │   └── graders/
│   │       └── test.ts
│   └── rename-api/
├── suites/
│   ├── smoke.yaml
│   └── coding-core.yaml
└── reports/
```

`task.yaml`：

```yaml
id: fix-add
version: 1
category: bug-fix
difficulty: easy
timeoutMs: 120000
maxSteps: 20
allowedTools:
  - read_file
  - grep_search
  - str_replace
  - apply_patch
  - bash
grader:
  command: bun test graders/test.ts
  timeoutMs: 20000
```

`prompt.md` 只描述用户可见需求，不泄漏 grader 断言和答案位置。

Runner 只把 `fixture/` 复制到 trial workspace，并把 Agent 的 `cwd` 限制在该目录。Grader 从 task root 运行，通过只读环境变量 `HARNESS_EVAL_WORKSPACE` 获取 trial workspace 路径；`graders/` 不复制进 Agent workspace，因此模型不能直接读取隐藏断言。

### 14.3 从小型任务集开始

第一版准备 10 个任务，覆盖不同失败模式：

1. 单文件纯函数 bug；
2. 跨文件 API rename；
3. 补充输入校验；
4. 添加一个带测试的小功能；
5. 修复 async race；
6. 在明确范围内重构；
7. 根据 failing test 定位问题；
8. 处理路径边界；
9. 更新配置且保持兼容；
10. 信息不足时正确提出问题，而不是擅自修改。

先让 10 个任务质量足够高，再扩大到 30～50 个。大量含糊 task 不会自动变成高质量 benchmark。

### 14.4 隔离运行

每个 trial 必须：

1. 创建新的临时目录；
2. 复制 fixture，不复用上次修改；
3. 初始化独立 runId 和 trace；
4. 限制 cwd、timeout、maxSteps 和 Tools；
5. 运行 Agent；
6. 停止 Agent 后运行 grader；
7. 保存 patch、trace、checkpoint、grader output；
8. 删除临时 workspace，或失败时按配置保留以便调试。

```ts
export interface EvalTrialResult {
  taskId: string;
  taskVersion: number;
  trial: number;
  runId: string;
  status: "passed" | "failed" | "timeout" | "infra_error";
  graderScore: number;
  metrics: RunMetrics;
  patchPath: string;
  tracePath: string;
  failureReason?: string;
}
```

`infra_error` 与 Agent 任务失败必须分开。API outage、fixture 缺失、grader 自身崩溃不能算成模型能力失败。

### 14.5 Grader 优先级

优先使用确定性 grader：

1. 自动化测试；
2. 文件内容/AST/JSON schema 检查；
3. command exit code；
4. 必要时人工 rubric；
5. 最后才是 LLM-as-judge。

LLM judge 适合评价解释质量或开放式结果，但会引入额外模型偏差。若使用，固定 judge model、prompt version，并保存原始判定理由；不要让 judge 读取被评模型身份。

### 14.6 EvalRunner 骨架

```ts
export class EvalRunner {
  constructor(options: {
    workspaceFactory: EvalWorkspaceFactory;
    agentFactory: EvalAgentFactory;
    graderRunner: GraderRunner;
    artifactStore: EvalArtifactStore;
    concurrency: number;
  }) {}

  async runSuite(options: {
    suitePath: string;
    trials: number;
    config: EvalConfig;
    signal?: AbortSignal;
  }): Promise<EvalSuiteResult> {
    // TODO:
    // load/validate tasks
    // → bounded concurrency
    // → isolated trials
    // → grade
    // → aggregate
    // → persist report
  }
}
```

并发数必须有上限，否则会同时打满 provider rate limit、CPU 和临时磁盘。Agent 内 Tool 并发与 eval task 并发是两个不同层级的并发控制。

### 14.7 保存实验身份

每份 report 必须包含：

```ts
export interface EvalRunIdentity {
  evalRunId: string;
  startedAt: string;
  gitCommit: string;
  dirtyWorktree: boolean;
  suite: string;
  suiteVersion: number;
  modelProvider: string;
  modelName: string;
  modelOptions: Record<string, unknown>;
  promptFingerprint: string;
  toolsetFingerprint: string;
  harnessConfig: Record<string, unknown>;
  runtimeVersion: string;
  platform: string;
}
```

不要记录 API key。dirty worktree 可以运行，但报告必须显式标记，避免以后无法复现对应代码。

### 14.8 指标和统计

基础指标：

```text
successRate = passed trials / valid trials
averageSteps
averageToolCalls
invalidToolCallRate
averageInputTokens
averageOutputTokens
averageWallTimeMs
recoverySuccessRate
```

每个 task 多次 trial 时记录 pass@k。至少理解：

- `pass@1` 更接近用户单次运行体验；
- 较高 `pass@k` 说明多次尝试中至少一次成功，不等于稳定性；
- 样本很少的时候，百分点差异不代表真实提升。

报告同时展示原始分子/分母，例如 `17/20 (85%)`，不要只展示百分比。

费用不硬编码在代码中。把 provider/model 的单位价格放入带生效日期的可更新配置；未知价格就只报告 token，不虚构 cost。

### 14.9 Baseline 与 Candidate

评测一项变更时只改变一个主变量。例如 context compaction：

```yaml
baseline:
  context:
    mode: full

candidate:
  context:
    mode: compact
    maxInputTokens: 12000
```

保持以下条件一致：

- model 和 provider；
- model options；
- task/suite version；
- Tool set；
- system prompt；
- trial count；
- 并发和 timeout。

否则无法把结果差异归因到 compaction。

### 14.10 Regression gate

初版只做报告，不要根据 10 个随机任务立刻阻断 CI。积累稳定数据后再配置：

```yaml
gates:
  successRateDropMax: 0.05
  invalidToolCallRateMax: 0.02
  averageInputTokensIncreaseMax: 0.10
```

Runtime conformance tests 可以强制 gate；真实模型 capability eval 更适合 nightly/manual，除非你能控制模型版本和服务稳定性。

### CLI 与输出

```bash
harness-lab eval run evals/suites/smoke.yaml --trials 1
harness-lab eval compare <baseline-id> <candidate-id>
harness-lab eval inspect <eval-run-id> --failed
```

对比表：

```text
Metric                 Baseline       Candidate       Delta
successRate            16/20 80.0%    17/20 85.0%    +5.0pp
avgInputTokens         18,240         11,380          -37.6%
avgSteps               7.3            7.5             +2.7%
invalidToolCallRate    3.1%           2.8%            -0.3pp
avgWallTime            42.1s          40.8s           -3.1%
```

`pp` 是 percentage point，不要把 80% 到 85% 写成“提升 5%”；相对提升是 6.25%。

### 必写测试

- task manifest schema；
- fixture 每个 trial 都是干净副本；
- grader timeout；
- Agent failure 与 infra error 分类；
- bounded concurrency；
- abort 整个 suite 后不再启动新 trial；
- artifact 路径不会逃逸 eval root；
- report identity 包含 commit/config fingerprints；
- aggregate 对空集合、timeout、重复 task id 的处理；
- baseline/candidate 不兼容时拒绝比较。

### 验收

- [ ] 10 个高质量任务；
- [ ] runtime conformance suite 完全离线；
- [ ] capability eval 每个 trial workspace 隔离；
- [ ] 失败 trial 可通过 trace 和 patch 定位；
- [ ] report 可以复现代码与配置；
- [ ] baseline/candidate 只改变一个主变量；
- [ ] `ADR-016` 解释 deterministic test 与 stochastic eval 的区别。

## 阶段 15：Capstone 与作品集交付

### 15.1 最终项目定义

你的 README 第一屏应在 30 秒内回答：

1. 这是一个什么项目？
2. 它解决什么 Agent 工程问题？
3. 与基础 Helixent 相比新增了什么？
4. 如何运行离线 demo？
5. 如何运行真实模型 demo？
6. 哪些数字证明设计有效？

推荐定位：

> Harness Lab 是一个基于 Bun/TypeScript 的 Coding Agent runtime。项目从统一 transcript 和 ReAct loop 出发，提供并发 Tool 调度、策略审批、结构化 tracing、原子 checkpoint、resume/replay、context compaction 和可复现 eval。

### 15.2 必备文档

```text
README.md
docs/
├── architecture.md
├── security-model.md
├── recovery-semantics.md
├── context-management.md
├── evaluation-methodology.md
├── benchmark-report.md
├── manual-test.md
└── decisions/
```

`architecture.md` 画依赖方向和一次 run 数据流；`recovery-semantics.md` 明确 unknown side effect；`benchmark-report.md` 保存实验身份、原始结果和限制。

### 15.3 必备演示

保留三个不会互相替代的 demo：

1. **Offline runtime demo**：scripted provider，展示 loop/concurrency/abort；
2. **Failure recovery demo**：故障注入，展示 checkpoint/resume/replay；
3. **Real coding demo**：真实模型修改 fixture repo，展示审批、trace 和 grader。

录屏控制在 3～5 分钟。不要剪掉审批、失败或 eval 输出，只保留聊天成功结果会掩盖 harness 的真正价值。

### 15.4 发布前 gate

```bash
bun run check
bun run eval:conformance
bun run examples/runtime-demo.ts
bun run examples/recovery-demo.ts
git status --short
```

再从全新目录验证 README 安装步骤。开发机上“因为全局依赖存在而成功”不算可复现。

### 15.5 Benchmark 报告模板

```markdown
# Benchmark Report

## Hypothesis
Context compaction 在不显著降低成功率的情况下减少 input token。

## Controlled variables
- commit: ...
- model/provider: ...
- suite/version: ...
- trials: ...
- toolset fingerprint: ...

## Independent variable
- baseline: full transcript
- candidate: compacted context, maxInputTokens=...

## Results
粘贴原始分子/分母、均值和失败分类。

## Failure analysis
至少分析 3 个失败 trace，不只解释平均值。

## Limitations
样本规模、模型版本漂移、grader 覆盖范围等。

## Decision
接受、拒绝或继续实验，以及原因。
```

### 15.6 简历描述模板

没有数据前使用事实描述：

> 基于 Helixent 架构独立复刻 Bun/TypeScript Coding Agent Harness，实现 canonical Message 协议、流式 ReAct loop、并发 Tool 调度、Middleware、权限审批与多模型适配。

有可复现实验后再加入数字：

> 设计 JSONL tracing 与原子 checkpoint，支持中断恢复和无副作用 replay；通过故障注入覆盖模型返回、Tool 执行和持久化边界，恢复测试通过 X/Y。

> 构建由 N 个隔离 Coding 任务组成的 eval suite；context compaction 将平均输入 token 从 A 降至 B（-C%），成功率从 D/E 变化为 F/G，实验配置和 trace 可复现。

`X/Y/N/A/B...` 必须替换成真实数据。没有测量就删除数字，不使用“显著提升”“大幅优化”等无证据表述。

### 15.7 面试答辩题

项目完成后，脱离代码回答：

1. 为什么 canonical Message 不能直接使用 OpenAI SDK type？
2. 为什么 Tool result 应按完成顺序反馈？
3. `Promise.all` 与 pending-set `Promise.race` 的用户体验差异是什么？
4. 为什么 Tool failure 通常是 observation，而不是 run failure？
5. Middleware 为什么不能承担所有 tracing？
6. trace、checkpoint 和 replay 分别服务什么目标？
7. 为什么任意 `bash` 无法保证 exactly-once recovery？
8. context compaction 如何保证 Tool call/result 配对？
9. 为什么完整 transcript 和本次 Model view 要分离？
10. 哪些错误可以 retry，哪些不能？
11. 为什么修改型 Tool 默认不能自动 retry？
12. 如何证明一个 prompt/context 改动真的更好？
13. eval 的 infra error 为什么不能计入任务失败？
14. 你的 benchmark 中最大的不确定性是什么？
15. 如果增加 multi-agent，会新增哪些状态、权限和评测问题？

无法清晰回答的问题，就是下一轮应该回到代码和 ADR 深挖的地方。

### 15.8 最终 Definition of Done

- [ ] 基础能力由离线 scripted tests 覆盖；
- [ ] 真实模型只是 adapter，不侵入 Agent runtime；
- [ ] 每个副作用都经过 Tool 和 Policy；
- [ ] 每个 run 都能 trace；
- [ ] crash 后可以 inspect 并按明确语义 resume；
- [ ] replay 不调用 model/Tool；
- [ ] context view 在预算内且不破坏 call/result pairing；
- [ ] eval fixture 隔离、grader 可复现；
- [ ] benchmark 包含失败分析和限制；
- [ ] README 明确标注 Helixent 来源和你的扩展；
- [ ] 创建 `v1.0.0` tag。

完成这些条件后，项目目标——“一个可观测、可恢复、可评测的 Coding Agent Harness”——才算真正闭环。
