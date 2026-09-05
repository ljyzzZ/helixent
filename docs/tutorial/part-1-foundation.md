# 第一部分：工程基础与 Foundation

这一部分完成阶段 0～3。结束时你还没有真正的 Agent，但已经拥有 Agent runtime 最重要的三组稳定契约：Message、Model 和 Tool。

如果你还不熟悉 TypeScript 的类型、union、generic、class 或 async/await，请先阅读[第零部分：TypeScript 必备基础](./part-0-typescript-basics.md)。

不要急着调用真实模型。先使用 deterministic fake 建立可重复测试，后面出现错误时才能判断问题来自 harness 还是 provider。

## 阶段 0：建立可运行工程

> 开始前回顾：第零部分已经覆盖本教程所需的 TypeScript 类型、模块、异步与流式基础；现在把这些知识落到一个可运行的 Bun 工程中。

### 目标

- 建立 Bun + TypeScript strict 项目；
- 固定四层依赖方向；
- 保留第一个可运行示例和测试；
- 建立 `bun run check` 质量门。

### 0.1 初始化

在新的 `harness-lab` 仓库中执行：

```bash
bun init -y
bun add zod
bun add -d typescript @types/bun
rm index.ts
mkdir -p src/foundation src/agent src/coding src/community src/cli/__tests__
mkdir -p examples docs/decisions
touch src/cli/index.ts src/cli/__tests__/index.test.ts
```

本阶段命令完成后的核心结构如下（省略依赖目录）：

```text
package.json                 # 定义 Bun scripts 与项目依赖
tsconfig.json                # 开启 TypeScript strict 和路径别名
bun.lock                     # 锁定依赖版本
src/
├── foundation/              # 保存稳定的底层类型和契约
├── agent/                   # 预留通用 Agent runtime
├── coding/                  # 预留 Coding Agent 能力
├── community/               # 预留第三方 Provider adapters
└── cli/
    ├── index.ts             # 提供最小 CLI 入口
    └── __tests__/
        └── index.test.ts    # 验证 CLI 入口可以调用
examples/                    # 保存各阶段可运行示例
docs/
└── decisions/               # 保存架构决策记录 ADR
```

`bun init` 生成的根目录 `index.ts` 是临时示例入口。本教程统一使用
`src/cli/index.ts`，因此删除它，并同时删除 `package.json` 中指向它的
`"module": "index.ts"`。

将 `tsconfig.json` 调整为：

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
    "types": ["bun"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "strict": true,
    "noEmit": true,
    "noUncheckedIndexedAccess": true,
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*.ts", "examples/**/*.ts"]
}
```


在 `package.json` 中建立脚本。下面只是需要合并的字段，不要覆盖 `name`、
`private`、`dependencies` 或 `devDependencies`：

```json
{
  "type": "module",
  "scripts": {
    "dev": "bun run src/cli/index.ts",
    "check:types": "tsc --noEmit",
    "test": "bun test",
    "check": "bun run check:types && bun test"
  }
}
```


同时，在 `package.json` 中，如果 `bun init` 将 TypeScript 放在
`peerDependencies`，请将它移动到 `devDependencies`；练习项目只在开发时使用编译器，
不要求下游使用者提供 TypeScript。

完成后确认 `typescript` 和 `@types/bun` 都位于 `devDependencies`，并且不存在
指向已删除入口的 `"module": "index.ts"`。依赖版本由前面的 `bun add` 命令写入，
不需要手工填写。

### 0.2 第一个程序

目标文件：`src/cli/index.ts`（已由 0.1 的命令创建）：

```ts
export function main() {
  console.log("harness-lab ready");
}

if (import.meta.main) {
  main();
}
```

目标文件：`src/cli/__tests__/index.test.ts`（测试内容完整复制，不需要补 TODO）：

```ts
import { describe, expect, test } from "bun:test";

import { main } from "../index";

