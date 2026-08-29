# 第零部分：TypeScript 必备基础

这一部分面向没有 TypeScript 基础的读者，只介绍后续 Coding Agent Harness 教程会实际用到的语言特性。完成后，你应当能够读懂类型定义、实现普通函数和类，并理解异步模型调用与流式输出。

Part 0 是可选先修，不属于项目阶段 0～15，也不要求提交 Git checkpoint。已经熟悉 TypeScript strict、union、generic 和 async/await 的读者可以直接进入第一部分。

## 1. 开始之前

### 1.1 建立独立练习环境

不要在 `harness-lab` 中练习本章代码。先创建一个可以随时删除的独立目录：

```bash
mkdir -p ts-basics-lab
cd ts-basics-lab
bun init -y
bun add -d typescript @types/bun
```

`bun init -y` 会创建 `index.ts`。本章的代码片段都可以放入这个文件，再使用以下命令观察结果：

```bash
# 执行 TypeScript，观察运行结果
bun run index.ts

# 只检查类型，不生成 JavaScript
bunx tsc --noEmit --strict
```

这两条命令解决不同问题：

- Bun 负责执行代码，但不会替你完成完整的 TypeScript 类型检查；
- `tsc --noEmit` 负责发现类型错误，但不会执行代码。

因此，程序“能运行”不代表“类型检查通过”。后续项目会把两项检查都放入 `bun run check`。

### 1.2 一个基本的 `.ts` 文件如何构成

一个 `.ts` 文件通常从依赖声明开始，接着定义类型和可复用逻辑，最后按需提供程序入口。下面的顺序是便于阅读的常用组织方式，不是 TypeScript 强制规定的语法顺序。

目标文件：`index.ts`（由前面的 `bun init -y` 创建）

```ts
// 1. import：引入其他 module 在运行时提供的值。
import { basename } from "node:path";

// 2. type/interface：描述数据形状，只参与类型检查。
interface ProgramOptions {
  inputPath: string;
  uppercase?: boolean;
}

// 3. module 常量：保存本文件共用且不会重新赋值的配置。
const DEFAULT_INPUT_PATH = "README.md";

// 4. 普通函数：实现一项可以独立测试的同步逻辑。
function formatFileName(path: string, uppercase = false): string {
  const name = basename(path);
  return uppercase ? name.toUpperCase() : name;
}

// 5. class：在需要同时管理状态和行为时使用。
class Reporter {
  private readonly prefix: string;

  constructor(options: { prefix: string }) {
    this.prefix = options.prefix;
  }

  print(message: string): void {
    console.log(`${this.prefix}: ${message}`);
  }
}

// 6. export：让测试或其他 module 可以复用这个函数。
export async function main(options: ProgramOptions = {
  inputPath: DEFAULT_INPUT_PATH,
}): Promise<void> {
  // await 表示这里会等待一个异步操作完成。
  await Bun.sleep(10);

  const reporter = new Reporter({ prefix: "file" });
  reporter.print(formatFileName(options.inputPath, options.uppercase));
}

// 7. 程序入口：直接运行本文件时调用 main，被 import 时不自动执行。
if (import.meta.main) {
  await main();
}
```

运行并检查：

```bash
# 执行 main()，观察程序输出
bun run index.ts

# 检查参数、返回值和 class 字段等类型关系
bunx tsc --noEmit --strict
```

示例输出：

```text
file: README.md
```

这份文件可以分成两类内容：

- `interface ProgramOptions` 等类型声明帮助编译器检查代码，运行时会被移除；
- import、常量初始化、函数调用和 `console.log()` 等 JavaScript 逻辑会在运行时执行。

并非每个 `.ts` 文件都需要包含以上全部部分。例如纯类型文件可以只有 `interface` 和
`type`，工具文件可以只导出函数，程序入口才需要 `main()` 与 `import.meta.main`。

## 2. 变量、类型与类型推断

