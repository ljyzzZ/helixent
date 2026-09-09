# 第三部分：Coding Agent 与交互客户端

这一部分完成阶段 7～10。阶段 10 结束时，你会得到一个实现了基础 coding 能力的 v1 coding agent：能接真实模型、读写代码、加载项目指令和 Skills、管理 Todo、流式交互，并在副作用 Tool 前请求人工审批。

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

### 7.0 阅读路线

先完成 OpenAI，再独立实现 Anthropic，最后按需接入真实 API。下面四个里程碑与正文顺序
一致；每个实现后面紧跟对应测试和运行命令，读完并通过当前检查后，再进入下一节。

| 里程碑 | 对应章节 | 本次完成什么 | 可以停止并检查的证据 |
|---|---|---|---|
| 7A | [7.1 OpenAI 非流式调用](#stage-7a) | 消息与 Tool schema 转换、`invoke` | converter tests、fake client test |
| 7B | [7.2 OpenAI streaming](#stage-7b) | 累计 snapshot、Tool JSON fragments、`stream` | accumulator tests、fake stream test |
| 7C | [7.3 Anthropic Adapter](#stage-7c) | 在独立章节复用同一 canonical 契约 | Anthropic converter、accumulator、fake client tests |
| 7D | [7.4 真实 API 验证](#stage-7d) | 配置 endpoint 并观察真实响应 | 可选 smoke example，不替代离线测试 |

先画出 `Message[] → request → SDK response → AssistantMessage`，每次只实现一个箭头。
7A～7C 均不需要 API key；只运行当前小节列出的测试，7C 完成后再运行两个 Provider 的完整测试。

### 7.1 OpenAI：消息转换与 invoke（7A） {#stage-7a}

这一节先跑通 `Message[] → OpenAI request → SDK response → AssistantMessage` 的非流式路径。
所有工作都在 `src/community/openai/` 内完成。

#### 7.1.1 安装 SDK 并创建文件

```bash
bun add openai
mkdir -p src/community/openai/__tests__
touch src/community/openai/utils.ts src/community/openai/model-provider.ts
touch src/community/openai/index.ts
touch src/community/openai/__tests__/utils.test.ts
touch src/community/openai/__tests__/model-provider.test.ts
```

执行后目录应为：

```text
src/community/openai/
├── utils.ts                       # canonical 与 OpenAI wire types 的转换
├── model-provider.ts              # 先实现 invoke，保留 stream 接口
├── index.ts                       # 导出 OpenAIModelProvider
└── __tests__/
    ├── utils.test.ts              # 消息转换测试
    └── model-provider.test.ts     # fake client 请求与响应测试
```

#### 7.1.2 实现纯转换函数，并运行转换测试

Agent 使用统一的 `Message` 类型记录对话，OpenAI SDK 则使用自己的请求与响应格式。
这一节用三个纯函数连接两种协议：

| 函数 | 输入 | 输出 |
|---|---|---|
| `convertToOpenAIMessages` | canonical `Message[]` | SDK 请求中的消息数组 |
| `convertToOpenAITools` | `Tool[]` | SDK 的 function Tool definitions |
| `parseOpenAIAssistantMessage` | SDK assistant response 与 usage | canonical `AssistantMessage` |

本节基于 OpenAI Chat Completions 实现消息转换，并支持 `reasoning_content` 扩展。
assistant 的正文、思考内容和工具调用分别映射到 `content`、`reasoning_content` 和
`tool_calls`，转换时保持原始对话记录不变。

以下对两个特殊字段作出说明：

- `reasoning_content` 是第三方扩展字段，DeepSeek 和 Qwen 等思考模式都使用它。
  本节适配为：接收时解析为 canonical `thinking`，流式调用时累积片段，发送历史消息时写回该字段。

  这是厂商扩展字段，不属于 OpenAI 官方 Chat Completions 协议，因此 SDK 的标准类型中没有对应声明。本节通过扩展类型补充声明，实际是否支持由所接入的 endpoint 决定。

  真实接入时需核对具体 endpoint、模型和模式的历史回传规则。参见 [Qwen 深度思考](https://www.alibabacloud.com/help/zh/model-studio/deep-thinking) 和 [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)。
- 而在 SDK 的字段中有一个 `refusal` 字段是 OpenAI 官方的拒绝答复字段，非流式响应使用 `message.refusal`，流式响应使用
  `delta.refusal`。本项目暂未适配；当响应只有 refusal、没有正文和工具调用时，
  当前转换会得到空的 content 数组，读者可自行增加拒绝文本的保存与展示。
  参见 [Chat Completions 响应](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
  和 [流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。

目标文件：`src/community/openai/utils.ts`

从已给出的 `system` 分支开始，按 TODO 完成其余转换。`convertToOpenAITools()` 提供完整
实现；`assertNever` 用于穷尽检查，新增消息或内容类型时会提示尚未处理的分支。

<details>
<summary>展开完整代码：<code>utils.ts</code></summary>

```ts
import OpenAI from "openai";

import type { AssistantMessage, Message, TokenUsage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

interface OpenAIReasoningFields {
  reasoning_content?: string | null;
}

export type OpenAIAssistantMessageParam =
  OpenAI.ChatCompletionAssistantMessageParam & OpenAIReasoningFields;

export type OpenAIChatCompletionMessageParam =
  OpenAI.ChatCompletionMessageParam | OpenAIAssistantMessageParam;

export type OpenAIChatCompletionMessage =
  OpenAI.ChatCompletionMessage & OpenAIReasoningFields;

function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

export function convertToOpenAIMessages(
  messages: Message[],
): OpenAIChatCompletionMessageParam[] {
  const result: OpenAIChatCompletionMessageParam[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        // system 文本合并为一个请求字段。
        result.push({ role: "system", content: message.content.map((item) => item.text).join("\n") });
        break;
      case "user":
        result.push({
          role: "user",
          content: message.content.map((item): OpenAI.ChatCompletionContentPart => {
            // TODO 1：逐项构造新的 content block，保留数组顺序。
            switch (item.type) {
              case "text":
                // 保留 type 和 text。
                throw new Error("TODO: convert user text");
              case "image_url":
                // 保留 type、image_url.url 和可选 detail。
                throw new Error("TODO: convert user image");
              default:
                return assertNever(item);
            }
          }),
        });
        break;
      case "assistant": {
        const converted: OpenAIAssistantMessageParam = { role: "assistant", content: [] };
        for (const item of message.content) {
          switch (item.type) {
            case "text":
              // TODO 2：正文写入 converted.content，保留文本顺序。
              throw new Error("TODO: convert assistant text");
            case "thinking":
              // TODO 3：将 item.thinking 赋给 converted.reasoning_content。
              throw new Error("TODO: preserve historical reasoning_content");
            case "tool_use":
              // TODO 4：追加到 converted.tool_calls，type 为 function，保留 id/name；
              // function.arguments 使用 JSON.stringify(item.input)。
              throw new Error("TODO: convert assistant tool call");
            default:
              assertNever(item);
          }
        }
        result.push(converted);
        break;
      }
      case "tool":
        // TODO 5：为每个 Tool result 生成一条 wire tool message，
        // 使用 tool_call_id=tool_use_id 关联调用。
        throw new Error("TODO: convert tool results");
      default:
        assertNever(message);
    }
  }
  return result;
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
  message: OpenAIChatCompletionMessage,
  usage?: TokenUsage,
): AssistantMessage {
  // TODO 6：reasoning_content 为字符串时先添加 thinking block，保持其原文。
  // TODO 7：仅在 content 为字符串时添加 text block，包括空字符串。
  // TODO 8：tool_calls arguments 用 JSON.parse；最终仍非法时抛出带 call id 的转换错误。
  // TODO 9：原样传递 usage，缺省时保留 undefined。
  throw new Error("TODO: implement parseOpenAIAssistantMessage");
}
```

</details>

转换函数只根据输入构造结果，保持原始消息不变。使用下面的固定输入验证转换结果。

**对应测试**

目标文件：`src/community/openai/__tests__/utils.test.ts`

将下面的完整测试保存到该文件。测试中的 `as never` 用于适配省略了无关 SDK 字段的 fixture。

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
  test("preserves user text/image block order, URLs and optional image detail", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be concise" }] },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect the first image" },
          {
            type: "image_url",
            image_url: { url: "https://example.test/a.png", detail: "high" },
          },
          { type: "text", text: "then compare the second image" },
          { type: "image_url", image_url: { url: "https://example.test/b.png" } },
        ],
      },
    ];
    const originalMessages = structuredClone(messages);

    expect(convertToOpenAIMessages(messages)).toEqual([
      { role: "system", content: "Be concise" },
      {
        role: "user",
        content: [
          { type: "text", text: "inspect the first image" },
          {
            type: "image_url",
            image_url: { url: "https://example.test/a.png", detail: "high" },
          },
          { type: "text", text: "then compare the second image" },
          { type: "image_url", image_url: { url: "https://example.test/b.png" } },
        ],
      },
    ]);
    expect(messages).toEqual(originalMessages);
  });

  test("does not turn assistant thinking into visible text and preserves tool calls", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private plan: inspect the file first" },
          { type: "text", text: "I will inspect the file" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const originalMessages = structuredClone(messages);
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    const assistant = result[0];
    if (assistant?.role !== "assistant") {
      throw new Error("Expected an assistant message");
    }

    // SDK accepts either a string or text blocks; neither may contain thinking.
    const visibleText = typeof assistant.content === "string"
      ? assistant.content
      : (assistant.content ?? [])
          .map((part) => part.type === "text" ? part.text : "")
          .join("");

    expect(visibleText).toBe("I will inspect the file");
    expect(assistant.tool_calls).toEqual([
      {
        type: "function",
        id: "call-1",
        function: { name: "read_file", arguments: '{"path":"a.ts"}' },
      },
    ]);
    expect(messages).toEqual(originalMessages);
  });

  test("preserves historical thinking in the reasoning_content field", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "inspect first" },
          { type: "text", text: "I will inspect the file" },
          { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
        ],
      },
    ];
    const originalMessages = structuredClone(messages);
    const result = convertToOpenAIMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: "assistant",
      reasoning_content: "inspect first",
      tool_calls: [
        { id: "call-1", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
      ],
    });
    expect(messages).toEqual(originalMessages);
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

  test("does not create an empty text block for null content with a tool call", () => {
    const result = parseOpenAIAssistantMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          type: "function",
          id: "call-1",
          function: { name: "read_file", arguments: '{"path":"a.ts"}' },
        },
      ],
    } as never);

    expect(result.content).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
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

完成实现后，运行转换测试：

```bash
bun test src/community/openai/__tests__/utils.test.ts
```

测试通过后，进入下一节，将这些转换函数接入 `Provider.invoke`。

