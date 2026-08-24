# 第四部分：可观测、可恢复与可靠运行

这一部分完成阶段 11～13，也是从“能运行的 Agent”走向“可工程化验证的 Harness”的关键。

三个概念先分开：

- **Trace**：解释发生了什么，面向人和指标；
- **Checkpoint**：保存继续运行所需的 canonical state；
- **Replay**：消费既有事件重建展示，不重新请求模型或执行 Tool。

不要直接把 console log 当作三者的共同实现。日志可以被截断和脱敏，不能天然承担恢复语义。

## 阶段 11：结构化 Observability

### 本阶段目标

每次 Agent run 都能回答：

- 哪个 model request 最慢？
- 哪个 Tool 失败，input validation 还是执行失败？
- 多少时间花在模型、Tool 和人工审批？
- 每个 step 使用多少 token？
- 为什么 run 最终停止？
- 哪一次 context 变换影响了实际发送给模型的内容？

### 11.1 Trace event schema

事件 envelope：

```ts
export interface TraceEvent<TType extends string, TPayload> {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  timestamp: string;
  type: TType;
  payload: TPayload;
}
```

定义 discriminated union：

```ts
export type RuntimeTraceEvent =
  | TraceEvent<"run_start", {
      agentName?: string;
      model: string;
      cwd: string;
      configFingerprint: string;
    }>
  | TraceEvent<"run_end", {
      status: "completed" | "failed" | "aborted" | "max_steps";
      durationMs: number;
      errorCode?: string;
    }>
  | TraceEvent<"step_start", { step: number }>
  | TraceEvent<"step_end", { step: number; durationMs: number }>
  | TraceEvent<"model_start", {
      step: number;
      messageCount: number;
      estimatedInputTokens?: number;
    }>
  | TraceEvent<"model_end", {
      step: number;
      durationMs: number;
      usage?: TokenUsage;
      toolCallCount: number;
    }>
  | TraceEvent<"message_appended", {
      step?: number;
      message: NonSystemMessage;
    }>
  | TraceEvent<"tool_start", {
      step: number;
      toolUseId: string;
      toolName: string;
      inputSummary: string;
    }>
  | TraceEvent<"tool_end", {
      step: number;
      toolUseId: string;
      toolName: string;
      durationMs: number;
      status: "succeeded" | "failed" | "denied" | "aborted";
      errorCode?: string;
      resultSummary: string;
    }>
  | TraceEvent<"approval_wait_start", { toolUseId: string; toolName: string }>
  | TraceEvent<"approval_wait_end", {
      toolUseId: string;
      decision: ApprovalDecision;
      durationMs: number;
    }>
  | TraceEvent<"context_prepared", {
      originalMessages: number;
      sentMessages: number;
      estimatedTokens: number;
      compacted: boolean;
    }>;
```

可以后续新增事件，但不能修改旧事件含义。`schemaVersion` 为未来 migration 留出空间。

### 11.2 注入 clock、id 和 sink

为了让测试 deterministic：

```ts
export interface RuntimeClock {
  now(): Date;
  monotonicMs(): number;
}

export interface IdGenerator {
  next(): string;
}

export interface TraceSink {
  append(event: RuntimeTraceEvent): Promise<void>;
}
```

Production 使用真实 clock 和 `crypto.randomUUID()`；测试使用递增 fake。不要在测试里断言真实时间或随机 UUID。

### 11.3 为什么不能只靠 Middleware

Middleware 很适合扩展普通生命周期，但 tracing 还需要观察：

- hook 自身抛错；
- model 请求尚未返回就 abort；
- Tool validation 失败；
- `finally` 中的 run termination；
- 精确的开始和结束时间。

因此把 trace emitter 作为 runtime 的基础依赖，在关键 `try/catch/finally` 边界发事件；业务自定义字段仍可由 Middleware 补充。不要为了“所有东西都是插件”而丢失失败路径。

### 11.4 JSONL TraceStore

```ts
export class JsonlTraceStore implements TraceSink {
  constructor(options: {
    rootDir: string;
    redactor: TraceRedactor;
  }) {}

  async append(event: RuntimeTraceEvent): Promise<void> {
    // TODO:
    // 1. validate event
    // 2. redact payload
    // 3. 一行一个 JSON，结尾换行
    // 4. 保证同一 run 的 sequence 有序
  }
}
```