JavaScript 决定代码如何运行，TypeScript 在它之上增加静态类型检查。类型只在开发和检查阶段存在，运行时不会保留 `string`、`interface` 或 generic 等声明。

### 2.1 基础类型

```ts
const modelName: string = "fake-model";
const maxSteps: number = 10;
const streaming: boolean = true;
const tags: string[] = ["agent", "tutorial"];
const position: [number, number] = [3, 7];

let latestText: string | undefined;
latestText = "hello";
latestText = undefined;
```

这里用到了：

- `string`、`number`、`boolean`：基础值类型；
- `string[]`：元素都是字符串的数组；
- `[number, number]`：长度和每个位置类型都固定的 tuple；
- `string | undefined`：值可以是字符串，也可以不存在。

TypeScript 通常可以根据初始值推断类型，因此下面的显式标注可以省略：

```ts
const provider = "openai"; // 推断为 literal type "openai"
let retries = 3; // 推断为 number
```

函数参数、返回值和公共数据结构仍建议明确标注，因为它们构成模块之间的契约。

### 2.2 `const` 与 `let`

```ts
const role = "assistant";
let accumulatedText = "";

accumulatedText += "Hello";
```

- `const` 禁止变量重新指向另一个值；
- `let` 允许重新赋值；
- `const` 对象内部的字段仍可能被修改，除非字段声明为 `readonly`。

优先使用 `const`，只有确实需要重新赋值时才使用 `let`。

### 2.3 Literal type

字符串 literal type 表示“只能是这个字符串”，而不是任意字符串：

```ts
let role: "assistant" = "assistant";

// 类型错误："user" 不是 "assistant"
// role = "user";
```

后续 Message 协议中的 `role: "user"` 和 Content 协议中的 `type: "text"` 都使用 literal type，TypeScript 可以据此判断当前处理的是哪一种消息。

### 2.4 `unknown`、`any` 与 `never`

```ts
let unchecked: any = JSON.parse("{}");
// unchecked.notExisting.deeplyNested();
// 编译器不会阻止上一行，但实际执行会发生运行时错误。

let externalValue: unknown = JSON.parse("{}");

if (typeof externalValue === "string") {
  console.log(externalValue.toUpperCase());
}
```

- `any` 关闭类型检查，应尽量避免；
- `unknown` 表示类型未知，使用前必须检查或校验；
- `never` 表示不可能存在的值，常用于检查 union 是否已处理完整。

模型响应、配置文件和 Tool 参数都来自程序边界，应先视为 `unknown`，再通过条件判断或 Zod 转为可信类型。

## 3. 对象、数组与集合

### 3.1 Object type、`interface` 与 `type`

可以直接描述一个对象：

```ts
const usage: {
  promptTokens: number;
  completionTokens: number;
} = {
  promptTokens: 12,
  completionTokens: 8,
};
```

重复使用的对象结构通常定义为 `interface`：

```ts
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

const usage: TokenUsage = {
  promptTokens: 12,
  completionTokens: 8,
  totalTokens: 20,
};
```

`type` 既能描述对象，也能为 union、tuple 等任意类型起别名：

```ts
type ModelProviderName = "openai" | "anthropic";
type Coordinate = [number, number];
type ProviderOptions = Record<string, unknown>;
```

本教程通常使用 `interface` 描述对象形状，使用 `type` 定义 union 或组合类型。

### 3.2 可选字段与只读字段

```ts
interface AssistantMessage {
  readonly role: "assistant";
  content: string;
  usage?: TokenUsage;
}
```

- `readonly role`：对象创建后不能给 `role` 重新赋值；
- `usage?`：字段可以存在，也可以是 `undefined`。

读取可选字段前需要处理缺失情况：

```ts
function totalTokens(message: AssistantMessage): number {
  return message.usage?.totalTokens ?? 0;
}
```

- `?.`：左侧不存在时返回 `undefined`；
- `??`：左侧为 `null` 或 `undefined` 时使用默认值。