describe("cli", () => {
  test("exports an entrypoint", () => {
    expect(main).toBeFunction();
  });
});
```

### 运行与观察

```bash
bun run dev
bun run check
```

预期看到：

```text
harness-lab ready
1 pass
```

### 验收

- [ ] `bun run dev` 正常退出，exit code 为 0；
- [ ] `bun run check` 同时执行 type check 和 test；
- [ ] `src/foundation` 不 import `agent`、`coding` 或 `cli`；
- [ ] 写下 `ADR-001: 为什么先用分层单体而不是多个 package`。

### 复盘问题

1. TypeScript 的 path alias 是编译器行为还是 Bun runtime 行为？
2. 为什么 `foundation` 必须位于依赖图最底层？
3. 为什么从第一天就需要一个不访问网络的测试？

## 阶段 1：用 Message 建立单一事实源

> 上一阶段回顾：阶段 0 建立了 Bun + TypeScript strict 工程、四层目录和 `bun run check` 质量门，并留下了第一个可运行 checkpoint。

### 本阶段的系统能力

Agent 不是“反复拼字符串”。它维护一个有角色、有内容类型、有调用关联关系的 transcript。后续 model adapter、tool runtime、TUI、checkpoint 和 eval 都应读取同一种 `Message`。

必须保持的不变量：

1. `role` 是 Message union 的 discriminator；
2. `type` 是 Content union 的 discriminator；
3. `ToolResultContent.tool_use_id` 必须引用之前的 `ToolUseContent.id`；
4. 内部只保存 canonical message，不把 OpenAI/Anthropic wire type 泄漏进来。

### 1.1 文件结构

在项目仓库根目录执行：

```bash
mkdir -p src/foundation/messages/types src/foundation/messages/__tests__ examples
touch src/foundation/messages/types/content.ts
touch src/foundation/messages/types/message.ts
touch src/foundation/messages/types/index.ts
touch src/foundation/messages/transcript.ts
touch src/foundation/messages/index.ts
touch src/foundation/messages/__tests__/transcript.test.ts
touch examples/stage-01-transcript.ts
```

执行后应得到：

```text
src/foundation/messages/          # canonical Message 模块
├── types/                        # Message 与 Content 类型定义
│   ├── content.ts                # 定义各类 Content 及其 union
│   ├── message.ts                # 定义各角色 Message 及其 union
│   └── index.ts                  # 汇总导出 types
├── __tests__/                    # Message 模块的自动化测试
│   └── transcript.test.ts        # 验证 transcript 格式与调用关联
├── transcript.ts                 # 将 canonical messages 格式化为可读文本
└── index.ts                      # 导出 Message 模块的公共 API
examples/
└── stage-01-transcript.ts        # 演示 transcript 的格式化输出
```

### 1.2 类型骨架

目标文件：`src/foundation/messages/types/content.ts`

阅读代码时先区分两种写法：

- `interface TextContent { ... }` 声明“一条文本内容必须有哪些字段”；
- `export type MessageContent = ...` 把多个已有类型组合成 union；
- interface 内的 `type: "text"` 中，`type` 是实际对象的字段名，`"text"` 是该字段唯一
  允许的值。这个字段会保留到 JavaScript 运行时，用于判断当前 content 的种类。

普通对象既可以用 `interface` 也可以用 `type` 描述；本教程使用 `interface` 描述字段，
使用 `type` 表达数组和 union。详细对比见[第零部分：TypeScript 必备基础](./part-0-typescript-basics.md)。

下面先完整实现 `SystemMessageContent` 作为标准示例。它只允许文本，原因是本课程把
system prompt 视为纯文本运行时配置。其余三个内容类型暂时使用 `never[]`，请根据各自
注释替换数组元素类型。

<details>
<summary>展开完整代码：<code>content.ts</code></summary>

```ts
export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageURLContent {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "high" | "low";
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolUseContent<T extends Record<string, unknown> = Record<string, unknown>> {
  type: "tool_use";
  id: string;
  name: string;
  input: T;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

// 标准实现示例：system message 只接受文本块。
export type SystemMessageContent = TextContent[];

// TODO 1：用户可以发送文本或图片。
// 提示：写成由 TextContent 和 ImageURLContent 组成的数组元素 union。
export type UserMessageContent = never[];

// TODO 2：assistant 可以输出文本、thinking 或发起 Tool call。
// 提示：不要加入 ToolResultContent；Tool result 只属于 role="tool"。
export type AssistantMessageContent = never[];

// TODO 3：Tool message 只承载 ToolResultContent 数组。
// 提示：直接把 never 替换为 ToolResultContent。
export type ToolMessageContent = never[];

// formatter 等跨角色工具使用的穷尽 union；这里给出完整实现。
export type MessageContent =
  | TextContent
  | ImageURLContent
  | ThinkingContent
  | ToolUseContent
  | ToolResultContent;
```

</details>

目标文件：`src/foundation/messages/types/message.ts`

`UserMessage` 是本文件的标准实现示例。注意 `role` 必须是 string literal，不能放宽为
`string`。请根据注释填写 `AssistantMessage` 和 `ToolMessage` 的字段，并替换两个顶层
union 中的 `never` 占位。

<details>
<summary>展开完整代码：<code>message.ts</code></summary>

```ts
import type {
  AssistantMessageContent,
  SystemMessageContent,
  ToolMessageContent,
  UserMessageContent,
} from "./content";

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SystemMessage {
  role: "system";
  content: SystemMessageContent;
}

// 标准实现示例：role 是 discriminator，content 使用对应角色的 union。
export interface UserMessage {
  role: "user";
  content: UserMessageContent;
}

export interface AssistantMessage {
  // TODO 1：添加 role 字段，类型必须是 string literal "assistant"。
  // TODO 2：添加 content 字段，类型使用 AssistantMessageContent。
  // TODO 3：添加可选 usage 字段，类型使用 TokenUsage，供 provider 回传统计。
}

export interface ToolMessage {
  // TODO 4：添加 role 字段，类型必须是 string literal "tool"。
  // TODO 5：添加 content 字段，类型使用 ToolMessageContent。
}

// TODO 6：用 UserMessage、AssistantMessage、ToolMessage 的 union 替换 never；
// 这里只表示“一条非 system 消息”，不要在 union 外再加 []。
export type NonSystemMessage = never;

// TODO 7：用 SystemMessage 与 NonSystemMessage 的 union 替换 never；
// Message 同样表示单条消息，Message[] 才表示 transcript。
export type Message = never;
```

</details>

目标文件：`src/foundation/messages/types/index.ts`

```ts
export * from "./content";
export * from "./message";
```

目标文件：`src/foundation/messages/index.ts`

```ts
export * from "./types";
export * from "./transcript";
```

不要为了少写类型而使用：

```ts
interface Message {
  role: string;
  content: unknown;
}
```

这种写法把协议错误推迟到运行期，也让 provider converter 充满类型断言。

### 1.3 Transcript formatter

目标文件：`src/foundation/messages/transcript.ts`

先实现 `text` 分支作为标准示例。其余分支的注释给出了固定输出协议；完成后
`assertNever(content)` 必须可以通过类型检查。

<details>
<summary>展开完整代码：<code>transcript.ts</code></summary>

```ts
import type { Message, MessageContent } from "./types";

export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

function formatContent(role: Message["role"], content: MessageContent): string {
  switch (content.type) {
    case "text":
      // 标准实现示例：普通文本保留所属 role，便于直接阅读 transcript。
      return `${role}: ${content.text}`;
    case "image_url":
      // TODO 1：返回 `${role}.image_url: ${content.image_url.url}`。
      // detail 是显示参数，不应替换 URL，也不需要下载图片。
    case "thinking":
      // TODO 2：返回 `${role}.thinking: ${content.thinking}`。
    case "tool_use":
      // TODO 3：必须显示 id、Tool name 和 JSON input。
      // 固定格式：assistant.tool_use[id]: name {json}
    case "tool_result":
      // TODO 4：必须显示 tool_use_id，固定格式：
      // tool.tool_result[id]: content
    default:
      return assertNever(content);
  }
}

export function formatTranscript(messages: Message[]): string {
  // TODO 5：保持 messages 及每条 content 的原始顺序；
  // 每个 content block 格式化为一行，最后使用 "\n" 连接。
  // 不要排序，也不要丢弃空 content 数组对应的 message。
}
```

</details>

示例输入（目标文件：`examples/stage-01-transcript.ts`）：

- `messages` 必须按真实发生顺序排列；
- `tool_use_id` 必须等于此前 `tool_use.id`；
- `input` 必须可被 `JSON.stringify`；本阶段不处理循环引用。

```ts
import type { Message } from "@/foundation/messages";
import { formatTranscript } from "@/foundation/messages";

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "北京天气如何？" }] },
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "call-1", name: "weather", input: { city: "北京" } }],
  },
  {
    role: "tool",
    content: [{ type: "tool_result", tool_use_id: "call-1", content: "晴，26°C" }],
  },
  { role: "assistant", content: [{ type: "text", text: "北京今天晴，26°C。" }] },
];

