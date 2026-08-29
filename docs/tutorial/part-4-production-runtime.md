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

创建文件：

```bash
mkdir -p src/runtime/trace/__tests__ src/cli/commands examples
touch src/runtime/trace/events.ts src/runtime/trace/runtime-clock.ts
touch src/runtime/trace/redactor.ts src/runtime/trace/jsonl-trace-store.ts
touch src/runtime/trace/metrics.ts src/runtime/trace/index.ts
touch src/runtime/trace/__tests__/jsonl-trace-store.test.ts
touch src/runtime/trace/__tests__/metrics.test.ts src/runtime/trace/__tests__/runtime-trace.test.ts
touch src/cli/commands/trace.ts
touch examples/stage-11-trace.ts
```

### 11.1 Trace event schema

目标文件：`src/runtime/trace/events.ts`

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

目标文件：`src/runtime/trace/runtime-clock.ts`

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

把三项依赖作为 `Agent` 构造参数中的 `runtime` 传入；production composition root 提供默认
实现，单元测试显式传 fake：

```ts
runtime?: {
  clock: RuntimeClock;
  idGenerator: IdGenerator;
  traceSink: TraceSink;
}
```

### 11.3 为什么不能只靠 Middleware

Middleware 很适合扩展普通生命周期，但 tracing 还需要观察：

- hook 自身抛错；
- model 请求尚未返回就 abort；
- Tool validation 失败；
- `finally` 中的 run termination；
- 精确的开始和结束时间。

因此把 trace emitter 作为 runtime 的基础依赖，在关键 `try/catch/finally` 边界发事件；业务自定义字段仍可由 Middleware 补充。不要为了“所有东西都是插件”而丢失失败路径。

### 11.4 JSONL TraceStore

目标文件：`src/runtime/trace/redactor.ts`

```ts
export interface TraceRedactor {
  redact<T>(value: T): T;
}

export function createTraceRedactor(options: {
  maxStringCharacters: number;
  secretKeys?: string[];
}): TraceRedactor {
  // TODO 1：递归复制 object/array，匹配 secret key 时替换值，不修改输入。
  // TODO 2：超过 maxStringCharacters 的字符串截断，并追加明确的 truncated marker。
  throw new Error("TODO: implement createTraceRedactor");
}
```

目标文件：`src/runtime/trace/jsonl-trace-store.ts`

```ts
export class JsonlTraceStore implements TraceSink {
  constructor(options: {
    rootDir: string;
    redactor: TraceRedactor;
  }) {}

  async append(event: RuntimeTraceEvent): Promise<void> {
    // 标准实现示例：先做纯 redaction，再序列化；原 event 不能被修改。
    const redacted = this._redactor.redact(structuredClone(event));

    // TODO 1：校验 envelope 与 payload；失败错误必须包含 event.type。
    // TODO 2：按 runId 选择 `.harness/runs/<run-id>/trace.jsonl` 并创建父目录。
    // TODO 3：同一 run 通过单写队列串行 append；每行 JSON 以 "\n" 结束。
    // TODO 4：拒绝 sequence 倒退或重复，并报告 expected/actual。
  }

  async read(runId: string): Promise<RuntimeTraceEvent[]> {
    // TODO 5：逐行解析；空尾行忽略，错误必须报告 runId 和 1-based 行号。
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

目标文件：`src/runtime/trace/metrics.ts`

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
  // 标准实现示例：初始化零值，确保空 trace 也返回完整 shape。
  const metrics: RunMetrics = {
    steps: 0,
    modelCalls: 0,
    toolCalls: 0,
    failedToolCalls: 0,
    deniedToolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    modelTimeMs: 0,
    toolTimeMs: 0,
    approvalWaitMs: 0,
    wallTimeMs: 0,
  };

  // TODO 1：逐事件累加；同一个 model_end 的 usage 只能计一次。
  // TODO 2：toolTimeMs 是所有 tool_end.durationMs 之和，不与 wallTime 取 max。
  // TODO 3：run_end.durationMs 覆盖 wallTimeMs；没有 run_end 时保持 0。
  return metrics;
}
```

注意并发 Tool 的 `toolTimeMs` 总和可能大于 `wallTimeMs`。前者是所有 Tool span 之和，后者是用户等待的墙钟时间，两者不能混用。

### 11.6 Trace CLI

目标命令及示例调用：

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

### 11.7 完整测试

目标文件：`src/runtime/trace/__tests__/jsonl-trace-store.test.ts`

下面的测试使用临时目录并直接读取 JSONL，因此同时验证持久化格式。`createTraceRedactor`
必须返回纯 redactor，不修改传入事件。

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { JsonlTraceStore } from "../jsonl-trace-store";
import { createTraceRedactor } from "../redactor";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture() {
  root = await mkdtemp(join(tmpdir(), "harness-trace-"));
  return new JsonlTraceStore({
    rootDir: root,
    redactor: createTraceRedactor({ maxStringCharacters: 16 }),
  });
}

