# 从零构建可观测、可恢复、可评测的 Coding Agent Harness

这是一门以 Helixent 为参考实现的项目制教程。你会新建一个空的 TypeScript/Bun 项目，先逐层复刻 Helixent 的核心能力，再把它扩展成一个具备 tracing、checkpoint/replay、context management 和 evaluation 的 Coding Agent Harness。

教程不要求逐行抄写 Helixent。每个阶段都采用同一种节奏：

1. 先明确本阶段新增的系统能力和不变量。
2. 复制“文件创建命令”，一次建立本阶段目录和空文件。
3. 复制教程给出的完整测试，先看到符合预期的失败。
4. 阅读一个带讲解的标准实现示例，再根据分项提示完成其余 `TODO`。
5. 运行示例和自动化测试，看到真实反馈并回答复盘问题。
6. 提交一个可以单独运行的 Git checkpoint。

最终项目建议命名为 `harness-lab`。如果用于简历，请写明“基于 Helixent 的架构进行独立复刻和扩展”，不要声称原始设计全部由自己从零发明。

## 1. 最终成果

完成课程后，项目应当具有以下数据流：

```text
User / CLI / TUI
        │
        ▼
 CodingAgent composition ─────── Skills / AGENTS.md / Todo
        │
        ▼
 Agent runtime ──────────────── Middleware / Policy / Context budget
   │       │       │
   │       │       └─────────── Trace events → JSONL trace store
   │       └─────────────────── Checkpoint → Resume / Replay
   ▼
 Model abstraction ⇄ OpenAI / Anthropic adapters
   │
   ▼
 Tool runtime ⇄ Filesystem / Search / Patch / Bash

Eval runner → fixtures → isolated workspace → agent run → graders → report
```

这里的 harness 不是某个 prompt，也不是模型 SDK 的薄封装。它是围绕模型的运行控制层，负责 transcript、context、tools、生命周期、安全策略、失败恢复、观测和评测。

## 2. 课程边界

基础复刻部分追求“功能等价”，不是“文件逐字相同”。完成阶段 0～10 后，你将拥有：

- 统一的 `Message` transcript；
- `Model` / `ModelProvider` 抽象和两个 provider adapter；
- Zod 驱动的 Tool contract；
- ReAct loop、流式输出、并发 Tool 调度和中止；
- Middleware 生命周期；
- Coding tools、Skills、Todo、`AGENTS.md`；
- Human-in-the-loop 审批；
- 可交互 CLI/TUI 和模型配置。

进阶部分不会优先堆 MCP 或 multi-agent。先完成单 Agent runtime 的可观测、可恢复和可评测闭环，才能判断更多组件到底改善了什么。

## 3. 前置知识和时间预算

最低要求：

- 知道 JSON、HTTP API、环境变量和 Git 的基本用法；
- 能阅读一个失败测试的错误信息。

如果还不熟悉 TypeScript，可以先完成[第零部分：TypeScript 必备基础](./part-0-typescript-basics.md)。
它覆盖后续代码会用到的 interface、union、generic、class、async/await 和
`AsyncGenerator`，不要求预先具备 TypeScript 开发经验。

不要求提前掌握：

- LLM tool calling 协议；
- `AsyncGenerator`；
- event sourcing；
- context compaction；
- agent eval。

建议投入 8～12 周、每周 6～10 小时。不要用完成天数衡量进度，以阶段验收条件为准。

## 4. 阶段地图