console.info(formatTranscript(messages));
```

示例输出（顺序和关联 id 都是协议的一部分）：

```text
user: 北京天气如何？
assistant.tool_use[call-1]: weather {"city":"北京"}
tool.tool_result[call-1]: 晴，26°C
assistant: 北京今天晴，26°C。
```

### 运行与观察

```bash
bun run examples/stage-01-transcript.ts
```

把 formatter 输出保留下来。阶段 11 的 trace viewer 会复用同一套 canonical type，而不是重新解析 provider response。

### 1.4 完整测试

测试文件由教程完整提供，读者不需要补测试 TODO。

目标文件：`src/foundation/messages/__tests__/transcript.test.ts`

<details>
<summary>展开完整代码：<code>transcript.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { Message } from "../types";
import { formatTranscript } from "../transcript";

describe("formatTranscript", () => {
  test("formats text messages", () => {
    const messages: Message[] = [
      { role: "system", content: [{ type: "text", text: "Be concise" }] },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi" }] },
    ];

    expect(formatTranscript(messages)).toBe(
      ["system: Be concise", "user: Hello", "assistant: Hi"].join("\n"),
    );
  });

  test("keeps tool call correlation ids visible", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "call-1", name: "weather", input: { city: "北京" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool_result", tool_use_id: "call-1", content: "晴，26°C" }],
      },
    ];

    expect(formatTranscript(messages)).toContain(
      'assistant.tool_use[call-1]: weather {"city":"北京"}',
    );
    expect(formatTranscript(messages)).toContain("tool.tool_result[call-1]: 晴，26°C");
  });

  test("formats every current content variant", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: "https://example.com/map.png", detail: "low" } },
        ],
      },
      { role: "assistant", content: [{ type: "thinking", thinking: "Need a weather tool" }] },
    ];

    expect(formatTranscript(messages)).toBe(
      [
        "user.image_url: https://example.com/map.png",
        "assistant.thinking: Need a weather tool",
      ].join("\n"),
    );
  });
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test src/foundation/messages
```

### 阶段后对照

完成测试后再查看参考实现：

- `src/foundation/messages/types/content.ts`
- `src/foundation/messages/types/message.ts`

记录你和参考实现对 multimodal content、thinking content、token usage 的差异。

### 验收

- [ ] TypeScript 可以根据 `role` 自动缩窄 Message；
- [ ] 可以根据 `content.type` 自动缩窄 Content；
- [ ] Tool call id 在格式化后仍可见；
- [ ] 没有 provider SDK type 出现在 `foundation/messages`；
- [ ] `ADR-002` 解释为什么 transcript 是 single source of truth。

## 阶段 2：隔离模型与 Provider

> 上一阶段回顾：阶段 1 定义了 canonical Message/Content union、Tool call 关联规则和 transcript formatter，让后续各层共享同一种对话表示。

### 本阶段的系统能力

Agent 只依赖 `Model`，不知道请求最终发往哪个厂商。Provider adapter 负责 canonical Message 与外部 API 之间的转换。

必须保持的不变量：

1. `invoke(context)` 返回完整 `AssistantMessage`；
2. `stream(context)` 产出累计快照，不是增量 token；
3. `stream()` 的最后一个快照与 `invoke()` 语义等价；
4. `AbortSignal` 从 Agent 一直传到网络请求；
5. provider-specific options 不污染通用接口。

先创建本阶段文件：

```bash
mkdir -p src/foundation/models/__tests__ examples
touch src/foundation/models/model-context.ts
touch src/foundation/models/model-provider.ts
touch src/foundation/models/model.ts
touch src/foundation/models/scripted-model-provider.ts
touch src/foundation/models/index.ts
touch src/foundation/models/__tests__/model.test.ts
touch examples/stage-02-model-stream.ts
```

执行后新增结构如下：

```text
src/foundation/models/                  # 通用模型调用边界
├── model-context.ts                    # 定义每次模型调用的 canonical 输入
├── model-provider.ts                   # 定义 Provider 必须实现的接口
├── model.ts                            # 封装模型名、选项和 Provider 调用
├── scripted-model-provider.ts          # 按脚本返回结果，供离线示例与测试使用
├── index.ts                            # 导出 Models 模块的公共 API
└── __tests__/
    └── model.test.ts                   # 验证 invoke、stream 和 abort 契约
examples/
└── stage-02-model-stream.ts            # 展示累计式流式快照
```

### 2.1 契约骨架

目标文件：`src/foundation/models/model-context.ts`

```ts
import type { NonSystemMessage } from "@/foundation/messages";

export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  signal?: AbortSignal;
}
```

目标文件：`src/foundation/models/model-provider.ts`

```ts
import type { AssistantMessage, Message } from "@/foundation/messages";

export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
}
```

阶段 2 尚未定义 `Tool`，所以这里先不引用它。完成阶段 3 后，再给 `ModelContext` 和
`ModelProviderInvokeParams` 增加 `tools?: Tool[]`。这样每个 checkpoint 都能独立通过类型检查。

目标文件：`src/foundation/models/model.ts`

构造函数是标准实现示例；三个剩余 TODO 分别对应一次调用、流式调用和 system prompt 注入。

<details>
<summary>展开完整代码：<code>model.ts</code></summary>

```ts
import type { Message } from "@/foundation/messages";

import type { ModelContext } from "./model-context";
import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

export class Model {
  readonly name: string;
  readonly provider: ModelProvider;
  readonly options?: Record<string, unknown>;

  // 调用方仍传入一个 options object；这里在参数位置直接解构出三个属性。
  // 冒号左侧是 JavaScript 解构，右侧是 TypeScript 参数类型。
  constructor({ name, provider, modelOptions }: {
    name: string;
    provider: ModelProvider;
    modelOptions?: Record<string, unknown>;
  }) {
    // 标准实现示例：构造阶段只保存稳定配置，不发请求、不修改 transcript。
    this.name = name;
    this.provider = provider;
    this.options = modelOptions;
  }

  invoke(context: ModelContext) {
    // TODO 1：把 _buildProviderParams(context) 的结果传给 provider.invoke。
    // 返回值应保持 Promise<AssistantMessage>，不要在这里转换为字符串。
  }

  stream(context: ModelContext) {
    // TODO 2：把相同 params 传给 provider.stream 并直接返回 AsyncGenerator。
  }

  private _buildProviderParams(context: ModelContext): ModelProviderInvokeParams {
    const messages: Message[] = [...context.messages];

    // TODO 3：context.prompt.trim() 非空时，在 messages 最前面放入 SystemMessage；
    // 不要 push 回 context.messages，否则每次请求都会永久复制 system prompt。

    return {
      model: this.name,
      messages,
      options: this.options,
      signal: context.signal,
    };
  }
}
```