function event(sequence: number, payload: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    runId: "run-1",
    sequence,
    timestamp: "2026-01-01T00:00:00.000Z",
    type: "tool_end" as const,
    payload: {
      step: 1,
      toolUseId: "call-1",
      toolName: "read_file",
      durationMs: 2,
      status: "succeeded" as const,
      resultSummary: "ok",
      ...payload,
    },
  };
}

describe("JsonlTraceStore", () => {
  test("writes one parseable line per event in sequence order", async () => {
    const store = await fixture();
    await Promise.all([store.append(event(1)), store.append(event(2)), store.append(event(3))]);

    const path = join(root!, ".harness", "runs", "run-1", "trace.jsonl");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line).sequence)).toEqual([1, 2, 3]);
    expect(await store.read("run-1")).toHaveLength(3);
  });

  test("redacts secret keys, truncates large strings and keeps the source immutable", async () => {
    const store = await fixture();
    const source = event(1, {
      authorization: "Bearer secret",
      resultSummary: "abcdefghijklmnopqrstuvwxyz",
    });
    await store.append(source as never);

    const [saved] = await store.read("run-1");
    expect(JSON.stringify(saved)).not.toContain("Bearer secret");
    expect(JSON.stringify(saved)).toContain("truncated");
    expect(JSON.stringify(source)).toContain("Bearer secret");
  });

  test("rejects duplicate or decreasing sequence numbers", async () => {
    const store = await fixture();
    await store.append(event(1));
    await expect(store.append(event(1))).rejects.toThrow("expected 2");
  });

  test("reports the one-based line number of malformed JSONL", async () => {
    const store = await fixture();
    await store.append(event(1));
    const path = join(root!, ".harness", "runs", "run-1", "trace.jsonl");
    await appendFile(path, "{broken\n", "utf8");

    await expect(store.read("run-1")).rejects.toThrow("line 2");
  });
});
```

目标文件：`src/runtime/trace/__tests__/metrics.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import { reduceRunMetrics } from "../metrics";

function trace(type: string, payload: Record<string, unknown>, sequence: number) {
  return {
    schemaVersion: 1,
    runId: "run-1",
    sequence,
    timestamp: `2026-01-01T00:00:00.00${sequence}Z`,
    type,
    payload,
  } as never;
}

describe("reduceRunMetrics", () => {
  test("returns a stable zero shape for an empty trace", () => {
    expect(reduceRunMetrics([])).toEqual({
      steps: 0,
      modelCalls: 0,
      toolCalls: 0,
      failedToolCalls: 0,
      deniedToolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      modelTimeMs: 0,
      toolTimeMs: 0,
      approvalWaitMs: 0,
      wallTimeMs: 0,
    });
  });

  test("sums concurrent spans while keeping wall time independent", () => {
    const metrics = reduceRunMetrics([
      trace("step_end", { step: 1, durationMs: 80 }, 1),
      trace("model_end", {
        step: 1,
        durationMs: 40,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        toolCallCount: 2,
      }, 2),
      trace("tool_end", {
        step: 1, toolUseId: "a", toolName: "read_file", durationMs: 50,
        status: "succeeded", resultSummary: "A",
      }, 3),
      trace("tool_end", {
        step: 1, toolUseId: "b", toolName: "write_file", durationMs: 60,
        status: "denied", resultSummary: "B",
      }, 4),
      trace("approval_wait_end", { toolUseId: "b", decision: "deny", durationMs: 12 }, 5),
      trace("run_end", { status: "completed", durationMs: 100 }, 6),
    ]);

    expect(metrics).toMatchObject({
      steps: 1,
      modelCalls: 1,
      toolCalls: 2,
      deniedToolCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelTimeMs: 40,
      toolTimeMs: 110,
      approvalWaitMs: 12,
      wallTimeMs: 100,
    });
  });
});
```

目标文件：`src/runtime/trace/__tests__/runtime-trace.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { Agent } from "@/agent/agent";

import type { RuntimeTraceEvent } from "../events";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run" }],
};
const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};

function runtime(events: RuntimeTraceEvent[]) {
  let id = 0;
  let ms = 0;
  return {
    clock: {
      now: () => new Date(`2026-01-01T00:00:00.${String(ms).padStart(3, "0")}Z`),
      monotonicMs: () => ms++,
    },
    idGenerator: { next: () => `run-${++id}` },
    traceSink: { append: async (event: RuntimeTraceEvent) => void events.push(event) },
  };
}

async function drain(agent: Agent) {
  for await (const _event of agent.stream(USER)) {
    // consume
  }
}

