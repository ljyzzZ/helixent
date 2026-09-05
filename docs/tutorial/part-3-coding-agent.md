# 第三部分：Coding Agent 与交互客户端

这一部分完成阶段 7～10。阶段 10 结束时，你会得到一个与 Helixent 核心能力功能等价的 v1：能接真实模型、读写代码、加载项目指令和 Skills、管理 Todo、流式交互，并在副作用 Tool 前请求人工审批。

真实 API 验证始终是 optional integration test。核心测试继续使用 fake provider，避免网络波动、费用和模型随机性破坏质量门。

## 阶段 7：实现 Provider Adapter

> 上一阶段回顾：阶段 6 建立了 Middleware 生命周期和明确的 mutation boundary，把日志、审批等横切策略从 Agent 主循环中分离出来。

### 本阶段解决的问题

不同模型厂商在以下方面并不一致：

- system prompt 放置方式；
- Tool definition schema；
- Tool call id 和参数编码；
- thinking/reasoning 内容；
- streaming chunk 结构；
- token usage 字段；
- abort 和错误类型。

Adapter 的职责是吸收这些差异，让 Agent runtime 只看到 canonical Message。

### 7.1 安装 SDK

```bash
bun add openai @anthropic-ai/sdk
```

一键创建目录和文件：

```bash
mkdir -p src/community/openai/__tests__ src/community/anthropic/__tests__ examples
touch src/community/openai/model-provider.ts src/community/openai/stream-accumulator.ts
touch src/community/openai/utils.ts src/community/openai/index.ts
touch src/community/openai/__tests__/utils.test.ts
touch src/community/openai/__tests__/stream-accumulator.test.ts
touch src/community/openai/__tests__/model-provider.test.ts
touch src/community/anthropic/model-provider.ts src/community/anthropic/stream-accumulator.ts
touch src/community/anthropic/utils.ts src/community/anthropic/index.ts
touch src/community/anthropic/__tests__/utils.test.ts
touch src/community/anthropic/__tests__/stream-accumulator.test.ts
touch examples/stage-07-real-model.ts
```

执行后目录应为：

```text
src/community/                      # 第三方模型 Provider adapters
├── openai/                         # OpenAI-compatible adapter
│   ├── model-provider.ts           # 调用 SDK 并实现 ModelProvider
│   ├── stream-accumulator.ts       # 将 OpenAI chunks 累积为 canonical snapshot
│   ├── utils.ts                    # 转换 canonical 与 OpenAI wire types
│   ├── __tests__/                  # OpenAI adapter 的协议测试
│   └── index.ts                    # 导出 OpenAI adapter 公共 API
└── anthropic/                      # Anthropic adapter
    ├── model-provider.ts           # 调用 SDK 并实现 ModelProvider
    ├── stream-accumulator.ts       # 将 Anthropic events 累积为 canonical snapshot
    ├── utils.ts                    # 转换 canonical 与 Anthropic wire types
    ├── __tests__/                  # Anthropic adapter 的协议测试
    └── index.ts                    # 导出 Anthropic adapter 公共 API
```

### 7.2 先写纯转换函数

目标文件：`src/community/openai/utils.ts`

OpenAI adapter 至少拆成以下函数。`convertToOpenAITools()` 是标准实现示例；其余 TODO
按 content variant 分支完成，未知 variant 必须走 `assertNever`。

<details>
<summary>展开完整代码：<code>utils.ts</code></summary>

```ts
export function convertToOpenAIMessages(
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  // TODO 1：system/user text 直接转换；image_url 只允许出现在 user。
  // TODO 2：assistant 的 text 与 tool_use 合并为一条 wire message。
  // TODO 3：每个 ToolResultContent 转成带 tool_call_id 的 tool role message。
}

export function convertToOpenAITools(
  tools: Tool[],
): OpenAI.ChatCompletionTool[] {
  // 标准实现示例：schema 转换只发生在 provider adapter。
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters.toJSONSchema(),
    },
  }));
}

export function parseOpenAIAssistantMessage(
  message: OpenAI.ChatCompletionMessage,
  usage?: TokenUsage,
): AssistantMessage {
  // TODO 4：content 转为 text；reasoning_content 转为 thinking（若 endpoint 提供）。
  // TODO 5：tool_calls arguments 用 JSON.parse；最终仍非法时抛出带 call id 的转换错误。
  // TODO 6：usage 缺省时不要伪造 0，保持 AssistantMessage.usage 为 undefined。
}
```

</details>

目标文件：`src/community/anthropic/utils.ts`

实现 Anthropic 协议转换函数：

```ts
export function extractSystemPrompt(messages: Message[]): string | undefined {
  // TODO 1：只收集 system text，并用两个换行连接；没有 system 时返回 undefined。
  // 参数规则：不得修改 messages，也不得把非 system 内容混入 prompt。
  throw new Error("TODO: implement extractSystemPrompt");
}

export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  // TODO 2：排除 system message，并把 Tool result 转成 user-role content。
  // 参数规则：保持原始消息及 content block 顺序，不修改 canonical messages。
  throw new Error("TODO: implement convertToAnthropicMessages");
}

export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  // TODO 3：使用 input_schema，不要复用 OpenAI wire type。
  throw new Error("TODO: implement convertToAnthropicTools");
}

export function parseAnthropicAssistantMessage(message: Anthropic.Message): AssistantMessage {
  // TODO 4：解析 text、thinking、tool_use，并原样保存 Tool id 和 provider usage。
  throw new Error("TODO: implement parseAnthropicAssistantMessage");
}
```

这些函数必须是纯函数。先用固定 fixture 测完，再调用 SDK。

### 7.3 StreamAccumulator

目标文件：`src/community/openai/stream-accumulator.ts`

定义 provider-local accumulator。文本 delta 分支是标准实现示例；thinking、Tool fragment
和 usage 分别保留为独立 TODO，不能共享可变字符串。

<details>
<summary>展开完整代码：<code>stream-accumulator.ts</code></summary>

```ts
export interface ProviderChunk {
  textDelta?: string;
  thinkingDelta?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  usage?: TokenUsage;
}

export class StreamAccumulator {
  private _text = "";
  private _thinking = "";
  private readonly _toolCalls = new Map<number, {
    id: string;
    name: string;
    argumentsText: string;
  }>();
  private _usage?: TokenUsage;

  push(chunk: ProviderChunk): void {
    if (chunk.textDelta) {
      // 标准实现示例：delta 只写 accumulator，不写 Agent transcript。
      this._text += chunk.textDelta;
    }
    // TODO 1：thinking delta 追加到 _thinking。
    // TODO 2：按 Tool call index 合并 id、name 和 argumentsText，不能按到达顺序串线。
    // TODO 3：provider 给出 usage 时覆盖 _usage。
  }

  snapshot(): AssistantMessage {
    // TODO 4：按稳定顺序构造完整 content 数组；argumentsText 不完整时暂用 {}。
    // TODO 5：返回新对象和新数组，调用方修改 snapshot 不能污染 accumulator。
  }
}
```

</details>

目标文件：`src/community/anthropic/stream-accumulator.ts`

Anthropic event 先转成以下固定 provider-local union，再进入同名 accumulator；不要让 SDK
event type 泄漏到 Agent：

```ts
export type ProviderChunk =
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_delta"; index: number; thinking: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "input_json_delta"; index: number; partialJson: string }
  | { type: "message_start"; inputTokens: number }
  | { type: "message_end"; outputTokens: number };

export class StreamAccumulator {
  // TODO 1：按 block index 保存 text/thinking/tool 的独立累计状态。
  // TODO 2：分别保存 input/output usage，message_end 后产生完整 TokenUsage。

  push(chunk: ProviderChunk): void {
    // TODO 3：按 chunk.type 分派；同一 index 的 partialJson 只能追加到同一 Tool。
    throw new Error("TODO: implement Anthropic StreamAccumulator.push");
  }

  snapshot(): AssistantMessage {
    // TODO 4：按 index 排序输出新 content 数组；不完整 Tool input 暂时使用 {}。
    throw new Error("TODO: implement Anthropic StreamAccumulator.snapshot");
  }
}
```

目标文件：`src/community/openai/__tests__/stream-accumulator.test.ts`

<details>
<summary>展开完整代码：<code>stream-accumulator.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { StreamAccumulator } from "../stream-accumulator";

