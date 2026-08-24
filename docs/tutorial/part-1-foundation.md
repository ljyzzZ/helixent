# 第一部分：工程基础与 Foundation

这一部分完成阶段 0～3。结束时你还没有真正的 Agent，但已经拥有 Agent runtime 最重要的三组稳定契约：Message、Model 和 Tool。

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
mkdir -p src/foundation src/agent src/coding src/community src/cli
mkdir -p examples docs/decisions
```

将 `tsconfig.json` 调整为：

```json
{
  "compilerOptions": {
    "lib": ["ESNext"],
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
  }
}
```

在 `package.json` 中建立脚本：

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

### 0.2 第一个程序

新建 `src/cli/index.ts`：

```ts
export function main() {
  console.log("harness-lab ready");
}

if (import.meta.main) {
  main();
}
```

新建 `src/cli/__tests__/index.test.ts`：

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

```text
src/foundation/messages/
├── types/
│   ├── content.ts
│   ├── message.ts
│   └── index.ts
├── transcript.ts
└── index.ts
```

### 1.2 类型骨架

在 `content.ts` 中完成所有 `TODO`：

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

export type SystemMessageContent = TODO;
export type UserMessageContent = TODO;
export type AssistantMessageContent = TODO;
export type ToolMessageContent = TODO;
```

在 `message.ts` 中定义：

```ts
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface SystemMessage {
  role: "system";
  content: SystemMessageContent;
}

// TODO: UserMessage、AssistantMessage、ToolMessage

export type NonSystemMessage = TODO;
export type Message = TODO;
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

实现：

```ts
export function formatTranscript(messages: Message[]): string {
  // TODO: 每条消息一行；tool_use 和 tool_result 显示关联 id
}
```

输入：

```ts
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
```

输出至少包含：

```text
user: 北京天气如何？
assistant.tool_use[call-1]: weather {"city":"北京"}
tool.tool_result[call-1]: 晴，26°C
assistant: 北京今天晴，26°C。
```

### 1.4 测试骨架

测试下面三个行为：

```ts
test("formats text messages", () => {
  // TODO
});

test("keeps tool call correlation ids visible", () => {
  // TODO
});

test("exhaustively handles every content type", () => {
  // 使用 assertNever，让新增 content variant 时编译失败
});
```

实现一个穷尽检查助手：

```ts
export function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}
```

### 运行与观察

```bash
bun run examples/stage-01-transcript.ts
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

### 2.1 契约骨架

```ts
export interface ModelContext {
  prompt: string;
  messages: NonSystemMessage[];
  tools?: Tool[];
  signal?: AbortSignal;
}

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

实现 `Model`：

```ts
export class Model {
  readonly name: string;
  readonly provider: ModelProvider;
  readonly options?: Record<string, unknown>;

  constructor(options: {
    name: string;
    provider: ModelProvider;
    modelOptions?: Record<string, unknown>;
  }) {
    // TODO
  }

  invoke(context: ModelContext) {
    // TODO: 调用 _buildProviderParams
  }

  stream(context: ModelContext) {
    // TODO
  }

  private _buildProviderParams(context: ModelContext): ModelProviderInvokeParams {
    // TODO: prompt 非空时转为第一条 system message
  }
}
```

这里使用单一 options object 构造函数。即使参考版本存在 positional constructor，也不要为逐字一致牺牲可扩展性。

### 2.2 离线 ScriptedModelProvider

先实现 deterministic fake：

```ts
export class ScriptedModelProvider implements ModelProvider {
  private readonly _responses: AssistantMessage[];
  private _cursor = 0;

  constructor({ responses }: { responses: AssistantMessage[] }) {
    this._responses = responses;
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    // TODO: 检查 signal，返回当前 response，并推进 cursor
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // TODO: 把当前文本拆成多个累计快照；最后一个必须是完整 response
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

### 2.3 必写测试

```ts
test("prepends a system message without storing it in transcript", async () => {
  // 使用 RecordingProvider 捕获 params
});

test("stream yields cumulative snapshots", async () => {
  // 断言 h、he、hel...，而不是单字符 delta
});

test("the final stream snapshot equals invoke result", async () => {
  // 为两个独立 provider 实例传入同一 response 后比较
});

test("passes AbortSignal to provider", async () => {
  // TODO
});
```

### 运行与观察

```bash
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

### 3.1 Tool 类型

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
  // TODO: 保持完整泛型推断
}
```

定义结果：

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
```

再实现 `okToolResult()` 和 `errorToolResult()` factory。

### 3.2 ToolRegistry 骨架

```ts
export type ToolExecutionResult =
  | { ok: true; toolName: string; value: unknown }
  | { ok: false; toolName: string; code: string; error: string };

export class ToolRegistry {
  private readonly _tools = new Map<string, Tool>();

  constructor({ tools }: { tools: Tool[] }) {
    // TODO: 拒绝重复 name
  }

  list(): Tool[] {
    // TODO
  }

  async invoke(options: {
    name: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<ToolExecutionResult> {
    // TODO:
    // 1. 查找 Tool；未知时返回 TOOL_NOT_FOUND
    // 2. parameters.safeParse(input)
    // 3. 校验失败返回 INVALID_TOOL_INPUT
    // 4. 调用 tool.invoke(parsed.data, signal)
    // 5. 最后防线捕获异常为 TOOL_EXECUTION_FAILED
  }
}
```

本课程在 runtime 增加本地 Zod validation。这比完全信任模型生成的 input 更安全，也是你与参考实现可以明确说明的一项有意差异。

### 3.3 第一个 Tool

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

### 3.4 必写测试

- 正常输入返回 `sum`；
- 缺少 `description` 返回 `INVALID_TOOL_INPUT`；
- `left: NaN` 被 schema 拒绝；
- 未注册 Tool 返回 `TOOL_NOT_FOUND`；
- 重复 Tool name 使 registry 构造失败；
- Tool 内部 throw 被转换成 `TOOL_EXECUTION_FAILED`；
- 已中止 signal 不应继续执行副作用。

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
