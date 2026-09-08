# 第四部分：可观测、可恢复与可靠运行

这一部分完成阶段 11～13，也是从“能运行的 Agent”走向“可工程化验证的 Harness”的关键。

三个概念先分开：

- **Trace**：解释发生了什么，面向人和指标；
- **Checkpoint**：保存继续运行所需的 canonical state；
- **Replay**：消费既有事件重建展示，不重新请求模型或执行 Tool。

不要直接把 console log 当作三者的共同实现。日志可以被截断和脱敏，不能天然承担恢复语义。

## 阶段 11：结构化 Observability

> 上一阶段回顾：阶段 10 交付了可交互 TUI、模型配置、token 展示和人工审批边界，形成了可用的基础版本。

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
mkdir -p src/foundation/runtime src/runtime/trace/__tests__ src/cli/commands examples
touch src/foundation/runtime/trace-events.ts src/foundation/runtime/agent-runtime.ts
touch src/runtime/trace/redactor.ts src/runtime/trace/jsonl-trace-store.ts
touch src/runtime/trace/metrics.ts src/runtime/trace/index.ts
touch src/runtime/trace/__tests__/jsonl-trace-store.test.ts
touch src/runtime/trace/__tests__/metrics.test.ts src/runtime/trace/__tests__/runtime-trace.test.ts
touch src/cli/commands/trace.ts
touch examples/stage-11-trace.ts
```

执行后新增结构如下：

```text
src/
├── foundation/runtime/
│   ├── trace-events.ts                 # 通用 trace 事件契约，不依赖 coding
│   └── agent-runtime.ts                # clock、id generator 与 trace sink 接口
├── runtime/trace/
│   ├── redactor.ts                     # 复制并脱敏敏感或过长字段
│   ├── jsonl-trace-store.ts            # 按 run 顺序持久化和读取 JSONL trace
│   ├── metrics.ts                      # 从事件纯函数归约运行指标
│   ├── index.ts                        # 导出 observability 公共 API
│   └── __tests__/
│       ├── jsonl-trace-store.test.ts   # 验证落盘、顺序和解析错误
│       ├── metrics.test.ts             # 验证指标归约与空 trace
│       └── runtime-trace.test.ts       # 验证 Agent 关键路径事件完整性
└── cli/commands/
    └── trace.ts                        # 提供查看 trace 与指标的 CLI 命令
examples/
└── stage-11-trace.ts                   # 演示生成并检查一次结构化 trace
```

### 11.1 Trace event schema

依赖方向保持为 `agent → foundation`。`foundation/runtime` 只定义事件、时钟和持久化
接口；`runtime/trace`、`runtime/checkpoint` 实现这些接口，CLI/eval 在 composition root
创建实现并注入 Agent。恢复编排可以调用 Agent，Agent 不反向导入恢复编排或文件存储。
审批决策类型同样来自 `foundation/permissions`，避免 trace 将通用 Agent 耦合到 coding。

目标文件：`src/foundation/runtime/trace-events.ts`

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

<details>
<summary>展开完整代码：<code>trace-events.ts</code></summary>

```ts
import type { ApprovalDecision } from "@/foundation/permissions/approval-decision";
import type { NonSystemMessage, TokenUsage } from "@/foundation/messages";

export interface TraceEvent<TType extends string, TPayload> {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  timestamp: string;
  type: TType;
  payload: TPayload;
}

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

</details>

可以后续新增事件，但不能修改旧事件含义。`schemaVersion` 为未来 migration 留出空间。

### 11.2 注入 clock、id 和 sink

为了让测试 deterministic：

目标文件：`src/foundation/runtime/agent-runtime.ts`

```ts
import type { RuntimeTraceEvent } from "@/foundation/runtime/trace-events";

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

export interface AgentRuntime {
  clock: RuntimeClock;
  idGenerator: IdGenerator;
  traceSink: TraceSink;
}
```

Production 使用真实 clock 和 `crypto.randomUUID()`；测试使用递增 fake。不要在测试里断言真实时间或随机 UUID。

把三项依赖作为 `Agent` 构造参数中的 `runtime` 传入；production composition root 提供默认
实现，单元测试显式传 fake：

目标文件：`src/agent/agent.ts`

```ts
import type { AgentRuntime } from "@/foundation/runtime/agent-runtime";

// Agent class 内：
private readonly _runtime?: AgentRuntime;

// constructor options 内：
runtime?: AgentRuntime;

// constructor body 内：
this._runtime = options.runtime;
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
import type { RuntimeTraceEvent } from "@/foundation/runtime/trace-events";
import type { TraceSink } from "@/foundation/runtime/agent-runtime";

import type { TraceRedactor } from "./redactor";

export class JsonlTraceStore implements TraceSink {
  private readonly _rootDir: string;
  private readonly _redactor: TraceRedactor;

  constructor(options: {
    rootDir: string;
    redactor: TraceRedactor;
  }) {
    this._rootDir = options.rootDir;
    this._redactor = options.redactor;
  }

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
    throw new Error(`TODO: implement JsonlTraceStore.read for ${runId}`);
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

<details>
<summary>展开完整代码：<code>metrics.ts</code></summary>

```ts
import type { RuntimeTraceEvent } from "@/foundation/runtime/trace-events";

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

</details>

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

### 11.7 Trace 示例

目标文件：`examples/stage-11-trace.ts`

示例运行一次离线 Tool loop，把 trace 保存到当前 workspace 的 `.harness/runs/`，随后
重新读取 JSONL 并从事件计算指标。使用唯一 run id，重复运行不会覆盖旧记录。

<details>
<summary>展开完整代码：<code>stage-11-trace.ts</code></summary>

```ts
import { join } from "node:path";

import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";
import { JsonlTraceStore } from "@/runtime/trace/jsonl-trace-store";
import { reduceRunMetrics } from "@/runtime/trace/metrics";
import { createTraceRedactor } from "@/runtime/trace/redactor";

const runId = `stage-11-${Date.now()}`;
const cwd = process.cwd();
const traceStore = new JsonlTraceStore({
  rootDir: cwd,
  redactor: createTraceRedactor({ maxStringCharacters: 2_000 }),
});
const responses: AssistantMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "inspect-1",
        name: "inspect_fixture",
        input: { description: "inspect deterministic fixture" },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "fixture inspected" }],
    usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
  },
];
const inspectTool = defineTool({
  name: "inspect_fixture",
  description: "Inspect a deterministic in-memory fixture",
  parameters: z.object({ description: z.string() }),
  invoke: async () => ({ files: 1, status: "clean" }),
});
const runtime = {
  clock: {
    now: () => new Date(),
    monotonicMs: () => performance.now(),
  },
  idGenerator: { next: () => runId },
  traceSink: traceStore,
};
const agent = new Agent({
  model: new Model({
    name: "scripted",
    provider: new ScriptedModelProvider({ responses }),
  }),
  prompt: "Inspect the fixture, then answer.",
  tools: [inspectTool],
  runtime,
});
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "inspect" }],
};

for await (const _event of agent.stream(userMessage)) {
  // Trace 由 runtime sink 在关键边界记录。
}

const events = await traceStore.read(runId);
for (const event of events) {
  console.log(`${event.sequence}\t${event.type}\t${event.timestamp}`);
}

console.log(JSON.stringify(reduceRunMetrics(events), null, 2));
console.log(`trace=${join(cwd, ".harness", "runs", runId, "trace.jsonl")}`);
```

</details>

运行后可直接用阶段 11 CLI 查看同一个 run：

```bash
bun run examples/stage-11-trace.ts
harness-lab trace list
```

### 故障注入

让 TraceSink 在第 N 次 append 时抛错，并明确你的策略：

- 默认建议 tracing failure 不终止 Agent，但向 stderr 发 warning；
- 若开启 compliance mode，可选择 fail closed。

把策略写入配置和 ADR，不能静默丢失。

### 11.8 完整测试

目标文件：`src/runtime/trace/__tests__/jsonl-trace-store.test.ts`

下面的测试使用临时目录并直接读取 JSONL，因此同时验证持久化格式。`createTraceRedactor`
必须返回纯 redactor，不修改传入事件。

<details>
<summary>展开完整代码：<code>jsonl-trace-store.test.ts</code></summary>

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

</details>

目标文件：`src/runtime/trace/__tests__/metrics.test.ts`

<details>
<summary>展开完整代码：<code>metrics.test.ts</code></summary>

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