describe("OpenAI StreamAccumulator", () => {
  test("accumulates text and usage into independent snapshots", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ textDelta: "hel" } as never);
    const first = accumulator.snapshot();
    accumulator.push({ textDelta: "lo" } as never);
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } } as never);

    expect(first.content).toEqual([{ type: "text", text: "hel" }]);
    expect(accumulator.snapshot()).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      usage: { totalTokens: 5 },
    });
  });

  test("joins fragmented JSON without mixing concurrent tool calls", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      toolCall: { index: 1, id: "b", name: "read_file", argumentsDelta: '{"path":"b' },
    } as never);
    accumulator.push({
      toolCall: { index: 0, id: "a", name: "read_file", argumentsDelta: '{"path":"/tmp/' },
    } as never);
    accumulator.push({ toolCall: { index: 1, argumentsDelta: '.ts"}' } } as never);
    accumulator.push({ toolCall: { index: 0, argumentsDelta: 'demo","line":1}' } } as never);

    expect(accumulator.snapshot().content).toEqual([
      {
        type: "tool_use",
        id: "a",
        name: "read_file",
        input: { path: "/tmp/demo", line: 1 },
      },
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
  });

  test("does not expose mutable accumulator state", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ textDelta: "safe" } as never);
    const snapshot = accumulator.snapshot();
    snapshot.content.splice(0);

    expect(accumulator.snapshot().content).toEqual([{ type: "text", text: "safe" }]);
  });
});
```

</details>

目标文件：`src/community/anthropic/__tests__/stream-accumulator.test.ts`

<details>
<summary>展开完整代码：<code>stream-accumulator.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { StreamAccumulator } from "../stream-accumulator";

describe("Anthropic StreamAccumulator", () => {
  test("keeps block index order while accumulating deltas", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ index: 1, type: "text_delta", text: "answer" } as never);
    accumulator.push({ index: 0, type: "thinking_delta", thinking: "plan" } as never);
    accumulator.push({
      index: 2,
      type: "tool_start",
      id: "call-1",
      name: "read_file",
    } as never);
    accumulator.push({ index: 2, type: "input_json_delta", partialJson: '{"path"' } as never);
    accumulator.push({ index: 2, type: "input_json_delta", partialJson: ':"a.ts"}' } as never);

    expect(accumulator.snapshot().content).toEqual([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  test("combines input and output token usage", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ type: "message_start", inputTokens: 12 } as never);
    accumulator.push({ type: "message_end", outputTokens: 4 } as never);

    expect(accumulator.snapshot().usage).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
    });
  });
});
```

</details>

这里的 chunk 是教程规定的 provider-local normalized chunk；参数规则是：`index` 在一次
响应内稳定、`argumentsDelta`/`partialJson` 必须按同一 index 拼接、usage 只在 provider
明确报告时出现。若你直接消费 SDK event，可先在 `model-provider.ts` 做一次窄转换。

### 7.4 Provider class

目标文件：`src/community/openai/model-provider.ts`

```ts
export class OpenAIModelProvider implements ModelProvider {
  private readonly _client: OpenAI;

  constructor(options: { baseURL?: string; apiKey?: string; client?: OpenAI } = {}) {
    // 标准实现示例：允许测试注入 fake client；production 才创建真实 SDK client。
    this._client = options.client ?? new OpenAI({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
    });
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    // TODO 1：构造 request → client.chat.completions.create → parse；透传 signal。
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // TODO 2：设置 stream=true；每个 SDK chunk 依次 push，再 yield 累计 snapshot。
    // TODO 3：结束前确认最后 snapshot 是完整消息，且不带临时 streaming 标记。
  }
}
```

默认使用确定性更强的 provider options，并允许调用方最后覆盖：

```ts
return {
  model,
  messages: convertToOpenAIMessages(messages),
  tools: tools ? convertToOpenAITools(tools) : undefined,
  temperature: 0,
  top_p: 0,
  ...options,
};
```

不要在日志、trace 或测试 snapshot 中记录 API key。

目标文件：`src/community/openai/__tests__/model-provider.test.ts`

<details>
<summary>展开完整代码：<code>model-provider.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { OpenAIModelProvider } from "../model-provider";

describe("OpenAIModelProvider", () => {
  test("passes signal, tools and caller overrides to the SDK", async () => {
    let request: Record<string, unknown> | undefined;
    let sdkSignal: AbortSignal | undefined;
    const client = {
      chat: {
        completions: {
          create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
            request = body;
            sdkSignal = options.signal;
            return {
              choices: [{ message: { role: "assistant", content: "ok" } }],
              usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
            };
          },
        },
      },
    };
    const controller = new AbortController();
    const provider = new OpenAIModelProvider({ client: client as never });

    const result = await provider.invoke({
      model: "test-model",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [],
      options: { temperature: 0.25 },
      signal: controller.signal,
    });

    expect(request).toMatchObject({
      model: "test-model",
      temperature: 0.25,
      top_p: 0,
    });
    expect(sdkSignal).toBe(controller.signal);
    expect(result).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { totalTokens: 4 },
    });
  });
});
```

</details>

SDK `create` 的第二个参数承载 `signal`；不要把 signal 混进 JSON request body。Anthropic
provider 使用相同注入方式和断言结构，其 wire 转换差异已由 7.5 的完整测试固定。

目标文件：`examples/stage-07-real-model.ts`

示例只把可见 text snapshot 写到终端；最终 JSON 中的 thinking 内容保留 canonical shape，
但用 `[hidden]` 替换原文。模型名可通过对应环境变量覆盖。

<details>
<summary>展开完整代码：<code>stage-07-real-model.ts</code></summary>

```ts
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider } from "@/foundation/models/model-provider";
import { AnthropicModelProvider } from "@/community/anthropic/model-provider";
import { OpenAIModelProvider } from "@/community/openai/model-provider";

type Vendor = "openai" | "anthropic";

function visibleText(message: AssistantMessage): string {
  return message.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

function redactThinking(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    content: message.content.map((item) =>
      item.type === "thinking" ? { ...item, thinking: "[hidden]" } : item,
    ),
  };
}

async function main(): Promise<void> {
  const vendor = Bun.argv[2];
  if (vendor !== "openai" && vendor !== "anthropic") {
    console.log("Usage: bun run examples/stage-07-real-model.ts <openai|anthropic>");
    return;
  }

  const config: Record<Vendor, {
    apiKey: string | undefined;
    modelName: string;
    providerName: string;
  }> = {
    openai: {
      apiKey: Bun.env.OPENAI_API_KEY,
      modelName: Bun.env.OPENAI_MODEL ?? "gpt-4.1-mini",
      providerName: "OpenAI",
    },
    anthropic: {
      apiKey: Bun.env.ANTHROPIC_API_KEY,
      modelName: Bun.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-20250514",
      providerName: "Anthropic",
    },
  };
  const selected = config[vendor];

  if (!selected.apiKey) {
    console.log(`Missing ${vendor === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}.`);
    console.log("Configure the key and run this optional integration example again.");
    return;
  }

  const provider: ModelProvider = vendor === "openai"
    ? new OpenAIModelProvider({
        apiKey: selected.apiKey,
        baseURL: Bun.env.OPENAI_BASE_URL,
      })
    : new AnthropicModelProvider({ apiKey: selected.apiKey });
  const model = new Model({ name: selected.modelName, provider });
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "用一句话解释 ReAct agent loop。" }],
  };
  const startedAt = performance.now();
  let finalMessage: AssistantMessage | undefined;

  console.log(`provider=${selected.providerName} model=${selected.modelName}`);
  for await (const snapshot of model.stream({
    prompt: "Answer concisely. Do not expose hidden reasoning.",
    messages: [userMessage],
  })) {
    process.stdout.write(`\r${visibleText(snapshot)}`);
    finalMessage = snapshot;
  }
  process.stdout.write("\n");

  if (!finalMessage) throw new Error("Provider stream returned no snapshots");

  console.log(JSON.stringify(redactThinking(finalMessage), null, 2));
  console.log(
    `tokens prompt=${finalMessage.usage?.promptTokens ?? "n/a"} ` +
      `output=${finalMessage.usage?.completionTokens ?? "n/a"} ` +
      `total=${finalMessage.usage?.totalTokens ?? "n/a"}`,
  );
  console.log(`elapsed=${Math.round(performance.now() - startedAt)}ms`);
}

await main();
```

</details>

### 运行与观察

OpenAI-compatible endpoint：

```bash
OPENAI_API_KEY=... bun run examples/stage-07-real-model.ts openai
```

Anthropic：

```bash
ANTHROPIC_API_KEY=... bun run examples/stage-07-real-model.ts anthropic
```

示例应打印：

- provider name 和 model name；
- streaming progress，不打印隐藏 reasoning 原文；
- 最终 canonical `AssistantMessage`；
- prompt/output/total tokens；
- 总耗时。

如果没有 key，示例给出配置提示后 exit 0；测试套件不能因此失败。

### 7.5 完整协议测试

目标文件：`src/community/openai/__tests__/utils.test.ts`

下面是可直接复制的完整 OpenAI 转换测试。测试中的 `as never` 只把精简 fixture
适配成 SDK 的庞大 wire type；生产代码不得借此跳过 canonical type 检查。

<details>
<summary>展开完整代码：<code>utils.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { Message } from "@/foundation/messages";

import {
  convertToOpenAIMessages,
  parseOpenAIAssistantMessage,
} from "../utils";

describe("OpenAI protocol conversion", () => {
  test("converts system and user content without losing order", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be concise" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image_url", image_url: { url: "https://example.test/a.png" } },
        ],
      },
    ];

    expect(convertToOpenAIMessages(messages)).toMatchObject([
      { role: "system" },
      { role: "user" },
    ]);
  });

  test("keeps text and multiple tool calls in one assistant message", () => {
    const result = convertToOpenAIMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect both files" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "call-2", name: "read_file", input: { path: "b.ts" } },
        ],
      },
    ]);

    expect(result[0]).toMatchObject({
      role: "assistant",
      tool_calls: [
        { id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "call-2", function: { name: "read_file", arguments: '{"path":"b.ts"}' } },
      ],
    });
  });

  test("expands tool results and preserves their call ids", () => {
    const result = convertToOpenAIMessages([
      {
        role: "tool",
        content: [
          { type: "tool_result", tool_use_id: "call-1", content: "A" },
          { type: "tool_result", tool_use_id: "call-2", content: "B" },
        ],
      },
    ]);

    expect(result).toMatchObject([
      { role: "tool", tool_call_id: "call-1", content: "A" },
      { role: "tool", tool_call_id: "call-2", content: "B" },
    ]);
  });

  test("parses reasoning, empty text and tool arguments", () => {
    const result = parseOpenAIAssistantMessage({
      role: "assistant",
      content: "",
      reasoning_content: "inspect first",
      tool_calls: [
        {
          type: "function",
          id: "call-1",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    } as never);

    expect(result.content).toEqual([
      { type: "thinking", thinking: "inspect first" },
      { type: "text", text: "" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(result.usage).toBeUndefined();
  });

  test("reports malformed final tool arguments with the call id", () => {
    expect(() =>
      parseOpenAIAssistantMessage({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            type: "function",
            id: "broken-call",
            function: { name: "read_file", arguments: '{"path"' },
          },
        ],
      } as never),
    ).toThrow("broken-call");
  });
});
```

