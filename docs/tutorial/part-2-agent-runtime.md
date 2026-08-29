# 第二部分：Agent Runtime

这一部分完成阶段 4～6。你会把 Message、Model 和 Tool 连接成 ReAct loop，并逐步加入 streaming、并发、abort 和 Middleware。

每次循环只有两个真正的动作：

```text
think: transcript → model → assistant message
act:   tool_use → tool runtime → tool_result → transcript
```

所谓 observation 并不是隐藏的第四种状态，它就是追加进 transcript 的 `ToolMessage`。下一轮 model 调用能看到这条消息，因此可以继续决策。

## 阶段 4：实现最小 ReAct loop

### 本阶段限制

为了看清最小算法，本阶段故意限制为：

- 使用离线 `ScriptedModelProvider`；
- Tool 顺序执行；
- 暂不支持 Middleware；
- 暂不实现 Ctrl+C abort；
- 每轮 model 只读取最终 response，不展示中间 progress。

创建文件：

```bash
mkdir -p src/agent/__tests__ examples
touch src/agent/agent-context.ts src/agent/agent-event.ts src/agent/agent.ts
touch src/agent/errors.ts src/agent/serialize-tool-result.ts src/agent/index.ts
touch src/agent/__tests__/agent.test.ts examples/stage-04-react-loop.ts
```

### 4.1 AgentContext 和 AgentEvent

目标文件：`src/agent/agent-context.ts` 和 `src/agent/agent-event.ts`

```ts
export interface AgentContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
}

export type AgentEvent =
  | { type: "message"; message: AssistantMessage | ToolMessage }
  | { type: "progress"; subtype: "thinking" }
  | { type: "progress"; subtype: "tool"; name: string; input: unknown };
```

不要为 `thinking`、`acting` 再维护一套可变状态。transcript 和 event stream 已足够表达发生过什么；重复状态会在异常路径下产生不一致。

### 4.2 Agent 骨架

目标文件：`src/agent/errors.ts`

后续测试会按名称 import `MaximumStepsError`，因此先固定完整 public error 契约：

```ts
export class MaximumStepsError extends Error {
  readonly maxSteps: number;

  constructor({ maxSteps }: { maxSteps: number }) {
    super(`Agent exceeded maximum steps: ${maxSteps}`);
    this.name = "MaximumStepsError";
    this.maxSteps = maxSteps;
  }
}
```

目标文件：`src/agent/agent.ts`

构造函数和 getter 是标准实现示例。getter 返回数组副本，防止调用方绕过 Agent
直接篡改 transcript；核心 loop 留给读者按分项提示完成。

```ts
export class Agent {
  private readonly _context: AgentContext;

  readonly model: Model;
  readonly maxSteps: number;

  constructor(options: {
    model: Model;
    prompt: string;
    messages?: NonSystemMessage[];
    tools?: Tool[];
    maxSteps?: number;
  }) {
    // 标准实现示例：复制外部数组，默认最多运行 20 个 step。
    this.model = model;
    this.maxSteps = maxSteps ?? 20;
    this._context = {
      prompt,
      messages: [...(messages ?? [])],
      tools: [...(tools ?? [])],
    };
  }

  get messages(): NonSystemMessage[] {
    return [...this._context.messages];
  }

  async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
    // TODO 1：先 append userMessage，同一个对象只能追加一次。
    // TODO 2：for step = 1 ... maxSteps，调用 model.stream。
    // TODO 3：遍历累计 snapshot，但只保留最后一个完整 AssistantMessage。
    // TODO 4：append/yield assistant message，保持 transcript 与 event 顺序一致。
    // TODO 5：提取 tool_use；没有 Tool call 时立即 return。
    // TODO 6：本阶段按数组顺序逐个执行，并 append/yield ToolMessage。
    // TODO 7：Tool failure 也序列化成 observation，不从 loop 直接 throw。
    // TODO 8：循环耗尽后抛出带 maxSteps 的 MaximumStepsError。
  }

  private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
    // TODO 9：使用 filter + type predicate；禁止 `as ToolUseContent[]`。
  }

  private async _invokeTool(toolUse: ToolUseContent): Promise<ToolMessage> {
    // TODO 10：通过 ToolRegistry 执行并用 serializeToolResult 转为字符串；
    // tool_use_id 必须原样复制 toolUse.id。
  }
}
```