</details>

目标文件：`src/runtime/trace/__tests__/runtime-trace.test.ts`

<details>
<summary>展开完整代码：<code>runtime-trace.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { Agent } from "@/agent/agent";

import type { RuntimeTraceEvent } from "@/foundation/runtime/trace-events";

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

</details>

最后执行本阶段的完整测试：

```bash
bun test src/runtime/trace
```

### 验收

- [ ] 每个 run 都有稳定 runId；
- [ ] 所有终止路径都有 `run_end`；
- [ ] trace 不包含 secret 和无限大 payload；
- [ ] 指标完全由 events 派生；
- [ ] 可以定位一次 Tool failure 的 step 和 call id；
- [ ] `ADR-012` 解释 trace 与 canonical state 的区别。

## 阶段 12：Checkpoint、Resume 与 Replay

> 上一阶段回顾：阶段 11 建立了结构化 trace、JSONL 存储、指标 reducer 和查询 CLI，使一次 Agent run 可以被定位和解释。

### 本阶段的真实难点

保存 `messages.json` 很容易；难的是在副作用执行到一半时确定“发生过什么”。

考虑：runtime 已经启动 `bash`，进程完成了文件写入，但 Agent 在保存 Tool result 前崩溃。重启后如果直接重新执行 command，副作用可能发生两次。

对任意 shell command，通用 harness 无法保证 exactly-once。你的目标应该是：

- 对已确认完成的动作不重复执行；
- 对纯只读、幂等动作可以安全重试；
- 对结果未知的修改动作停止并请求人工决策；
- 明确记录运行状态，而不是假装一定能自动恢复。

**开始 checkpoint/resume 实现前，先完成下面的 12.0。** 阶段 6 保留的并发取消缺口，会让已完成副作用缺少 observation；若此时直接保存 checkpoint，恢复代码可能把它误判为需要重试的动作。

创建文件：

```bash
mkdir -p src/runtime/checkpoint/__tests__ src/runtime/replay/__tests__
touch src/agent/__tests__/tool-cancellation-boundary.test.ts
touch src/foundation/runtime/run-state.ts src/foundation/runtime/checkpoint-store.ts
touch src/runtime/checkpoint/file-checkpoint-store.ts src/runtime/checkpoint/resume-run.ts
touch src/foundation/runtime/fault-injector.ts src/foundation/runtime/agent-checkpoint.ts
touch src/runtime/checkpoint/index.ts
touch src/runtime/checkpoint/__tests__/file-checkpoint-store.test.ts
touch src/runtime/checkpoint/__tests__/resume-run.test.ts
touch src/runtime/checkpoint/__tests__/recovery-integration.test.ts
touch examples/recovery-scenario.ts
touch src/runtime/replay/replay.ts src/runtime/replay/index.ts
touch src/runtime/replay/__tests__/replay.test.ts examples/stage-12-recovery.ts
```

执行后新增结构如下：

```text
src/agent/__tests__/
└── tool-cancellation-boundary.test.ts  # 进入恢复实现前验证并发取消与迟到任务隔离
src/foundation/runtime/
├── run-state.ts                       # 可恢复的 canonical state 契约
├── checkpoint-store.ts                # checkpoint 持久化接口
├── agent-checkpoint.ts                # Agent 接收的状态与持久化依赖
└── fault-injector.ts                  # 可注入故障点与异常类型
src/runtime/
├── checkpoint/
│   ├── file-checkpoint-store.ts        # 原子写入并读取文件 checkpoint
│   ├── resume-run.ts                   # 校验状态并从安全边界恢复运行
│   ├── index.ts                        # 导出 checkpoint 公共 API
│   └── __tests__/
│       ├── file-checkpoint-store.test.ts # 验证原子写入与损坏文件处理
│       ├── resume-run.test.ts          # 验证恢复决策与 observation 对账
│       └── recovery-integration.test.ts # 用真实 Agent 验证副作用不重复
└── replay/
    ├── replay.ts                       # 从既有 trace 重建脱敏后的展示时间线
    ├── index.ts                        # 导出 replay 公共 API
    └── __tests__/
        └── replay.test.ts              # 验证 replay 不调用模型或重复执行 Tool
examples/
├── recovery-scenario.ts                # 实际执行计数器写入、中断与续跑
└── stage-12-recovery.ts                # 演示故障注入、checkpoint 与恢复
```

### 12.0 先补齐并发取消边界

这一步承接[阶段 6 的已知边界](./part-2-agent-runtime.md)。先完善现有 `_act()` 的结果收集与关闭协议，再实现 12.1 以后的 checkpoint；到 12C 恢复并发时继续运行这里的回归测试，不能用暂时改成顺序执行来绕过验收。

需要明确三个不同状态：

- **执行中**：Tool 或 hook 尚未交付结果，不能认定副作用没有发生。
- **结果已就绪**：完整 ToolMessage 已交给 runtime 的结果队列，但可能尚未追加到 transcript。
- **已记录**：observation 已追加一次；接入 checkpoint 后，还要区分内存记录与持久化成功。

建议让每个 run 拥有自己的 pending 集合、已完成结果队列和关闭状态。任务完成时只交付给本次 run 的结果队列，由统一的消费位置追加 transcript；`yield` 只负责展示，不应决定哪些已完成结果能够被保存。

取消关闭按以下顺序设计：

1. 停止启动新的模型请求和 Tool，将 signal 传给正在执行的可中止操作。
2. 固定关闭边界，保存边界前已经交付给 runtime 的结果，每个 `tool_use_id` 最多追加一次。已取得结果但仍在执行必要 `afterToolUse` 收尾的任务，要在 ADR 中明确收尾策略；若无法确认结果，不得假装其副作用未发生。
3. 不为所有未完成任务无限等待。为每个在途 Promise 保留 rejection handler，移除已不用的 abort listener，并按明确策略处理无法及时停止的任务。
4. run 关闭后，迟到结果以及 Middleware 返回的更新不能再修改该 run 的 transcript/context；也不能进入下一次 run。需要 run 身份和写入开关，不能只依赖容易被新 run 重置的 `_streaming` 布尔值。
5. 完成以上记录与隔离后，再执行最终 `afterAgentRun`、发 `run_end` 并复位运行状态。用户取消不等于进程崩溃；关闭边界之后才收到的未知副作用，在接入持久化后按 12.3/12.4 的 execution record 对账。

目标文件：`src/agent/__tests__/tool-cancellation-boundary.test.ts`。先填入下面的回归：

<details>
<summary>展开首个回归用例：<code>tool-cancellation-boundary.test.ts</code></summary>

```ts
import { expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider } from "@/foundation/models/model-provider";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";

test("records both ready tool results before cancellation cleanup", async () => {
  const names = ["first", "second"];
  let toolCalls = 0;
  let afterToolCalls = 0;
  let modelCalls = 0;
  let afterRunCount = 0;
  let idsSeenAtCleanup: string[] = [];
  const call: AssistantMessage = {
    role: "assistant",
    content: names.map((name) => ({
      type: "tool_use", id: name, name, input: { description: "verify parallel completion" },
    })),
  };
  const provider: ModelProvider = {
    async invoke(): Promise<AssistantMessage> {
      modelCalls += 1;
      return modelCalls === 1
        ? structuredClone(call)
        : { role: "assistant", content: [{ type: "text", text: "done" }] };
    },
    async *stream(params) { yield await this.invoke(params); },
  };
  const agent = new Agent({
    model: new Model({ name: "cancellation-probe", provider }),
    prompt: "test",
    tools: names.map((name) => defineTool({
      name,
      description: "Return a completed result",
      parameters: z.object({ description: z.string() }),
      invoke: async () => { toolCalls += 1; return `${name} completed`; },
    })),
    middlewares: [{
      afterToolUse: async () => { afterToolCalls += 1; },
      afterAgentRun: async ({ agentContext }) => {
        afterRunCount += 1;
        // 验证结果在最终收尾前已记录，而不是 run 结束后才由后台任务补写。
        idsSeenAtCleanup = agentContext.messages
          .filter((message) => message.role === "tool")
          .flatMap((message) => message.content.map((content) => content.tool_use_id));
      },
    }],
  });
  const user: UserMessage = { role: "user", content: [{ type: "text", text: "run" }] };
  const run = (async () => {
    for await (const event of agent.stream(user)) {
      if (event.type === "message" && event.message.role === "tool") {
        // 两个动作和它们的结果 hooks 均已完成，才触发本例的取消边界。
        expect(toolCalls).toBe(2);
        expect(afterToolCalls).toBe(2);
        agent.abort();
      }
    }
  })();

  await expect(run).rejects.toMatchObject({ name: "AbortError" });
  expect(modelCalls).toBe(1);
  expect(afterRunCount).toBe(1);
  expect(idsSeenAtCleanup).toHaveLength(2);
  expect(new Set(idsSeenAtCleanup)).toEqual(new Set(names));
  expect(agent.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  expect(agent.streaming).toBe(false);
});
```

