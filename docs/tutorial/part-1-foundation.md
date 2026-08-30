# 第一部分：工程基础与 Foundation

这一部分完成阶段 0～3。结束时你还没有真正的 Agent，但已经拥有 Agent runtime 最重要的三组稳定契约：Message、Model 和 Tool。

如果你还不熟悉 TypeScript 的类型、union、generic、class 或 async/await，请先阅读[第零部分：TypeScript 必备基础](./part-0-typescript-basics.md)。

不要急着调用真实模型。先使用 deterministic fake 建立可重复测试，后面出现错误时才能判断问题来自 harness 还是 provider。

## 阶段 0：建立可运行工程

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
src/foundation/messages/
├── types/
│   ├── content.ts
│   ├── message.ts
│   └── index.ts
├── __tests__/
│   └── transcript.test.ts
├── transcript.ts
└── index.ts
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

目标文件：`src/foundation/messages/types/message.ts`

`UserMessage` 是本文件的标准实现示例。注意 `role` 必须是 string literal，不能放宽为
`string`。请根据注释填写 `AssistantMessage` 和 `ToolMessage` 的字段，并替换两个顶层
union 中的 `never` 占位。

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

### 1.4 完整测试

测试文件由教程完整提供，读者不需要补测试 TODO。

目标文件：`src/foundation/messages/__tests__/transcript.test.ts`

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

### 运行与观察

```bash
# 执行示例程序，在终端观察格式化后的 transcript
bun run examples/stage-01-transcript.ts

# 运行自动化测试，验证 formatter 的输出
bun test src/foundation/messages
```

把 formatter 输出保留下来。阶段 11 的 trace viewer 会复用同一套 canonical type，而不是重新解析 provider response。

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

这里使用单一 options object 构造函数。即使参考版本存在 positional constructor，也不要为逐字一致牺牲可扩展性。

### 2.2 离线 ScriptedModelProvider

目标文件：`src/foundation/models/scripted-model-provider.ts`

`invoke()` 给出标准实现示例。它规定了 abort、响应耗尽和 cursor 推进的语义；
`stream()` 由读者根据分项提示实现。

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
    // TODO 2：本阶段 fixture 只含一个 text block；按 Unicode code point 逐步累积文本。
    // TODO 3：每次 yield 都返回完整 AssistantMessage，例如 h、he、hel。
    // TODO 4：最后一次 yield 必须与完整 response 深度相等。
    // 提示：使用 Array.from(text) 避免把 emoji 的 surrogate pair 拆开。
  }
}
```

例如完整文本为 `hello`，累计快照应类似：

```text
h
he
hel
hell
hello
```

不要产生 `h`、`e`、`l`、`l`、`o` 这种 delta。累计快照让上层 UI 可以无状态替换当前内容，也让不同 provider 的 streaming 行为统一。

### 2.3 完整测试

目标文件：`src/foundation/models/__tests__/model.test.ts`

下面是完整测试文件。它使用两个独立 scripted provider 比较 `invoke` 与 `stream`，
避免 cursor 状态互相影响。

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

### 2.4 离线流式示例

目标文件：`examples/stage-02-model-stream.ts`

下面的示例通过 `Model.stream()` 消费累计快照。循环只读取 canonical
`AssistantMessage`，不接触 `ScriptedModelProvider` 的内部状态。

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

### 运行测试与观察

```bash
# 先验证 Model 与 ScriptedModelProvider 的行为
bun test src/foundation/models/__tests__/model.test.ts

# 再观察累计流式快照
bun run examples/stage-02-model-stream.ts
```

示例每 50ms 覆盖打印当前累计文本，并在结束时打印 canonical `AssistantMessage` JSON。观察 UI 只依赖 canonical snapshot，不依赖 fake provider 的内部表示。

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

完成 Tool 类型后，回到以下两个文件加入 `tools?: Tool[]`：

- `src/foundation/models/model-context.ts`
- `src/foundation/models/model-provider.ts`

只使用 `import type { Tool } from "@/foundation/tools"`，避免 runtime 循环依赖。

### 3.2 ToolRegistry 骨架

目标文件：`src/foundation/tools/tool-registry.ts`

```ts
export type ToolExecutionResult =
  | { ok: true; toolName: string; value: unknown }
  | { ok: false; toolName: string; code: string; error: string };

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
    // TODO 1：返回新的数组，避免调用方修改内部 Map；保持注册顺序。
  }

  async invoke(options: {
    name: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult> {
    // TODO 2：查找 Tool；未知时返回 TOOL_NOT_FOUND，toolName 使用请求中的 name。
    // TODO 3：parameters.safeParse(input)；失败返回 INVALID_TOOL_INPUT。
    // TODO 4：signal 已中止时返回 ABORTED，且不得调用真实 Tool。
    // TODO 5：调用 tool.invoke(parsed.data, signal)，成功时返回 value。
    // TODO 6：最后防线捕获异常；AbortError 映射 ABORTED，其他异常映射
    // TOOL_EXECUTION_FAILED。单个 Tool 的异常不能逃出 registry。
  }
}
```

本课程在 runtime 增加本地 Zod validation。这比完全信任模型生成的 input 更安全，也是你与参考实现可以明确说明的一项有意差异。

### 3.3 第一个 Tool

目标文件：`src/foundation/tools/add-tool.ts`

示例输入规则：`description`、`left`、`right` 都是必填字段，两个数字必须是 finite；
额外字段是否允许由你选择的 Zod object policy 决定，但需要通过测试固定。

```ts
import { z } from "zod";

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

### 3.4 完整测试

目标文件：`src/foundation/tools/__tests__/tool-registry.test.ts`

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

### 运行与观察

```bash
bun run examples/stage-03-tool-playground.ts add '{"description":"demo","left":2,"right":3}'
bun run examples/stage-03-tool-playground.ts add '{"left":2,"right":3}'
```

预期分别看到 success JSON 和带稳定 error code 的 error JSON。不要只输出 stack trace。

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

不要调用 LLM，完成一个命令：

```bash
bun run examples/foundation-demo.ts
```

它应当：

1. 构造一段含 `tool_use` 的 canonical transcript；
2. 使用 `ScriptedModelProvider` 产生累计快照；
3. 使用 `ToolRegistry` 执行 `add`；
4. 把 structured result 追加为 `tool_result`；
5. 使用 `formatTranscript` 输出全过程。

如果你能解释每个对象属于 foundation 的原因，就可以进入 Agent loop。
