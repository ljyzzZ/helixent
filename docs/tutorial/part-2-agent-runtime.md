# 第二部分：Agent Runtime

这一部分完成阶段 4～6。你会把 Message、Model 和 Tool 连接成 ReAct loop，并逐步加入 streaming、并发、abort 和 Middleware。

每次循环只有两个真正的动作：

```text
think: transcript → model → assistant message
act:   tool_use → tool runtime → tool_result → transcript
```

observation 就是追加进 transcript 的 `ToolMessage`，下一轮 model 调用能看到它并继续决策。
answer 是模型返回无 Tool call 的 assistant message 后结束循环的分支。think、act、observe、answer
描述的是流程中的四个环节，不要求实现四个同名方法。

## 阶段 4：实现最小 ReAct loop

> 上一阶段回顾：阶段 3 定义了 Tool schema、Registry、本地输入校验、结构化错误和中止边界，使模型只能通过显式注册的 Tool 行动。

### 本阶段限制

为了看清最小算法，本阶段故意限制为：

- 使用离线 `ScriptedModelProvider` 模拟真实模型行为；
- Tool 顺序执行；
- 暂不支持 Middleware；
- 暂不实现 Ctrl+C abort；
- 每轮 model 只读取最终 response，不展示中间 progress。

创建文件：

```bash
mkdir -p src/agent/__tests__ examples/__tests__
touch src/agent/agent-context.ts src/agent/agent-event.ts src/agent/agent.ts
touch src/agent/errors.ts src/agent/serialize-tool-result.ts src/agent/index.ts
touch src/agent/__tests__/agent.test.ts examples/stage-04-react-loop.ts
touch examples/message-stream-printer.ts examples/__tests__/message-stream-printer.test.ts
```

执行后新增结构如下：

```text
src/agent/                              # 通用 Agent runtime
├── agent-context.ts                    # 保存 prompt、transcript 与可用 Tools
├── agent-event.ts                      # 定义流式运行期间对外发送的事件
├── agent.ts                            # 实现最小 ReAct loop 与 transcript 更新
├── errors.ts                           # 定义最大步数等可识别的运行错误
├── serialize-tool-result.ts            # 将 Tool 返回值规范化为 transcript 字符串
├── index.ts                            # 统一导出 Agent runtime 公共 API
└── __tests__/
    └── agent.test.ts                   # 验证循环终止、Tool observation 等不变量
examples/
├── stage-04-react-loop.ts              # 用离线脚本模型演示一次完整 ReAct 循环
├── message-stream-printer.ts           # 重放完整消息，在当前行逐步显示
└── __tests__/
    └── message-stream-printer.test.ts  # 验证逐行重放不会重复输出
```

本阶段还会修改两个阶段 2 已有文件：

```text
src/foundation/models/
├── scripted-model-provider.ts          # 扩展 stream，为三种 assistant content 生成累计快照
└── __tests__/
    └── model.test.ts                   # 增加结构化 response 的回归测试
```

### 4.1 AgentContext 和 AgentEvent

目标文件：`src/agent/agent-context.ts`

```ts
import type { NonSystemMessage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface AgentContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
}
```

目标文件：`src/agent/agent-event.ts`

```ts
import type { AssistantMessage, ToolMessage } from "@/foundation/messages";

export type AgentEvent =
  | { type: "message"; message: AssistantMessage | ToolMessage }
  | { type: "progress"; subtype: "thinking" }
  | { type: "progress"; subtype: "tool"; name: string; input: unknown };
```

不要为 `thinking`、`acting` 再维护一套可变状态。transcript 和 event stream 已足够表达发生过什么；重复状态会在异常路径下产生不一致。

### 4.2 Agent 骨架

目标文件：`src/agent/errors.ts`

`MaximumStepsError` 表示 Agent 达到最大步数后仍未结束：

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

本阶段把主流程集中在 `stream()` 中，先看清消息如何流转。四个环节对应下面这些 TODO：

| 环节 | 在最小循环中的位置 |
|---|---|
| think | TODO 2～3：把当前 transcript 交给模型，取得最终 assistant message；不要求消息包含 `thinking` block。 |
| act | TODO 6、10：按顺序执行 `tool_use`，通过 Registry 调用工具。 |
| observe | TODO 6～7、10：将工具结果或错误转换为 `ToolMessage`，追加到 transcript，供下一轮模型读取。 |
| answer | TODO 4～5：输出完整 assistant message；没有 Tool call 时结束循环。 |

有 Tool call 时，执行工具并回写结果后继续下一轮 think，直到某轮模型生成不含 Tool call
的最终回答。阶段 5 再从这里提取 `_think()`、`_act()`，为 progress、并发和取消信号建立清晰的修改位置。

<details>
<summary>展开完整代码：<code>agent.ts</code></summary>

```ts
import type {
  AssistantMessage,
  NonSystemMessage,
  ToolMessage,
  ToolUseContent,
  UserMessage,
} from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ToolRegistry } from "@/foundation/tools";
import type { Tool } from "@/foundation/tools";

import type { AgentContext } from "./agent-context";
import type { AgentEvent } from "./agent-event";

export class Agent {
  private readonly _context: AgentContext;
  private readonly _toolRegistry: ToolRegistry;

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
    this.model = options.model;
    this.maxSteps = options.maxSteps ?? 20;
    this._toolRegistry = new ToolRegistry({ tools: options.tools ?? [] });
    this._context = {
      prompt: options.prompt,
      messages: [...(options.messages ?? [])],
      tools: this._toolRegistry.list(),
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
    throw new Error("TODO: implement Agent._extractToolUses");
  }

  private async _invokeTool(toolUse: ToolUseContent): Promise<ToolMessage> {
    // TODO 10：通过 this._toolRegistry.invoke() 执行。成功时序列化 result.value，
    // 失败时序列化完整错误结果；tool_use_id 必须原样复制 toolUse.id。
    throw new Error("TODO: implement Agent._invokeTool");
  }
}
```

</details>

`_toolRegistry` 是 Tool 执行的唯一入口，负责查找、输入校验和错误规范化；
`AgentContext.tools` 保存 `list()` 返回的数组副本，供 Model 和 Middleware 查看可用 Tool。
两者在构造阶段来自同一份 `options.tools`，运行过程中不要再建立临时 Registry。

### 4.3 Tool result 序列化策略

Provider wire protocol 通常要求 Tool result content 是字符串。定义一个明确的边界函数：

目标文件：`src/agent/serialize-tool-result.ts`

```ts
export function serializeToolResult(result: unknown): string {
  const fallback =
    '{"ok":false,"summary":"Tool returned a non-serializable value",' +
    '"error":"Tool result cannot be serialized","code":"NON_SERIALIZABLE_TOOL_RESULT"}';

  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result) ?? fallback;
  } catch {
    return fallback;
  }
}
```

不要把原始对象塞进 canonical `ToolResultContent`，否则 checkpoint、provider converter 和 TUI 会分别发明序列化行为。

最后填充本阶段创建的 Agent barrel：

目标文件：`src/agent/index.ts`

```ts
export { Agent } from "./agent";
export type { AgentContext } from "./agent-context";
export type { AgentEvent } from "./agent-event";
export { MaximumStepsError } from "./errors";
```

这里只导出 Agent runtime 的公共入口；`serializeToolResult` 是 Agent 内部使用的协议边界，
不需要暴露为公共 API。

### 4.4 让 ScriptedModelProvider 支持三种 Content 的累计快照

阶段 2 的 `ScriptedModelProvider.stream()` 只接受单个 text block。现在把它扩展为按
content 数组顺序生成快照，每个快照都保留已经完成的 block：

- `text.text` 和 `thinking.thinking` 按 Unicode code point 累积；
- `tool_use` 保持 `id` 稳定，先累积 `name`，再逐个填充 `input` 字段。字符串字段逐字累积，
  数字、布尔值、null、数组和嵌套对象作为一个字段值整体加入；
- `input` 始终是对象，不把不完整的 JSON 字符串冒充 canonical input。真实 Provider 的
  fragmented JSON 解析留到阶段 7；这里模拟的是解析后的累计对象；
- 空 content、空文本、空 thinking 和空参数也有最终快照。中间快照相互独立，
  最终快照与同一脚本 response 的 `invoke()` 结果深度相等。

目标文件：`src/foundation/models/scripted-model-provider.ts`

用下面的版本替换原文件：

<details>
<summary>展开完整代码：<code>scripted-model-provider.ts</code></summary>