#### 7.1.3 实现 Provider.invoke，并用 fake client 验证

目标文件：`src/community/openai/model-provider.ts`

上一节的转换函数只处理数据格式。本节把它们与 SDK 调用连接起来，让 `invoke` 接收一次
模型调用的参数，发出请求，再返回 canonical `AssistantMessage`。

调用链是 `Model.invoke(context) → provider.invoke(params)`。`Model` 会把模型名称、
模型 options 和本轮上下文整理为 `ModelProviderInvokeParams`：

| 参数 | 来源与用途 |
|---|---|
| `model` | `Model.name`，指定 endpoint 上要调用的模型 |
| `messages` | `Model` 将 prompt（如果有）和对话历史组成的 canonical 消息数组 |
| `tools` | 本轮允许模型选择的工具，由上下文提供；可省略 |
| `options` | 创建 `Model` 时传入的模型参数，如 `temperature`、`max_tokens` |
| `signal` | 本轮上下文的取消信号，用来中止正在进行的请求；可省略 |

下面是项目的组织方式：`_baseChatCompletionParams` 构造请求体，`toTokenUsage` 转换
用量字段，`invoke` 负责串起整个流程。两个辅助函数提供完整实现，按三个 TODO 完成 `invoke`。

```ts
import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources";

import type { AssistantMessage, TokenUsage } from "@/foundation/messages";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

import {
  convertToOpenAIMessages,
  convertToOpenAITools,
  parseOpenAIAssistantMessage,
} from "./utils";

function toTokenUsage(usage?: {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}): TokenUsage | undefined {
  if (!usage) return undefined;
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}

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
    // TODO 1：调用 this._baseChatCompletionParams(params)，得到 SDK 请求体 request。
    // TODO 2：await this._client.chat.completions.create(request, { signal: params.signal })，
    // 将完整 SDK 响应保存为 response。
    // TODO 3：将 response.choices[0]!.message 和 toTokenUsage(response.usage)
    // 传给 parseOpenAIAssistantMessage，并返回转换结果。
    throw new Error("TODO: implement OpenAIModelProvider.invoke");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // 7A 先保留接口；7B 再接入 StreamAccumulator 并实现累计 snapshot。
    throw new Error("TODO: implement OpenAIModelProvider.stream in 7B");
  }

  private _baseChatCompletionParams({
    model,
    messages,
    tools,
    options,
  }: ModelProviderInvokeParams): ChatCompletionCreateParamsNonStreaming {
    return {
      model,
      messages: convertToOpenAIMessages(messages),
      tools: tools ? convertToOpenAITools(tools) : undefined,
      temperature: 0,
      ...options,
    };
  }
}
```

先看 TODO 1。`_baseChatCompletionParams` 是类内部的辅助方法，参数中的
`{ model, messages, tools, options }` 是对象解构，从传入的 `params` 中取出这些字段。
方法里的 `return` 返回 SDK 请求体，因此只构造数据，不会发送请求。各字段的处理方式如下：

- `model` 原样传入，告诉 endpoint 使用哪个模型。
- `messages` 调用上一节的 `convertToOpenAIMessages`，将 canonical 消息转成 SDK 格式。
- `tools` 有传入时调用 `convertToOpenAITools`，生成工具名称、描述和参数 schema；未传入时
  保持 `undefined`。这里传递工具定义，工具的实际执行仍由 Agent 负责。
- `temperature: 0` 保留默认模型参数。末尾的 `...options` 将调用方传入的参数展开
  到同一个对象中；同名字段以后面的值为准。例如 `options` 中设置 `temperature: 0.6`，
  最终请求就使用 `0.6`；其他字段也按原项目的方式原样合并。

TODO 2 才发出请求。`this._client` 是构造函数中保存的 SDK client，已经持有 `baseURL`
和 `apiKey`。SDK 按 API 资源组织入口，`chat.completions.create` 可以逐层理解：

| 层级 | 含义 |
|---|---|
| `chat` | client 上的聊天 API 分组 |
| `completions` | 该分组下负责根据对话消息生成模型回复的资源 |
| `create(...)` | 向这个资源提交一次生成请求 |