### 3.3 `Record`

`Record<K, V>` 表示 key 类型为 `K`、value 类型为 `V` 的对象：

```ts
const headers: Record<string, string> = {
  "content-type": "application/json",
};

const options: Record<string, unknown> = {
  temperature: 0,
  reasoningEffort: "high",
};
```

当字段名称无法提前列举，但 value 类型有统一规则时，可以使用 `Record`。

### 3.4 `Partial`

`Partial<T>` 会把 `T` 的所有字段变成可选字段：

```ts
interface AgentContext {
  step: number;
  messages: string[];
  aborted: boolean;
}

const contextPatch: Partial<AgentContext> = {
  aborted: true,
};
```

Middleware 不需要返回完整的 `AgentContext`，只返回要更新的字段即可。调用方再把 patch 合并到原 context。

### 3.5 数组操作

```ts
const tools = ["read_file", "write_file", "bash"];

const readOnlyTools = tools.filter((name) => name === "read_file");
const labels = tools.map((name) => `tool:${name}`);
const hasBash = tools.some((name) => name === "bash");
```

这些方法都返回新值，不会修改原数组。需要追加元素但保留原数组时，可以使用 spread：

```ts
const messages = ["user: hello"];
const nextMessages = [...messages, "assistant: hi"];
```

在启用 `noUncheckedIndexedAccess` 后，数组索引结果可能是 `undefined`：

```ts
const first = messages[0]; // string | undefined

if (first !== undefined) {
  console.log(first.toUpperCase());
}
```

### 3.6 `Map` 与 `Set`

```ts
const toolsByName = new Map<string, { description: string }>();
toolsByName.set("read_file", { description: "Read a file" });

const allowedTools = new Set<string>();
allowedTools.add("read_file");

console.log(toolsByName.get("read_file")); // object | undefined
console.log(allowedTools.has("bash")); // false
```

- `Map` 适合按 id 或名称查找对象；
- `Set` 适合去重以及判断某个值是否存在。

ToolRegistry、运行中 Tool call 的状态和权限列表都会使用类似结构。

## 4. Union 与类型收窄

Union 表示一个值可能属于多个类型。Coding Agent 的 Message、Content、事件和结果协议都大量使用 discriminated union。

### 4.1 定义 discriminated union

```ts
interface TextContent {
  type: "text";
  text: string;
}

interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type MessageContent = TextContent | ToolUseContent;
```

两个成员都包含 `type`，但 literal value 不同，因此 `type` 是 discriminator。

### 4.2 使用 `switch` 收窄类型

```ts
function formatContent(content: MessageContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "tool_use":
      return `${content.name} ${JSON.stringify(content.input)}`;
  }
}
```

进入 `case "text"` 后，TypeScript 知道 `content` 是 `TextContent`，因此允许访问 `text`。

### 4.3 使用 `never` 做穷尽检查

```ts
function assertNever(value: never): never {
  throw new Error(`Unexpected variant: ${JSON.stringify(value)}`);
}

function formatContent(content: MessageContent): string {
  switch (content.type) {
    case "text":
      return content.text;
    case "tool_use":
      return `${content.name} ${JSON.stringify(content.input)}`;
    default:
      return assertNever(content);
  }
}
```

以后为 `MessageContent` 新增成员但忘记更新 `switch` 时，`content` 不再能收窄成 `never`，类型检查会指出遗漏。

### 4.4 根据 boolean discriminator 收窄

```ts
type ToolResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string };

function printResult(result: ToolResult<number>): void {
  if (result.ok) {
    console.log(result.data);
  } else {
    console.error(result.code, result.error);
  }
}
```

`ok` 同样是 discriminator。成功分支一定存在 `data`，失败分支一定存在 `error`。

## 5. 函数

### 5.1 参数与返回类型