</details>

目标文件：`src/community/anthropic/__tests__/utils.test.ts`

<details>
<summary>展开完整代码：<code>utils.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { Message } from "@/foundation/messages";

import {
  convertToAnthropicMessages,
  extractSystemPrompt,
  parseAnthropicAssistantMessage,
} from "../utils";

describe("Anthropic protocol conversion", () => {
  test("extracts system text separately and excludes it from messages", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Rule A" }] },
      { role: "system", content: [{ type: "text", text: "Rule B" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];

    expect(extractSystemPrompt(messages)).toBe("Rule A\n\nRule B");
    expect(convertToAnthropicMessages(messages)).toMatchObject([
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ]);
  });

  test("keeps assistant text, thinking and multiple tool ids", () => {
    const result = convertToAnthropicMessages([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "running" },
          { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
          { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
        ],
      },
    ]);

    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan" },
        { type: "text", text: "running" },
        { type: "tool_use", id: "a" },
        { type: "tool_use", id: "b" },
      ],
    });
  });

  test("converts tool results into user-role content", () => {
    expect(convertToAnthropicMessages([
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "a", content: "result" }],
      },
    ])).toMatchObject([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "a", content: "result" }],
      },
    ]);
  });

  test("parses text, thinking, tool use and usage", () => {
    const result = parseAnthropicAssistantMessage({
      id: "message-1",
      type: "message",
      role: "assistant",
      model: "test-model",
      stop_reason: "tool_use",
      content: [
        { type: "thinking", thinking: "plan", signature: "signature" },
        { type: "text", text: "running" },
        { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
      ],
      usage: { input_tokens: 8, output_tokens: 5 },
    } as never);

    expect(result.content).toMatchObject([
      { type: "thinking", thinking: "plan" },
      { type: "text", text: "running" },
      { type: "tool_use", id: "a", input: { path: "a.ts" } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 8, completionTokens: 5, totalTokens: 13 });
  });
});
```

</details>

这两个文件已经覆盖 user/system/assistant、混合内容、多 Tool call、call id、空文本、
thinking、缺少 usage 和 malformed arguments。Malformed arguments 在最终非流式响应中必须
抛出带 call id 的诊断错误；流式 fragment 的规则由前文 7.3 的 accumulator 测试固定。

最后执行本阶段的完整测试：

```bash
bun test src/community/openai src/community/anthropic
```

### 阶段后对照

- `src/community/openai/model-provider.ts`
- `src/community/openai/utils.ts`
- `src/community/openai/stream-accumulator.ts`
- `src/community/anthropic/model-provider.ts`
- `src/community/anthropic/utils.ts`
- `src/community/anthropic/stream-accumulator.ts`

### 验收

- [ ] provider SDK type 不进入 `agent`；
- [ ] converter tests 不访问网络；
- [ ] streaming 最终 snapshot 与 non-stream response 语义一致；
- [ ] fragmented Tool arguments 有测试；
- [ ] signal 传入 SDK 请求；
- [ ] `ADR-008` 解释 canonical protocol 与 vendor wire protocol 的边界。

## 阶段 8：实现 Coding Tools

> 上一阶段回顾：阶段 7 把 canonical protocol 映射到 OpenAI 与 Anthropic，并统一了 streaming、Tool call、usage 和 abort 语义。

### 本阶段原则

Coding Agent 的能力不来自“更长的 prompt”，而来自高质量的环境接口。Tool 应窄、可组合、有明确 error code，并回显模型下一步决策需要的信息。

按风险分两批实现：

| 批次 | Tools | 副作用 |
|---|---|---|
| A：只读 | `file_info`、`list_files`、`glob_search`、`grep_search`、`read_file` | 无 |
| B：修改 | `mkdir`、`write_file`、`str_replace`、`apply_patch`、`move_path`、`bash` | 有 |

不要一开始实现一个万能 `filesystem` Tool。窄 Tool 更容易描述、审批、测试、统计和限制权限。

一键创建全部 Tool 与测试文件：

```bash
mkdir -p src/coding/tools/__tests__ examples
for name in tool-utils tool-result file-info list-files glob-search grep-search read-file mkdir write-file str-replace apply-patch move-path bash; do
  touch "src/coding/tools/${name}.ts"
done
touch src/coding/tools/__tests__/tool-utils.test.ts
touch src/coding/tools/__tests__/coding-tools.test.ts
touch src/coding/tools/index.ts examples/stage-08-coding-tools.ts
```

这个循环只创建空文件，不覆盖内容。所有 Tool 的公开行为集中在一个完整 contract test，
路径安全单独测试；迭代时可用 `bun test -t "read_file"` 只运行相关用例。

各 Tool factory 的导出如下：

| 文件 | public export |
|---|---|
| `file-info.ts` | `defineFileInfoTool` |
| `list-files.ts` | `defineListFilesTool` |
| `glob-search.ts` | `defineGlobSearchTool` |
| `grep-search.ts` | `defineGrepSearchTool` |
| `read-file.ts` | `defineReadFileTool` |
| `mkdir.ts` | `defineMkdirTool` |
| `write-file.ts` | `defineWriteFileTool` |
| `str-replace.ts` | `defineStrReplaceTool` |
| `apply-patch.ts` | `defineApplyPatchTool` |
| `move-path.ts` | `defineMovePathTool` |
| `bash.ts` | `defineBashTool` |

### 8.1 Workspace boundary

创建 `src/coding/tools/tool-utils.ts`：

```ts
export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; code: "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE"; error: string };

export async function resolveWorkspacePath(options: {
  cwd: string;
  inputPath: string;
}): Promise<PathValidationResult> {
  // 标准实现示例：第一步只做词法规范化，不能据此判定安全。
  const absolutePath = resolve(options.cwd, options.inputPath);

  // TODO 1：realpath cwd；cwd 不存在时返回 INVALID_PATH。
  // TODO 2：向上找到 absolutePath 最近的已存在祖先并 realpath，处理 symlink。
  // TODO 3：用 relative(realCwd, realAncestor) 判断是否越界；拒绝 ".." 和绝对结果。
  // TODO 4：将尚不存在的尾部路径重新接到真实祖先，并返回最终 path。
}
```

这是课程对基础参考实现的安全增强。需要明确测试：

- 相对路径；
- 正常绝对路径；
- `../` 越界；
- 相似前缀目录；
- 指向 workspace 外的 symlink；
- 尚不存在的目标文件。

### 8.2 Tool 实现配方

每个 Tool 按同一顺序实现：

1. 定义用户目标和最小输入；
2. Zod schema 的第一个字段放 `description`；
3. 验证 path/range/size；
4. 执行单一动作；
5. success result 返回 `summary + data`；
6. expected failure 返回 `summary + error + code + details`；
7. 写 happy path、error code 和 boundary tests；
8. 注册到 `src/coding/tools/index.ts`。

以 `read_file` 为例，目标文件是 `src/coding/tools/read-file.ts`。Tool 必须通过 factory
绑定 workspace；`cwd` 是已初始化的可信边界，不允许模型通过 Tool input 修改：

```ts
export function defineReadFileTool(options: { cwd: string; maxCharacters?: number }) {
  return defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file or a bounded line range",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
    invoke: async (input, signal) => {
      signal?.throwIfAborted();
      // 标准实现示例：中止检查必须发生在文件系统访问之前。

      // TODO 1：resolveWorkspacePath；失败时原样返回稳定 code。
      // TODO 2：检查存在且为普通文件；分别返回 FILE_NOT_FOUND / NOT_A_FILE。
      // TODO 3：startLine/endLine 必须成对满足 1 <= start <= end <= lineCount。
      // TODO 4：全文件读取返回原文；范围读取返回带 1-based 行号的文本。
      // TODO 5：应用字符上限并在截断时添加明确 marker。
    },
  });
}
```

建议稳定 error codes：

```text
INVALID_PATH
PATH_OUTSIDE_WORKSPACE
FILE_NOT_FOUND
NOT_A_FILE
NOT_A_DIRECTORY
START_LINE_OUT_OF_RANGE
INVALID_LINE_RANGE
PATTERN_NOT_FOUND
AMBIGUOUS_REPLACEMENT
PATCH_APPLY_FAILED
COMMAND_FAILED
COMMAND_TIMED_OUT
ABORTED
```

### 8.3 `str_replace` 的正确语义

不要默认替换所有匹配。安全行为是：

- 0 个匹配：`PATTERN_NOT_FOUND`；
- 1 个匹配：执行替换；
- 多个匹配且未显式允许：`AMBIGUOUS_REPLACEMENT`；
- success data 返回替换位置和修改后的摘要。

这能阻止模型的局部意图意外变成全局修改。

### 8.4 `bash` 的边界

`bash` Tool 负责进程执行和结果捕获，不负责自行决定是否安全。审批由阶段 10 的 Policy Middleware 完成。

必须支持：

- 明确的 `cwd`；
- stdout、stderr、exit code；
- timeout；
- `AbortSignal` 时 kill 子进程；
- 输出大小上限和 truncation marker；
- non-zero exit 返回 structured error。

不要把 command 插入另一层未转义的 shell string。若契约接收完整 shell command，应明确这是 intentional shell execution，并把原始 command 展示在审批界面。

### 8.5 组装 Coding Tools

目标文件：`src/coding/tools/index.ts`

用 `defineCodingTools()` 创建阶段 8 的全部 Tool：

```ts
export interface DefineCodingToolsOptions {
  cwd: string;
  bashTimeoutMs?: number;
  maxOutputCharacters?: number;
}