describe("Agent runtime trace", () => {
  test("emits ordered transcript facts and a completed run_end", async () => {
    const events: RuntimeTraceEvent[] = [];
    const provider = new ScriptedModelProvider({
      responses: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "missing", input: {} }],
        },
        FINAL,
      ],
    });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [],
      runtime: runtime(events),
    });

    await drain(agent);
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(events.filter((event) => event.type === "message_appended")).toHaveLength(4);
    expect(events.find((event) =>
      event.type === "tool_end" && event.payload.toolUseId === "call-1",
    )).toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "run_end", payload: { status: "completed" } });
  });

  test("emits max_steps when the loop exhausts its budget", async () => {
    const events: RuntimeTraceEvent[] = [];
    const agent = new Agent({
      model: new Model({
        name: "scripted",
        provider: new ScriptedModelProvider({
          responses: [{
            role: "assistant",
            content: [{ type: "tool_use", id: "call-1", name: "missing", input: {} }],
          }],
        }),
      }),
      prompt: "",
      tools: [],
      maxSteps: 1,
      runtime: runtime(events),
    });

    await expect(drain(agent)).rejects.toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "run_end", payload: { status: "max_steps" } });
  });

  test("emits failed when the provider throws", async () => {
    const events: RuntimeTraceEvent[] = [];
    const provider = {
      invoke: async () => { throw new Error("provider failed"); },
      stream: async function* () { throw new Error("provider failed"); },
    };
    const agent = new Agent({
      model: new Model({ name: "broken", provider }),
      prompt: "",
      tools: [],
      runtime: runtime(events),
    });

    await expect(drain(agent)).rejects.toThrow("provider failed");
    expect(events.at(-1)).toMatchObject({ type: "run_end", payload: { status: "failed" } });
  });

  test("emits aborted when the active model request is cancelled", async () => {
    const events: RuntimeTraceEvent[] = [];
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const provider = {
      invoke: async () => FINAL,
      stream: async function* ({ signal }: { signal?: AbortSignal }) {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield FINAL;
      },
    };
    const agent = new Agent({
      model: new Model({ name: "blocking", provider }),
      prompt: "",
      tools: [],
      runtime: runtime(events),
    });

    const run = drain(agent);
    await modelStarted;
    agent.abort();
    await expect(run).rejects.toBeDefined();
    expect(events.at(-1)).toMatchObject({ type: "run_end", payload: { status: "aborted" } });
  });
});
```

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

创建文件：

```bash
mkdir -p src/runtime/checkpoint/__tests__ src/runtime/replay/__tests__
touch src/runtime/checkpoint/run-state.ts src/runtime/checkpoint/checkpoint-store.ts
touch src/runtime/checkpoint/file-checkpoint-store.ts src/runtime/checkpoint/resume-run.ts
touch src/runtime/checkpoint/fault-injector.ts src/runtime/checkpoint/index.ts
touch src/runtime/checkpoint/__tests__/file-checkpoint-store.test.ts
touch src/runtime/checkpoint/__tests__/resume-run.test.ts
touch src/runtime/replay/replay.ts src/runtime/replay/index.ts
touch src/runtime/replay/__tests__/replay.test.ts examples/stage-12-recovery.ts
```

### 12.1 RunState schema

目标文件：`src/runtime/checkpoint/run-state.ts`

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

目标文件：`src/runtime/checkpoint/checkpoint-store.ts` 和 `file-checkpoint-store.ts`

```ts
export interface CheckpointStore {
  save(state: RunState): Promise<void>;
  load(runId: string): Promise<RunState>;
  list(): Promise<RunStateSummary[]>;
}

export interface RunStateSummary {
  runId: string;
  status: RunState["status"];
  phase: RunState["phase"];
  nextStep: number;
  updatedAt: string;
}
```

目标文件：`src/runtime/checkpoint/file-checkpoint-store.ts`

```ts
export class FileCheckpointStore implements CheckpointStore {
  constructor(options: {
    rootDir: string;
    faultInjector?: FaultInjector;
  }) {
    // TODO 1：保存 rootDir/faultInjector；构造阶段不访问文件系统。
  }

  async save(state: RunState): Promise<void> {
    // TODO 2：校验 → 同目录临时文件 → flush/close → rename；同一 run 串行写入。
    throw new Error("TODO: implement FileCheckpointStore.save");
  }

  async load(runId: string): Promise<RunState> {
    // TODO 3：读取并校验 schema；错误包含 runId，不返回半个 checkpoint。
    throw new Error("TODO: implement FileCheckpointStore.load");
  }