```ts
import type { AssistantMessage } from "@/foundation/messages";

import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

type AssistantContent = AssistantMessage["content"][number];

function* textPrefixes(text: string): Generator<string> {
  let accumulated = "";
  if (text.length === 0) yield accumulated;
  for (const character of text) {
    accumulated += character;
    yield accumulated;
  }
}

function* contentSnapshots(content: AssistantContent): Generator<AssistantContent> {
  if (content.type === "text") {
    for (const text of textPrefixes(content.text)) yield { ...content, text };
  } else if (content.type === "thinking") {
    for (const thinking of textPrefixes(content.thinking)) yield { ...content, thinking };
  } else {
    for (const name of textPrefixes(content.name)) yield { ...content, name, input: {} };

    let input: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(content.input)) {
      if (typeof value === "string") {
        for (const prefix of textPrefixes(value)) {
          yield { ...content, input: { ...input, [key]: prefix } };
        }
      } else {
        yield { ...content, input: { ...input, [key]: value } };
      }
      input = { ...input, [key]: value };
    }
  }
}

export class ScriptedModelProvider implements ModelProvider {
  private readonly _responses: AssistantMessage[];
  private _cursor = 0;

  constructor({ responses }: { responses: AssistantMessage[] }) {
    this._responses = structuredClone(responses);
  }

  async invoke({ signal }: ModelProviderInvokeParams): Promise<AssistantMessage> {
    return this._nextResponse(signal);
  }

  async *stream({ signal }: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = this._nextResponse(signal);
    const completed: AssistantContent[] = [];
    let pending: AssistantMessage | undefined;

    for (const content of response.content) {
      for (const partial of contentSnapshots(content)) {
        signal?.throwIfAborted();
        // 向前看一个快照，避免额外重复发送最后一个完整快照。
        if (pending) yield pending;
        pending = { role: "assistant", content: structuredClone([...completed, partial]) };
      }
      completed.push(content);
    }
    signal?.throwIfAborted();
    yield response;
  }

  private _nextResponse(signal?: AbortSignal): AssistantMessage {
    signal?.throwIfAborted();
    const response = this._responses[this._cursor];
    if (!response) {
      throw new Error("ScriptedModelProvider has no response left");
    }
    this._cursor += 1;
    return structuredClone(response);
  }
}
```

</details>

`invoke()` 和 `stream()` 共用 `_nextResponse()`，每次调用只推进一次 cursor。构造函数、
读取 response 和中间快照各自复制数据，避免消费者修改快照时污染后续输出。
`pending` 暂存最新快照：只有发现下一个快照时才把它作为中间结果发出；遍历结束后直接
发送原始完整 response，因此最终结果保留 usage 等元数据。这里按迭代结束判断响应完成，无需增加新的 Message 字段。

### 4.5 离线 weather agent

阶段 4 的 Agent 仍只对外返回完整 `message`，不转发模型的中间快照。这里把流式展示
放在示例层：收到完整 assistant message 后，用新的 `ScriptedModelProvider` 将这条消息
重放成累计快照，再把新增字符写到终端。

这是消息完成后的展示重放；模型生成期间的进度仍留到阶段 5。Tool 返回的 `ToolMessage`
不属于 `ModelProvider` 的输出类型，它的结果行直接交给逐字 `write` 函数。

目标文件：`examples/message-stream-printer.ts`

<details>
<summary>展开完整代码：<code>message-stream-printer.ts</code></summary>

```ts
import type { AssistantMessage, ToolMessage } from "@/foundation/messages";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

/** 在展示层逐行重放完整消息，write 可注入终端输出或测试收集函数。 */
export function defineMessagePrinter({ write }: {
  write: (text: string) => void | Promise<void>;
}): (message: AssistantMessage | ToolMessage) => Promise<void> {
  return async (message) => {
    if (message.role === "tool") {
      for (const item of message.content) {
        await write(`[tool/tool_result] #${item.tool_use_id} ${item.content}`);
        await write("\n");
      }
      return;
    }

    let contentIndex = 0;
    let written = "";
    let lineOpen = false;

    async function printSnapshot(snapshot: AssistantMessage, complete: boolean): Promise<void> {
      while (contentIndex < snapshot.content.length) {
        const item = snapshot.content[contentIndex];
        if (!item) break;
        const label = item.type === "text" ? "assistant" : `assistant/${item.type}`;
        const body = item.type === "text" ? item.text
          : item.type === "thinking" ? item.thinking : item.name;

        if (!lineOpen) {
          await write(`[${label}] `);
          lineOpen = true;
        }
        await write(body.slice(written.length));
        written = body;

        if (!complete && contentIndex === snapshot.content.length - 1) break;
        if (item.type === "tool_use") await write(` #${item.id}`);
        await write("\n");
        contentIndex += 1;
        written = "";
        lineOpen = false;
      }
    }

    const replay = new ScriptedModelProvider({ responses: [message] });
    for await (const snapshot of replay.stream({ model: "display-replay", messages: [] })) {
      await printSnapshot(snapshot, false);
    }
    await printSnapshot(message, true);
  };
}
```

</details>

每次重放独立记录当前 block 及已经写出的正文长度，只追加累计快照中新增的后缀。
下一个 block 出现或重放结束时才换行，因此不会把 `上`、`上海` 等累计内容重复打印。
Tool call 行逐步显示 name，完成时补上稳定的 id；input 也在重放快照中逐步补齐，
简短展示沿用原来的 `name #id` 格式。

目标文件：`examples/stage-04-react-loop.ts`

下面使用一个确定性的 fake provider：第一轮
生成 `tool_use`，第二轮按 `tool_use_id` 读取真实 Tool exchange，再根据 observation 生成文本。
`get_weather` 使用传入的 `city` 生成离线结果，不访问网络。

<details>
<summary>展开完整代码：<code>stage-04-react-loop.ts</code></summary>

```ts
import { z } from "zod";

import { Agent } from "@/agent/agent";
import type {
  AssistantMessage,
  Message,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type {
  ModelProvider,
  ModelProviderInvokeParams,
} from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

import { defineMessagePrinter } from "./message-stream-printer";

interface WeatherObservation {
  city: string;
  condition: string;
  temperatureC: number;
}

function findLatestWeatherExchange(messages: Message[]): {
  toolUse: ToolUseContent;
  toolResult: ToolResultContent;
} | undefined {
  for (let resultIndex = messages.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const resultMessage = messages[resultIndex];
    if (resultMessage?.role !== "tool") continue;

    for (const toolResult of resultMessage.content) {
      for (let useIndex = resultIndex - 1; useIndex >= 0; useIndex -= 1) {
        const useMessage = messages[useIndex];
        if (useMessage?.role !== "assistant") continue;

        const toolUse = useMessage.content.find(
          (item): item is ToolUseContent =>
            item.type === "tool_use" && item.id === toolResult.tool_use_id,
        );
        if (toolUse?.name === "get_weather") return { toolUse, toolResult };
      }
    }
  }
  return undefined;
}

function parseWeatherObservation(content: string): WeatherObservation {
  const value: unknown = JSON.parse(content);
  if (
    typeof value !== "object" ||
    value === null ||
    !("city" in value) ||
    typeof value.city !== "string" ||
    !("condition" in value) ||
    typeof value.condition !== "string" ||
    !("temperatureC" in value) ||
    typeof value.temperatureC !== "number"
  ) {
    throw new Error("get_weather returned an invalid observation");
  }
  return {
    city: value.city,
    condition: value.condition,
    temperatureC: value.temperatureC,
  };
}

class DemoWeatherModelProvider implements ModelProvider {
  constructor(private readonly _city: string) {}

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    params.signal?.throwIfAborted();

    const exchange = findLatestWeatherExchange(params.messages);
    if (!exchange) {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "weather-1",
            name: "get_weather",
            input: { description: `查询${this._city}天气`, city: this._city },
          },
        ],
      };
    }

    const requestedCity = exchange.toolUse.input.city;
    if (typeof requestedCity !== "string") {
      throw new Error("get_weather tool_use did not contain a city");
    }
    const observation = parseWeatherObservation(exchange.toolResult.content);
    if (observation.city !== requestedCity) {
      throw new Error("get_weather observation does not match its tool_use");
    }

    return {
      role: "assistant",
      content: [{
        type: "text",
        text: `${requestedCity}今天${observation.condition}，${observation.temperatureC}°C。`,
      }],
    };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = await this.invoke(params);
    const scripted = new ScriptedModelProvider({ responses: [response] });
    yield* scripted.stream(params);
  }
}

const getWeatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather without network access",
  parameters: z.object({
    description: z.string(),
    city: z.string(),
  }),
  invoke: async ({ city }) => ({ city, condition: "晴", temperatureC: 26 }),
});

const city = Bun.argv[2]?.trim() || "北京";
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: `${city}天气如何？` }],
};

const printMessage = defineMessagePrinter({
  write: async (text) => {
    for (const character of text) {
      process.stdout.write(character);
      if (character !== "\n") await Bun.sleep(20);
    }
  },
});

const provider = new DemoWeatherModelProvider(city);
const agent = new Agent({
  model: new Model({ name: "scripted", provider }),
  prompt: "Use get_weather when the user asks about weather.",
  tools: [getWeatherTool],
});
const userText = userMessage.content.find((item) => item.type === "text")?.text ?? "";
let steps = 0;

console.log(`[user] ${userText}`);
for await (const event of agent.stream(userMessage)) {
  if (event.type !== "message") continue;
  if (event.message.role === "assistant") steps += 1;
  await printMessage(event.message);
}

console.log(`[done] steps=${steps} messages=${agent.messages.length}`);
```

</details>

这个 fake provider 只预设“先调用哪个 Tool”，不预设最终答案。第二轮回答读取真实的
`tool_result`，再根据 Tool observation 生成文本。若 Agent 没有追加 `tool_result`、关联错
`tool_use_id`，或者 Tool 返回的 city 与调用参数不一致，示例会直接失败。

运行：

```bash
bun run examples/stage-04-react-loop.ts
bun run examples/stage-04-react-loop.ts 上海
```

示例只消费 `message` 事件。每收到一条完整消息，就等待这一条的展示重放结束，
再读取下一个事件，从而保持 Tool call、Tool result、最终回答三行的顺序。
`ScriptedModelProvider` 在模型侧用于离线响应，在展示侧用于重放已经完成的消息；
这两个用途使用独立实例，展示不会推进模型侧的 cursor，也不会修改 transcript。