export function defineCodingTools(options: DefineCodingToolsOptions): Tool[] {
  // TODO：构造并返回阶段 8 的全部 Tool；每个 filesystem Tool 共享 options.cwd。
  // 提示：只读 Tool 放前、修改型 Tool 放后，并保持数组顺序稳定供测试与 UI 使用。
  // bashTimeoutMs/maxOutputCharacters 只传给需要它们的 Tool，不能接受模型侧覆盖。
  throw new Error("TODO: implement defineCodingTools");
}
```

参数规则：所有 Tool input 的首字段都是 `description`；文件路径相对固定 `cwd`；
`startLine/endLine` 为 1-based 且必须成对出现；bash timeout 来自 composition 配置而非模型。

目标文件：`examples/stage-08-coding-tools.ts`

示例在系统临时目录中创建 fixture，三种模式都通过公开 Tool contract 操作。结束时输出
简化 workspace diff，并在 `finally` 中删除临时目录。

<details>
<summary>展开完整代码：<code>stage-08-coding-tools.ts</code></summary>

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineCodingTools } from "@/coding/tools";

type Mode = "inspect" | "edit" | "reject-path";
type WorkspaceSnapshot = Record<string, string>;

const trackedPaths = ["input.ts", "notes.txt"];

async function snapshot(cwd: string): Promise<WorkspaceSnapshot> {
  const result: WorkspaceSnapshot = {};
  for (const path of trackedPaths) {
    try {
      result[path] = await readFile(join(cwd, path), "utf8");
    } catch {
      // 文件尚不存在时不写入 snapshot。
    }
  }
  return result;
}

function printDiff(before: WorkspaceSnapshot, after: WorkspaceSnapshot): void {
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  let changed = false;

  for (const path of paths) {
    if (before[path] === after[path]) continue;
    changed = true;
    console.log(`--- before/${path}`);
    console.log(`+++ after/${path}`);
    if (before[path] !== undefined) console.log(`-${before[path]!.trimEnd()}`);
    if (after[path] !== undefined) console.log(`+${after[path]!.trimEnd()}`);
  }

  if (!changed) console.log("(no workspace changes)");
}

async function main(): Promise<void> {
  const mode = Bun.argv[2];
  if (mode !== "inspect" && mode !== "edit" && mode !== "reject-path") {
    console.log("Usage: bun run examples/stage-08-coding-tools.ts <inspect|edit|reject-path>");
    return;
  }

  const workspace = await mkdtemp(join(tmpdir(), "harness-tools-demo-"));
  try {
    await writeFile(join(workspace, "input.ts"), "export const value = 1;\n", "utf8");
    const before = await snapshot(workspace);
    const tools = defineCodingTools({ cwd: workspace, bashTimeoutMs: 1_000 });
    const invoke = async (name: string, input: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Missing coding Tool: ${name}`);
      const result = await tool.invoke({ description: `demo ${name}`, ...input } as never);
      console.log(`${name}: ${JSON.stringify(result, null, 2)}`);
      return result;
    };

    if (mode === "inspect") {
      await invoke("list_files", { path: "." });
      await invoke("read_file", { path: "input.ts" });
      await invoke("grep_search", { path: ".", pattern: "value" });
    } else if (mode === "edit") {
      await invoke("str_replace", {
        path: "input.ts",
        oldText: "value = 1",
        newText: "value = 2",
      });
      await invoke("write_file", {
        path: "notes.txt",
        content: "updated by stage-08-coding-tools\n",
      });
    } else {
      await invoke("read_file", { path: "../outside.txt" });
    }

    console.log("workspace diff:");
    printDiff(before, await snapshot(workspace));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

await main();
```

</details>

### 运行与观察

创建一个临时 fixture repo，依次运行：

```bash
bun run examples/stage-08-coding-tools.ts inspect
bun run examples/stage-08-coding-tools.ts edit
bun run examples/stage-08-coding-tools.ts reject-path
```

示例最后打印 workspace diff，而不只是打印 `ok: true`。你应能看到每个 Tool 对外部世界造成的具体变化。

### 8.6 完整测试

目标文件：`src/coding/tools/__tests__/tool-utils.test.ts`

每个 filesystem Tool 都依赖这里固定的 workspace boundary。下面是完整测试文件：

<details>
<summary>展开完整代码：<code>tool-utils.test.ts</code></summary>

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWorkspacePath } from "../tool-utils";

let workspace: string;
let outside: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "harness-lab-tool-"));
  outside = await mkdtemp(join(tmpdir(), "harness-lab-outside-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveWorkspacePath", () => {
  test("accepts relative, absolute and not-yet-created paths inside cwd", async () => {
    await mkdir(join(workspace, "src"));

    expect(await resolveWorkspacePath({ cwd: workspace, inputPath: "src/new.ts" }))
      .toMatchObject({ ok: true, path: join(workspace, "src/new.ts") });
    expect(await resolveWorkspacePath({ cwd: workspace, inputPath: join(workspace, "src") }))
      .toMatchObject({ ok: true, path: join(workspace, "src") });
  });

  test("rejects traversal and a directory with a similar prefix", async () => {
    expect(await resolveWorkspacePath({ cwd: workspace, inputPath: "../secret.txt" }))
      .toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
    expect(await resolveWorkspacePath({ cwd: workspace, inputPath: `${workspace}-other/file.ts` }))
      .toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("rejects a symlink whose real target is outside cwd", async () => {
    await symlink(outside, join(workspace, "escape"));

    expect(await resolveWorkspacePath({ cwd: workspace, inputPath: "escape/new.ts" }))
      .toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
  });
});
```

</details>

目标文件：`src/coding/tools/__tests__/coding-tools.test.ts`

`defineCodingTools({ cwd })` 在 `src/coding/tools/index.ts` 返回全部 Tool。测试通过 Tool 的
公开 `invoke` 契约操作临时目录，因此不会修改课程仓库：

<details>
<summary>展开完整代码：<code>coding-tools.test.ts</code></summary>

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { defineCodingTools } from "../index";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "harness-lab-tools-"));
  await writeFile(join(workspace, "input.ts"), "const value = 1;\n", "utf8");
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