### 4.3 Tool result 序列化策略

Provider wire protocol 通常要求 Tool result content 是字符串。定义一个明确的边界函数：

目标文件：`src/agent/serialize-tool-result.ts`

```ts
export function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify({
      ok: false,
      summary: "Tool returned a non-serializable value",
      error: "Tool result cannot be serialized",
      code: "NON_SERIALIZABLE_TOOL_RESULT",
    });
  }
}
```

不要把原始对象塞进 canonical `ToolResultContent`，否则 checkpoint、provider converter 和 TUI 会分别发明序列化行为。

### 4.4 离线 weather agent

目标文件：`examples/stage-04-react-loop.ts`

准备两个 scripted responses。以下是示例输入：第一个 response 发出 Tool call，第二个
response 给最终文本；`weather-1` 在这次 run 中必须唯一。

```ts
const responses: AssistantMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "weather-1",
        name: "get_weather",
        input: { description: "查询北京天气", city: "北京" },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "北京今天晴，26°C。" }],
  },
];
```

`get_weather` 返回固定结果，不访问网络。运行：

```bash
bun run examples/stage-04-react-loop.ts
```

示例程序应该根据 `AgentEvent` 打印以下示例输出：

```text
[user] 北京天气如何？
[assistant/tool_use] get_weather #weather-1
[tool/tool_result] #weather-1 晴，26°C
[assistant] 北京今天晴，26°C。
[done] steps=2 messages=4
```

### 4.5 完整测试

目标文件：`src/agent/__tests__/agent.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";
import { MaximumStepsError } from "../errors";

const USER_MESSAGE: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "北京天气如何？" }],
};

const WEATHER_CALL: AssistantMessage = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "weather-1",
      name: "get_weather",
      input: { description: "查询北京天气", city: "北京" },
    },
  ],
};

const FINAL_ANSWER: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "北京今天晴，26°C。" }],
};

const weatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather",
  parameters: z.object({ description: z.string(), city: z.string() }),
  invoke: async ({ city }) => ({ city, condition: "晴", temperatureC: 26 }),
});

async function drain(agent: Agent): Promise<void> {
  for await (const _event of agent.stream(USER_MESSAGE)) {
    // 消费完整 event stream；断言统一读取 agent.messages。
  }
}

function defineWeatherAgent(options: {
  responses?: AssistantMessage[];
  tools?: typeof weatherTool[];
  maxSteps?: number;
} = {}): Agent {
  const provider = new ScriptedModelProvider({
    responses: options.responses ?? [WEATHER_CALL, FINAL_ANSWER],
  });
  return new Agent({
    model: new Model({ name: "scripted", provider }),
    prompt: "Answer with tools when needed",
    tools: options.tools ?? [weatherTool],
    maxSteps: options.maxSteps,
  });
}

describe("Agent", () => {
  test("runs think-act-observe until the model returns text", async () => {
    const agent = defineWeatherAgent();
    await drain(agent);

    expect(agent.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  test("preserves tool_use_id in the result message", async () => {
    const agent = defineWeatherAgent();
    await drain(agent);
    const toolMessage = agent.messages.find((message) => message.role === "tool");

    expect(toolMessage?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "weather-1",
    });
  });

  test("turns an unknown tool into an observation", async () => {
    const agent = defineWeatherAgent({ tools: [] });
    await drain(agent);
    const toolMessage = agent.messages.find((message) => message.role === "tool");

    expect(toolMessage?.content[0]?.content).toContain("TOOL_NOT_FOUND");
    expect(agent.messages.at(-1)).toEqual(FINAL_ANSWER);
  });

  test("fails with a typed error after maxSteps", async () => {
    const agent = defineWeatherAgent({ responses: [WEATHER_CALL], maxSteps: 1 });
    expect(drain(agent)).rejects.toBeInstanceOf(MaximumStepsError);
  });
});
```

未知 Tool 和普通 Tool failure 应反馈给模型，让模型有机会修正。只有 runtime invariant 被破坏、用户中止或达到上限时，Agent run 才整体失败。

### 阶段后对照

- `src/agent/agent.ts` 的 `stream()`、`_think()`、`_act()`；
- `src/agent/tool-result-runtime.ts`；
- `src/agent/__tests__/tool-result-runtime.test.ts`。

