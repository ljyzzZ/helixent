# 第三部分：Coding Agent 与交互客户端

这一部分完成阶段 7～10。阶段 10 结束时，你会得到一个具备基础编码能力的 v1 Coding Agent：能接真实模型、读写代码、加载 `AGENTS.md` 和 Skills、管理 Todo、流式交互，并在执行会修改文件等有副作用的工具前请求人工审批。

真实 API 验证始终是可选的集成测试。核心测试继续使用模拟 Provider（按预设返回结果，不访问真实模型服务），避免网络波动、费用和模型随机性影响质量检查。

## 阶段 7：实现 Provider Adapter

> 上一阶段回顾：阶段 6 建立了 Middleware 生命周期，并明确各环节可以修改哪些状态，把日志、审批等通用策略从 Agent 主循环中分离出来。

### 本阶段解决的问题

不同模型厂商在以下方面并不一致：

- 系统提示词的放置方式；
- 工具定义和参数结构；
- 工具调用标识和参数编码；
- 思考内容（thinking/reasoning）；
- 流式响应的数据片段结构；
- token 用量字段；
- 中止请求的方式和错误类型。

Provider 是模型调用接口的实现；Adapter（适配器）负责转换项目与模型厂商之间的数据格式。
它吸收这些差异，让 Agent 运行时只处理统一的 `Message`。

本阶段会反复遇到以下术语，先按这里的含义理解即可：

| 术语 | 在本教程中的含义 |
|---|---|
| canonical（内部统一、作为基准的） | 修饰 `Message`、type 等词时，指项目内部统一采用的表示；修饰 transcript、context 时，指作为事实来源或基准维护的对话记录、上下文，用于生成每次请求的临时 Model view |
| schema | 数据的结构与校验规则，例如工具参数有哪些字段、各是什么类型、是否必填 |
| endpoint | 模型服务的 API 地址；同一套 SDK 可以通过配置地址连接不同的兼容服务 |
| converter | 格式转换函数，例如将 `Message[]` 转成 SDK 所需的消息数组 |
| fake client / fake provider | 模拟客户端或模拟 Provider，按测试预设返回响应，代替真实网络调用 |
| fixture | 为测试预先准备的数据或环境，例如一段固定的 SDK 响应、一份临时文件 |
| contract（契约） | 接口对输入、输出和行为的约定；契约测试通过公开接口验证这些约定 |

其中 schema 可以理解为“数据应当长什么样”的说明。参见 [JSON Schema 对 schema 的解释](https://json-schema.org/understanding-json-schema/about)。

### 7.0 阅读路线

先完成 OpenAI，再独立实现 Anthropic，最后按需接入真实 API。下面四个里程碑与正文顺序
一致；每个实现后面紧跟对应测试和运行命令，读完并通过当前检查后，再进入下一节。

| 里程碑 | 对应章节 | 本次完成什么 | 可以停止并检查的证据 |
|---|---|---|---|
| 7A | [7.1 OpenAI 非流式调用](#stage-7a) | 消息与工具参数结构转换、`invoke` | 转换函数测试、模拟客户端测试 |
| 7B | [7.2 OpenAI 流式调用](#stage-7b) | 累计快照、工具参数的 JSON 片段、`stream` | 累积器测试、模拟流式响应测试 |
| 7C | [7.3 Anthropic Adapter](#stage-7c) | 在独立章节复用同一套内部格式与行为约定 | Anthropic 转换函数、累积器、模拟客户端测试 |
| 7D | [7.4 真实 API 验证](#stage-7d) | 配置服务地址并观察真实响应 | 可选的基本连通性示例，不替代离线测试 |

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
├── utils.ts                       # canonical（项目内部统一表示）与 OpenAI wire types 的转换
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
| `convertToOpenAIMessages` | 内部统一的 `Message[]` | SDK 请求中的消息数组 |
| `convertToOpenAITools` | `Tool[]` | SDK 的函数工具定义 |
| `parseOpenAIAssistantMessage` | SDK 的助手响应与用量数据 | 内部统一的 `AssistantMessage` |

本节基于 OpenAI Chat Completions 实现消息转换，并支持 `reasoning_content` 扩展。
assistant 的正文、思考内容和工具调用分别映射到 `content`、`reasoning_content` 和
`tool_calls`，转换时保持原始对话记录不变。

以下对两个特殊字段作出说明：

- `reasoning_content` 是第三方扩展字段，DeepSeek 和 Qwen 等思考模式都使用它。
  本节适配为：接收时解析为内部的 `thinking` 内容块，流式调用时累积片段，发送历史消息时写回该字段。

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

将下面的完整测试保存到该文件。测试中的 `as never` 用于适配省略了无关 SDK 字段的测试数据。

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
模型调用的参数，发出请求，再返回内部统一的 `AssistantMessage`。

调用链是 `Model.invoke(context) → provider.invoke(params)`。`Model` 会把模型名称、
模型 options 和本轮上下文整理为 `ModelProviderInvokeParams`：

| 参数 | 来源与用途 |
|---|---|
| `model` | `Model.name`，指定 endpoint 上要调用的模型 |
| `messages` | `Model` 将提示词（如果有）和对话历史组成的内部消息数组 |
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
- `messages` 调用上一节的 `convertToOpenAIMessages`，将内部消息转成 SDK 格式。
- `tools` 有传入时调用 `convertToOpenAITools`，生成工具名称、描述和参数结构；未传入时
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
请求控制选项用途不同。API 密钥由 SDK 用于鉴权，不应写入消息、日志或测试快照。

最后完成 TODO 3。SDK 响应中的 `choices` 保存候选回复；本项目取第一项的 `message`，
交给 `parseOpenAIAssistantMessage`，继续使用上一节已经实现的正文、thinking 和工具调用解析。
代码中的 `!` 是 TypeScript 非空断言：这里沿用项目取首项回复的约定，它本身不做运行时校验。

`usage` 位于 SDK 响应的顶层，需要先经 `toTokenUsage` 转成内部统一的字段：
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

SDK `create` 的第二个参数承载 `signal`；不要把取消信号混进 JSON 请求体。
测试通过构造函数注入模拟客户端，不创建真实 SDK 客户端，也不需要 API 密钥。

```bash
bun test src/community/openai/__tests__/model-provider.test.ts
```

**7A 完成检查**：转换测试和模拟客户端测试通过，`invoke` 返回内部统一的
`AssistantMessage`，调用方的 `options` 能覆盖默认值，`signal` 已透传到 SDK。

### 7.2 OpenAI：流式输出与工具参数片段（7B） {#stage-7b}

在已通过测试的 OpenAI 非流式路径上增加流式输出（streaming）：模型逐步返回生成内容，
调用方可以边接收边处理，不必等待完整回答。本节继续只修改 OpenAI 适配器。

这里要区分“本次收到的片段”和“目前累计的完整内容”：

| 术语 | 含义与例子 |
|---|---|
| chunk（数据片段） | 流中每次收到的一个数据对象；可能携带新增文本、工具参数或用量数据 |
| delta（增量） | 相比上一次新增的部分，例如先收到“你”，再收到“好” |
| accumulator（累积器） | 保存并合并历次片段的对象；本节对应 `StreamAccumulator` |
| snapshot（快照） | 某一时刻累计状态的独立副本；上述两次文本的快照分别是“你”和“你好” |

工具参数的 fragments 也是逐步到达的片段，只是内容为 JSON 文本，需要先拼接再解析。

```bash
touch src/community/openai/stream-accumulator.ts
touch src/community/openai/__tests__/stream-accumulator.test.ts
```

#### 7.2.1 实现 StreamAccumulator，并验证累计状态

目标文件：`src/community/openai/stream-accumulator.ts`

定义仅供这个 Provider 使用的累积器。文本增量分支是标准实现示例；思考内容、工具参数片段
和用量分别保留为独立 TODO，每个工具调用按 `index` 分别累计参数。

`_toolCalls` 保存拼接中的 `argumentsText`，而 `ToolUseContent` 要求解析后的 `input`。
在 `snapshot()` 中完成这次转换：先加入非空 thinking、正文，再按 Tool call index 从小到大
逐个加入工具调用。`AssistantMessageContent` 本身就是数组类型，可以逐个 `push` 内容块。

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

这里的 `ProviderChunk` 是 OpenAI 适配器内部整理后的片段类型。`index` 是工具调用在本次响应中的序号，
同一次调用的序号保持不变；`argumentsDelta` 按相同序号拼接，`usage` 只在 Provider 明确报告时出现。
SDK 片段到这个类型的转换留在 `model-provider.ts`，不要让 SDK 类型进入 Agent。

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
   并通过第二个参数传入 `signal`。**项目同时还需要设置 `stream_options: { include_usage: true }`**，
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
在文件末尾追加下面的完整用例。
这些用例直接向 Provider 输入 SDK 形状的 chunk，检查请求配置和转换后的累计消息，
因此不能只靠 accumulator 的单元测试代替。

<details>
<summary>展开追加用例：<code>OpenAI fake stream</code></summary>

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

  expect(request).toMatchObject({
    model: "test-model",
    stream: true,
    stream_options: { include_usage: true },
  });
  expect(sdkSignal).toBe(controller.signal);
  expect(snapshots[0]?.content).toEqual([{ type: "text", text: "hel" }]);
  expect(snapshots.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "hello" }],
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  });
});

test("accumulates reasoning_content separately from text", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield { choices: [{ index: 0, delta: { reasoning_content: "先分析" } }] };
          yield {
            choices: [{ index: 0, delta: { reasoning_content: "再回答", content: "hel" } }],
          };
          yield { choices: [{ index: 0, delta: { content: "lo" } }] };
        })(),
      },
    },
  };
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
    snapshots.push(snapshot);
  }

  expect(snapshots.map((snapshot) => snapshot.content)).toEqual([
    [{ type: "thinking", thinking: "先分析" }],
    [
      { type: "thinking", thinking: "先分析再回答" },
      { type: "text", text: "hel" },
    ],
    [
      { type: "thinking", thinking: "先分析再回答" },
      { type: "text", text: "hello" },
    ],
  ]);
  expect(snapshots.at(-1)?.usage).toBeUndefined();
});

test("maps SDK function fields to tool name and input before usage arrives", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield {
            choices: [{ index: 0, delta: { tool_calls: [{
              index: 0,
              id: "call-read",
              type: "function",
              function: { name: "read_file", arguments: '{"path":"a.ts"}' },
            }] } }],
          };
        })(),
      },
    },
  };
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
    snapshots.push(snapshot);
  }

  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]?.content).toEqual([
    { type: "tool_use", id: "call-read", name: "read_file", input: { path: "a.ts" } },
  ]);
  expect(snapshots[0]?.usage).toBeUndefined();
});

test("handles all tool fragments per chunk without mixing calls or repeating text", async () => {
  const client = {
    chat: {
      completions: {
        create: async () => (async function* () {
          yield {
            choices: [{ index: 0, delta: {
              content: "读取",
              reasoning_content: "检查",
              tool_calls: [
                {
                  index: 1, id: "call-b", type: "function",
                  function: { name: "write_file", arguments: '{"path":"b.ts",' },
                },
                {
                  index: 0, id: "call-a", type: "function",
                  function: { name: "read_file", arguments: '{"path":' },
                },
              ],
            } }],
          };
          yield {
            choices: [{ index: 0, delta: {
              content: "完成",
              reasoning_content: "文件",
              tool_calls: [
                { index: 0, function: { arguments: '"a.ts"}' } },
                { index: 1, function: { arguments: '"content":"ok"}' } },
              ],
            } }],
          };
        })(),
      },
    },
  };
  const provider = new OpenAIModelProvider({ client: client as never });
  const snapshots = [];

  for await (const snapshot of provider.stream({ model: "test-model", messages: [] })) {
    snapshots.push(snapshot);
  }

  expect(snapshots.map((snapshot) => snapshot.content)).toEqual([
    [
      { type: "thinking", thinking: "检查" },
      { type: "text", text: "读取" },
    ],
    [
      { type: "thinking", thinking: "检查文件" },
      { type: "text", text: "读取完成" },
      { type: "tool_use", id: "call-a", name: "read_file", input: { path: "a.ts" } },
      {
        type: "tool_use", id: "call-b", name: "write_file",
        input: { path: "b.ts", content: "ok" },
      },
    ],
  ]);
});
```

</details>

测试命令：

```bash
bun test src/community/openai
```

**7B 完成检查**：OpenAI converter、accumulator 和 Provider tests 全部通过；非流式路径
仍正常，streaming 能输出独立的累计 snapshot，并保留末尾单独报告的 usage。到这里再开始第二个 Provider。

### 7.3 Anthropic：独立实现第二个 Adapter（7C） {#stage-7c}

本章集中完成 Anthropic 的安装、转换、streaming 和 Provider 验证。复用的是
`ModelProvider` 与 canonical `Message`（项目内部统一的消息表示）契约，转换函数和 accumulator 都放在独立的
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

Anthropic 将消息分成内容块（content block），每块承载文本、思考内容或工具调用等一种内容。
其中 `thinking` 内容块包含思考文本和 `signature` 签名；客户端不解释签名的内容，只原样保存和回传。
在思考内容伴随工具调用的对话中，返回工具结果时必须一并回传之前完整、未修改的思考内容块。
即使文本为空，也要保留其签名。协议说明见 [Anthropic Thinking](https://platform.claude.com/docs/en/build-with-claude/thinking)。

本节用 adapter 内部的 `_anthropicSignature` 保存签名，发送请求时还原为 SDK 的 `signature`。
它随内部的思考内容块保存在对话记录中，不需要修改 `foundation` 的类型。
下面给出可通过类型检查的练习骨架：系统消息提取、用户文本与 URL 图片转换、签名辅助函数和用量映射已作为示例实现，
其余分支按编号 TODO 完成。每个待实现分支暂时抛出错误，完成时用对应的返回值替换 `throw`。

<details>
<summary>展开代码骨架：<code>utils.ts</code></summary>

```ts
import Anthropic from "@anthropic-ai/sdk";

import type { AssistantMessage, Message, ThinkingContent } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface AnthropicThinkingContent extends ThinkingContent {
  // 流式中间快照可能尚未收到签名。
  _anthropicSignature?: string;
}

function parseAnthropicThinking(block: Anthropic.ThinkingBlock): AnthropicThinkingContent {
  return {
    type: "thinking",
    thinking: block.thinking,
    _anthropicSignature: block.signature,
  };
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
  const systemMessages = messages.filter((message) => message.role === "system");
  if (systemMessages.length === 0) {
    return undefined;
  }
  return systemMessages
    .flatMap((message) => message.content.map((textContent) => textContent.text))
    .join("\n\n");
}

export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[] {
  // TODO 2：排除 system message，并把 Tool result 转成 user-role content。
  // 参数规则：保持原始消息及 content block 顺序，不修改 canonical messages（采用内部统一格式的消息）。
  // assistant thinking 分支调用 convertToAnthropicThinking，保留空 thinking 文本。
  const nonSystemMessages = messages.filter((message) => message.role !== "system");

  const messageParams: Anthropic.MessageParam[] = [];

  for (const message of nonSystemMessages) {
    switch (message.role) {
      case "assistant":
        messageParams.push({
          role: "assistant",
          content: message.content.map((assistantContent): Anthropic.ContentBlockParam => {
            switch (assistantContent.type) {
              case "text":
                // TODO 2.1：返回 text block，字段为 type 和 text。
                // 空字符串也是有效内容，不要用 if (assistantContent.text) 过滤。
                throw new Error("TODO 2.1: convert assistant text");
              case "thinking":
                // TODO 2.2：返回 convertToAnthropicThinking(assistantContent) 的结果。
                // 复用签名校验；即使 thinking 为空也要保留该 block。
                throw new Error("TODO 2.2: convert assistant thinking");
              case "tool_use":
                // TODO 2.3：返回 type、id、name、input 四个字段。
                // input 保持对象，不需要像 OpenAI arguments 那样 JSON.stringify。
                // 不要重新生成 id，后面的 tool_result 要靠它关联调用。
                throw new Error("TODO 2.3: convert assistant tool use");
            }
          }),
        });
        break;
      case "user":
        messageParams.push({
          role: "user",
          content: message.content.map((userContent) => {
            if (userContent.type === "text") {
              return {
                type: "text",
                text: userContent.text,
              };
            }

            return {
              type: "image",
              source: {
                type: "url",
                url: userContent.image_url.url,
              },
            };
          }),
        });
        break;
      case "tool":
        messageParams.push({
          // Anthropic 用 user 消息承载工具结果，没有独立的 tool role。
          role: "user",
          content: message.content.map((toolContent): Anthropic.ToolResultBlockParam => {
            // TODO 2.4：返回 type="tool_result"、tool_use_id 和 content。
            // 一条 ToolMessage 内的多个结果放进同一个 content 数组，顺序不变。
            // toolContent.content 已经是字符串，直接保留，不要再次 JSON.stringify。
            throw new Error("TODO 2.4: convert tool result");
          }),
        });
        break;
    }
  }
  return messageParams;
}

export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[] {
  return tools.map((tool): Anthropic.Tool => {
    // TODO 3.1：调用 tool.parameters.toJSONSchema() 得到 JSON Schema。
    // TODO 3.2：返回 name、description、input_schema；不用 OpenAI 的 function 包装层。
    // input_schema 必须是对象 schema；SDK 要求 type 为字面量 "object"。
    // 如果 schema.type 的类型太宽，先检查 schema.type !== "object" 并抛错，
    // 然后使用 { ...schema, type: "object" }，保留 properties、required 等字段。
    // 不要调用 tool.invoke；这里只转换定义，不执行工具。
    throw new Error("TODO 3: convert tool definition");
  });
}

export function parseAnthropicAssistantMessage(message: Anthropic.Message): AssistantMessage {
  const content = message.content.map((anthropicContent): AssistantMessage["content"][number] => {
    switch (anthropicContent.type) {
      case "text":
        // TODO 4.1：返回内部 text block；字段为 type 和 text，保留空字符串。
        throw new Error("TODO 4.1: parse assistant text");
      case "thinking":
        // TODO 4.2：返回 parseAnthropicThinking(anthropicContent) 的结果。
        // SDK signature 存入 _anthropicSignature，后续回传时再还原。
        throw new Error("TODO 4.2: parse assistant thinking");
      case "tool_use":
        // TODO 4.3：返回内部 tool_use block，保留 id、name 和 input。
        // SDK 的 anthropicContent.input 是 unknown，内部要求 Record<string, unknown>。
        // 先检查 typeof input === "object"、input !== null、!Array.isArray(input)，
        // 不符合时抛出带 anthropicContent.id 的错误；通过检查后再收窄为 Record<string, unknown>。
        // input 已是解析后的值，不需要 JSON.parse。
        throw new Error("TODO 4.3: parse assistant tool use");
      default:
        // SDK 还有 redacted_thinking、服务端工具等类型，本练习暂不支持。
        // 显式报错避免静默丢失内容；以后扩展时再定义对应的内部表示。
        throw new Error(`UNSUPPORTED_CONTENT_BLOCK: ${anthropicContent.type}`);
    }
  });

  // 示例：按本节约定映射 provider usage，不按文本长度估算 token。
  const promptTokens = message.usage.input_tokens;
  const completionTokens = message.usage.output_tokens;
  return {
    role: "assistant",
    content,
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    },
  };
}
```

</details>

建议按 `TODO 2.1–2.4 → TODO 3 → TODO 4.1–4.3` 的顺序实现：先转换消息，
再转换工具定义，最后解析响应。`map` 回调标注了目标内容块类型，便于把类型错误定位到具体分支。
user 示例中的图片使用 `{ type: "url", url }` 作为 `source`，不能直接传内部的 `{ url, detail? }` 对象。

这些函数必须是纯函数，保持消息与内容块顺序，不修改输入。先用下面的固定测试数据测完，再调用 SDK。
骨架通过类型检查只说明类型结构成立；未替换的 TODO 仍会抛错，必须补齐实现并运行转换测试。

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

Anthropic 事件先转成以下仅供该 Provider 使用的联合类型（union，即一个值可以属于列出的几种类型之一），
再交给累积器；不要让 SDK 的事件类型进入 Agent。

下面预先搭好状态类型、事件分派和快照结构，并用 text 累积与 usage 映射作为示例。
按 `TODO 1.1–1.5 → TODO 2` 补齐 thinking、Tool 和 JSON 解析逻辑；完成一个分支时，
将对应的 `throw` 替换为实现，并用 `break` 结束该事件分支。

<details>
<summary>展开代码骨架：<code>stream-accumulator.ts</code></summary>

```ts
import type { AssistantMessage, TokenUsage } from "@/foundation/messages";

import type { AnthropicThinkingContent } from "./utils";

export type ProviderChunk =
  | { type: "text_delta"; index: number; text: string }
  | { type: "thinking_start"; index: number; thinking: string; signature: string }
  | { type: "thinking_delta"; index: number; thinking: string }
  | { type: "signature_delta"; index: number; signature: string }
  | { type: "tool_start"; index: number; id: string; name: string }
  | { type: "input_json_delta"; index: number; partialJson: string }
  | { type: "message_start"; inputTokens: number }
  | { type: "message_end"; outputTokens: number };

interface TextBlockState {
  type: "text";
  text: string;
}

interface ThinkingBlockState {
  type: "thinking";
  thinking: string;
  signature: string;
}

interface ToolBlockState {
  type: "tool_use";
  id: string;
  name: string;
  partialJson: string;
}

type BlockState = TextBlockState | ThinkingBlockState | ToolBlockState;

export class StreamAccumulator {
  // Map 的 key 是响应内的 block index；不要用 tool id 或到达顺序代替。
  private readonly _blocks = new Map<number, BlockState>();
  private _promptTokens: number | undefined;
  private _completionTokens: number | undefined;