每个字符间的 20ms 延迟用于看清离线演示，Provider 本身不等待。
`get_weather` 的结果在工具执行完成后一次性返回，再由 `write` 逐字显示；
assistant 的 name/text 也在完整消息到达后开始重放。这一阶段展示的是完整结果的逐字效果。

运行 `bun run examples/stage-04-react-loop.ts 上海`，逐字显示结束后应得到：

```text
[user] 上海天气如何？
[assistant/tool_use] get_weather #weather-1
[tool/tool_result] #weather-1 {"city":"上海","condition":"晴","temperatureC":26}
[assistant] 上海今天晴，26°C。
[done] steps=2 messages=4
```

### 4.6 完整测试

先为刚刚扩展的结构化 response 增加回归测试。

目标文件：`src/foundation/models/__tests__/model.test.ts`

在文件末尾增加：

<details>
<summary>展开新增测试：<code>model.test.ts</code></summary>

```ts
async function collectSnapshots(provider: ScriptedModelProvider): Promise<AssistantMessage[]> {
  const snapshots: AssistantMessage[] = [];
  for await (const snapshot of provider.stream({ model: "scripted", messages: [] })) {
    snapshots.push(snapshot);
  }
  return snapshots;
}

test("streams thinking, tool_use and text without losing earlier blocks", async () => {
  const response: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "查🤔" },
      {
        type: "tool_use", id: "call-1", name: "get_weather",
        input: { city: "上海", days: 2, options: { units: "celsius" } },
      },
      { type: "text", text: "好🌤" },
    ],
    usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 },
  };
  const snapshots = await collectSnapshots(new ScriptedModelProvider({ responses: [response] }));
  const invoked = await new ScriptedModelProvider({ responses: [response] })
    .invoke({ model: "scripted", messages: [] });

  expect(snapshots[0]?.content).toEqual([{ type: "thinking", thinking: "查" }]);
  expect(snapshots.some((snapshot) => snapshot.content.some(
    (item) => item.type === "tool_use" && item.name === "g" && item.id === "call-1",
  ))).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.content.some(
    (item) => item.type === "tool_use" && item.input.city === "上",
  ))).toBe(true);
  expect(snapshots.some((snapshot) => snapshot.content.some(
    (item) => item.type === "text" && item.text === "好",
  ))).toBe(true);
  for (const snapshot of snapshots) {
    if (snapshot.content.length >= 2) expect(snapshot.content[0]).toEqual(response.content[0]);
    if (snapshot.content.length === 3) expect(snapshot.content[1]).toEqual(response.content[1]);
  }
  expect(snapshots.at(-1)).toEqual(invoked);
});

test("emits a final snapshot for empty content and empty blocks", async () => {
  const contents: AssistantMessage["content"][] = [
    [],
    [{ type: "text", text: "" }],
    [{ type: "thinking", thinking: "" }],
    [{ type: "tool_use", id: "empty", name: "noop", input: {} }],
    [
      { type: "thinking", thinking: "" },
      { type: "tool_use", id: "empty", name: "noop", input: { value: "", enabled: false, data: null, items: [] } },
      { type: "text", text: "" },
    ],
  ];
  for (const content of contents) {
    const response: AssistantMessage = { role: "assistant", content };
    const snapshots = await collectSnapshots(new ScriptedModelProvider({ responses: [response] }));
    expect(snapshots.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toEqual(response);
  }
});

test("isolates snapshots from consumers and the original script", async () => {
  const response: AssistantMessage = {
    role: "assistant",
    content: [
      { type: "tool_use", id: "call-1", name: "go", input: { nested: { value: 1 }, city: "上海" } },
      { type: "text", text: "完成" },
    ],
  };
  const expected = structuredClone(response);
  const provider = new ScriptedModelProvider({ responses: [response] });
  response.content.length = 0;
  const stream = provider.stream({ model: "scripted", messages: [] });
  for await (const snapshot of stream) {
    const item = snapshot.content[0];
    if (item?.type === "tool_use" && item.input.nested) {
      Object.assign(item.input.nested, { value: 99 });
      item.name = "changed";
      snapshot.content.length = 0;
      // 此时后面还有 city 和 text；继续读取，验证它们未受修改影响。
      let final: AssistantMessage | undefined;
      for await (const remaining of stream) final = remaining;
      expect(final).toEqual(expected);
      return;
    }
  }
  throw new Error("Expected an intermediate snapshot containing nested input");
});

test("checks abort before consuming a response and between snapshots", async () => {
  const first: AssistantMessage = { role: "assistant", content: [{ type: "thinking", thinking: "想一想" }] };
  const second: AssistantMessage = { role: "assistant", content: [{ type: "text", text: "next" }] };
  const provider = new ScriptedModelProvider({ responses: [first, second] });
  const aborted = new AbortController();
  aborted.abort();
  const stopped = provider.stream({ model: "scripted", messages: [], signal: aborted.signal });
  await expect(stopped.next()).rejects.toBeDefined();

  const controller = new AbortController();
  const stream = provider.stream({ model: "scripted", messages: [], signal: controller.signal });
  const start = await stream.next();
  expect(start.value?.content[0]).toEqual({ type: "thinking", thinking: "想" });
  controller.abort();
  await expect(stream.next()).rejects.toBeDefined();
  expect(await provider.invoke({ model: "scripted", messages: [] })).toEqual(second);
});
```

</details>

先单独运行这些回归测试，确认阶段 4 对 `ScriptedModelProvider` 的适配生效：

```bash
bun test src/foundation/models/__tests__/model.test.ts
```

目标文件：`src/agent/__tests__/agent.test.ts`

<details>
<summary>展开完整代码：<code>agent.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type {
  AssistantMessage,
  Message,
  ToolResultContent,
  ToolUseContent,
  UserMessage,
} from "@/foundation/messages";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";
import { defineTool } from "@/foundation/tools";
import type { Tool } from "@/foundation/tools";

import { Agent } from "../agent";
import { MaximumStepsError } from "../errors";

const weatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather",
  parameters: z.object({ description: z.string(), city: z.string() }),
  invoke: async ({ city }) => ({ city, condition: "晴", temperatureC: 26 }),
});

function userMessage(city: string): UserMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `${city}天气如何？` }],
  };
}

function findLatestWeatherExchange(messages: Message[]): {
  toolUse: ToolUseContent;
  toolResult: ToolResultContent;
} | undefined {
  for (let resultIndex = messages.length - 1; resultIndex >= 0; resultIndex -= 1) {
    const resultMessage = messages[resultIndex];
    if (resultMessage?.role !== "tool") continue;

    for (const toolResult of resultMessage.content) {
      for (let useIndex = resultIndex - 1; useIndex >= 0; useIndex -= 1) {
        const useMessage = messages[useIndex];
        if (useMessage?.role !== "assistant") continue;
        const toolUse = useMessage.content.find(
          (item): item is ToolUseContent =>
            item.type === "tool_use" && item.id === toolResult.tool_use_id,
        );
        if (toolUse?.name === "get_weather") return { toolUse, toolResult };
      }
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordFromJson(content: string): Record<string, unknown> {
  const value: unknown = JSON.parse(content);
  if (!isRecord(value)) {
    throw new Error("Expected a JSON object Tool observation");
  }
  return value;
}

class WeatherLoopProvider implements ModelProvider {
  constructor(private readonly _city: string) {}

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    params.signal?.throwIfAborted();

    const exchange = findLatestWeatherExchange(params.messages);
    if (!exchange) {
      return {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: "weather-1",
          name: "get_weather",
          input: { description: `查询${this._city}天气`, city: this._city },
        }],
      };
    }

    const observation = recordFromJson(exchange.toolResult.content);
    if (observation.ok === false) {
      const code = typeof observation.code === "string"
        ? observation.code
        : "UNKNOWN_TOOL_ERROR";
      return {
        role: "assistant",
        content: [{ type: "text", text: `天气查询失败：${code}` }],
      };
    }

    const city = exchange.toolUse.input.city;
    if (
      typeof city !== "string" ||
      observation.city !== city ||
      typeof observation.condition !== "string" ||
      typeof observation.temperatureC !== "number"
    ) {
      throw new Error("Invalid or mismatched weather observation");
    }
    return {
      role: "assistant",
      content: [{
        type: "text",
        text: `${city}今天${observation.condition}，${observation.temperatureC}°C。`,
      }],
    };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = await this.invoke(params);
    const scripted = new ScriptedModelProvider({ responses: [response] });
    yield* scripted.stream(params);
  }
}

async function drain(agent: Agent, city = "北京"): Promise<void> {
  for await (const _event of agent.stream(userMessage(city))) {
    // 消费完整 event stream；断言统一读取 agent.messages。
  }
}

function defineWeatherAgent(options: {
  city?: string;
  tools?: Tool[];
  maxSteps?: number;
} = {}): Agent {
  const provider = new WeatherLoopProvider(options.city ?? "北京");
  return new Agent({
    model: new Model({ name: "scripted", provider }),
    prompt: "Answer with tools when needed",
    tools: options.tools ?? [weatherTool],
    maxSteps: options.maxSteps,
  });
}