</details>

在阶段 6 的基础 pending-set 实现上，这个用例预期失败：两个 Tool 都完成，但通常只有第一条 observation 被保存。修复后它必须通过，不能通过让消费者忽略取消或重新执行 Tool 来凑齐结果。

还必须在同一文件补齐下面两项用例。使用阶段 6 的手动 Promise gate 控制时序；测试中只给“是否能结束”设置宽松超时兜底，并在 `finally` 释放 gate，避免失败后遗留悬挂任务。

| 必补用例 | 如何构造 | 断言 |
|---|---|---|
| 一个结果完成，另一个 Tool 不响应 signal | fast Tool 返回结果；slow Tool 等待手动 gate；收到 fast observation 后取消，先等 run 结束，再释放 slow | fast observation 恰好一条；不无限等待 slow；最终收尾一次；slow 迟到后不再调用会修改状态的 hook，不改变已关闭 run 或新 run |
| 取消时仍有 `beforeToolUse` 等待 | 一个 Tool 已完成；另一个 Tool 的 `beforeToolUse` 等 gate，释放后返回 `{ prompt: "late update" }` | 取消结束后释放 gate，真实 Tool 执行次数仍为 0；迟到的返回值未合并进 context；没有未处理的 Promise rejection |

运行并通过这三项回归后，再继续 12.1：

```bash
bun test src/agent/__tests__/tool-cancellation-boundary.test.ts
bun test src/agent/__tests__/host-hooks.test.ts src/agent/__tests__/middleware.test.ts
```

在 `ADR-013` 写明：结果何时算“已交付”、取消关闭边界如何确定、迟到任务如何隔离、无法确定结果的动作如何转为 unknown。通过内存队列测试不代表结果已经耐受进程崩溃；后续仍必须实现 intent、原子 checkpoint 和恢复对账。

### 12.1 RunState schema

目标文件：`src/foundation/runtime/run-state.ts`

<details>
<summary>展开完整代码：<code>run-state.ts</code></summary>

```ts
import type { NonSystemMessage } from "@/foundation/messages";

export interface RunState {
  schemaVersion: 1;
  runId: string;
  status: "running" | "completed" | "failed" | "aborted";
  phase: "idle" | "thinking" | "acting";
  nextStep: number;
  maxSteps: number;
  toolsetFingerprint: string;
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

</details>

`middlewareState` 只保存显式声明可序列化的 state，例如 Todo。不要直接序列化函数、SDK client、AbortController 或整个 Middleware object。

### 12.2 CheckpointStore

目标文件：`src/foundation/runtime/checkpoint-store.ts` 和 `file-checkpoint-store.ts`

故障注入契约放在 `src/foundation/runtime/fault-injector.ts`：

```ts
export class InjectedCrashError extends Error {
  constructor({ point }: { point: string }) {
    super(`Injected crash at ${point}`);
    this.name = "InjectedCrashError";
  }
}

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

实现应支持在第 N 次 `hit` 抛出 `InjectedCrashError`，供示例和最终恢复测试注入确定性故障。

目标文件：`src/foundation/runtime/checkpoint-store.ts`

```ts
import type { RunState } from "@/foundation/runtime/run-state";

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
import type { CheckpointStore, RunStateSummary } from "@/foundation/runtime/checkpoint-store";
import type { FaultInjector } from "@/foundation/runtime/fault-injector";
import type { RunState } from "@/foundation/runtime/run-state";

export class FileCheckpointStore implements CheckpointStore {
  private readonly _rootDir: string;
  private readonly _faultInjector?: FaultInjector;

  constructor(options: {
    rootDir: string;
    faultInjector?: FaultInjector;
  }) {
    // 构造阶段只保存依赖，不访问文件系统。
    this._rootDir = options.rootDir;
    this._faultInjector = options.faultInjector;
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

### 12.4 把恢复入口接回真实 Agent

先完成 12A（单 Tool 的中断续跑），再做 12B（未知修改动作的人工确认），最后做 12C
（并发批次）。不要只实现 `load()` 就把本阶段标为完成。

12.1 的 `RunState.maxSteps` 和 `toolsetFingerprint` 分别固定运行预算与 Tool 配置。
恢复沿用原始总步数上限，不能每次重启都重新获得一份预算。

新建 `src/foundation/runtime/agent-checkpoint.ts`：

```ts
import type { CheckpointStore } from "./checkpoint-store";
import type { FaultInjector } from "./fault-injector";
import type { RunState, ToolExecutionRecord } from "./run-state";

export interface AgentCheckpoint {
  state: RunState;
  store: CheckpointStore;
  toolMetadata: Record<string, Pick<ToolExecutionRecord, "effect" | "idempotency">>;
  snapshotMiddlewareState?: () => Record<string, unknown>;
  faultInjector?: FaultInjector;
}
```

给 `Agent` constructor options 增加 `checkpoint?: AgentCheckpoint`，复制 `checkpoint.state`。
有 checkpoint 时，从其 `prompt/messages/maxSteps` 恢复 Agent；不要再追加用户消息。
`middlewareState` 的恢复由 composition root 在创建各 Middleware 时完成，再把它们传给
Agent。checkpoint 中不保存函数或具体存储实现。

有状态的 Middleware 还要通过 `snapshotMiddlewareState` 提供保存出口，例如返回
`{ todos: todoSystem.snapshot() }`。`_saveCheckpoint()` 调用它并深度复制返回值，恢复时
composition root 再把 `state.middlewareState.todos` 交给 TodoSystem。只恢复、不更新这个
字段，会让后续 checkpoint 永远保留初始 Todo。

在 constructor 中替换对应赋值，保留已有的 Model、Registry 和 Middleware 初始化：

```ts
this._checkpoint = options.checkpoint
  ? { ...options.checkpoint, state: structuredClone(options.checkpoint.state) }
  : undefined;
this.maxSteps = this._checkpoint?.state.maxSteps ?? options.maxSteps ?? 20;
this._context = {
  prompt: this._checkpoint?.state.prompt ?? options.prompt,
  messages: structuredClone(this._checkpoint?.state.messages ?? options.messages ?? []),
  tools: this._toolRegistry.list(),
};
```

将阶段 5/6 的外层运行 guard 提取为 `_run()`，将 step 循环提取为 `_runSteps()`。
目标文件：`src/agent/agent.ts`，下面是两个公开入口的完整实现：

```ts
async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
  yield* this._run({ userMessage, nextStep: 1 });
}