```ts
function formatLine(role: string, text: string): string {
  return `${role}: ${text}`;
}

const output = formatLine("user", "hello");
```

冒号后面是类型：

- `role: string` 和 `text: string` 是参数类型；
- 括号后的 `: string` 是返回类型。

没有返回值的函数使用 `void`：

```ts
function logMessage(message: string): void {
  console.log(message);
}
```

### 5.2 可选参数与默认参数

```ts
function formatError(message: string, code?: string): string {
  return code === undefined ? message : `[${code}] ${message}`;
}

function retryDelay(attempt: number, baseMs = 100): number {
  return attempt * baseMs;
}
```

- `code?: string`：调用时可以省略；
- `baseMs = 100`：省略时自动使用默认值。

### 5.3 Arrow function 与 callback

```ts
const uppercase = (value: string): string => value.toUpperCase();

type WarningHandler = (message: string) => void;

function reportWarning(message: string, handler: WarningHandler): void {
  handler(message);
}

reportWarning("retrying", (message) => console.warn(message));
```

函数也可以作为值传递。Middleware hook、事件订阅和依赖注入都会把 callback 作为参数。

### 5.4 参数对象与解构

参数较多时，本教程通常传入一个 options object：

```ts
interface InvokeOptions {
  model: string;
  prompt: string;
  temperature?: number;
}

function invoke({ model, prompt, temperature = 0 }: InvokeOptions): string {
  return `${model}:${temperature}:${prompt}`;
}
```

这样调用时每个值的含义更清楚：

```ts
invoke({ model: "fake-model", prompt: "hello", temperature: 0 });
```

## 6. Generic

Generic 让一段实现保留调用方传入的具体类型，而不是把所有值都退化为 `unknown`。

### 6.1 Generic function

```ts
function first<T>(items: T[]): T | undefined {
  return items[0];
}

const firstName = first(["openai", "anthropic"]); // string | undefined
const firstStep = first([1, 2, 3]); // number | undefined
```

`T` 是类型参数。传入字符串数组时 `T` 是 `string`，传入数字数组时 `T` 是 `number`。

### 6.2 Generic interface 与默认类型

```ts
interface StructuredResult<T = unknown> {
  summary: string;
  data?: T;
}

const result: StructuredResult<{ path: string }> = {
  summary: "file created",
  data: { path: "/tmp/demo.txt" },
};
```

没有指定 `T` 时使用默认值 `unknown`。

### 6.3 Generic constraint

```ts
function withId<T extends Record<string, unknown>>(value: T, id: string): T & { id: string } {
  return { ...value, id };
}

const toolCall = withId({ name: "read_file", input: { path: "README.md" } }, "call-1");
```

`extends Record<string, unknown>` 限制 `T` 必须是对象。后续 `ToolUseContent<T>` 和 `FunctionTool<P, R>` 会用 generic 保留 Tool 参数与返回值的具体类型。

## 7. 类与对象实例

类把状态和操作状态的方法组合在一起。

### 7.1 字段、构造函数与方法

```ts
class Transcript {
  private readonly messages: string[] = [];

  append(message: string): void {
    this.messages.push(message);
  }

  snapshot(): string[] {
    return [...this.messages];
  }
}

const transcript = new Transcript();
transcript.append("user: hello");
console.log(transcript.snapshot());
```

- `private`：只能在类内部访问；
- `readonly`：字段引用不能被重新赋值；
- `this`：当前对象实例；
- `new Transcript()`：调用构造过程并创建实例。

`snapshot()` 返回数组副本，调用方修改返回值时不会破坏类的内部状态。

### 7.2 Constructor dependency injection

```ts
interface Clock {
  now(): number;
}

class RunTimer {
  private readonly clock: Clock;

  constructor(options: { clock: Clock }) {
    this.clock = options.clock;
  }

  startedAt(): number {
    return this.clock.now();
  }
}
```

通过 constructor 传入依赖，可以在测试中使用 fake，而不必访问真实时间、网络或文件系统。