describe("Agent", () => {
  test("feeds the real Tool observation into the next model step", async () => {
    const receivedCities: string[] = [];
    const rainyWeatherTool = defineTool({
      name: "get_weather",
      description: "Return a test-specific weather observation",
      parameters: z.object({ description: z.string(), city: z.string() }),
      invoke: async ({ city }) => {
        receivedCities.push(city);
        return { city, condition: "雨", temperatureC: 17 };
      },
    });
    const agent = defineWeatherAgent({ city: "上海", tools: [rainyWeatherTool] });
    await drain(agent, "上海");

    expect(agent.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(receivedCities).toEqual(["上海"]);
    const toolMessage = agent.messages.find((message) => message.role === "tool");
    expect(JSON.parse(toolMessage?.content[0]?.content ?? "null")).toEqual({
      city: "上海",
      condition: "雨",
      temperatureC: 17,
    });
    expect(agent.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "上海今天雨，17°C。" }],
    });
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
    expect(agent.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "天气查询失败：TOOL_NOT_FOUND" }],
    });
  });

  test("fails with a typed error after maxSteps", async () => {
    const agent = defineWeatherAgent({ maxSteps: 1 });
    expect(drain(agent)).rejects.toBeInstanceOf(MaximumStepsError);
  });
});
```

</details>

未知 Tool 和普通 Tool failure 应反馈给模型，让模型有机会修正。只有 runtime invariant 被破坏、用户中止或达到上限时，Agent run 才整体失败。

再验证展示层：只传入完整消息，也能分多次写入正文，并且每个 block 只输出一行。

目标文件：`examples/__tests__/message-stream-printer.test.ts`

<details>
<summary>展开完整代码：<code>message-stream-printer.test.ts</code></summary>

```ts
import { expect, test } from "bun:test";

import type { AssistantMessage } from "@/foundation/messages";

import { defineMessagePrinter } from "../message-stream-printer";

test("replays complete weather messages incrementally without duplicate lines", async () => {
  const chunks: string[] = [];
  const print = defineMessagePrinter({ write: (text) => { chunks.push(text); } });
  const call: AssistantMessage = {
    role: "assistant",
    content: [{ type: "tool_use", id: "weather-1", name: "get_weather", input: { city: "上海" } }],
  };
  const original = structuredClone(call);
  await print(call);
  expect(call).toEqual(original);
  expect(chunks).toContain("g");
  expect(chunks).toContain("e");
  expect(chunks.join("")).toBe("[assistant/tool_use] get_weather #weather-1\n");

  await print({
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "weather-1", content: '{"city":"上海","condition":"晴","temperatureC":26}' }],
  });
  await print({ role: "assistant", content: [{ type: "text", text: "上海今天晴，26°C。" }] });
  expect(chunks).toContain("上");
  expect(chunks).toContain("海");
  expect(chunks.join("")).toBe(
    '[assistant/tool_use] get_weather #weather-1\n' +
    '[tool/tool_result] #weather-1 {"city":"上海","condition":"晴","temperatureC":26}\n' +
    '[assistant] 上海今天晴，26°C。\n',
  );
});

test("keeps mixed blocks, Unicode and consecutive tool calls on separate lines", async () => {
  const chunks: string[] = [];
  const print = defineMessagePrinter({ write: (text) => { chunks.push(text); } });
  await print({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "想🤔" },
      { type: "text", text: "" },
      { type: "tool_use", id: "a", name: "first", input: {} },
      { type: "tool_use", id: "b", name: "second", input: {} },
      { type: "text", text: "好🌤" },
    ],
  });
  await print({ role: "assistant", content: [] });
  expect(chunks).toContain("🤔");
  expect(chunks).toContain("🌤");
  expect(chunks.join("")).toBe(
    "[assistant/thinking] 想🤔\n[assistant] \n" +
    "[assistant/tool_use] first #a\n[assistant/tool_use] second #b\n[assistant] 好🌤\n",
  );
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test
```

### 本阶段小结

本阶段把 Message、Model 和 Tool 连接成最小的顺序 ReAct loop：Agent 保存 transcript，
调用模型生成 `tool_use`，通过 ToolRegistry 执行 Tool，再将序列化后的 `tool_result`
作为 observation 交给下一轮模型。没有 Tool call 时结束循环，超过 `maxSteps` 时抛出
`MaximumStepsError`；普通 Tool failure 也会成为模型可见的 observation。

`ScriptedModelProvider` 已支持 `text`、`thinking`、`tool_use` 及混合内容的累计快照。
离线 weather 示例根据真实 Tool observation 生成回答，Agent 对外仍只返回完整消息，
示例层再逐行、逐字重放这些消息。因此，展示效果与 Agent 的最小循环保持各自的职责。

阶段 5 先从 `stream()` 提取 `_think()`、`_act()`，用本阶段测试确认行为一致，
再加入模型生成期间的 progress、并发 Tool 调度和 AbortSignal 传递。阶段 6 再引入 Middleware。

### 验收

- [ ] 能指出 think、act、observe、answer 在最小循环中的位置，不依赖四个同名方法；
- [ ] transcript 的 role 顺序正确；
- [ ] `text`、`thinking`、`tool_use` 及混合 content 都产生累计快照；
- [ ] 示例只消费完整 message，在展示层逐行重放，不改变 AgentEvent 或 transcript；
- [ ] 每个 `tool_result` 都能关联 `tool_use_id`；
- [ ] 最后一条无 Tool call 的 assistant message 终止循环；
- [ ] `maxSteps` 是 runtime guard，不是 prompt 建议；
- [ ] `ADR-005` 解释为什么 Tool failure 是 observation。

## 阶段 5：Streaming、并发 Tool 与 Abort

> 上一阶段回顾：阶段 4 在 `stream()` 中组装了最小顺序 ReAct loop，覆盖 think、act、observe、answer 四个环节，并用 `maxSteps` 限制循环。本阶段先提取模型调用和工具执行方法，再扩展运行能力。

### 本阶段解决的问题

阶段 4 能工作，但有三个真实产品问题：

1. 模型长响应期间用户看不到进度；
2. 同一 assistant message 中的独立 Tool 被串行执行；
3. 用户中止后网络请求或子进程仍可能继续运行。

创建新增文件：

```bash
touch src/agent/__tests__/think-hints.test.ts
touch src/agent/__tests__/agent-streaming.test.ts
touch examples/stage-05-parallel-tools.ts examples/stage-05-abort.ts
```

执行后新增结构如下：

```text
src/agent/__tests__/
├── think-hints.test.ts                 # 5.1 验证 progress 分类、最终消息和 transcript 边界
└── agent-streaming.test.ts             # 5.4 验证并行 Tool 与 abort 语义
examples/
├── stage-05-parallel-tools.ts          # 演示多个 Tool call 的并行执行与稳定回写
└── stage-05-abort.ts                   # 演示中止信号如何贯穿 model 和 Tool
```

### 5.0 提取模型调用与工具执行

目标文件：`src/agent/agent.ts`

先整理已经通过阶段 4 测试的代码。模型调用即将增加 progress，工具执行即将改为并发，
把它们分别提取出来，可以让 `stream()` 继续专注于循环编排。这一步仍顺序执行 Tool、
只输出完整 message，不改变消息内容、顺序、终止条件或错误语义。

按以下顺序移动已有逻辑：

1. 把读取模型累计快照、保留最终消息的部分移入 `_think()`。它返回完整
   `AssistantMessage`，不写入 transcript；若模型没有产生消息，抛出错误。
2. 把顺序执行工具、追加并输出 `ToolMessage` 的部分移入 `_act()`，继续复用
   阶段 4 的 `_invokeTool()`。
3. `stream()` 保留用户消息追加、步数限制、assistant 消息追加与输出，以及无 Tool call 时的终止分支。

下面给出提取后的标准实现供对比。用它替换原 `stream()`，并在 `Agent` 内增加两个私有方法；
保留构造函数、getter、`_extractToolUses()`、`_invokeTool()` 及阶段 4 已补齐的 imports
（包括 `MaximumStepsError` 和 `serializeToolResult`）。

```ts
async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
  this._context.messages.push(userMessage);

  for (let step = 1; step <= this.maxSteps; step++) {
    const assistantMessage = yield* this._think();
    this._context.messages.push(assistantMessage);
    yield { type: "message", message: assistantMessage };

    const toolUses = this._extractToolUses(assistantMessage);
    if (toolUses.length === 0) return;

    yield* this._act(toolUses);
  }

  throw new MaximumStepsError({ maxSteps: this.maxSteps });
}

private async *_think(): AsyncGenerator<AgentEvent, AssistantMessage> {
  let latest: AssistantMessage | undefined;
  for await (const snapshot of this.model.stream(this._context)) {
    latest = snapshot;
  }
  if (!latest) throw new Error("Model stream did not yield an assistant message");
  return latest;
}

private async *_act(toolUses: ToolUseContent[]): AsyncGenerator<AgentEvent> {
  for (const toolUse of toolUses) {
    const message = await this._invokeTool(toolUse);
    this._context.messages.push(message);
    yield { type: "message", message };
  }
}
```

`AsyncGenerator<AgentEvent, AssistantMessage>` 的两个类型参数分别表示 `yield` 的事件和
`return` 的最终值。`yield* this._think()` 会转发内部事件，并把最终返回值赋给
`assistantMessage`。此时 `_think()` 还不 yield 事件，5.1 加入 progress 后可继续使用这个签名。
`return latest` 本身不会向调用方发送 message event，所以 assistant 消息统一在 `stream()` 中
先追加、再 yield，避免重复回写或输出。

observe 仍由 `_invokeTool()` 构造 `ToolMessage`、`_act()` 回写结果共同完成；
answer 仍是 `stream()` 输出无 Tool call 的 assistant message 后结束循环。
本阶段无需增加 `_observe()`、`_answer()`，也无需为最终回答再调用一次模型。

先运行阶段 4 的回归测试，再继续 5.1：

```bash
bun test src/agent/__tests__/agent.test.ts
```

天气回答仍须来自实际 Tool observation，`tool_use_id`、普通错误回写和 `maxSteps` 行为均应保持一致。

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
async *stream(userMessage: UserMessage): AsyncGenerator<AgentEvent> {
  if (this._streaming) throw new Error("Agent is already streaming");

  this._abortController = new AbortController();
  this._streaming = true;
  try {
    // TODO 1：放入 5.0 的主循环，包括 userMessage 追加和 MaximumStepsError。
    // userMessage 只追加一次；重入检查必须发生在追加之前。
    // TODO 2：取本次 signal，每轮开始检查中止，并传给 _think(signal)、_act(toolUses, signal)。
    // 在 _think 返回后、_act 完成后也检查中止，避免取消被当成正常结束或达到步数上限。
  } finally {
    this._streaming = false;
    this._abortController = null;
  }
}
```