### 验收

- [ ] transcript 的 role 顺序正确；
- [ ] 每个 `tool_result` 都能关联 `tool_use_id`；
- [ ] 最后一条无 Tool call 的 assistant message 终止循环；
- [ ] `maxSteps` 是 runtime guard，不是 prompt 建议；
- [ ] `ADR-005` 解释为什么 Tool failure 是 observation。

## 阶段 5：Streaming、并发 Tool 与 Abort

### 本阶段解决的问题

阶段 4 能工作，但有三个真实产品问题：

1. 模型长响应期间用户看不到进度；
2. 同一 assistant message 中的独立 Tool 被串行执行；
3. 用户中止后网络请求或子进程仍可能继续运行。

创建新增文件：

```bash
touch src/agent/__tests__/agent-streaming.test.ts
touch examples/stage-05-parallel-tools.ts examples/stage-05-abort.ts
```

### 5.1 Streaming 状态机

目标文件：`src/agent/agent.ts`

在 `Agent` 增加。`abort()` 是标准实现示例：它只发出中止信号，资源清理由持有资源的
provider/Tool 完成。

```ts
private _streaming = false;
private _abortController: AbortController | null = null;

get streaming() {
  return this._streaming;
}

abort() {
  this._abortController?.abort();
}
```

`stream()` 必须满足：

```ts
async *stream(message: UserMessage): AsyncGenerator<AgentEvent> {
  if (this._streaming) throw new Error("Agent is already streaming");

  this._abortController = new AbortController();
  this._streaming = true;
  try {
    // TODO 1：复用阶段 4 loop，并把 this._abortController.signal 同时传入 Model 和 Tool。
    // TODO 2：累计 snapshot 只产生 progress；最后一个 snapshot 才进入 transcript。
  } finally {
    this._streaming = false;
    this._abortController = null;
  }
}
```

注意 `finally`：成功、模型异常、Tool 异常、达到 max steps 和 abort 都必须复位状态。

在 `_think()` 中将 signal 放入 `ModelContext`。对 provider 每个累计 snapshot：

- 只有 text/thinking 时 yield `{ type: "progress", subtype: "thinking" }`；
- 出现 `tool_use` 时 yield `{ type: "progress", subtype: "tool", ... }`；
- 只有最后的完整 message 才 append 到 transcript 并产生 `message` event。

不要把每个累计 snapshot 都追加到 transcript。

### 5.2 并发 Tool 调度

同一个 assistant message 中的多个 Tool call 可以并发，但必须注意两个次序：

- Tool 启动顺序：按模型给出的数组顺序；
- Tool result 进入 transcript 的顺序：按实际完成顺序。

目标文件：`src/agent/agent.ts` 的 `_act()`（从阶段 4 的顺序执行逻辑中提取）。

核心骨架已实现“启动全部 promise”和“按完成顺序取结果”；最后一步留给读者：

```ts
const pending = toolUses.map(async (toolUse, index) => {
  try {
    const result = await registry.invoke({
      name: toolUse.name,
      input: toolUse.input,
      signal,
    });
    return { index, toolUse, result };
  } catch (error) {
    return { index, toolUse, result: normalizeUnexpectedError(error) };
  }
});

const remaining = new Set(pending.map((_, index) => index));

while (remaining.size > 0) {
  const candidates = [...remaining].map((index) => pending[index]!);
  const resolved = await Promise.race(candidates);
  remaining.delete(resolved.index);
  // TODO 3：把 resolved.result 序列化成与 resolved.toolUse.id 关联的 ToolMessage；
  // 先 append transcript，再 yield message event。不得按 resolved.index 重新排序。
}
```

为什么不直接 `Promise.all`：它虽然并发启动，但只能等最慢 Tool 完成后统一返回，用户看不到先完成的结果。

每个 pending promise 必须在内部捕获普通 Tool 异常，否则 `Promise.race` 的 rejection 会让整个调度器提前退出。

### 5.3 Abort Tool

目标文件：`examples/stage-05-abort.ts`

实现一个 `delay` Tool。示例输入规则：`ms` 是非负有限整数，`label` 非空；signal
可以缺省，但一旦中止必须清理 timer 并以 AbortError 结束。

```ts
invoke: async ({ ms, label }, signal) => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return { label, ms };
}
```