async *continueFromStep(nextStep: number): AsyncGenerator<AgentEvent> {
  if (!this._checkpoint) throw new Error("Cannot resume without a checkpoint");
  if (nextStep !== this._checkpoint.state.nextStep) {
    throw new Error("Resume step does not match the checkpoint");
  }
  yield* this._run({ nextStep });
}
```

这里的 `_checkpoint` 类型是 `AgentCheckpoint | undefined`。`_run()` 的参数和修改点为：

```ts
private async *_run(options: {
  userMessage?: UserMessage;
  nextStep: number;
}): AsyncGenerator<AgentEvent> {
  if (this._streaming) throw new Error("Agent is already streaming");
  this._streaming = true;
  this._abortController = new AbortController();
  const signal = this._abortController.signal;
  try {
    if (options.userMessage) {
      this._context.messages.push(options.userMessage);
      signal.throwIfAborted();
      await this._beforeAgentRun();
      signal.throwIfAborted();
    }
    yield* this._runSteps(options.nextStep, signal);
  } catch (error) {
    if (!(error instanceof InjectedCrashError) && this._checkpoint) {
      // _act 必须先完成 12.0 的结果回收和关闭隔离，再把取消向外抛出。
      this._checkpoint.state.status = signal.aborted ? "aborted" : "failed";
      await this._saveCheckpoint();
    }
    throw error;
  } finally {
    try {
      await this._afterAgentRun();
      // 阶段 11 的 run_end emitter 留在这里；其失败策略仍按 11.7 的约定处理。
    } finally {
      this._streaming = false;
      this._abortController = null;
    }
  }
}
```

该文件需导入 `AgentCheckpoint`、`InjectedCrashError`。下面给出共享循环骨架中最重要的
恢复分支；`_planToolExecutions/_setCheckpointPhase/_saveCheckpoint` 的契约紧随其后：

```ts
private async *_runSteps(startStep: number, signal: AbortSignal): AsyncGenerator<AgentEvent> {
  for (let step = startStep; step <= this.maxSteps; step += 1) {
    signal.throwIfAborted();
    let toolUses: ToolUseContent[];
    if (this._checkpoint?.state.phase === "acting") {
      // 已持久化的 assistant 是事实；恢复时不能再次请求模型生成同一批 Tool calls。
      const assistant = this._context.messages.findLast((message) => message.role === "assistant");
      if (!assistant) throw new Error("Acting checkpoint has no assistant message");
      toolUses = this._extractToolUses(assistant);
      if (!toolUses.length) throw new Error("Acting checkpoint has no tool calls");
    } else {
      await this._beforeAgentStep(step);
      signal.throwIfAborted();
      await this._setCheckpointPhase("thinking", step);
      signal.throwIfAborted();
      const assistant = yield* this._think(signal);
      signal.throwIfAborted();
      await this._afterModel(assistant);
      signal.throwIfAborted();
      this._context.messages.push(assistant);
      toolUses = this._extractToolUses(assistant);
      this._planToolExecutions(toolUses);
      await this._setCheckpointPhase(toolUses.length ? "acting" : "idle", step,
        toolUses.length ? "running" : "completed");
      signal.throwIfAborted();
      this._checkpoint?.faultInjector?.hit("after_model");
      yield { type: "message", message: assistant };
      signal.throwIfAborted();
      if (!toolUses.length) return;
    }
    yield* this._act(toolUses, signal);
    await this._afterAgentStep(step);
    signal.throwIfAborted();
    await this._setCheckpointPhase("idle", step + 1);
    signal.throwIfAborted();
  }
  throw new MaximumStepsError({ maxSteps: this.maxSteps });
}
```

补齐三个小方法，分别完成单一职责：

| 方法 | 参数/返回值 | 实现提示 |
|---|---|---|
| `_planToolExecutions` | `ToolUseContent[] → void` | 无 checkpoint 时 no-op；按 id 拒绝重复，创建 `planned` record；metadata 缺失默认 `process/unknown`，不能猜成安全读取 |
| `_setCheckpointPhase` | `(phase: RunState["phase"], nextStep: number, status: RunState["status"] = "running") → Promise<void>` | 更新三个字段，再 await `_saveCheckpoint()` |
| `_saveCheckpoint` | `() → Promise<void>` | 无 checkpoint 时 no-op；复制当前 prompt/messages 和 state，调用可选 snapshotMiddlewareState 更新中间件状态，更新时间，await store.save；失败必须终止当前运行 |

这是在阶段 11 已有循环上添加持久化位置，原来的 `message_appended` 和 span emitter 要保留，
不能因提取循环而漏发事件。每个启用 checkpoint 的 Agent 实例承载一个 run；新 run 由
composition root 创建新的 RunState/runId。恢复复用旧 runId；若 trace 续写同一 JSONL，
先读最后的 sequence，再从下一个序号开始，不能重新从 1 写入。

`_runSteps(startStep, signal)` 使用原来的 `_think/_act`，按这个状态表插入持久化点：

| 当前状态 | 执行动作 | 必须持久化的下一状态 |
|---|---|---|
| `idle/thinking` | 调用 `_think`，追加最终 assistant | 有 Tool 时保存 `phase=acting`、当前 `nextStep`、整批 `planned` records；无 Tool 时保存 `completed` |
| `acting`（包括恢复） | 从最后一条 assistant 取 Tool calls；不再调用模型生成同一批 | 每个 Tool 按 12.3 推进 record，追加缺少的 observation |
| 全批 Tool observations 已齐 | 调用 `afterAgentStep` | `phase=idle`、`nextStep=当前 step + 1` |

`after_model` 故障点放在 assistant 和 planned records 成功保存之后。`before_tool` 放在
running record 保存之后；`after_tool` 放在实际 Tool 返回之后、result 保存之前。故障点
必须位于 Registry 的业务错误捕获范围之外，否则模拟 crash 会被错误转换为普通 observation。

为 `_invokeTool()` 增加以下明确分支；原有 hook、Registry 校验和序列化逻辑提取为
`_executeTool()` 继续复用：

```ts
// 位于 _invokeTool 内；record 由当前批次 toolUse.id 查找，不按 Tool name 查找。
if (record.status === "succeeded" || record.status === "failed") {
  if (record.resultContent === undefined) throw new Error("Terminal Tool record has no result");
  return {
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: record.toolUseId, content: record.resultContent }],
  } satisfies ToolMessage;
}
if (record.status !== "planned") throw new Error("Unresolved Tool execution");
// TODO：record.status="running" → await save → before_tool → await _executeTool。
// after_tool → 保存 resultContent 与 succeeded/failed → await save → 返回 ToolMessage。
// failed 表示已有确定的错误 observation，也不能在恢复时隐式重试。
```

`_act()` 追加前按 `tool_use_id` 检查 observation 是否已经存在：存在则核对内容并跳过
append/yield；不存在才追加、保存并输出。这样“result 已保存但 observation 尚未追加”的
crash 可以补回消息，已经追加的消息不会出现两次。进入下一次 `_think` 前必须确认这一批
所有 call 都有且只有一个 result。

保存时复制 `{ ...state, prompt: this._context.prompt, messages: this._context.messages }`，
不能让旧数组快照覆盖新 transcript。12C 再保留并发 `_act`：record 更新和 save 的入队顺序
固定，save 队列不得吞掉失败。模拟 crash 后设置共享停止标志、abort，并等待可中止任务完成清理；
无法及时停止的任务按 12.0 隔离，不能无限等待。停止后禁止其他任务再写 checkpoint；
真正的进程崩溃测试则由外部进程终止。

12C 必须继续遵守 12.0 的关闭边界：先收集边界内已经交付的结果，再串行完成对应 execution record、observation 与 checkpoint 写入，最后保存 run 的取消状态并关闭写入口。对无法等待完成的任务，保持其结果未知；不能把“收到 abort”直接记为副作用未发生。已排队的合法最终写入与关闭后新到达的写入要区分处理，不能让关闭标志反而丢弃已确认结果。

在 `recovery-integration.test.ts` 增加并发取消后续跑用例：两个写入 Tool 各更新一个计数器，确认两个结果都已交付后，在收到第一条 Tool observation 时取消；检查已持久化的两个结果各有一条关联 observation。再 resume，两个计数器仍各为 1，不重新调用已完成 Tool，也不重新生成这一批 Tool calls。使用同样的 call id 重复对账，不增加第三条 observation。这是将 12.0 的内存保证接到真实恢复链路上的验证。

#### 恢复决策与 observation 对账

目标文件：`src/runtime/checkpoint/resume-run.ts`。这段实现先处理未知动作，全部可继续后
才创建真实 Agent。`Pick<Agent, "continueFromStep">` 直接引用上一节新增的公开 API；单测
可以实现同一接口，集成示例会传入真正的 Agent。

```ts
import type { Agent } from "@/agent/agent";
import type { AgentEvent } from "@/agent/agent-event";
import type { CheckpointStore } from "@/foundation/runtime/checkpoint-store";
import type { RunState, ToolExecutionRecord } from "@/foundation/runtime/run-state";

export type UnknownToolResolution =
  | { action: "retry" }
  | { action: "record_result"; content: string }
  | { action: "skip"; reason: string }
  | { action: "ask_user" };

export type UnknownToolResolver = (record: ToolExecutionRecord) => Promise<UnknownToolResolution>;
export type ResumeResult =
  | { status: "completed" }
  | { status: "needs_input"; toolUseIds: string[] };