### 7.3 `implements`

```ts
interface ModelProvider {
  invoke(prompt: string): Promise<string>;
}

class FakeModelProvider implements ModelProvider {
  async invoke(prompt: string): Promise<string> {
    return `echo:${prompt}`;
  }
}
```

`implements ModelProvider` 要求类提供接口规定的方法，但不会自动生成实现。

### 7.4 继承内置错误

```ts
class MaximumStepsError extends Error {
  readonly maxSteps: number;

  constructor(maxSteps: number) {
    super(`Agent exceeded maximum steps: ${maxSteps}`);
    this.name = "MaximumStepsError";
    this.maxSteps = maxSteps;
  }
}
```

`extends Error` 复用标准错误行为，并增加 Agent runtime 需要的结构化字段。

## 8. 模块与 import/export

项目会把实现拆分到多个文件。每个包含顶层 `import` 或 `export` 的文件都是一个 module。

创建这一节的示例文件：

```bash
touch message.ts module-demo.ts
```

目标文件：`message.ts`

```ts
export interface Message {
  role: "user" | "assistant";
  content: string;
}

export function formatMessage(message: Message): string {
  return `${message.role}: ${message.content}`;
}
```

目标文件：`module-demo.ts`

```ts
import type { Message } from "./message";
import { formatMessage } from "./message";

const message: Message = { role: "user", content: "hello" };
console.log(formatMessage(message));
```

```bash
# 执行 module 入口，观察跨文件 import 的结果
bun run module-demo.ts
```

- `import type` 只导入类型，运行时不会产生 import；
- 普通 `import` 导入运行时会调用的值；
- 相对路径 `./message` 表示当前目录下的 module。

Barrel file 用于从一个入口重新导出多个 module：

```bash
mkdir -p messages
touch messages/content.ts messages/message.ts messages/index.ts
```

目标文件：`messages/index.ts`

```ts
export * from "./content";
export * from "./message";
```

后续 `@/foundation/messages` 中的 `@/*` 是 `tsconfig.json` 配置的 path alias，用于避免过长的相对路径。

### `import.meta.main`

```ts
export function main(): void {
  console.log("started");
}

if (import.meta.main) {
  main();
}
```

直接执行该文件时 `import.meta.main` 为 `true`；被测试或其他 module import 时为 `false`。这样同一个文件既能导出可测试函数，也能作为程序入口运行。

## 9. 错误处理与边界校验

### 9.1 `throw` 与 `try/catch/finally`

```ts
function parsePositiveInteger(value: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }

  return parsed;
}

try {
  console.log(parsePositiveInteger("invalid"));
} catch (error: unknown) {
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error("Unknown error", error);
  }
} finally {
  console.log("cleanup");
}
```

- `throw` 中断当前执行路径；
- `catch` 处理异常；
- `finally` 无论成功或失败都会执行，适合清理 timer、文件句柄或事件监听器；
- catch value 应视为 `unknown`，因为 JavaScript 允许抛出任意值。

### 9.2 异常与结构化失败

不是所有失败都应该 `throw`：

```ts
type ReadResult =
  | { ok: true; content: string }
  | { ok: false; code: "NOT_FOUND" | "OUTSIDE_WORKSPACE"; error: string };
```

本教程通常采用以下规则：

- 违反程序不变量、无法继续运行：`throw`；
- Tool 的预期业务失败：返回结构化结果；
- Agent 需要观察的 Tool 失败：转成 `tool_result` 写入 transcript。

### 9.3 JSON 与 `unknown`

```ts
const raw = '{"city":"北京"}';
const parsed: unknown = JSON.parse(raw);

if (
  typeof parsed === "object" &&
  parsed !== null &&
  "city" in parsed &&
  typeof parsed.city === "string"
) {
  console.log(parsed.city);
}
```

TypeScript 类型不会在运行时自动验证 JSON。后续 Tool 参数和配置会使用 Zod 完成同类校验，并生成更清楚的错误信息。

