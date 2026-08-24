# 第三部分：Coding Agent 与交互客户端

这一部分完成阶段 7～10。阶段 10 结束时，你会得到一个与 Helixent 核心能力功能等价的 v1：能接真实模型、读写代码、加载项目指令和 Skills、管理 Todo、流式交互，并在副作用 Tool 前请求人工审批。

真实 API 验证始终是 optional integration test。核心测试继续使用 fake provider，避免网络波动、费用和模型随机性破坏质量门。

## 阶段 7：实现 Provider Adapter

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

目录：

```text
src/community/
├── openai/
│   ├── model-provider.ts
│   ├── stream-accumulator.ts
│   ├── utils.ts
│   ├── __tests__/
│   └── index.ts
└── anthropic/
    ├── model-provider.ts
    ├── stream-accumulator.ts
    ├── utils.ts
    ├── __tests__/
    └── index.ts
```

### 7.2 先写纯转换函数

OpenAI adapter 至少拆成：

```ts
export function convertToOpenAIMessages(
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  // TODO
}

export function convertToOpenAITools(
  tools: Tool[],
): OpenAI.ChatCompletionTool[] {
  // TODO: parameters.toJSONSchema()
}

export function parseOpenAIAssistantMessage(
  message: OpenAI.ChatCompletionMessage,
  usage?: TokenUsage,
): AssistantMessage {
  // TODO
}
```

Anthropic adapter至少拆成：

```ts
export function extractSystemPrompt(messages: Message[]): string | undefined;
export function convertToAnthropicMessages(messages: Message[]): Anthropic.MessageParam[];
export function convertToAnthropicTools(tools: Tool[]): Anthropic.Tool[];
export function parseAnthropicAssistantMessage(message: Anthropic.Message): AssistantMessage;
```

这些函数必须是纯函数。先用固定 fixture 测完，再调用 SDK。

### 7.3 必须覆盖的协议案例

为两个 adapter 分别测试：

- user text；
- system prompt；
- assistant text；
- assistant 同时包含 text 和 `tool_use`；
- 多个 Tool calls；
- `tool_result` 与 call id 关联；
- provider 缺少 usage；
- 空文本；
- thinking/reasoning content；
- malformed Tool arguments。

Malformed Tool arguments 不应让 streaming accumulator 每收到一个 fragment 就崩溃。在 JSON 尚未完整时，可以保留 partial object 或空 object；最终 chunk 仍无法解析时，返回可诊断错误。

### 7.4 StreamAccumulator

定义 provider-local accumulator：

```ts
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
    // TODO: 合并 delta，不产生 canonical transcript side effect
  }

  snapshot(): AssistantMessage {
    // TODO: 每次返回完整累计快照
  }
}
```

最关键的测试是 fragmented JSON：

```text
chunk 1: {"path":"/tmp/
chunk 2: demo","line":1}
```

最终 snapshot 的 input 应为 `{ path: "/tmp/demo", line: 1 }`。同时测试两个并行 Tool call 的 fragment 不会互相串线。

### 7.5 Provider class

```ts
export class OpenAIModelProvider implements ModelProvider {
  private readonly _client: OpenAI;

  constructor({ baseURL, apiKey }: { baseURL?: string; apiKey?: string } = {}) {
    this._client = new OpenAI({ baseURL, apiKey });
  }

  async invoke(params: ModelProviderInvokeParams): Promise<AssistantMessage> {
    // TODO: convert → SDK → parse
  }

  async *stream(params: ModelProviderInvokeParams): AsyncGenerator<AssistantMessage> {
    // TODO: SDK stream → accumulator.push → snapshot
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

### 阶段后对照

- `src/community/openai/model-provider.ts`
- `src/community/openai/utils.ts`
- `src/community/openai/stream-utils.ts`
- `src/community/anthropic/model-provider.ts`
- `src/community/anthropic/utils.ts`
- `src/community/anthropic/stream-utils.ts`

### 验收

- [ ] provider SDK type 不进入 `agent`；
- [ ] converter tests 不访问网络；
- [ ] streaming 最终 snapshot 与 non-stream response 语义一致；
- [ ] fragmented Tool arguments 有测试；
- [ ] signal 传入 SDK 请求；
- [ ] `ADR-008` 解释 canonical protocol 与 vendor wire protocol 的边界。

## 阶段 8：实现 Coding Tools

### 本阶段原则

Coding Agent 的能力不来自“更长的 prompt”，而来自高质量的环境接口。Tool 应窄、可组合、有明确 error code，并回显模型下一步决策需要的信息。

按风险分两批实现：

| 批次 | Tools | 副作用 |
|---|---|---|
| A：只读 | `file_info`、`list_files`、`glob_search`、`grep_search`、`read_file` | 无 |
| B：修改 | `mkdir`、`write_file`、`str_replace`、`apply_patch`、`move_path`、`bash` | 有 |

不要一开始实现一个万能 `filesystem` Tool。窄 Tool 更容易描述、审批、测试、统计和限制权限。

### 8.1 Workspace boundary

创建 `src/coding/tools/tool-utils.ts`：

```ts
export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; code: "INVALID_PATH" | "PATH_OUTSIDE_WORKSPACE"; error: string };