export function reconcileToolObservations(state: RunState): RunState {
  const next = structuredClone(state);
  const calls = new Set<string>();
  const results = new Map<string, string>();
  for (const message of next.messages) {
    for (const content of message.content) {
      if (content.type === "tool_use") {
        if (calls.has(content.id)) throw new Error(`Duplicate tool_use ${content.id}`);
        calls.add(content.id);
      } else if (content.type === "tool_result") {
        if (!calls.has(content.tool_use_id) || results.has(content.tool_use_id)) {
          throw new Error(`Invalid tool_result ${content.tool_use_id}`);
        }
        results.set(content.tool_use_id, content.content);
      }
    }
  }
  for (const record of next.toolExecutions) {
    if (!calls.has(record.toolUseId)) throw new Error(`Missing tool_use ${record.toolUseId}`);
    if (record.status !== "succeeded" && record.status !== "failed") continue;
    if (record.resultContent === undefined) throw new Error(`Missing result ${record.toolUseId}`);
    if (results.has(record.toolUseId)) {
      if (results.get(record.toolUseId) !== record.resultContent) {
        throw new Error(`Conflicting result ${record.toolUseId}`);
      }
      continue;
    }
    next.messages.push({ role: "tool", content: [{
      type: "tool_result", tool_use_id: record.toolUseId, content: record.resultContent,
    }] });
    results.set(record.toolUseId, record.resultContent);
  }
  return next;
}

export async function resumeRun(options: {
  runId: string;
  checkpointStore: CheckpointStore;
  defineAgentFromState: (state: RunState) => Promise<Pick<Agent, "continueFromStep">>;
  resolveUnknownTool?: UnknownToolResolver;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  expected?: {
    cwd: string;
    projectFingerprint: string;
    modelOptionsFingerprint: string;
    toolsetFingerprint: string;
  };
}): Promise<ResumeResult> {
  let state = structuredClone(await options.checkpointStore.load(options.runId));
  if (state.schemaVersion !== 1) throw new Error("Unsupported schemaVersion");
  if (state.status === "completed") throw new Error(`Run ${options.runId} is already completed`);
  if (options.expected) {
    const actual = {
      cwd: state.cwd, projectFingerprint: state.projectFingerprint,
      modelOptionsFingerprint: state.model.optionsFingerprint,
      toolsetFingerprint: state.toolsetFingerprint,
    };
    const keys = Object.keys(actual) as Array<keyof typeof actual>;
    const mismatches = keys.filter((key) => actual[key] !== options.expected![key]);
    if (mismatches.length) throw new Error(`Fingerprint mismatch: ${mismatches.join(", ")}`);
  }

  for (const record of state.toolExecutions) {
    if (record.status === "running") record.status = "unknown";
  }
  // 在询问用户前持久化 unknown；关闭窗口后重试仍会询问同一条 record。
  await options.checkpointStore.save(state);
  const pending: string[] = [];
  for (const record of state.toolExecutions) {
    if (record.status !== "unknown") continue;
    const safeRead = record.effect === "read" && record.idempotency === "safe";
    const decision = options.resolveUnknownTool
      ? await options.resolveUnknownTool(structuredClone(record))
      : { action: safeRead ? "retry" : "ask_user" } as const;
    switch (decision.action) {
      case "retry":
        // 本阶段只自动重试纯只读动作；写操作即使宣称幂等，也需另做前后置条件校验。
        if (!safeRead) throw new Error(`Unsafe retry: ${record.toolUseId}`);
        record.status = "planned";
        delete record.resultContent;
        break;
      case "record_result":
        record.status = "succeeded";
        record.resultContent = decision.content;
        break;
      case "skip":
        record.status = "failed";
        record.errorCode = "RECOVERY_SKIPPED";
        record.resultContent = JSON.stringify({ ok: false, code: record.errorCode, error: decision.reason });
        break;
      case "ask_user":
        pending.push(record.toolUseId);
        break;
    }
  }
  state = reconcileToolObservations(state);
  await options.checkpointStore.save(state);
  if (pending.length) return { status: "needs_input", toolUseIds: pending };

  const agent = await options.defineAgentFromState(state);
  for await (const event of agent.continueFromStep(state.nextStep)) {
    await options.onEvent?.(event);
  }
  return { status: "completed" };
}
```

`record_result` 必须来自用户检查真实副作用后的确认，例如读取目标文件验证内容后提交
对应 observation。`skip` 也产生明确错误 observation，不能直接删掉 Tool call。
CLI 收到 `needs_input` 时显示 call id、input 和未知原因；收集决定后再次调用 `resumeRun`，
不能在尚有 unknown 时提前调用模型。`expected` 由 CLI 按当前项目和配置提供。

先运行 12.8 的纯对账/决策测试，再完成 Agent 持久化接线并运行真实 Agent 集成示例。


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
import type { RuntimeTraceEvent } from "@/foundation/runtime/trace-events";

export async function replayTrace(options: {
  events: RuntimeTraceEvent[];
  onEvent: (event: RuntimeTraceEvent) => void | Promise<void>;
  speed?: number;
  noDelay?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  // TODO 1：按 sequence 稳定排序，并拒绝重复或倒退的 sequence。
  // TODO 2：依据相邻 timestamp 和 speed 计算可中止延迟；noDelay 时跳过等待。
  // TODO 3：依次 await options.onEvent(event)，不得请求模型或执行 Tool。
  throw new Error("TODO: implement replayTrace");
}
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

### 12.7 Recovery 示例

目标文件：`examples/stage-12-recovery.ts`

示例先保存稳定 checkpoint，再在临时文件写完后注入故障，确认旧 checkpoint 仍可读取；
最后使用内存 trace 演示 replay，不创建 Model 或 Tool。

<details>
<summary>展开完整代码：<code>stage-12-recovery.ts</code></summary>

```ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FileCheckpointStore } from "@/runtime/checkpoint/file-checkpoint-store";
import type { RunState } from "@/foundation/runtime/run-state";
import { replayTrace } from "@/runtime/replay/replay";
import type { RuntimeTraceEvent } from "@/foundation/runtime/trace-events";