</details>

这里使用单一 options object 构造函数。即使参考版本存在 positional constructor，也不要为逐字一致牺牲可扩展性。

### 2.2 离线 ScriptedModelProvider

目标文件：`src/foundation/models/scripted-model-provider.ts`

`invoke()` 给出标准实现示例。它规定了 abort、响应耗尽和 cursor 推进的语义；
`stream()` 由读者根据分项提示实现。

<details>
<summary>展开完整代码：<code>scripted-model-provider.ts</code></summary>

```ts
import type { AssistantMessage } from "@/foundation/messages";

import type { ModelProvider, ModelProviderInvokeParams } from "./model-provider";

export class ScriptedModelProvider implements ModelProvider {
  private readonly _responses: AssistantMessage[];
  private _cursor = 0;

  constructor({ responses }: { responses: AssistantMessage[] }) {
    this._responses = responses;
  }

  async invoke({ signal }: ModelProviderInvokeParams): Promise<AssistantMessage> {
    // 标准实现示例：中止优先于任何状态推进。
    signal?.throwIfAborted();

    const response = this._responses[this._cursor];
    if (!response) {
      throw new Error("ScriptedModelProvider has no response left");
    }

    this._cursor += 1;
    return structuredClone(response);
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // TODO 1：先检查 params.signal，再读取当前 response，且只推进一次 cursor。

    // TODO 2：response 只含一个 text block 时，按 Unicode code point 逐步累积文本；
    // 其他 content 组合（例如 tool_use）直接 yield 一次完整 clone，供后续阶段复用。
    // 提示：使用 Array.from(text) 避免把 emoji 的 surrogate pair 拆开。

    // TODO 3：每次 yield 都返回完整 AssistantMessage，例如 h、he、hel。
    // TODO 4：最后一次 yield 必须与完整 response 深度相等。
    // 提示：每次 yield 时，可以将 partialResponse.content[0] 替换为文本块，
    // 其中 type 为 "text"，text 为当前累积文本。
  }
}
```

</details>

例如完整文本为 `hello`，累计快照应类似：

```text
h
he
hel
hell
hello
```

不要产生 `h`、`e`、`l`、`l`、`o` 这种 delta。累计快照让上层 UI 可以无状态
替换当前内容，也让不同 provider 的 streaming 行为统一。

> **补充理解**
>
> 真实网络场景通常使用异步循环，等待模型持续返回事件：
>
> ```ts
> for await (const event of networkStream) {
>   // 处理模型持续返回的事件
> }
> ```
>
> 网络读取本身是异步的，天然适合通过 `yield` 产生流式输出。
> 这里没有真实网络流，因此 `ScriptedModelProvider` 的 `async *stream()` 方法会主动拆分
> 完整 response 的文本块来模拟这一过程。

### 2.3 离线流式示例

目标文件：`examples/stage-02-model-stream.ts`

下面的示例通过 `Model.stream()` 消费累计快照。循环只读取 canonical
`AssistantMessage`，不接触 `ScriptedModelProvider` 的内部状态。

<details>
<summary>展开完整代码：<code>stage-02-model-stream.ts</code></summary>

```ts
import type { AssistantMessage } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";

const response: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
};

const provider = new ScriptedModelProvider({ responses: [response] });
const model = new Model({ name: "scripted", provider });
let finalMessage: AssistantMessage | undefined;

for await (const snapshot of model.stream({ prompt: "", messages: [] })) {
  const text = snapshot.content
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");

  process.stdout.write(`\r${text}`);
  finalMessage = snapshot;
  await Bun.sleep(50);
}

process.stdout.write("\n");

if (!finalMessage) {
  throw new Error("Model stream did not yield a response");
}

console.log(JSON.stringify(finalMessage, null, 2));
```

</details>

### 运行与观察

```bash
bun run examples/stage-02-model-stream.ts
```

示例每 50ms 覆盖打印当前累计文本，并在结束时打印 canonical `AssistantMessage` JSON。观察 UI 只依赖 canonical snapshot，不依赖 fake provider 的内部表示。

### 2.4 完整测试

目标文件：`src/foundation/models/__tests__/model.test.ts`

下面是完整测试文件。它使用两个独立 scripted provider 比较 `invoke` 与 `stream`，
避免 cursor 状态互相影响。

<details>
<summary>展开完整代码：<code>model.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import type { AssistantMessage } from "@/foundation/messages";

import { Model } from "../model";
import type { ModelProvider, ModelProviderInvokeParams } from "../model-provider";
import { ScriptedModelProvider } from "../scripted-model-provider";

class RecordingProvider implements ModelProvider {
  params?: ModelProviderInvokeParams;

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    this.params = params;
    return { role: "assistant", content: [{ type: "text", text: "ok" }] };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    this.params = params;
    yield { role: "assistant", content: [{ type: "text", text: "ok" }] };
  }
}

const RESPONSE: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "hello" }],
};

async function collectText(provider: ScriptedModelProvider): Promise<string[]> {
  const snapshots: string[] = [];
  for await (const message of provider.stream({ model: "scripted", messages: [] })) {
    const text = message.content.find((item) => item.type === "text");
    if (text?.type === "text") snapshots.push(text.text);
  }
  return snapshots;
}