  async list(): Promise<RunStateSummary[]> {
    // TODO 4：只返回 summary，按 updatedAt 稳定排序；跳过临时文件。
    throw new Error("TODO: implement FileCheckpointStore.list");
  }
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

目标文件：`src/runtime/checkpoint/resume-run.ts`

```ts
export type UnknownToolResolution = "retry" | "skip" | "ask_user";

export type UnknownToolResolver = (
  record: ToolExecutionRecord,
) => Promise<UnknownToolResolution>;

export async function resumeRun(options: {
  runId: string;
  checkpointStore: CheckpointStore;
  defineAgentFromState: (state: RunState) => Promise<Agent>;
  resolveUnknownTool: UnknownToolResolver;
  expected?: {
    cwd: string;
    projectFingerprint: string;
    modelOptionsFingerprint: string;
  };
}): Promise<void> {
  const state = await checkpointStore.load(runId);
  // 标准实现示例：completed run 是稳定终态，必须在创建 Agent 前拒绝。
  if (state.status === "completed") {
    throw new Error(`Run ${runId} is already completed`);
  }

  // TODO 1：按 schemaVersion migrate；未知新版拒绝读取，不能猜字段。
  // TODO 2：校验 cwd/project/model/tool registry fingerprint，列出每项差异。
  // TODO 3：恢复 transcript 和显式可序列化的 middleware state。
  // TODO 4：planned 可取消；running 在 crash 后先转 unknown，再调用 resolver。
  // TODO 5：只自动重试 resolver 判定 safe 的动作，然后从 nextStep 继续。
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

目标文件：`src/runtime/replay/replay.ts`

```ts
export async function replayTrace(options: {
  events: RuntimeTraceEvent[];
  onEvent: (event: RuntimeTraceEvent) => void | Promise<void>;
  speed?: number;
  noDelay?: boolean;
  signal?: AbortSignal;
}): Promise<void>;
```

这个公开契约故意不接收 ModelProvider、ToolRegistry 或 CheckpointStore，因此 replay 从类型
层面就是只读的；实现只按 sequence 排序、依据相邻 timestamp 计算延迟并调用 `onEvent`。

### 12.6 CLI

```bash
harness-lab run
harness-lab run list
harness-lab run inspect <run-id>
harness-lab resume <run-id>
harness-lab replay <run-id>
```

`inspect` 展示当前 phase、next step、最后一条 message、pending/unknown Tools、project fingerprint 差异。

### 12.7 完整恢复测试

实现 `FaultInjector`：

```ts
export interface FaultInjector {
  hit(point:
    | "after_model"
    | "before_tool"
    | "after_tool"
    | "before_checkpoint"
    | "after_temp_write"
  ): void;
}
```

在第 N 次 hit 抛出 `InjectedCrashError`。目标文件：
`src/runtime/checkpoint/__tests__/file-checkpoint-store.test.ts`

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RunState } from "../run-state";
import { FileCheckpointStore } from "../file-checkpoint-store";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

function state(nextStep: number): RunState {
  return {
    schemaVersion: 1,
    runId: "run-1",
    status: "running",
    phase: "idle",
    nextStep,
    prompt: "test",
    messages: [],
    model: { name: "test", provider: "scripted", optionsFingerprint: "model-v1" },
    cwd: "/fixture",
    projectFingerprint: "project-v1",
    toolExecutions: [],
    middlewareState: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function store(options: { crashAfterTempWrite?: boolean } = {}) {
  root = await mkdtemp(join(tmpdir(), "harness-checkpoint-"));
  return new FileCheckpointStore({
    rootDir: root,
    faultInjector: options.crashAfterTempWrite
      ? { hit: (point) => {
          if (point === "after_temp_write") throw new Error("injected crash");
        } }
      : undefined,
  });
}

describe("FileCheckpointStore", () => {
  test("round-trips a validated checkpoint and lists its summary", async () => {
    const checkpoints = await store();
    await checkpoints.save(state(2));

    expect(await checkpoints.load("run-1")).toEqual(state(2));
    expect(await checkpoints.list()).toMatchObject([{ runId: "run-1", nextStep: 2 }]);
  });

  test("keeps the previous checkpoint when a crash occurs before rename", async () => {
    const stable = await store();
    await stable.save(state(1));
    const crashing = new FileCheckpointStore({
      rootDir: root!,
      faultInjector: { hit: (point) => {
        if (point === "after_temp_write") throw new Error("injected crash");
      } },
    });

    await expect(crashing.save(state(2))).rejects.toThrow("injected crash");
    expect((await stable.load("run-1")).nextStep).toBe(1);
  });

  test("rejects unsupported future schema versions", async () => {
    const checkpoints = await store();
    await expect(checkpoints.save({ ...state(1), schemaVersion: 99 } as never))
      .rejects.toThrow("schemaVersion");
  });
});
```

目标文件：`src/runtime/checkpoint/__tests__/resume-run.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import type { RunState, ToolExecutionRecord } from "../run-state";
import { resumeRun } from "../resume-run";

function tool(status: ToolExecutionRecord["status"], effect: ToolExecutionRecord["effect"])
  : ToolExecutionRecord {
  return {
    toolUseId: `call-${status}-${effect}`,
    toolName: effect === "read" ? "read_file" : "write_file",
    input: {},
    effect,
    idempotency: effect === "read" ? "safe" : "unsafe",
    status,
  };
}

function state(overrides: Partial<RunState> = {}): RunState {
  return {
    schemaVersion: 1,
    runId: "run-1",
    status: "running",
    phase: "acting",
    nextStep: 2,
    prompt: "test",
    messages: [],
    model: { name: "test", provider: "scripted", optionsFingerprint: "model-v1" },
    cwd: "/fixture",
    projectFingerprint: "project-v1",
    toolExecutions: [],
    middlewareState: { todos: [] },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function dependencies(saved: RunState) {
  const resolved: string[] = [];
  let definedWith: RunState | undefined;
  return {
    resolved,
    definedWith: () => definedWith,
    options: {
      runId: saved.runId,
      checkpointStore: {
        load: async () => structuredClone(saved),
        save: async () => undefined,
        list: async () => [],
      },
      defineAgentFromState: async (value: RunState) => {
        definedWith = structuredClone(value);
        return { continueFromStep: async () => undefined } as never;
      },
      resolveUnknownTool: async (record: ToolExecutionRecord) => {
        resolved.push(record.toolUseId);
        return record.idempotency === "safe" ? "retry" : "ask_user";
      },
    },
  };
}

describe("resumeRun", () => {
  test("rejects a completed run before constructing an Agent", async () => {
    const fixture = dependencies(state({ status: "completed" }));
    await expect(resumeRun(fixture.options)).rejects.toThrow("already completed");
    expect(fixture.definedWith()).toBeUndefined();
  });

  test("does not revisit succeeded tools and resolves crash-time running tools", async () => {
    const fixture = dependencies(state({
      toolExecutions: [tool("succeeded", "write"), tool("running", "read"), tool("running", "write")],
    }));
    await resumeRun(fixture.options);

    expect(fixture.resolved).toEqual(["call-running-read", "call-running-write"]);
    expect(fixture.definedWith()?.toolExecutions[0]?.status).toBe("succeeded");
  });

  test("reports every fingerprint mismatch together", async () => {
    const fixture = dependencies(state());
    await expect(resumeRun({
      ...fixture.options,
      expected: {
        cwd: "/other",
        projectFingerprint: "project-v2",
        modelOptionsFingerprint: "model-v2",
      },
    })).rejects.toThrow(/cwd.*projectFingerprint.*modelOptionsFingerprint/s);
  });
});
```

目标文件：`src/runtime/replay/__tests__/replay.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import { replayTrace } from "../replay";

function event(sequence: number, text: string) {
  return {
    schemaVersion: 1,
    runId: "run-1",
    sequence,
    timestamp: `2026-01-01T00:00:00.00${sequence}Z`,
    type: "message_appended",
    payload: {
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  } as never;
}

describe("replayTrace", () => {
  test("replays in sequence order without mutating the input", async () => {
    const source = [event(2, "second"), event(1, "first")];
    const original = structuredClone(source);
    const seen: number[] = [];

    await replayTrace({
      events: source,
      noDelay: true,
      onEvent: (item) => void seen.push(item.sequence),
    });

    expect(seen).toEqual([1, 2]);
    expect(source).toEqual(original);
  });

  test("stops promptly when aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(replayTrace({
      events: [event(1, "first")],
      onEvent: () => undefined,
      signal: controller.signal,
    })).rejects.toBeDefined();
  });
});
```

示例故障演练还应手工覆盖 model 后/Tool 前、read/write Tool 中途和并发批次崩溃；上面
三个完整文件固定了最容易被实现错误破坏的自动化不变量：原子保存、unknown 分类、成功
动作不重访、完成态拒绝和 replay 只读。

### 验收

- [ ] checkpoint 原子写入；
- [ ] schema 有 version；
- [ ] Tool intent 在副作用前持久化；
- [ ] unknown 不被错误归类为 failed；
- [ ] replay 完全离线只读；
- [ ] Todo 等 middleware state 可恢复；
- [ ] `ADR-013` 解释为什么 arbitrary Tool 无法通用 exactly-once。

## 阶段 13：Context Budget、Compaction 与可靠性策略

创建文件：

```bash
mkdir -p src/runtime/context/__tests__ src/runtime/reliability/__tests__ src/runtime/policy/__tests__
touch src/runtime/context/token-estimator.ts src/runtime/context/message-groups.ts
touch src/runtime/context/context-manager.ts src/runtime/context/index.ts
touch src/runtime/context/__tests__/context-manager.test.ts
touch src/runtime/reliability/resilient-model-provider.ts src/runtime/reliability/tool-timeout.ts
touch src/runtime/reliability/__tests__/resilient-model-provider.test.ts
touch src/runtime/reliability/__tests__/tool-timeout.test.ts
touch src/runtime/policy/policy-engine.ts src/runtime/policy/__tests__/policy-engine.test.ts
touch examples/stage-13-context.ts examples/stage-13-retry.ts
```

### 13.1 Canonical transcript 与 Model view

恢复需要完整 canonical transcript，但模型不应永远接收全量历史。保持两个概念：

```text
AgentContext.messages  = 完整事实记录，用于 checkpoint/recovery
ModelContext.messages  = 本次调用的预算内视图
```

Context manager 只在 `beforeModel` 阶段生成 view，不原地删除 canonical messages。

### 13.2 TokenEstimator 与预算

目标文件：`src/runtime/context/token-estimator.ts`

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

目标文件：`src/runtime/context/message-groups.ts`

```ts
export function validateToolCallPairs(messages: NonSystemMessage[]): {
  ok: boolean;
  orphanToolUseIds: string[];
  orphanToolResultIds: string[];
};
```

每次 compaction 后都执行。

### 13.4 ContextManager

目标文件：`src/runtime/context/context-manager.ts`

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
  constructor(options: {
    estimator: TokenEstimator;
    summarizer: ConversationSummarizer;
  }) {}