完成后还要移除 listener，避免长 session 累积无效闭包。可以用 `try/finally` 或在 resolve/reject 前统一 cleanup。

对于 `Bun.spawn`，abort handler 必须 kill 子进程，而不只是停止等待 stdout。

### 运行与观察

准备一次包含 `slow(300ms)` 和 `fast(30ms)` 的 assistant response：

```bash
bun run examples/stage-05-parallel-tools.ts
```

预期：

```text
0ms    tool_start slow
1ms    tool_start fast
~31ms  tool_end fast
~301ms tool_end slow
```

再运行中止示例：

```bash
bun run examples/stage-05-abort.ts
```

程序在 100ms 后调用 `agent.abort()`，应快速退出且没有悬挂 timer/process。

### 5.4 完整测试

目标文件：`src/agent/__tests__/agent-streaming.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run tools" }],
};

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function defineDelayTool(name: string, ms: number, onSignal?: (signal?: AbortSignal) => void) {
  return defineTool({
    name,
    description: `Wait ${ms}ms`,
    parameters: z.object({ description: z.string() }),
    invoke: async (_input, signal) => {
      onSignal?.(signal);
      await delay(ms, signal);
      return { name, ms };
    },
  });
}

function toolBatch(names: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: names.map((name) => ({
      type: "tool_use" as const,
      id: `call-${name}`,
      name,
      input: { description: `run ${name}` },
    })),
  };
}

async function drain(agent: Agent): Promise<void> {
  for await (const _event of agent.stream(USER)) {
    // consume
  }
}

describe("Agent streaming runtime", () => {
  test("appends tool results in completion order and runs them concurrently", async () => {
    const provider = new ScriptedModelProvider({
      responses: [
        toolBatch(["slow", "fast"]),
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [defineDelayTool("slow", 180), defineDelayTool("fast", 30)],
    });

    const startedAt = performance.now();
    await drain(agent);
    const elapsed = performance.now() - startedAt;
    const resultIds = agent.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.content[0]?.tool_use_id);

    expect(resultIds).toEqual(["call-fast", "call-slow"]);
    expect(elapsed).toBeLessThan(280);
  });

  test("passes the same signal to tools and resets streaming after abort", async () => {
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const toolStarted = new Promise<void>((resolve) => (started = resolve));
    const blockingTool = defineDelayTool("blocking", 10_000, (signal) => {
      receivedSignal = signal;
      started();
    });
    const provider = new ScriptedModelProvider({ responses: [toolBatch(["blocking"])] });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [blockingTool],
    });

    const run = drain(agent);
    await toolStarted;
    agent.abort();
    await expect(run).rejects.toBeDefined();

    expect(receivedSignal?.aborted).toBe(true);
    expect(agent.streaming).toBe(false);
  });

  test("does not cancel a sibling tool when one tool throws", async () => {
    let completed = false;
    const brokenTool = defineTool({
      name: "broken",
      description: "Throw",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        throw new Error("boom");
      },
    });
    const healthyTool = defineTool({
      name: "healthy",
      description: "Complete",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        await delay(20);
        completed = true;
        return "ok";
      },
    });
    const provider = new ScriptedModelProvider({
      responses: [
        toolBatch(["broken", "healthy"]),
        { role: "assistant", content: [{ type: "text", text: "observed" }] },
      ],
    });
    const agent = new Agent({
      model: new Model({ name: "scripted", provider }),
      prompt: "",
      tools: [brokenTool, healthyTool],
    });

    await drain(agent);
    expect(completed).toBe(true);
    expect(agent.messages.filter((message) => message.role === "tool")).toHaveLength(2);
  });

  test("passes abort to the active model request", async () => {
    let receivedSignal: AbortSignal | undefined;
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const provider: ModelProvider = {
      invoke: async () => ({ role: "assistant", content: [] }),
      stream: async function* (params: ModelProviderInvokeParams) {
        receivedSignal = params.signal;
        started();
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(params.signal?.reason), {
            once: true,
          });
        });
        yield { role: "assistant", content: [] };
      },
    };
    const agent = new Agent({
      model: new Model({ name: "blocking", provider }),
      prompt: "",
      tools: [],
    });

    const run = drain(agent);
    await modelStarted;
    agent.abort();
    await expect(run).rejects.toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  test("rejects a reentrant stream while a run is active", async () => {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    const provider: ModelProvider = {
      invoke: async () => ({ role: "assistant", content: [] }),
      stream: async function* ({ signal }: ModelProviderInvokeParams) {
        started();
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        yield { role: "assistant", content: [] };
      },
    };
    const agent = new Agent({
      model: new Model({ name: "blocking", provider }),
      prompt: "",
      tools: [],
    });

    const firstRun = drain(agent);
    await modelStarted;
    await expect(drain(agent)).rejects.toThrow("already streaming");
    agent.abort();
    await expect(firstRun).rejects.toBeDefined();
  });
});
```