describe("Model", () => {
  test("prepends a system message without storing it in transcript", async () => {
    const provider = new RecordingProvider();
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "Hi" }] }];
    const model = new Model({ name: "recording", provider });

    await model.invoke({ prompt: "Be concise", messages });

    expect(provider.params?.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "Be concise" }],
    });
    expect(messages).toHaveLength(1);
  });

  test("stream yields cumulative snapshots", async () => {
    const provider = new ScriptedModelProvider({ responses: [RESPONSE] });
    expect(await collectText(provider)).toEqual(["h", "he", "hel", "hell", "hello"]);
  });

  test("streams a structured response as one complete snapshot", async () => {
    const response: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call-1",
          name: "get_weather",
          input: { city: "北京" },
        },
      ],
    };
    const provider = new ScriptedModelProvider({ responses: [response] });
    const snapshots: AssistantMessage[] = [];

    for await (const snapshot of provider.stream({ model: "scripted", messages: [] })) {
      snapshots.push(snapshot);
    }

    expect(snapshots).toEqual([response]);
  });

  test("the final stream snapshot equals invoke result", async () => {
    const invokeProvider = new ScriptedModelProvider({ responses: [RESPONSE] });
    const streamProvider = new ScriptedModelProvider({ responses: [RESPONSE] });
    const invoked = await invokeProvider.invoke({ model: "scripted", messages: [] });
    let streamed: AssistantMessage | undefined;

    for await (const snapshot of streamProvider.stream({ model: "scripted", messages: [] })) {
      streamed = snapshot;
    }

    expect(streamed).toEqual(invoked);
  });

  test("passes AbortSignal to provider", async () => {
    const provider = new RecordingProvider();
    const model = new Model({ name: "recording", provider });
    const controller = new AbortController();

    await model.invoke({ prompt: "", messages: [], signal: controller.signal });

    expect(provider.params?.signal).toBe(controller.signal);
  });
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test src/foundation/models/__tests__/model.test.ts
```

### 阶段后对照

- `src/foundation/models/model-context.ts`
- `src/foundation/models/model-provider.ts`
- `src/foundation/models/model.ts`
- `src/community/openai/stream-utils.ts`

此时只理解 `StreamAccumulator` 解决的问题，不需要实现真实 OpenAI chunk parsing。

### 验收

- [ ] fake provider 不访问网络；
- [ ] system prompt 只在调用 provider 时注入；
- [ ] transcript 中没有重复 system message；
- [ ] 最终 streaming snapshot 不带 `streaming: true`；
- [ ] `ADR-003` 解释 delta 和 cumulative snapshot 的取舍。

## 阶段 3：Tool contract 与安全执行边界

> 上一阶段回顾：阶段 2 建立了 Model/Provider 边界，并用离线 Provider 固定了 `invoke`、累计式 `stream` 和 `AbortSignal` 的契约。

### 本阶段的系统能力

Tool 是模型改变外部世界的唯一出口。描述和 JSON schema 面向模型，`invoke` 面向 runtime，structured result 同时服务于模型决策、UI 展示和 eval 分类。

必须保持的不变量：

1. 每个 Tool 有唯一 name；
2. runtime 在调用实现前验证 input；
3. 预期错误返回 structured result，不靠 throw 表达业务失败；
4. `AbortSignal` 传入 Tool；
5. 模型只能调用显式注册的 Tool。

创建文件：

```bash
mkdir -p src/foundation/tools/__tests__ examples
touch src/foundation/tools/function-tool.ts
touch src/foundation/tools/structured-tool-result.ts
touch src/foundation/tools/tool-registry.ts
touch src/foundation/tools/add-tool.ts
touch src/foundation/tools/index.ts
touch src/foundation/tools/__tests__/tool-registry.test.ts
touch examples/stage-03-tool-playground.ts
```

执行后新增结构如下：

```text
src/foundation/tools/                         # Tool 定义与安全执行基础
├── function-tool.ts                          # 定义 Tool 类型和 defineTool factory
├── structured-tool-result.ts                 # 定义稳定的成功与错误结果
├── tool-registry.ts                          # 注册、查找、校验并调用 Tool
├── add-tool.ts                               # 提供首个确定性示例 Tool
├── index.ts                                  # 统一导出 Tools 模块公共 API
└── __tests__/
    └── tool-registry.test.ts                 # 验证注册、校验与错误边界
examples/
└── stage-03-tool-playground.ts               # 从命令行调用 Tool 并观察结果
```

### 3.1 Tool 类型

目标文件：`src/foundation/tools/function-tool.ts`

`defineTool()` 是本节的标准实现示例：它不包裹或复制 `options`，因此 Zod schema 的
具体类型和 `invoke` 返回值都能被 TypeScript 原样推断。

```ts
import type { z } from "zod";

export interface FunctionTool<
  P extends z.ZodSchema<Record<string, unknown>> = z.ZodSchema<Record<string, unknown>>,
  R = unknown,
> {
  name: string;
  description: string;
  parameters: P;
  invoke(input: z.infer<P>, signal?: AbortSignal): Promise<R>;
}

export type Tool = FunctionTool;

export function defineTool<P extends z.ZodSchema<Record<string, unknown>>, R>(options: {
  name: string;
  description: string;
  parameters: P;
  invoke(input: z.infer<P>, signal?: AbortSignal): Promise<R>;
}): FunctionTool<P, R> {
  // 标准实现示例：返回同一个对象即可保留 P 和 R 的完整泛型信息。
  return options;
}
```

目标文件：`src/foundation/tools/structured-tool-result.ts`

```ts
export type StructuredToolResult<T = unknown> =
  | { ok: true; summary: string; data?: T }
  | {
      ok: false;
      summary: string;
      error: string;
      code?: string;
      details?: Record<string, unknown>;
    };

export function okToolResult<T>(summary: string, data?: T): StructuredToolResult<T> {
  // TODO 1：返回 ok: true、summary 和可选 data。
  // 提示：data 为 undefined 时可以省略字段，但 ok 必须保持 literal true。
  throw new Error("TODO: implement okToolResult");
}

export function errorToolResult(
  summary: string,
  error: string,
  code?: string,
  details?: Record<string, unknown>,
): StructuredToolResult<never> {
  // TODO 2：返回 ok: false、summary、error，以及存在时的 code/details。
  // 提示：这是预期业务失败，不要在最终实现中 throw。
  throw new Error("TODO: implement errorToolResult");
}
```

### 3.2 ToolRegistry 骨架

目标文件：`src/foundation/tools/tool-registry.ts`

<details>
<summary>展开完整代码：<code>tool-registry.ts</code></summary>

```ts
import type { Tool } from "./function-tool";

export type ToolExecutionErrorCode =
  | "TOOL_NOT_FOUND"
  | "INVALID_TOOL_INPUT"
  | "ABORTED"
  | "TOOL_EXECUTION_FAILED";

export type ToolExecutionResult =
  | { ok: true; toolName: string; value: unknown }
  | {
      ok: false;
      toolName: string;
      code: ToolExecutionErrorCode;
      error: string;
    };