前两层是对象属性，真正调用的方法是末尾的 `create()`。本项目每轮都会提交 `messages`
和可选的 `tools`，让模型生成下一条回复或工具调用；这正是 Chat Completions API 的职责，
因此使用 SDK 中对应的入口。`create` 底层发出 `POST /chat/completions`；使用官方
`baseURL` 时，请求地址是 `https://api.openai.com/v1/chat/completions`，配置兼容服务的
`baseURL` 时则发往该服务。参见 [Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

可以在编辑器中对 `create` 使用“转到定义”，沿着参数类型和返回类型阅读 SDK。
本小节关注 `ChatCompletionCreateParamsNonStreaming`：它描述非流式请求体，
对应的返回值经过 `await` 后是 `ChatCompletion`，其中包含下一步要处理的 `choices` 和 `usage`。

`chat.completions.create` 的第一个参数是上一步的请求体，第二个参数是 SDK
的请求控制选项。把 `params.signal` 放在第二个参数中，调用方取消操作时，SDK 就能中止请求；
它不属于模型要读取的 JSON 数据。`await` 等待这次非流式调用完成，得到完整响应。

这里的 `params.options` 用于设置模型参数，与构造函数中的连接配置、SDK 第二个参数中的
请求控制选项用途不同。API key 由 SDK 用于鉴权，不应写入消息、日志或测试 snapshot。

最后完成 TODO 3。SDK 响应中的 `choices` 保存候选回复；本项目取第一项的 `message`，
交给 `parseOpenAIAssistantMessage`，继续使用上一节已经实现的正文、thinking 和工具调用解析。
代码中的 `!` 是 TypeScript 非空断言：这里沿用项目取首项回复的约定，它本身不做运行时校验。

`usage` 位于 SDK 响应的顶层，需要先经 `toTokenUsage` 转成 canonical 字段：
`prompt_tokens → promptTokens`、`completion_tokens → completionTokens`、
`total_tokens → totalTokens`。整个 `usage` 缺省时保留 `undefined`；存在时，个别缺省字段按
原项目取 `0`。把转换后的 usage 作为解析函数的第二个参数，`invoke` 最终就能返回同时包含
消息内容与用量的 `AssistantMessage`。

本小节只完成 `invoke`。`stream` 保留显式报错的占位实现，进入 7B 后再补齐；
`index.ts` 导出 `OpenAIModelProvider`。

**对应测试**

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

SDK `create` 的第二个参数承载 `signal`；不要把 signal 混进 JSON request body。
测试通过构造函数注入 fake client，不创建真实 SDK client，也不需要 API key。

```bash
bun test src/community/openai/__tests__/model-provider.test.ts
```

**7A 完成检查**：转换测试和 fake client test 通过，`invoke` 返回 canonical
`AssistantMessage`，调用方 options 能覆盖默认值，`signal` 已透传到 SDK。

### 7.2 OpenAI：streaming 与 Tool 参数片段（7B） {#stage-7b}

在已通过测试的 OpenAI 非流式路径上增加 streaming。本节继续只修改 OpenAI adapter。

```bash
touch src/community/openai/stream-accumulator.ts
touch src/community/openai/__tests__/stream-accumulator.test.ts
```

#### 7.2.1 实现 StreamAccumulator，并验证累计状态

目标文件：`src/community/openai/stream-accumulator.ts`

定义 provider-local accumulator。文本 delta 分支是标准实现示例；thinking、Tool fragment
和 usage 分别保留为独立 TODO，每个 Tool call 按 index 分别累计参数。

`_toolCalls` 保存拼接中的 `argumentsText`，而 `ToolUseContent` 要求解析后的 `input`。
在 `snapshot()` 中完成这次转换：先加入非空 thinking、正文，再按 Tool call index 从小到大
加入工具调用。`AssistantMessageContent` 本身就是数组类型，可以逐个 `push` 内容块；
不能只给内部记录补上 `type`，也不要把整个工具数组作为一个元素加入 `content`。

参数可能分多次到达，例如 `'{"path":"/tmp/'` 和 `'demo"}'`。沿用原项目的处理方式：
没有收到 usage 时，暂不输出 JSON 尚不能解析的工具调用，但其他已完整的调用仍可输出；
参数拼接完整后，下一次快照就能包含它。收到 usage 后，仍解析失败的调用以 `input: {}`
兜底。本实现以 usage 是否存在判断这一阶段，不以 token 数量是否大于零判断；
这依赖下一节请求末尾用量的约定，未收到 usage 时不会仅因调用 `snapshot()` 而进入兜底。

<details>
<summary>展开完整代码：<code>stream-accumulator.ts</code></summary>

```ts
import type { AssistantMessage, AssistantMessageContent, TokenUsage } from "@/foundation/messages";

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
    const content: AssistantMessageContent = [];
    // TODO 4：按 thinking、text、Tool call 的顺序构造 content，省略空文本块。
    // 提示：Map 的插入顺序不等于 index 顺序；排序时需要保留 entries() 中的 index。
    // TODO 5：将 argumentsText 解析为 input，显式构造 tool_use 内容块。
    // 提示：解析失败时，未收到 usage 则跳过该调用，收到 usage 后才以 {} 兜底。
    // TODO 6：返回独立快照；内容块、嵌套 input 和 usage 都不能暴露内部可变引用。
    throw new Error("TODO: implement StreamAccumulator.snapshot");
  }
}
```

</details>

这里的 `ProviderChunk` 是 OpenAI adapter 内部的 normalized chunk。`index` 在一次响应内
稳定，`argumentsDelta` 按同一 Tool call index 拼接，usage 只在 provider 明确报告时出现。
SDK chunk 到这个类型的转换留在 `model-provider.ts`，不要让 SDK type 进入 Agent。

**对应测试**

目标文件：`src/community/openai/__tests__/stream-accumulator.test.ts`

<details>
<summary>展开完整代码：<code>stream-accumulator.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { AssistantMessageContent, ToolUseContent } from "@/foundation/messages";

import { StreamAccumulator } from "../stream-accumulator";

describe("OpenAI StreamAccumulator", () => {
  test("omits empty content and leaves absent usage undefined", () => {
    const accumulator = new StreamAccumulator();
    expect(accumulator.snapshot().content).toEqual([]);
    accumulator.push({});
    accumulator.push({ textDelta: "", thinkingDelta: "" });

    expect(accumulator.snapshot().role).toBe("assistant");
    expect(accumulator.snapshot().content).toEqual([]);
    expect(accumulator.snapshot().usage).toBeUndefined();
  });

  test("accumulates thinking and emits thinking before text and tools", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      textDelta: "answer",
      thinkingDelta: "think",
      toolCall: { index: 0, id: "a", name: "read_file", argumentsDelta: "{}" },
    });
    const first = accumulator.snapshot();
    accumulator.push({ thinkingDelta: " more", textDelta: "!" });

    expect(first.content).toEqual([
      { type: "thinking", thinking: "think" },
      { type: "text", text: "answer" },
      { type: "tool_use", id: "a", name: "read_file", input: {} },
    ]);
    expect(accumulator.snapshot().content).toEqual([
      { type: "thinking", thinking: "think more" },
      { type: "text", text: "answer!" },
      { type: "tool_use", id: "a", name: "read_file", input: {} },
    ]);
  });

  test("accumulates text and usage into independent snapshots", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ textDelta: "hel" });
    const first = accumulator.snapshot();
    accumulator.push({ textDelta: "lo" });
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });

    expect(first.content).toEqual([{ type: "text", text: "hel" }]);
    expect(accumulator.snapshot()).toMatchObject({
      content: [{ type: "text", text: "hello" }],
      usage: { totalTokens: 5 },
    });
  });

  test("joins fragmented JSON without mixing concurrent tool calls", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      toolCall: { index: 10, id: "a", name: "read_file", argumentsDelta: '{"path":"b' },
    });
    accumulator.push({
      toolCall: { index: 2, id: "z", name: "read_file", argumentsDelta: '{"path":"/tmp/' },
    });
    accumulator.push({ toolCall: { index: 10, argumentsDelta: '.ts"}' } });
    accumulator.push({ toolCall: { index: 2, argumentsDelta: 'demo","line":1}' } });

    expect(accumulator.snapshot().content).toEqual([
      {
        type: "tool_use",
        id: "z",
        name: "read_file",
        input: { path: "/tmp/demo", line: 1 },
      },
      { type: "tool_use", id: "a", name: "read_file", input: { path: "b.ts" } },
    ]);
  });

  test("does not expose mutable accumulator state", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ textDelta: "safe" });
    const snapshot = accumulator.snapshot();
    snapshot.content.splice(0);

    expect(accumulator.snapshot().content).toEqual([{ type: "text", text: "safe" }]);
  });

  test("withholds only incomplete calls and exposes them once JSON is complete", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      toolCall: { index: 1, id: "b", name: "read_file", argumentsDelta: '{"path":"b.ts"}' },
    });
    accumulator.push({
      toolCall: { index: 0, id: "a", name: "read_file", argumentsDelta: '{"path":"/tmp/' },
    });
    const partial = accumulator.snapshot();
    expect(partial.content).toEqual([
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
    expect(accumulator.snapshot().content).toEqual(partial.content);

    accumulator.push({ toolCall: { index: 0, argumentsDelta: 'demo"}' } });
    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "a", name: "read_file", input: { path: "/tmp/demo" } },
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
    expect(partial.content).toEqual([
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ]);
    expect(accumulator.snapshot().usage).toBeUndefined();
  });

  test("falls back only for invalid arguments after receiving usage, including zero usage", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ toolCall: { index: 2, id: "empty", name: "read_file" } });
    accumulator.push({
      toolCall: { index: 1, id: "broken", name: "read_file", argumentsDelta: '{"path":' },
    });
    accumulator.push({
      toolCall: { index: 0, id: "valid", name: "read_file", argumentsDelta: '{"path":"a.ts"}' },
    });
    const valid: ToolUseContent = { type: "tool_use", id: "valid", name: "read_file", input: { path: "a.ts" } };
    expect(accumulator.snapshot().content).toEqual([valid]);

    accumulator.push({ usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    expect(accumulator.snapshot().content).toEqual([
      valid,
      { type: "tool_use", id: "broken", name: "read_file", input: {} },
      { type: "tool_use", id: "empty", name: "read_file", input: {} },
    ]);
    expect(accumulator.snapshot().usage).toEqual({
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
    });
  });

  test("merges metadata arriving after arguments and preserves it across later fragments", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ toolCall: { index: 3, argumentsDelta: '{"path":' } });
    accumulator.push({ toolCall: { index: 3, id: "a", name: "read_file" } });
    accumulator.push({ toolCall: { index: 3, id: "a", name: "read_file", argumentsDelta: '"a.ts"}' } });
    accumulator.push({ toolCall: { index: 3, argumentsDelta: "" } });

    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  test("replaces usage when reported and preserves it when a chunk omits it", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } });
    const first = accumulator.snapshot();
    accumulator.push({ usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
    accumulator.push({});

    expect(first.usage).toEqual({ promptTokens: 3, completionTokens: 1, totalTokens: 4 });
    expect(accumulator.snapshot().usage).toEqual({
      promptTokens: 3, completionTokens: 2, totalTokens: 5,
    });
  });

  test("isolates content objects, nested tool input and usage between snapshots", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({
      thinkingDelta: "think",
      textDelta: "safe",
      toolCall: {
        index: 0, id: "a", name: "read_file",
        argumentsDelta: '{"options":{"paths":["a.ts"]}}',
      },
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
    const first = accumulator.snapshot();
    const second = accumulator.snapshot();
    for (const item of first.content) {
      if (item.type === "thinking") item.thinking = "changed";
      if (item.type === "text") item.text = "changed";
      if (item.type === "tool_use") {
        item.id = "changed";
        item.name = "changed";
        const options = item.input.options as { paths: string[] };
        options.paths.push("changed.ts");
      }
    }
    first.usage!.totalTokens = 999;

    const expectedContent: AssistantMessageContent = [
      { type: "thinking", thinking: "think" },
      { type: "text", text: "safe" },
      { type: "tool_use", id: "a", name: "read_file", input: { options: { paths: ["a.ts"] } } },
    ];
    expect(second.content).toEqual(expectedContent);
    expect(accumulator.snapshot().content).toEqual(expectedContent);
    expect(second.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(accumulator.snapshot().usage).toEqual(second.usage);
  });
});
```

</details>

```bash
bun test src/community/openai/__tests__/stream-accumulator.test.ts
```

通过后应能观察到：thinking、正文和工具调用按约定顺序累计；交错的 Tool call 不串线；
未完成参数在中途快照中暂不出现，收到 usage 后才对仍非法的参数兜底；修改旧 snapshot
的内容块、嵌套参数或 usage，不会影响其他快照和后续输出。

#### 7.2.2 接入 Provider.stream，并用 fake stream 验证

目标文件：`src/community/openai/model-provider.ts`。

这里的 `stream` 是本项目的 `ModelProvider` 方法，底层仍调用 SDK 的
`chat.completions.create`。非流式与流式都向同一个 API 提交对话并生成回复，区别在于
服务端如何返回结果。设置 `stream: true` 后，服务端通过 SSE（Server-Sent Events）
在一次响应中持续发送生成片段，SDK 负责把这些网络事件解析成 chunk 对象。

| 调用方式 | 请求中的 `stream` | `await create(...)` 后得到什么 |
|---|---|---|
| 非流式 | 省略或 `false` | 一份完整的 `ChatCompletion`，读取 `choices[0].message` |
| 流式 | `true` | `Stream<ChatCompletionChunk>`，通过 `for await...of` 逐个读取 chunk |

流式路径中的 `await` 得到的是可异步迭代的流对象。之后的 `for await...of` 才持续等待并
读取后续片段，每次循环消费同一次请求的数据。chunk 中通常是本次新增的 `delta`，而项目
要求每次对外输出累计的 `AssistantMessage`，因此还需要上一节的 accumulator 保存状态。
协议结构见 [Chat Completions 流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)。

实现前，可以按以下顺序查看相关定义：

1. SDK 的 `chat.completions.create` 重载：关注 `ChatCompletionCreateParamsStreaming` 中
   的 `stream: true`，以及返回类型中的 `Stream<ChatCompletionChunk>`。
2. SDK 的 `Stream`：它实现 `AsyncIterable`，所以能被 `for await...of` 消费。阅读
   `[Symbol.asyncIterator]` 可了解迭代入口；本项目直接使用这个能力即可。
3. SDK 的 `ChatCompletionChunk`：重点看 `choices[0]?.delta.content`、`delta.tool_calls`
   和顶层 `usage`。工具参数也可能分片到达，需要按 call index 累积；`reasoning_content`
   沿用 7.1.2 的厂商扩展声明。
4. 本项目的 `StreamAccumulator.push` 与 `snapshot`：前者把新增片段写入累计状态，后者
   构造当前完整消息。`yield` 是生成器语法，用来把 snapshot 交给调用 `provider.stream()`
   的上层消费；它本身不负责请求模型或合并片段。

理解这条数据流后，补齐 7A 留下的 `stream` 方法：

1. 复用 `invoke` 的请求转换，调用 `chat.completions.create` 时设置 `stream: true`，
   并通过第二个参数传入 `signal`。原项目同时设置 `stream_options: { include_usage: true }`，
   请求服务端在流结束前单独报告本次调用的用量。
2. 为每次调用创建独立的 `StreamAccumulator`，通过 `for await...of` 读取 SDK 返回的流。
   把 chunk 中的 text、thinking、Tool
   fragments 和 usage 转成 `ProviderChunk`，依次 `push`。
3. 每次 `yield` 返回累计 snapshot。即使 chunk 的 `choices` 为空，也要处理其中的 usage。
4. 最终 Tool input 沿用 7.2.1 的处理规则：收到 usage 后，仍无法解析的参数以 `{}` 兜底。
   这是原项目流式路径的现有行为，与非流式转换中解析失败时抛错的处理不同。

`include_usage` 对应的末尾 chunk 可以没有候选回复，只携带用量数据，所以处理 usage
不能依赖 `choices[0]` 存在。若流被中断，末尾用量可能不会到达；只有收到服务端报告后才更新
累计 usage。参见 [stream_options 定义](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。

**对应测试**

目标文件：`src/community/openai/__tests__/model-provider.test.ts`。保留 7A 的测试，
在文件末尾追加下面的完整用例；沿用已有的 `test` 和 `OpenAIModelProvider` imports。

```ts
test("streams cumulative snapshots and keeps usage-only chunks", async () => {
  let request: Record<string, unknown> | undefined;
  let sdkSignal: AbortSignal | undefined;
  const client = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
          request = body;
          sdkSignal = options.signal;
          return (async function* () {
            yield { choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }] };
            yield { choices: [{ index: 0, delta: { content: "lo" } }] };
            yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
            yield {
              choices: [],
              usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
            };
          })();
        },
      },
    },
  };
  const controller = new AbortController();
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    signal: controller.signal,
  })) {
    snapshots.push(snapshot);
  }

  expect(request).toMatchObject({ model: "test-model", stream: true });
  expect(sdkSignal).toBe(controller.signal);
  expect(snapshots[0]?.content).toEqual([{ type: "text", text: "hel" }]);
  expect(snapshots.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  });
});
```

```bash
bun test src/community/openai
```

**7B 完成检查**：OpenAI converter、accumulator 和 Provider tests 全部通过；非流式路径
仍正常，streaming 能输出独立的累计 snapshot，并保留末尾单独报告的 usage。到这里再开始第二个 Provider。

### 7.3 Anthropic：独立实现第二个 Adapter（7C） {#stage-7c}

本章集中完成 Anthropic 的安装、转换、streaming 和 Provider 验证。复用的是
`ModelProvider` 与 canonical `Message` 契约，转换函数和 accumulator 都放在独立的
`src/community/anthropic/` 目录中。

#### 7.3.1 安装 SDK 并创建文件

```bash
bun add @anthropic-ai/sdk
mkdir -p src/community/anthropic/__tests__
touch src/community/anthropic/utils.ts src/community/anthropic/stream-accumulator.ts
touch src/community/anthropic/model-provider.ts src/community/anthropic/index.ts
touch src/community/anthropic/__tests__/utils.test.ts
touch src/community/anthropic/__tests__/stream-accumulator.test.ts
touch src/community/anthropic/__tests__/model-provider.test.ts
```

执行后新增目录为：

```text
src/community/anthropic/
├── utils.ts                       # system、消息、Tool schema 与响应转换
├── stream-accumulator.ts           # 按 block index 累积事件
├── model-provider.ts              # 实现 invoke 与 stream
├── index.ts                       # 导出 AnthropicModelProvider
└── __tests__/
    ├── utils.test.ts              # Anthropic 协议转换测试
    ├── stream-accumulator.test.ts  # 内容顺序、thinking 签名与 usage 测试
    └── model-provider.test.ts     # fake client 请求与响应测试
