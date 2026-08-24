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

### 4.1 AgentContext 和 AgentEvent

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
    // TODO
  }

  get messages(): NonSystemMessage[] {
    // TODO
  }

  async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
    // TODO:
    // 1. append userMessage
    // 2. for step = 1 ... maxSteps
    // 3. think：调用 model.stream，保留最后一个 snapshot
    // 4. append/yield assistantMessage
    // 5. 提取 tool_use
    // 6. 没有 tool_use 就 return
    // 7. 顺序执行 tool，并 append/yield ToolMessage
    // 8. 超过 maxSteps 时抛出 MaximumStepsError
  }

  private _extractToolUses(message: AssistantMessage): ToolUseContent[] {
    // TODO: 使用 type predicate，禁止 as ToolUseContent[]
  }

  private async _invokeTool(toolUse: ToolUseContent): Promise<ToolMessage> {
    // TODO: 通过 ToolRegistry 执行并关联 tool_use_id
  }
}
```

### 4.3 Tool result 序列化策略

Provider wire protocol 通常要求 Tool result content 是字符串。定义一个明确的边界函数：

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

准备两个 scripted responses：

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

示例程序应该根据 `AgentEvent` 打印：

```text
[user] 北京天气如何？
[assistant/tool_use] get_weather #weather-1
[tool/tool_result] #weather-1 晴，26°C
[assistant] 北京今天晴，26°C。
[done] steps=2 messages=4
```

### 4.5 必写测试

```ts
test("runs think-act-observe until the model returns text", async () => {
  // 断言 role 顺序 user → assistant → tool → assistant
});

test("preserves tool_use_id in the result message", async () => {
  // TODO
});

test("turns an unknown tool into an observation", async () => {
  // Agent 不应崩溃，下一轮模型应看到 TOOL_NOT_FOUND
});

test("fails with a typed error after maxSteps", async () => {
  // scripted provider 每轮都返回 tool_use
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

### 5.1 Streaming 状态机

在 `Agent` 增加：

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
    // TODO: run loop
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

核心骨架：

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
  // TODO: append/yield resolved tool result
}
```

为什么不直接 `Promise.all`：它虽然并发启动，但只能等最慢 Tool 完成后统一返回，用户看不到先完成的结果。

每个 pending promise 必须在内部捕获普通 Tool 异常，否则 `Promise.race` 的 rejection 会让整个调度器提前退出。

### 5.3 Abort Tool

实现一个 `delay` Tool：

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

### 5.4 必写测试

- 快 Tool 的 `tool_result` 先进入 transcript；
- 总耗时接近最慢 Tool，而不是所有耗时之和；
- abort 时 provider 收到同一个 signal；
- abort 时 Tool 收到同一个 signal；
- abort 后 `agent.streaming === false`；
- 运行中再次调用 `stream()` 会失败；
- 一个 Tool 失败不会取消同批次其他 Tool。

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

### 6.1 Hook 契约

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

在 `Agent` 内实现 `_beforeAgentRun()` 等私有方法：

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

### 6.4 Lifecycle recorder

实现一个只记录 hook 名称的 Middleware：

```ts
export function defineLifecycleRecorder(log: string[]): AgentMiddleware {
  return {
    beforeAgentRun: async () => void log.push("beforeAgentRun"),
    beforeAgentStep: async ({ step }) => void log.push(`beforeAgentStep:${step}`),
    beforeModel: async () => void log.push("beforeModel"),
    afterModel: async () => void log.push("afterModel"),
    beforeToolUse: async ({ toolUse }) => void log.push(`beforeToolUse:${toolUse.name}`),
    afterToolUse: async ({ toolUse }) => void log.push(`afterToolUse:${toolUse.name}`),
    afterAgentStep: async ({ step }) => void log.push(`afterAgentStep:${step}`),
    afterAgentRun: async () => void log.push("afterAgentRun"),
  };
}
```

调整 TypeScript 写法，使每个 hook 符合定义的 Promise return type；不要为了照搬示例而保留类型错误。

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

### 6.5 必写测试

- lifecycle 完整顺序；
- 多个 middleware 按数组顺序执行；
- `beforeModel` 只修改单次 `ModelContext`；
- `beforeToolUse` skip 后真实 Tool invoke count 为 0；
- skip result 仍进入 transcript；
- Tool throw 时普通 middleware 的行为有明确测试；
- maxSteps/error 时 `afterAgentRun` 是否调用有明确语义。

最后两条不要求唯一答案，但不能依赖偶然的控制流。

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