export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  constructor({ tools }: { tools: Tool[] }) {
    // 标准实现示例：构造阶段固定注册表，并立即拒绝重复 name。
    for (const tool of tools) {
      if (this._tools.has(tool.name)) {
        throw new Error(`Duplicate tool name: ${tool.name}`);
      }
      this._tools.set(tool.name, tool);
    }
  }

  list(): Tool[] {
    // TODO 1：读取 this._tools.values() 并返回新的数组。
    // Map 会保持插入顺序，因此不需要额外排序；不要把内部 Map 暴露给调用方。
  }

  async invoke(options: {
    name: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult> {
    // TODO 2：用 options.name 查找 Tool。未注册时立即返回 TOOL_NOT_FOUND；
    // toolName 保留调用方传入的名称，便于 trace 定位模型实际请求了什么。
    // TODO 3：对 options.input 调用 tool.parameters.safeParse()。
    // 校验失败时返回 INVALID_TOOL_INPUT，且不得进入 tool.invoke()。
    // TODO 4：调用 Tool 前检查 options.signal。已经中止时返回 ABORTED，
    // 确保具有副作用的实现不会在取消后才开始执行。
    // TODO 5：把 parsed.data 而不是原始 input 传给 tool.invoke()，同时继续传递 signal；
    // 成功后返回 { ok: true, toolName: tool.name, value }。
    // TODO 6：用 try/catch 包围真实调用。signal 已中止或捕获到 AbortError 时返回
    // ABORTED；其余异常转换为 TOOL_EXECUTION_FAILED，并保留可读的错误消息。
    // 单个 Tool 的异常不能逃出 Registry 并终止整个 Agent loop。
  }
}
```

</details>

`ToolRegistry` 是模型输出进入本地代码前的信任边界。虽然 TypeScript 已经为
`tool.invoke()` 描述了参数类型，但模型返回的是运行时 JSON，可能缺少字段、包含错误类型，
也可能请求一个根本没有注册的 Tool；静态类型无法验证这些外部数据。因此 `invoke()` 的
输入必须保持为 `unknown`，并在 Registry 内完成查找和 Zod 校验。

`ToolExecutionErrorCode` 使用字符串字面量 union，而不是 `enum`。这些错误码需要写入
transcript、trace 和测试结果，直接使用字符串既不会生成额外的 runtime 对象，也能让
TypeScript 拒绝拼错或尚未定义的错误码。

失败分支中的两个字段承担不同职责：

| 字段 | 用途 | 示例 |
|---|---|---|
| `code` | 稳定、机器可读的错误类别，供 Agent、UI 和测试进行分支判断 | `"TOOL_NOT_FOUND"` |
| `error` | 可读的具体错误消息，携带本次调用的上下文 | `"Unknown tool: missing"` |

因此“返回 `TOOL_NOT_FOUND`”是“返回一个 `code` 为 `TOOL_NOT_FOUND` 的失败对象”的简称，
不是把错误码转换成另一个字段。例如未注册 Tool 的完整返回值是：

```ts
return {
  ok: false,
  toolName: options.name,
  code: "TOOL_NOT_FOUND",
  error: `Unknown tool: ${options.name}`,
};
```

其余失败沿用相同 shape，只替换 `code` 和具体消息：

| 失败条件 | `code` | `error` 的来源 |
|---|---|---|
| Tool 未注册 | `TOOL_NOT_FOUND` | 包含请求中的 Tool name |
| Zod 校验失败 | `INVALID_TOOL_INPUT` | 使用 `parsed.error.message` 或等价摘要 |
| 调用前或执行中被取消 | `ABORTED` | 说明本次 Tool 调用已中止 |
| Tool 抛出其他异常 | `TOOL_EXECUTION_FAILED` | `Error.message`，非 `Error` 值用 `String(error)` |

实现时按以下顺序处理，顺序不要交换：

1. 根据 `name` 查找 Tool，找不到就返回 `TOOL_NOT_FOUND`；
2. 使用 `safeParse()` 校验 `input`，失败就返回 `INVALID_TOOL_INPUT`；
3. 在产生副作用前检查 `AbortSignal`，已经取消就返回 `ABORTED`；
4. 使用 `parsed.data` 调用 Tool，因为它包含 Zod 执行 default、transform 等规则后的结果；
5. 捕获 Tool 抛出的异常，将中止和普通执行失败分别归一化为稳定错误码。

这里使用 `safeParse()` 而不是 `parse()`，是因为非法模型输入属于可以预期的运行结果，
不应依赖异常控制正常分支。调用方只需要检查 `result.ok` 就能缩窄 union：成功时读取
`value`，失败时读取 `code` 和 `error`，无需解析错误文本或捕获 Registry 异常。

`list()` 同样要返回新数组，例如从 `Map.values()` 展开。这样 Provider 可以按照注册顺序
生成 Tool definitions，同时调用方无法通过修改返回值破坏 Registry 内部状态。

最后注意两个结果层级：`ToolExecutionResult` 描述 Registry 是否成功找到、校验并调用
Tool；Tool 实现返回的 `StructuredToolResult` 则是调用成功后放在 `value` 中的业务结果。
例如 Tool 正常运行并报告“目标文件不存在”时，Registry 仍可能返回
`{ ok: true, value: { ok: false, ... } }`。前一个 `ok` 属于执行边界，后一个 `ok` 属于
Tool 的业务语义，不要把两者合并判断。

### 3.3 第一个 Tool

目标文件：`src/foundation/tools/add-tool.ts`

示例输入规则：`description`、`left`、`right` 都是必填字段，两个数字必须是 finite；
额外字段是否允许由你选择的 Zod object policy 决定，但需要通过测试固定。

```ts
import { z } from "zod";

import { defineTool } from "./function-tool";
import { okToolResult } from "./structured-tool-result";

export const addTool = defineTool({
  name: "add",
  description: "Add two finite numbers",
  parameters: z.object({
    description: z.string(),
    left: z.number().finite(),
    right: z.number().finite(),
  }),
  invoke: async ({ left, right }) => {
    return okToolResult(`Calculated ${left} + ${right}`, {
      left,
      right,
      sum: left + right,
    });
  },
});
```

`description` 是模型解释这次调用意图的字段，不是 Tool 自身的 description。它能改善审批 UI 和 trace 可读性。

目标文件：`src/foundation/tools/index.ts`

完成上述实现文件后，通过 barrel 统一导出公共 API：

```ts
export { addTool } from "./add-tool";
export { defineTool } from "./function-tool";
export type { FunctionTool, Tool } from "./function-tool";
export { errorToolResult, okToolResult } from "./structured-tool-result";
export type { StructuredToolResult } from "./structured-tool-result";
export { ToolRegistry } from "./tool-registry";
export type { ToolExecutionErrorCode, ToolExecutionResult } from "./tool-registry";
```

现在回到以下两个文件加入 `tools?: Tool[]`。

目标文件：`src/foundation/models/model-context.ts`

```ts
import type { NonSystemMessage } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}
```

目标文件：`src/foundation/models/model-provider.ts`

```ts
import type { AssistantMessage, Message } from "@/foundation/messages";
import type { Tool } from "@/foundation/tools";