function defineState(root: string, nextStep: number): RunState {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: 1,
    runId: "stage-12-demo",
    status: "running",
    phase: "idle",
    nextStep,
    maxSteps: 20,
    toolsetFingerprint: "tools-v1",
    prompt: "recovery demo",
    messages: [],
    model: {
      name: "scripted",
      provider: "scripted",
      optionsFingerprint: "model-v1",
    },
    cwd: root,
    projectFingerprint: "fixture-v1",
    toolExecutions: [],
    middlewareState: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function messageEvent(sequence: number, text: string): RuntimeTraceEvent {
  return {
    schemaVersion: 1,
    runId: "stage-12-demo",
    sequence,
    timestamp: `2026-01-01T00:00:00.00${sequence}Z`,
    type: "message_appended",
    payload: {
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "harness-recovery-demo-"));

try {
  const stableStore = new FileCheckpointStore({ rootDir: root });
  await stableStore.save(defineState(root, 1));
  console.log("saved nextStep=1");

  const crashingStore = new FileCheckpointStore({
    rootDir: root,
    faultInjector: {
      hit: (point) => {
        if (point === "after_temp_write") throw new Error("injected crash");
      },
    },
  });

  try {
    await crashingStore.save(defineState(root, 2));
  } catch (error) {
    console.log(`crash=${error instanceof Error ? error.message : String(error)}`);
  }

  const recovered = await stableStore.load("stage-12-demo");
  console.log(`recovered nextStep=${recovered.nextStep}`);
  if (recovered.nextStep !== 1) throw new Error("Atomic checkpoint guarantee was violated");

  await replayTrace({
    events: [messageEvent(2, "second"), messageEvent(1, "first")],
    noDelay: true,
    onEvent: (event) => {
      if (event.type !== "message_appended") return;
      const text = event.payload.message.content
        .map((item) => (item.type === "text" ? item.text : ""))
        .join("");
      console.log(`replay sequence=${event.sequence} text=${text}`);
    },
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
```

</details>

运行：

```bash
bun run examples/stage-12-recovery.ts
```

#### 运行真正的中断续跑场景

上面的文件替换演示只验证存储原子性。下面补上另一条独立路径，使用本课程已实现的
`Agent`、Registry 和文件 Tool，验证副作用发生后中断的恢复行为。

目标文件：`examples/recovery-scenario.ts`。示例返回可断言的证据，供 CLI 和集成测试复用：

```ts
import { join } from "node:path";
import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";
import { InjectedCrashError } from "@/foundation/runtime/fault-injector";
import type { AgentCheckpoint } from "@/foundation/runtime/agent-checkpoint";
import type { RunState } from "@/foundation/runtime/run-state";
import { FileCheckpointStore } from "@/runtime/checkpoint/file-checkpoint-store";
import { resumeRun } from "@/runtime/checkpoint/resume-run";

export async function runRecoveryScenario(root: string) {
  const path = join(root, "counter.txt");
  await Bun.write(path, "0");
  let readCalls = 0;
  let writeCalls = 0;
  let modelCalls = 0;
  const tools = [
    defineTool({
      name: "read_once", description: "Read the fixture counter",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        readCalls += 1;
        return { ok: true, data: { value: Number(await Bun.file(path).text()) } };
      },
    }),
    defineTool({
      name: "increment_once", description: "Increment the fixture counter",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        writeCalls += 1;
        const value = Number(await Bun.file(path).text()) + 1;
        await Bun.write(path, String(value));
        return { ok: true, data: { value } };
      },
    }),
  ];
  function response(params: ModelProviderInvokeParams): AssistantMessage {
    const observations = params.messages.flatMap((message) =>
      message.role === "tool" ? message.content.map((item) => item.tool_use_id) : [],
    );
    if (observations.includes("write-1")) {
      return { role: "assistant", content: [{ type: "text", text: "completed" }] };
    }
    const readDone = observations.includes("read-1");
    return { role: "assistant", content: [{
      type: "tool_use", id: readDone ? "write-1" : "read-1",
      name: readDone ? "increment_once" : "read_once", input: { description: "fixture action" },
    }] };
  }
  const provider: ModelProvider = {
    invoke: async (params) => { modelCalls += 1; return response(params); },
    stream: async function* (params) {
      params.signal?.throwIfAborted();
      modelCalls += 1;
      yield response(params);
    },
  };
  const model = new Model({ name: "recovery-scripted", provider });
  const store = new FileCheckpointStore({ rootDir: root });
  const now = new Date().toISOString();
  const initial: RunState = {
    schemaVersion: 1, runId: "recovery-integration", status: "running", phase: "idle",
    nextStep: 1, maxSteps: 4, toolsetFingerprint: "read-increment-v1", prompt: "", messages: [],
    model: { name: model.name, provider: "scripted", optionsFingerprint: "model-v1" },
    cwd: root, projectFingerprint: "fixture-v1", toolExecutions: [], middlewareState: {},
    createdAt: now, updatedAt: now,
  };
  const toolMetadata: AgentCheckpoint["toolMetadata"] = {
    read_once: { effect: "read", idempotency: "safe" },
    increment_once: { effect: "write", idempotency: "unsafe" },
  };
  let finishedTools = 0;
  const first = new Agent({ model, prompt: "", tools, checkpoint: {
    state: initial, store, toolMetadata,
    faultInjector: { hit: (point) => {
      if (point === "after_tool" && ++finishedTools === 2) {
        throw new InjectedCrashError({ point });
      }
    } },
  } });
  let crashed = false;
  try {
    for await (const _event of first.stream({
      role: "user", content: [{ type: "text", text: "Read and increment the counter once" }],
    })) { /* consume */ }
  } catch (error) {
    if (!(error instanceof InjectedCrashError)) throw error;
    crashed = true;
  }
  if (!crashed) throw new Error("Expected an injected crash after the write");
  const atCrash = await store.load(initial.runId);
  const callsAtCrash = modelCalls;
  let resumedAgents = 0;
  const defineAgentFromState = async (state: RunState) => {
    resumedAgents += 1;
    return new Agent({ model, prompt: state.prompt, tools, checkpoint: { state, store, toolMetadata } });
  };
  const options = {
    runId: initial.runId, checkpointStore: store, defineAgentFromState,
    expected: {
      cwd: root, projectFingerprint: "fixture-v1", modelOptionsFingerprint: "model-v1",
      toolsetFingerprint: "read-increment-v1",
    },
  };
  const blocked = await resumeRun(options);
  if (blocked.status !== "needs_input" || resumedAgents !== 0 || modelCalls !== callsAtCrash) {
    throw new Error("Unknown write must block before constructing or running an Agent");
  }
  // 模拟用户检查磁盘后确认结果。没有确认前绝不自动再次执行 increment_once。
  const confirmedValue = Number(await Bun.file(path).text());
  if (confirmedValue !== 1) throw new Error("Unexpected side effect at the crash boundary");
  await resumeRun({ ...options, resolveUnknownTool: async () => ({
    action: "record_result", content: JSON.stringify({ ok: true, data: { value: confirmedValue } }),
  }) });
  const final = await store.load(initial.runId);
  const resultIds = final.messages.flatMap((message) =>
    message.role === "tool" ? message.content.map((item) => item.tool_use_id) : [],
  );
  return {
    readCalls, writeCalls, modelCallsAfterCrash: modelCalls - callsAtCrash,
    phaseAtCrash: atCrash.phase, stepAtCrash: atCrash.nextStep,
    blockedToolUseIds: blocked.toolUseIds,
    finalValue: Number(await Bun.file(path).text()), status: final.status, resultIds,
    finalMessage: final.messages.at(-1),
  };
}
```

在 `examples/stage-12-recovery.ts` 顶部导入 `runRecoveryScenario`（`./recovery-scenario`），
并在已有 `try` 内、删除临时目录之前增加：

```ts
console.log(JSON.stringify(await runRecoveryScenario(root), null, 2));
```

预期关键输出：`readCalls=1`、`writeCalls=1`、`modelCallsAfterCrash=1`、
`phaseAtCrash="acting"`、`stepAtCrash=2`、`finalValue=1`、`status="completed"`，
`resultIds` 恰好是 `["read-1", "write-1"]`。计数器若变成 2，说明恢复重复执行了副作用；
若没有最后的 assistant，则只完成了状态加载，没有真正续跑。


### 12.8 完整恢复测试

目标文件：
`src/runtime/checkpoint/__tests__/file-checkpoint-store.test.ts`

<details>
<summary>展开完整代码：<code>file-checkpoint-store.test.ts</code></summary>

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { RunState } from "@/foundation/runtime/run-state";
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
    maxSteps: 20,
    toolsetFingerprint: "tools-v1",
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

</details>

目标文件：`src/runtime/checkpoint/__tests__/resume-run.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "@/agent/agent-event";
import type { CheckpointStore } from "@/foundation/runtime/checkpoint-store";
import type { RunState } from "@/foundation/runtime/run-state";

import { reconcileToolObservations, resumeRun } from "../resume-run";

function state(): RunState {
  return {
    schemaVersion: 1, runId: "run-1", status: "running", phase: "acting", nextStep: 2,
    maxSteps: 4, toolsetFingerprint: "tools-v1", prompt: "test",
    messages: [{ role: "assistant", content: [{
      type: "tool_use", id: "call-1", name: "write_file", input: {},
    }] }],
    model: { name: "test", provider: "scripted", optionsFingerprint: "model-v1" },
    cwd: "/fixture", projectFingerprint: "project-v1", middlewareState: {},
    toolExecutions: [{
      toolUseId: "call-1", toolName: "write_file", input: {}, effect: "write",
      idempotency: "unsafe", status: "running",
    }],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function dependencies(initial: RunState) {
  let saved = structuredClone(initial);
  let definedWith: RunState | undefined;
  const continued: number[] = [];
  const checkpointStore: CheckpointStore = {
    save: async (value) => { saved = structuredClone(value); },
    load: async () => structuredClone(saved),
    list: async () => [],
  };
  const options: Parameters<typeof resumeRun>[0] = {
    runId: initial.runId, checkpointStore,
    defineAgentFromState: async (value) => {
      definedWith = structuredClone(value);
      return { continueFromStep: async function* (step): AsyncGenerator<AgentEvent> {
        continued.push(step);
        yield* []; // 这个 fake 只记录调用，真实执行由下一份集成测试覆盖。
      } };
    },
  };
  return { options, continued, saved: () => saved, definedWith: () => definedWith };
}

describe("resumeRun", () => {
  test("rejects a completed run before constructing an Agent", async () => {
    const fixture = dependencies({ ...state(), status: "completed" });
    await expect(resumeRun(fixture.options)).rejects.toThrow("already completed");
    expect(fixture.definedWith()).toBeUndefined();
  });

  test("persists unknown and blocks unsafe effects before Agent construction", async () => {
    const fixture = dependencies(state());
    expect(await resumeRun(fixture.options)).toEqual({ status: "needs_input", toolUseIds: ["call-1"] });
    expect(fixture.saved().toolExecutions[0]?.status).toBe("unknown");
    expect(fixture.definedWith()).toBeUndefined();
    expect(fixture.continued).toEqual([]);
  });

  test("only retries safe reads and preserves the saved step", async () => {
    const input = state();
    input.toolExecutions[0]!.effect = "read";
    input.toolExecutions[0]!.idempotency = "safe";
    const fixture = dependencies(input);
    await resumeRun(fixture.options);
    expect(fixture.definedWith()?.toolExecutions[0]?.status).toBe("planned");
    expect(fixture.continued).toEqual([2]);
    expect(fixture.definedWith()?.messages).toHaveLength(1);
  });

  test("rejects an unsafe automatic retry even when a resolver requests it", async () => {
    const fixture = dependencies(state());
    await expect(resumeRun({ ...fixture.options, resolveUnknownTool: async () => ({ action: "retry" }) }))
      .rejects.toThrow("Unsafe retry");
    expect(fixture.continued).toEqual([]);
  });

  test("reconciles a saved result without duplicating observations", async () => {
    const input = state();
    input.toolExecutions[0]!.status = "succeeded";
    input.toolExecutions[0]!.resultContent = "saved output";
    const repaired = reconcileToolObservations(input);
    expect(repaired.messages).toHaveLength(2);
    expect(input.messages).toHaveLength(1);
    expect(reconcileToolObservations(repaired)).toEqual(repaired);
    const fixture = dependencies(repaired);
    await resumeRun(fixture.options);
    expect(fixture.definedWith()?.toolExecutions[0]?.status).toBe("succeeded");
    expect(fixture.definedWith()?.messages).toHaveLength(2);
    expect(fixture.continued).toEqual([2]);
  });

  test("user confirmation and skip both leave a paired observation", async () => {
    const confirmed = dependencies(state());
    await resumeRun({ ...confirmed.options, resolveUnknownTool: async () => ({
      action: "record_result", content: "verified on disk",
    }) });
    expect(confirmed.definedWith()?.messages.at(-1)).toEqual({ role: "tool", content: [{
      type: "tool_result", tool_use_id: "call-1", content: "verified on disk",
    }] });
    const skipped = dependencies(state());
    await resumeRun({ ...skipped.options, resolveUnknownTool: async () => ({
      action: "skip", reason: "user declined to retry",
    }) });
    expect(JSON.stringify(skipped.definedWith()?.messages)).toContain("RECOVERY_SKIPPED");
  });

  test("reports every fingerprint mismatch together", async () => {
    const fixture = dependencies(state());
    await expect(resumeRun({ ...fixture.options, expected: {
      cwd: "/other", projectFingerprint: "project-v2", modelOptionsFingerprint: "model-v2",
      toolsetFingerprint: "tools-v2",
    } })).rejects.toThrow(/cwd.*projectFingerprint.*modelOptionsFingerprint.*toolsetFingerprint/s);
  });
});
```

这些单测只证明恢复决策和对账，不证明 Agent 已经执行。下面的集成测试复用真实 Agent
场景，不能用返回空对象或空 `continueFromStep()` 的 fake 替换。

目标文件：`src/runtime/checkpoint/__tests__/recovery-integration.test.ts`

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runRecoveryScenario } from "../../../../examples/recovery-scenario";

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("resumes a real Agent after an unknown write without repeating completed effects", async () => {
  root = await mkdtemp(join(tmpdir(), "harness-recovery-integration-"));
  const result = await runRecoveryScenario(root);
  expect(result).toMatchObject({
    readCalls: 1, writeCalls: 1, modelCallsAfterCrash: 1,
    phaseAtCrash: "acting", stepAtCrash: 2, blockedToolUseIds: ["write-1"],
    finalValue: 1, status: "completed", resultIds: ["read-1", "write-1"],
    finalMessage: { role: "assistant", content: [{ type: "text", text: "completed" }] },
  });
});
```


目标文件：`src/runtime/replay/__tests__/replay.test.ts`

<details>
<summary>展开完整代码：<code>replay.test.ts</code></summary>

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

</details>

示例故障演练还应手工覆盖 model 后/Tool 前、read/write Tool 中途和并发批次崩溃；上面
这些测试分别覆盖存储原子性、决策/对账、真实 Agent 续跑和 replay。它们不替代并发批次、
真实进程被终止或磁盘写入失败的故障演练；这些场景仍需按 12C 的停止与持久化规则验证。

最后执行本阶段的完整测试：

```bash
bun test src/agent/__tests__/tool-cancellation-boundary.test.ts src/runtime/checkpoint src/runtime/replay
```

### 验收

- [ ] 先通过 12.0 的三项并发取消/迟到任务隔离测试，再接入 checkpoint；
- [ ] 取消时已交付结果各记录一次，关闭后旧任务不再修改 context、transcript 或 checkpoint；
- [ ] 并发取消后 resume 不重复已完成副作用，计数器和 observation 去重断言通过；
- [ ] 阶段 6 的 24 项回归在恢复改造后仍通过；
- [ ] checkpoint 原子写入；
- [ ] schema 有 version；
- [ ] Tool intent 在副作用前持久化；
- [ ] unknown 不被错误归类为 failed；
- [ ] replay 完全离线只读；
- [ ] Todo 等 middleware state 可恢复；
- [ ] `ADR-013` 解释为什么 arbitrary Tool 无法通用 exactly-once。

## 阶段 13：Context Budget、Compaction 与可靠性策略

> 上一阶段回顾：阶段 12 实现了版本化 checkpoint、write-ahead Tool intent、安全恢复和只读 replay，明确了未知副作用的处理方式。

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

执行后新增结构如下：

```text
src/runtime/
├── context/
│   ├── token-estimator.ts              # 估算消息、文本与 Tool schema token
│   ├── message-groups.ts               # 将相关消息分成不可拆散的语义组
│   ├── context-manager.ts              # 在预算内生成 Model view 并执行 compaction
│   ├── index.ts                        # 导出 context 管理公共 API
│   └── __tests__/
│       └── context-manager.test.ts     # 验证预算、保留规则与 transcript 不变性
├── reliability/
│   ├── resilient-model-provider.ts     # 为可重试模型错误提供退避与重试
│   ├── tool-timeout.ts                 # 为 Tool 执行施加 timeout 和 abort
│   └── __tests__/
│       ├── resilient-model-provider.test.ts # 验证重试分类与退避策略
│       └── tool-timeout.test.ts        # 验证超时、中止与资源清理
└── policy/
    ├── policy-engine.ts                # 集中判定 Tool 调用是否允许或需审批
    └── __tests__/
        └── policy-engine.test.ts       # 验证允许、拒绝与审批规则
examples/
├── stage-13-context.ts                 # 演示长 transcript 的预算内 Model view
└── stage-13-retry.ts                   # 演示可重试错误与最终失败
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
import type { Message } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

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

目标文件：`src/runtime/context/message-groups.ts`

```ts
import type { NonSystemMessage } from "@/foundation/messages";

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
} {
  // TODO 1：收集 assistant tool_use id 和 tool_result.tool_use_id。
  // TODO 2：分别返回缺少 result 和缺少 use 的 id，结果顺序保持稳定。
  throw new Error("TODO: implement validateToolCallPairs");
}
```

每次 compaction 后都执行。

### 13.4 ContextManager

目标文件：`src/runtime/context/context-manager.ts`

<details>
<summary>展开完整代码：<code>context-manager.ts</code></summary>

```ts
import type { NonSystemMessage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

import type { MessageGroup } from "./message-groups";
import type { ContextBudget, TokenEstimator } from "./token-estimator";

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
  private readonly _estimator: TokenEstimator;
  private readonly _summarizer: ConversationSummarizer;

  constructor(options: {
    estimator: TokenEstimator;
    summarizer: ConversationSummarizer;
  }) {
    this._estimator = options.estimator;
    this._summarizer = options.summarizer;
  }

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
    throw new Error("TODO: implement ContextManager.prepare");
  }
}
```

</details>

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

### 13.5 Model retry

目标文件：`src/runtime/reliability/resilient-model-provider.ts`

实现 `ResilientModelProvider` decorator：

<details>
<summary>展开完整代码：<code>resilient-model-provider.ts</code></summary>

```ts
import type { AssistantMessage } from "@/foundation/messages";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify(error: unknown): "transient" | "permanent" | "aborted";
}

export type RetrySleeper = (delayMs: number, signal?: AbortSignal) => Promise<void>;

export class ResilientModelProvider implements ModelProvider {
  private readonly _provider: ModelProvider;
  private readonly _policy: RetryPolicy;
  private readonly _sleeper: RetrySleeper;
  private readonly _jitter: () => number;

  constructor(options: {
    provider: ModelProvider;
    policy: RetryPolicy;
    sleeper: RetrySleeper;
    jitter: () => number;
  }) {
    // 构造阶段只保存依赖，不调用 provider，也不启动 timer。
    this._provider = options.provider;
    this._policy = options.policy;
    this._sleeper = options.sleeper;
    this._jitter = options.jitter;
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

</details>

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

### 13.6 Tool timeout 和 idempotency

给 Tool metadata 增加：

目标文件：`src/runtime/reliability/tool-timeout.ts`

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

### 13.7 PolicyEngine

把阶段 10 的 Tool-name allowlist 升级为：

目标文件：`src/runtime/policy/policy-engine.ts`

<details>
<summary>展开完整代码：<code>policy-engine.ts</code></summary>

```ts
import { resolve } from "node:path";

import type { ToolUseContent } from "@/foundation/messages";

import type { ToolRuntimeMetadata } from "../reliability/tool-timeout";

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
  private readonly _workspace: string;
  private readonly _commandPrefixRules: string[][];

  constructor(options: {
    workspace: string;
    commandPrefixRules: string[][];
  }) {
    // 构造阶段保存配置，不执行 command。
    this._workspace = resolve(options.workspace);
    this._commandPrefixRules = options.commandPrefixRules.map((rule) => [...rule]);
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

</details>

至少考虑：

- Tool effect；
- path 是否在 workspace；
- command 是否命中明确 prefix rule；
- 是否包含 network access；
- 是否覆盖已有文件；
- project-local persistence rule；
- unknown 输入默认 ask 或 deny。

不要尝试用几条正则“证明任意 shell command 安全”。复杂 shell 的静态分析不可靠；无法分类时请求审批。

目标文件：`examples/stage-13-context.ts`

<details>
<summary>展开完整代码：<code>stage-13-context.ts</code></summary>

```ts
import type { NonSystemMessage } from "@/foundation/messages";
import { ContextManager } from "@/runtime/context/context-manager";
import { validateToolCallPairs } from "@/runtime/context/message-groups";

const estimator = {
  estimateText: (text: string) => text.length,
  estimateMessages: (messages: unknown[]) => JSON.stringify(messages).length,
  estimateTools: (tools: unknown[]) => JSON.stringify(tools).length,
};
const messages: NonSystemMessage[] = [];

for (let turn = 1; turn <= 20; turn += 1) {
  messages.push({
    role: "user",
    content: [{ type: "text", text: `request ${turn}: ${"context ".repeat(8)}` }],
  });
  messages.push({
    role: "assistant",
    content: [{ type: "text", text: `answer ${turn}: ${"result ".repeat(8)}` }],
  });
}
messages.push({
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "context-check-1",
      name: "read_file",
      input: { path: "src/context.ts" },
    },
  ],
});
messages.push({
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: "context-check-1",
      content: "fixture content",
    },
  ],
});
messages.push({
  role: "user",
  content: [{ type: "text", text: "latest constraint: preserve this message" }],
});