```

#### 7.3.2 实现纯转换函数，并运行转换测试

目标文件：`src/community/anthropic/utils.ts`

Anthropic 的 `thinking` block 包含 `thinking` 文本和不透明的 `signature`。在 thinking
伴随 Tool use 的对话中，返回 Tool result 时必须一并回传之前完整、未修改的 thinking block。
即使文本为空，也要保留其签名。协议说明见 [Anthropic Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)。

本节用 adapter 内部的 `_anthropicSignature` 保存签名，发送请求时还原为 SDK 的 `signature`。
它随 canonical thinking block 保存在对话记录中，不需要修改 foundation 的类型。
下面给出签名转换的辅助函数，其余转换按 TODO 完成：

```ts
import Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, Message, ThinkingContent } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface AnthropicThinkingContent extends ThinkingContent {
  // 流式中间快照可能尚未收到签名。
  _anthropicSignature?: string;
}

function parseAnthropicThinking(block: Anthropic.ThinkingBlock): AnthropicThinkingContent {
  return { type: "thinking", thinking: block.thinking, _anthropicSignature: block.signature };
}

function convertToAnthropicThinking(item: ThinkingContent): Anthropic.ThinkingBlockParam {
  const signature = (item as AnthropicThinkingContent)._anthropicSignature;
  if (typeof signature !== "string" || signature.length === 0) {
    throw new Error("MISSING_THINKING_SIGNATURE: cannot replay an unsigned thinking block");
  }
  return { type: "thinking", thinking: item.thinking, signature };
}

export function extractSystemPrompt(messages: Message[]): string | undefined {
  // TODO 1：只收集 system text，并用两个换行连接；没有 system 时返回 undefined。
  // 参数规则：不得修改 messages，也不得把非 system 内容混入 prompt。
  throw new Error("TODO: implement extractSystemPrompt");
}

export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  // TODO 2：排除 system message，并把 Tool result 转成 user-role content。
  // 参数规则：保持原始消息及 content block 顺序，不修改 canonical messages。
  // assistant thinking 分支调用 convertToAnthropicThinking，保留空 thinking 文本。
  throw new Error("TODO: implement convertToAnthropicMessages");
}

export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  // TODO 3：使用 input_schema，不要复用 OpenAI wire type。
  throw new Error("TODO: implement convertToAnthropicTools");
}

export function parseAnthropicAssistantMessage(message: Anthropic.Message): AssistantMessage {
  // TODO 4：解析 text、thinking、tool_use，并原样保存 Tool id 和 provider usage。
  // thinking 分支调用 parseAnthropicThinking，将文本和签名一起存入 content。
  throw new Error("TODO: implement parseAnthropicAssistantMessage");
}
```

这些函数必须是纯函数。先用固定 fixture 测完，再调用 SDK。

**对应测试**

目标文件：`src/community/anthropic/__tests__/utils.test.ts`

<details>
<summary>展开完整代码：<code>utils.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";

import type { Message } from "@/foundation/messages";

import type { AnthropicThinkingContent } from "../utils";
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

  test("round-trips thinking signatures and multiple tool calls without changing history", () => {
    const content: Anthropic.ContentBlockParam[] = [
      { type: "thinking", thinking: "plan", signature: "opaque-signature-a" },
      { type: "text", text: "running" },
      { type: "thinking", thinking: "verify", signature: "opaque-signature-b" },
      { type: "tool_use", id: "a", name: "read_file", input: { path: "a.ts" } },
      { type: "tool_use", id: "b", name: "read_file", input: { path: "b.ts" } },
    ];
    const response = {
      role: "assistant", content, usage: { input_tokens: 8, output_tokens: 5 },
    };
    const originalResponse = structuredClone(response);
    const assistant = parseAnthropicAssistantMessage(response as never);
    const messages: Message[] = [assistant, {
      role: "tool",
      content: [
        { type: "tool_result", tool_use_id: "a", content: "file A" },
        { type: "tool_result", tool_use_id: "b", content: "file B" },
      ],
    }];
    const originalMessages = structuredClone(messages);

    expect(convertToAnthropicMessages(messages)).toEqual([
      { role: "assistant", content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "a", content: "file A" },
          { type: "tool_result", tool_use_id: "b", content: "file B" },
        ],
      },
    ]);
    expect(response).toEqual(originalResponse);
    expect(messages).toEqual(originalMessages);
  });

  test("preserves signed thinking even when its text is empty", () => {
    const assistant = parseAnthropicAssistantMessage({
      role: "assistant",
      content: [{ type: "thinking", thinking: "", signature: "opaque-empty-signature" }],
      usage: { input_tokens: 1, output_tokens: 2 },
    } as never);

    const expected: AnthropicThinkingContent[] = [
      { type: "thinking", thinking: "", _anthropicSignature: "opaque-empty-signature" },
    ];
    expect(assistant.content).toEqual(expected);
    expect(convertToAnthropicMessages([assistant])).toEqual([
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "", signature: "opaque-empty-signature" }],
      },
    ]);
  });

  test("rejects replaying thinking without a signature", () => {
    expect(() => convertToAnthropicMessages([{
      role: "assistant",
      content: [{ type: "thinking", thinking: "plan" }],
    }])).toThrow("MISSING_THINKING_SIGNATURE");
  });

  test("keeps empty text blocks when parsing a response", () => {
    const result = parseAnthropicAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "" }],
      usage: { input_tokens: 1, output_tokens: 0 },
    } as never);

    expect(result.content).toEqual([{ type: "text", text: "" }]);
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
      { type: "thinking", thinking: "plan", _anthropicSignature: "signature" },
      { type: "text", text: "running" },
      { type: "tool_use", id: "a", input: { path: "a.ts" } },
    ]);
    expect(result.usage).toEqual({ promptTokens: 8, completionTokens: 5, totalTokens: 13 });
  });
});
```

</details>

```bash
bun test src/community/anthropic/__tests__/utils.test.ts
```

通过后应确认：system 从消息中单独提取；Tool result 转成 user-role content；
text、thinking、Tool id 与 usage 在转换中保留；thinking 的文本和签名可以完整回传。

#### 7.3.3 实现 StreamAccumulator，并运行事件累积测试

目标文件：`src/community/anthropic/stream-accumulator.ts`

Anthropic event 先转成以下固定 provider-local union，再进入同名 accumulator；不要让 SDK
event type 泄漏到 Agent：

```ts
import type { AssistantMessage } from "@/foundation/messages";

export type ProviderChunk =
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_start"; index: number; thinking: string; signature: string }
  | { type: "thinking_delta"; index: number; thinking: string }
  | { type: "signature_delta"; index: number; signature: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "input_json_delta"; index: number; partialJson: string }
  | { type: "message_start"; inputTokens: number }
  | { type: "message_end"; outputTokens: number };

export class StreamAccumulator {
  // TODO 1：按 block index 保存 text/thinking/tool 的独立累计状态，thinking 包含 signature。
  // TODO 2：分别保存 input/output usage，message_end 后产生完整 TokenUsage。

  push(chunk: ProviderChunk): void {
    // TODO 3：按 chunk.type 分派；同一 index 的 partialJson 只能追加到同一 Tool。
    // thinking_start 初始化文本和签名；thinking_delta 追加文本，signature_delta 更新签名。
    throw new Error("TODO: implement Anthropic StreamAccumulator.push");
  }

  snapshot(): AssistantMessage {
    // TODO 4：按 index 排序输出新 content 数组；不完整 Tool input 暂时使用 {}。
    // thinking 输出 AnthropicThinkingContent（从 ./utils 导入），用 _anthropicSignature 保存签名。
    // 保留文本为空的 thinking block；复制每个 block，后续 delta 不能改变旧 snapshot。
    throw new Error("TODO: implement Anthropic StreamAccumulator.snapshot");
  }
}
```

这里的 `index` 表示一次响应内的 content block index。`partialJson` 只能追加到同一
index 的 Tool；usage 只在 provider 明确报告时出现。SDK event 先在 `model-provider.ts`
中转换为上面的 union，再交给 accumulator。thinking block 在 start 时就要建立状态，
随后将 `signature_delta.signature` 原样赋给对应 block 的签名；签名不参与文本拼接。

**对应测试**

目标文件：`src/community/anthropic/__tests__/stream-accumulator.test.ts`

<details>
<summary>展开完整代码：<code>stream-accumulator.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { StreamAccumulator } from "../stream-accumulator";
import type { AnthropicThinkingContent } from "../utils";