时间测试不要断言精确毫秒。用足够大的快慢差并设置宽松上限，减少 CI 抖动。

### 阶段后对照

- `src/agent/agent.ts` 中 `AbortController` 和 `Promise.race`；
- `src/coding/tools/bash.ts` 的子进程中止；
- `src/community/openai/model-provider.ts` 的 signal 传递。

### 验收

- [ ] streaming snapshot 不污染 transcript；
- [ ] Tool result 按完成顺序可见；
- [ ] abort 能到达 model 和 Tool；
- [ ] 所有结束路径都复位 `_streaming`；
- [ ] `ADR-006` 解释 `Promise.race` pending-set 模式。

## 阶段 6：Middleware 生命周期与策略分离

### 本阶段解决的问题

如果 Todo、Skills、审批、日志和 context compaction 都硬编码进 `Agent.stream()`，循环很快会不可测试。Middleware 用稳定 hook 把横切能力放到 runtime 外部。

本阶段的核心不是“支持插件”，而是定义清晰的 mutation boundary。

创建新增文件：

```bash
touch src/agent/agent-middleware.ts src/agent/lifecycle-recorder.ts
touch src/agent/__tests__/middleware.test.ts examples/stage-06-middleware.ts
```

### 6.1 Hook 契约

目标文件：`src/agent/agent-middleware.ts`

定义以下 hooks：

```ts
export interface AgentMiddleware {
  beforeAgentRun?(params: {
    agentContext: AgentContext;
  }): Promise<Partial<AgentContext> | void>;

  afterAgentRun?(params: {
    agentContext: AgentContext;
  }): Promise<Partial<AgentContext> | void>;

  beforeAgentStep?(params: {
    agentContext: AgentContext;
    step: number;
  }): Promise<Partial<AgentContext> | void>;

  afterAgentStep?(params: {
    agentContext: AgentContext;
    step: number;
  }): Promise<Partial<AgentContext> | void>;

  beforeModel?(params: {
    modelContext: ModelContext;
    agentContext: AgentContext;
  }): Promise<Partial<ModelContext> | void>;

  afterModel?(params: {
    agentContext: AgentContext;
    message: AssistantMessage;
  }): Promise<Partial<AssistantMessage> | void>;

  beforeToolUse?(params: {
    agentContext: AgentContext;
    toolUse: ToolUseContent;
  }): Promise<
    | Partial<AgentContext>
    | { __skip: true; result: unknown }
    | void
  >;

  afterToolUse?(params: {
    agentContext: AgentContext;
    toolUse: ToolUseContent;
    toolResult: unknown;
  }): Promise<Partial<AgentContext> | void>;
}
```

### 6.2 两种 Context 不要混淆

- `AgentContext`：跨 step 持久存在，例如 transcript、可用 Tools、Skills；
- `ModelContext`：某一次 model 请求的临时视图，例如追加 reminder 或压缩后的 messages。

`beforeModel` 返回值合并到 `ModelContext`，不能不经声明地永久修改 `AgentContext.messages`。阶段 13 的 context compaction 将依赖这条边界。

### 6.3 Hook host 实现

目标文件：`src/agent/agent.ts`

在 `Agent` 内实现 `_beforeAgentRun()` 等私有方法。`_beforeModel()` 是标准实现示例；
其余 host 方法保持相同的 middleware 顺序和合并规则。

```ts
private async _beforeModel(modelContext: ModelContext) {
  for (const middleware of this.middlewares) {
    const result = await middleware.beforeModel?.({
      modelContext,
      agentContext: this._context,
    });
    if (result) Object.assign(modelContext, result);
  }
}
```

所有 hooks 按 middleware 数组顺序串行执行。这样后一个 middleware 能观察前一个的结果，调用顺序也可预测。