建议位置：

```text
.harness/runs/<run-id>/trace.jsonl
```

不要记录：

- API key、authorization header；
- 完整隐藏 reasoning；
- 未限制大小的文件内容或 shell 输出；
- 配置文件中的 secret value；
- 用户明确标记为 sensitive 的内容。

`inputSummary` 和 `resultSummary` 应有长度上限。完整恢复状态由 checkpoint 保存，不依赖脱敏 trace。

`message_appended` 是 replay 的事实来源：user、assistant 和 tool message 每次进入 transcript 时都发一条。Redactor 可以替换敏感 text、thinking 和过长 Tool result，但必须保持合法的 canonical Message shape，使 replay 能重建一条脱敏后的 UI 时间线。它不用于 resume；resume 读取未被观测性裁剪的 checkpoint。

### 11.5 Metrics reducer

从 trace 纯函数派生指标：

```ts
export interface RunMetrics {
  steps: number;
  modelCalls: number;
  toolCalls: number;
  failedToolCalls: number;
  deniedToolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  modelTimeMs: number;
  toolTimeMs: number;
  approvalWaitMs: number;
  wallTimeMs: number;
}

export function reduceRunMetrics(events: RuntimeTraceEvent[]): RunMetrics {
  // TODO: 不读取 Agent 实例或全局状态
}
```

注意并发 Tool 的 `toolTimeMs` 总和可能大于 `wallTimeMs`。前者是所有 Tool span 之和，后者是用户等待的墙钟时间，两者不能混用。

### 11.6 Trace CLI

实现：

```bash
harness-lab trace list
harness-lab trace show <run-id>
harness-lab trace metrics <run-id>
```

`trace show` 以相对时间显示：

```text
RUN 8cf... model=... status=completed wall=1832ms
  +0ms     step 1
  +3ms       model  input≈824  output=63  920ms
  +926ms      tool read_file #call-1  ok 12ms
  +940ms    step 2
  +942ms      model  input≈1104 output=41  866ms
TOTAL tokens=2032 model=1786ms tools=12ms approval=0ms
```

### 必写测试

- sequence 从 1 单调递增；
- 同一 run 的 JSONL 可以逐行解析；
- redactor 删除常见 secret keys；
- 大 input/output 被截断并有 marker；
- success、failure、abort、maxSteps 都产生 `run_end`；
- transcript 每次变更产生一个顺序正确的 `message_appended`；
- 并发 Tool event correlation 不串 id；
- metrics reducer 正确处理并发 spans；
- malformed/truncated JSONL 给出可定位行号。

### 故障注入

让 TraceSink 在第 N 次 append 时抛错，并明确你的策略：

- 默认建议 tracing failure 不终止 Agent，但向 stderr 发 warning；
- 若开启 compliance mode，可选择 fail closed。

把策略写入配置和 ADR，不能静默丢失。

### 验收

- [ ] 每个 run 都有稳定 runId；
- [ ] 所有终止路径都有 `run_end`；
- [ ] trace 不包含 secret 和无限大 payload；
- [ ] 指标完全由 events 派生；
- [ ] 可以定位一次 Tool failure 的 step 和 call id；
- [ ] `ADR-012` 解释 trace 与 canonical state 的区别。

## 阶段 12：Checkpoint、Resume 与 Replay

### 本阶段的真实难点

保存 `messages.json` 很容易；难的是在副作用执行到一半时确定“发生过什么”。

考虑：runtime 已经启动 `bash`，进程完成了文件写入，但 Agent 在保存 Tool result 前崩溃。重启后如果直接重新执行 command，副作用可能发生两次。

对任意 shell command，通用 harness 无法保证 exactly-once。你的目标应该是：

- 对已确认完成的动作不重复执行；
- 对纯只读、幂等动作可以安全重试；
- 对结果未知的修改动作停止并请求人工决策；
- 明确记录运行状态，而不是假装一定能自动恢复。

### 12.1 RunState schema