async function invoke(name: string, input: Record<string, unknown>, signal?: AbortSignal) {
  const tool = defineCodingTools({ cwd: workspace, bashTimeoutMs: 50 })
    .find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing test Tool: ${name}`);
  return tool.invoke({ description: `test ${name}`, ...input } as never, signal);
}

describe("read-only coding tools", () => {
  test("file_info, list_files, glob_search and grep_search expose bounded data", async () => {
    expect(await invoke("file_info", { path: "input.ts" })).toMatchObject({ ok: true });
    expect(await invoke("list_files", { path: "." })).toMatchObject({ ok: true });
    expect(await invoke("glob_search", { path: ".", pattern: "**/*.ts" }))
      .toMatchObject({ ok: true });
    expect(await invoke("grep_search", { path: ".", pattern: "value" }))
      .toMatchObject({ ok: true });
  });

  test("read_file validates ranges and rejects traversal", async () => {
    expect(await invoke("read_file", { path: "input.ts", startLine: 1, endLine: 1 }))
      .toMatchObject({ ok: true });
    expect(await invoke("read_file", { path: "input.ts", startLine: 2, endLine: 1 }))
      .toMatchObject({ ok: false, code: "INVALID_LINE_RANGE" });
    expect(await invoke("read_file", { path: "../outside.ts" }))
      .toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
  });
});

describe("mutating coding tools", () => {
  test("mkdir, write_file and move_path produce observable side effects", async () => {
    expect(await invoke("mkdir", { path: "src" })).toMatchObject({ ok: true });
    expect(await invoke("write_file", { path: "src/a.ts", content: "export {};\n" }))
      .toMatchObject({ ok: true });
    expect(await invoke("move_path", { from: "src/a.ts", to: "src/b.ts" }))
      .toMatchObject({ ok: true });
    expect(await readFile(join(workspace, "src/b.ts"), "utf8")).toBe("export {};\n");
  });

  test("str_replace refuses zero and ambiguous matches", async () => {
    await writeFile(join(workspace, "input.ts"), "same\nsame\n", "utf8");

    expect(await invoke("str_replace", { path: "input.ts", oldText: "missing", newText: "x" }))
      .toMatchObject({ ok: false, code: "PATTERN_NOT_FOUND" });
    expect(await invoke("str_replace", { path: "input.ts", oldText: "same", newText: "x" }))
      .toMatchObject({ ok: false, code: "AMBIGUOUS_REPLACEMENT" });
  });

  test("apply_patch applies a valid patch and diagnoses an invalid one", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: input.ts",
      "@@",
      "-const value = 1;",
      "+const value = 2;",
      "*** End Patch",
    ].join("\n");

    expect(await invoke("apply_patch", { patch })).toMatchObject({ ok: true });
    expect(await invoke("apply_patch", { patch: "not a patch" }))
      .toMatchObject({ ok: false, code: "PATCH_APPLY_FAILED" });
  });
});

describe("bash", () => {
  test("captures success and non-zero exit", async () => {
    expect(await invoke("bash", { command: "printf ok" })).toMatchObject({ ok: true });
    expect(await invoke("bash", { command: "exit 7" }))
      .toMatchObject({ ok: false, code: "COMMAND_FAILED" });
  });

  test("reports timeout and observes a pre-aborted signal", async () => {
    expect(await invoke("bash", { command: "sleep 1" }))
      .toMatchObject({ ok: false, code: "COMMAND_TIMED_OUT" });

    const controller = new AbortController();
    controller.abort();
    expect(await invoke("bash", { command: "printf unexpected" }, controller.signal))
      .toMatchObject({ ok: false, code: "ABORTED" });
  });
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test src/coding/tools
```

### 阶段后对照

- `src/coding/tools/` 下各实现；
- `src/coding/tools/__tests__/`；
- `src/coding/tools/tool-utils.ts`；
- `src/coding/tools/tool-result.ts`。

### 验收

- [ ] 所有修改型 Tool 都有副作用测试；
- [ ] path traversal 和 symlink escape 被拒绝；
- [ ] `str_replace` 不做隐式多处替换；
- [ ] bash 超时和 abort 不遗留子进程；
- [ ] 输出有大小上限；
- [ ] `ADR-009` 解释为什么采用多个窄 Tool。

## 阶段 9：组装 Coding Agent、Skills、Todo 与项目指令

> 上一阶段回顾：阶段 8 建立了一组窄而安全的 Coding Tools，统一了 workspace boundary、结构化结果、超时与中止行为。

创建新增文件：

```bash
mkdir -p src/coding/agents/__tests__ src/agent/skills/__tests__ src/agent/todos/__tests__
touch src/coding/agents/coding-agent.ts src/coding/agents/index.ts
touch src/coding/agents/__tests__/coding-agent.test.ts
touch src/agent/skills/skill-reader.ts src/agent/skills/skills-middleware.ts src/agent/skills/index.ts
touch src/agent/skills/__tests__/skill-reader.test.ts
touch src/agent/todos/todo-system.ts src/agent/todos/index.ts src/agent/todos/__tests__/todo-system.test.ts
touch src/coding/tools/ask-user-question.ts src/coding/tools/__tests__/ask-user-question.test.ts
touch examples/stage-09-coding-agent.ts
```

### 9.1 Coding Agent composition root

不要把 Coding 逻辑放回通用 `Agent`。创建：

```ts
export async function defineCodingAgent(options: {
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  askUserQuestion?: AskUserQuestionHandler;
  policyMiddleware?: AgentMiddleware;
  maxGuidanceCharacters?: number;
  onWarning?: (message: string) => void;
}): Promise<Agent> {
  // 标准实现示例：先固定 cwd；后续所有 path Tool 必须共享这一个边界。
  const cwd = options.cwd ?? process.cwd();

  // TODO 1：读取 `${cwd}/AGENTS.md`；不存在时返回空 guidance，超限时 warning。
  // TODO 2：组合 coding prompt，但不要把 guidance 写入 canonical transcript。
  // TODO 3：构造绑定 cwd 的 coding tools。
  // TODO 4：构造 skills/todo/policy middlewares，顺序写入测试。
  // TODO 5：返回通用 Agent；本文件不实现 loop 或 filesystem 细节。
}
```

composition root 只做组装，不实现 filesystem 或 loop 细节。

### 9.2 `AGENTS.md`

启动时查找 workspace root 的 `AGENTS.md`：

- 不存在时正常运行；
- 存在时读取为 project guidance；
- trace 中记录文件路径和 content hash，不默认复制完整内容；
- 不把 guidance 称为“模型学习到的长期记忆”。它只是每次 run 可重载的持久化指令。

为防止 project guidance 无限制膨胀，设置字符或 token 上限，超限时给出明确 warning。

### 9.3 Skills progressive loading

定义最小 frontmatter：

```yaml
---
name: test-writer
description: Use when adding or repairing automated tests.
---

# Test Writer

Instructions...
```

Skill discovery 只读取 `name`、`description`、`path`，把列表注入 model prompt。只有模型选择 Skill 或用户显式指定 Skill 后，才调用 `read_file` 加载完整 `SKILL.md`。

目标文件：`src/agent/skills/skill-reader.ts`

实现 Skill 发现与读取接口：

```ts
export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
}

export async function discoverSkills(options: {
  directories: string[];
  maxFrontmatterCharacters?: number;
}): Promise<{ skills: SkillDescriptor[]; warnings: string[] }> {
  // TODO 1：遍历每个目录的一层子目录，只读取 SKILL.md frontmatter。
  // TODO 2：按 realpath 去重；malformed 文件写入 warnings，不中止其他目录。
  throw new Error("TODO: implement discoverSkills");
}

export async function readSkill(options: {
  descriptor: SkillDescriptor;
  maxCharacters?: number;
}): Promise<{ content: string; truncated: boolean }> {
  // TODO 3：只读取 descriptor.path，应用字符上限，并准确返回 truncated。
  // 提示：不得按 name 重新搜索，否则同名不同 path 会加载错误内容。
  throw new Error("TODO: implement readSkill");
}
```

必须测试：

- 目录不存在；
- malformed frontmatter；
- 重复 path；
- 同名不同 path；
- 显式选择 Skill；
- Skill 内容只在选择后进入 transcript。

### 9.4 Todo system

Todo 由一个 Tool 和一个 Middleware 组成：

- `todo_write` Tool 管理结构化状态；
- Middleware 在长时间未更新时注入 reminder；
- 最多一个 item 为 `in_progress`；
- `merge=true` 按 id 更新，`merge=false` 全量替换；
- UI 从结构化 store 渲染，不从 assistant 文本猜 Todo。

这是一项很好的 Middleware 练习：状态属于 Todo system，通用 Agent 只负责调用 hooks。

目标文件：`src/agent/todos/todo-system.ts`

定义 Todo 数据类型和状态管理类：

<details>
<summary>展开完整代码：<code>todo-system.ts</code></summary>

```ts
export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
}

export interface TodoWriteInput {
  merge: boolean;
  items: TodoItem[];
}

export class TodoSystem {
  constructor(options: { reminderAfterSteps: number }) {
    // TODO 1：保存 reminderAfterSteps，并初始化私有 Todo store/lastUpdatedStep。
  }

  write(input: TodoWriteInput): void {
    // TODO 2：merge=false 全量替换；merge=true 按 id 更新或追加。
    // TODO 3：提交前校验最多一个 in_progress，失败时不能部分修改 store。
    throw new Error("TODO: implement TodoSystem.write");
  }

  snapshot(): TodoItem[] {
    // TODO 4：返回深度独立的数组，调用方不得修改内部状态。
    throw new Error("TODO: implement TodoSystem.snapshot");
  }

  reminderForStep(step: number): string | undefined {
    // TODO 5：达到 reminderAfterSteps 且仍有未完成项时返回 reminder，否则 undefined。
    throw new Error("TODO: implement TodoSystem.reminderForStep");
  }
}
```

</details>

### 9.5 Ask user Tool

Tool call 不只用于机器 API。定义 `ask_user_question`，把需要人类补充的信息表示为可等待的 Tool：

```ts
export type AskUserQuestionHandler = (params: {
  question: string;
  choices?: string[];
}) => Promise<{ answer: string }>;

export function defineAskUserQuestionTool(options: {
  handler: AskUserQuestionHandler;
}): FunctionTool {
  // TODO：定义 wire name="ask_user_question" 的 Tool，并把 question/choices 交给 handler。
  // 提示：先检查 signal；handler 的 answer 原样返回，异常由 Tool runtime 统一规范化。
  throw new Error("TODO: implement defineAskUserQuestionTool");
}
```

测试 handler 被并发 Tool 调度调用时不会丢失 call id。

### 运行与观察

准备 fixture workspace：

```text
fixture/                                      # 离线 Coding Agent 示例 workspace
├── AGENTS.md                                 # 提供项目级开发约束
├── .agents/skills/test-writer/SKILL.md       # 提供按需加载的测试 Skill
└── src/math.ts                               # 供 Agent 检查的示例源码
```

目标文件：`examples/stage-09-coding-agent.ts`

`fixture/AGENTS.md` 应包含一条可辨识的 project guidance，Skill frontmatter 的 name 应为
`test-writer`。示例会确认二者进入首次 model view，然后使用 scripted responses 驱动
Skill 文件读取、Todo 更新和源码读取。

<details>
<summary>展开完整代码：<code>stage-09-coding-agent.ts</code></summary>

```ts
import { join, resolve } from "node:path";

import { defineCodingAgent } from "@/coding/agents/coding-agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

class RecordingScriptedProvider implements ModelProvider {
  readonly requests: ModelProviderInvokeParams[] = [];
  private readonly _provider: ScriptedModelProvider;

  constructor(responses: AssistantMessage[]) {
    this._provider = new ScriptedModelProvider({ responses });
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.requests.push(params);
    return this._provider.invoke(params);
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.requests.push(params);
    yield* this._provider.stream(params);
  }
}

const responses: AssistantMessage[] = [
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "skill-1",
        name: "read_file",
        input: {
          description: "load the selected test-writer Skill",
          path: ".agents/skills/test-writer/SKILL.md",
        },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "todo-1",
        name: "todo_write",
        input: {
          description: "track fixture inspection",
          merge: false,
          items: [{ id: "inspect", text: "Inspect src/math.ts", status: "in_progress" }],
        },
      },
    ],
  },
  {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "read-1",
        name: "read_file",
        input: { description: "inspect the fixture source", path: "src/math.ts" },
      },
    ],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Loaded project guidance, Skill, Todo, and source." }],
  },
];

async function main(): Promise<void> {
  const fixtureArgument = Bun.argv[2];
  if (!fixtureArgument) {
    console.log("Usage: bun run examples/stage-09-coding-agent.ts <fixture-workspace>");
    return;
  }

  const cwd = resolve(fixtureArgument);
  const requiredFiles = [
    "AGENTS.md",
    ".agents/skills/test-writer/SKILL.md",
    "src/math.ts",
  ];
  for (const path of requiredFiles) {
    if (!(await Bun.file(join(cwd, path)).exists())) {
      throw new Error(`Missing fixture file: ${join(cwd, path)}`);
    }
  }

  const provider = new RecordingScriptedProvider(responses);
  const agent = await defineCodingAgent({
    model: new Model({ name: "scripted", provider }),
    cwd,
    skillsDirs: [join(cwd, ".agents", "skills")],
    askUserQuestion: async ({ question }) => ({ answer: `fixture answer: ${question}` }),
  });
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "Inspect the fixture using the test-writing guidance." }],
  };

  for await (const event of agent.stream(userMessage)) {
    if (event.type === "message") console.log(JSON.stringify(event.message));
  }

  const guidance = (await Bun.file(join(cwd, "AGENTS.md")).text()).trim();
  const firstModelView = JSON.stringify(provider.requests[0]?.messages ?? []);
  if (!firstModelView.includes("test-writer") || !firstModelView.includes(guidance)) {
    throw new Error("Project guidance or Skill metadata was not included in the first model view");
  }

  console.log(JSON.stringify(agent.messages, null, 2));
  console.log("[offline] completed with ScriptedModelProvider; no API request was made");
}

await main();
```

</details>

运行：

```bash
bun run examples/stage-09-coding-agent.ts fixture
```

使用 scripted provider 完成一次“读取 guidance → 列出 Skill → 加载 Skill → 建 Todo → 读取文件 → 最终回答”的 run。输出 transcript，并断言没有真实 API。

### 9.6 完整测试

目标文件：`src/agent/skills/__tests__/skill-reader.test.ts`

<details>
<summary>展开完整代码：<code>skill-reader.test.ts</code></summary>

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { discoverSkills, readSkill } from "../skill-reader";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-skills-"));
  roots.push(root);
  await mkdir(join(root, "valid"));
  await mkdir(join(root, "broken"));
  await writeFile(join(root, "valid", "SKILL.md"), [
    "---",
    "name: test-writer",
    "description: Use when writing tests.",
    "---",
    "",
    "# Test Writer",
    "Full instructions",
  ].join("\n"));
  await writeFile(join(root, "broken", "SKILL.md"), "---\nname: broken\n");
  return root;
}