  async prepare(options: {
    messages: NonSystemMessage[];
    prompt: string;
    tools: Tool[];
    budget: ContextBudget;
    signal?: AbortSignal;
  }): Promise<PreparedContext> {
    // 标准实现示例：复制输入，后续任何 compaction 都只操作副本。
    const canonicalMessages = structuredClone(options.messages);

    // TODO 1：计算 system prompt、Tool schema 和三项 budget 的固定成本。
    // TODO 2：先 group，再从最新 group 向前保留；不得逐 message 拆 tool exchange。
    // TODO 3：只把较旧 groups 交给 summarizer，并用明确 summary 边界包装。
    // TODO 4：仍超限时按最旧 group 删除；最新 user message 不得删除。
    // TODO 5：validateToolCallPairs；失败属于 runtime invariant error。
    // TODO 6：返回新 messages、完整 stats，并确认 options.messages 深度不变。
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

### 13.5 完整 Context 测试

目标文件：`src/runtime/context/__tests__/context-manager.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import type { NonSystemMessage } from "@/foundation/messages";

import { ContextManager } from "../context-manager";
import { validateToolCallPairs } from "../message-groups";

const estimator = {
  estimateText: (text: string) => text.length,
  estimateMessages: (messages: unknown[]) => JSON.stringify(messages).length,
  estimateTools: (tools: unknown[]) => JSON.stringify(tools).length,
};
const budget = {
  maxInputTokens: 260,
  reservedOutputTokens: 20,
  safetyMarginTokens: 20,
};

function transcript(): NonSystemMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: "old request ".repeat(8) }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
        { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "A" },
        { type: "tool_result", tool_use_id: "b", content: "B" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "latest constraint" }] },
  ];
}

describe("ContextManager", () => {
  test("returns equivalent content without mutating input when already in budget", async () => {
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "small" }] },
    ];
    const source = structuredClone(messages);
    const manager = new ContextManager({
      estimator,
      summarizer: { summarize: async () => "unused" },
    });

    const prepared = await manager.prepare({ messages, prompt: "p", tools: [], budget });
    expect(prepared.messages).toEqual(source);
    expect(messages).toEqual(source);
    expect(prepared.stats.summarizedGroups).toBe(0);
  });

  test("compacts atomic tool exchanges and keeps the latest user constraint", async () => {
    const messages = transcript();
    const source = structuredClone(messages);
    const manager = new ContextManager({
      estimator,
      summarizer: { summarize: async () => "older work summarized" },
    });

    const prepared = await manager.prepare({ messages, prompt: "p", tools: [], budget });
    expect(prepared.stats.preparedTokens).toBeLessThanOrEqual(220);
    expect(JSON.stringify(prepared.messages)).toContain("latest constraint");
    expect(validateToolCallPairs(prepared.messages)).toEqual({
      ok: true,
      orphanToolUseIds: [],
      orphanToolResultIds: [],
    });
    expect(messages).toEqual(source);
  });

  test("uses deterministic fallback when summarization fails", async () => {
    const manager = new ContextManager({
      estimator,
      summarizer: { summarize: async () => { throw new Error("summary failed"); } },
    });

    const first = await manager.prepare({ messages: transcript(), prompt: "p", tools: [], budget });
    const second = await manager.prepare({ messages: transcript(), prompt: "p", tools: [], budget });
    expect(first).toEqual(second);
    expect(first.stats.preparedTokens).toBeLessThanOrEqual(220);
  });

  test("propagates abort while the summarizer is running", async () => {
    const controller = new AbortController();
    const manager = new ContextManager({
      estimator,
      summarizer: {
        summarize: async (_groups, signal) => {
          controller.abort();
          signal?.throwIfAborted();
          return "unreachable";
        },
      },
    });

    await expect(manager.prepare({
      messages: transcript(), prompt: "p", tools: [], budget, signal: controller.signal,
    })).rejects.toBeDefined();
  });
});
```

示例输入是 `transcript()`；参数规则中的有效消息预算为 `260 - 20 - 20 = 220`，还要再
扣除 prompt 和 Tool schema 固定成本。示例断言不依赖某个 provider tokenizer，只依赖注入
的 deterministic estimator。

### 13.6 Model retry

目标文件：`src/runtime/reliability/resilient-model-provider.ts`

实现 `ResilientModelProvider` decorator：

```ts
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify(error: unknown): "transient" | "permanent" | "aborted";
}

export type RetrySleeper = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export class ResilientModelProvider implements ModelProvider {
  constructor(options: {
    provider: ModelProvider;
    policy: RetryPolicy;
    sleeper: RetrySleeper;
    jitter: () => number;
  }) {
    // TODO 1：保存依赖；构造阶段不调用 provider，也不启动 timer。
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    // TODO 2：按 policy 调用 provider.invoke；只重试 transient error。
    // TODO 3：每次等待使用 sleeper，并把 params.signal 原样传入。
    throw new Error("TODO: implement ResilientModelProvider.invoke");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // TODO 4：只在收到第一个 snapshot 前允许 retry；开始产出后不能静默重放响应。
    throw new Error("TODO: implement ResilientModelProvider.stream");
  }
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
export interface ToolRuntimeMetadata {
  effect: "read" | "write" | "process" | "network";
  idempotency: "safe" | "unsafe" | "unknown";
  defaultTimeoutMs: number;
}
```

- read-only、明确幂等 Tool 可以按策略 retry；
- write/process/network 默认不自动 retry；
- timeout 后如果无法确认副作用是否发生，状态为 `unknown`；
- timeout 和 abort 不能都归类为普通 execution failure。

目标文件：`src/runtime/reliability/tool-timeout.ts`

```ts
export async function invokeToolWithTimeout<T>(options: {
  invoke: (signal: AbortSignal) => Promise<T>;
  metadata: ToolRuntimeMetadata;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<
  | { status: "succeeded"; value: T }
  | { status: "aborted"; error: unknown }
  | { status: "timed_out" | "unknown"; error: unknown }
> {
  // TODO 1：组合 caller signal 与 timeout controller，并在 finally 清理 timer/listener。
  // TODO 2：caller abort → aborted；safe read timeout → timed_out；其他 effect → unknown。
  throw new Error("TODO: implement invokeToolWithTimeout");
}
```

### 13.8 PolicyEngine

把阶段 10 的 Tool-name allowlist 升级为：

目标文件：`src/runtime/policy/policy-engine.ts`

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

export class DefaultPolicyEngine implements PolicyEngine {
  constructor(options: {
    workspace: string;
    commandPrefixRules: string[][];
  }) {
    // TODO 1：保存规范化 workspace 和 prefix rules；不要执行 command。
  }

  async evaluate(input: {
    cwd: string;
    toolUse: ToolUseContent;
    metadata: ToolRuntimeMetadata;
  }): Promise<PolicyDecision> {
    // TODO 2：workspace 外 path 返回 deny；明确只读操作可 allow。
    // TODO 3：逐 token 匹配 command prefix；network/unknown shell 默认 ask。
    // TODO 4：所有分支返回非空 reason，供 trace 和审批 UI 使用。
    throw new Error("TODO: implement DefaultPolicyEngine.evaluate");
  }
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

### 13.9 完整可靠性与 Policy 测试

目标文件：`src/runtime/reliability/__tests__/resilient-model-provider.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import type { AssistantMessage } from "@/foundation/messages";

import { ResilientModelProvider } from "../resilient-model-provider";

const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};
const params = { model: "test", messages: [] };

function provider(failures: unknown[]) {
  let calls = 0;
  return {
    calls: () => calls,
    invoke: async () => {
      const failure = failures[calls++];
      if (failure) throw failure;
      return FINAL;
    },
    stream: async function* () {
      const failure = failures[calls++];
      if (failure) throw failure;
      yield FINAL;
    },
  };
}

const policy = {
  maxAttempts: 3,
  baseDelayMs: 10,
  maxDelayMs: 100,
  classify: (error: unknown) => {
    if (error instanceof DOMException && error.name === "AbortError") return "aborted" as const;
    return error instanceof Error && error.message === "transient"
      ? "transient" as const
      : "permanent" as const;
  },
};

describe("ResilientModelProvider", () => {
  test("retries only transient errors with deterministic backoff", async () => {
    const inner = provider([new Error("transient"), new Error("transient")]);
    const delays: number[] = [];
    const resilient = new ResilientModelProvider({
      provider: inner,
      policy,
      sleeper: async (delayMs) => void delays.push(delayMs),
      jitter: () => 0,
    });

    expect(await resilient.invoke(params)).toEqual(FINAL);
    expect(inner.calls()).toBe(3);
    expect(delays).toEqual([10, 20]);
  });

  test("does not retry permanent errors", async () => {
    const inner = provider([new Error("permanent")]);
    const resilient = new ResilientModelProvider({
      provider: inner,
      policy,
      sleeper: async () => undefined,
      jitter: () => 0,
    });

    await expect(resilient.invoke(params)).rejects.toThrow("permanent");
    expect(inner.calls()).toBe(1);
  });

  test("aborts during backoff without starting another attempt", async () => {
    const inner = provider([new Error("transient")]);
    const controller = new AbortController();
    const resilient = new ResilientModelProvider({
      provider: inner,
      policy,
      sleeper: async (_delayMs, signal) => {
        controller.abort();
        signal?.throwIfAborted();
      },
      jitter: () => 0,
    });

    await expect(resilient.invoke({ ...params, signal: controller.signal })).rejects.toBeDefined();
    expect(inner.calls()).toBe(1);
  });
});
```

目标文件：`src/runtime/policy/__tests__/policy-engine.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import { DefaultPolicyEngine } from "../policy-engine";

const workspace = "/workspace/project";
const engine = new DefaultPolicyEngine({
  workspace,
  commandPrefixRules: [["bun", "test"], ["git", "status"]],
});

function input(name: string, toolInput: Record<string, unknown>, effect: string) {
  return {
    cwd: workspace,
    toolUse: { type: "tool_use", id: "call-1", name, input: toolInput },
    metadata: { effect, idempotency: effect === "read" ? "safe" : "unknown", defaultTimeoutMs: 1000 },
  } as never;
}

describe("DefaultPolicyEngine", () => {
  test("allows workspace-local reads", async () => {
    expect(await engine.evaluate(input("read_file", { path: "src/a.ts" }, "read")))
      .toMatchObject({ action: "allow" });
  });

  test("denies paths outside the workspace", async () => {
    expect(await engine.evaluate(input("read_file", { path: "../secret" }, "read")))
      .toMatchObject({ action: "deny" });
  });

  test("allows an exact command prefix and asks for unclassified shell", async () => {
    expect(await engine.evaluate(input("bash", { command: "bun test src/a.test.ts" }, "process")))
      .toMatchObject({ action: "allow" });
    expect(await engine.evaluate(input("bash", { command: "curl https://example.test" }, "network")))
      .toMatchObject({ action: "ask" });
  });

  test("returns a non-empty reason for every decision", async () => {
    const decision = await engine.evaluate(input("write_file", { path: "a.ts" }, "write"));
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});
```

目标文件：`src/runtime/reliability/__tests__/tool-timeout.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import { invokeToolWithTimeout } from "../tool-timeout";

function metadata(effect: "read" | "write" | "process" | "network") {
  return {
    effect,
    idempotency: effect === "read" ? "safe" as const : "unknown" as const,
    defaultTimeoutMs: 5,
  };
}

describe("invokeToolWithTimeout", () => {
  test("returns a successful value", async () => {
    expect(await invokeToolWithTimeout({
      invoke: async () => "ok",
      metadata: metadata("read"),
    })).toEqual({ status: "succeeded", value: "ok" });
  });

  test("distinguishes a safe read timeout from an unknown write effect", async () => {
    const never = (signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });

    expect(await invokeToolWithTimeout({ invoke: never, metadata: metadata("read") }))
      .toMatchObject({ status: "timed_out" });
    expect(await invokeToolWithTimeout({ invoke: never, metadata: metadata("write") }))
      .toMatchObject({ status: "unknown" });
  });

  test("keeps a caller abort distinct from timeout", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("user abort", "AbortError"));
    expect(await invokeToolWithTimeout({
      invoke: async (signal) => {
        signal.throwIfAborted();
        return "unreachable";
      },
      metadata: metadata("process"),
      signal: controller.signal,
    })).toMatchObject({ status: "aborted" });
  });
});
```

Model retry 与 Tool timeout 使用不同测试文件，避免混淆网络请求重试和外部副作用恢复。

### 运行与观察

准备一个 30+ messages 的长 session fixture：

```bash
bun run examples/stage-13-context.ts
```

示例输出（数值取决于 fixture 与 estimator）：

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