describe("Anthropic StreamAccumulator", () => {
  test("keeps block index order while accumulating deltas", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ index: 1, type: "text_delta", text: "answer" } as never);
    accumulator.push({ index: 0, type: "thinking_start", thinking: "", signature: "" });
    accumulator.push({ index: 0, type: "thinking_delta", thinking: "plan" } as never);
    accumulator.push({ index: 0, type: "signature_delta", signature: "opaque-signature" });
    accumulator.push({
      index: 2,
      type: "tool_start",
      id: "call-1",
      name: "read_file",
    } as never);
    accumulator.push({ index: 2, type: "input_json_delta", partialJson: '{"path"' } as never);
    accumulator.push({ index: 2, type: "input_json_delta", partialJson: ':"a.ts"}' } as never);

    const thinking: AnthropicThinkingContent = {
      type: "thinking", thinking: "plan", _anthropicSignature: "opaque-signature",
    };
    expect(accumulator.snapshot().content).toEqual([
      thinking,
      { type: "text", text: "answer" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
  });

  test("keeps signatures on their own blocks and leaves earlier snapshots unchanged", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ type: "thinking_start", index: 0, thinking: "first", signature: "" });
    const first = accumulator.snapshot();
    const originalFirst = structuredClone(first);
    accumulator.push({ type: "signature_delta", index: 0, signature: "opaque-a" });
    accumulator.push({ type: "thinking_start", index: 2, thinking: "second", signature: "opaque-b" });
    accumulator.push({ type: "thinking_delta", index: 2, thinking: " plan" });

    const final = accumulator.snapshot();
    const expected: AnthropicThinkingContent[] = [
      { type: "thinking", thinking: "first", _anthropicSignature: "opaque-a" },
      { type: "thinking", thinking: "second plan", _anthropicSignature: "opaque-b" },
    ];
    expect(final.content).toEqual(expected);
    expect(first).toEqual(originalFirst);
    const originalFinal = structuredClone(final);
    const thinking = final.content[0];
    if (thinking?.type !== "thinking") throw new Error("Expected thinking");
    thinking.thinking = "changed by caller";
    expect(accumulator.snapshot()).toEqual(originalFinal);
  });

  test("keeps a signature-only thinking block without thinking deltas", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ type: "thinking_start", index: 0, thinking: "", signature: "" });
    accumulator.push({ type: "signature_delta", index: 0, signature: "opaque-empty-signature" });

    const expected: AnthropicThinkingContent[] = [
      { type: "thinking", thinking: "", _anthropicSignature: "opaque-empty-signature" },
    ];
    expect(accumulator.snapshot().content).toEqual(expected);
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

```bash
bun test src/community/anthropic/__tests__/stream-accumulator.test.ts
```

通过后应确认：thinking、text 和 Tool 按 block index 输出，JSON fragments 正确拼接，
签名保存在所属 thinking block，旧 snapshot 保持不变，输入与输出 tokens 合并为 canonical `TokenUsage`。

#### 7.3.4 实现 Provider.invoke，并用 fake client 验证

目标文件：`src/community/anthropic/model-provider.ts`

```ts
import Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage } from "@/foundation/messages";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

export class AnthropicModelProvider implements ModelProvider {
  private readonly _client: Anthropic;

  constructor(options: { baseURL?: string; apiKey?: string; client?: Anthropic } = {}) {
    this._client = options.client ?? new Anthropic({
      baseURL: options.baseURL,
      apiKey: options.apiKey,
    });
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    // TODO 1：提取 system，转换 messages/tools，并设置 max_tokens 默认值。
    // TODO 2：合并调用方 options，调用 messages.create，第二个参数透传 signal。
    // TODO 3：用 parseAnthropicAssistantMessage 将响应和 usage 转回 canonical 消息。
    throw new Error("TODO: implement AnthropicModelProvider.invoke");
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // TODO 4：复用请求转换，设置 stream=true，并透传 signal。
    // TODO 5：把 SDK events 转成 ProviderChunk，逐个 push，再 yield 累计 snapshot。
    // thinking 的 content_block_start 与 signature_delta 都要转发，保留对应 index。
    // TODO 6：流结束时校验 Tool JSON 完整性，保留最终 usage。
    throw new Error("TODO: implement AnthropicModelProvider.stream");
  }
}
```

请求中 `system` 与 `messages` 分开传入，Tool schema 使用 `input_schema`；
`max_tokens` 可先默认设为 `8192`，再由调用方 `options` 覆盖。`signal` 放在 SDK
`messages.create` 的第二个参数中。通过构造函数注入 fake client，测试无需 key。

先实现 `invoke` 并通过下面的测试，再连接本章已验证的 accumulator 实现 `stream`。
`index.ts` 导出 `AnthropicModelProvider`，API key 不进入日志、trace 或测试 snapshot。

**对应测试**

目标文件：`src/community/anthropic/__tests__/model-provider.test.ts`

<details>
<summary>展开完整代码：<code>model-provider.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { AnthropicModelProvider } from "../model-provider";

describe("AnthropicModelProvider", () => {
  test("separates system and passes caller options and signal to the SDK", async () => {
    let request: Record<string, unknown> | undefined;
    let sdkSignal: AbortSignal | undefined;
    const client = {
      messages: {
        create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
          request = body;
          sdkSignal = options.signal;
          return {
            id: "message-1",
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 3, output_tokens: 1 },
          };
        },
      },
    };
    const controller = new AbortController();
    const provider = new AnthropicModelProvider({ client: client as never });

    const result = await provider.invoke({
      model: "test-model",
      messages: [
        { role: "system", content: [{ type: "text", text: "Be concise" }] },
        { role: "user", content: [{ type: "text", text: "hello" }] },
      ],
      options: { max_tokens: 256 },
      signal: controller.signal,
    });

    expect(request).toMatchObject({
      model: "test-model",
      system: "Be concise",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      max_tokens: 256,
    });
    expect(request).not.toHaveProperty("signal");
    expect(sdkSignal).toBe(controller.signal);
    expect(result).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
    });
  });
});
```

</details>

```bash
bun test src/community/anthropic/__tests__/model-provider.test.ts
```

#### 7.3.5 接入 Provider.stream，并用 fake stream 验证

目标文件：`src/community/anthropic/model-provider.ts`。现在补齐 `stream`，把 SDK 的
text/thinking delta、thinking/Tool block start、signature delta、JSON delta 和 usage
事件转换为本章的 `ProviderChunk`。每次调用使用独立 accumulator；最终 Tool JSON 非法时
抛出带 call id 的错误。流中暂时不完整的 input 可以是 `{}`，最终结果不能静默保留这个占位值。

**对应测试**

目标文件：`src/community/anthropic/__tests__/model-provider.test.ts`。保留上一小节的测试，
在文件末尾追加下面的完整用例；沿用已有的 `test` 和 `AnthropicModelProvider` imports。

<details>
<summary>展开追加用例：Anthropic fake stream</summary>

```ts
test("streams signed thinking and replays it with tool results", async () => {
  let request: Record<string, unknown> | undefined;
  let sdkSignal: AbortSignal | undefined;
  const client = {
    messages: {
      create: async (body: Record<string, unknown>, options: { signal?: AbortSignal }) => {
        request = body;
        sdkSignal = options.signal;
        if (!body.stream) {
          return {
            id: "message-2", type: "message", role: "assistant", model: "test-model",
            content: [{ type: "text", text: "done" }], stop_reason: "end_turn", stop_sequence: null,
            usage: { input_tokens: 5, output_tokens: 1 },
          };
        }
        return (async function* () {
          yield {
            type: "message_start",
            message: {
              id: "message-1", type: "message", role: "assistant", model: "test-model",
              content: [], stop_reason: null, stop_sequence: null,
              usage: { input_tokens: 3, output_tokens: 0 },
            },
          };
          yield {
            type: "content_block_start", index: 0,
            content_block: { type: "thinking", thinking: "", signature: "" },
          };
          yield {
            type: "content_block_delta", index: 0,
            delta: { type: "thinking_delta", thinking: "plan" },
          };
          yield {
            type: "content_block_delta", index: 0,
            delta: { type: "signature_delta", signature: "opaque-stream-signature" },
          };
          yield { type: "content_block_stop", index: 0 };
          yield {
            type: "content_block_start", index: 1,
            content_block: { type: "text", text: "" },
          };
          yield {
            type: "content_block_delta", index: 1,
            delta: { type: "text_delta", text: "hel" },
          };
          yield {
            type: "content_block_delta", index: 1,
            delta: { type: "text_delta", text: "lo" },
          };
          yield { type: "content_block_stop", index: 1 };
          yield {
            type: "content_block_start", index: 2,
            content_block: { type: "tool_use", id: "call-1", name: "read_file", input: {} },
          };
          yield {
            type: "content_block_delta", index: 2,
            delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
          };
          yield { type: "content_block_stop", index: 2 };
          yield {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 2 },
          };
          yield { type: "message_stop" };
        })();
      },
    },
  };
  const controller = new AbortController();
  const provider = new AnthropicModelProvider({ client: client as never });
  const snapshots = [];
  const options = { thinking: { type: "enabled", budget_tokens: 1024 } };

  for await (const snapshot of provider.stream({
    model: "test-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    options,
    signal: controller.signal,
  })) {
    snapshots.push(snapshot);
  }

  expect(request).toMatchObject({ model: "test-model", stream: true, ...options });
  expect(sdkSignal).toBe(controller.signal);
  expect(snapshots.some((snapshot) =>
    snapshot.content.some((item) => item.type === "text" && item.text === "hel"),
  )).toBe(true);
  const final = snapshots.at(-1);
  if (!final) throw new Error("Expected a final snapshot");
  expect(final).toMatchObject({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "plan", _anthropicSignature: "opaque-stream-signature" },
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  });

  await provider.invoke({
    model: "test-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      final,
      { role: "tool", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file A" }] },
    ],
    options,
  });
  expect(request?.messages).toEqual([
    { role: "user", content: [{ type: "text", text: "hello" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "opaque-stream-signature" },
        { type: "text", text: "hello" },
        { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "file A" }] },
  ]);
});
```

</details>

用例中的 SDK `message_delta.usage.output_tokens` 应映射到 normalized `message_end`；
`message_stop` 自身没有 usage，不能因此把已累计的 tokens 清零。
fake signature 只验证字段传递；真实请求中的签名必须来自 API 响应。流式快照可以暂缺签名，
回传历史消息时应使用已收齐签名的最终结果。

完成本章后运行：

```bash
bun test src/community/anthropic
```

**7C 完成检查**：Anthropic converter、accumulator 和 fake client tests 通过；
`invoke` 和 `stream` 都返回 canonical `AssistantMessage`，Agent 无需分支判断厂商。
此时两个 Adapter 的实现都已完成，可以进入可选联网验证，也可以直接执行 7.5 的完整检查。

### 7.4 真实 API 验证（7D，可选） {#stage-7d}

前面的小节用 fake client 和固定 fixtures 验证契约。现在才接入真实 endpoint，观察
SDK、鉴权、模型配置与 streaming 是否能一起工作。没有 API key 可以跳过本节。

#### 7.4.1 创建真实模型示例

```bash
mkdir -p examples
touch examples/stage-07-real-model.ts
```

示例通过参数选择 Provider；因为同时导入两个 Adapter，请先完成 7C。

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

#### 7.4.2 运行与观察

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

**7D 完成检查（可选）**：配置有效 key 后，所选 Provider 能返回真实回答，并打印
canonical message、provider 报告的 token usage 与耗时。网络或鉴权失败在本节排查，
不把联网请求加入核心测试套件。

### 7.5 完整测试与阶段验收

两个 Provider 的实现和各自测试完成后，统一执行：

```bash
bun test src/community/openai src/community/anthropic
bun run check
```

这里汇总前面已运行的离线测试，不再引入新的测试文件，也不依赖 7D 的真实 API 配置。

#### 阶段后对照

- `src/community/openai/model-provider.ts`
- `src/community/openai/utils.ts`
- `src/community/openai/stream-utils.ts`（练习项目将对应文件命名为 `stream-accumulator.ts`）
- `src/community/anthropic/model-provider.ts`
- `src/community/anthropic/utils.ts`
- `src/community/anthropic/stream-utils.ts`（练习项目将对应文件命名为 `stream-accumulator.ts`）

#### 验收

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

先按依赖跑通一条最小路径，再扩展到完整工具集：

| 小里程碑 | Tools | 完成后立即观察 |
|---|---|---|
| 8A | 路径校验 + `read_file` | 读取一份临时文件；范围和越界测试通过 |
| 8B | `str_replace` | 读出旧值 → 唯一替换 → 再读出新值；失败时文件不变 |
| 8C | `bash` | 执行 fixture 的检查命令；捕获输出、超时和运行中 abort |
| 8D | `file_info`、`list_files`、`glob_search`、`grep_search` | 搜索结果的路径、行号和截断状态正确 |
| 8E | `mkdir`、`write_file`、`apply_patch`、`move_path` | 在磁盘上检查新增、修改、移动结果 |

8A～8C 的 playground 直接 import 当前 Tool factory，只注册已实现的 Tool。8E 完成后才填充
8.5 的 `defineCodingTools()`，再运行依赖完整工具集的示例和 8.6 contract tests。这样未完成的
空文件不会阻塞第一个读写闭环。

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

执行后新增结构如下：

```text
src/coding/tools/                       # 受 workspace 边界约束的 Coding Tools
├── tool-utils.ts                       # 规范化路径并提供截断等共享辅助函数
├── tool-result.ts                      # 构造稳定、可序列化的 Tool result
├── file-info.ts                        # 查询文件或目录元数据
├── list-files.ts                       # 枚举目录内容
├── glob-search.ts                      # 按 glob 模式搜索路径
├── grep-search.ts                      # 按文本或正则搜索文件内容
├── read-file.ts                        # 按行范围读取文本文件
├── mkdir.ts                            # 在 workspace 内创建目录
├── write-file.ts                       # 创建或覆盖文本文件
├── str-replace.ts                      # 执行唯一、精确的字符串替换
├── apply-patch.ts                      # 应用 unified diff patch
├── move-path.ts                        # 移动或重命名文件与目录
├── bash.ts                             # 执行支持 timeout 与 abort 的子进程
├── index.ts                            # 组合并导出 Coding Tools
└── __tests__/
    ├── tool-utils.test.ts              # 验证路径穿越、符号链接等安全边界
    └── coding-tools.test.ts            # 验证各 Tool 的公开 contract