## 10. Promise 与 `async`/`await`

### 10.1 从同步函数到异步函数

同步函数立即返回结果：

```ts
function add(left: number, right: number): number {
  return left + right;
}
```

异步函数立即返回 `Promise`，结果会在未来完成：

```ts
async function loadModelName(): Promise<string> {
  await Bun.sleep(20);
  return "fake-model";
}

const modelName = await loadModelName();
console.log(modelName);
```

`async function` 的返回类型通常写成 `Promise<T>`。`await` 会等待 Promise 完成，并取得其中的 `T`。

### 10.2 顺序执行

```ts
const first = await loadModelName();
const second = await loadModelName();
```

第二次调用会等第一次完成后才开始。存在先后依赖时应当使用顺序执行。

### 10.3 并发执行

```ts
const [first, second] = await Promise.all([
  loadModelName(),
  loadModelName(),
]);
```

两个操作先同时启动，再等待全部完成。多个彼此独立的 Tool call 会使用这种方式并发执行。

`Promise.all` 不是创建 CPU thread；它只是让多个异步操作的等待时间重叠。其中任意 Promise reject 时，`Promise.all` 也会 reject。

### 10.4 `AbortSignal`

```ts
async function invokeModel(prompt: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  await Bun.sleep(20);
  signal?.throwIfAborted();
  return `answer:${prompt}`;
}

const controller = new AbortController();
const promise = invokeModel("hello", controller.signal);

// controller.abort();
console.log(await promise);
```

`AbortController` 发出取消信号，`AbortSignal` 由被调用函数读取。阶段 5 会把同一个 signal 传递给 Model 和 Tool，使 Ctrl+C 能中止整个 Agent run。

## 11. AsyncGenerator 与流式输出

普通 `Promise<T>` 最终只产生一个值。模型流式响应会连续产生多个 snapshot，因此使用 `AsyncGenerator<T>`。

### 11.1 定义异步生成器

```ts
async function* streamText(): AsyncGenerator<string> {
  let text = "";

  for (const delta of ["Hel", "lo", "!"]) {
    await Bun.sleep(20);
    text += delta;
    yield text;
  }
}
```

- `async function*`：定义异步生成器；
- `yield`：产生一个值，但不结束函数；
- 下一次迭代会从上次 `yield` 后继续。

### 11.2 消费异步生成器

```ts
for await (const snapshot of streamText()) {
  console.log(snapshot);
}
```

示例输出：

```text
Hel
Hello
Hello!
```

本教程的 `ModelProvider.stream()` 会产生累计的 `AssistantMessage` snapshot，而不是只产生原始字符串 delta。这样 TUI 随时都能渲染一条完整消息。

## 12. 引用、复制与不可变更新

Object 和 array 是引用类型：

```ts
const original = { status: "pending" };
const alias = original;

alias.status = "completed";
console.log(original.status); // completed
```

`alias` 和 `original` 指向同一个对象。只复制一层可以使用 spread：

```ts
const next = { ...original, status: "completed" };
```

复制嵌套数据可以使用 `structuredClone`：

```ts
const messages = [
  { role: "user", content: [{ type: "text", text: "hello" }] },
];

const snapshot = structuredClone(messages);
```

Agent getter、Middleware context、checkpoint 和 TUI reducer 需要明确哪些对象允许修改。没有明确 mutation boundary 时，一个组件可能意外改变另一个组件正在使用的 transcript。

`as const` 可以把 literal 和数组收窄为只读形式：

```ts
const roles = ["user", "assistant", "tool"] as const;
type Role = (typeof roles)[number];
```

此时 `Role` 等价于 `"user" | "assistant" | "tool"`。

## 13. 综合示例：消息格式化与流式响应

将 `index.ts` 替换为以下完整内容：