```ts
export interface RunState {
  schemaVersion: 1;
  runId: string;
  status: "running" | "completed" | "failed" | "aborted";
  phase: "idle" | "thinking" | "acting";
  nextStep: number;
  prompt: string;
  messages: NonSystemMessage[];
  model: {
    name: string;
    provider: string;
    optionsFingerprint: string;
  };
  cwd: string;
  projectFingerprint: string;
  toolExecutions: ToolExecutionRecord[];
  middlewareState: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ToolExecutionRecord {
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  effect: "read" | "write" | "process" | "network";
  idempotency: "safe" | "unsafe" | "unknown";
  status: "planned" | "running" | "succeeded" | "failed" | "unknown";
  resultContent?: string;
  errorCode?: string;
}
```

`middlewareState` 只保存显式声明可序列化的 state，例如 Todo。不要直接序列化函数、SDK client、AbortController 或整个 Middleware object。

### 12.2 CheckpointStore

```ts
export interface CheckpointStore {
  save(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState>;
  list(): Promise<RunStateSummary[]>;
}
```

本地文件实现必须原子保存：

1. 序列化并校验 state；
2. 写入同目录临时文件；
3. flush/close；
4. rename 覆盖 `checkpoint.json`；
5. 失败时保留上一个完整 checkpoint。

位置：

```text
.harness/runs/<run-id>/checkpoint.json
```

不要原地 truncate 后再写；进程在写到一半时崩溃会同时失去新旧状态。

### 12.3 Write-ahead Tool intent

Tool 执行按以下协议：

```text
1. 保存 status=planned
2. 保存 status=running
3. 调用真实 Tool
4. 保存 status=succeeded/failed + result
5. 把 ToolMessage 追加 transcript
6. 再保存一次 checkpoint
```

如果进程在 2 和 4 之间死亡，恢复时把该记录视为 `unknown`，而不是假设 failed。

对同批次并发 Tool，每个 ToolExecutionRecord 独立推进。CheckpointStore 需要串行化写入，避免后完成的旧 snapshot 覆盖新状态。可以使用单写队列或 revision compare-and-swap。

### 12.4 Resume algorithm

```ts
export async function resumeRun(options: {
  runId: string;
  checkpointStore: CheckpointStore;
  defineAgentFromState: (state: RunState) => Promise<Agent>;
  resolveUnknownTool: UnknownToolResolver;
}): Promise<void> {
  // TODO:
  // 1. load + schema migrate
  // 2. 校验 cwd/project/model/tool registry fingerprint
  // 3. 恢复 transcript 和 middleware state
  // 4. 处理 planned/running/unknown Tool records
  // 5. 从 nextStep 继续
}
```

Unknown Tool resolver 的默认规则：

| Effect / idempotency | 默认恢复动作 |
|---|---|
| read + safe | 自动重试 |
| write + safe | 校验前置/后置条件后重试 |
| write/process + unsafe | 停止并询问用户 |
| network + unknown | 停止并询问用户 |

例如 `mkdir` 在 `recursive: true` 时可以设计为幂等；任意 `bash` 默认不是。

### 12.5 Replay

Replay 只读 `trace.jsonl`：

```bash
harness-lab replay <run-id>
harness-lab replay <run-id> --speed 2
harness-lab replay <run-id> --no-delay
```

Replay 禁止：

- 请求模型；
- 执行 Tool；
- 修改 checkpoint；
- 请求新的审批。

Replay 按 sequence 消费 `message_appended` 和 lifecycle events。它展示的是经过 redaction 的历史视图，不承诺恢复被隐藏的 secret 或超长 Tool 输出；精确继续运行属于 checkpoint/resume 的职责。

为测试这一点，注入会在调用时直接 throw 的 ModelProvider 和 ToolRegistry；replay 仍应成功。

### 12.6 CLI

```bash
harness-lab run
harness-lab run list
harness-lab run inspect <run-id>
harness-lab resume <run-id>
harness-lab replay <run-id>
```

`inspect` 展示当前 phase、next step、最后一条 message、pending/unknown Tools、project fingerprint 差异。

### 故障注入测试

实现 `FaultInjector`：