examples/
└── stage-08-coding-tools.ts            # 在临时 workspace 演示读写与 diff
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
import { resolve } from "node:path";

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
  throw new Error("TODO: implement resolveWorkspacePath");
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
import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { resolveWorkspacePath } from "./tool-utils";

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
      const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
      if (!resolved.ok) return { ...resolved, summary: resolved.error };

      // 标准路径：边界通过后才读取；不存在的文件是业务失败，不是路径越界。
      const file = Bun.file(resolved.path);
      if (!(await file.exists())) {
        return { ok: false, summary: "File not found", code: "FILE_NOT_FOUND", error: input.path };
      }
      // TODO 1：用 stat 检查普通文件；目录返回 NOT_A_FILE，其他 I/O 错误规范化。
      // TODO 2：读取 UTF-8 文本；把 text.split("\n") 的末尾空项排除出 lineCount，
      // 但无范围时必须返回原始 text，保留末尾换行。
      // TODO 3：有且仅有一个范围端点，或 start > end 时返回 INVALID_LINE_RANGE；
      // start 超过 lineCount 返回 START_LINE_OUT_OF_RANGE，end 越界返回 INVALID_LINE_RANGE。
      // TODO 4：范围输出固定为 `${lineNumber}: ${lineText}`，以换行连接。
      // TODO 5：maxCharacters 限制保留的正文字符数，超限追加 "\n[truncated]"；
      // 返回 { ok: true, summary, data: { path: resolved.path, content, truncated } }。
      throw new Error("TODO: implement read_file");
    },
  });
}
```

补齐 TODO 时再导入所选的 `stat` API。
先实现全文件读取，再补范围和截断，按 8.6 中的 `read_file` 用例逐个转绿。

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

在 `src/coding/tools/str-replace.ts` 的 `invoke` 中，按下面的骨架补齐。输入 schema 使用
`description/path/oldText/newText`，其中 `oldText` 必须非空，`newText` 可以为空：

```ts
// 此段位于 invoke 内；先完成路径校验、文件存在性检查和 signal 检查。
const matches = original.split(input.oldText).length - 1;
if (matches !== 1) {
  return {
    ok: false,
    summary: "Replacement requires exactly one match",
    error: `Found ${matches} matches`,
    code: matches === 0 ? "PATTERN_NOT_FOUND" : "AMBIGUOUS_REPLACEMENT",
  };
}
const updated = original.replace(input.oldText, () => input.newText);
// TODO：写入前再检查 signal，然后写 updated；成功后返回修改路径与 replacements: 1。
// 使用 callback 返回 newText，避免 $&、$1 等被 String.replace 当成替换表达式。
```

`original` 来自通过校验后的文件内容；0/多匹配分支必须发生在任何写入之前。
先在临时文件上手动跑通“读 → 替换 → 再读”，再测试失败时文件的字节内容保持不变。

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

本课程的 `bash` 示例面向 macOS/Linux。先实现普通命令，再增加下面这些资源所有权：

| 资源 | 创建位置 | 结束条件 |
|---|---|---|
| 子进程及进程组 | `Bun.spawn(["bash", "-c", command], { cwd, detached: true, ... })` | 正常退出，或 timeout/abort 后终止整个进程组 |
| stdout/stderr reader | spawn 后立即并发消费 | 读到 EOF；达到保留上限后继续 drain，丢弃多余正文 |
| timeout timer | spawn 后 | 所有退出路径 `clearTimeout` |
| abort listener | spawn 前检查，spawn 后注册并再检查一次 | `finally` 移除 |

在 `src/coding/tools/bash.ts` 的 `invoke` 中依次完成这些块：

```ts
// 这是 invoke 内的执行顺序骨架；变量和结果类型使用本文件的 Tool contract。
// TODO 1：若 signal.aborted，直接返回 structured ABORTED，不能 spawn。
// TODO 2：spawn 一个独立进程组，固定 cwd，同时开始读取 stdout 和 stderr。
// TODO 3：把结束原因保存为 "exit" | "timeout" | "abort"，第一次原因生效后不可覆盖。
// TODO 4：timeout/abort 先向进程组发 SIGTERM，宽限期后仍未退出则发 SIGKILL。
// POSIX 进程组使用 process.kill(-child.pid, signal)；ESRCH 表示已经退出，可忽略。
// TODO 5：等待 child.exited 和两个 reader 完成，再返回结果；finally 清理所有 timer/listener。
// TODO 6：成功 data 包含 stdout/stderr/exitCode/truncated；超时和 abort 使用不同 code。
```

只调用 `child.kill()` 可能留下 shell 启动的孙进程。8.6 会启动一个延迟写文件的孙进程，
检查取消后它没有继续产生副作用。不要用 `Promise.race` 返回超时后就丢弃仍在运行的进程。

### 8.5 组装 Coding Tools

目标文件：`src/coding/tools/index.ts`

用 `defineCodingTools()` 创建阶段 8 的全部 Tool：

```ts
import type { Tool } from "@/foundation/tools";

export interface DefineCodingToolsOptions {
  cwd: string;
  bashTimeoutMs?: number;
  maxOutputCharacters?: number;
  maxResults?: number;
}

export function defineCodingTools(options: DefineCodingToolsOptions): Tool[] {
  // TODO：构造并返回阶段 8 的全部 Tool；每个 filesystem Tool 共享 options.cwd。
  // 提示：只读 Tool 放前、修改型 Tool 放后，并保持数组顺序稳定供测试与 UI 使用。
  // bashTimeoutMs/maxOutputCharacters 只传给需要它们的 Tool，不能接受模型侧覆盖。
  throw new Error("TODO: implement defineCodingTools");
}
```

8D/8E 的输出字段固定如下，便于测试内容而不是只测试 `ok`：

| Tool | success `data` 的必要字段 |
|---|---|
| `file_info` | `path`（绝对路径）、`type`（`file`/`directory`）、`size` |
| `list_files` | `entries`（相对请求目录的名称，排序）、`truncated` |
| `glob_search` | `paths`（相对 cwd 的路径，排序）、`truncated` |
| `grep_search` | `matches: { path, line, text }[]`，path 相对 cwd、line 从 1 开始；`truncated` |
| `read_file` | `path`、`content`、`truncated` |
| 修改型 Tools | 被修改的路径；测试另从磁盘读取最终结果 |
| `bash` | `stdout`、`stderr`、`exitCode`、`truncated` |

`maxResults` 控制 list/glob/grep 的条数；`maxOutputCharacters` 转发为 read_file 的
`maxCharacters`，并控制 bash 保留的输出正文。上限由 composition 配置，不能由模型放大。

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
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

async function invoke(
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
  limits: { maxOutputCharacters?: number; maxResults?: number; bashTimeoutMs?: number } = {},
) {
  const tool = defineCodingTools({ cwd: workspace, bashTimeoutMs: 100, ...limits })
    .find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing test Tool: ${name}`);
  return tool.invoke({ description: `test ${name}`, ...input } as never, signal);
}