export interface ModelProviderInvokeParams {
  model: string;
  messages: Message[];
  tools?: Tool[];
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ModelProvider {
  invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage>;
  stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage>;
}
```

最后在 `src/foundation/models/model.ts` 的 `_buildProviderParams()` 返回值中转发
`ModelContext.tools`：

```ts
return {
  model: this.name,
  messages,
  tools: context.tools,
  options: this.options,
  signal: context.signal,
};
```

此时 `@/foundation/tools` 会解析到上面的 `index.ts`，而 `import type` 不会产生
runtime 循环依赖。

### 3.4 Tool playground

目标文件：`examples/stage-03-tool-playground.ts`

这个 CLI 把命令行中的 Tool name 和 JSON input 交给 `ToolRegistry`。JSON 解析错误同样
输出 structured error，不打印 stack trace。

<details>
<summary>展开完整代码：<code>stage-03-tool-playground.ts</code></summary>

```ts
import { addTool } from "@/foundation/tools/add-tool";
import { ToolRegistry } from "@/foundation/tools/tool-registry";

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(): Promise<void> {
  const [toolName, rawInput] = Bun.argv.slice(2);

  if (!toolName || !rawInput) {
    print({
      ok: false,
      code: "INVALID_ARGUMENTS",
      error: "Usage: bun run examples/stage-03-tool-playground.ts <tool> <json-input>",
    });
    process.exitCode = 1;
    return;
  }

  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch (error) {
    print({
      ok: false,
      toolName,
      code: "INVALID_JSON_INPUT",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const registry = new ToolRegistry({ tools: [addTool] });
  print(await registry.invoke({ name: toolName, input }));
}

await main();
```

</details>

### 运行与观察

```bash
bun run examples/stage-03-tool-playground.ts add '{"description":"demo","left":2,"right":3}'
bun run examples/stage-03-tool-playground.ts add '{"left":2,"right":3}'
```

预期分别看到 success JSON 和带稳定 error code 的 error JSON。不要只输出 stack trace。

### 3.5 完整测试

目标文件：`src/foundation/tools/__tests__/tool-registry.test.ts`

<details>
<summary>展开完整代码：<code>tool-registry.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { addTool } from "../add-tool";
import { defineTool } from "../function-tool";
import { ToolRegistry } from "../tool-registry";

describe("ToolRegistry", () => {
  test("returns the add result for valid input", async () => {
    const registry = new ToolRegistry({ tools: [addTool] });

    const result = await registry.invoke({
      name: "add",
      input: { description: "sum two numbers", left: 2, right: 3 },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        ok: true,
        summary: "Calculated 2 + 3",
        data: { left: 2, right: 3, sum: 5 },
      });
    }
  });

  test("rejects input without description", async () => {
    const registry = new ToolRegistry({ tools: [addTool] });
    const result = await registry.invoke({
      name: "add",
      input: { left: 2, right: 3 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_TOOL_INPUT" });
  });

  test("rejects non-finite numbers", async () => {
    const registry = new ToolRegistry({ tools: [addTool] });
    const result = await registry.invoke({
      name: "add",
      input: { description: "invalid number", left: Number.NaN, right: 3 },
    });

    expect(result).toMatchObject({ ok: false, code: "INVALID_TOOL_INPUT" });
  });

  test("returns TOOL_NOT_FOUND for an unknown tool", async () => {
    const registry = new ToolRegistry({ tools: [] });
    expect(await registry.invoke({ name: "missing", input: {} })).toEqual({
      ok: false,
      toolName: "missing",
      code: "TOOL_NOT_FOUND",
      error: "Unknown tool: missing",
    });
  });

  test("rejects duplicate tool names", () => {
    expect(() => new ToolRegistry({ tools: [addTool, addTool] })).toThrow(
      "Duplicate tool name: add",
    );
  });

  test("normalizes an unexpected tool exception", async () => {
    const brokenTool = defineTool({
      name: "broken",
      description: "Always fails",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        throw new Error("boom");
      },
    });
    const registry = new ToolRegistry({ tools: [brokenTool] });

    expect(
      await registry.invoke({ name: "broken", input: { description: "test failure" } }),
    ).toMatchObject({ ok: false, code: "TOOL_EXECUTION_FAILED", error: "boom" });
  });

  test("does not invoke a tool after abort", async () => {
    let invokeCount = 0;
    const sideEffectTool = defineTool({
      name: "side_effect",
      description: "Counts calls",
      parameters: z.object({ description: z.string() }),
      invoke: async () => {
        invokeCount += 1;
        return "done";
      },
    });
    const registry = new ToolRegistry({ tools: [sideEffectTool] });
    const controller = new AbortController();
    controller.abort();

    const result = await registry.invoke({
      name: "side_effect",
      input: { description: "must not run" },
      signal: controller.signal,
    });

    expect(result).toMatchObject({ ok: false, code: "ABORTED" });
    expect(invokeCount).toBe(0);
  });
});
```

</details>

最后执行本阶段的完整测试：

```bash
bun test src/foundation/tools/__tests__/tool-registry.test.ts
```

### 阶段后对照

- `src/foundation/tools/function-tool.ts`
- `src/foundation/tools/structured-tool-result.ts`
- `src/coding/tools/tool-result.ts`
- `src/coding/tools/__tests__/tool-result.test.ts`

### 验收

- [ ] schema 同时可用于 provider tool definition 和本地 validation；
- [ ] 所有预期错误都有稳定 code；
- [ ] Tool result 可以安全 `JSON.stringify`；
- [ ] 单个 Tool 失败不会让 playground 进程崩溃；
- [ ] `ADR-004` 解释为什么 Tool 是副作用边界。

## 第一部分综合练习

这个练习不调用真实 LLM，而是把前三个阶段的组件串成一条完整数据流。先创建文件：

```bash
touch examples/foundation-demo.ts
```

执行后新增结构如下：

```text
examples/
└── foundation-demo.ts         # 串联前三阶段能力的离线综合示例
```

目标文件：`examples/foundation-demo.ts`

<details>
<summary>展开完整代码：<code>foundation-demo.ts</code></summary>

```ts
import type {
  AssistantMessage,
  Message,
  NonSystemMessage,
  ToolResultContent,
  ToolUseContent,
} from "@/foundation/messages";
import { formatTranscript } from "@/foundation/messages";
import { Model } from "@/foundation/models/model";
import type {
  ModelProvider,
  ModelProviderInvokeParams,
} from "@/foundation/models/model-provider";
import { ScriptedModelProvider } from "@/foundation/models/scripted-model-provider";
import { addTool, ToolRegistry } from "@/foundation/tools";

function textOf(message: AssistantMessage): string {
  let text = "";
  for (const content of message.content) {
    if (content.type === "text") text += content.text;
  }
  return text;
}

function findToolUse(message: AssistantMessage): ToolUseContent {
  for (const content of message.content) {
    if (content.type === "tool_use") return content;
  }
  throw new Error("Model response did not contain a tool_use");
}

function findLatestToolResult(messages: Message[]): ToolResultContent | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "tool") continue;

    for (const content of message.content) {
      if (content.type === "tool_result") return content;
    }
  }
  return undefined;
}

function readSum(value: unknown): number {
  if (typeof value !== "object" || value === null || !("ok" in value) || value.ok !== true) {
    throw new Error("add Tool did not return a successful StructuredToolResult");
  }
  if (!("data" in value) || typeof value.data !== "object" || value.data === null) {
    throw new Error("add Tool result did not contain data");
  }
  if (!("sum" in value.data) || typeof value.data.sum !== "number") {
    throw new Error("add Tool result did not contain a numeric sum");
  }
  return value.data.sum;
}

class DemoAddModelProvider implements ModelProvider {
  private readonly _left: number;
  private readonly _right: number;

  constructor({ left, right }: { left: number; right: number }) {
    this._left = left;
    this._right = right;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    params.signal?.throwIfAborted();

    const toolResult = findLatestToolResult(params.messages);
    if (!toolResult) {
      return {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "add-1",
            name: "add",
            input: {
              description: "计算两个数字的和",
              left: this._left,
              right: this._right,
            },
          },
        ],
      };
    }

    const observation: unknown = JSON.parse(toolResult.content);
    const sum = readSum(observation);
    return {
      role: "assistant",
      content: [{ type: "text", text: `计算结果是 ${sum}。` }],
    };
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    const response = await this.invoke(params);
    const scripted = new ScriptedModelProvider({ responses: [response] });
    yield* scripted.stream(params);
  }
}

const [leftText = "2", rightText = "3"] = Bun.argv.slice(2);
const left = Number(leftText);
const right = Number(rightText);
if (!Number.isFinite(left) || !Number.isFinite(right)) {
  throw new Error("Usage: bun run examples/foundation-demo.ts <left> <right>");
}

const registry = new ToolRegistry({ tools: [addTool] });
const provider = new DemoAddModelProvider({ left, right });
const model = new Model({ name: "demo-add", provider });
const transcript: NonSystemMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: `请计算 ${left} + ${right}。` }],
  },
];

// 第一次模型调用根据用户消息产生 Tool call。
const toolRequest = await model.invoke({
  prompt: "需要计算时调用 add Tool。",
  messages: transcript,
  tools: registry.list(),
});
transcript.push(toolRequest);

const toolUse = findToolUse(toolRequest);
const execution = await registry.invoke({
  name: toolUse.name,
  input: toolUse.input,
});

// Registry 失败时记录执行错误；成功时把 Tool 自身的 structured result 作为 observation。
const observation = execution.ok ? execution.value : execution;
const observationText = JSON.stringify(observation);
if (observationText === undefined) {
  throw new Error("Tool observation could not be serialized");
}
transcript.push({
  role: "tool",
  content: [
    {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: observationText,
    },
  ],
});

// 第二次模型调用读取刚刚追加的真实 Tool result，再产生最终回答。
let finalMessage: AssistantMessage | undefined;
console.log("Cumulative snapshots:");
for await (const snapshot of model.stream({
  prompt: "根据 Tool observation 回答用户。",
  messages: transcript,
  tools: registry.list(),
})) {
  console.log(textOf(snapshot));
  finalMessage = snapshot;
}

if (!finalMessage) {
  throw new Error("Model stream did not yield a response");
}

transcript.push(finalMessage);

console.log("\nCanonical transcript:");
console.log(formatTranscript(transcript));
```

</details>

数据流中有两个容易混淆的关联点：

1. 第一次 `model.invoke()` 只在 transcript 尚无 Tool result 时产生 `tool_use`，这个消息
   随后才被追加到 transcript，并不是预先写入 transcript；
2. `toolUse.id` 与随后 `tool_result.tool_use_id` 都是 `"add-1"`，因此第二次模型调用能找到
   属于这次调用的 observation；
3. `execution.ok` 描述 Registry 是否成功完成查找、校验和调用，`execution.value` 才是
   `addTool` 返回的 `StructuredToolResult`；
4. `DemoAddModelProvider` 从实际 Tool result 中读取 `data.sum` 后构造最终文本，并只把
   累计快照的生成委托给 `ScriptedModelProvider`。因此最终数字不再是预设常量。

### 运行与观察

```bash
bun run examples/foundation-demo.ts
bun run examples/foundation-demo.ts 7 8
```

第一条命令的累计快照最终是“计算结果是 5。”，第二条则会根据真实 Tool 输出得到
“计算结果是 15。”。随后打印的 canonical transcript 依次包含 user message、模型生成的
`tool_use`、关联的 `tool_result` 和基于该 result 生成的最终 assistant message。

这里仍然是一个确定性 fake provider：它只模拟“第一次请求 Tool、第二次读取 observation”
这两个决策。阶段 4 会把当前显式编排的两轮调用提取为可复用的 Agent loop。

如果你能解释每个对象属于 foundation 的原因，就可以进入 Agent loop。