```ts
interface TextContent {
  type: "text";
  text: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

type MessageContent = TextContent | ThinkingContent;

interface UserMessage {
  role: "user";
  content: TextContent[];
}

interface AssistantMessage {
  role: "assistant";
  content: MessageContent[];
}

type Message = UserMessage | AssistantMessage;

function assertNever(value: never): never {
  throw new Error(`Unexpected content: ${JSON.stringify(value)}`);
}

function formatContent(role: Message["role"], content: MessageContent): string {
  switch (content.type) {
    case "text":
      return `${role}: ${content.text}`;
    case "thinking":
      return `${role}.thinking: ${content.thinking}`;
    default:
      return assertNever(content);
  }
}

function formatMessage(message: Message): string {
  return message.content
    .map((content) => formatContent(message.role, content))
    .join("\n");
}

async function* streamReply(): AsyncGenerator<AssistantMessage> {
  let text = "";

  for (const delta of ["Hel", "lo", "!"]) {
    await Bun.sleep(20);
    text += delta;
    yield {
      role: "assistant",
      content: [{ type: "text", text }],
    };
  }
}

async function main(): Promise<void> {
  const userMessage: UserMessage = {
    role: "user",
    content: [{ type: "text", text: "Say hello" }],
  };

  console.log(formatMessage(userMessage));

  for await (const assistantSnapshot of streamReply()) {
    console.log(formatMessage(assistantSnapshot));
  }
}

if (import.meta.main) {
  await main();
}
```

运行并检查：

```bash
# 观察普通消息和累计流式消息
bun run index.ts

# 验证所有类型关系
bunx tsc --noEmit --strict
```

示例输出：

```text
user: Say hello
assistant: Hel
assistant: Hello
assistant: Hello!
```

这个示例包含后续教程最常见的一条路径：

```text
typed Message
  → discriminated union
  → formatter function
  → async generator
  → for await 消费 snapshot
```

## 14. 与后续章节的对应关系

| TypeScript 特性 | 教程中的用途 |
|---|---|
| `interface`、object type | Message、Model、Tool 和配置契约 |
| literal type、union | role、content、event 和结果分类 |
| `switch`、`never` | 穷尽处理所有消息或事件类型 |
| `unknown`、类型收窄 | 外部 JSON、模型响应和 Tool 参数 |
| `Partial<T>` | Middleware 返回局部 context 更新 |
| generic | Tool schema、Tool result 和 provider 类型复用 |
| class、`private`、`readonly` | Agent、Registry、Store 和运行状态 |
| constructor dependency injection | 注入 fake、时钟、存储和 Policy |
| `Promise`、`async`/`await` | 模型请求、Tool 调用和文件操作 |
| `Promise.all` | 并发执行彼此独立的 Tool call |
| `AbortSignal` | Ctrl+C、timeout 和跨层中止 |
| `AsyncGenerator`、`for await` | 模型流式响应和累计 snapshot |
| `Map`、`Set` | id 索引、去重和权限集合 |
| spread、`structuredClone` | transcript snapshot 和不可变状态更新 |
| ESM import/export | 分层 module、barrel export 和 type-only import |

## 15. 自检

进入第一部分前，确认你能回答：

1. `unknown` 与 `any` 的区别是什么？
2. `role: "assistant"` 为什么比 `role: string` 更精确？
3. `interface` 与 union type 分别适合描述什么？
4. `switch` 的 `default` 为什么可以交给 `assertNever()`？
5. `Promise<T>` 与 `AsyncGenerator<T>` 分别产生多少个值？
6. `await` 顺序调用与 `Promise.all` 并发调用有什么区别？
7. 为什么 getter 或 snapshot 经常返回数组副本？
8. `bun run index.ts` 与 `tsc --noEmit` 分别检查什么？

不需要背诵所有语法。能够读懂综合示例，并知道遇到这些类型时回到哪一节查阅，就可以继续学习[第一部分：工程基础与 Foundation](./part-1-foundation.md)。