describe("read-only coding tools", () => {
  test("file_info, list_files, glob_search and grep_search expose bounded data", async () => {
    expect(await invoke("file_info", { path: "input.ts" })).toMatchObject({
      ok: true, data: { type: "file", size: new TextEncoder().encode("const value = 1;\n").length },
    });
    expect(await invoke("list_files", { path: "." })).toMatchObject({
      ok: true, data: { entries: ["input.ts"], truncated: false },
    });
    expect(await invoke("glob_search", { path: ".", pattern: "**/*.ts" }))
      .toMatchObject({ ok: true, data: { paths: ["input.ts"], truncated: false } });
    expect(await invoke("grep_search", { path: ".", pattern: "value" }))
      .toMatchObject({ ok: true, data: {
        matches: [{ path: "input.ts", line: 1, text: "const value = 1;" }], truncated: false,
      } });
    for (const name of ["file_info", "list_files", "glob_search", "grep_search"]) {
      expect(await invoke(name, { path: "missing", pattern: "value" }))
        .toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
    }
  });

  test("limits search results and marks truncated output", async () => {
    await writeFile(join(workspace, "second.ts"), "const value = 2;\n", "utf8");
    const limits = { maxResults: 1 };
    expect(await invoke("list_files", { path: "." }, undefined, limits))
      .toMatchObject({ data: { entries: ["input.ts"], truncated: true } });
    expect(await invoke("glob_search", { path: ".", pattern: "**/*.ts" }, undefined, limits))
      .toMatchObject({ data: { paths: ["input.ts"], truncated: true } });
    expect(await invoke("grep_search", { path: ".", pattern: "value" }, undefined, limits))
      .toMatchObject({ data: {
        matches: [{ path: "input.ts", line: 1, text: "const value = 1;" }], truncated: true,
      } });
  });

  test("read_file validates ranges and rejects traversal", async () => {
    expect(await invoke("read_file", { path: "input.ts", startLine: 1, endLine: 1 }))
      .toMatchObject({ ok: true, data: { content: "1: const value = 1;", truncated: false } });
    expect(await invoke("read_file", { path: "input.ts" }))
      .toMatchObject({ data: { content: "const value = 1;\n", truncated: false } });
    expect(await invoke("read_file", { path: "input.ts" }, undefined, { maxOutputCharacters: 5 }))
      .toMatchObject({ data: { content: "const\n[truncated]", truncated: true } });
    expect(await invoke("read_file", { path: "input.ts", startLine: 1 }))
      .toMatchObject({ ok: false, code: "INVALID_LINE_RANGE" });
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
    await expect(access(join(workspace, "src/a.ts"))).rejects.toBeDefined();
    expect(await invoke("move_path", { from: "missing.ts", to: "unused.ts" }))
      .toMatchObject({ ok: false, code: "FILE_NOT_FOUND" });
    expect(await invoke("write_file", { path: "../outside.ts", content: "bad" }))
      .toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
  });

  test("str_replace refuses zero and ambiguous matches", async () => {
    await writeFile(join(workspace, "input.ts"), "same\nsame\n", "utf8");

    expect(await invoke("str_replace", { path: "input.ts", oldText: "missing", newText: "x" }))
      .toMatchObject({ ok: false, code: "PATTERN_NOT_FOUND" });
    expect(await invoke("str_replace", { path: "input.ts", oldText: "same", newText: "x" }))
      .toMatchObject({ ok: false, code: "AMBIGUOUS_REPLACEMENT" });
    expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("same\nsame\n");
  });

  test("str_replace writes exactly the requested literal replacement", async () => {
    expect(await invoke("str_replace", { path: "input.ts", oldText: "1", newText: "$&" }))
      .toMatchObject({ ok: true });
    expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("const value = $&;\n");
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
    expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("const value = 2;\n");
    expect(await invoke("apply_patch", { patch: "not a patch" }))
      .toMatchObject({ ok: false, code: "PATCH_APPLY_FAILED" });
    expect(await readFile(join(workspace, "input.ts"), "utf8")).toBe("const value = 2;\n");
  });
});