describe("Skill reader", () => {
  test("returns no skills for a missing directory", async () => {
    const result = await discoverSkills({ directories: ["/definitely/missing"] });
    expect(result.skills).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  test("discovers metadata but loads full content only when selected", async () => {
    const root = await fixture();
    const result = await discoverSkills({ directories: [root] });

    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "test-writer",
      description: "Use when writing tests.",
    });
    expect(JSON.stringify(result.skills)).not.toContain("Full instructions");
    expect((await readSkill({ descriptor: result.skills[0]! })).content)
      .toContain("Full instructions");
    expect(result.warnings.join("\n")).toContain("broken");
  });

  test("deduplicates the same real path without hiding same-name skills", async () => {
    const root = await fixture();
    const result = await discoverSkills({ directories: [root, root] });
    expect(result.skills.filter((skill) => skill.name === "test-writer")).toHaveLength(1);
  });
});
```

</details>

目标文件：`src/agent/todos/__tests__/todo-system.test.ts`

<details>
<summary>展开完整代码：<code>todo-system.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { TodoSystem } from "../todo-system";

describe("TodoSystem", () => {
  test("replaces all items when merge is false", () => {
    const todos = new TodoSystem({ reminderAfterSteps: 2 });
    todos.write({
      merge: false,
      items: [
        { id: "a", text: "inspect", status: "completed" },
        { id: "b", text: "edit", status: "in_progress" },
      ],
    });

    expect(todos.snapshot()).toHaveLength(2);
  });

  test("merges by id and rejects two in-progress items", () => {
    const todos = new TodoSystem({ reminderAfterSteps: 2 });
    todos.write({
      merge: false,
      items: [{ id: "a", text: "inspect", status: "in_progress" }],
    });
    todos.write({
      merge: true,
      items: [{ id: "a", text: "inspect", status: "completed" }],
    });
    expect(todos.snapshot()[0]?.status).toBe("completed");

    expect(() => todos.write({
      merge: false,
      items: [
        { id: "a", text: "one", status: "in_progress" },
        { id: "b", text: "two", status: "in_progress" },
      ],
    })).toThrow("in_progress");
  });

  test("reminds only after the configured number of untouched steps", () => {
    const todos = new TodoSystem({ reminderAfterSteps: 2 });
    todos.write({
      merge: false,
      items: [{ id: "a", text: "inspect", status: "pending" }],
    });
    expect(todos.reminderForStep(1)).toBeUndefined();
    expect(todos.reminderForStep(2)).toContain("inspect");
  });
});
```

</details>

目标文件：`src/coding/tools/__tests__/ask-user-question.test.ts`

```ts
import { describe, expect, test } from "bun:test";

import { defineAskUserQuestionTool } from "../ask-user-question";

describe("ask_user_question", () => {
  test("keeps concurrent answers associated with their invocation", async () => {
    const tool = defineAskUserQuestionTool({
      handler: async ({ question }) => {
        await Bun.sleep(question === "slow" ? 20 : 1);
        return { answer: `answer:${question}` };
      },
    });

    const [slow, fast] = await Promise.all([
      tool.invoke({ description: "ask slow", question: "slow" }),
      tool.invoke({ description: "ask fast", question: "fast" }),
    ]);

    expect(slow).toEqual({ answer: "answer:slow" });
    expect(fast).toEqual({ answer: "answer:fast" });
  });
});
```

目标文件：`src/coding/agents/__tests__/coding-agent.test.ts`

<details>
<summary>展开完整代码：<code>coding-agent.test.ts</code></summary>

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

import { defineCodingAgent } from "../coding-agent";

const FINAL: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "done" }],
};
const USER: UserMessage = {
  role: "user",
  content: [{ type: "text", text: "inspect" }],
};

class RecordingProvider implements ModelProvider {
  params?: ModelProviderInvokeParams;

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.params = params;
    return FINAL;
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.params = params;
    yield FINAL;
  }
}

let workspace: string | undefined;

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
});

async function runFixture(options: { guidance?: string; max?: number }) {
  workspace = await mkdtemp(join(tmpdir(), "harness-agent-"));
  if (options.guidance !== undefined) {
    await writeFile(join(workspace, "AGENTS.md"), options.guidance, "utf8");
  }
  const provider = new RecordingProvider();
  const warnings: string[] = [];
  const agent = await defineCodingAgent({
    model: new Model({ name: "recording", provider }),
    cwd: workspace,
    maxGuidanceCharacters: options.max,
    onWarning: (warning) => warnings.push(warning),
  });
  for await (const _event of agent.stream(USER)) {
    // consume
  }
  return { provider, warnings };
}