export function resolveWorkspacePath(options: {
  cwd: string;
  inputPath: string;
}): PathValidationResult {
  // TODO:
  // 1. resolve 成绝对路径
  // 2. realpath 已存在的祖先，处理符号链接
  // 3. 确认结果在 cwd 内
  // 4. 不使用简单 startsWith(cwd)，避免 /repo-other 绕过 /repo
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

以 `read_file` 为例：

```ts
export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a UTF-8 text file or a bounded line range",
  parameters: z.object({
    description: z.string(),
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
  invoke: async (input, signal) => {
    // TODO:
    // validate path → check abort → check existence/type
    // → validate line range → return numbered content
  },
});
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

### 8.5 测试隔离

每个 filesystem Tool 使用临时 workspace：

```ts
import { afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "harness-lab-tool-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});
```

测试绝不能修改课程仓库本身。

### 运行与观察

创建一个临时 fixture repo，依次运行：

```bash
bun run examples/stage-08-coding-tools.ts inspect
bun run examples/stage-08-coding-tools.ts edit
bun run examples/stage-08-coding-tools.ts reject-path
```

示例最后打印 workspace diff，而不只是打印 `ok: true`。你应能看到每个 Tool 对外部世界造成的具体变化。

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

### 9.1 Coding Agent composition root

不要把 Coding 逻辑放回通用 `Agent`。创建：

```ts
export async function defineCodingAgent(options: {
  model: Model;
  cwd?: string;
  skillsDirs?: string[];
  askUserQuestion?: AskUserQuestionHandler;
  policyMiddleware?: AgentMiddleware;
}): Promise<Agent> {
  // TODO:
  // 1. 读取项目 guidance
  // 2. 定义 coding prompt
  // 3. 构造 tools
  // 4. 构造 skills/todo/policy middlewares
  // 5. 返回通用 Agent
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

### 9.5 Ask user Tool

Tool call 不只用于机器 API。定义 `ask_user_question`，把需要人类补充的信息表示为可等待的 Tool：

```ts
export type AskUserQuestionHandler = (params: {
  question: string;
  choices?: string[];
}) => Promise<{ answer: string }>;
```

测试 handler 被并发 Tool 调度调用时不会丢失 call id。

### 运行与观察

准备 fixture workspace：

```text
fixture/
├── AGENTS.md
├── .agents/skills/test-writer/SKILL.md
└── src/math.ts
```

运行：

```bash
bun run examples/stage-09-coding-agent.ts fixture
```

使用 scripted provider 完成一次“读取 guidance → 列出 Skill → 加载 Skill → 建 Todo → 读取文件 → 最终回答”的 run。输出 transcript，并断言没有真实 API。

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

### 本阶段目标

把 runtime 变成真正可用的终端产品，同时建立人工审批边界。完成后打 `v0.1.0` tag，表示基础复刻结束。

### 10.1 安装交互依赖

```bash
bun add commander ink react yaml
bun add -d @types/react eslint typescript-eslint
```

把 ESLint 加入 `bun run check`。不要在这一阶段做全仓库风格重构，只约束新增项目。

### 10.2 配置模型

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

先实现状态，再做视觉：

```ts
interface AgentLoopViewState {
  messages: NonSystemMessage[];
  streaming: boolean;
  tokenUsage: {
    latestInputTokens: number;
    sessionTotalTokens: number;
  };
  pendingApproval?: ApprovalRequest;
  todos: TodoItem[];
}
```

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

只从 assistant message 的 provider-reported usage 聚合：

```ts
export function calculateTokenUsage(messages: NonSystemMessage[]) {
  // latestInputTokens = 最后一条有 usage 的 assistant.promptTokens
  // sessionTotalTokens = 所有 assistant.totalTokens 之和
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

### 必写自动化测试

- model config schema；
- default model resolution；
- token usage aggregation；
- slash command parsing；
- approval queue FIFO；
- queue overflow fail closed；
- deny 跳过真实 Tool；
- project allowlist persistence；
- abort 后可开始下一轮 run；
- TUI state reducer 对 event 的更新。

UI 像素和颜色不用过度测试，优先测试状态转换。

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