  push(chunk: ProviderChunk): void {
    // usage 事件没有 index；先用 in 收窄，再读取对应 block 的累计状态。
    const blockState = "index" in chunk ? this._blocks.get(chunk.index) : undefined;

    switch (chunk.type) {
      case "text_delta": {
        // 示例：首次 delta 创建状态，后续 delta 追加文本。
        // 即使首个 chunk.text 为空，也会建立 text block。
        if (blockState === undefined) {
          this._blocks.set(chunk.index, { type: "text", text: chunk.text });
          break;
        }
        if (blockState.type !== "text") {
          throw new Error(`INVALID_BLOCK_TYPE: expected text at index ${chunk.index}`);
        }
        blockState.text += chunk.text;
        break;
      }
      case "thinking_start":
        // TODO 1.1：为 chunk.index 建立 ThinkingBlockState。
        // 保存 chunk.thinking 和 chunk.signature，包括空字符串。
        // start 应只出现一次；若 blockState 已存在，抛错，避免覆盖累计内容。
        throw new Error("TODO 1.1: initialize thinking block");
      case "thinking_delta":
        // TODO 1.2：检查 blockState 存在且 type === "thinking"，再追加 thinking。
        // 不要从 delta 临时创建 thinking block，否则会遗漏 start 中的文本和签名。
        // Map.get 可能返回 undefined；通过检查后，TS 才允许访问 thinking 字段。
        throw new Error("TODO 1.2: append thinking delta");
      case "signature_delta":
        // TODO 1.3：检查 blockState 是 thinking，再更新它的 signature。
        // 本节 ProviderChunk 的 signature 是完整签名：使用赋值，不使用 +=。
        // 不要追加到 thinking 文本，也不要更新其他 index 的签名。
        throw new Error("TODO 1.3: update thinking signature");
      case "tool_start":
        // TODO 1.4：为 chunk.index 建立 ToolBlockState。
        // 保存 id、name，partialJson 初始化为 ""；重复 start 应报错。
        // 参数先保存为字符串，JSON 片段可能还不完整，不要在这里 JSON.parse。
        throw new Error("TODO 1.4: initialize tool block");
      case "input_json_delta":
        // TODO 1.5：检查 blockState 是 tool_use，再把 chunk.partialJson 追加进去。
        // 每个 index 有自己的 partialJson；多个 Tool 交错到达时不能混用缓冲区。
        throw new Error("TODO 1.5: append tool input JSON");
      case "message_start":
        // 示例：记录 provider 明确报告的输入 token 数，0 也是有效值。
        this._promptTokens = chunk.inputTokens;
        break;
      case "message_end":
        this._completionTokens = chunk.outputTokens;
        break;
    }
  }

  snapshot(): AssistantMessage {
    // 示例：Map 按插入顺序遍历，输出前必须按 index 做数值排序。
    const orderedBlocks = [...this._blocks.entries()].sort(([leftIndex], [rightIndex]) =>
      leftIndex - rightIndex,
    );
    const content = orderedBlocks.map(([, blockState]): AssistantMessage["content"][number] => {
      switch (blockState.type) {
        case "text":
          return { type: "text", text: blockState.text };
        case "thinking": {
          // 示例：累计状态使用 signature，内部消息使用 _anthropicSignature。
          // 流式快照允许签名暂时为空；不要调用会拒绝空签名的发送端转换函数。
          const thinkingContent: AnthropicThinkingContent = {
            type: "thinking",
            thinking: blockState.thinking,
            _anthropicSignature: blockState.signature,
          };
          return thinkingContent;
        }
        case "tool_use":
          return {
            type: "tool_use",
            id: blockState.id,
            name: blockState.name,
            input: this._parseToolInput(blockState.partialJson),
          };
      }
    });

    // 每次都返回新对象；不能把 Map 中可变的 blockState 直接放进 content。
    return { role: "assistant", content, usage: this._snapshotUsage() };
  }

  private _parseToolInput(partialJson: string): Record<string, unknown> {
    // TODO 2：生成当前快照使用的 Tool input。
    // 1. partialJson 为空时返回一个新的 {}。
    // 2. 用 try/catch 包裹 JSON.parse，并把结果先声明为 unknown。
    // 3. JSON 尚未完整、解析失败时，暂时返回新的 {}，不要让流式快照中断。
    // 4. 解析成功后检查非 null 的 object 且不是数组，再作为 Record 返回；
    //    对于 null、数组、字符串等不符合 Tool input 契约的值，也暂时返回 {}。
    // 每次 snapshot 都重新解析，确保嵌套对象也独立，调用方不能反向修改后续快照。
    // 这里只提供中间展示；流结束时的严格 JSON 校验由后续 Provider 阶段负责。
    throw new Error("TODO 2: parse partial tool input for snapshot");
  }

  private _snapshotUsage(): TokenUsage | undefined {
    // 示例：两个计数都已报告时才生成完整 usage，缺失时不伪造 0。
    if (this._promptTokens === undefined || this._completionTokens === undefined) {
      return undefined;
    }
    return {
      promptTokens: this._promptTokens,
      completionTokens: this._completionTokens,
      totalTokens: this._promptTokens + this._completionTokens,
    };
  }
}
```

</details>

这里的 `index` 表示内容块在本次响应中的序号。`partialJson` 只能追加到同一序号的工具调用；
`usage` 只在 Provider 明确报告时出现。SDK 事件先在 `model-provider.ts`
中转换为上面的联合类型，再交给累积器。思考内容块在开始事件到达时就要建立状态，
随后将 `signature_delta.signature` 原样赋给对应内容块的签名；签名不参与文本拼接。

实现时可以先单独验证 text 和 usage，再补 thinking 与 Tool：

- 累计状态按 `index` 隔离，快照按数值大小排序；事件到达顺序不等于内容展示顺序。
- 空 thinking 和尚未收到签名的 thinking 都应出现在流式快照中，不能用真假值判断过滤。
- Tool 参数片段要先拼接再解析；中间的 `{}` 只是展示占位，不代表参数已通过最终校验。
- 保存一次 `snapshot()` 后继续 `push()`，旧快照应保持不变；修改快照中的嵌套 Tool input，
  再次读取快照也不应受影响。

这份骨架可以通过类型检查，但含 TODO 的路径仍会抛错。下面的测试需要在补齐实现后通过。

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
    accumulator.push({ index: 1, type: "text_delta", text: "answer" });
    accumulator.push({ index: 0, type: "thinking_start", thinking: "", signature: "" });
    accumulator.push({ index: 0, type: "thinking_delta", thinking: "plan" });
    accumulator.push({ index: 0, type: "signature_delta", signature: "opaque-signature" });
    accumulator.push({
      index: 2,
      type: "tool_start",
      id: "call-1",
      name: "read_file",
    });
    accumulator.push({ index: 2, type: "input_json_delta", partialJson: '{"path"' });
    accumulator.push({ index: 2, type: "input_json_delta", partialJson: ':"a.ts"}' });

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
    accumulator.push({ type: "message_start", inputTokens: 12 });
    accumulator.push({ type: "message_end", outputTokens: 4 });

    expect(accumulator.snapshot().usage).toEqual({
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
    });
  });

  test.each([
    "42", "-7", "1.5", "true", "0", "false", "null", "[]", '[{"path":"a.ts"}]', '"hello"', '""',
  ])("uses an object placeholder for non-object tool JSON: %s", (partialJson) => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
    accumulator.push({ type: "input_json_delta", index: 0, partialJson });

    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: {} },
    ]);
  });

  test.each(["", "   ", '{"path":', "not-json"])(
    "uses an object placeholder for empty, incomplete or malformed tool JSON: %s",
    (partialJson) => {
      const accumulator = new StreamAccumulator();
      accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
      accumulator.push({ type: "input_json_delta", index: 0, partialJson });

      expect(accumulator.snapshot().content).toEqual([
        { type: "tool_use", id: "call-1", name: "read_file", input: {} },
      ]);
    },
  );

  test.each([
    { label: "empty object", input: {} },
    {
      label: "object containing numbers, booleans, null and arrays",
      input: { count: 42, enabled: true, optional: null, nested: { values: [1, false] } },
    },
  ])("preserves valid tool input: $label", ({ input }) => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
    accumulator.push({ type: "input_json_delta", index: 0, partialJson: JSON.stringify(input) });

    // 只限制参数的顶层类型；对象内部的数字、布尔值和数组都是有效 JSON 值。
    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input },
    ]);
  });

  test("replaces an incomplete input placeholder without changing the previous snapshot", () => {
    const accumulator = new StreamAccumulator();
    accumulator.push({ type: "tool_start", index: 0, id: "call-1", name: "read_file" });
    accumulator.push({ type: "input_json_delta", index: 0, partialJson: '{"path":' });
    const partial = accumulator.snapshot();
    expect(partial.content).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: {} },
    ]);
    const originalPartial = structuredClone(partial);

    accumulator.push({ type: "input_json_delta", index: 0, partialJson: '"a.ts"}' });
    expect(accumulator.snapshot().content).toEqual([
      { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.ts" } },
    ]);
    expect(partial).toEqual(originalPartial);
  });
});
```

</details>

```bash
bun test src/community/anthropic/__tests__/stream-accumulator.test.ts
```

通过后应确认：思考内容、正文和工具调用按内容块序号输出，JSON 片段正确拼接，
签名保存在所属思考内容块，旧快照保持不变，输入与输出 token 用量合并为内部统一的 `TokenUsage`。

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
    // TODO 3：用 parseAnthropicAssistantMessage 将响应和 usage 转回 canonical 消息（采用内部统一格式的消息）。
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
`index.ts` 导出 `AnthropicModelProvider`，API 密钥不进入日志、运行追踪记录或测试快照。

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
`invoke` 和 `stream` 都返回 canonical `AssistantMessage`（项目内部统一的助手消息表示），Agent 无需分支判断厂商。
此时两个 Adapter 的实现都已完成，可以进入可选联网验证，也可以直接执行 7.5 的完整检查。

### 7.4 真实 API 验证（7D，可选） {#stage-7d}

前面的小节用 fake client 和固定 fixtures 验证契约。现在才接入真实 endpoint，观察
SDK、鉴权、模型配置与 streaming 是否能一起工作。没有 API key 可以跳过本节。

#### 7.4.1 创建真实模型示例

先在练习项目根目录创建 `.env.example`，集中列出 API key、请求基础 URL 和模型名。
[Bun 会自动加载 `.env`](https://bun.com/docs/runtime/environment-variables)，代码仍通过 `Bun.env` 读取配置，无需安装 `dotenv`。

<details>
<summary>展开配置模板：<code>.env.example</code></summary>

```dotenv
# 复制为 .env 后，只需填写本次使用的 Provider；API key 留空时示例会提示配置。

# OpenAI 或兼容 Chat Completions 的服务
OPENAI_API_KEY=
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4.1-mini

# Anthropic 或兼容 Messages API 的服务
ANTHROPIC_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

</details>

首次配置时复制模板，再在 `.env` 中填写所选 Provider 的 key、URL 和可用模型名：

```bash
cp -n .env.example .env
```

如果已有 `.env`，直接补充所需字段即可。`.env` 保存本地配置并由 `.gitignore` 忽略，
`.env.example` 保留空 key，作为可提交的模板。URL 填服务的基础地址；
使用兼容服务时按其要求填写，不要在末尾追加 `/chat/completions` 或 `/messages`。

然后创建示例文件：

```bash
mkdir -p examples
touch examples/stage-07-real-model.ts
```

示例通过参数选择 Provider；因为同时导入两个 Adapter，请先完成 7C。

目标文件：`examples/stage-07-real-model.ts`

示例只把累计 snapshot 中新增的可见 text 写到终端；最终 JSON 中的 thinking 内容保留 canonical shape（项目内部统一的数据结构），
但用 `[hidden]` 替换原文。两个 Provider 都从 `.env` 读取 key、基础 URL 和模型名；
URL 留空时使用 SDK 默认地址，模型名留空时使用代码中的默认值。

`Model.stream()` 返回累计快照，展示层用 `printedText` 记录已输出的文本，
每次只追加 `text.slice(printedText.length)`。这依赖当前正文只追加的流式语义；
仅更新 thinking、签名、usage 或重复最终快照时，可见文本没有增加，就不会重复打印。
不要用 `\r` 加完整快照覆盖输出：`\r` 只回到当前行首，无法覆盖已换行的整段文本，
日志面板也可能不支持这种覆盖方式。

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
    baseURL: string | undefined;
    modelName: string;
    providerName: string;
  }> = {
    openai: {
      apiKey: Bun.env.OPENAI_API_KEY?.trim(),
      baseURL: Bun.env.OPENAI_BASE_URL?.trim() || undefined,
      modelName: Bun.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini",
      providerName: "OpenAI",
    },
    anthropic: {
      apiKey: Bun.env.ANTHROPIC_API_KEY?.trim(),
      baseURL: Bun.env.ANTHROPIC_BASE_URL?.trim() || undefined,
      modelName: Bun.env.ANTHROPIC_MODEL?.trim() || "claude-sonnet-4-20250514",
      providerName: "Anthropic",
    },
  };
  const selected = config[vendor];

  if (!selected.apiKey) {
    console.log(`Missing ${vendor === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}.`);
    console.log("Configure the key in the project-root .env file and run this example again.");
    return;
  }

  const provider: ModelProvider = vendor === "openai"
    ? new OpenAIModelProvider({
        apiKey: selected.apiKey,
        baseURL: selected.baseURL,
      })
    : new AnthropicModelProvider({
        apiKey: selected.apiKey,
        baseURL: selected.baseURL,
      });
  const model = new Model({ name: selected.modelName, provider });
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "用一句话解释 ReAct agent loop。" }],
  };
  const startedAt = performance.now();
  let finalMessage: AssistantMessage | undefined;
  let printedText = "";

  console.log(`provider=${selected.providerName} model=${selected.modelName}`);
  for await (const snapshot of model.stream({
    prompt: "Answer concisely. Do not expose hidden reasoning.",
    messages: [userMessage],
  })) {
    const text = visibleText(snapshot);
    process.stdout.write(text.slice(printedText.length));
    printedText = text;
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

配置完成后，在练习项目根目录运行；命令中不再填写 key 或 URL。

OpenAI-compatible endpoint：

```bash
bun run examples/stage-07-real-model.ts openai
```

Anthropic：

```bash
bun run examples/stage-07-real-model.ts anthropic
```

示例应打印：

- provider name 和 model name；
- streaming progress，只追加新增正文，不重复打印累计文本，也不打印隐藏 reasoning 原文；
- 最终 canonical `AssistantMessage`（项目内部统一的助手消息表示）；
- prompt/output/total tokens；
- 总耗时。

末尾 JSON 会再次包含完整正文，这是最终消息的展示；流式输出阶段的正文应只出现一次。

如果没有 key，示例给出配置提示后 exit 0；测试套件不能因此失败。

**7D 完成检查（可选）**：配置有效 key 后，所选 Provider 能返回真实回答，并打印
canonical message（采用项目内部统一格式的消息）、provider 报告的 token usage 与耗时。网络或鉴权失败在本节排查，
不把联网请求加入核心测试套件。

### 7.5 完整测试与阶段验收

两个 Provider 的实现和各自测试完成后，统一执行：

```bash
bun test src/community/openai src/community/anthropic
bun run check
```

这里汇总前面已运行的离线测试，不再引入新的测试文件，也不依赖 7D 的真实 API 配置。


#### 验收

- [ ] provider SDK type 不进入 `agent`；
- [ ] converter tests 不访问网络；
- [ ] streaming 最终 snapshot 与 non-stream response 语义一致；
- [ ] fragmented Tool arguments 有测试；
- [ ] signal 传入 SDK 请求；
- [ ] `ADR-008` 解释内部统一协议与厂商实际请求、响应格式之间的边界。

## 阶段 8：实现 Coding Tools

> 上一阶段回顾：阶段 7 把内部统一协议映射到 OpenAI 与 Anthropic，并统一了流式输出、工具调用、用量和中止请求的行为。

### 本阶段原则

Coding Agent 的能力不来自“更长的提示词”，而来自高质量的环境接口。工具应职责单一、可组合、有明确错误码，并回显模型下一步决策需要的信息。

先按依赖跑通一条最小路径，再扩展到完整工具集：

| 小里程碑 | Tools | 完成后立即观察 |
|---|---|---|
| 8A | 路径校验 + `read_file` | 读取一份临时文件；范围和越界测试通过 |
| 8B | `str_replace` | 读出旧值 → 唯一替换 → 再读出新值；失败时文件不变 |
| 8C | `bash` | 执行测试目录中的检查命令；捕获输出、超时和运行中取消 |
| 8D | `file_info`、`list_files`、`glob_search`、`grep_search` | 搜索结果的路径、行号和截断状态正确 |
| 8E | `mkdir`、`write_file`、`apply_patch`、`move_path` | `apply_patch` 使用完整示例；在磁盘上检查新增、修改、移动结果 |

8A～8C 的演练示例直接导入当前工具的工厂函数（factory，即接收配置并返回工具实例的函数），只注册已实现的工具。8E 完成后才填充
8.5 的 `defineCodingTools()`，再运行依赖完整工具集的示例和 8.6 的契约测试。这样未完成的
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

这个循环只创建空文件，不覆盖内容。所有工具的公开行为集中在一个完整的契约测试文件中，
路径安全单独测试；迭代时可用 `bun test -t "read_file"` 只运行相关用例。

各工具工厂函数的导出如下：

| 文件 | 公开导出 |
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

### 8.1 工作区边界 {#_8-1-workspace-boundary}

**工作区（workspace）**：允许工具访问的项目目录，由固定的 `cwd` 指定。
本节建立工作区边界：接受内部路径，拒绝通过 `../` 或符号链接访问外部，并支持尚未创建的目标。
函数只解析路径，不创建文件。

**符号链接（symlink，也叫软链接）**：保存了另一条目标路径的文件系统对象。访问它时，
系统通常会沿目标路径继续查找。例如 `/work/project/escape` 指向 `/outside`，
那么访问 `escape/config.ts` 实际访问的是 `/outside/config.ts`，即使输入路径看起来位于工作区内。
这就是“符号链接越界（symlink escape）”。参见 [GNU 对符号链接的说明](https://www.gnu.org/software/coreutils/manual/html_node/ln-invocation.html)。

难点是：`resolve()` 只整理路径字符串，`realpath()` 才会解析符号链接，得到实际路径，但要求路径已存在。
因此目标不存在时，要先向上找到已存在的祖先路径（父目录、父目录的父目录等），解析它，再拼回未创建的部分。
`lstat()` 检查路径项本身；最后一项是符号链接时，它检查链接，而不是链接目标。
相关 API 可对照 [Node.js 文件系统文档](https://nodejs.org/api/fs.html#fspromisesrealpathpath-options)。

目标文件 `src/coding/tools/tool-utils.ts`。下面给出步骤 1 和查找循环，TODO 2～4
分别补“记录路径段”“判断越界”“返回路径”，每处只需几行：

```ts
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; code: "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE"; error: string };