describe("defineCodingAgent", () => {
  test("loads project guidance and composes the coding toolset", async () => {
    const { provider } = await runFixture({ guidance: "Always run tests." });
    expect(JSON.stringify(provider.params?.messages[0])).toContain("Always run tests.");
    expect(provider.params?.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "todo_write", "ask_user_question"]),
    );
  });

  test("runs without AGENTS.md and warns when guidance exceeds its limit", async () => {
    expect((await runFixture({})).warnings).toEqual([]);
    expect((await runFixture({ guidance: "123456", max: 4 })).warnings.join("\n"))
      .toContain("AGENTS.md");
  });
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test src/agent/skills src/agent/todos src/coding/agents src/coding/tools/__tests__/ask-user-question.test.ts
```

### 阶段后对照

- `src/coding/agents/lead-agent.ts`
- `src/agent/skills/`
- `src/agent/todos/`
- `src/coding/tools/ask-user-question.ts`

### 验收

- [ ] Coding Agent 通过 composition 构造；
- [ ] 通用 Agent 不 import coding layer；
- [ ] Skill 完整内容按需加载；
- [ ] Todo 状态可独立测试；
- [ ] `AGENTS.md` 有 size guard；
- [ ] `ADR-010` 区分 project guidance、Skill、Todo 和 transcript。

## 阶段 10：CLI/TUI、模型配置与 Human-in-the-loop

> 上一阶段回顾：阶段 9 组装了 Coding Agent，并接入项目指令、渐进式 Skills、Todo 和 `ask_user_question` Tool。

### 本阶段目标

把 runtime 变成真正可用的终端产品，同时建立人工审批边界。完成后打 `v0.1.0` tag，表示基础复刻结束。

创建新增目录和主要文件：

```bash
mkdir -p src/cli/config/__tests__ src/cli/tui/components src/cli/tui/hooks src/cli/tui/__tests__
mkdir -p src/coding/permissions/__tests__ docs
touch src/cli/config/schema.ts src/cli/config/model-factory.ts src/cli/config/index.ts
touch src/cli/config/__tests__/schema.test.ts
touch src/cli/tui/app.tsx src/cli/tui/state.ts src/cli/tui/token-usage.ts
touch src/cli/tui/__tests__/state.test.ts src/cli/tui/__tests__/token-usage.test.ts
touch src/coding/permissions/approval-middleware.ts src/coding/permissions/index.ts
touch src/coding/permissions/__tests__/approval-middleware.test.ts docs/manual-test.md
```

### 10.1 安装交互依赖

```bash
bun add commander ink react yaml
bun add -d @types/react eslint typescript-eslint
```

把 ESLint 加入 `bun run check`。不要在这一阶段做全仓库风格重构，只约束新增项目。

### 10.2 配置模型

目标文件：`src/cli/config/schema.ts`

定义可校验的 YAML：

```yaml
defaultModel: local-openai
models:
  local-openai:
    provider: openai
    model: your-model-name
    baseURL: https://example.com/v1
    apiKeyEnv: OPENAI_API_KEY
    options:
      temperature: 0
```

定义解析后的内部类型和配置解析函数：

```ts
export type ModelProviderName = "openai" | "anthropic";

export interface ModelConfig {
  provider: ModelProviderName;
  model: string;
  baseURL?: string;
  apiKeyEnv: string;
  options?: Record<string, unknown>;
}

export interface HarnessConfig {
  defaultModel: string;
  models: Record<string, ModelConfig>;
}

export function parseHarnessConfig(input: unknown): HarnessConfig {
  // TODO 1：用 Zod 校验完整 shape，并把 issue path 保留在错误信息中。
  // TODO 2：校验 defaultModel 是 models 的真实 key；不要在这里读取环境变量值。
  throw new Error("TODO: implement parseHarnessConfig");
}

export function resolveDefaultModel(config: HarnessConfig): ModelConfig {
  // TODO 3：返回 config.models[config.defaultModel]；缺失时抛出包含名称的配置错误。
  throw new Error("TODO: implement resolveDefaultModel");
}
```

原则：

- 配置只保存环境变量名，不保存 secret value；
- schema validation error 显示完整字段路径；
- default model 必须真实存在；
- provider factory 只在 composition root 创建 SDK client。

至少支持：

```bash
harness-lab config model list
harness-lab config model add
harness-lab config model remove <name>
harness-lab config model set-default <name>
```

### 10.3 最小 TUI 状态

目标文件：`src/cli/tui/state.ts`

先实现状态，再做视觉：

<details>
<summary>展开完整代码：<code>state.ts</code></summary>

```ts
export interface AgentLoopViewState {
  messages: NonSystemMessage[];
  streaming: boolean;
  tokenUsage: {
    latestInputTokens: number;
    sessionTotalTokens: number;
  };
  pendingApproval?: ApprovalRequest;
  todos: TodoItem[];
}

export interface SlashCommand {
  name: "clear" | "help" | "exit";
  args: string[];
}

export type AgentLoopEvent =
  | AgentEvent
  | { type: "run_start" }
  | { type: "run_end"; status?: "completed" | "failed" | "aborted" }
  | { type: "approval_requested"; request: ApprovalRequest };

export function initialAgentLoopViewState(): AgentLoopViewState {
  // 标准实现示例：每次返回新对象，测试之间不共享数组引用。
  return {
    messages: [],
    streaming: false,
    tokenUsage: { latestInputTokens: 0, sessionTotalTokens: 0 },
    todos: [],
  };
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
  // TODO 1：非 slash input 返回 undefined；只接受 clear/help/exit。
  // TODO 2：按空白拆分 args；未知 slash command 抛出包含原名称的错误。
  throw new Error("TODO: implement parseSlashCommand");
}

export function reduceAgentEvent(
  state: AgentLoopViewState,
  event: AgentLoopEvent,
): AgentLoopViewState {
  // TODO 3：以 immutable reducer 更新 messages/streaming/approval/tokenUsage/todos。
  // 提示：run_end（包括 aborted）必须复位 streaming，不能修改传入 state。
  throw new Error("TODO: implement reduceAgentEvent");
}
```

</details>

UI 通过消费 `AgentEvent` 更新状态。不要让 UI 读取 `Agent` 私有字段或重新调用模型。

最低组件：

- `MessageHistory`；
- `InputBox`；
- `StreamingIndicator`；
- `Footer`：model、最新 input token、session total；
- `TodoPanel`；
- `ApprovalPrompt`；
- `AskUserQuestionPrompt`。

支持：

- Enter 提交；
- Ctrl+C 中止当前 run，再次 Ctrl+C 退出；
- `/clear`、`/help`、`/exit`；
- 模型输出期间禁止重复提交；
- 普通 API error 渲染为 assistant error message，不使 TUI 崩溃。

### 10.4 审批 Middleware

基础版本按 Tool 风险分类：

目标文件：`src/coding/permissions/approval-middleware.ts`

```ts
const TOOLS_REQUIRING_APPROVAL = [
  "bash",
  "write_file",
  "str_replace",
  "apply_patch",
  "mkdir",
  "move_path",
] as const;
```

决策：

```ts
export type ApprovalDecision =
  | "allow_once"
  | "allow_always_project"
  | "deny";

export interface ApprovalRequest {
  id: string;
  toolName: string;
  toolUse: ToolUseContent;
}

export interface ApprovalPersistence {
  has(projectId: string, toolName: string): Promise<boolean>;
  add(projectId: string, toolName: string): Promise<void>;
}