```ts
export interface FaultInjector {
  hit(point: "after_model" | "before_tool" | "after_tool" | "before_checkpoint"): void;
}
```

在第 N 次 hit 抛出 `InjectedCrashError`。至少验证：

- model 返回后、Tool 执行前崩溃；
- read Tool 执行中崩溃；
- write Tool 已产生副作用、结果未保存时崩溃；
- 多个并发 Tool 中一个完成后崩溃；
- checkpoint 临时文件写到一半崩溃；
- resume 后不会重复已确认成功的 Tool；
- unsafe unknown Tool 触发人工决策；
- completed run 不可再次 resume。

### 验收

- [ ] checkpoint 原子写入；
- [ ] schema 有 version；
- [ ] Tool intent 在副作用前持久化；
- [ ] unknown 不被错误归类为 failed；
- [ ] replay 完全离线只读；
- [ ] Todo 等 middleware state 可恢复；
- [ ] `ADR-013` 解释为什么 arbitrary Tool 无法通用 exactly-once。

## 阶段 13：Context Budget、Compaction 与可靠性策略

### 13.1 Canonical transcript 与 Model view

恢复需要完整 canonical transcript，但模型不应永远接收全量历史。保持两个概念：

```text
AgentContext.messages  = 完整事实记录，用于 checkpoint/recovery
ModelContext.messages  = 本次调用的预算内视图
```

Context manager 只在 `beforeModel` 阶段生成 view，不原地删除 canonical messages。

### 13.2 TokenEstimator 与预算

```ts
export interface TokenEstimator {
  estimateText(text: string): number;
  estimateMessages(messages: Message[]): number;
  estimateTools(tools: Tool[]): number;
}

export interface ContextBudget {
  maxInputTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
}
```

可用输入预算：

```text
available = maxInputTokens
          - reservedOutputTokens
          - safetyMarginTokens
          - systemPromptTokens
          - toolSchemaTokens
```

初版 estimator 可以用字符近似，但要把它标为 estimate，并与 provider-reported prompt tokens 记录偏差。不要把 TUI 的累计 usage 当成当前 context size。

### 13.3 原子消息分组

Compaction 不能逐条随意裁剪。先把 transcript 分组：

```ts
export interface MessageGroup {
  kind: "user_turn" | "assistant_final" | "tool_exchange";
  messages: NonSystemMessage[];
  estimatedTokens: number;
}
```

`tool_exchange` 至少包含：

- 产生一个或多个 `tool_use` 的 assistant message；
- 对应的全部 `tool_result` messages。

任何情况下都不能只保留 Tool result 或只保留 Tool call。

写一个 validator：

```ts
export function validateToolCallPairs(messages: NonSystemMessage[]): {
  ok: boolean;
  orphanToolUseIds: string[];
  orphanToolResultIds: string[];
};
```

每次 compaction 后都执行。

### 13.4 ContextManager

```ts
export interface PreparedContext {
  messages: NonSystemMessage[];
  stats: {
    originalTokens: number;
    preparedTokens: number;
    compressionRatio: number;
    summarizedGroups: number;
    droppedGroups: number;
  };
}

export interface ConversationSummarizer {
  summarize(groups: MessageGroup[], signal?: AbortSignal): Promise<string>;
}

export class ContextManager {
  async prepare(options: {
    messages: NonSystemMessage[];
    prompt: string;
    tools: Tool[];
    budget: ContextBudget;
    signal?: AbortSignal;
  }): Promise<PreparedContext> {
    // TODO:
    // 1. 计算固定成本
    // 2. 从最新 group 向前保留
    // 3. 对较旧 groups 生成 summary
    // 4. summary + recent groups 仍超限时按 group 删除
    // 5. 校验 tool call pairs
    // 6. 返回 stats，不修改原数组
  }
}
```

Summary 使用明确边界：

```text
<conversation_summary source="older_transcript">
- User goal: ...
- Confirmed constraints: ...
- Files changed: ...
- Failed approaches: ...
- Outstanding work: ...
</conversation_summary>
```

Summary 不应伪装成新的用户指令。保留最新用户消息、尚未解决的约束和最近 Tool exchange 原文。