export async function resolveWorkspacePath(options: {
  cwd: string;
  inputPath: string;
}): Promise<PathValidationResult> {
  try {
    // 步骤 1（已给出）：解析可信 workspace；不存在时由外层 catch 返回 INVALID_PATH。
    // realpath 解析 workspace 的符号链接；resolve 只拼接路径，不要求目标存在。
    const realCwd = await realpath(options.cwd);
    const absolutePath = resolve(options.cwd, options.inputPath);
    let ancestor = absolutePath;
    const missingParts: string[] = [];

    // 目标可能尚未创建，逐级向上查找，直到找到存在的路径或遇到无法处理的错误。
    while (true) {
      try {
        // lstat 检查路径项本身，末尾是符号链接时也不跟随它；成功后退出循环。
        await lstat(ancestor);
        break;
      } catch (error) {
        // 只有“路径不存在”才向上找，其他 I/O 错误交给外层 catch。
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        // dirname 去掉最后一个路径段；根目录的父路径还是它自己，不能继续上移。
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;

        // TODO 2：记录被剥离的最后一个路径段，然后向父目录继续查找。
        // basename 取最后一段；unshift 放到数组头部，保持后续拼接时的父到子顺序。
        // 再将 ancestor 更新为 parent，进入下一轮循环。
        throw new Error("TODO 2: collect missingParts and advance ancestor");
      }
    }

    // 解析找到的路径实际指向的位置，避免 workspace 内的链接指向外部。
    const realAncestor = await realpath(ancestor);
    // relative 计算从 workspace 到真实路径的路线，如 "src"、"" 或 "../outside"。
    const relativePath = relative(realCwd, realAncestor);

    // TODO 3：越界时返回 { ok: false, code: "PATH_OUTSIDE_WORKSPACE", error: ... }。
    // 拒绝 relativePath === ".."、以 `..${sep}` 开头，或 isAbsolute(relativePath)。
    // 需要先向上走就表示越界；Windows 跨盘符时结果可能是绝对路径，也应拒绝。
    // 空字符串表示 workspace 本身，允许通过；sep 是平台的路径分隔符。
    throw new Error("TODO 3: reject an ancestor outside realCwd");

    // TODO 4：通过边界检查后，返回 { ok: true, path: ... }。
    // 在真实路径上拼回尚不存在的部分，保留符号链接解析后的结果。
    // 用 resolve(realAncestor, ...missingParts) 拼回路径；不要返回 absolutePath。
  } catch (error) {
    return {
      ok: false,
      code: "INVALID_PATH",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

#### 用一个未创建的文件演算 TODO 2

假设 `cwd = /work/project`，只存在 `/work/project/src`，输入为
`src/generated/config.ts`，且这些已存在的目录都不是符号链接：

| 本轮 `ancestor` | 更新后的 `missingParts` | 下一步 |
|---|---|---|
| `/work/project/src/generated/config.ts` | `["config.ts"]` | 不存在，上移到 `generated` |
| `/work/project/src/generated` | `["generated", "config.ts"]` | 不存在，上移到 `src` |
| `/work/project/src` | 保持不变 | 已存在，`break` |

因此 `realAncestor = /work/project/src`，`relativePath = src`，祖先在工作区内。
拼回后返回 `/work/project/src/generated/config.ts`，磁盘上的文件仍未创建。
如果目标已经存在，第一轮就 `break`，`missingParts` 为空，最终返回目标的 `realpath()`。

用 `unshift()`，是为了让路径段保持 `generated → config.ts` 的拼接顺序。

TODO 3 必须比较真实路径。例如 `escape` 指向 `/outside`，输入 `escape/new.ts` 时，
`realAncestor` 是 `/outside`，相对工作区的路径为 `../../outside`，应拒绝。
也不要用字符串前缀判断：`/work/project-other` 以 `/work/project` 开头，但属于外部目录。

<details>
<summary>仍然卡住时，展开 TODO 2～4 的填空提示</summary>

用以下两行替换 TODO 2 的 `throw`：

```ts
missingParts.unshift(basename(ancestor));
ancestor = parent;
```

用以下分支替换 TODO 3 的 `throw`：

```ts
if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
  return { ok: false, code: "PATH_OUTSIDE_WORKSPACE", error: `Path is outside workspace: ${options.inputPath}` };
}
```

在 TODO 4 后添加成功返回：

```ts
return { ok: true, path: resolve(realAncestor, ...missingParts) };
```

</details>

完成后运行
`bun test src/coding/tools/__tests__/tool-utils.test.ts`（完整测试见 8.6），检查以下行为：

- 相对路径；
- 正常绝对路径；
- `../` 越界；
- 相似前缀目录；
- 指向工作区外的符号链接；
- 尚不存在的目标文件。

### 8.2 Tool 实现配方

每个 Tool 按同一顺序实现：

1. 定义用户目标和最小输入；
2. Zod 参数定义的第一个字段放 `description`；
3. 验证路径、范围和大小；
4. 执行单一动作；
5. 成功时返回 `summary + data`；
6. 预期内的失败返回 `summary + error + code + details`；
7. 测试正常成功流程（happy path）、错误码和边界情况；
8. 注册到 `src/coding/tools/index.ts`。

阶段 8 给出三个完整示例：`read_file` 展示文件 Tool 的标准结构，`apply_patch` 展示
补丁解析、内容校验与写入，8.4 的 `bash` 展示子进程的资源管理。
其余工具提供独立的工厂函数、参数定义和分项 TODO；长代码可按需展开。
所有工厂函数都绑定可信 `cwd`，模型只能传入工具参数，不能修改工作区或输出上限。

| 阅读顺序 | 内容 | 实现方式 |
|---|---|---|
| 8.2.1 | 结果辅助函数 + `read_file` | 完整示例，先跑通全文件读取 |
| 8.3 | `str_replace` | 补齐读取、唯一替换、写入 |
| 8.4 | `bash` | 完整示例，逐段观察退出、截断和取消 |
| 8.2.2 | `file_info`、`list_files`、`glob_search`、`grep_search` | 按各自骨架补齐查询逻辑 |
| 8.2.3 | `mkdir`、`write_file`、`move_path` | 按各自骨架补齐修改逻辑 |
| 8.2.3 | `apply_patch` | 使用完整示例，观察修改块解析、校验和写入 |

骨架里的 `throw new Error("TODO: ...")` 是待替换的位置，不是最终错误处理。
成功返回 `okToolResult()`；预期失败返回 `errorToolResult(summary, error, code, details)`，
沿用阶段 3 的四参数签名。I/O 异常统一由下面的 `errorFromException()` 处理。

#### 8.2.1 完整示例：`read_file`

目标文件 `src/coding/tools/tool-result.ts`。复用阶段 3 的结果构造函数，并将不存在的路径
映射为 `FILE_NOT_FOUND`，取消映射为 `ABORTED`，其他异常使用各工具的失败错误码：

```ts
export { errorToolResult, okToolResult } from "@/foundation/tools";

export function errorFromException(error: unknown, fallbackCode: string, details?: Record<string, unknown>) {
  const message = error instanceof Error ? error.message : String(error);
  // 保留取消、文件不存在这两类可识别错误；其他异常使用工具传入的兜底错误码。
  const code = error instanceof Error && error.name === "AbortError" ? "ABORTED"
    : typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
      ? "FILE_NOT_FOUND" : fallbackCode;
  // as const 保留 ok 的字面量 false 类型，便于调用方按成功/失败分支收窄类型。
  return { ok: false as const, summary: message, error: message, code, details };
}
```

目标文件 `src/coding/tools/read-file.ts`。按“路径检查 → 读取 → 范围处理 → 截断”阅读。
全文件读取保留原文的末尾换行；指定范围时输出 `行号: 内容`。范围端点必须成对提供，
末尾换行产生的空项不计入行数；字符上限只限制保留的正文，超限追加 `[truncated]`。

<details>
<summary>展开完整示例：<code>read-file.ts</code></summary>

```ts
import { stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineReadFileTool(options: { cwd: string; maxCharacters?: number }) {
  // 工具通过闭包保留宿主指定的 workspace 和输出长度限制。
  return defineTool({
    name: "read_file",
    description: "Read a UTF-8 text file or a bounded line range",
    // Registry 会用这个 schema 校验参数；对外的行号从 1 开始。
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      startLine: z.number().int().positive().optional(),
      endLine: z.number().int().positive().optional(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        // 解析真实路径并检查 workspace 边界，后续只使用校验后的路径。
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);
        // stat 提供文件类型信息，isFile() 排除目录等非普通文件。
        if (!(await stat(resolved.path)).isFile()) {
          return errorToolResult("Not a file", input.path, "NOT_A_FILE");
        }

        const text = await Bun.file(resolved.path).text();
        const lines = text === "" ? [] : text.split("\n");
        // 末尾换行会让 split 多出一个空元素，不将它计为额外的一行。
        if (text.endsWith("\n")) lines.pop();
        let content = text;
        const { startLine, endLine } = input;

        if (startLine !== undefined || endLine !== undefined) {
          // 指定行范围时，起止行必须成对提供、顺序正确且不超出文件行数。
          if (startLine === undefined || endLine === undefined || startLine > endLine) {
            return errorToolResult("Invalid line range", input.path, "INVALID_LINE_RANGE");
          }
          if (startLine > lines.length) {
            return errorToolResult("Start line is out of range", input.path, "START_LINE_OUT_OF_RANGE");
          }
          if (endLine > lines.length) {
            return errorToolResult("End line is out of range", input.path, "INVALID_LINE_RANGE");
          }
          // slice 从 0 开始且不包含右端点；例如第 2～4 行对应 slice(1, 4)。
          // 为选中的文本加上原始行号，方便模型定位后续修改。
          content = lines.slice(startLine - 1, endLine)
            .map((line, index) => `${startLine + index}: ${line}`).join("\n");
        }

        // 文件读取期间也可能收到取消请求，因此返回前再检查一次。
        signal?.throwIfAborted();
        // 限制返回给模型的文本长度；此时文件已完整读入，限制的是输出量。
        const limit = options.maxCharacters ?? 12_000;
        const truncated = content.length > limit;
        if (truncated) content = `${content.slice(0, limit)}\n[truncated]`;
        return okToolResult(`Read ${input.path}`, { path: resolved.path, content, truncated });
      } catch (error) {
        // 将文件系统和取消异常转换为统一的工具失败结果。
        return errorFromException(error, "READ_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

先直接导入 `defineReadFileTool`，在临时文件上观察两种返回值：

```ts
const tool = defineReadFileTool({ cwd: workspace }); // workspace 是已创建的临时目录
await tool.invoke({ description: "Read the file", path: "input.ts" });
await tool.invoke({ description: "Read the first line", path: "input.ts", startLine: 1, endLine: 1 });
```

假设原文为 `const value = 1;\n`，两次的 `data.content` 分别是原文和
`1: const value = 1;`。后续骨架沿用同一套路径校验和结果处理，不需要重新设计工具契约。

#### 8.2.2 只读 Tool 骨架（8D）

先实现 `file_info` 和 `list_files`，再实现文件名模式匹配（glob，例如 `**/*.ts` 匹配各级目录下的 TypeScript 文件）和文本搜索。以下代码分别放入同名文件；
各 Tool 的输出字段与 8.5、8.6 一致。

`file_info`：使用 `stat()` 得到文件类型和字节大小。

<details>
<summary>展开骨架与 TODO：<code>file-info.ts</code></summary>

```ts
import { stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineFileInfoTool(options: { cwd: string }) {
  return defineTool({
    name: "file_info",
    description: "Inspect a file or directory",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：const info = await stat(resolved.path)。不存在由 catch 返回 FILE_NOT_FOUND。
        // TODO 2：用 info.isFile()/isDirectory() 得到 type: "file" | "directory"。
        // TODO 3：返回 okToolResult(summary, { path: resolved.path, type, size: info.size })。
        throw new Error("TODO: implement file_info");
      } catch (error) {
        return errorFromException(error, "FILE_INFO_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

`list_files`：列出请求目录的直接子项，排序后截取 `maxResults`；返回相对该目录的名称。

<details>
<summary>展开骨架与 TODO：<code>list-files.ts</code></summary>

```ts
import { readdir, stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineListFilesTool(options: { cwd: string; maxResults?: number; }) {
  return defineTool({
    name: "list_files",
    description: "List the immediate entries in a directory",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：stat 后确认是目录；否则用 errorToolResult(summary, error, "NOT_A_DIRECTORY") 返回。
        // TODO 2：await readdir(resolved.path) 得到直接子项名称，不需要递归；先 sort()。
        // TODO 3：limit = options.maxResults ?? 200；entries = names.slice(0, limit)。
        // TODO 4：返回 { entries, truncated: names.length > limit }，而非只返回 ok。
        throw new Error("TODO: implement list_files");
      } catch (error) {
        return errorFromException(error, "LIST_FILES_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

`glob_search`：用 `Bun.Glob` 枚举候选；确认候选仍在工作区内，再返回相对工作区的路径。
扫描 API 可对照 [Bun Glob 文档](https://bun.com/docs/runtime/glob)。

<details>
<summary>展开骨架与 TODO：<code>glob-search.ts</code></summary>

```ts
import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineGlobSearchTool(options: { cwd: string; maxResults?: number; }) {
  return defineTool({
    name: "glob_search",
    description: "Find paths matching a glob pattern",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      pattern: z.string(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：确认 resolved.path 是目录；否则返回 NOT_A_DIRECTORY。
        // TODO 2：new Bun.Glob(input.pattern).scan({ cwd: resolved.path, onlyFiles: true, followSymlinks: false })。
        // 用 for await 消费结果；每个候选以 resolved.path 为基准再次 resolveWorkspacePath，跳过越界项。
        // TODO 3：realCwd = await realpath(options.cwd)，用 relative(realCwd, candidate.path)
        // 将通过校验的路径转换为相对 workspace 的路径；排序后再截取 maxResults ?? 200。
        // TODO 4：返回 { paths, truncated }；truncated 表示匹配总数超过上限。
        throw new Error("TODO: implement glob_search");
      } catch (error) {
        return errorFromException(error, "GLOB_SEARCH_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

`grep_search`：先复用文件枚举思路，再逐行匹配。`regex` 默认为 false，表示普通文本查找；
true 时使用正则。这里直接读取 UTF-8 文本实现，不依赖额外安装 `rg`。

<details>
<summary>展开骨架与 TODO：<code>grep-search.ts</code></summary>

```ts
import { realpath, stat } from "node:fs/promises";
import { relative } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineGrepSearchTool(options: { cwd: string; maxResults?: number; }) {
  return defineTool({
    name: "grep_search",
    description: "Search UTF-8 text files by text or regex",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      pattern: z.string(),
      regex: z.boolean().optional(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：确认是目录；regex 为 true 时构造 new RegExp(input.pattern)，否则用 includes。
        // TODO 2：用 Bun.Glob("**/*") 枚举文件（scan 选项同 glob_search），按路径排序。
        // 每个候选再次验证 workspace 边界后，才用 Bun.file(candidate.path).text() 读取。
        // TODO 3：逐行匹配；每条结果为 { path: relative(realCwd, candidate.path), line: index + 1, text }。
        // realCwd = await realpath(options.cwd)；末尾换行产生的空项不计作一行。
        // TODO 4：保留 maxResults ?? 200 条；再找到一条时 truncated=true，可以结束搜索。
        // 返回 { matches, truncated }；没有匹配是成功，matches 为 []。
        throw new Error("TODO: implement grep_search");
      } catch (error) {
        return errorFromException(error, "GREP_SEARCH_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

#### 8.2.3 修改型 Tools（8E）

`mkdir`：完成路径校验后创建目录，`recursive` 默认 true。

<details>
<summary>展开骨架与 TODO：<code>mkdir.ts</code></summary>

```ts
import { mkdir } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineMkdirTool(options: { cwd: string }) {
  return defineTool({
    name: "mkdir",
    description: "Create a directory inside the workspace",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      recursive: z.boolean().optional(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：写入前再检查 signal；await mkdir(resolved.path, { recursive: input.recursive ?? true })。
        // TODO 2：返回 okToolResult(summary, { path: resolved.path })。
        throw new Error("TODO: implement mkdir");
      } catch (error) {
        return errorFromException(error, "MKDIR_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

`write_file`：准备父目录，然后创建或覆盖文件。

<details>
<summary>展开骨架与 TODO：<code>write-file.ts</code></summary>

```ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineWriteFileTool(options: { cwd: string }) {
  return defineTool({
    name: "write_file",
    description: "Create or overwrite a UTF-8 text file",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      content: z.string(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：await mkdir(dirname(resolved.path), { recursive: true }) 准备父目录。
        // TODO 2：写入前再检查 signal；await Bun.write(resolved.path, input.content)。
        // TODO 3：返回 okToolResult(summary, { path: resolved.path })。
        // 此 Tool 明确允许覆盖已有文件；修改现有片段时使用 str_replace。
        throw new Error("TODO: implement write_file");
      } catch (error) {
        return errorFromException(error, "WRITE_FILE_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

`move_path`：源与目标都必须通过工作区边界检查，源必须存在，再调用 `rename()`。

<details>
<summary>展开骨架与 TODO：<code>move-path.ts</code></summary>

```ts
import { rename, stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineMovePathTool(options: { cwd: string }) {
  return defineTool({
    name: "move_path",
    description: "Move or rename a file or directory inside the workspace",
    parameters: z.object({ description: z.string(), from: z.string(), to: z.string() }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const source = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.from });
        if (!source.ok) return errorToolResult(source.error, source.error, source.code);
        const target = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.to });
        if (!target.ok) return errorToolResult(target.error, target.error, target.code);

        // TODO 1：await stat(source.path) 确认源存在；ENOENT 由 catch 转为 FILE_NOT_FOUND。
        // TODO 2：移动前检查 signal；await rename(source.path, target.path)。
        // TODO 3：返回 okToolResult(summary, { from: source.path, to: target.path })。
        throw new Error("TODO: implement move_path");
      } catch (error) {
        return errorFromException(error, "MOVE_FAILED", { from: input.from, to: input.to });
      }
    },
  });
}
```

</details>

`apply_patch`：解析 unified diff，再根据原文**校验和应用修改块**。
**hunk（修改块）**：补丁中描述一处局部修改的单元，以 `@@ ... @@` 开头，后面跟着这一处的
上下文行、删除行和新增行。一个文件可以有多个修改块，一份补丁也可以涉及多个文件。

这里直接提供完整实现，不再作为待补齐的练习。实现沿用 `harness-coding-lab` 的
`src/coding/tools/apply-patch.ts`，移除了已完成步骤的待办标记。
解析和内容匹配拆成两个纯函数，与磁盘写入分开；已支持多个修改块和多个文件。
先用下面只有一个修改块的单文件更新理解输入格式：

```diff
--- a/input.ts
+++ b/input.ts
@@ -1 +1 @@
-const value = 1;
+const value = 2;
```

`---` 和 `+++` 分别标出修改前、后的文件路径。`@@ -1 +1 @@` 是修改块头（hunk header），
表示修改前、后都从第 1 行开始，各涉及 1 行，等价于 `@@ -1,1 +1,1 @@`。
代码里的 `oldStart/newStart` 对应起始行号，`oldCount/newCount` 对应涉及的行数。

修改块内部用行首字符区分三种行：以空格开头的是未修改、需要与原文匹配的上下文行；
`-` 开头的行要删除；`+` 开头的行要新增。上例没有上下文行，只把 `const value = 1;`
替换为 `const value = 2;`。注意“以空格开头的行”不等于“空白行”。
格式说明见 [GNU unified diff 文档](https://www.gnu.org/software/diffutils/manual/html_node/Detailed-Unified.html)。

路径检查使用本教程的
`resolveWorkspacePath()`；新增文件使用 `--- /dev/null`，文件删除不在这个 Tool 的契约内。
所有文件的路径和内容都校验通过后才开始写入；写入阶段发生 I/O 错误或取消时，不提供跨文件回滚。

<details>
<summary>展开完整实现：<code>apply-patch.ts</code></summary>

```ts
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: { kind: "context" | "delete" | "add"; text: string }[];
}

interface PatchFile {
  oldPath: string;
  newPath: string;
  hunks: PatchHunk[];
}

function parsePatch(patch: string): PatchFile[] {
  // 一个 patch 可以修改多个文件；先拆成行，再逐个收集文件信息。
  const lines = patch.split(/\r?\n/);
  const files: PatchFile[] = [];
  // 记录当前文件，将解析出的 hunk 放进它的 hunks。
  let currentFile: PatchFile | undefined;

  const readHeaderPath = (header: string): string => {
    // "--- " 和 "+++ " 都占 4 个字符；制表符后可能附带时间戳。
    // 只按制表符拆分，保留文件名中合法的空格。
    const rawPath = header.slice(4).split("\t")[0] ?? "";
    // 只删除开头的 a/ 或 b/；/dev/null 和没有这些前缀的路径保持原样。
    const path = rawPath.replace(/^[ab]\//, "");
    if (path === "") throw new Error("Missing path in patch file header");
    return path;
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    if (line?.startsWith("--- ")) {
      // 文件头必须成对出现：先是旧路径，再是新路径。
      const newHeader = lines[index + 1];
      if (!newHeader?.startsWith("+++ ")) {
        throw new Error("Expected +++ file header after --- file header");
      }

      currentFile = {
        oldPath: readHeaderPath(line),
        newPath: readHeaderPath(newHeader),
        hunks: [],
      };
      files.push(currentFile);

      // +++ 行已在上面处理；加上 for 自身的 index++，下一轮从它后面开始。
      index++;
      continue;
    }

    const header = line?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!header) continue;
    if (!currentFile) throw new Error("Hunk found before file headers");

    const hunk: PatchHunk = {
      oldStart: Number(header[1]),
      oldCount: Number(header[2] ?? 1),
      newStart: Number(header[3]),
      newCount: Number(header[4] ?? 1),
      lines: [],
    };
    let oldLines = 0;
    let newLines = 0;

    while (index + 1 < lines.length) {
      const body = lines[index + 1]!;
      // 行数已满足时，成对的 ---/+++ 才作为下一份文件头处理。
      if (
        oldLines >= hunk.oldCount &&
        newLines >= hunk.newCount &&
        body.startsWith("--- ") &&
        lines[index + 2]?.startsWith("+++ ")
      )
        break;
      if (body === "\\ No newline at end of file") {
        index++;
        continue;
      }

      const kind =
        body[0] === " "
          ? "context"
          : body[0] === "-"
            ? "delete"
            : body[0] === "+"
              ? "add"
              : undefined;
      if (!kind) break;

      hunk.lines.push({ kind, text: body.slice(1) });
      if (kind !== "add") oldLines++;
      if (kind !== "delete") newLines++;
      index++;
    }
    // 复用扫描时的计数，确认正文与 header 声明的旧、新行数一致。
    if (oldLines !== hunk.oldCount || newLines !== hunk.newCount) {
      throw new Error(`Hunk line count mismatch in ${currentFile.newPath}`);
    }
    currentFile.hunks.push(hunk);
  }

  if (files.length === 0) throw new Error("Patch contains no file headers");
  for (const file of files) {
    if (file.hunks.length === 0) throw new Error(`No hunks found for ${file.newPath}`);
  }
  return files;
}

function applyHunks(original: string, hunks: PatchHunk[]): string {
  // 将原文按行拆分，记录原文是否以换行结尾；末尾空项不作为正文行。
  const hasTrailingNewline = original.endsWith("\n");
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const source = original === "" ? [] : original.split(/\r?\n/);
  if (hasTrailingNewline) source.pop();

  // 保持 sourceIndex 和 output；先拷贝 hunk 前未改动的原文行。
  // oldStart 是 1-based；空文件插入 hunk 的 oldStart=0。当前位置已越过 hunk 时拒绝。
  let sourceIndex = 0;
  const output: string[] = [];
  for (const hunk of hunks) {
    if (
      ![hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount].every(Number.isSafeInteger) ||
      hunk.oldCount < 0 ||
      hunk.newCount < 0 ||
      hunk.oldStart < (hunk.oldCount === 0 ? 0 : 1) ||
      hunk.newStart < (hunk.newCount === 0 ? 0 : 1)
    ) {
      throw new Error("Invalid hunk range");
    }

    // count=0 表示在 start 行之后插入；此时 start 已是对应的数组位置。
    const oldIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const newIndex = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (oldIndex < sourceIndex || oldIndex + hunk.oldCount > source.length) {
      throw new Error("Hunk overlaps a previous hunk or exceeds the original file");
    }
    while (sourceIndex < oldIndex) output.push(source[sourceIndex++]!);
    // 未改动的前文复制完后，输出长度应与 header 声明的新文件位置一致。
    if (output.length !== newIndex) throw new Error("Hunk newStart does not match output position");

    // context/delete 行必须与 source[sourceIndex] 相等，否则 throw。
    // context 拷贝并前移，delete 只前移，add 只追加；后续 hunk 的坐标仍以原文为基准。
    for (const line of hunk.lines) {
      if (line.kind === "add") {
        output.push(line.text);
        continue;
      }
      if (source[sourceIndex] !== line.text) {
        throw new Error(`Patch content mismatch at original line ${sourceIndex + 1}`);
      }
      if (line.kind === "context") output.push(line.text);
      sourceIndex++;
    }
  }

  // 拷贝原文剩余行，join("\n") 并保留原文末尾换行。
  while (sourceIndex < source.length) output.push(source[sourceIndex++]!);
  // 沿用原文的 LF/CRLF 和末尾换行约定；删光正文时返回空字符串。
  const content = output.join(newline);
  return output.length > 0 && hasTrailingNewline ? content + newline : content;
}

export function defineApplyPatchTool(options: { cwd: string }) {
  return defineTool({
    name: "apply_patch",
    description: "Apply a unified diff patch inside the workspace",
    parameters: z.object({ description: z.string(), patch: z.string() }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const files = parsePatch(input.patch);
        const changes: { path: string; content: string }[] = [];
        const targets = new Set<string>();
        // 逐个文件验证 oldPath/newPath 的 workspace 边界（跳过 /dev/null），失败时保留原 code 返回。
        // 用 resolveWorkspacePath({ cwd: options.cwd, inputPath: file.newPath })，不要直接信任 patch 路径。
        for (const file of files) {
          signal?.throwIfAborted();
          const source =
            file.oldPath === "/dev/null"
              ? null
              : await resolveWorkspacePath({
                  cwd: options.cwd,
                  inputPath: file.oldPath,
                });
          if (source && !source.ok) return errorToolResult(source.error, source.error, source.code);
          const target =
            file.newPath === "/dev/null"
              ? null
              : await resolveWorkspacePath({
                  cwd: options.cwd,
                  inputPath: file.newPath,
                });
          if (target && !target.ok) return errorToolResult(target.error, target.error, target.code);

          // 普通更新读取旧文件；--- /dev/null 表示新增，原文取 ""；不支持删除文件。
          // 用 applyHunks(original, file.hunks) 得到新文本；先完成内容校验，再写入对应文件。
          if (!target) throw new Error("Deleting files is not supported");
          if (targets.has(target.path)) throw new Error(`Duplicate patch target: ${file.newPath}`);
          if (!source && (await Bun.file(target.path).exists())) {
            throw new Error(`Cannot add an existing file: ${file.newPath}`);
          }
          const original = source ? await Bun.file(source.path).text() : "";
          signal?.throwIfAborted();
          changes.push({ path: target.path, content: applyHunks(original, file.hunks) });
          targets.add(target.path);
        }

        // 准备目标父目录，检查 signal，用 Bun.write 写入；记录 changedPaths。
        // 所有文件校验通过后才开始写入；写入阶段的 I/O 失败不具备跨文件回滚能力。
        const changedPaths: string[] = [];
        for (const change of changes) {
          signal?.throwIfAborted();
          await mkdir(dirname(change.path), { recursive: true });
          signal?.throwIfAborted();
          await Bun.write(change.path, change.content);
          changedPaths.push(change.path);
        }

        // 返回 okToolResult(summary, { paths: changedPaths })。
        return okToolResult(`Applied patch to ${changedPaths.length} files`, {
          paths: changedPaths,
        });
      } catch (error) {
        return errorFromException(error, "PATCH_APPLY_FAILED");
      }
    },
  });
}
```

</details>

建议固定以下错误码：

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
- 成功时在 `data` 中返回替换位置和修改后的摘要。

这能阻止模型的局部意图意外变成全局修改。

目标文件 `src/coding/tools/str-replace.ts`。下面补齐工厂函数与参数定义；
`oldText` 必须非空，`newText` 可以为空。按四个 TODO 完成读取、匹配、替换和写入：

<details>
<summary>展开骨架与 TODO：<code>str-replace.ts</code></summary>

```ts
import { stat } from "node:fs/promises";

import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";
import { resolveWorkspacePath } from "./tool-utils";

export function defineStrReplaceTool(options: { cwd: string }) {
  return defineTool({
    name: "str_replace",
    description: "Replace exactly one literal occurrence",
    parameters: z.object({
      description: z.string(),
      path: z.string(),
      oldText: z.string().min(1),
      newText: z.string(),
    }),
    invoke: async (input, signal) => {
      try {
        signal?.throwIfAborted();
        const resolved = await resolveWorkspacePath({ cwd: options.cwd, inputPath: input.path });
        if (!resolved.ok) return errorToolResult(resolved.error, resolved.error, resolved.code);

        // TODO 1：stat 确认普通文件（否则 NOT_A_FILE），再用 Bun.file(resolved.path).text() 读取 original。
        // TODO 2：matches = original.split(input.oldText).length - 1。
        // 0 次返回 PATTERN_NOT_FOUND，多次返回 AMBIGUOUS_REPLACEMENT，均不能写文件。
        // TODO 3：updated = original.replace(input.oldText, () => input.newText)。
        // callback 保证 $&、$1 等被当作普通文本；不要直接把 newText 当替换表达式。
        // TODO 4：写入前检查 signal，Bun.write(resolved.path, updated)。
        // 返回 okToolResult(summary, { path: resolved.path, replacements: 1 })。
        throw new Error("TODO: implement str_replace");
      } catch (error) {
        return errorFromException(error, "STR_REPLACE_FAILED", { path: input.path });
      }
    },
  });
}
```

</details>

先在临时文件上手动跑通“读 → 替换 → 再读”，再用 8.6 检查 0/多匹配时文件保持不变，
以及 `$&` 等文本不会被当成替换表达式。

### 8.4 `bash` 的边界

`bash` 工具负责进程执行和结果捕获，不负责自行决定是否安全。审批由阶段 10 的审批中间件完成。

必须支持：

- 明确的 `cwd`；
- 标准输出（stdout）、标准错误输出（stderr）和退出码（exit code）；
- 超时处理；
- 收到 `AbortSignal` 取消信号时终止子进程；
- 输出大小上限和截断标记，例如 `[truncated]`；
- 退出码非零时返回包含错误码等字段的结构化错误。

不要把命令插入另一层未转义的 shell 字符串。若接口接收完整的 shell 命令，应明确它会交由 shell 解释执行，并把原始命令展示在审批界面。

本课程的 `bash` 示例面向 macOS/Linux。先实现普通命令，再增加下面这些资源所有权：

| 资源 | 创建位置 | 结束条件 |
|---|---|---|
| 子进程及进程组 | `Bun.spawn(["bash", "-c", command], { cwd, detached: true, ... })` | 正常退出，或超时、取消后终止整个进程组 |
| 标准输出与错误输出的读取器 | 启动子进程后立即并发读取 | 读到流结束；达到保留上限后继续读取，丢弃多余正文 |
| 超时计时器 | 启动子进程后 | 所有退出路径都调用 `clearTimeout` |
| 取消事件监听器 | 启动子进程前检查，启动后注册并再检查一次 | 在 `finally` 中移除 |

这里的“继续读取直到流结束”也叫 drain：即使不再保留正文，也要把后续输出读走，
避免输出管道写满后子进程无法继续。EOF 表示已经读到流末尾，没有后续数据。

目标文件 `src/coding/tools/bash.ts`。这是第二个完整示例，沿用上面的现有要求。
建议按 `captureOutput()` → `stop()` → 结果分支 → `finally` 的顺序阅读：

- 两个读取器同时启动，各自最多保留 `maxOutputCharacters` 个正文字符，之后继续读取并丢弃超出部分；
- `stop()` 只记录第一次超时或取消，先终止进程组，再等待 100ms 宽限期并发送 SIGKILL（强制终止信号）；
- 等子进程和两个读取器都结束，才返回结果并清理计时器和监听器。

<details>
<summary>展开完整示例：<code>bash.ts</code></summary>

```ts
import { z } from "zod";

import { defineTool } from "@/foundation/tools";

import { errorFromException, errorToolResult, okToolResult } from "./tool-result";

// 达到保留上限后继续读到 EOF，避免子进程因 pipe 填满而阻塞。
async function captureOutput(stream: ReadableStream<Uint8Array>, limit: number) {
  // reader 独占读取该流；TextDecoder 默认将输出字节按 UTF-8 解码。
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let truncated = false;
  const retain = (text: string) => {
    // 只保留剩余空间内的文本；空间用完后仍读取，但不再追加内容。
    const remaining = Math.max(0, limit - content.length);
    content += text.slice(0, remaining);
    // ||= 保留已有的 true，只要发生过截断就不会再恢复为 false。
    truncated ||= text.length > remaining;
  };
  try {
    while (true) {
      // await 等待下一块输出，不会空转；done 表示已经读到流末尾（EOF）。
      const { done, value } = await reader.read();
      if (done) break;
      // stream: true 保留解码状态，处理一个 UTF-8 字符被拆到不同块的情况。
      retain(decoder.decode(value, { stream: true }));
    }
    // 输入结束后刷新 decoder，处理内部尚未输出的内容。
    retain(decoder.decode());
    return { content: truncated ? `${content}\n[truncated]` : content, truncated };
  } finally {
    // 成功或抛错都释放读取锁，避免该流一直被这个 reader 占用。
    reader.releaseLock();
  }
}

function signalProcessGroup(pid: number, signal: "SIGTERM" | "SIGKILL") {
  try {
    // macOS/Linux 上负 PID 指向整个进程组，包含仍留在组内的命令后代。
    process.kill(-pid, signal);
  } catch (error) {
    // ESRCH 表示进程组已不存在，可忽略；其他错误继续交给调用方处理。
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

export function defineBashTool(options: {
  cwd: string;
  timeoutMs?: number;
  maxOutputCharacters?: number;
}) {
  // 创建工具时保留宿主配置，真正的命令执行发生在 invoke 被调用时。
  return defineTool({
    name: "bash",
    description: "Execute a shell command and capture its output",
    // Registry 用 schema 校验每次调用的参数；实际执行的是 command。
    parameters: z.object({ description: z.string(), command: z.string() }),
    invoke: async (input, signal) => {
      // 调用开始前就已取消时，直接返回，避免启动子进程。
      if (signal?.aborted) return errorToolResult("Command aborted", input.command, "ABORTED");
      try {
        // -c 让 Bash 解析整段命令；spawn 返回进程对象，不等待命令完成。
        const child = Bun.spawn(["bash", "-c", input.command], {
          // cwd 只设置初始工作目录，命令仍可通过 cd 等方式切换目录。
          cwd: options.cwd,
          // 创建独立进程组，组长 PID 用于后续向整组发送终止信号。
          detached: true,
          // 不提供交互式输入；通过 pipe 捕获标准输出和标准错误。
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        });
        // stdout、stderr 各自应用此上限，长度按 JS 字符串的 length 计数。
        const limit = options.maxOutputCharacters ?? 12_000;
        // 立即同时读取两条流，暂不 await，避免某条 pipe 填满后卡住子进程。
        const stdoutTask = captureOutput(child.stdout, limit);
        const stderrTask = captureOutput(child.stderr, limit);
        const state: { reason?: "exit" | "timeout" | "abort" } = {};
        // ReturnType 提取定时器句柄类型；Promise<void> 只表示升级终止步骤完成。
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        let escalationTask: Promise<void> | undefined;

        const stop = (reason: "timeout" | "abort") => {
          // 保留首次记录的停止原因，避免超时和取消重复安排终止操作。
          if (state.reason !== undefined) return;
          state.reason = reason;
          // 先请求退出，给进程自行收尾的机会。
          signalProcessGroup(child.pid, "SIGTERM");
          // 约 100ms 后强制终止仍在组内的进程，并用 Promise 跟踪这一步。
          escalationTask = new Promise((resolve, reject) => {
            killTimer = setTimeout(() => {
              try {
                signalProcessGroup(child.pid, "SIGKILL");
                resolve();
              } catch (error) {
                reject(error);
              }
            }, 100);
          });
        };
        const onAbort = () => stop("abort");
        // 超时和外部取消共用 stop；定时器到期才调用 callback，不阻塞当前函数。
        const timeoutTimer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 10_000);

        try {
          // once: true 让监听器触发一次后自动移除。
          signal?.addEventListener("abort", onAbort, { once: true });
          // 已取消的 signal 不会补发 abort 事件，注册后再检查一次以免漏掉。
          if (signal?.aborted) onAbort();
          // 同时等待退出码和两条流读完；进程退出时可能还有输出尚未读取。
          const [exitCode, stdout, stderr] = await Promise.all([child.exited, stdoutTask, stderrTask]);
          // 等待宽限期结束，收回仍留在进程组内的后代。
          // 正常完成时任务为 undefined，await 不需要等待任何异步任务。
          await escalationTask;
          // ??= 只在原因未设置时记为正常退出，保留已有的 timeout/abort。
          state.reason ??= "exit";
          const data = {
            stdout: stdout.content,
            stderr: stderr.content,
            exitCode,
            truncated: stdout.truncated || stderr.truncated,
          };
          // 优先返回取消或超时原因；被终止后的非零退出码不能覆盖这些原因。
          if (state.reason === "abort")
            return errorToolResult("Command aborted", input.command, "ABORTED", data);
          if (state.reason === "timeout")
            return errorToolResult("Command timed out", input.command, "COMMAND_TIMED_OUT", data);
          if (exitCode !== 0) return errorToolResult("Command failed", input.command, "COMMAND_FAILED", data);
          return okToolResult("Command completed", data);
        } catch (error) {
          // reader 等执行环节失败时，也要收回子进程和两个 pipe。
          signalProcessGroup(child.pid, "SIGKILL");
          // 清理时即使某个任务失败，也等其余任务结束，再抛出原始异常。
          await Promise.allSettled([child.exited, stdoutTask, stderrTask]);
          throw error;
        } finally {
          // return 或抛错也会执行，清除定时器和监听器，避免执行结束后再触发。
          clearTimeout(timeoutTimer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          signal?.removeEventListener("abort", onAbort);
        }
      } catch (error) {
        // 内层负责收尾，这里将传播出来的异常转换为统一的工具失败结果。
        return errorFromException(error, "COMMAND_FAILED", { command: input.command });
      }
    },
  });
}
```

</details>

`Bun.spawn()` 的参数与输出管道读取可对照 [Bun 子进程文档](https://bun.com/docs/runtime/child-process)。
先运行 8.6 的普通命令测试，再观察输出上限、超时和运行中取消的测试。

只调用 `child.kill()` 可能留下 shell 启动的孙进程。8.6 会启动一个延迟写文件的孙进程，
检查取消后它没有继续产生副作用。不要用 `Promise.race` 返回超时后就丢弃仍在运行的进程。

### 8.5 组装 Coding Tools

目标文件：`src/coding/tools/index.ts`

各 Tool 完成后，用 `defineCodingTools()` 组装。下面给出完整接线代码；
所有文件系统工具共享 `cwd`，组装时把各项上限转发到需要它们的工厂函数。
在 8A～8C 迭代时仍直接导入当前工厂函数，避免尚未实现的模块阻塞验证。

<details>
<summary>展开完整示例：<code>index.ts</code></summary>

```ts
import type { Tool } from "@/foundation/tools";

import { defineApplyPatchTool } from "./apply-patch";
import { defineBashTool } from "./bash";
import { defineFileInfoTool } from "./file-info";
import { defineGlobSearchTool } from "./glob-search";
import { defineGrepSearchTool } from "./grep-search";
import { defineListFilesTool } from "./list-files";
import { defineMkdirTool } from "./mkdir";
import { defineMovePathTool } from "./move-path";
import { defineReadFileTool } from "./read-file";
import { defineStrReplaceTool } from "./str-replace";
import { defineWriteFileTool } from "./write-file";

export interface DefineCodingToolsOptions {
  cwd: string;
  bashTimeoutMs?: number;
  maxOutputCharacters?: number;
  maxResults?: number;
}

export function defineCodingTools(options: DefineCodingToolsOptions): Tool[] {
  return [
    defineFileInfoTool(options),
    defineListFilesTool(options),
    defineGlobSearchTool(options),
    defineGrepSearchTool(options),
    defineReadFileTool({ cwd: options.cwd, maxCharacters: options.maxOutputCharacters }),
    defineMkdirTool(options),
    defineWriteFileTool(options),
    defineStrReplaceTool(options),
    defineApplyPatchTool(options),
    defineMovePathTool(options),
    defineBashTool({ cwd: options.cwd, timeoutMs: options.bashTimeoutMs, maxOutputCharacters: options.maxOutputCharacters }),
  ];
}

export {
  defineApplyPatchTool, defineBashTool, defineFileInfoTool, defineGlobSearchTool,
  defineGrepSearchTool, defineListFilesTool, defineMkdirTool, defineMovePathTool,
  defineReadFileTool, defineStrReplaceTool, defineWriteFileTool,
};
```

</details>

8D/8E 的输出字段固定如下，便于测试内容而不是只测试 `ok`：

| 工具 | 成功结果中 `data` 的必要字段 |
|---|---|
| `file_info` | `path`（绝对路径）、`type`（`file`/`directory`）、`size` |
| `list_files` | `entries`（相对请求目录的名称，排序）、`truncated` |
| `glob_search` | `paths`（相对 cwd 的路径，排序）、`truncated` |
| `grep_search` | `matches: { path, line, text }[]`，path 相对 cwd、line 从 1 开始；`truncated` |
| `read_file` | `path`、`content`、`truncated` |
| 修改型 Tools | 被修改的路径；测试另从磁盘读取最终结果 |
| `bash` | `stdout`、`stderr`、`exitCode`、`truncated` |

`maxResults` 控制 list/glob/grep 的条数；`maxOutputCharacters` 转发为 read_file 的
`maxCharacters`，并控制 bash 保留的输出正文。上限由组装工具的调用方配置，不能由模型放大。

参数规则：所有工具输入的首字段都是 `description`；文件路径相对固定 `cwd`；
`startLine/endLine` 从 1 开始计数且必须成对出现；bash 超时时间由组装工具的调用方配置。

目标文件：`examples/stage-08-coding-tools.ts`

示例在系统临时目录中准备测试文件，三种模式都通过工具的公开接口操作。结束时输出
工作区修改前后的简化差异，并在 `finally` 中删除临时目录。

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

创建一个用于测试的临时项目目录，依次运行：

```bash
bun run examples/stage-08-coding-tools.ts inspect
bun run examples/stage-08-coding-tools.ts edit
bun run examples/stage-08-coding-tools.ts reject-path
```

示例最后打印工作区修改前后的差异，而不只是打印 `ok: true`。你应能看到每个工具对外部世界造成的具体变化。

### 8.6 完整测试

目标文件：`src/coding/tools/__tests__/tool-utils.test.ts`

每个文件系统工具都依赖这里固定的工作区边界。下面是完整测试文件：

<details>
<summary>展开完整代码：<code>tool-utils.test.ts</code></summary>

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { resolveWorkspacePath } from "../tool-utils";

let workspace: string;
let outside: string;

beforeEach(async () => {
  // macOS 的 tmpdir() 可能经过 /var symlink；预期值也统一为真实路径。
  workspace = await realpath(await mkdtemp(join(tmpdir(), "harness-lab-tool-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "harness-lab-outside-")));
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
      "--- a/input.ts",
      "+++ b/input.ts",
      "@@ -1 +1 @@",
      "-const value = 1;",
      "+const value = 2;",
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


### 验收

- [ ] 所有修改型 Tool 都有副作用测试；
- [ ] 通过 `../` 访问工作区外部，以及符号链接越界，都被拒绝；
- [ ] `str_replace` 不做隐式多处替换；
- [ ] bash 超时和取消不遗留子进程；
- [ ] 输出有大小上限；
- [ ] `ADR-009` 解释为什么采用多个窄 Tool。

## 阶段 9：组装 Coding Agent、Skills、Todo 与 `AGENTS.md`

> 上一阶段回顾：阶段 8 建立了一组职责单一的 Coding Tools，统一了工作区边界、结构化结果、超时与中止行为。

现在为这些工具补上工作所需的上下文：项目有哪些约束、有哪些可用 Skill、任务做到哪里，
以及信息不足时如何等待用户回答。先依次完成这些能力，再把它们组装成 Coding Agent，
最后运行一次完整的离线对话。每节的代码只依赖前面已经完成的内容，测试也放在对应实现之后。

文件读取、目录扫描、格式化等辅助代码直接给出；需要你动手的部分放在上下文注入、
状态更新、异步等待和 Agent 组装上。遇到 `throw new Error("TODO: ...")` 时，
用该处要求的逻辑替换占位错误；测试文件不需要补 TODO。

### 9.1 读取 `AGENTS.md`

`AGENTS.md` 保存工作区的项目约束。先写一个独立读取函数：不存在时返回空字符串，
超过长度限制时截断注入文本并发出警告。它返回普通字符串，还不依赖 Coding Agent。

在练习项目中创建文件：

```bash
mkdir -p src/coding/agents/__tests__
touch src/coding/agents/project-guidance.ts src/coding/agents/__tests__/project-guidance.test.ts
```

目标文件：`src/coding/agents/project-guidance.ts`。文件 I/O 沿用阶段 8 的写法，直接给出实现：

```ts
import { join } from "node:path";

export async function readProjectGuidance(options: {
  cwd: string;
  maxCharacters?: number;
  onWarning?: (message: string) => void;
}): Promise<string> {
  const path = join(options.cwd, "AGENTS.md");
  const limit = options.maxCharacters ?? 12_000;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error("maxGuidanceCharacters must be a non-negative integer");
  }
  let content: string;
  try {
    content = await Bun.file(path).text();
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error; // 无权限或 I/O 故障不是“文件不存在”。
  }
  if (content.length > limit) options.onWarning?.(`Truncated AGENTS.md: ${path} to ${limit} characters`);
  return content.slice(0, limit);
}
```

注意 `catch` 中只把 `ENOENT` 当作缺失；无权限或 I/O 故障仍向外抛出。
这里的字符上限按 JavaScript 字符串长度计算，限制的是注入模型的文本，不是 token 数，
也不是读取文件时的内存上限。原文件不会被截断。

`AGENTS.md` 会在创建 Agent 时重新加载。本阶段只读取工作区根目录，不实现父目录继承、
热加载或追踪存储；阶段 11 加入 trace 后再记录路径与内容哈希。

目标文件：`src/coding/agents/__tests__/project-guidance.test.ts`。以下测试完整复制：

<details>
<summary>展开测试：<code>project-guidance.test.ts</code></summary>

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readProjectGuidance } from "../project-guidance";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "harness-guidance-"));
  roots.push(cwd);
  return cwd;
}

describe("project guidance", () => {
  test("treats a missing AGENTS.md as empty guidance", async () => {
    const warnings: string[] = [];
    expect(await readProjectGuidance({
      cwd: await workspace(), onWarning: (message) => warnings.push(message),
    })).toBe("");
    expect(warnings).toEqual([]);
  });

  test("truncates the injected text and reports the source path", async () => {
    const cwd = await workspace();
    const path = join(cwd, "AGENTS.md");
    await Bun.write(path, "123456");
    const warnings: string[] = [];
    expect(await readProjectGuidance({
      cwd, maxCharacters: 4, onWarning: (message) => warnings.push(message),
    })).toBe("1234");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(await Bun.file(path).text()).toBe("123456");
  });
});
```

</details>

运行：

```bash
bun test src/coding/agents/__tests__/project-guidance.test.ts
```

应看到两项测试通过：缺失文件得到空字符串，`123456` 在上限为 4 时得到 `1234` 和一次警告。
有了这条稳定的读取路径，下一步再处理需要按需加载的 Skill。

### 9.2 发现 Skills，并把目录交给模型

`AGENTS.md` 的内容默认加载；Skill 的完整内容只在被选择后加载。发现阶段向模型提供名称、简介和
精确路径，模型随后通过已有的 `read_file` 读取正文，再由 `tool_result` 带回对话。

创建文件并安装 YAML 解析依赖：

```bash
bun add yaml
mkdir -p src/agent/skills/__tests__
touch src/agent/skills/skill-reader.ts src/agent/skills/skills-middleware.ts src/agent/skills/index.ts
touch src/agent/skills/__tests__/skill-reader.test.ts src/agent/skills/__tests__/skills-middleware.test.ts
```

#### 9.2.1 先准备元数据读取

frontmatter 是 Markdown 开头由两行 `---` 包围的 YAML 元数据。下面是一份完整的
`SKILL.md` 示例；名称和简介进入目录，最后一段工作说明属于正文：

```yaml
---
name: test-writer
description: Use when adding or repairing automated tests.
---

# Test Writer

Read the source, add a focused test, then run that test.
```

目标文件：`src/agent/skills/skill-reader.ts`。扫描、解析、去重和错误隔离提供完整实现，
后面的练习集中在“这些信息怎样进入模型请求”。发现阶段需要读取文件解析 frontmatter，
但返回的 descriptor 只保留 `name`、`description`、`path`，不携带正文。

<details>
<summary>展开完整辅助实现：<code>skill-reader.ts</code></summary>

```ts
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";

import { parse } from "yaml";
import { z } from "zod";

export interface SkillDescriptor {
  name: string;
  description: string;
  path: string;
}

const skillMetadataSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
});

function parseSkillDescriptor(text: string, path: string, limit: number): SkillDescriptor {
  // 文件必须从 frontmatter 开始；同时接受 LF 和 CRLF。
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error("Missing or unclosed frontmatter");
  const frontmatter = match[1]!;
  if (frontmatter.length > limit) throw new Error("Frontmatter exceeds character limit");
  const metadata = skillMetadataSchema.parse(parse(frontmatter));
  return { name: metadata.name, description: metadata.description, path };
}

export async function discoverSkills(options: {
  directories: string[];
  maxFrontmatterCharacters?: number;
}): Promise<{ skills: SkillDescriptor[]; warnings: string[] }> {
  const skills: SkillDescriptor[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const limit = options.maxFrontmatterCharacters ?? 4_000;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid frontmatter limit");

  for (const directory of options.directories) {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      // directory 按传入顺序，子目录按名称排序，让提示词与测试稳定。
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const candidate = join(directory, entry.name, "SKILL.md");
        try {
          const path = await realpath(candidate);
          if (seen.has(path)) continue;
          seen.add(path);
          skills.push(parseSkillDescriptor(await Bun.file(path).text(), path, limit));
        } catch (error) {
          if ((error as { code?: string }).code !== "ENOENT") {
            warnings.push(`${candidate}: ${String(error)}`);
          }
        }
      }
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        warnings.push(`${directory}: ${String(error)}`);
      }
    }
  }
  return { skills, warnings };
}

export async function readSkill(options: {
  descriptor: SkillDescriptor;
  maxCharacters?: number;
}): Promise<{ content: string; truncated: boolean }> {
  const limit = options.maxCharacters ?? 20_000;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid Skill content limit");
  const content = await Bun.file(options.descriptor.path).text();
  return { content: content.slice(0, limit), truncated: content.length > limit };
}
```

</details>

这里按 `realpath` 去重，不能按名称去重：两个目录中的 Skill 可以同名，读取时必须使用
对应的精确路径。单个文件的 YAML 或字段校验失败会进入 `warnings`，不阻止其他 Skill 被发现。

#### 9.2.2 练习：注入本次 Model view

现在实现关键连接：模型必须看到目录，又不能让目录永久堆积在对话记录中。
回想阶段 6 的契约：`beforeModel` 返回 `Partial<ModelContext>`，host 会把返回值
合并到本次请求；`AgentContext.messages` 则是长期保留的 canonical transcript（作为事实来源维护的正式对话记录）。

目标文件：`src/agent/skills/skills-middleware.ts`：

```ts
import type { AgentMiddleware } from "@/agent/agent-middleware";

import type { SkillDescriptor } from "./skill-reader";

export function defineSkillsMiddleware(options: { skills: SkillDescriptor[] }): AgentMiddleware {
  const catalog = options.skills.map(({ name, description, path }) => ({ name, description, path }));
  const instructions = "When a Skill is selected, first read its exact path with read_file. Do not guess by name.";
  return {
    beforeModel: async ({ modelContext }) => {
      // 无 Skill 时不修改本次请求，这是完整的空目录路径。
      if (catalog.length === 0) return;

      // TODO：返回 Partial<ModelContext>，只更新 prompt。
      // 保留 modelContext.prompt，追加目录标题、JSON.stringify(catalog) 和 instructions。
      // 此处不读 Skill 正文，也不修改传入的 context 或 transcript。
      throw new Error("TODO: inject Skill catalog into the model view");
    },
  };
}
```

完成这个 hook 时，先确定返回对象的字段，再组织内容：保留原有 prompt，换行追加
`Available Skills (metadata only):`、目录 JSON 和加载说明。无目录的分支已经实现。
不用在这里创建 system message；阶段 2 的 `Model` 会把最终 prompt 转成 system message。

这一步的判断标准是：两次从相同 canonical context（用于生成各次请求的基准上下文）准备请求，应得到相同的目录提示。
如果第二次目录出现两份，检查是否改了 `agentContext.prompt`；如果正文提前出现，检查
是否在 hook 内调用了 `readSkill()`。本阶段的 Agent 读取链路应保持为：

```text
Skill 元数据 → 本次 prompt → 模型选择路径 → read_file → tool_result → 下一次模型请求
```

`readSkill()` 供应用显式读取或单测使用，不必再与 `read_file` 同时注入正文。用户显式选择
Skill 时，可在用户消息中同时写名称和路径。本阶段把 Skill 放在工作区内；配置工作区外
目录并不会绕过 `read_file` 的工作区边界。

目标文件：`src/agent/skills/__tests__/skill-reader.test.ts`。以下测试完整复制：

<details>
<summary>展开测试：<code>skill-reader.test.ts</code></summary>

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

  test("deduplicates real paths but keeps distinct files with the same name", async () => {
    const root = await fixture();
    await mkdir(join(root, "another"));
    await writeFile(join(root, "another", "SKILL.md"),
      await Bun.file(join(root, "valid", "SKILL.md")).text());
    const result = await discoverSkills({ directories: [root, root] });
    expect(result.skills.filter((skill) => skill.name === "test-writer")).toHaveLength(2);
    expect(new Set(result.skills.map((skill) => skill.path)).size).toBe(2);
  });

  test("loads the selected path and reports truncation at the exact boundary", async () => {
    const root = await fixture();
    const { skills } = await discoverSkills({ directories: [root] });
    const descriptor = skills[0]!;
    const full = await readSkill({ descriptor });
    expect(await readSkill({ descriptor, maxCharacters: full.content.length }))
      .toEqual({ content: full.content, truncated: false });
    expect(await readSkill({ descriptor, maxCharacters: 4 }))
      .toEqual({ content: full.content.slice(0, 4), truncated: true });
    const alternate = join(root, "alternate.md");
    await writeFile(alternate, "Selected exact file");
    expect((await readSkill({ descriptor: { ...descriptor, path: alternate } })).content)
      .toBe("Selected exact file");
  });
});
```

</details>

目标文件：`src/agent/skills/__tests__/skills-middleware.test.ts`。以下测试完整复制：

<details>
<summary>展开测试：<code>skills-middleware.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { AgentContext } from "@/agent/agent-context";
import type { ModelContext } from "@/foundation/models/model-context";

import { defineSkillsMiddleware } from "../skills-middleware";

function contexts(): { agentContext: AgentContext; modelContext: ModelContext } {
  const agentContext: AgentContext = {
    prompt: "Keep the project guidance.",
    messages: [{ role: "user", content: [{ type: "text", text: "add a test" }] }],
  };
  return { agentContext, modelContext: { ...agentContext } };
}

const SKILL = {
  name: "test-writer",
  description: "Use when adding tests.",
  path: "/workspace/.agents/skills/test-writer/SKILL.md",
};

describe("Skills Middleware", () => {
  test("leaves an empty catalog alone", async () => {
    const middleware = defineSkillsMiddleware({ skills: [] });
    expect(await middleware.beforeModel!(contexts())).toBeUndefined();
  });

  test("returns a temporary prompt without mutating either context", async () => {
    const middleware = defineSkillsMiddleware({ skills: [SKILL] });
    const input = contexts();
    const original = structuredClone(input);
    const update = await middleware.beforeModel!(input);
    expect(update?.prompt).toContain("Keep the project guidance.");
    expect(update?.prompt).toContain(SKILL.name);
    expect(update?.prompt).toContain(SKILL.path);
    expect(update?.prompt).toContain("read_file");
    expect(update?.messages).toBeUndefined();
    expect(input).toEqual(original);

    // 模拟 host 将返回值合并到本次 ModelContext，再从 canonical context（基准上下文）准备下一次请求。
    const firstView = { ...input.modelContext, ...update };
    const nextContext = { ...input.agentContext };
    const nextUpdate = await middleware.beforeModel!({
      agentContext: input.agentContext, modelContext: nextContext,
    });
    expect({ ...nextContext, ...nextUpdate }).toEqual(firstView);
  });
});
```

</details>

在 `src/agent/skills/index.ts` 导出 `./skill-reader` 和 `./skills-middleware`，然后运行：

```bash
bun test src/agent/skills
```

扫描测试检查元数据、路径和错误隔离；Middleware 测试检查返回的新视图与原 context。
当前 hook 尚未注册到一个 Agent，但可以直接调用测试。后面的组装只需注册这个已验证的对象。

### 9.3 让 Todo 更新影响后续推理

Todo 就是“待办事项”。在这里，它是 Agent 为当前任务维护的一份结构化工作清单，
记录要做什么、正在做什么、已经完成什么。例如用户要求“修复登录失败并补测试”，
Agent 可以把工作拆成三项：

| 待办事项 | 状态 | 含义 |
|---|---|---|
| 定位登录失败的原因 | `in_progress` | 正在处理 |
| 修改登录逻辑 | `pending` | 尚未开始 |
| 补充并运行回归测试 | `pending` | 尚未开始 |

定位完成后，Agent 将第一项改为 `completed`（已完成），再把第二项改为 `in_progress`。
这样，多步读文件、改代码、跑测试之后，仍有一份明确的进度记录可供检查，后面的 TUI
也可以直接展示它。简单的一步问答通常不需要拆清单，多步骤任务才更能体现它的作用。

这份清单由模型调用 `todo_write` 主动更新，保存在程序的 `TodoSystem` 中；它不会自动
执行清单上的工作，也不会验证任务是否真的完成。如果模型连续多步没有更新清单，
我们就把未完成项作为提醒加入下一次模型请求，让模型重新检查进度、决定后续行动。

Todo 需要同时服务两条路径：`todo_write` 改变结构化状态；模型多步没有更新任务时，
Middleware 根据该状态生成提醒。两者必须引用同一个 `TodoSystem`。

```bash
mkdir -p src/agent/todos/__tests__
touch src/agent/todos/todo-system.ts src/agent/todos/index.ts src/agent/todos/__tests__/todo-system.test.ts
```

#### 9.3.1 练习：合并状态与决定提醒时机

先实现管理清单的 `TodoSystem`，下一节再把它接入 Agent。每个 `TodoItem` 用稳定的
`id` 标识同一项工作，`text` 描述工作内容，`status` 记录上述三种状态。本节约定最多
一项处于 `in_progress`，让清单明确当前正在推进的重点。

读代码前，先理解它提供的三个操作：

- `write({ merge: false, items })`：用传入的完整列表替换旧清单，适合首次制定或重新制定计划。
  `merge: true` 则按 `id` 更新已有项、追加新项，保留未提及的项，适合推进部分任务的状态。
- `snapshot()`：返回当前清单的副本，供工具结果和 UI 读取，避免调用方意外修改内部状态。
- `reminderForStep(step)`：检查是否需要提醒。这里的 step 是 Agent 的推理步骤计数，
  不是待办项数量或经过的秒数；`reminderAfterSteps: 3` 表示至少间隔三步才再次提醒。
  成功更新清单会重新计时，全部完成后停止提醒。

目标文件：`src/agent/todos/todo-system.ts`。全量替换、候选状态校验、提交和快照是完整参照；
你需要实现按 id 合并，以及提醒的时间判断。

<details>
<summary>展开练习骨架：<code>todo-system.ts</code></summary>

```ts
import { z } from "zod";

import type { AgentMiddleware } from "@/agent/agent-middleware";
import { defineTool } from "@/foundation/tools";

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

const todoItemsSchema = z.array(z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
}));

function formatTodoReminder(items: TodoItem[]): string {
  return `Review unfinished Todos:\n${items.map((item) => `[${item.status}] ${item.text}`).join("\n")}`;
}

export class TodoSystem {
  private readonly _reminderAfterSteps: number;
  private _items: TodoItem[] = [];
  private _step = 0;
  private _lastUpdatedStep = 0;
  private _lastReminderStep = 0;

  constructor(options: { reminderAfterSteps: number }) {
    if (!Number.isSafeInteger(options.reminderAfterSteps) || options.reminderAfterSteps < 1) {
      throw new Error("reminderAfterSteps must be a positive integer");
    }
    this._reminderAfterSteps = options.reminderAfterSteps;
  }

  write(input: TodoWriteInput): void {
    const incoming = todoItemsSchema.parse(input.items);
    if (new Set(incoming.map((item) => item.id)).size !== incoming.length) {
      throw new Error("Duplicate Todo id");
    }
    let next: TodoItem[];
    if (!input.merge) {
      next = incoming; // 全量替换示例：此时仍未修改 store。
    } else {
      // TODO 1：从旧列表构造候选集合，再按 id 更新 incoming 中的条目，得到 next。
      // 已有 id 保持原位置，新 id 追加到末尾；未提及的条目保持不变。
      // 可以使用 Map；只改候选集合，下面的统一校验通过后才提交 this._items。
      throw new Error("TODO 1: merge Todo candidates by id");
    }
    if (next.filter((item) => item.status === "in_progress").length > 1) {
      throw new Error("At most one Todo may be in_progress");
    }
    this._items = next.map((item) => ({ ...item }));
    this._lastUpdatedStep = this._step;
    this._lastReminderStep = this._step;
  }

  snapshot(): TodoItem[] {
    // TodoItem 只有标量字段，复制数组和每个 item 即可隔离可变引用。
    return this._items.map((item) => ({ ...item }));
  }

  reminderForStep(step: number): string | undefined {
    this._step = step;
    const unfinished = this._items.filter((item) => item.status !== "completed");
    // 无未完成项时无需提醒；仍需记录本次 step，供之后的 write 重置计时。
    if (unfinished.length === 0) return;
    // TODO 2：距“最近一次成功写入”和“最近一次提醒”都已达到间隔时才提醒。
    // 未到期返回 undefined，且不能更新 _lastReminderStep。
    // 到期才将 _lastReminderStep 设为 step，并返回 formatTodoReminder(unfinished)。
    throw new Error("TODO 2: schedule Todo reminders");
  }
}
```

</details>

先完成 `write` 的 merge 分支。它与已给出的 replace 分支都只负责准备 `next`，
之后统一检查“最多一个 `in_progress`”，最后才提交。可用以 id 为 key 的 `Map`，
也可在复制后的数组上查找、替换；已有条目的位置必须稳定。

用这个输入检查是否保留了原列表，而不只是把传入数组写回去：

```text
旧状态： [a: in_progress, b: pending]
本次更新：[a: completed, c: pending]，merge=true
新状态： [a: completed, b: pending, c: pending]
```

如果只把 b 改为 `in_progress` 而没有完成 a，整个更新必须失败，旧状态保持不变。
校验失败时也不能更新 `_lastUpdatedStep`，因为模型并未成功提交一次 Todo 更新。

再完成 `reminderForStep`。`_step` 是当前步，另外两个字段分别记录最近的成功写入和提醒。
判断间隔时取后两者的较大值作为起点；只看成功写入时间会导致首次提醒后每步都重复提醒。
例如间隔为 2 时，应能得到下面的行为：

| 操作 | 结果 | 原因 |
|---|---|---|
| step 0 写入 pending 任务，检查 step 1 | 无提醒 | 只过去一步 |
| 检查 step 2 | 提醒 | 达到间隔，记录这次提醒 |
| 再检查 step 2、step 3 | 无提醒 | 距刚才的提醒不足两步 |
| step 3 成功更新任务，检查 step 4 | 无提醒 | 成功写入重置计时 |
| 检查 step 5 | 提醒 | 任务仍未完成且再次到期 |
| 把所有任务标记为 completed | 后续无提醒 | 已无未完成项 |

#### 9.3.2 接上 Tool 与 Middleware

继续追加到同一个 `todo-system.ts`，复用上面的 imports。这份接线代码完整给出，
也可对照刚完成的 Skills hook，观察另一种临时 prompt 更新。

```ts
export function defineTodoIntegration(todos: TodoSystem) {
  // Agent 的 step 每轮从 1 开始；这里独立计数，跨多轮用户输入持续递增。
  let modelStep = 0;
  let reminder: string | undefined;
  const tool = defineTool({
    name: "todo_write",
    description: "Replace or merge the session task list. At most one item may be in_progress.",
    parameters: z.object({
      description: z.string().describe("Explain why you want to update Todos. Always place `description` as the first parameter."),
      merge: z.boolean(),
      items: todoItemsSchema,
    }),
    invoke: async (input, signal) => {
      signal?.throwIfAborted();
      todos.write(input);
      return { ok: true, summary: "Todo list updated", data: { items: todos.snapshot() } };
    },
  });
  const middleware: AgentMiddleware = {
    beforeAgentStep: async () => {
      reminder = todos.reminderForStep(++modelStep);
    },
    beforeModel: async ({ modelContext }) => {
      if (reminder) return { prompt: `${modelContext.prompt}\n\n${reminder}` };
    },
  };
  return { tool, middleware };
}
```

顺着这段代码追踪一次运行：`beforeAgentStep` 前移计数并计算提醒，`beforeModel`
把提醒加入当前 prompt，之后 `todo_write` 调用 `write()` 更新状态。下一步再从同一容器
计算提醒，而不是从助手回复里猜任务状态。

`modelStep` 在这个 Middleware 实例中持续累加，因为 Agent 的 step 会在每轮用户输入时
重新从 1 开始。Tool 失败不会执行成功提交之后的计时更新。阶段 10 的 UI 也会读取
这个容器的 `snapshot()`，无需现在引入订阅总线。

目标文件：`src/agent/todos/__tests__/todo-system.test.ts`。以下测试完整复制：

<details>
<summary>展开测试：<code>todo-system.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { TodoSystem, defineTodoIntegration } from "../todo-system";

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
    expect(todos.reminderForStep(2)).toBeUndefined();
    expect(todos.reminderForStep(3)).toBeUndefined();
    todos.write({ merge: true, items: [{ id: "a", text: "inspect", status: "pending" }] });
    expect(todos.reminderForStep(4)).toBeUndefined();
    expect(todos.reminderForStep(5)).toContain("inspect");
  });

  test("commits merges atomically and isolates input and snapshot references", () => {
    const todos = new TodoSystem({ reminderAfterSteps: 2 });
    const items = [{ id: "a", text: "inspect", status: "in_progress" as const }];
    todos.write({ merge: false, items });
    items[0]!.text = "mutated input";
    const snapshot = todos.snapshot();
    snapshot[0]!.text = "mutated snapshot";
    expect(todos.snapshot()[0]!.text).toBe("inspect");
    expect(() => todos.write({ merge: true, items: [
      { id: "b", text: "edit", status: "in_progress" },
    ] })).toThrow("in_progress");
    expect(todos.snapshot()).toEqual([{ id: "a", text: "inspect", status: "in_progress" }]);
    todos.write({ merge: true, items: [
      { id: "a", text: "inspect", status: "completed" },
      { id: "b", text: "edit", status: "in_progress" },
    ] });
    expect(todos.snapshot().map((item) => item.id)).toEqual(["a", "b"]);
  });

  test("does not reset the reminder on a rejected write and stops after completion", () => {
    const todos = new TodoSystem({ reminderAfterSteps: 2 });
    todos.write({ merge: false, items: [{ id: "a", text: "inspect", status: "pending" }] });
    expect(todos.reminderForStep(2)).toContain("inspect");
    expect(todos.reminderForStep(3)).toBeUndefined();
    expect(() => todos.write({ merge: false, items: [
      { id: "a", text: "inspect", status: "in_progress" },
      { id: "b", text: "edit", status: "in_progress" },
    ] })).toThrow("in_progress");
    expect(todos.reminderForStep(4)).toContain("inspect");
    todos.write({ merge: true, items: [{ id: "a", text: "inspect", status: "completed" }] });
    expect(todos.reminderForStep(10)).toBeUndefined();
  });

  test("connects the Tool and reminder to one store across user runs", async () => {
    const todos = new TodoSystem({ reminderAfterSteps: 2 });
    const { tool, middleware } = defineTodoIntegration(todos);
    const agentContext = { prompt: "base", messages: [] };
    await tool.invoke({ description: "plan work", merge: false,
      items: [{ id: "a", text: "inspect", status: "pending" }],
    });
    await middleware.beforeAgentStep!({ agentContext, step: 1 });
    expect(await middleware.beforeModel!({ agentContext, modelContext: { ...agentContext } }))
      .toBeUndefined();
    // 第二轮用户输入的 Agent step 又是 1，Todo 的内部计数仍继续递增。
    await middleware.beforeAgentStep!({ agentContext, step: 1 });
    const update = await middleware.beforeModel!({ agentContext, modelContext: { ...agentContext } });
    expect(update?.prompt).toContain("inspect");
    expect(agentContext).toEqual({ prompt: "base", messages: [] });
  });
});
```

</details>

在 `src/agent/todos/index.ts` 导出 `./todo-system`，然后运行：

```bash
bun test src/agent/todos
```

先让 merge、提醒、引用隔离测试通过，再看最后一项接线测试：它直接调用 Tool 和 hooks，
验证修改的是同一份状态，以及跨两轮用户输入后提醒计数仍然连续。

### 9.4 把用户回答作为 Tool 结果

Agent 还需要一种特殊的 Tool：它不读写文件，而是等待外部 handler 提供答案。
离线示例的 handler 立即返回固定值；下一阶段才把它连接到终端输入。

```bash
touch src/coding/tools/ask-user-question.ts src/coding/tools/__tests__/ask-user-question.test.ts
```

目标文件：`src/coding/tools/ask-user-question.ts`。输入 schema 和调用前的取消检查已经给出，
完成 `invoke` 中的异步边界：

```ts
import { z } from "zod";

import { defineTool } from "@/foundation/tools";

export type AskUserQuestionHandler = (params: {
  question: string;
  choices?: string[];
  signal?: AbortSignal;
}) => Promise<{ answer: string }>;

export function defineAskUserQuestionTool(options: { handler: AskUserQuestionHandler }) {
  return defineTool({
    name: "ask_user_question",
    description: "Ask the user for missing information needed to continue.",
    parameters: z.object({
      description: z.string().describe("Explain why you want to ask the user. Always place `description` as the first parameter."),
      question: z.string().min(1),
      choices: z.array(z.string().min(1)).min(1).optional(),
    }),
    invoke: async ({ question, choices }, signal): Promise<{ answer: string }> => {
      signal?.throwIfAborted();
      // TODO：await 当前调用的 handler，透传 question、choices、signal。
      // 等待期间可能取消，因此取得答案后再次检查 signal，再原样返回结果。
      // 不捕获并吞掉 handler 的异常；也不要用共享变量保存各次调用的答案。
      throw new Error("TODO: await the answer for this tool invocation");
    },
  });
}
```

这里的练习是保持“一次调用对应一个答案”的关系：每次 `invoke` 都等待自己调用 handler
得到的 Promise。两个 Tool 同时提问时，不能用共享的 `lastAnswer` 或 resolver 交叉传递结果。

还需要处理“等待时取消”的情况。将 signal 传给 handler，让它有机会结束等待；取得结果
后再检查一次，避免把取消后的迟到答案当作成功结果。handler 拒绝时让异常向上传递，
由已有的 Tool runtime 规范化。前后检查不能自动终止一个不响应 signal 的 handler；
终端输入队列如何主动取消会在阶段 10 实现。

目标文件：`src/coding/tools/__tests__/ask-user-question.test.ts`。以下测试完整复制：

<details>
<summary>展开测试：<code>ask-user-question.test.ts</code></summary>

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

  test("does not invoke the handler when already aborted", async () => {
    let calls = 0;
    const tool = defineAskUserQuestionTool({ handler: async () => {
      calls++;
      return { answer: "unused" };
    } });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.invoke({ description: "ask", question: "continue?" }, controller.signal))
      .rejects.toHaveProperty("name", "AbortError");
    expect(calls).toBe(0);
  });

  test("forwards the signal and rejects an answer returned after cancellation", async () => {
    const controller = new AbortController();
    const tool = defineAskUserQuestionTool({ handler: async ({ question, choices, signal }) => {
      expect(question).toBe("continue?");
      expect(choices).toEqual(["yes", "no"]);
      expect(signal).toBe(controller.signal);
      controller.abort();
      return { answer: "late answer" };
    } });
    await expect(tool.invoke({ description: "ask", question: "continue?", choices: ["yes", "no"] }, controller.signal))
      .rejects.toHaveProperty("name", "AbortError");
  });
});
```

</details>

运行：

```bash
bun test src/coding/tools/__tests__/ask-user-question.test.ts
```

并发测试故意让第二个问题先完成，两个返回值仍应各自匹配原问题。
Tool call id 与 `tool_result` 的关联由阶段 5 的调度负责，不需要把 id 拼进答案正文。

### 9.5 组装 Coding Agent

前面四节已经可以各自运行。现在把它们接到通用 `Agent`，这就是 composition root（组装入口）：
它选择依赖、共享实例和 Middleware 顺序，不再实现文件读取或 Agent 循环。

```bash
touch src/coding/agents/coding-agent.ts src/coding/agents/index.ts src/coding/agents/__tests__/coding-agent.test.ts
```

目标文件：`src/coding/agents/coding-agent.ts`。依赖初始化和 `new Agent` 已给出，
需要你完成 prompt、工具与中间件的连接。填完两处 TODO 后删去中间的占位 `throw`，
执行流才能到达最后的 `return`。

```ts
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { Agent } from "@/agent/agent";
import type { AgentMiddleware } from "@/agent/agent-middleware";
import { discoverSkills } from "@/agent/skills/skill-reader";
import { defineSkillsMiddleware } from "@/agent/skills/skills-middleware";
import { TodoSystem, defineTodoIntegration } from "@/agent/todos/todo-system";
import { defineCodingTools } from "@/coding/tools";
import { defineAskUserQuestionTool } from "@/coding/tools/ask-user-question";
import type { AskUserQuestionHandler } from "@/coding/tools/ask-user-question";
import type { Model } from "@/foundation/models";

import { readProjectGuidance } from "./project-guidance";

export async function defineCodingAgent(options: {
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  askUserQuestion?: AskUserQuestionHandler;
  policyMiddleware?: AgentMiddleware;
  maxGuidanceCharacters?: number;
  onWarning?: (message: string) => void;
  todos?: TodoSystem;
}): Promise<Agent> {
  const cwd = await realpath(options.cwd ?? process.cwd());
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const guidance = await readProjectGuidance({
    cwd, maxCharacters: options.maxGuidanceCharacters, onWarning: warn,
  });
  const { skills, warnings } = await discoverSkills({
    directories: options.skillsDirs ?? [join(cwd, ".agents", "skills")],
  });
  warnings.forEach(warn);
  const todos = options.todos ?? new TodoSystem({ reminderAfterSteps: 3 });
  const todo = defineTodoIntegration(todos);

  const promptParts = [
    "You are a coding assistant. Inspect files before editing and verify your changes.",
    `Workspace: ${cwd}`,
  ];
  const tools = defineCodingTools({ cwd });
  const middlewares: AgentMiddleware[] = [];
  const questionTool = defineAskUserQuestionTool({
    handler: options.askUserQuestion ?? (async () => {
      throw new Error("No user input handler is connected");
    }),
  });

  // TODO 1：guidance 非空时加入 promptParts，并标明内容来自 AGENTS.md。
  // 只通过 prompt 传入 Model view；不要为它创建 user message。

  // TODO 2：补齐两个数组：tools 还需要 todo.tool 和 questionTool；
  // middlewares 按 Skills → Todo → 可选 policy 的顺序加入对应实例。
  // 使用上面同一个 todo 的 tool/middleware，不要在这里再创建 TodoSystem。
  throw new Error("TODO: complete Coding Agent composition");

  return new Agent({
    model: options.model,
    prompt: promptParts.join("\n\n"),
    tools,
    middlewares,
  });
}
```

先把 `AGENTS.md` 的内容接入 prompt：`guidance` 非空时追加到 `promptParts`，不把它变成用户消息。
这样 `Model` 会在请求中看到 system 指令，而 `agent.messages` 仍只保留用户、助手和工具之间的消息。

然后补齐两个注册数组。`tools` 已有阶段 8 的文件工具，再添加 `todo.tool` 与 `questionTool`。
`middlewares` 先加入 `defineSkillsMiddleware({ skills })`，再加入 `todo.middleware`，
最后在存在时加入 `options.policyMiddleware`。最后一项是阶段 10 的注入点，现在不需要
实现审批；本节测试用一个记录 prompt 的 Middleware 观察顺序即可。

注意上面的 `todo` 同时给出了 Tool 和 Middleware。若在两处分别创建容器，模型虽然能调用
`todo_write`，提醒和 UI 却看不到更新。传入 `options.todos` 时也必须复用它，这个依赖
会让下面的测试直接观察到 Tool 是否修改了正确的对象。

目标文件：`src/coding/agents/__tests__/coding-agent.test.ts`。以下测试完整复制：

<details>
<summary>展开测试：<code>coding-agent.test.ts</code></summary>

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { AgentMiddleware } from "@/agent/agent-middleware";
import { TodoSystem } from "@/agent/todos/todo-system";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models";

import { defineCodingAgent } from "../coding-agent";

const FINAL: AssistantMessage = {
  role: "assistant", content: [{ type: "text", text: "done" }],
};
const USER: UserMessage = {
  role: "user", content: [{ type: "text", text: "inspect" }],
};

class RecordingProvider implements ModelProvider {
  readonly requests: ModelProviderInvokeParams[] = [];
  private readonly _responses: AssistantMessage[];
  private _cursor = 0;

  constructor(options: { responses: AssistantMessage[] }) {
    this._responses = options.responses;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.requests.push(params);
    const response = this._responses[this._cursor++];
    if (!response) throw new Error("Script exhausted");
    return response;
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    yield await this.invoke(params);
  }
}

const workspaces: string[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runFixture(options: {
  guidance?: string;
  responses?: AssistantMessage[];
  todos?: TodoSystem;
  policyMiddleware?: AgentMiddleware;
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "harness-agent-"));
  workspaces.push(cwd);
  if (options.guidance !== undefined) await Bun.write(join(cwd, "AGENTS.md"), options.guidance);
  const skillDirectory = join(cwd, ".agents", "skills", "test-writer");
  await mkdir(skillDirectory, { recursive: true });
  await Bun.write(join(skillDirectory, "SKILL.md"),
    "---\nname: test-writer\ndescription: Use for tests.\n---\nBODY_ONLY_AFTER_SELECTION\n");
  const provider = new RecordingProvider({ responses: options.responses ?? [FINAL] });
  const agent = await defineCodingAgent({
    model: new Model({ name: "recording", provider }), cwd,
    todos: options.todos, policyMiddleware: options.policyMiddleware,
  });
  for await (const _event of agent.stream(USER)) { /* consume */ }
  return { agent, provider };
}

describe("defineCodingAgent", () => {
  test("combines guidance, metadata and tools without polluting the transcript", async () => {
    const { agent, provider } = await runFixture({ guidance: "Always run tests." });
    const first = provider.requests[0]!;
    expect(JSON.stringify(first.messages[0])).toContain("Always run tests.");
    expect(JSON.stringify(first.messages[0])).toContain("test-writer");
    expect(JSON.stringify(first.messages)).not.toContain("BODY_ONLY_AFTER_SELECTION");
    expect(JSON.stringify(agent.messages)).not.toContain("Always run tests.");
    expect(first.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["read_file", "todo_write", "ask_user_question"]),
    );
  });

  test("shares the injected Todo store and applies Skills then Todo then policy", async () => {
    const todos = new TodoSystem({ reminderAfterSteps: 1 });
    const seen: string[] = [];
    await runFixture({
      todos,
      policyMiddleware: { beforeModel: async ({ modelContext }) => { seen.push(modelContext.prompt); } },
      responses: [{ role: "assistant", content: [{
        type: "tool_use", id: "todo-1", name: "todo_write", input: {
          description: "track work", merge: false,
          items: [{ id: "a", text: "inspect", status: "pending" }],
        },
      }] }, FINAL],
    });
    expect(todos.snapshot()).toEqual([{ id: "a", text: "inspect", status: "pending" }]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toContain("Review unfinished Todos");
    expect(seen[1]).toContain("Review unfinished Todos");
    expect(seen[1]!.indexOf("test-writer")).toBeLessThan(seen[1]!.indexOf("Review unfinished Todos"));
  });

  test("loads the selected Skill through a Tool result on the next model request", async () => {
    const { provider } = await runFixture({ responses: [{ role: "assistant", content: [{
      type: "tool_use", id: "skill-1", name: "read_file", input: {
        description: "load selected Skill", path: ".agents/skills/test-writer/SKILL.md",
      },
    }] }, FINAL] });
    expect(JSON.stringify(provider.requests[0]!.messages)).not.toContain("BODY_ONLY_AFTER_SELECTION");
    const observations = provider.requests[1]!.messages.filter((message) => message.role === "tool");
    expect(JSON.stringify(observations)).toContain("BODY_ONLY_AFTER_SELECTION");
    expect(observations[0]?.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "skill-1" });
  });
});
```

</details>

在 `src/coding/agents/index.ts` 导出 `defineCodingAgent`，然后运行：

```bash
bun test src/coding/agents
```

这次测试真正消费 `Agent.stream()`：检查首次请求中的 `AGENTS.md` 内容与 Skill 目录、Tool 更新
共享 Todo 后的提醒，以及读取 Skill 后正文只出现在后续请求的 Tool result 中。
如果工具存在但提醒缺失，先检查共享实例和 Middleware 注册，不要改通用 Agent loop。

### 9.6 运行完整的离线对话

各个模块已经实现并测试，现在用一条对话串起来。准备用于演练的工作区：

```text
fixture/
├── AGENTS.md
├── .agents/skills/test-writer/SKILL.md
└── src/math.ts
```

先创建目录和文件：

```bash
mkdir -p examples fixture/.agents/skills/test-writer fixture/src
touch fixture/AGENTS.md fixture/.agents/skills/test-writer/SKILL.md fixture/src/math.ts
touch examples/stage-09-coding-agent.ts
```

再向 `AGENTS.md` 写入 `Always inspect source before editing.`；向 `src/math.ts` 写入
`export const add = (a: number, b: number) => a + b;`；`SKILL.md` 使用 9.2.1 的示例。
三者都不依赖真实 API 或已有业务项目。

目标文件：`examples/stage-09-coding-agent.ts`。完整脚本已提供：预设模型依次读取 Skill、
创建 Todo、读取源码、向用户提问、完成 Todo，再返回最终回答。它用于观察各模块的数据流，
不要求真实模型决定调用哪些工具。

<details>
<summary>展开离线演练：<code>stage-09-coding-agent.ts</code></summary>

```ts
import { join, resolve } from "node:path";

import { TodoSystem } from "@/agent/todos/todo-system";
import { defineCodingAgent } from "@/coding/agents/coding-agent";
import type { AssistantMessage, UserMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type { ModelProvider, ModelProviderInvokeParams } from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

class RecordingScriptedProvider implements ModelProvider {
  readonly requests: ModelProviderInvokeParams[] = [];
  private readonly _provider: ScriptedModelProvider;

  constructor(options: { responses: AssistantMessage[] }) {
    this._provider = new ScriptedModelProvider(options);
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
    content: [{ type: "tool_use", id: "ask-1", name: "ask_user_question", input: {
      description: "confirm the next task", question: "Should we add a test next?",
    } }],
  },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "todo-2", name: "todo_write", input: {
      description: "finish fixture inspection", merge: true,
      items: [{ id: "inspect", text: "Inspect src/math.ts", status: "completed" }],
    } }],
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Loaded guidance and Skill, inspected source, and recorded the user's answer." }],
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

  const provider = new RecordingScriptedProvider({ responses });
  const todos = new TodoSystem({ reminderAfterSteps: 3 });
  const agent = await defineCodingAgent({
    model: new Model({ name: "scripted", provider }),
    cwd,
    todos,
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
  const firstModelView = (provider.requests[0]?.messages ?? [])
    .filter((message) => message.role === "system")
    .flatMap((message) => message.content.map((item) => item.type === "text" ? item.text : ""))
    .join("\n");
  if (!firstModelView.includes("test-writer") || !firstModelView.includes(guidance)) {
    throw new Error("Project guidance or Skill metadata was not included in the first model view");
  }

  const observations = agent.messages.flatMap((message) => message.role === "tool" ? message.content : []);
  for (const id of ["skill-1", "todo-1", "read-1", "todo-2"]) {
    const observation = observations.find((item) => item.tool_use_id === id);
    if (!observation || JSON.parse(observation.content).ok !== true) {
      throw new Error(`Expected successful Tool result for ${id}`);
    }
  }
  const answer = observations.find((item) => item.tool_use_id === "ask-1");
  if (!answer || JSON.parse(answer.content).answer !== "fixture answer: Should we add a test next?") {
    throw new Error("The answer was not returned to ask-1");
  }
  const snapshot = todos.snapshot();
  if (snapshot.length !== 1 || snapshot[0]?.id !== "inspect" || snapshot[0].status !== "completed") {
    throw new Error("The shared Todo store was not updated to completed");
  }
  console.log("Final Todos:", snapshot);
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

首次模型请求包含 `AGENTS.md` 内容和 Skill 元数据。随后，模拟模型按预设顺序发出以下内容，
可以逐步对照 Agent 的执行结果：

| 步骤 | 模拟模型发出的内容 | Agent 执行结果 |
| --- | --- | --- |
| 1 | 调用 `read_file`，读取 `.agents/skills/test-writer/SKILL.md` | 返回 Skill 正文，其中要求先读源码、添加测试、运行测试 |
| 2 | 调用 `todo_write`，`merge: false` | 创建任务 `inspect`，状态为 `in_progress` |
| 3 | 调用 `read_file`，读取 `src/math.ts` | 返回 `export const add = (a: number, b: number) => a + b;` |
| 4 | 调用 `ask_user_question` | 得到预设回答 `fixture answer: Should we add a test next?` |
| 5 | 调用 `todo_write`，`merge: true` | 按相同的 `id: "inspect"`，把任务更新为 `completed` |
| 6 | 返回普通文本 | 没有新的工具调用，Agent 结束本轮运行 |

最后的快照应只有已完成的 `inspect` 任务。提醒会出现在 Model view 中，而不会冒充
用户消息出现在 canonical transcript（作为事实来源维护的正式对话记录）中。

最后一起运行本阶段的测试和类型检查，确认组装时没有破坏前面已通过的模块：

```bash
bun test src/agent/skills src/agent/todos src/coding/agents src/coding/tools/__tests__/ask-user-question.test.ts
bun run check:types
```



### 验收

- [ ] Coding Agent 通过组装入口构造，通用 Agent 不导入 `coding` 层；
- [ ] `AGENTS.md` 加载的内容有长度上限，并通过 prompt 进入模型请求；
- [ ] Skill 目录只进入临时 Model view，正文通过选择后的 Tool result 加载；
- [ ] Todo merge 失败不改旧状态；成功更新和提醒分别影响计时；
- [ ] 提问结果按调用配对，取消后的答案不作为成功结果返回；
- [ ] Tool、Middleware 和调用方观察到同一个 TodoSystem；
- [ ] `ADR-010` 说明 `AGENTS.md`、Skill、Todo 和对话记录各自的生命周期。

## 阶段 10：CLI/TUI、模型配置与 Human-in-the-loop

> 上一阶段回顾：阶段 9 组装了 Coding Agent，并接入 `AGENTS.md`、渐进式 Skills、Todo 和 `ask_user_question` Tool。

### 本阶段目标

把运行时变成真正可用的终端产品，同时建立人工审批边界。Human-in-the-loop 指“人在执行流程中参与决策”，
这里体现为人工审批工具操作，以及回答 Agent 提出的问题。完成后创建 `v0.1.0` 版本标签，表示基础复刻结束。

本阶段再分四步，不要求第一次就写出七个组件：

| 小里程碑 | 范围 | 反馈 |
|---|---|---|
| 10A | 配置解析 + 文本客户端 | 输入一行，读取一次 Agent 流式输出，显示结果 |
| 10B | reducer + 最小 Ink 界面 | 输入、忙碌提示、消息历史；沿用同一 Agent |
| 10C | 审批和向用户提问 | 等待、允许、拒绝、取消都能结束；并发请求不会覆盖 |
| 10D | Todo、token、斜杠命令（如 `/clear`）和组件拆分 | 完成本节手工验收，最后执行完整质量检查 |

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
touch src/cli/tui/app.tsx src/cli/tui/state.ts src/cli/tui/token-usage.ts src/cli/tui/human-input.ts
touch src/cli/tui/__tests__/state.test.ts src/cli/tui/__tests__/token-usage.test.ts src/cli/tui/__tests__/human-input.test.ts
touch src/coding/permissions/approval-middleware.ts src/coding/permissions/approval-persistence.ts src/coding/permissions/index.ts
touch src/coding/permissions/__tests__/approval-middleware.test.ts src/coding/permissions/__tests__/approval-persistence.test.ts docs/manual-test.md
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
│       ├── human-input.ts              # 将并发审批和问题串行展示、处理取消
│       ├── components/                 # 放置可复用的 TUI 展示组件
│       ├── hooks/
│       │   └── use-agent-loop.ts       # 连接 reducer、Agent stream 与取消操作
│       └── __tests__/
│           ├── state.test.ts           # 验证 reducer 状态迁移
│           ├── token-usage.test.ts     # 验证 token 统计与缺省字段
│           └── human-input.test.ts     # 验证问题配对、取消和卸载清理
└── coding/permissions/
    ├── approval-middleware.ts          # 在有副作用的 Tool 前请求人工审批
    ├── approval-persistence.ts         # 保存项目级允许列表（10D 练习）
    ├── index.ts                        # 导出权限层公共 API
    └── __tests__/
        ├── approval-middleware.test.ts # 验证允许、拒绝与中止路径
        └── approval-persistence.test.ts # 验证重启读取、项目隔离和写入失败
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

目标文件：`harness.config.yaml`。配置只记录环境变量名，不写入密钥值：

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

#### 10.2.1 先校验结构，再校验模型引用

目标文件：`src/cli/config/schema.ts`。Zod shape 和错误格式已实现，只保留一个跨字段
校验练习；它与“字符串非空”不同，需要查看另一字段的值。

```ts
import { z } from "zod";

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

const harnessConfigSchema = z.object({
  defaultModel: z.string().min(1),
  models: z.record(z.string().min(1), z.object({
    provider: z.enum(["openai", "anthropic"]),
    model: z.string().min(1),
    baseURL: z.string().url().optional(),
    apiKeyEnv: z.string().min(1),
    options: z.record(z.string(), z.unknown()).optional(),
  }).strict()),
}).strict();

export function parseHarnessConfig(input: unknown): HarnessConfig {
  const result = harnessConfigSchema.safeParse(input);
  if (!result.success) {
    // 不输出原配置对象，避免把误填到配置里的密钥回显。
    throw new Error(result.error.issues.map((issue) =>
      `${issue.path.join(".") || "config"}: ${issue.message}`,
    ).join("\n"));
  }
  const config = result.data;
  // TODO 1：调用下面的 resolveDefaultModel(config)，验证 defaultModel 指向真实 key。
  // 成功则 return config；不要读取 process.env，也不要将缺省模型偷偷换成第一个模型。
  throw new Error("TODO 1: validate defaultModel reference");
}

export function resolveDefaultModel(config: HarnessConfig): ModelConfig {
  if (!Object.hasOwn(config.models, config.defaultModel)) {
    throw new Error(`defaultModel: unknown model ${config.defaultModel}`);
  }
  return config.models[config.defaultModel]!;
}
```

例子：`models.local.provider: unknown` 应报告 `models.local.provider`；
`defaultModel: missing` 应报告 `defaultModel` 和 `missing`。
结构校验不依赖机器是否配置了 API key，因此离线测试也能通过。

#### 10.2.2 补齐模型工厂

目标文件：`src/cli/config/model-factory.ts`。这是完整接线，不需要再猜 SDK 在哪里创建。

```ts
import { OpenAIModelProvider } from "@/community/openai/model-provider";
import { AnthropicModelProvider } from "@/community/anthropic/model-provider";
import { Model } from "@/foundation/models";

import type { HarnessConfig } from "./schema";
import { resolveDefaultModel } from "./schema";

export function defineConfiguredModel(
  config: HarnessConfig,
  env: Record<string, string | undefined> = process.env,
): Model {
  const selected = resolveDefaultModel(config);
  const apiKey = env[selected.apiKeyEnv];
  if (!apiKey) throw new Error(`Missing environment variable: ${selected.apiKeyEnv}`);
  const providerOptions = { baseURL: selected.baseURL, apiKey };
  const provider = selected.provider === "openai"
    ? new OpenAIModelProvider(providerOptions)
    : new AnthropicModelProvider(providerOptions);
  return new Model({ name: selected.model, provider, modelOptions: selected.options });
}
```

10A 先运行 10.3 的离线文本客户端；10B 完成后，CLI 入口按这个顺序读取真实配置：
`Bun.file(configPath).text() → YAML.parse → parseHarnessConfig → defineConfiguredModel →
defineCodingAgent → mountApp`。10C 的组装示例会补上审批和问题输入。

10D 再添加配置命令，不把四个命令的交互设计与 Agent 调试混在一起：

| 命令 | 实现步骤与边界 |
|---|---|
| `config model list` | 读取并校验 YAML；输出名称、provider、model 和默认标记，不解析密钥值 |
| `config model add` | 收集名称、provider、model、baseURL、apiKeyEnv；第一项同时成为默认；重名时明确报错 |
| `config model remove <name>` | 未找到时报错；默认项拒绝删除，提示先 set-default |
| `config model set-default <name>` | 先确认 key 存在，再更新 defaultModel |

写命令统一先复制配置、修改副本、调用 `parseHarnessConfig`，校验成功后才用 YAML.stringify
写文件。在阶段 0 的 CLI 入口中引入 Commander，注册 `program.command("config").command("model")` 的子命令；
用临时文件验收“非法输入不改原文件”。`add` 可先采用必填 flags，交互向导留作后续增强。

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
| component / props（组件 / 传入组件的参数） | 用函数描述界面，通过参数接收 Agent；不要在渲染时重新创建 Agent |
| `useReducer` | 根据事件计算下一份状态；不能直接修改旧数组 |
| `useRef` | 同步保存忙碌标志，避免 React 更新提交前连续按 Enter 触发两次运行 |
| `useEffect` 的清理函数（cleanup） | 组件卸载时中止运行并移除监听，防止后台任务留存 |

reducer 是“根据旧状态和事件计算新状态”的函数，例如收到 `run_start` 事件后将运行标志设为真。
Hook 是 React 中使用状态等能力的函数，例如 `useReducer`；本节的 `useAgentLoop` 则把 Agent 与界面连接起来。
下面直接给出 reducer 和 Hook 的基础实现，先用事件序列理解它们，再完成 10C 的输入面板；无需同时学习复杂 React 优化。

目标文件：`src/cli/tui/state.ts`

先复制 10.5 的 `token-usage.ts` 和 10.4.2 的审批接口，再复制本节 reducer。
10B 不需要运行审批逻辑，但 TypeScript 需要解析这些类型导出。

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
  tokenUsage: { latestInputTokens: number; sessionTotalTokens: number };
  pendingApproval?: ApprovalRequest;
  error?: string;
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
  | { type: "client_error"; message: string }
  | { type: "approval_requested"; request: ApprovalRequest }
  | { type: "approval_resolved" };

export function initialAgentLoopViewState(): AgentLoopViewState {
  return {
    messages: [], streaming: false,
    tokenUsage: { latestInputTokens: 0, sessionTotalTokens: 0 }, todos: [],
  };
}

export function parseSlashCommand(input: string): SlashCommand | undefined {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return;
  const [command, ...args] = trimmed.slice(1).split(/\s+/);
  if (command !== "clear" && command !== "help" && command !== "exit") {
    throw new Error(`Unknown slash command: ${command}`);
  }
  return { name: command, args };
}

export function reduceAgentEvent(
  state: AgentLoopViewState,
  event: AgentLoopEvent,
): AgentLoopViewState {
  switch (event.type) {
    case "message": {
      const messages = [...state.messages, event.message];
      return { ...state, messages, tokenUsage: calculateTokenUsage(messages) };
    }
    case "user_submitted":
      return { ...state, messages: [...state.messages, {
        role: "user", content: [{ type: "text", text: event.text }],
      }] };
    case "run_start":
      return { ...state, streaming: true, error: undefined };
    case "run_end":
      return { ...state, streaming: false, pendingApproval: undefined };
    case "client_error":
      return { ...state, error: event.message };
    case "approval_requested":
      return { ...state, pendingApproval: event.request };
    case "approval_resolved":
      return { ...state, pendingApproval: undefined };
    case "todos_updated":
      return { ...state, todos: event.items.map((item) => ({ ...item })) };
    case "cleared":
      return initialAgentLoopViewState();
    case "progress":
      // 进度不是新消息；累计内容不能反复追加到历史或重复计费。
      return state;
  }
}
```

</details>

在 `src/agent/agent.ts` 的 Agent 类中增加公开方法，供 Hook 同时清除事实记录和 UI：

```ts
/** Clear the conversation only while the Agent is idle. */
clearMessages(): void {
  if (this.streaming) throw new Error("Cannot clear messages while the Agent is running");
  this._context.messages = [];
}
```

运行中拒绝清除；Hook 先调用这个方法，成功后再派发 `cleared`。
本教程的 `/clear` 同时清空 Todo 和 token 统计，但保留已加载的 `AGENTS.md` 内容、Skill 目录及已持久化的审批许可。

目标文件：`src/cli/tui/hooks/use-agent-loop.ts`：

```ts
import { useEffect, useReducer, useRef } from "react";

import type { Agent } from "@/agent/agent";
import type { TodoSystem } from "@/agent/todos/todo-system";
import { runAgentTurn } from "@/cli/run-agent-turn";

import { initialAgentLoopViewState, reduceAgentEvent } from "../state";

export function useAgentLoop(agent: Agent, todos?: TodoSystem) {
  const [state, dispatch] = useReducer(reduceAgentEvent, undefined, initialAgentLoopViewState);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; agent.abort(); };
  }, [agent]);

  async function submit(text: string): Promise<void> {
    if (busy.current || !text.trim()) return;
    busy.current = true;
    dispatch({ type: "user_submitted", text });
    dispatch({ type: "run_start" });
    try {
      await runAgentTurn({ agent, text, onEvent: (event) => {
        if (!mounted.current) return;
        dispatch(event);
        if (todos) dispatch({ type: "todos_updated", items: todos.snapshot() });
      } });
    } catch (error) {
      if (mounted.current && !(error instanceof Error && error.name === "AbortError")) {
        dispatch({ type: "client_error", message: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      busy.current = false;
      if (mounted.current) dispatch({ type: "run_end" });
    }
  }

  function clear(): void {
    if (busy.current) return;
    agent.clearMessages(); // 先清事实记录，成功后才清 UI。
    todos?.write({ merge: false, items: [] });
    dispatch({ type: "cleared" });
  }

  return { state, submit, clear, abort: () => agent.abort() };
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

在 App 的状态提示下加 `<Text>{state.error ?? ""}</Text>`，API 错误即可独立显示。
10B 先用 ScriptedModelProvider 创建一个 Agent 并调用 `mountApp(agent)`；不要在每次渲染时
重新创建它。脚本响应耗尽会显示错误，再次输入应仍能提交，不应永久卡在 Working。

10D 接斜杠命令时，把 `TextInput.onSubmit` 转交本地 `handleInput`：先调用
`parseSlashCommand(text)`，没有命令才 `submit(text)`；clear 调 Hook 的 `clear()`，
help 设置本地提示文字，exit 在空闲时调用 Ink 的 `exit()`。catch 未知命令并显示本地错误。
命令不能先作为 `user_submitted` 派发，否则 `/clear`、`/help` 会进入模型对话。
可在输入回调中先按下列完整分派片段实现，再抽成组件：

```ts
function handleInput(text: string): void {
  try {
    const command = parseSlashCommand(text);
    if (!command) { void submit(text); return; }
    if (command.name === "clear") clear();
    if (command.name === "help") setNotice("/clear  /help  /exit");
    if (command.name === "exit" && !agent.streaming) exit();
  } catch (error) {
    setNotice(error instanceof Error ? error.message : String(error));
  }
}
```

App 从 Hook 取出 `clear`，导入 `parseSlashCommand`，用 `useState("")` 定义
`notice/setNotice` 并渲染 `<Text>{notice}</Text>`；提交后清空输入框。
10C 审批弹出时关闭聊天输入焦点，具体接线见 10.4.3。

当前 `AgentEvent.progress` 提供生成状态及 Tool 参数提示，不包含正文增量；因此先做
忙碌指示和最终消息展示。若要正文逐字输出，需要显式扩展进度快照的契约及测试，
不能让 UI 读取 Agent 私有状态。不要把“进度提示”描述成已经实现了正文流式渲染。

最低组件：

- `MessageHistory`；
- `InputBox`；
- `StreamingIndicator`；
- `Footer`：模型名称、最近一次输入的 token 数、会话累计 token 数；
- `TodoPanel`；
- `ApprovalPrompt`；
- `AskUserQuestionPrompt`。

支持：

- Enter 提交；
- Ctrl+C 中止当前运行，再次 Ctrl+C 退出；
- `/clear`、`/help`、`/exit`；
- 模型输出期间禁止重复提交；
- 普通 API 错误显示在 UI 错误区域，不写成模型回复或使 TUI 崩溃。

### 10.4 审批 Middleware

先完成独立于 React 的审批，再接 UI。审批结果是通用类型，目标文件
`src/foundation/permissions/approval-decision.ts`：

```ts
export type ApprovalDecision = "allow_once" | "allow_always_project" | "deny";
```

在该目录的 `index.ts` 中 re-export。`coding` 实现审批策略；`cli` 负责展示问题和收集答案。

#### 10.4.1 先把取消信号接到 hook

阶段 6 的 `beforeToolUse` 尚未声明 signal。现在在 `src/agent/agent-middleware.ts`
的该 hook 参数中添加 `signal?: AbortSignal`。在 Agent host 的 `_beforeToolUse` 中
也增加可选 signal 参数，并在调用 middleware 时传入：

```ts
const result = await middleware.beforeToolUse?.({
  agentContext: this._context, toolUse, signal,
});
```

把实际工具执行前的调用改为 `await this._beforeToolUse(toolUse, signal)`，保留 hook
前后已有的 `signal?.throwIfAborted()`。这三处必须一起改；只改类型，等待中的审批仍然不会取消。
不要在通用 Agent 中导入审批实现，它只传递本轮 signal。

#### 10.4.2 FIFO 和拒绝路径已实现，补齐允许决策

目标文件：`src/coding/permissions/approval-middleware.ts`。
`maxQueueLength` **包含当前展示中的请求**，因此设为 1 时第二个并发请求立即被拒绝。
先复制这份队列和拒绝实现，只完成标出的允许决策 TODO。

<details>
<summary>展开审批队列与允许决策练习</summary>

```ts
import type { AgentMiddleware } from "@/agent/agent-middleware";
import type { ToolUseContent } from "@/foundation/messages";
import type { ApprovalDecision } from "@/foundation/permissions/approval-decision";

export type { ApprovalDecision } from "@/foundation/permissions/approval-decision";

const TOOLS_REQUIRING_APPROVAL = new Set([
  "bash", "write_file", "str_replace", "apply_patch", "mkdir", "move_path",
]);
export interface ApprovalRequest {
  id: string;
  toolName: string;
  toolUse: ToolUseContent;
}
export interface ApprovalPersistence {
  has(projectId: string, toolName: string): Promise<boolean>;
  add(projectId: string, toolName: string): Promise<void>;
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    // 即使取消先发生，也观察原 promise 的 rejection，避免 unhandled rejection。
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function defineApprovalMiddleware(options: {
  projectId: string;
  maxQueueLength: number;
  requestDecision(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>;
  persistence?: ApprovalPersistence;
  onWarning?: (message: string) => void;
}): AgentMiddleware {
  if (!Number.isSafeInteger(options.maxQueueLength) || options.maxQueueLength < 1) {
    throw new Error("maxQueueLength must be a positive integer");
  }
  let tail = Promise.resolve();
  let pending = 0;
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const deny = (code: string, error: string) => ({
    __skip: true as const,
    result: { ok: false, summary: error, error, code },
  });

  return {
    beforeToolUse: async ({ toolUse, signal }) => {
      signal?.throwIfAborted();
      if (!TOOLS_REQUIRING_APPROVAL.has(toolUse.name)) return;
      if (pending >= options.maxQueueLength) {
        return deny("APPROVAL_QUEUE_FULL", "Approval queue is full");
      }
      // 必须在第一个 await 前占位，否则并发调用可能同时越过容量检查。
      pending++;
      const previous = tail;
      let release!: () => void;
      const done = new Promise<void>((resolve) => { release = resolve; });
      // 中间请求取消时，后继仍要等 previous；不能提前越过当前展示者。
      tail = previous.then(() => done);
      try {
        await waitWithSignal(previous, signal);
        signal?.throwIfAborted();
        try {
          if (options.persistence && await waitWithSignal(
            options.persistence.has(options.projectId, toolUse.name), signal,
          )) return;
        } catch (error) {
          signal?.throwIfAborted();
          warn(`Cannot read approval persistence: ${String(error)}`);
          // 无法读取 allowlist 时仍需询问，不默认放行。
        }
        signal?.throwIfAborted();
        const decision = await waitWithSignal(options.requestDecision({
          id: crypto.randomUUID(), toolName: toolUse.name, toolUse,
        }, signal), signal);
        signal?.throwIfAborted();
        if (decision === "deny") return deny("USER_DENIED", "User denied this tool call");

        // TODO 1：allow_once 直接 return；不写入 persistence。
        // TODO 2：allow_always_project 时用 waitWithSignal 等待 persistence.add(projectId, toolUse.name)。
        // 将 add 放在独立 try/catch 中；失败调用 warn，但仍允许本次动作。
        // 写完后再次检查 signal，再 return；没有 persistence 时也只允许本次动作并 warning。
        // 其他值（例如损坏的 UI 回答）返回 deny("APPROVAL_FAILED", "Invalid approval decision")。
        throw new Error("TODO: handle allow decisions");
      } catch (error) {
        signal?.throwIfAborted();
        warn(`Approval failed: ${String(error)}`);
        return deny("APPROVAL_FAILED", "Could not obtain approval");
      } finally {
        pending--;
        release(); // 允许、拒绝、异常和取消都必须释放队列。
      }
    },
  };
}
```

</details>

实现允许分支时，可按下面的决策表逐行检查，勿把 `allow_always_project` 写入发生在实际
Tool 执行之后的 hook：

| 输入 | 是否调用持久化 | hook 返回 | Tool 是否执行 |
|---|---|---|---|
| `deny` | 否 | `__skip` + `USER_DENIED` | 否 |
| `allow_once` | 否 | `undefined` | 是 |
| `allow_always_project`，保存成功 | 是 | `undefined` | 是；后续复用 |
| `allow_always_project`，保存失败 | 尝试并 warning | `undefined` | 本次是；后续重新询问 |
| 请求失败或容量溢出 | 否 | `__skip` + 对应错误码 | 否 |
| signal 取消 | 不启动新的等待或动作 | 抛出取消原因 | 否 |

用 a、b、c 三个并发调用演算：a 展示时 b、c 等待；拒绝 a 后 b 展示；
b 等待时取消 c，c 不应展示；b 完成后队列仍能接收新请求。
`waitWithSignal` 只结束等待；真正关闭输入框由下面的 UI 桥接负责。

#### 10.4.3 给审批和提问共用一个输入队列

一个 `pendingQuestion` 加一个全局 resolver 无法承受并发调用。这里直接提供辅助队列，
审批和提问进入同一条 FIFO，每条请求持有自己的 Promise、id 和清理函数。

目标文件：`src/cli/tui/human-input.ts`：

<details>
<summary>展开输入队列完整代码</summary>

```ts
import type { ApprovalRequest } from "@/coding/permissions/approval-middleware";

export type HumanPrompt =
  | { kind: "approval"; request: ApprovalRequest }
  | { kind: "question"; question: string; choices?: string[] };
export interface PendingHumanInput {
  id: string;
  prompt: HumanPrompt;
}
interface Entry {
  view: PendingHumanInput;
  finish(answer?: string, error?: Error): void;
}

export class HumanInputQueue {
  private readonly _entries: Entry[] = [];
  private readonly _listeners = new Set<() => void>();

  get current(): PendingHumanInput | undefined {
    return this._entries[0]?.view;
  }

  subscribe(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  request(prompt: HumanPrompt, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this._entries.length >= 16) return Promise.reject(new Error("Human input queue is full"));
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => entry.finish(undefined, new DOMException("Input cancelled", "AbortError"));
      const entry: Entry = {
        view: { id: crypto.randomUUID(), prompt },
        finish: (answer, error) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          this._entries.splice(this._entries.indexOf(entry), 1);
          if (error) reject(error);
          else resolve(answer!);
          this._emit();
        },
      };
      this._entries.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this._emit();
      if (signal?.aborted) onAbort();
    });
  }

  answer(id: string, answer: string): boolean {
    const entry = this._entries[0];
    if (!entry || entry.view.id !== id) return false; // 拒绝迟到的旧界面答案。
    entry.finish(answer);
    return true;
  }

  cancelAll(): void {
    for (const entry of [...this._entries]) {
      entry.finish(undefined, new DOMException("Input cancelled", "AbortError"));
    }
  }

  private _emit(): void {
    this._listeners.forEach((listener) => listener());
  }
}
```

</details>

这个队列只解决输入等待，不决定哪个工具危险。审批策略仍在 Middleware 中。
10C 可先把两个面板都放在 `app.tsx`，10D 再拆组件：

1. App 接收同一个 `humanInput`；用 `useSyncExternalStore` 订阅
   `humanInput.subscribe(listener)`，snapshot 返回 `humanInput.current`。
2. 有当前请求时，暂停聊天输入框焦点。审批显示 `toolName` 和 `toolUse.input`，
   用 a/p/d 分别返回 `allow_once` / `allow_always_project` / `deny`。
3. 问题分支使用单独的 `TextInput`；`key={pending.id}` 使新问题的输入状态独立。
   提交时调用 `humanInput.answer(pending.id, text)`，不要调用聊天的 submit。
4. Ctrl+C 调 `agent.abort()`；卸载时再 `humanInput.cancelAll()` 并移除订阅。
   不要在请求仍等待时直接清空 UI 状态。

订阅和审批按键可直接按下面接线，放在 App 内、其他 Hook 旁边：

```ts
const pending = useSyncExternalStore(
  (listener) => humanInput.subscribe(listener),
  () => humanInput.current,
);
useEffect(() => () => humanInput.cancelAll(), [humanInput]);
useInput((input, key) => {
  if (key.ctrl || pending?.prompt.kind !== "approval") return;
  const decisions: Record<string, string> = {
    a: "allow_once", p: "allow_always_project", d: "deny",
  };
  const answer = decisions[input];
  if (answer) humanInput.answer(pending.id, answer);
});
```

记得从 React 导入新增 hooks。`pending` 来自输入队列；10.3 reducer 的
`approval_requested/approval_resolved` 是独立测试用的展示事件接口，使用队列时可以不派发，
避免再维护一份审批队列。

完成接线后，可用下面的完整最小界面对照替换 10B 的 `app.tsx`。它已包含
Todo、token 和斜杠命令；10D 只需按展示职责拆组件，并在 Footer 加上模型名称。

<details>
<summary>展开 10C 可运行的完整界面：<code>app.tsx</code></summary>

```tsx
import { Box, Text, render, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import { memo, useEffect, useState, useSyncExternalStore } from "react";

import type { Agent } from "@/agent/agent";
import type { TodoSystem } from "@/agent/todos/todo-system";
import { formatTranscript } from "@/foundation/messages";

import { useAgentLoop } from "./hooks/use-agent-loop";
import type { HumanInputQueue, PendingHumanInput } from "./human-input";
import { parseSlashCommand } from "./state";

const QuestionInput = memo(function QuestionInput({ pending, humanInput }: {
  pending: PendingHumanInput;
  humanInput: HumanInputQueue;
}) {
  const [answer, setAnswer] = useState("");
  if (pending.prompt.kind !== "question") return null;
  return <Box flexDirection="column">
    <Text>{pending.prompt.question}</Text>
    <Text>{pending.prompt.choices?.join(" / ") ?? "Type your answer"}</Text>
    <TextInput value={answer} onChange={setAnswer} onSubmit={(text) => {
      if (text.trim()) humanInput.answer(pending.id, text);
    }} />
  </Box>;
});

export const App = memo(function App({ agent, todos, humanInput }: {
  agent: Agent;
  todos: TodoSystem;
  humanInput: HumanInputQueue;
}) {
  const { state, submit, clear, abort } = useAgentLoop(agent, todos);
  const [input, setInput] = useState("");
  const [notice, setNotice] = useState("");
  const { exit } = useApp();
  const pending = useSyncExternalStore(
    (listener) => humanInput.subscribe(listener),
    () => humanInput.current,
  );
  useEffect(() => () => humanInput.cancelAll(), [humanInput]);
  useInput((keyInput, key) => {
    if (key.ctrl && keyInput === "c") {
      if (agent.streaming) abort();
      else exit();
      return;
    }
    if (key.ctrl || pending?.prompt.kind !== "approval") return;
    const decisions: Record<string, string> = {
      a: "allow_once", p: "allow_always_project", d: "deny",
    };
    const answer = decisions[keyInput];
    if (answer) humanInput.answer(pending.id, answer);
  });

  function handleInput(text: string): void {
    if (agent.streaming || pending) return;
    setInput("");
    setNotice("");
    try {
      const command = parseSlashCommand(text);
      if (!command) { void submit(text); return; }
      if (command.name === "clear") clear();
      if (command.name === "help") setNotice("/clear  /help  /exit");
      if (command.name === "exit") exit();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  return <Box flexDirection="column">
    <Text>{formatTranscript(state.messages)}</Text>
    <Text>{state.streaming ? "Working…" : "Ready"}</Text>
    <Text>{state.error ?? notice}</Text>
    <Text>{state.todos.map((item) => `[${item.status}] ${item.text}`).join("\n")}</Text>
    <Text>Input tokens: {state.tokenUsage.latestInputTokens} | Total: {state.tokenUsage.sessionTotalTokens}</Text>
    {pending?.prompt.kind === "approval" && <Box flexDirection="column">
      <Text>{pending.prompt.request.toolName}: {JSON.stringify(pending.prompt.request.toolUse.input)}</Text>
      <Text>a: allow once | p: allow for project | d: deny</Text>
    </Box>}
    {pending?.prompt.kind === "question" &&
      <QuestionInput key={pending.id} pending={pending} humanInput={humanInput} />}
    {!pending && <TextInput value={input} onChange={setInput}
      focus={!state.streaming} onSubmit={handleInput} />}
  </Box>;
});

export function mountApp(options: { agent: Agent; todos: TodoSystem; humanInput: HumanInputQueue }) {
  return render(<App {...options} />, { exitOnCtrlC: false });
}
```

</details>

#### 10.4.4 组装与持久化练习

目标文件：`src/cli/index.ts`。用下述入口替换阶段 0 的 ready 示例，保留 `main` 导出供原测试使用。
如果已经添加配置子命令，把它们注册在同一个 `program` 上。App 和 `mountApp` 的参数对应扩为 `{ agent, todos, humanInput }`，并把
`todos` 传给 `useAgentLoop(agent, todos)`。

```ts
import { realpath } from "node:fs/promises";

import { Command } from "commander";
import { parse } from "yaml";

import { TodoSystem } from "@/agent/todos/todo-system";
import { defineCodingAgent } from "@/coding/agents/coding-agent";
import { defineApprovalMiddleware } from "@/coding/permissions/approval-middleware";
import type { ApprovalPersistence } from "@/coding/permissions/approval-middleware";

import { defineConfiguredModel } from "./config/model-factory";
import { parseHarnessConfig } from "./config/schema";
import { mountApp } from "./tui/app";
import { HumanInputQueue } from "./tui/human-input";

export async function startChat(configPath: string, persistence?: ApprovalPersistence): Promise<void> {
  const config = parseHarnessConfig(parse(await Bun.file(configPath).text()));
  const cwd = await realpath(process.cwd());
  const humanInput = new HumanInputQueue();
  const todos = new TodoSystem({ reminderAfterSteps: 3 });
  const policyMiddleware = defineApprovalMiddleware({
    projectId: cwd, maxQueueLength: 8, persistence,
    requestDecision: async (request, signal) => {
      const answer = await humanInput.request({ kind: "approval", request }, signal);
      if (answer === "allow_once" || answer === "allow_always_project" || answer === "deny") return answer;
      return "deny";
    },
  });
  const agent = await defineCodingAgent({
    cwd, model: defineConfiguredModel(config), todos, policyMiddleware,
    askUserQuestion: async ({ question, choices, signal }) => ({
      answer: await humanInput.request({ kind: "question", question, choices }, signal),
    }),
  });
  await mountApp({ agent, todos, humanInput }).waitUntilExit();
}

export async function main(argv: string[] = Bun.argv): Promise<void> {
  const program = new Command();
  program.name("harness-lab")
    .option("-c, --config <path>", "model config file", "harness.config.yaml")
    .action(async (options: { config: string }) => { await startChat(options.config); });
  await program.parseAsync(argv);
}

if (import.meta.main) await main();
```

先不传 persistence，跑通 allow_once、deny、取消；再实现重启后的项目允许列表。
这是本节第二个练习，目标文件 `src/coding/permissions/approval-persistence.ts`：

| 步骤 | 具体提示 |
|---|---|
| 读取 | 工厂接收由 CLI 传入的存储 path；JSON 形状为 `{ version: 1, projects: Record<string, string[]> }`，用 Zod 校验；仅 ENOENT 作为空表 |
| `has(projectId, toolName)` | 检查对应项目的数组是否 includes；不存在返回 false，不把别的项目的许可混进来 |
| `add(projectId, toolName)` | 对该项目数组用 Set 去重；先形成候选表再写入；写失败向外抛，由 Middleware warning |
| 存储位置 | 使用用户配置目录，如 `~/.config/harness-lab/approvals.json`；由 CLI 展开 `~` 并传入真实绝对路径 |
| 写入 | 创建父目录，写到同目录唯一临时文件后 rename；失败清理临时文件。通过 Promise 链串行化同一实例的 add，避免丢更新 |
| 验收 | 用临时目录保存后重新创建 persistence，原项目命中、另一个项目不命中；损坏 JSON 抛错，不能当作授权成功 |

为避免重新设计 JSON 存取和写入队列，下面提供辅助实现，只留 `add` 中的集合更新。
这是一份完整文件，目标为 `src/coding/permissions/approval-persistence.ts`：

<details>
<summary>展开持久化参照与一处练习：<code>approval-persistence.ts</code></summary>

```ts
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { ApprovalPersistence } from "./approval-middleware";

const approvalFileSchema = z.object({
  version: z.literal(1),
  projects: z.record(z.string(), z.array(z.string())),
});
type ApprovalFile = z.infer<typeof approvalFileSchema>;

export function defineApprovalPersistence(options: { path: string }): ApprovalPersistence {
  let tail = Promise.resolve();

  async function read(): Promise<ApprovalFile> {
    try {
      return approvalFileSchema.parse(await Bun.file(options.path).json());
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return { version: 1, projects: {} };
      throw error;
    }
  }

  async function save(value: ApprovalFile): Promise<void> {
    await mkdir(dirname(options.path), { recursive: true });
    const temporary = `${options.path}.${crypto.randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, JSON.stringify(value, null, 2));
      await rename(temporary, options.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  return {
    has: async (projectId, toolName) => {
      await tail; // 等待当前实例已经提交的写请求，避免读到上一份状态。
      return (await read()).projects[projectId]?.includes(toolName) ?? false;
    },
    add: (projectId, toolName) => {
      const operation = tail.then(async () => {
        const current = await read();
        // TODO 1：从 current.projects[projectId] ?? [] 构造 Set，add(toolName)。
        // current.projects[projectId] = [...allowed]；然后 await save(current)。
        // read 返回独立对象；只有 rename 成功才提交磁盘状态，不需要另设缓存。
        throw new Error("TODO: merge and save project approval");
      });
      // 调用方仍收到 operation 的失败；队列自身恢复，下一次 add 可以继续。
      tail = operation.catch(() => {});
      return operation;
    },
  };
}
```

</details>

CLI 使用 `join(homedir(), ".config", "harness-lab", "approvals.json")` 作为存储路径，
用 `defineApprovalPersistence({ path })` 创建实例并传给 `startChat(configPath, persistence)`。
不要把含 `~` 的字符串直接交给 Bun.file；Node/Bun 文件 API 不替你做 shell 展开。
同一实例的 add 已串行化，文件替换也使用同目录 rename；多进程写入锁留作扩展。

在 CLI 初始化 persistence 并传给 `startChat` 后，才支持 `allow_always_project` 的跨进程复用。
阶段 13 才升级到命令、路径和网络目标的细粒度策略。

### 10.5 Token usage

目标文件：`src/cli/tui/token-usage.ts`

token 是模型处理文本时的计量单位，不等同于字数或词数。这里仅汇总助手消息中由 Provider 实际报告的 `usage`：

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

这些用量是服务端报告的观测值，不能精确算出下一次请求会占用多少上下文空间。
tokenizer（分词器）按模型规则将文本拆成 token；阶段 13 会另建用量估算和预算机制，在请求前控制上下文大小。

### 运行与观察

```bash
bun run dev
```

手工验收脚本：

1. 输入普通问候，观察忙碌提示、最终回复和 token 用量；
2. 请求读取文件，确认无审批；
3. 请求修改文件，选择拒绝（`deny`），确认模型收到拒绝；
4. 再请求修改，选择仅允许本次（`allow_once`）；
5. 运行耗时命令，按 Ctrl+C，确认子进程结束；
6. 使用 `/clear`，确认 UI 和 Agent 对话记录同时清空；
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
import { defineConfiguredModel } from "../model-factory";

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

  test("resolves credentials only in the factory and forwards model options", () => {
    const config = parseHarnessConfig({ defaultModel: "local", models: {
      local: { provider: "openai", model: "test-model", apiKeyEnv: "TEST_KEY", options: { temperature: 0.2 } },
    } });
    expect(() => defineConfiguredModel(config, {})).toThrow("Missing environment variable: TEST_KEY");
    const model = defineConfiguredModel(config, { TEST_KEY: "fixture-key" });
    expect(model.name).toBe("test-model");
    expect(model.options).toEqual({ temperature: 0.2 });
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
    })).toThrow("defaultModel: unknown model missing");
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

const agentContext = { prompt: "", messages: [] };

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

    expect(await middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("read", "read_file") }))
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

    const results = await Promise.all([
      middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("a") }),
      middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("b") }),
      middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("c") }),
    ]);
    expect(requested).toEqual(["a", "b", "c"]);
    expect(results).toEqual([undefined, undefined, undefined]);
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

    const first = middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("a") });
    const overflow = await middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("b") });
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

    await middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("a") });
    await middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("b") });
    expect(saved).toEqual(["write_file"]);
    expect(requests).toBe(1);
  });

  test("warns on persistence failure but still allows this invocation", async () => {
    const warnings: string[] = [];
    const middleware = defineApprovalMiddleware({
      projectId: "fixture", maxQueueLength: 1,
      requestDecision: async () => "allow_always_project",
      persistence: {
        has: async () => false,
        add: async () => { throw new Error("disk unavailable"); },
      },
      onWarning: (warning) => warnings.push(warning),
    });
    expect(await middleware.beforeToolUse?.({ agentContext, toolUse: toolUse("a") })).toBeUndefined();
    expect(warnings.join("\n")).toContain("disk unavailable");
  });

  test("cancels a waiting request without showing it and releases the queue", async () => {
    const shown: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markShown!: () => void;
    const firstShown = new Promise<void>((resolve) => { markShown = resolve; });
    const middleware = defineApprovalMiddleware({
      projectId: "fixture", maxQueueLength: 2,
      requestDecision: async ({ toolUse }) => {
        shown.push(toolUse.id);
        if (toolUse.id === "a") { markShown(); await gate; }
        return "allow_once";
      },
    });
    const first = middleware.beforeToolUse!({ agentContext, toolUse: toolUse("a") });
    await firstShown;
    const controller = new AbortController();
    const waiting = middleware.beforeToolUse!({ agentContext, toolUse: toolUse("b"), signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toHaveProperty("name", "AbortError");
    release();
    await first;
    await middleware.beforeToolUse!({ agentContext, toolUse: toolUse("c") });
    expect(shown).toEqual(["a", "c"]);
  });
});
```

</details>

目标文件：`src/coding/permissions/__tests__/approval-persistence.test.ts`：

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineApprovalPersistence } from "../approval-persistence";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "harness-approvals-"));
  roots.push(root);
  return join(root, "approvals.json");
}

describe("approval persistence", () => {
  test("serializes additions, deduplicates, and survives recreation without crossing projects", async () => {
    const path = await fixturePath();
    const persistence = defineApprovalPersistence({ path });
    expect(await persistence.has("/project-a", "write_file")).toBe(false);
    await Promise.all([
      persistence.add("/project-a", "write_file"),
      persistence.add("/project-a", "mkdir"),
      persistence.add("/project-a", "write_file"),
    ]);
    const reopened = defineApprovalPersistence({ path });
    expect(await reopened.has("/project-a", "write_file")).toBe(true);
    expect(await reopened.has("/project-b", "write_file")).toBe(false);
    expect((await Bun.file(path).json()).projects["/project-a"]).toEqual(["write_file", "mkdir"]);
  });

  test("rejects corrupt storage without overwriting it and can retry after repair", async () => {
    const path = await fixturePath();
    await Bun.write(path, "not JSON");
    const persistence = defineApprovalPersistence({ path });
    await expect(persistence.has("/project-a", "write_file")).rejects.toThrow();
    await expect(persistence.add("/project-a", "write_file")).rejects.toThrow();
    expect(await Bun.file(path).text()).toBe("not JSON");
    await rm(path);
    await persistence.add("/project-a", "write_file");
    expect(await persistence.has("/project-a", "write_file")).toBe(true);
  });
});
```

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
    const started = reduceAgentEvent(initialAgentLoopViewState(), { type: "run_start" });
    const messaged = reduceAgentEvent(started, {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    });
    const approval = reduceAgentEvent(messaged, {
      type: "approval_requested",
      request: {
        id: "approval-1", toolName: "write_file",
        toolUse: { type: "tool_use", id: "call-1", name: "write_file", input: {} },
      },
    });
    const ended = reduceAgentEvent(approval, { type: "run_end" });

    expect(started.streaming).toBe(true);
    expect(messaged.messages).toHaveLength(1);
    expect(approval.pendingApproval).toMatchObject({ id: "approval-1" });
    expect(ended.streaming).toBe(false);
    expect(ended.pendingApproval).toBeUndefined();
  });

  test("keeps progress and client errors out of transcript and copies Todos", () => {
    const state = initialAgentLoopViewState();
    const progressed = reduceAgentEvent(state, { type: "progress", subtype: "thinking" });
    const failed = reduceAgentEvent(progressed, { type: "client_error", message: "network error" });
    expect(failed.messages).toEqual([]);
    expect(failed.error).toBe("network error");
    expect(failed.tokenUsage.sessionTotalTokens).toBe(0);
    const items = [{ id: "a", text: "inspect", status: "pending" as const }];
    const updated = reduceAgentEvent(failed, { type: "todos_updated", items });
    items[0]!.text = "mutated";
    expect(updated.todos[0]!.text).toBe("inspect");
    expect(reduceAgentEvent(updated, { type: "cleared" })).toEqual(initialAgentLoopViewState());
  });

  test("can start a new run after abort", () => {
    const aborted = reduceAgentEvent(
      reduceAgentEvent(initialAgentLoopViewState(), { type: "run_start" }),
      { type: "run_end", status: "aborted" },
    );
    expect(reduceAgentEvent(aborted, { type: "run_start" }).streaming).toBe(true);
  });
});
```

</details>

目标文件：`src/cli/tui/__tests__/human-input.test.ts`。这里不渲染终端，直接验证
UI 所依赖的等待、配对与取消契约：

```ts
import { describe, expect, test } from "bun:test";