export function defineApprovalMiddleware(options: {
  projectId: string;
  maxQueueLength: number;
  requestDecision(request: ApprovalRequest): Promise<ApprovalDecision>;
  persistence?: ApprovalPersistence;
  onWarning?: (message: string) => void;
}): AgentMiddleware {
  // TODO 1：构造有限长 FIFO queue；同一时间最多展示一个 request。
  // TODO 2：实现只读直通、project allowlist、deny skip 和 fail-closed overflow。
  // TODO 3：持久化失败调用 onWarning，但不撤销本次已批准动作。
  throw new Error("TODO: implement defineApprovalMiddleware");
}
```

`beforeToolUse` 行为：

1. 只读 Tool 直接通过；
2. 项目 allowlist 已包含 Tool 时通过；
3. 否则排队展示审批；
4. deny 返回 `__skip` result，让模型看到拒绝；
5. `allow_always_project` 持久化 Tool name；
6. persistence failure 不应把已批准动作变成未知状态，但必须记录 warning。

审批队列要有限长，溢出时 fail closed。并发 Tool calls 不能同时覆盖一个全局 prompt。

阶段 13 会把“按 Tool name”升级为 command/path/network-aware policy；本阶段不要提前实现复杂 DSL。

### 10.5 Token usage

目标文件：`src/cli/tui/token-usage.ts`

只从 assistant message 的 provider-reported usage 聚合：

```ts
export function calculateTokenUsage(messages: NonSystemMessage[]) {
  const assistantWithUsage = messages.filter(
    (message) => message.role === "assistant" && message.usage,
  );

  // 标准实现示例：session total 是所有已报告 totalTokens 的和。
  const sessionTotalTokens = assistantWithUsage.reduce(
    (sum, message) => sum + (message.usage?.totalTokens ?? 0),
    0,
  );

  // TODO：latestInputTokens 读取最后一条有 usage 的 promptTokens；没有时为 0。
  return { latestInputTokens: 0, sessionTotalTokens };
}
```

它是观测值，不是 context window 的精确 tokenizer。阶段 13 会另建 token estimator/budget。

### 运行与观察

```bash
bun run dev
```

手工验收脚本：

1. 输入普通问候，观察 streaming 和 token；
2. 请求读取文件，确认无审批；
3. 请求修改文件，选择 deny，确认模型收到拒绝；
4. 再请求修改，选择 allow once；
5. 运行慢 command，按 Ctrl+C，确认子进程结束；
6. 使用 `/clear`，确认 UI 和 Agent transcript 同时清空；
7. 重启后验证 `allow_always_project`。

把这套步骤写成 `docs/manual-test.md`，阶段 15 录制演示时直接复用。

### 10.6 完整自动化测试

UI 像素和颜色不用过度测试，固定配置、审批与状态转换即可。以下文件均为完整内容，
复制后读者只运行测试，不修改断言。

目标文件：`src/cli/config/__tests__/schema.test.ts`

<details>
<summary>展开完整代码：<code>schema.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { parseHarnessConfig, resolveDefaultModel } from "../schema";

describe("model config", () => {
  test("parses a valid model without resolving the secret value", () => {
    const config = parseHarnessConfig({
      defaultModel: "local",
      models: {
        local: {
          provider: "openai",
          model: "test-model",
          apiKeyEnv: "OPENAI_API_KEY",
          options: { temperature: 0 },
        },
      },
    });

    expect(resolveDefaultModel(config)).toMatchObject({
      provider: "openai",
      model: "test-model",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(JSON.stringify(config)).not.toContain(process.env.OPENAI_API_KEY ?? "never-a-secret");
  });

  test("reports the full path for invalid fields", () => {
    expect(() => parseHarnessConfig({
      defaultModel: "local",
      models: { local: { provider: "unknown" } },
    })).toThrow("models.local");
  });

  test("rejects a missing default model", () => {
    expect(() => parseHarnessConfig({
      defaultModel: "missing",
      models: {
        local: { provider: "openai", model: "test-model", apiKeyEnv: "OPENAI_API_KEY" },
      },
    })).toThrow("defaultModel");
  });
});
```

</details>

目标文件：`src/cli/tui/__tests__/token-usage.test.ts`

<details>
<summary>展开完整代码：<code>token-usage.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { NonSystemMessage } from "@/foundation/messages";

import { calculateTokenUsage } from "../token-usage";

describe("calculateTokenUsage", () => {
  test("uses the latest reported prompt tokens and sums session totals", () => {
    const messages: NonSystemMessage[] = [
      { role: "user", content: [{ type: "text", text: "one" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      },
      { role: "assistant", content: [{ type: "text", text: "no usage" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "latest" }],
        usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
      },
    ];

    expect(calculateTokenUsage(messages)).toEqual({
      latestInputTokens: 20,
      sessionTotalTokens: 35,
    });
  });

  test("returns zero values without provider usage", () => {
    expect(calculateTokenUsage([])).toEqual({ latestInputTokens: 0, sessionTotalTokens: 0 });
  });
});
```

</details>

目标文件：`src/coding/permissions/__tests__/approval-middleware.test.ts`

<details>
<summary>展开完整代码：<code>approval-middleware.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { defineApprovalMiddleware } from "../approval-middleware";

function toolUse(id: string, name = "write_file") {
  return { type: "tool_use" as const, id, name, input: { path: "a.ts", content: "x" } };
}

describe("approval middleware", () => {
  test("lets read-only tools pass without requesting approval", async () => {
    let requests = 0;
    const middleware = defineApprovalMiddleware({
      projectId: "fixture",
      maxQueueLength: 2,
      requestDecision: async () => {
        requests += 1;
        return "deny";
      },
    });

    expect(await middleware.beforeToolUse?.({ toolUse: toolUse("read", "read_file") } as never))
      .toBeUndefined();
    expect(requests).toBe(0);
  });

  test("serves concurrent approval requests in FIFO order", async () => {
    const requested: string[] = [];
    const middleware = defineApprovalMiddleware({
      projectId: "fixture",
      maxQueueLength: 3,
      requestDecision: async ({ toolUse }) => {
        requested.push(toolUse.id);
        await Bun.sleep(1);
        return "allow_once";
      },
    });

    await Promise.all([
      middleware.beforeToolUse?.({ toolUse: toolUse("a") } as never),
      middleware.beforeToolUse?.({ toolUse: toolUse("b") } as never),
      middleware.beforeToolUse?.({ toolUse: toolUse("c") } as never),
    ]);
    expect(requested).toEqual(["a", "b", "c"]);
  });

  test("fails closed on overflow and turns deny into a skip result", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const middleware = defineApprovalMiddleware({
      projectId: "fixture",
      maxQueueLength: 1,
      requestDecision: async () => {
        await blocked;
        return "deny";
      },
    });

    const first = middleware.beforeToolUse?.({ toolUse: toolUse("a") } as never);
    const overflow = await middleware.beforeToolUse?.({ toolUse: toolUse("b") } as never);
    expect(overflow).toMatchObject({ __skip: true, result: { code: "APPROVAL_QUEUE_FULL" } });
    release();
    expect(await first).toMatchObject({ __skip: true, result: { code: "USER_DENIED" } });
  });

  test("persists and reuses allow_always_project", async () => {
    const saved: string[] = [];
    let requests = 0;
    const middleware = defineApprovalMiddleware({
      projectId: "fixture",
      maxQueueLength: 2,
      persistence: {
        has: async (_projectId, toolName) => saved.includes(toolName),
        add: async (_projectId, toolName) => void saved.push(toolName),
      },
      requestDecision: async () => {
        requests += 1;
        return "allow_always_project";
      },
    });

    await middleware.beforeToolUse?.({ toolUse: toolUse("a") } as never);
    await middleware.beforeToolUse?.({ toolUse: toolUse("b") } as never);
    expect(saved).toEqual(["write_file"]);
    expect(requests).toBe(1);
  });
});
```

</details>

目标文件：`src/cli/tui/__tests__/state.test.ts`

<details>
<summary>展开完整代码：<code>state.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { initialAgentLoopViewState, parseSlashCommand, reduceAgentEvent } from "../state";

describe("TUI state", () => {
  test("parses only supported slash commands", () => {
    expect(parseSlashCommand("/clear")).toEqual({ name: "clear", args: [] });
    expect(parseSlashCommand("/help topic")).toEqual({ name: "help", args: ["topic"] });
    expect(parseSlashCommand("hello")).toBeUndefined();
    expect(() => parseSlashCommand("/unknown")).toThrow("unknown");
  });

  test("reduces messages, streaming and approval events", () => {
    const started = reduceAgentEvent(initialAgentLoopViewState(), { type: "run_start" } as never);
    const messaged = reduceAgentEvent(started, {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    } as never);
    const approval = reduceAgentEvent(messaged, {
      type: "approval_requested",
      request: { id: "approval-1", toolName: "write_file" },
    } as never);
    const ended = reduceAgentEvent(approval, { type: "run_end" } as never);

    expect(started.streaming).toBe(true);
    expect(messaged.messages).toHaveLength(1);
    expect(approval.pendingApproval).toMatchObject({ id: "approval-1" });
    expect(ended.streaming).toBe(false);
  });

  test("can start a new run after abort", () => {
    const aborted = reduceAgentEvent(
      reduceAgentEvent(initialAgentLoopViewState(), { type: "run_start" } as never),
      { type: "run_end", status: "aborted" } as never,
    );
    expect(reduceAgentEvent(aborted, { type: "run_start" } as never).streaming).toBe(true);
  });
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test src/cli src/coding/permissions
```

### 阶段后对照

- `src/cli/`
- `src/cli/tui/hooks/use-agent-loop.ts`
- `src/cli/tui/components/`
- `src/cli/config/` 和 `src/cli/settings/`
- `src/coding/permissions/`

### 基础复刻总验收

- [ ] `bun run check` 全部通过；
- [ ] scripted/offline demo 始终可运行；
- [ ] 有 key 时真实 provider 可用；
- [ ] read-only 与 mutating Tool 审批行为不同；
- [ ] abort 能结束模型请求和子进程；
- [ ] Skills、Todo、`AGENTS.md` 在 TUI 可观察；
- [ ] 配置不保存 secret；
- [ ] `ADR-011` 解释 Human-in-the-loop 的 fail-open/fail-closed 选择；
- [ ] 创建 `v0.1.0` tag。

## 第三部分复盘

在进入进阶扩展前，画出一次真实请求的调用链并标注类型转换点：

```text
TUI input
→ UserMessage
→ AgentContext
→ ModelContext
→ provider wire request
→ provider chunks
→ AssistantMessage
→ ToolUseContent
→ approval
→ ToolRegistry
→ ToolResultContent
→ next ModelContext
→ final AssistantMessage
→ TUI state
```

你必须能指出：

- 哪些数据是 canonical state；
- 哪些只是单次请求 view；
- 哪些是外部副作用；
- 哪些信息适合写入 trace；
- 异常中断时最少要保存什么才能恢复。

最后一个问题正是下一部分的起点。