const canonical = JSON.stringify(messages);
const manager = new ContextManager({
  estimator,
  summarizer: {
    summarize: async (groups) => [
      '<conversation_summary source="older_transcript">',
      `- Summarized groups: ${groups.length}`,
      "- Earlier requests and answers were repetitive fixture data.",
      "</conversation_summary>",
    ].join("\n"),
  },
});
const prepared = await manager.prepare({
  messages,
  prompt: "Keep the latest user constraint.",
  tools: [],
  budget: {
    maxInputTokens: 1_200,
    reservedOutputTokens: 100,
    safetyMarginTokens: 100,
  },
});
const pairs = validateToolCallPairs(prepared.messages);

if (JSON.stringify(messages) !== canonical) {
  throw new Error("ContextManager mutated the canonical transcript");
}

console.log(
  `original: ${messages.length} messages, estimated ${prepared.stats.originalTokens} tokens`,
);
console.log(
  `prepared: ${prepared.messages.length} messages, estimated ${prepared.stats.preparedTokens} tokens`,
);
console.log(`summary:  ${prepared.stats.summarizedGroups} groups → 1 summary`);
console.log(`pairs:    ${pairs.ok ? "valid" : "invalid"}`);
console.log(`ratio:    ${(prepared.stats.compressionRatio * 100).toFixed(1)}%`);
```

</details>

目标文件：`examples/stage-13-retry.ts`

<details>
<summary>展开完整代码：<code>stage-13-retry.ts</code></summary>

```ts
import type { AssistantMessage } from "@/foundation/messages";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models/model-provider";
import { ResilientModelProvider } from "@/runtime/reliability/resilient-model-provider";