| 阶段 | 可交付程序 | 你能看到的反馈 | 推荐提交 |
|---|---|---|---|
| 0. 工程起点 | Bun/TS CLI + 测试 | `harness-lab ready` | `chore(scaffold): 初始化课程项目` |
| 1. Message | transcript formatter | 四种 role 的结构化输出 | `feat(foundation): 定义消息协议` |
| 2. Model | scripted streaming demo | 文本逐步累积 | `feat(model): 建立模型抽象` |
| 3. Tool | Tool playground | 参数校验与结构化结果 | `feat(tool): 建立工具契约` |
| 4. ReAct loop | 离线 weather agent | `think → act → observe → answer` | `feat(agent): 实现最小循环` |
| 5. 并发与中止 | parallel tools demo | 快 Tool 先返回、Ctrl+C 中止 | `feat(agent): 支持并发和中止` |
| 6. Middleware | lifecycle demo | 完整 hook 调用顺序 | `feat(agent): 引入中间件生命周期` |
| 7. Provider | 真实模型 chat | OpenAI/Anthropic 流式回复 | `feat(provider): 接入模型适配器` |
| 8. Coding tools | workspace agent | 读取、搜索、修改临时仓库 | `feat(coding): 实现编码工具集` |
| 9. Context 能力 | coding agent composition | Skills/Todo/项目指令生效 | `feat(coding): 组装编码智能体` |
| 10. CLI/TUI 与审批 | 交互式 coding agent | streaming、token、审批弹窗 | `feat(cli): 完成交互式客户端` |
| 11. Observability | trace recorder/viewer | step/tool/token/latency 时间线 | `feat(trace): 记录运行轨迹` |
| 12. Recovery | resume/replay CLI | 中断后续跑、无模型重放 | `feat(runtime): 支持断点恢复` |
| 13. Context 与可靠性 | budgeted long session | 压缩率、retry、timeout 指标 | `feat(runtime): 管理上下文与失败` |
| 14. Evaluation | eval runner/report | 成功率、token、耗时对比 | `feat(eval): 建立评测闭环` |
| 15. Capstone | 可发布项目 | 可复现实验和演示 | `docs(portfolio): 完成项目交付` |

## 5. 章节导航

- [第零部分：TypeScript 必备基础](./part-0-typescript-basics.md)
- [第一部分：工程基础与 Foundation](./part-1-foundation.md)
- [第二部分：Agent Runtime](./part-2-agent-runtime.md)
- [第三部分：Coding Agent 与交互客户端](./part-3-coding-agent.md)
- [第四部分：可观测、可恢复与可靠运行](./part-4-production-runtime.md)
- [第五部分：评测闭环与作品集交付](./part-5-evaluation.md)
- [附录：阶段验收清单](./stage-checklists.md)

## 6. 开始前的仓库策略

建议把参考仓库和练习仓库并排放置：

```text
projects/
├── helixent/       # 参考实现，只读
└── harness-lab/    # 你的练习与二次开发
```

在一个新目录开始：

```bash
mkdir harness-lab
cd harness-lab
git init
bun init -y
```

不要直接复制 `src/`。每阶段完成前，只允许查看本教程列出的“阶段前参考”；完成测试后，再通过“阶段后对照”检查设计差异。

推荐每阶段使用一个分支：

```bash
git switch -c course/stage-01-messages
```

阶段完成后合并到自己的 `main`。这样每个 Git commit 都是可以运行的课程 checkpoint，也方便在面试中演示架构如何逐步演化。

## 7. 全课程统一工程约束

你的练习项目沿用 Helixent 的核心约束：

- Runtime 和包管理器使用 Bun；
- TypeScript strict、ESM、`moduleResolution: "bundler"`；
- schema 使用 Zod；
- 内部跨层 import 使用 `@/*`；
- `foundation` 不依赖其他业务层；
- `agent` 只依赖 `foundation`；
- `coding` 组合 `agent` 和 `foundation`；
- provider adapter 放在 `community`；
- `cli` 可以依赖所有层；
- 测试与实现 co-located；
- 每个 Tool 必须有 success 和 structured error 测试；
- 每次提交前执行 `bun run check`。

质量门脚本统一为：

```json
{
  "scripts": {
    "dev": "bun run src/cli/index.ts",
    "check:types": "tsc --noEmit",
    "test": "bun test",
    "check": "bun run check:types && bun test"
  }
}
```

课程前半段暂不引入 ESLint，避免把注意力从 runtime 转移到格式配置。阶段 10 再把 lint 纳入 gate。

## 8. 每阶段的标准动作

每一章都按下面的协议完成。

### 8.1 Scaffold：复制命令创建文件

每个阶段先给出可从练习仓库根目录直接执行的命令，例如：

```bash
mkdir -p src/foundation/messages/types src/foundation/messages/__tests__ examples
touch src/foundation/messages/types/content.ts
touch src/foundation/messages/types/message.ts
touch src/foundation/messages/__tests__/transcript.test.ts
touch examples/stage-01-transcript.ts
```

命令只负责创建目录和空文件，不会覆盖已有内容。若文件已经存在，`touch` 只更新时间戳；
执行前仍应使用 `git status --short` 确认没有不希望覆盖的修改。

### 8.2 Red：先运行完整失败测试

教程中的测试文件是完整内容，不留待填写的 `TODO`。复制后执行：

```bash
bun test path/to/test.ts
```