为 `beforeToolUse` 单独实现 skip normalization：

```ts
type BeforeToolUseDecision =
  | { skip: false }
  | { skip: true; result: unknown };
```

当 middleware 返回 `{ __skip: true, result }` 时，runtime 不调用真实 Tool，但仍然生成正常的 `tool_result` observation。

其余实现提示：

- TODO 1：`beforeAgentRun`、`beforeAgentStep`、`afterAgentStep` 和 `afterAgentRun` 的返回值只合并到 `AgentContext`；
- TODO 2：`afterModel` 的返回值只合并到本次 `AssistantMessage`；
- TODO 3：`beforeToolUse` 遇到第一个 `__skip` 后停止调用后续 `beforeToolUse`，但正常进入 observation；
- TODO 4：本课程规定 `afterAgentRun` 放在外层 `finally`，成功、abort、error、maxSteps 都调用一次；
- TODO 5：`afterAgentStep` 只在该 step 的 Tool observations 全部追加后调用，最终纯文本 step 不调用。

### 6.4 Lifecycle recorder

目标文件：`src/agent/lifecycle-recorder.ts`

实现一个只记录 hook 名称的 Middleware。第一个 hook 展示标准的 async block 写法，
其余 hook 完整给出，复制后可直接通过 Promise return type 检查。

```ts
export function defineLifecycleRecorder(log: string[]): AgentMiddleware {
  return {
    beforeAgentRun: async () => {
      // 标准实现示例：async hook 不返回 mutation 时自然解析为 undefined。
      log.push("beforeAgentRun");
    },
    beforeAgentStep: async ({ step }) => {
      log.push(`beforeAgentStep:${step}`);
    },
    beforeModel: async () => {
      log.push("beforeModel");
    },
    afterModel: async () => {
      log.push("afterModel");
    },
    beforeToolUse: async ({ toolUse }) => {
      log.push(`beforeToolUse:${toolUse.name}`);
    },
    afterToolUse: async ({ toolUse }) => {
      log.push(`afterToolUse:${toolUse.name}`);
    },
    afterAgentStep: async ({ step }) => {
      log.push(`afterAgentStep:${step}`);
    },
    afterAgentRun: async () => {
      log.push("afterAgentRun");
    },
  };
}
```

### 运行与观察

```bash
bun run examples/stage-06-middleware.ts
```

一次一轮 Tool、第二轮结束的 run 应展示类似顺序：

```text
beforeAgentRun
beforeAgentStep:1
beforeModel
afterModel
beforeToolUse:get_weather
afterToolUse:get_weather
afterAgentStep:1
beforeAgentStep:2
beforeModel
afterModel
afterAgentRun
```

本课程定义：没有 Tool 的终止 step 不调用 `afterAgentStep`，与 Helixent 当前语义保持一致。你可以选择不同语义，但必须在 ADR 和测试中固定下来。

### 6.5 完整测试