注意 `finally`：成功、模型异常、Tool 异常、达到 max steps 和 abort 都必须复位状态。

先为 5.0 的 `_think()`、`_act()` 和已有 `_invokeTool()` 增加 `signal?: AbortSignal` 参数，
保留各自的返回类型。`_act()` 调用 `_invokeTool(toolUse, signal)`，后者把 signal 传给
`this._toolRegistry.invoke({ name: toolUse.name, input: toolUse.input, signal })`，从而贯通 Tool 调用。

在 `_think()` 中，将 `this.model.stream(this._context)` 改为
`this.model.stream({ ...this._context, signal })`。这会构造本次调用的 `ModelContext`，
不会把 signal 永久写入 `AgentContext`。

接下来只在 `_think()` 的 `for await` 循环内增加 progress 生成逻辑。
这里有两种输出：循环中的 `yield` 报告模型生成进度；循环结束后的 `return` 交付完整消息。
为了达成这一目标，如果你在 5.0 使用了 `async _think(): Promise<AssistantMessage>`，现在需要把它改为参考实现的
`AsyncGenerator` 异步生成器签名，并将主循环里的 `await this._think()` 改为 `yield* this._think(signal)`。

按以下顺序处理每个 snapshot：

1. 先执行 `latest = snapshot`，保留目前最新的累计快照。暂时不能认定它是最终消息，
   因为 provider 后面可能还会产生新的快照。
2. 调用已有的 `this._extractToolUses(snapshot)`，从 content 数组提取工具调用。
   取最新的一个；空数组会得到 `undefined`，不需要类型断言。
3. 没有工具调用时，yield `{ type: "progress", subtype: "thinking" }`。
   这里的 `thinking` 是进度分类，普通文本生成也属于这一类，不要求 content 含 `thinking` block。
4. 有工具调用时，yield 一个 `subtype: "tool"` 的 progress。事件的 `name` 和 `input`
   从 `toolUseContent` 中取；input 保持对象，不做序列化。

> 辅助示例：可以用这些输入判断分支是否正确。表中 A、B 表示同一累计快照内按顺序出现的两个 `tool_use`：
> | snapshot 的 content | 本次应该 yield 的 progress |
> |---|---|
> | 空数组、只有 `text`、只有 `thinking`，或两者混合 | `type: "progress"`、`subtype: > "thinking"` |
> | `text` 与工具调用 A 混合 | `type: "progress"`、`subtype: "tool"`，携带 A 的 name 和 input |
> | 工具调用 A 与 B 同时存在，B 时序位于 A 之后 | 只产生一个工具进度事件，携带最后一个 B 的 name 和 input |

本节按每个 snapshot 产生一次 progress，无需去重。`name` 和 `input` 可能还在累积，
所以 tool progress 只表示模型正在生成工具调用；实际执行仍要等最终消息返回后进入 `_act()`。

如何判断最终消息：等 `for await` 正常结束，此时 `latest` 才是最后的完整消息。
不要在循环内部 `return snapshot`，也不要根据有没有 `tool_use` 提前结束。
若 provider 没有产生任何快照，保留上面的空流错误；无需给 `Message` 增加完成标记。

在同一文件的 `stream()` 主循环中，保留 5.0 已有的消息回写位置，并沿用本节的中止检查：

```ts
const assistantMessage = yield* this._think(signal);
signal.throwIfAborted();
this._context.messages.push(assistantMessage);
yield { type: "message", message: assistantMessage };
```

这里的 signal 是本次 `AbortController.signal`。`yield*` 会把 `_think()` 的 progress 转发给外部，
并在它结束时取得 `return latest` 的值。最终消息只在上述位置追加并输出一次；
不要在 `_think()` 中再 yield 一个 message event 或追加 assistant 消息。

完成后先自查一个最小场景：模型依次产生文本 `你`、`你好` 两个累计快照。
外部应先收到两个 thinking progress，再收到一个正文为 `你好` 的 message event。
对于没有历史消息的新 Agent，transcript 应只有 user 和最终 assistant 两条消息，
不包含 progress，也不包含中间的 `你`。随后再检查表中的工具调用和混合内容分支。

#### 验证 progress 与最终消息

把上面的自查落实为 5.1 的聚焦测试。目标文件：`src/agent/__tests__/think-hints.test.ts`。

将下面完整内容填入该文件。测试通过公开的 `Agent.stream()` 检查行为，
无需访问私有 `_think()`。fake provider 显式给出每个累计快照，使断言不依赖分块策略。
工具分支的测试在收到完整 assistant 消息后关闭迭代器，工具尚未开始执行，
所以此时保留顺序 `_act()` 即可，不需要提前完成 5.2 的并发调度。

<details>
<summary>展开完整代码：<code>think-hints.test.ts</code></summary>

```ts
import { expect, test } from "bun:test";

import type { AssistantMessage, ToolUseContent, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models";
import type { ModelProvider } from "@/foundation/models";

import { Agent } from "../agent";
import type { AgentEvent } from "../agent-event";

const USER: UserMessage = { role: "user", content: [{ type: "text", text: "test" }] };
const THINKING_PROGRESS: AgentEvent = { type: "progress", subtype: "thinking" };
const TOOL_A: ToolUseContent = { type: "tool_use", id: "a", name: "tool_a", input: { x: 1 } };
const TOOL_B: ToolUseContent = { type: "tool_use", id: "b", name: "tool_b", input: { x: 2 } };

function defineTextMessage(text: string): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function defineAgent(snapshots: AssistantMessage[]): Agent {
  const provider: ModelProvider = {
    invoke: async () => { throw new Error("Expected streaming model invocation"); },
    stream: async function* ({ signal }) {
      for (const snapshot of snapshots) {
        signal?.throwIfAborted();
        yield snapshot;
      }
    },
  };
  return new Agent({ model: new Model({ name: "hints", provider }), prompt: "" });
}

test("text progress precedes one final message without entering the transcript", async () => {
  const final = defineTextMessage("你好");
  const agent = defineAgent([defineTextMessage("你"), final]);
  const events: AgentEvent[] = [];

  for await (const event of agent.stream(USER)) {
    if (event.type === "progress") expect(agent.messages).toEqual([USER]);
    events.push(event);
  }

  expect(events).toEqual([
    THINKING_PROGRESS,
    THINKING_PROGRESS,
    { type: "message", message: final },
  ]);
  expect(agent.messages).toEqual([USER, final]);
});

const cases: {
  name: string;
  content: AssistantMessage["content"];
  progress: AgentEvent;
}[] = [
  { name: "empty content", content: [], progress: THINKING_PROGRESS },
  {
    name: "text with thinking",
    content: [{ type: "thinking", thinking: "想" }, { type: "text", text: "好" }],
    progress: THINKING_PROGRESS,
  },
  {
    name: "text with a tool",
    content: [{ type: "text", text: "查" }, TOOL_A],
    progress: { type: "progress", subtype: "tool", name: TOOL_A.name, input: TOOL_A.input },
  },
  {
    name: "the last of two tools",
    content: [TOOL_A, TOOL_B],
    progress: { type: "progress", subtype: "tool", name: TOOL_B.name, input: TOOL_B.input },
  },
];

for (const scenario of cases) {
  test(`classifies ${scenario.name}`, async () => {
    const snapshot: AssistantMessage = { role: "assistant", content: scenario.content };
    const agent = defineAgent([snapshot]);
    const iterator = agent.stream(USER);

    try {
      expect(await iterator.next()).toEqual({ done: false, value: scenario.progress });
      expect(agent.messages).toEqual([USER]);
      expect(await iterator.next()).toEqual({
        done: false,
        value: { type: "message", message: snapshot },
      });
      expect(agent.messages).toEqual([USER, snapshot]);
    } finally {
      // 在进入 _act() 前结束本次迭代，同时让 stream() 的 finally 清理运行状态。
      await iterator.return(undefined);
    }
  });
}

test("an empty model stream retains the error path", async () => {
  const agent = defineAgent([]);
  await expect(agent.stream(USER).next()).rejects.toThrow(
    "Model stream did not yield an assistant message",
  );
  expect(agent.messages).toEqual([USER]);
});
```

</details>

完成 `_think()` 后，在练习项目根目录运行：

```bash
bun test src/agent/__tests__/think-hints.test.ts
```

预期为 **6 pass、0 fail**：文本的两个累计快照、表中的四种分类，以及模型空流错误。
如果第一项就收到 message，检查是否仍用 `await` 调用 `_think()`，或遗漏了 progress 的 `yield`；
如果工具分类失败，检查是否选中了最后一个 `tool_use` 并保留 name/input；
如果 transcript 断言失败，检查是否把快照或 progress 提前写入，或重复追加了最终消息。
这些测试通过后再继续 5.2；并发和 abort 的完整验证留到 5.4。