确认它因为缺少当前能力而失败。测试一开始就通过，通常说明测试没有覆盖目标行为。

### 8.3 Green：一个示例 + 分项提示

当一个代码块含有多个待实现点时，教程遵循两条规则：

- 第一个关键分支给出标准实现，并用注释解释输入、输出和不变量；
- 其余分支保留为练习，但每个 `TODO` 都提供独立提示、边界条件和失败语义。

### 8.4 代码块路径、示例输入和示例输出

所有实现代码块之前都标明目标文件。示例数据统一写成“示例输入”“示例输出”，并说明：

- 参数是否必填、是否允许空值；
- 数组或事件是否要求顺序；
- id、路径和 Tool result 的关联规则；
- error 是 throw、structured result 还是 observation。

### 8.5 只实现当前阶段

不要提前实现后续能力。例如阶段 4 只需要顺序 Tool 执行；并发、abort 和 Middleware 留到后续阶段。限制变量能让你真正看见每项设计解决的具体问题。

### 8.6 Observe：运行真实示例

测试证明程序符合断言，终端反馈帮助你建立运行时心智模型。每阶段必须保留一个 `examples/stage-xx-*.ts`，不能只保留单元测试。

### 8.7 Refactor：写决策记录

在 `docs/decisions/` 新增简短 ADR，回答：

```markdown
# ADR-00X: 决策标题

## Context
遇到了什么问题？

## Decision
选择了什么设计？

## Consequences
获得什么，牺牲什么？
```

### 8.8 Gate：提交可运行 checkpoint

```bash
bun run check
git status --short
git add .
git commit -m "feat(scope): 用中文描述本阶段结果"
```

## 9. Definition of Done

一个阶段只有同时满足以下条件才算完成：

- 示例程序可以从干净 checkout 运行；
- 不需要真实 API 的单元测试全部通过；
- 真实 API 是可选验证，缺少 key 不会导致整个测试套件失败；
- 终端输出能观察本阶段新增行为；
- error path 至少有一个自动化测试；
- 没有把下一阶段的能力混入当前实现；
- ADR 能解释一个关键设计决定；
- Git commit 只包含本阶段内容。

## 10. 如何使用 Helixent 参考源码

参考源码的正确用途是验证推理，而不是替代推理。

推荐顺序：

1. 根据接口、测试和不变量独立实现。
2. 写下你认为可能失败的边界情况。
3. 运行测试并修正。
4. 查看对应 Helixent 文件。
5. 对比两种实现的约束、复杂度和错误处理。
6. 保留你能解释的设计，不因“参考项目这样写”就机械改写。

当你的实现与参考不同，问三个问题：

- 两者是否满足同一条不变量？
- 你的实现在哪个输入下会失败？
- 参考实现承担了什么你暂时没有的兼容性约束？

## 11. 最终评测指标

从阶段 11 开始固定记录这些指标，阶段 15 才能形成可信的简历数据：

- `taskSuccessRate`：任务通过 grader 的比例；
- `averageSteps`：完成任务所需平均 Agent step；
- `averageToolCalls`：每个任务的 Tool 调用次数；
- `invalidToolCallRate`：参数校验失败或未知 Tool 比例；
- `inputTokens`、`outputTokens`、`totalTokens`；
- `wallTimeMs`、`modelTimeMs`、`toolTimeMs`；
- `recoverySuccessRate`：故障注入后成功恢复的比例；
- `contextCompressionRatio`：压缩后 token / 压缩前 token；
- `retryCount` 和按错误类型分类的失败数量。

不要预先填写漂亮数字。指标只有在任务集、模型参数、代码版本和运行环境都可复现时才有价值。

## 12. 课程完成标准

最终答辩时，你应当能在 20 分钟内完成以下演示：

1. 运行一个离线 scripted agent，解释 transcript 如何驱动 ReAct loop。
2. 运行真实 Coding Agent，展示审批和文件修改。
3. 打开一次 trace，定位最慢的 step 和失败 Tool。
4. 人为终止运行，再使用 `resume` 完成任务。
5. 使用 `replay` 在不请求模型的情况下复现 UI 时间线。
6. 运行小型 eval suite，展示两个配置的成功率、token 和耗时差异。
7. 解释 context compaction 为什么没有破坏 `tool_use` / `tool_result` 配对。

做到这些，你掌握的是可验证的 Agent 工程能力，而不只是调用模型 API。