import { HumanInputQueue } from "../human-input";

describe("HumanInputQueue", () => {
  test("answers concurrent questions in FIFO order and rejects stale ids", async () => {
    const queue = new HumanInputQueue();
    const first = queue.request({ kind: "question", question: "first?" });
    const firstId = queue.current!.id;
    const second = queue.request({ kind: "question", question: "second?" });
    expect(queue.current!.prompt).toMatchObject({ question: "first?" });
    expect(queue.answer(firstId, "one")).toBe(true);
    expect(queue.answer(firstId, "late answer")).toBe(false);
    expect(queue.current!.prompt).toMatchObject({ question: "second?" });
    queue.answer(queue.current!.id, "two");
    expect(await Promise.all([first, second])).toEqual(["one", "two"]);
    expect(queue.current).toBeUndefined();
  });

  test("aborts active input and accepts a fresh request", async () => {
    const queue = new HumanInputQueue();
    const controller = new AbortController();
    const pending = queue.request({ kind: "question", question: "wait?" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(queue.current).toBeUndefined();
    const next = queue.request({ kind: "question", question: "ready?" });
    queue.answer(queue.current!.id, "yes");
    expect(await next).toBe("yes");
  });

  test("unmount cancellation settles every waiting caller", async () => {
    const queue = new HumanInputQueue();
    const pending = Promise.allSettled([
      queue.request({ kind: "question", question: "one?" }),
      queue.request({ kind: "question", question: "two?" }),
    ]);
    queue.cancelAll();
    expect((await pending).map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(queue.current).toBeUndefined();
  });
});
```

最后执行本阶段的完整测试：

```bash
bun test src/cli src/coding/permissions
```


### 基础复刻总验收

- [ ] `bun run check` 全部通过；
- [ ] 使用预设响应的离线示例始终可运行；
- [ ] 配置密钥后真实 Provider 可用；
- [ ] 只读工具与修改型工具的审批行为不同；
- [ ] 取消操作能结束模型请求和子进程；
- [ ] Skills、Todo、`AGENTS.md` 在 TUI 可观察；
- [ ] 配置不保存密钥；
- [ ] `ADR-011` 解释 Human-in-the-loop 的 fail-open/fail-closed 选择；
- [ ] 创建 `v0.1.0` 版本标签。

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

- 哪些数据属于内部统一状态；
- 哪些只是为单次请求临时整理的数据；
- 哪些是外部副作用；
- 哪些信息适合写入运行追踪记录；
- 异常中断时最少要保存什么才能恢复。

最后一个问题正是下一部分的起点。