describe("bash", () => {
  test("captures success and non-zero exit", async () => {
    expect(await invoke("bash", { command: "printf ok; printf err >&2" }))
      .toMatchObject({ ok: true, data: { stdout: "ok", stderr: "err", exitCode: 0 } });
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

  test("drains large process output while retaining only a bounded prefix", async () => {
    expect(await invoke("bash", { command: "printf '%1048576s' '' | tr ' ' x" }, undefined, {
      maxOutputCharacters: 8, bashTimeoutMs: 2000,
    })).toMatchObject({ ok: true, data: { stdout: "xxxxxxxx\n[truncated]", truncated: true } });
  });

  test("abort and timeout stop a running descendant before it writes", async () => {
    for (const reason of ["abort", "timeout"] as const) {
      const controller = new AbortController();
      const command = `touch ready-${reason}; (sleep 0.4; printf unexpected > late-${reason}) & wait`;
      const result = invoke("bash", { command }, controller.signal, { bashTimeoutMs: 200 });
      // 等真实进程启动，避免把运行中中止退化成 pre-aborted 测试。
      const deadline = performance.now() + 1000;
      while (!(await Bun.file(join(workspace, `ready-${reason}`)).exists())) {
        if (performance.now() > deadline) {
          controller.abort();
          await result;
          throw new Error("bash did not start within the test deadline");
        }
        await Bun.sleep(5);
      }
      if (reason === "abort") controller.abort();
      expect(await result).toMatchObject({
        ok: false, code: reason === "abort" ? "ABORTED" : "COMMAND_TIMED_OUT",
      });
      await Bun.sleep(450);
      expect(await Bun.file(join(workspace, `late-${reason}`)).exists()).toBe(false);
    }
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

执行后新增结构如下：

```text
src/
├── coding/
│   ├── agents/
│   │   ├── coding-agent.ts             # 组合 prompt、Tools 与 Middleware
│   │   ├── index.ts                    # 导出 Coding Agent 公共 API
│   │   └── __tests__/
│   │       └── coding-agent.test.ts    # 验证 composition root 与项目指令加载
│   └── tools/
│       ├── ask-user-question.ts        # 将关键信息缺口交还给用户确认
│       └── __tests__/
│           └── ask-user-question.test.ts # 验证提问 handler 的输入输出契约
└── agent/
    ├── skills/
    │   ├── skill-reader.ts             # 发现并解析 SKILL.md
    │   ├── skills-middleware.ts        # 将匹配的 Skill 指令注入 model view
    │   ├── index.ts                    # 导出 Skill 系统公共 API
    │   └── __tests__/
    │       └── skill-reader.test.ts    # 验证发现、解析和边界条件
    └── todos/
        ├── todo-system.ts              # 管理结构化任务列表与状态迁移
        ├── index.ts                    # 导出 Todo 系统公共 API
        └── __tests__/
            └── todo-system.test.ts     # 验证 Todo 状态不变量
examples/
└── stage-09-coding-agent.ts            # 演示带 Skills、Todo 与提问能力的 Agent
```

### 9.1 Coding Agent composition root

不要把 Coding 逻辑放回通用 `Agent`。

目标文件：`src/coding/agents/coding-agent.ts`

```ts
import { Agent } from "@/agent/agent";
import type { AgentMiddleware } from "@/agent/agent-middleware";
import type { Model } from "@/foundation/models";

import type { AskUserQuestionHandler } from "../tools/ask-user-question";

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
  throw new Error("TODO: implement defineCodingAgent");
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
  private readonly _reminderAfterSteps: number;
  private _items: TodoItem[] = [];
  private _lastUpdatedStep = 0;

  constructor(options: { reminderAfterSteps: number }) {
    this._reminderAfterSteps = options.reminderAfterSteps;
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

目标文件：`src/coding/tools/ask-user-question.ts`

```ts
import type { FunctionTool } from "@/foundation/tools";

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

本阶段再分四步，不要求第一次就写出七个组件：

| 小里程碑 | 范围 | 反馈 |
|---|---|---|
| 10A | 配置解析 + 文本客户端 | 输入一行，消费一次 Agent stream，显示结果 |
| 10B | reducer + 最小 Ink 界面 | 输入、忙碌提示、消息历史；沿用同一 Agent |
| 10C | 审批和 Ask user | 等待、允许、拒绝、取消都能结束；并发请求不会覆盖 |
| 10D | Todo、token、slash commands 和组件拆分 | 完成本节手工验收，最后执行完整 gate |

配置和文本客户端先独立运行，确认 provider、Tools、Agent 都正常之后再排查 React 状态。

创建新增目录和主要文件：

```bash
mkdir -p src/cli/config/__tests__ src/cli/tui/components src/cli/tui/hooks src/cli/tui/__tests__
mkdir -p src/coding/permissions/__tests__ docs
mkdir -p src/foundation/permissions
touch src/foundation/permissions/approval-decision.ts src/foundation/permissions/index.ts
touch src/cli/run-agent-turn.ts examples/stage-10-text-client.ts
touch src/cli/tui/hooks/use-agent-loop.ts
touch src/cli/config/schema.ts src/cli/config/model-factory.ts src/cli/config/index.ts
touch src/cli/config/__tests__/schema.test.ts
touch src/cli/tui/app.tsx src/cli/tui/state.ts src/cli/tui/token-usage.ts
touch src/cli/tui/__tests__/state.test.ts src/cli/tui/__tests__/token-usage.test.ts
touch src/coding/permissions/approval-middleware.ts src/coding/permissions/index.ts
touch src/coding/permissions/__tests__/approval-middleware.test.ts docs/manual-test.md
```

执行后新增结构如下：

```text
src/
├── foundation/permissions/
│   ├── approval-decision.ts            # 通用审批决策类型
│   └── index.ts                        # 导出通用权限契约
├── cli/
│   ├── run-agent-turn.ts               # 消费一轮 Agent stream，供文本与 Ink 共用
│   ├── config/
│   │   ├── schema.ts                   # 校验模型、Provider 与运行参数配置
│   │   ├── model-factory.ts            # 根据配置实例化对应 ModelProvider
│   │   ├── index.ts                    # 导出配置层公共 API
│   │   └── __tests__/
│   │       └── schema.test.ts          # 验证默认值、非法配置与 secret 引用
│   └── tui/
│       ├── app.tsx                     # 组合 Ink 交互界面与 Agent stream
│       ├── state.ts                    # 维护消息、状态和用户输入 reducer
│       ├── token-usage.ts              # 汇总并格式化 token usage
│       ├── components/                 # 放置可复用的 TUI 展示组件
│       ├── hooks/
│       │   └── use-agent-loop.ts       # 连接 reducer、Agent stream 与取消操作
│       └── __tests__/
│           ├── state.test.ts           # 验证 reducer 状态迁移
│           └── token-usage.test.ts     # 验证 token 统计与缺省字段
└── coding/permissions/
    ├── approval-middleware.ts          # 在有副作用的 Tool 前请求人工审批
    ├── index.ts                        # 导出权限层公共 API
    └── __tests__/
        └── approval-middleware.test.ts # 验证允许、拒绝与中止路径
docs/
└── manual-test.md                      # 固化真实终端中的人工验收步骤
examples/
└── stage-10-text-client.ts             # 离线验证一次文本交互
```

### 10.1 安装交互依赖

```bash
bun add commander ink ink-text-input react yaml
bun add -d @types/react eslint typescript-eslint
```

阶段 0 的配置只覆盖 `.ts`。现在修改练习项目的 `tsconfig.json`：在 `compilerOptions` 中
加入 `"jsx": "react-jsx"`，并将 `include` 替换为下面的列表，其余字段保留：

```json
{
  "compilerOptions": { "jsx": "react-jsx" },
  "include": ["src/**/*.ts", "src/**/*.tsx", "examples/**/*.ts", "examples/**/*.tsx"]
}
```

这是需要合并的字段，不是完整配置。JSX 是 `<Text>hello</Text>` 这样的表达式，`.tsx`
让 TypeScript 解析它，`jsx` 决定如何转换为 React 调用。Bun 能运行 JSX 不代表 `tsc` 已配置。

创建 `eslint.config.js`，先采用能够发现错误的最小配置：

```js
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "evals/**", "**/.harness/**"] },
  ...tseslint.configs.recommended,
  { rules: { "@typescript-eslint/no-unused-vars": "off" } },
);
```

配置文件的 default export 是 ESLint 的入口要求；课程实现模块仍使用 named exports。
将 `package.json` 的 scripts 合并为：

```json
{
  "scripts": {
    "dev": "bun run src/cli/index.ts",
    "check:types": "tsc --noEmit",
    "test": "bun test",
    "lint": "eslint src examples",
    "check": "bun run check:types && bun run lint && bun test"
  }
}
```

先运行 `bun run check:types`。若看到 `--jsx is not set`，检查正在使用的是否为练习仓库的
tsconfig；若出现新增文件未检查，检查 `include`，不要用类型断言屏蔽错误。

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

先实现不依赖 React 的一轮交互。目标文件：`src/cli/run-agent-turn.ts`：

```ts
import type { Agent } from "@/agent/agent";
import type { AgentEvent } from "@/agent/agent-event";

export async function runAgentTurn(options: {
  agent: Agent;
  text: string;
  onEvent: (event: AgentEvent) => void | Promise<void>;
}): Promise<void> {
  if (!options.text.trim()) return;
  for await (const event of options.agent.stream({
    role: "user", content: [{ type: "text", text: options.text }],
  })) {
    await options.onEvent(event);
  }
}
```

目标文件：`examples/stage-10-text-client.ts`。这条离线路径无需 API key 或 TUI：

```ts
import { Agent } from "@/agent/agent";
import { Model, ScriptedModelProvider } from "@/foundation/models";
import { formatTranscript } from "@/foundation/messages";
import { runAgentTurn } from "@/cli/run-agent-turn";

const agent = new Agent({
  prompt: "", tools: [],
  model: new Model({ name: "scripted", provider: new ScriptedModelProvider({ responses: [
    { role: "assistant", content: [{ type: "text", text: "client ready" }] },
  ] }) }),
});
const onInterrupt = () => agent.abort();
process.on("SIGINT", onInterrupt);
try {
  await runAgentTurn({ agent, text: "hello", onEvent: (event) => {
    if (event.type === "message") console.log(formatTranscript([event.message]));
  } });
} finally {
  process.off("SIGINT", onInterrupt);
}
```

运行 `bun run examples/stage-10-text-client.ts`，应看到 `assistant: client ready`。
下一步将同一个 `runAgentTurn` 接入 Ink，不复制 Agent loop。真实命令行入口负责加载
配置、创建 Provider 和 Coding Agent，最后调用 `render(<App agent={agent} />)`；入口若
需要 JSX，可将 render 调用放进 `app.tsx` 导出的 `mountApp()`，保留原 `src/cli/index.ts`。

理解 TUI 前只需要四个 React 概念：

| 概念 | 在这里的职责 |
|---|---|
| component/props | 用函数描述界面，通过 props 接收 Agent；不要在 render 中重新创建 Agent |
| `useReducer` | 根据事件计算下一份 state；不能直接修改旧数组 |
| `useRef` | 同步保存 busy 标志，避免 React 更新提交前连续 Enter 触发两次 run |
| `useEffect` cleanup | 组件卸载时 abort 并移除监听，防止后台 run 留存 |

先完成下面的 reducer，再填充 hook 和界面骨架；无需同时学习复杂 React 优化。

目标文件：`src/cli/tui/state.ts`

先实现状态，再做视觉：

<details>
<summary>展开完整代码：<code>state.ts</code></summary>

```ts
import type { AgentEvent } from "@/agent/agent-event";
import type { TodoItem } from "@/agent/todos/todo-system";
import type { ApprovalRequest } from "@/coding/permissions/approval-middleware";
import type { NonSystemMessage } from "@/foundation/messages";

import { calculateTokenUsage } from "./token-usage";

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
  | { type: "user_submitted"; text: string }
  | { type: "cleared" }
  | { type: "todos_updated"; items: TodoItem[] }
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
  if (event.type === "message") {
    // 标准路径：模型的累计 progress 不进历史；仅在最终 message 到来时追加一次。
    const messages = [...state.messages, event.message];
    return { ...state, messages, tokenUsage: calculateTokenUsage(messages) };
  }
  // TODO 3：user_submitted 追加 user message；run_start 设置 streaming=true。
  // TODO 4：run_end（包括 aborted）设置 streaming=false，清空 pendingApproval。
  // TODO 5：approval_requested 只替换 pendingApproval；todos_updated 深度复制 items。
  // TODO 6：cleared 返回 initialAgentLoopViewState；先通过 Agent.clearMessages 清除事实记录。
  // TODO 7：progress 可更新忙碌提示，不向 messages 塞入不完整 assistant message。
  throw new Error("TODO: implement reduceAgentEvent");
}
```

</details>

`Agent` 增加公开方法
`clearMessages(): void`：运行中拒绝清除，空闲时把 `_context.messages` 置为空数组。
hook 先调用这个方法，成功后再 dispatch `cleared`，避免 UI 与 transcript 不一致。

目标文件：`src/cli/tui/hooks/use-agent-loop.ts`：

```ts
import { useEffect, useReducer, useRef } from "react";

import type { Agent } from "@/agent/agent";
import { runAgentTurn } from "@/cli/run-agent-turn";

import { initialAgentLoopViewState, reduceAgentEvent } from "../state";

export function useAgentLoop(agent: Agent) {
  const [state, dispatch] = useReducer(reduceAgentEvent, undefined, initialAgentLoopViewState);
  const busy = useRef(false);
  useEffect(() => () => agent.abort(), [agent]);

  async function submit(text: string): Promise<void> {
    if (busy.current || !text.trim()) return;
    busy.current = true;
    dispatch({ type: "user_submitted", text });
    dispatch({ type: "run_start" });
    try {
      await runAgentTurn({ agent, text, onEvent: (event) => dispatch(event) });
    } catch (error) {
      // TODO：区分 abort 与普通 API 错误，显示错误提示；错误提示不冒充模型回复写回 Agent。
    } finally {
      busy.current = false;
      dispatch({ type: "run_end" });
    }
  }

  // TODO：加入 clear、审批桥接、Todo store 订阅；卸载时清理订阅并取消待处理的人类输入。
  return { state, submit, abort: () => agent.abort() };
}
```

10B 的 `App` 先只渲染 `state.messages`、`state.streaming` 和输入框。输入文本用
`useState` 保存；Enter 调 `submit(text)`，忙碌时禁用普通输入，Ctrl+C 调 `abort()`。
10C 再让审批/问题输入优先于普通聊天输入；10D 最后拆分以下组件。

目标文件：`src/cli/tui/app.tsx`。下面先打通 10B；`TextInput` 管理光标和退格，无需自己
处理每个字符。`exitOnCtrlC: false` 让应用先中止 Agent，空闲时才退出。

```tsx
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useState } from "react";

import type { Agent } from "@/agent/agent";
import { formatTranscript } from "@/foundation/messages";

import { useAgentLoop } from "./hooks/use-agent-loop";

export const App = memo(function App({ agent }: { agent: Agent }) {
  const { state, submit, abort } = useAgentLoop(agent);
  const [input, setInput] = useState("");
  const { exit } = useApp();
  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === "c") {
      if (agent.streaming) abort();
      else exit();
    }
  });
  return (
    <Box flexDirection="column">
      <Text>{formatTranscript(state.messages)}</Text>
      <Text>{state.streaming ? "Working…" : "Ready"}</Text>
      <TextInput value={input} onChange={setInput} focus={!state.streaming}
        onSubmit={(text) => { setInput(""); void submit(text); }} />
    </Box>
  );
});

export function mountApp(agent: Agent) {
  return render(<App agent={agent} />, { exitOnCtrlC: false });
}
```

运行前先完成 reducer 中的 `user_submitted/run_start/run_end/progress` 分支。
这个最小界面还没有审批和 slash command；进入 10C 时，在 `submit` 调模型之前解析 slash
command，审批弹出时将 `TextInput` 的 focus 关闭，并用单独的状态显示 API error。

当前 `AgentEvent.progress` 提供生成状态及 Tool 参数提示，不包含正文增量；因此先做
忙碌指示和最终消息展示。若要正文逐字输出，需要显式扩展 progress snapshot 契约及测试，
不能让 UI 读取 Agent 私有状态。不要把“进度提示”描述成已经实现了正文流式渲染。

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
- 普通 API error 显示在 UI 错误区域，不写成模型回复或使 TUI 崩溃。

### 10.4 审批 Middleware

审批决策是通用类型。目标文件：`src/foundation/permissions/approval-decision.ts`：

```ts
export type ApprovalDecision = "allow_once" | "allow_always_project" | "deny";
```

在 `src/foundation/permissions/index.ts` 中 re-export 该类型。`coding` 负责审批界面与
持久化策略，后续 trace 直接使用 foundation 的契约，不能反向依赖 coding。

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
import type { AgentMiddleware } from "@/agent/agent-middleware";
import type { ToolUseContent } from "@/foundation/messages";
import type { ApprovalDecision } from "@/foundation/permissions/approval-decision";

export type { ApprovalDecision } from "@/foundation/permissions/approval-decision";

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
import type { AssistantMessage, NonSystemMessage } from "@/foundation/messages";

export function calculateTokenUsage(messages: NonSystemMessage[]) {
  const assistantWithUsage = messages.filter(
    (message): message is AssistantMessage => message.role === "assistant" && message.usage !== undefined,
  );

  // 标准实现示例：session total 是所有已报告 totalTokens 的和。
  const sessionTotalTokens = assistantWithUsage.reduce(
    (sum, message) => sum + (message.usage?.totalTokens ?? 0),
    0,
  );

  const latestInputTokens = assistantWithUsage.at(-1)?.usage?.promptTokens ?? 0;
  return { latestInputTokens, sessionTotalTokens };
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