目标文件：`src/agent/__tests__/middleware.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";
import type { AgentMiddleware } from "../agent-middleware";
import { defineLifecycleRecorder } from "../lifecycle-recorder";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run" }],
};
const TOOL_CALL: AssistantMessage = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "call-1",
      name: "work",
      input: { description: "do work" },
    },
  ],
};
const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};

async function drain(agent: Agent): Promise<void> {
  for await (const _event of agent.stream(USER)) {
    // consume
  }
}

function defineAgent(options: {
  middlewares: AgentMiddleware[];
  invoke?: () => Promise<unknown>;
  responses?: AssistantMessage[];
  maxSteps?: number;
}): Agent {
  const tool = defineTool({
    name: "work",
    description: "Test work",
    parameters: z.object({ description: z.string() }),
    invoke: options.invoke ?? (async () => "ok"),
  });
  return new Agent({
    model: new Model({
      name: "scripted",
      provider: new ScriptedModelProvider({ responses: options.responses ?? [TOOL_CALL, FINAL] }),
    }),
    prompt: "test",
    tools: [tool],
    middlewares: options.middlewares,
    maxSteps: options.maxSteps,
  });
}

describe("Agent middleware", () => {
  test("runs the complete lifecycle in the documented order", async () => {
    const log: string[] = [];
    await drain(defineAgent({ middlewares: [defineLifecycleRecorder(log)] }));

    expect(log).toEqual([
      "beforeAgentRun",
      "beforeAgentStep:1",
      "beforeModel",
      "afterModel",
      "beforeToolUse:work",
      "afterToolUse:work",
      "afterAgentStep:1",
      "beforeAgentStep:2",
      "beforeModel",
      "afterModel",
      "afterAgentRun",
    ]);
  });

  test("runs multiple middleware in array order", async () => {
    const log: string[] = [];
    const defineOrderMiddleware = (name: string): AgentMiddleware => ({
      beforeModel: async () => {
        log.push(name);
      },
    });
    await drain(
      defineAgent({
        middlewares: [defineOrderMiddleware("first"), defineOrderMiddleware("second")],
      }),
    );

    expect(log.slice(0, 2)).toEqual(["first", "second"]);
  });

  test("keeps beforeModel messages out of the canonical transcript", async () => {
    const temporaryView: AgentMiddleware = {
      beforeModel: async ({ modelContext }) => ({
        messages: [
          ...modelContext.messages,
          { role: "user", content: [{ type: "text", text: "temporary reminder" }] },
        ],
      }),
    };
    const agent = defineAgent({ middlewares: [temporaryView] });

    await drain(agent);
    expect(JSON.stringify(agent.messages)).not.toContain("temporary reminder");
  });

  test("turns a skipped tool into an observation without invoking it", async () => {
    let invokeCount = 0;
    const deny: AgentMiddleware = {
      beforeToolUse: async () => ({
        __skip: true,
        result: { ok: false, code: "DENIED", error: "Denied by test" },
      }),
    };
    const agent = defineAgent({
      middlewares: [deny],
      invoke: async () => {
        invokeCount += 1;
        return "unexpected";
      },
    });

    await drain(agent);
    const toolMessage = agent.messages.find((message) => message.role === "tool");
    expect(invokeCount).toBe(0);
    expect(toolMessage?.content[0]?.content).toContain("DENIED");
  });

  test("calls afterToolUse with a normalized tool failure", async () => {
    let afterToolUseCount = 0;
    const observe: AgentMiddleware = {
      afterToolUse: async ({ toolResult }) => {
        expect(toolResult).toMatchObject({ ok: false });
        afterToolUseCount += 1;
      },
    };
    const agent = defineAgent({
      middlewares: [observe],
      invoke: async () => {
        throw new Error("boom");
      },
    });

    await drain(agent);
    expect(afterToolUseCount).toBe(1);
  });

  test("calls afterAgentRun once when maxSteps fails", async () => {
    let afterRunCount = 0;
    const agent = defineAgent({
      middlewares: [
        {
          afterAgentRun: async () => {
            afterRunCount += 1;
          },
        },
      ],
      responses: [TOOL_CALL],
      maxSteps: 1,
    });

    await expect(drain(agent)).rejects.toBeDefined();
    expect(afterRunCount).toBe(1);
  });
});
```

这里固定的标准语义是：Tool throw 先被规范化，再调用 `afterToolUse`；`afterAgentRun`
在外层 `finally` 中调用一次。若你选择不同语义，必须同时修改说明和完整测试。

### 阶段后对照

- `src/agent/agent-middleware.ts`；
- `src/agent/agent.ts` 的 `_beforeX` / `_afterX`；
- `src/coding/permissions/coding-approval-middleware.ts`。

### 验收

- [ ] `Agent.stream()` 中没有 Todo、Skills 或审批的业务判断；
- [ ] Middleware mutation boundary 有类型约束；
- [ ] skip 不会破坏 transcript 协议；
- [ ] hook 顺序由测试固定；
- [ ] `ADR-007` 解释 Middleware 顺序和异常语义。

## 第二部分综合练习

实现 `examples/runtime-demo.ts`，支持三个参数：

```bash
bun run examples/runtime-demo.ts --parallel
bun run examples/runtime-demo.ts --deny get_weather
bun run examples/runtime-demo.ts --abort-after 100
```

它必须完全离线，通过 scripted responses 展示：

- 正常 ReAct；
- 并发 Tool 完成顺序；
- Middleware 拒绝执行后的模型 observation；
- abort 后资源清理。

到这里，你已经具备一个可测试的通用 Agent runtime。下一部分才开始接真实模型和 Coding Agent。