### 13.5 Compaction 测试

- 输入未超预算时 messages 引用或内容不变；
- 超预算时 prepared tokens 在预算内；
- canonical transcript 未改变；
- 最近用户消息始终保留；
- Tool call/result 永不孤立；
- 多 Tool 单 assistant message 作为同一原子组；
- summarizer 失败时有 deterministic fallback；
- summary 自身超预算时安全截断；
- abort summarizer 后 run 正确结束；
- trace 记录 compression stats。

### 13.6 Model retry

实现 `ResilientModelProvider` decorator：

```ts
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify(error: unknown): "transient" | "permanent" | "aborted";
}
```

只对 transient error 自动 retry，例如 rate limit、部分 5xx 和瞬时 network error。以下情况不 retry：

- auth/permission error；
- invalid request/context too long；
- schema/converter bug；
- user abort。

退避：

```text
delay = min(maxDelay, baseDelay * 2^(attempt-1)) + jitter
```

等待必须可被 `AbortSignal` 中止。测试注入 fake sleeper，不能真的 sleep 数秒。

### 13.7 Tool timeout 和 idempotency

给 Tool metadata 增加：

```ts
interface ToolRuntimeMetadata {
  effect: "read" | "write" | "process" | "network";
  idempotency: "safe" | "unsafe" | "unknown";
  defaultTimeoutMs: number;
}
```

- read-only、明确幂等 Tool 可以按策略 retry；
- write/process/network 默认不自动 retry；
- timeout 后如果无法确认副作用是否发生，状态为 `unknown`；
- timeout 和 abort 不能都归类为普通 execution failure。

### 13.8 PolicyEngine

把阶段 10 的 Tool-name allowlist 升级为：

```ts
export type PolicyDecision =
  | { action: "allow"; reason: string }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string };

export interface PolicyEngine {
  evaluate(input: {
    cwd: string;
    toolUse: ToolUseContent;
    metadata: ToolRuntimeMetadata;
  }): Promise<PolicyDecision>;
}
```

至少考虑：

- Tool effect；
- path 是否在 workspace；
- command 是否命中明确 prefix rule；
- 是否包含 network access；
- 是否覆盖已有文件；
- project-local persistence rule；
- unknown 输入默认 ask 或 deny。

不要尝试用几条正则“证明任意 shell command 安全”。复杂 shell 的静态分析不可靠；无法分类时请求审批。

### 运行与观察

准备一个 30+ messages 的长 session fixture：

```bash
bun run examples/stage-13-context.ts
```

输出：

```text
original: 42 messages, estimated 18,420 tokens
prepared: 11 messages, estimated 7,311 tokens
summary:  28 groups → 1 summary
pairs:    valid
ratio:    39.7%
```

再运行失败注入：

```bash
bun run examples/stage-13-retry.ts --fail-first 2
```

应显示 attempt、error class、backoff 和最终成功；abort 时不得继续下一次 attempt。

### 验收

- [ ] canonical transcript 不因 compaction 丢失；
- [ ] model view 始终满足预算；
- [ ] Tool call/result 配对 validator 全通过；
- [ ] retry 只处理 transient model error；
- [ ] unsafe Tool 不自动 retry；
- [ ] policy decision 和原因进入 trace；
- [ ] `ADR-014` 解释完整 transcript 与 budgeted view 的分离；
- [ ] `ADR-015` 解释 retry 与副作用幂等性的关系。

## 第四部分综合故障演练

用一个 scripted scenario 连续注入：

1. 第一次 model call 返回 transient error；
2. 第二次成功并发出两个 Tool calls；
3. read Tool 成功；
4. write Tool 产生副作用后注入 crash；
5. resume 检测 unknown write Tool 并询问用户；
6. 用户确认副作用已发生；
7. context 超预算，触发 compaction；
8. run 最终完成。

最后使用三个命令验证：

```bash
harness-lab trace show <run-id>
harness-lab run inspect <run-id>
harness-lab replay <run-id> --no-delay
```

如果 trace 能解释故障、checkpoint 能恢复、replay 不产生新副作用，你已经完成“可观测、可恢复”的闭环。