### 5.2 并发 Tool 调度

同一个 assistant message 中的多个 Tool call 可以并发，但必须注意两个次序：

- Tool 启动顺序：按模型给出的数组顺序；
- Tool result 进入 transcript 的顺序：按实际完成顺序。

目标文件：`src/agent/agent.ts` 的 `_act()`（5.0 已提取，5.1 已增加 signal 参数）。

用下面的调度骨架替换 `_act()` 内部的顺序循环，保留 5.1 增加的 signal 参数。
`_invokeTool()` 继续负责 Registry 调用、结果序列化和 `tool_use_id` 关联，
调度器只负责启动任务与按完成顺序回写。核心骨架已实现前两步；回写步骤留给读者：

```ts
const pending = toolUses.map(async (toolUse, index) => {
  const message = await this._invokeTool(toolUse, signal);
  return { index, message };
});

const remaining = new Set(pending.map((_, index) => index));

while (remaining.size > 0) {
  signal?.throwIfAborted();
  const candidates = [...remaining].map((index) => pending[index]!);
  const resolved = await Promise.race(candidates);
  signal?.throwIfAborted();
  remaining.delete(resolved.index);
  // TODO 3：把 resolved.message 先 append 到 transcript，再 yield message event。
  // 不得按 resolved.index 重新排序，也不要重复序列化或再次执行 Tool。
}
```

为什么不直接 `Promise.all`：它虽然并发启动，但只能等最慢 Tool 完成后统一返回，用户看不到先完成的结果。

普通 Tool 异常已由阶段 3 的 Registry 捕获并规范化，再由 `_invokeTool()` 转换为
`ToolMessage`，因此单个 Tool failure 不会通过 promise rejection 提前终止调度器。
signal 中止则终止整个 run：Registry 即使返回结构化 `ABORTED`，runtime 仍通过
`throwIfAborted()` 传播取消，不再进入下一轮模型调用。

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

#### 并发 Tool 示例

目标文件：`examples/stage-05-parallel-tools.ts`

<details>
<summary>展开完整代码：<code>stage-05-parallel-tools.ts</code></summary>

```ts
import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run slow and fast" }],
};

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const startedAt = performance.now();

function log(event: "tool_start" | "tool_end", name: string): void {
  const elapsed = Math.round(performance.now() - startedAt);
  console.log(`${elapsed}ms  ${event} ${name}`);
}

function defineDelayTool(name: string, ms: number) {
  return defineTool({
    name,
    description: `Wait ${ms}ms`,
    parameters: z.object({ description: z.string() }),
    invoke: async (_input, signal) => {
      log("tool_start", name);
      await wait(ms, signal);
      log("tool_end", name);
      return { name, ms };
    },
  });
}

const toolCalls: AssistantMessage = {
  role: "assistant",
  content: ["slow", "fast"].map((name) => ({
    type: "tool_use" as const,
    id: `call-${name}`,
    name,
    input: { description: `run ${name}` },
  })),
};
const provider = new ScriptedModelProvider({
  responses: [
    toolCalls,
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ],
});
const agent = new Agent({
  model: new Model({ name: "scripted", provider }),
  prompt: "Run independent tools together.",
  tools: [defineDelayTool("slow", 300), defineDelayTool("fast", 30)],
});

for await (const _event of agent.stream(userMessage)) {
  // Tool 自身记录开始和结束时间；这里只消费完整 event stream。
}
```

</details>

#### Abort 示例

目标文件：`examples/stage-05-abort.ts`

<details>
<summary>展开完整代码：<code>stage-05-abort.ts</code></summary>

```ts
import { z } from "zod";

import { Agent } from "@/agent/agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const delayTool = defineTool({
  name: "delay",
  description: "Wait for a bounded duration",
  parameters: z.object({
    description: z.string(),
    ms: z.number().finite().int().nonnegative(),
    label: z.string().min(1),
  }),
  invoke: async ({ ms, label }, signal) => {
    await wait(ms, signal);
    return { label, ms };
  },
});
const toolCall: AssistantMessage = {
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "delay-1",
      name: "delay",
      input: { description: "demonstrate abort", ms: 10_000, label: "slow" },
    },
  ],
};
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "start a long delay" }],
};
const agent = new Agent({
  model: new Model({
    name: "scripted",
    provider: new ScriptedModelProvider({ responses: [toolCall] }),
  }),
  prompt: "Run the requested delay.",
  tools: [delayTool],
});
const startedAt = performance.now();
const abortTimer = setTimeout(() => {
  console.log("[abort] request user cancellation");
  agent.abort();
}, 100);

try {
  for await (const _event of agent.stream(userMessage)) {
    // consume
  }
} catch (error) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.log(`[stopped] ${message}`);
} finally {
  clearTimeout(abortTimer);
}

console.log(
  `[done] elapsed=${Math.round(performance.now() - startedAt)}ms streaming=${agent.streaming}`,
);
```

</details>

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

<details>
<summary>展开完整代码：<code>agent-streaming.test.ts</code></summary>

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

</details>

时间测试不要断言精确毫秒。用足够大的快慢差并设置宽松上限，减少 CI 抖动。

最后执行本阶段的完整测试：

```bash
bun test src/agent/__tests__/agent.test.ts src/agent/__tests__/think-hints.test.ts src/agent/__tests__/agent-streaming.test.ts
```

这条命令同时运行阶段 4 的循环回归、5.1 的 progress 聚焦测试，以及本节的并发和 abort 测试。
按教程提供的测试内容，预期为 **15 pass、0 fail**。

### 阶段后对照

- `src/agent/agent.ts` 中 `AbortController` 和 `Promise.race`；
- `src/coding/tools/bash.ts` 的子进程中止；
- `src/community/openai/model-provider.ts` 的 signal 传递。

### 验收

- [ ] 先提取 `_think()`、`_act()` 并通过阶段 4 回归测试，再加入本阶段能力；
- [ ] `think-hints.test.ts` 的 6 项 progress、最终消息和空流测试通过；
- [ ] streaming snapshot 不污染 transcript；
- [ ] Tool result 按完成顺序可见；
- [ ] abort 能到达 model 和 Tool；
- [ ] 所有结束路径都复位 `_streaming`；
- [ ] `ADR-006` 解释 `Promise.race` pending-set 模式。

## 阶段 6：Middleware 生命周期与策略分离

> 上一阶段回顾：阶段 5 为 Agent 增加了累计式 streaming、同批 Tool 并发和端到端 abort，并让 Tool result 按完成顺序可见。

### 本阶段解决的问题

如果 Todo、Skills、审批、日志和 context compaction 都硬编码进 `Agent.stream()`，循环很快会不可测试。Middleware 用稳定 hook 把横切能力放到 runtime 外部。

本阶段的核心不是“支持插件”，而是定义清晰的 mutation boundary。

创建新增文件：

```bash
touch src/agent/agent-middleware.ts src/agent/lifecycle-recorder.ts
touch src/agent/__tests__/host-hooks.test.ts
touch src/agent/__tests__/middleware.test.ts examples/stage-06-middleware.ts
```

执行后新增结构如下：

```text
src/agent/
├── agent-middleware.ts                 # 定义 Agent、step、model 与 Tool 生命周期 hooks
├── lifecycle-recorder.ts               # 提供记录 hook 调用次序的示例 Middleware
└── __tests__/
    ├── host-hooks.test.ts              # 聚焦验证 host 调用次数和返回值合并
    └── middleware.test.ts              # 验证 hook 顺序、mutation 与错误传播
examples/
└── stage-06-middleware.ts              # 演示日志等横切能力如何接入生命周期
```

### 6.1 Hook 契约

**Hook（钩子）是程序在特定时机留出的扩展入口。** 你提供一个函数，主流程运行到约定位置时调用它，让你插入自己的逻辑。在本章中，它就是一个由 Agent runtime 调用的回调函数，名称如 `beforeModel` 表示它介入的时机。

例如，Agent 原本只需要“构造请求 → 调用模型 → 处理回复”。增加 hook 后，可以在调用模型前执行 `beforeModel`，在取得最终回复后执行 `afterModel`。需要增加日志或调整本次请求时，就把逻辑放进对应 hook，无需每增加一种用途都修改 Agent 循环。

Hook 常用于日志与计时、输入检查、权限审批、调整数据以及资源清理。你可能见过的 Git `pre-commit` hook 也是这个思路：Git 在提交前运行指定脚本，用来执行检查。具体到本章，可以这样选择入口：

| 要做的事 | 可以使用的 hook | 它在这里负责什么 |
|---|---|---|
| 给本次模型请求追加提醒 | `beforeModel` | 返回本次 `ModelContext` 的修改，不永久追加到 transcript |
| 记录模型回复中的 token 用量 | `afterModel` | 读取本次最终 `AssistantMessage`，记录统计数据 |
| 在运行 `bash` 前询问用户 | `beforeToolUse` | 等待审批；拒绝时返回约定的 skip 结果 |
| 在一次 Agent run 结束时收尾 | `afterAgentRun` | 按本章约定，由外层 `finally` 调用，覆盖成功、失败和中止 |

这里还需要区分三个角色：**hook 是入口，Middleware 是提供这些入口实现的对象，host 是负责调用它们的 Agent。** 一个 Middleware 可以只实现自己需要的 hook，再通过 `new Agent({ middlewares: [...] })` 注册。仅仅定义一个名叫 `beforeModel` 的方法不会让它自动运行，host 必须在模型调用前显式调用它。