class TransientModelError extends Error {}

class FailingProvider implements ModelProvider {
  private _attempt = 0;

  constructor(private readonly _failFirst: number) {}

  async invoke(_params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this._attempt += 1;
    console.log(`attempt=${this._attempt}`);
    if (this._attempt <= this._failFirst) {
      const error = new TransientModelError(`injected transient failure ${this._attempt}`);
      console.log(`error=${error.constructor.name}: ${error.message}`);
      throw error;
    }
    return { role: "assistant", content: [{ type: "text", text: "success" }] };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    yield await this.invoke(params);
  }
}

function numberFlag(name: string, fallback: number): number {
  const index = Bun.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(Bun.argv[index + 1]);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const failFirst = numberFlag("--fail-first", 0);
const abortAfter = Bun.argv.includes("--abort-after")
  ? numberFlag("--abort-after", 0)
  : undefined;
const controller = new AbortController();
const abortTimer = abortAfter === undefined
  ? undefined
  : setTimeout(() => controller.abort(new DOMException("user abort", "AbortError")), abortAfter);
const resilient = new ResilientModelProvider({
  provider: new FailingProvider(failFirst),
  policy: {
    maxAttempts: Math.max(3, failFirst + 1),
    baseDelayMs: 50,
    maxDelayMs: 200,
    classify: (error) => {
      if (error instanceof DOMException && error.name === "AbortError") return "aborted";
      return error instanceof TransientModelError ? "transient" : "permanent";
    },
  },
  sleeper: async (delayMs, signal) => {
    console.log(`backoff=${delayMs}ms`);
    await wait(delayMs, signal);
  },
  jitter: () => 0,
});

try {
  const result = await resilient.invoke({
    model: "fixture",
    messages: [],
    signal: controller.signal,
  });
  console.log(`result=${JSON.stringify(result)}`);
} catch (error) {
  console.log(`stopped=${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
} finally {
  if (abortTimer !== undefined) clearTimeout(abortTimer);
}
```

</details>

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

### 13.8 完整测试

#### ContextManager

目标文件：`src/runtime/context/__tests__/context-manager.test.ts`

<details>
<summary>展开完整代码：<code>context-manager.test.ts</code></summary>

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

</details>

示例输入是 `transcript()`；参数规则中的有效消息预算为 `260 - 20 - 20 = 220`，还要再
扣除 prompt 和 Tool schema 固定成本。示例断言不依赖某个 provider tokenizer，只依赖注入
的 deterministic estimator。

#### 可靠性与 Policy

目标文件：`src/runtime/reliability/__tests__/resilient-model-provider.test.ts`

<details>
<summary>展开完整代码：<code>resilient-model-provider.test.ts</code></summary>

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

</details>

目标文件：`src/runtime/policy/__tests__/policy-engine.test.ts`

<details>
<summary>展开完整代码：<code>policy-engine.test.ts</code></summary>

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

</details>

目标文件：`src/runtime/reliability/__tests__/tool-timeout.test.ts`

<details>
<summary>展开完整代码：<code>tool-timeout.test.ts</code></summary>

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

</details>

Model retry 与 Tool timeout 使用不同测试文件，避免混淆网络请求重试和外部副作用恢复。

最后执行本阶段的完整测试：

```bash
bun test src/runtime/context src/runtime/reliability src/runtime/policy
```

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