“契约”则回答三个问题：**什么时候调用、传入什么、如何处理返回值。** 下面接口中的 `?` 表示方法可选；`Promise<...>` 表示 host 需要等待异步逻辑完成；返回 `void` 表示不请求修改上下文，返回 `Partial<...>` 表示只提供需要更新的字段，由 host 合并到对应对象。`beforeToolUse` 额外允许返回 `{ __skip: true, result }`，表示跳过真实 Tool 调用，并把 `result` 作为结果反馈给 Agent。

这些返回值只有在 host 实现了对应处理逻辑后才会生效。类似地，`after` 这个名字本身也不保证失败时一定调用；是否进入 `finally`、是否覆盖终止 step，都需要像后面的实现提示一样明确规定。

目标文件：`src/agent/agent-middleware.ts`

定义以下 hooks：

<details>
<summary>展开完整代码：<code>agent-middleware.ts</code></summary>

```ts
import type { AssistantMessage, ToolUseContent } from "@/foundation/messages";
import type { ModelContext } from "@/foundation/models/model-context";

import type { AgentContext } from "./agent-context";

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

</details>

### 6.2 两种 Context 不要混淆

- `AgentContext`：跨 step 持久存在，例如 transcript、可用 Tools、Skills；
- `ModelContext`：某一次 model 请求的临时视图，例如追加 reminder 或压缩后的 messages。

`beforeModel` 返回值合并到 `ModelContext`，不能不经声明地永久修改 `AgentContext.messages`。阶段 13 的 context compaction 将依赖这条边界。

### 6.3 Hook host 实现

目标文件：`src/agent/agent.ts`

先区分 **Middleware hook 的返回值**和 **host 方法的返回值**。例如，`beforeAgentRun()` 和 `_beforeAgentRun()` 是两个不同的方法：

- `middleware.beforeAgentRun()` 由 Middleware 提供，返回 `Promise<Partial<AgentContext> | void>`，告诉 host“我想更新这些字段”或“不更新”。
- `agent._beforeAgentRun()` 由 Agent 提供，负责依次调用上述 hook，并把返回的字段合并到 `this._context`。修改已经在方法内部完成，所以它只返回 `Promise<void>`，让 `stream()` 等待执行完成即可。

它们的调用关系是：

```text
stream() 等待 _beforeAgentRun()
  → host 等待 middleware.beforeAgentRun()
  ← Middleware 返回更新字段，或不返回值
  → host 执行 Object.assign(this._context, 更新字段)
  ← host 执行结束，stream() 继续读取已更新的 this._context
```

因此，`_beforeAgentRun()` 并不是在实现 `AgentMiddleware.beforeAgentRun` 接口，而是在调用它；两者的返回类型不必一致。下划线只是本项目标记私有成员的命名约定，不会让这两个方法自动产生关联。`Promise<void>` 也不表示“没有修改任何对象”或“不会抛错”，只表示调用方不需要从返回值取得数据。

`Object.assign` 自身会返回被修改的目标对象，但 host 没有写 `return Object.assign(...)`，所以不会把它继续返回。这里的 async 方法执行结束后，Promise 解析为 `undefined`；调用方持有的对象已被原地更新。

如果你看的是后面的 lifecycle recorder，它属于 Middleware 实现，但同样可以不返回值：接口中的 `Partial<AgentContext> | void` 已经允许 `void` 这一分支，并不要求每个实现都返回更新字段。

**合并目标要查契约，不能只看 hook 名称或传入参数。** 6.1 的 hooks 并非全部返回 `Partial<AgentContext>`：`beforeModel` 返回 `Partial<ModelContext>`，`afterModel` 返回 `Partial<AssistantMessage>`，`beforeToolUse` 还允许返回 skip 指令。

实现 hooks 方法时，先查返回类型中的 `Partial<T>`，再找契约指定的那个 `T` 类型的对象，使用 `Object.assign(target, result)`。没有返回值就不合并。例如，`afterToolUse` 虽然接收 `toolResult`，但返回的是 `Partial<AgentContext>`，所以更新的是 `this._context`，不能把返回值写进 `toolResult`。`Object.assign` 只负责复制字段，不会根据类型帮你选择目标，传入错误对象也可能不被 TypeScript 拦住。

`_beforeToolUse()` 是这里唯一需要把业务数据返回给调用方的 host：调用方要根据它决定是否执行真实 Tool。下面会定义 `BeforeToolUseDecision`；skip 指令必须转成这个决策返回，不能作为普通字段合并进上下文。

先在文件顶部导入 `AgentMiddleware`，再为 `Agent` 保存一份 Middleware 数组：

```ts
import type { AgentMiddleware } from "./agent-middleware";

// Agent class 内：
private readonly _middlewares: AgentMiddleware[];
```

在构造参数中增加 `middlewares?: AgentMiddleware[]`，并在 constructor 内复制数组：

```ts
this._middlewares = [...(options.middlewares ?? [])];
```

然后在 `Agent` 内实现以下三个示例中的私有方法，再按前面实现的 `Hook契约` 补齐剩余方法及其调用位置。

**示例一：`_beforeModel()` 修改本次模型请求**

Middleware 的 `beforeModel` 返回请求更新字段，host 合并到本次 `modelContext`：

```ts
private async _beforeModel(modelContext: ModelContext): Promise<void> {
  for (const middleware of this._middlewares) {
    // host 在这里真正调用 hook；
    // ?. 让未实现 beforeModel 的 Middleware 自动跳过。
    // await 保证当前 hook 完成并合并结果后，才轮到下一个 Middleware。
    const result = await middleware.beforeModel?.({
      modelContext,
      agentContext: this._context,
    });
    // 只修改本次模型请求的视图。Object.assign 是浅合并：同名字段由后者覆盖。
    // 例如返回 { messages: [...] } 会替换整个 messages 字段，而不是自动追加。
    if (result) Object.assign(modelContext, result);
  }
}
```

例如，给本次模型请求加提醒时，某个 `beforeModel` 可以返回包含新 `messages` 数组的对象，上面的 host 会将它合并到本次 `modelContext`；下一个 Middleware 看到的就是更新后的请求。这里虽然也传入了 `agentContext` 供读取，但返回值不会合并到它。实现 hook 时应构造新数组，避免直接 `push` 到与 transcript 共享的数组上，否则仍可能修改持久状态。

所有 hooks 按 middleware 数组顺序串行执行。这样后一个 middleware 能观察前一个的结果，调用顺序也可预测。

**示例二：`_beforeAgentRun()` 修改持久上下文**

与 `_beforeModel()` 相比，遍历和等待逻辑不变，但传入参数及合并目标都变成了 `AgentContext`：

```ts
private async _beforeAgentRun(): Promise<void> {
  for (const middleware of this._middlewares) {
    const result = await middleware.beforeAgentRun?.({
      agentContext: this._context,
    });
    // 修改保存在 Agent 上，后续 step 会继续使用这些字段。
    if (result) Object.assign(this._context, result);
  }
}
```

TODO：在 `stream()` 中完成运行状态初始化、追加本次用户消息后，在第一轮 step 开始前调用 `await this._beforeAgentRun()`。把调用放在已有的 `try` 内，让 hook 抛错时也能进入 `finally` 清理运行状态；不要放进 step 循环，否则每一轮都会重复执行。

**示例三：`_afterModel()` 修改本次最终回复**

Middleware 的 `afterModel` 返回回复更新字段，host 合并到本次 `message`，不能照抄上例合并进 `AgentContext`：

```ts
private async _afterModel(message: AssistantMessage): Promise<void> {
  for (const middleware of this._middlewares) {
    const result = await middleware.afterModel?.({
      agentContext: this._context,
      message,
    });
    // 原地更新本次回复；下一个 Middleware 和后续 Tool 提取都读取更新后的对象。
    if (result) Object.assign(message, result);
  }
}
```

TODO：在阶段 5 的 `stream()` 中，取得 `_think()` 返回的完整回复后接入它。保留已有的 abort 检查，再按下面的相对顺序组织代码；不要在每次 progress snapshot 到来时调用：

```ts
const assistantMessage = yield* this._think(signal);
signal.throwIfAborted();
await this._afterModel(assistantMessage);
// hook 可能等待异步操作，等待期间用户也可能 abort。
signal.throwIfAborted();
this._context.messages.push(assistantMessage);
yield { type: "message", message: assistantMessage };
// 后续再从 assistantMessage 提取 Tool calls，沿用已有的执行与终止逻辑。
```

#### 小阶段自查

目标文件：`src/agent/__tests__/host-hooks.test.ts`。

这份文件用于你的练习项目，可在接入上述 host 方法后运行，不依赖后面的 lifecycle recorder。它通过公开的 `Agent.stream()` 验证行为，不直接调用私有方法。测试内的 fake provider 每次请求只返回一个完整回复，便于把注意力集中在 host 上；累计快照和 progress 仍由阶段 5 的测试覆盖。

<details>
<summary>展开完整代码：<code>host-hooks.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider } from "@/foundation/models/model-provider";
import { defineTool } from "@/foundation/tools";

import { Agent } from "../agent";
import type { AgentMiddleware } from "../agent-middleware";

const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "run" }],
};
const TOOL_CALL: AssistantMessage = {
  role: "assistant",
  content: [{
    type: "tool_use",
    id: "work-1",
    name: "work",
    input: { description: "verify the second model step" },
  }],
};
const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};

function defineHostTestAgent(options: {
  responses: AssistantMessage[];
  middlewares: AgentMiddleware[];
  invoke?: () => Promise<unknown>;
}): Agent {
  let cursor = 0;
  const provider: ModelProvider = {
    async invoke({ signal }) {
      signal?.throwIfAborted();
      const response = options.responses[cursor++];
      if (!response) throw new Error("No fixture response left");
      // 每次交付独立对象，防止 Middleware 修改共享 fixture，污染其他测试。
      return structuredClone(response);
    },
    async *stream(params) {
      yield await this.invoke(params);
    },
  };
  const tool = defineTool({
    name: "work",
    description: "Return a fixture result",
    parameters: z.object({ description: z.string() }),
    invoke: options.invoke ?? (async () => "ok"),
  });
  return new Agent({
    model: new Model({ name: "host-test", provider }),
    prompt: "test",
    tools: [tool],
    middlewares: options.middlewares,
    maxSteps: 3,
  });
}

describe("Agent host hooks", () => {
  test("calls beforeAgentRun once across two model steps", async () => {
    const calls: string[] = [];
    let toolCalls = 0;
    const agent = defineHostTestAgent({
      responses: [TOOL_CALL, FINAL],
      middlewares: [{
        beforeAgentRun: async () => { calls.push("beforeAgentRun"); },
        beforeModel: async () => { calls.push("beforeModel"); },
      }],
      invoke: async () => {
        toolCalls += 1;
        return "ok";
      },
    });

    for await (const _event of agent.stream(structuredClone(USER))) {
      // 必须消费到结束，第二轮模型请求才会发生。
    }

    expect(calls).toEqual(["beforeAgentRun", "beforeModel", "beforeModel"]);
    expect(toolCalls).toBe(1);
    expect(agent.messages.map((message) => message.role)).toEqual([
      "user", "assistant", "tool", "assistant",
    ]);
  });

  test("merges afterModel updates before the next hook and message event", async () => {
    const expectedContent: AssistantMessage["content"] = [
      { type: "text", text: "reviewed: done" },
    ];
    const seenByNextHook: AssistantMessage["content"][] = [];
    const emittedMessages: AssistantMessage[] = [];
    const agent = defineHostTestAgent({
      responses: [FINAL],
      middlewares: [
        {
          afterModel: async () => {
            await Promise.resolve();
            // 只返回更新字段，不直接修改 message，确保测试真正检查 host 的合并。
            return { content: structuredClone(expectedContent) };
          },
        },
        {
          afterModel: async ({ message }) => {
            // 立即复制，固定“第二个 hook 执行时”看到的内容。
            seenByNextHook.push(structuredClone(message.content));
          },
        },
      ],
    });

    for await (const event of agent.stream(structuredClone(USER))) {
      if (event.type === "message" && event.message.role === "assistant") {
        // 同样记录收到事件时的快照，不能等 run 结束后才读取共享对象。
        emittedMessages.push(structuredClone(event.message));
      }
    }

    expect(seenByNextHook).toEqual([expectedContent]);
    expect(emittedMessages).toHaveLength(1);
    expect(emittedMessages[0]?.content).toEqual(expectedContent);
    expect(agent.messages).toEqual([
      USER,
      { role: "assistant", content: expectedContent },
    ]);
  });
});
```

</details>

运行：

```bash
bun test src/agent/__tests__/host-hooks.test.ts
```

两个 host 接入正确后，预期为 **2 pass、0 fail**。如果第一个测试多出 `beforeAgentRun`，检查它是否误放进 step 循环；如果第二个 hook 仍看到 `done`，检查是否等待了前一个 hook 并将返回值合并到 `message`；如果消息事件仍是旧内容，检查 `_afterModel()` 是否放在最终 `message` 事件发出之前。

测试中的 `structuredClone` 用于固定观察时刻。只保存对象引用，可能会因为对象在之后被修改而误通过，从而漏掉“先发事件、后执行 hook”的错误。

#### 补齐其余 hooks

为 `beforeToolUse` 单独实现 skip normalization：

```ts
type BeforeToolUseDecision =
  | { skip: false }
  | { skip: true; result: unknown };
```

将 `BeforeToolUseDecision` 定义在 `Agent` class 外。对应 host 方法的签名为 `private async _beforeToolUse(toolUse: ToolUseContent): Promise<BeforeToolUseDecision>`，方法体按下面的分支提示补齐。

TODO：按 Middleware 数组顺序调用 `beforeToolUse`。无返回值时继续；返回 `{ __skip: true, result }` 时立即返回 `{ skip: true, result }`；普通 `Partial<AgentContext>` 则合并到 `this._context` 后继续。遍历结束仍未 skip 时返回 `{ skip: false }`。`__skip` 是 Middleware 的指令字段，`skip` 是 host 交给 Tool 调用方的决策字段，不要混用。

当 host 返回 `{ skip: true, result }` 时，runtime 不调用真实 Tool，但仍然生成正常的 `tool_result` observation。

其余实现提示：

- TODO 1：`beforeAgentRun`、`beforeAgentStep`、`afterAgentStep` 和 `afterAgentRun` 的返回值只合并到 `AgentContext`；
- TODO 2：本课程规定 `afterAgentRun` 放在外层 `finally`，成功、abort、error、maxSteps 都调用一次；
- TODO 3：`afterAgentStep` 只在该 step 的 Tool observations 全部追加后调用，最终纯文本 step 不调用。

### 6.4 Lifecycle recorder

目标文件：`src/agent/lifecycle-recorder.ts`

**示例四：`defineLifecycleRecorder()` 记录执行顺序**

实现一个只记录 hook 名称的 Middleware。第一个 hook 展示标准的 async block 写法，
其余 hook 完整给出，复制后可直接通过 Promise return type 检查。

```ts
import type { AgentMiddleware } from "./agent-middleware";

export function defineLifecycleRecorder(log: string[]): AgentMiddleware {
  // 返回的是 hook 实现集合；此时还没有运行 Agent，也不会向 log 写入内容。
  return {
    beforeAgentRun: async () => {
      // 等 host 开始一次 run 时才执行。闭包让 hook 能写入调用方传入的 log 数组。
      log.push("beforeAgentRun");
      // 没有 return，Promise 解析为 undefined：记录了日志，但不请求修改 AgentContext。
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
      // toolUse 由 host 传入，因此同一个 hook 可以记录不同 Tool 的调用。
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

这个 recorder 在各个 hook 中向外部 `log` 数组写入名称，最后就能核对模型调用与 Tool 执行的顺序。它说明 hook 不一定要返回修改对象：记录日志也是一种用途。注意，返回 `void` 只代表不请求 host 合并上下文，并不代表函数没有副作用；这里写入日志就是副作用。

目标文件：`examples/stage-06-middleware.ts`

<details>
<summary>展开完整代码：<code>stage-06-middleware.ts</code></summary>

```ts
import { z } from "zod";

import { Agent } from "@/agent/agent";
import { defineLifecycleRecorder } from "@/agent/lifecycle-recorder";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { defineTool } from "@/foundation/tools/function-tool";

const responses: AssistantMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "weather-1",
        name: "get_weather",
        input: { description: "query fixture weather", city: "北京" },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "北京今天晴。" }],
  },
];
const weatherTool = defineTool({
  name: "get_weather",
  description: "Return deterministic weather",
  parameters: z.object({ description: z.string(), city: z.string() }),
  invoke: async ({ city }) => ({ city, condition: "晴" }),
});
const userMessage: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "北京天气如何？" }],
};
const log: string[] = [];
const agent = new Agent({
  model: new Model({
    name: "scripted",
    provider: new ScriptedModelProvider({ responses }),
  }),
  prompt: "Use get_weather when needed.",
  tools: [weatherTool],
  middlewares: [defineLifecycleRecorder(log)],
});

for await (const _event of agent.stream(userMessage)) {
  // 生命周期由 Middleware 记录，event stream 仍需完整消费。
}

console.log(log.join("\n"));
```

</details>

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

本课程定义：没有 Tool 的终止 step 不调用 `afterAgentStep`。你可以选择不同语义，但必须在 ADR 和测试中固定下来。

### 6.5 完整测试

目标文件：`src/agent/__tests__/middleware.test.ts`

<details>
<summary>展开完整代码：<code>middleware.test.ts</code></summary>

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

</details>

这里固定的标准语义是：Tool throw 先被规范化，再调用 `afterToolUse`；`afterAgentRun`
在外层 `finally` 中调用一次。若你选择不同语义，必须同时修改说明和完整测试。

最后执行本阶段的完整测试：

```bash
bun test src/agent/__tests__/host-hooks.test.ts src/agent/__tests__/middleware.test.ts
```

按本章给出的测试内容，预期为 **8 pass、0 fail**：2 项 host 聚焦测试，加上 6 项 Middleware 生命周期与策略测试。

### 阶段后对照

- `src/agent/agent-middleware.ts`；
- `src/agent/agent.ts` 的 `_beforeX` / `_afterX`；
- `src/coding/permissions/coding-approval-middleware.ts`。

### 验收

- [ ] `Agent.stream()` 中没有 Todo、Skills 或审批的业务判断；
- [ ] Middleware mutation boundary 有类型约束；
- [ ] skip 不会破坏 transcript 协议；
- [ ] hook 顺序由测试固定；
- [ ] `host-hooks.test.ts` 的 2 项调用次数与合并结果测试通过；
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
