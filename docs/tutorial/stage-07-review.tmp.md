# 阶段 7 临时复习笔记

记录日期：2026-10-10。用于恢复学习上下文，重点回顾 Provider Adapter 和 7B 流式实现；后续可整理进正式教程或删除。

实现基线：练习仓库 `harness-coding-lab` 的 `main`，提交 `cf3753d`。下文源码路径均相对练习仓库，描述的是当前实现。

## 当前进度

阶段 0～6 已实现消息协议、模型抽象、工具契约、ReAct 循环、并发与中止、Middleware。
阶段 7 的核心实现也已完成，可以进入阶段 8：

| 里程碑 | 已完成内容 |
|---|---|
| 7A | OpenAI 消息与工具定义转换、非流式 `invoke()` |
| 7B | OpenAI `stream()`、累计快照、工具 JSON 片段拼接、usage |
| 7C | Anthropic 独立适配、内容块累积、thinking 签名与流结束校验 |
| 7D | 通过 Anthropic Provider 验证真实 endpoint，修复示例重复打印 |

阶段 7 在 9 月 14 日合入练习仓库 `main`，9 月 18 日提交并推送流式打印修复。
10 月 9 日核验时，练习仓库类型检查通过，140 项测试通过、0 项失败；这不是本笔记新增的测试结果。
教程要求的 `ADR-008` 尚未找到，仍需补充协议边界的设计记录。

## 阶段 7 解决的问题

阶段 1～6 使用离线 `ScriptedModelProvider` 验证 Agent 行为。接入真实模型后，需要处理厂商消息、工具调用、流式事件和 token 字段的差异。

```text
Agent → Model → Provider Adapter → SDK / 模型服务
                   ↓
             AssistantMessage
                   ↓
           Agent 记录消息、调度工具
```

Provider 将内部 `Message[]` 和 Tool 定义转换成请求，再将响应转换回统一的 `AssistantMessage`。
它生成工具调用描述；实际执行工具由 Agent 和 ToolRegistry 负责。

每个 Provider 的三个主要文件分工如下：

| 文件 | 职责 |
|---|---|
| `utils.ts` | 内部消息与厂商协议之间的转换 |
| `model-provider.ts` | 发起请求、消费响应流、组织转换与输出 |
| `stream-accumulator.ts` | 保存累计内容，生成当前消息快照 |

## 7B 的执行链路

入口：`src/community/openai/model-provider.ts` 的 `stream()`。

```text
SDK chunk
→ 提取正文、thinking、工具参数片段、usage
→ accumulator.push() 更新状态
→ accumulator.snapshot() 构造当前完整消息
→ yield 交给调用方
```

`async *stream()` 返回异步生成器。调用方开始迭代时才执行方法体，每次 `yield` 产出一份 `AssistantMessage`。

```ts
const responseStream = await this._client.chat.completions.create(
    {
        ...this._baseChatCompletionParams(params),
        stream: true,
        stream_options: { include_usage: true },
    },
    { signal: params.signal },
);

const accumulator = new StreamAccumulator();
for await (const chunk of responseStream) {
    // 提取字段，调用 push()。
    yield accumulator.snapshot();
}
```

这是省略字段处理后的流程示意。`await create()` 获得响应流，`for await` 持续读取片段。
同一次模型响应共用一个累积器，因此它必须在循环外创建；下一次模型请求创建新的累积器。

### Provider 提取字段

| SDK 数据 | 内部 `ProviderChunk` 字段 |
|---|---|
| `delta.content` | `textDelta` |
| `delta.reasoning_content` | `thinkingDelta` |
| `call.index`、`call.id` | `toolCall.index`、`toolCall.id` |
| `call.function.name` | `toolCall.name` |
| `call.function.arguments` | `toolCall.argumentsDelta` |
| `chunk.usage` | 转换字段名后的 `usage` |

当前实现只处理 `chunk.choices[0]`。`delta` 是候选回复的新增内容，`ProviderChunk` 是项目自定义的更新格式，两者不是同一个类型。

每个 SDK chunk 的处理顺序是：正文和 thinking 更新一次 → 遍历所有工具片段 → 更新 usage → 生成并输出一次快照。
一个 chunk 带多个工具时，正文也只追加一次。

只含 usage 的 chunk 可以没有候选回复，所以使用 `chunk.choices[0]?.delta`，并在 `delta` 缺失时继续处理 usage。

### 累积器保存四类状态

实现位置：`src/community/openai/stream-accumulator.ts`。

| 状态 | 更新规则 |
|---|---|
| `_text` | 追加正文片段 |
| `_thinking` | 单独追加 thinking 片段 |
| `_toolCalls` | 按工具 `index` 保存 id、name、参数字符串 |
| `_usage` | 收到新统计时覆盖；未提供时保留旧值 |

工具调用中，`id` 和 `name` 在片段提供有效值时赋值，`argumentsDelta` 使用 `+=` 拼接。
后续片段可以只有 `index` 和参数增量，通过 `index` 找到原来的状态。

```text
第一次：index=0，id=call-a，name=read_file，argumentsDelta='{"path":'
状态：  0 → { id: "call-a", name: "read_file", argumentsText: '{"path":' }

第二次：index=0，argumentsDelta='"a.ts"}'
状态：  0 → { id: "call-a", name: "read_file", argumentsText: '{"path":"a.ts"}' }
```

不同 `index` 使用独立状态，避免多个工具的参数交错到达时混在一起。

### snapshot 将中间状态转成消息

输出顺序为 thinking、text、按数值 `index` 排序的 tool_use。Map 保留插入顺序，输出前需要显式排序。

工具中间状态 `{ id, name, argumentsText }` 必须转换成 `{ type: "tool_use", id, name, input }`。
只增加 `type` 字段还不够，`argumentsText` 要经过 `JSON.parse` 得到 `input`。

| 参数状态 | usage 状态 | 当前 OpenAI 实现的行为 |
|---|---|---|
| JSON 可解析 | 任意 | 输出该工具调用 |
| JSON 不可解析 | 尚未收到 | 暂时跳过该工具调用 |
| JSON 不可解析 | 已收到 | 输出该工具调用，以 `{}` 兜底 |

源码中“参数不完整时暂用 `{}`”的旧注释不够准确，应以以上实际逻辑为准。
usage 触发兜底是当前实现的约定，不代表参数已通过严格校验；`JSON.parse` 成功也不保证得到对象或符合工具 schema。

每次快照创建新数组和内容块，重新解析工具参数，并克隆 usage，避免调用方修改旧快照时污染后续状态。

### 一次响应的变化示例

| 顺序 | 本次新增数据 | 快照中的内容 |
|---|---|---|
| 1 | 正文 `正在读取` | 正文 `正在读取` |
| 2 | 工具 0 的参数 `{"path":` | 仍只有正文，工具参数未完整 |
| 3 | 工具 0 的参数 `"a.ts"}` | 正文 + `read_file({ path: "a.ts" })` 的调用描述 |
| 4 | usage | 内容保持不变，更新 token 用量 |

快照是截至当前的累计状态，正文没有变化也可能再次输出。
当前 OpenAI Provider 在 SDK 流迭代结束时结束生成器，没有额外的最终校验步骤，也没有通过 `return` 返回最终消息；调用方保留最后一次 `yield` 的结果。

## 快照如何进入 Agent 和终端

`src/agent/agent.ts` 的 `_think()` 持续更新 `latest = snapshot`，并根据快照发出 progress。
流结束后返回 `latest`，由外层 Agent 写入 transcript，再调度其中的工具。
中间快照里的 `tool_use` 用于进度展示，当前 Agent 不会在每个片段到达时执行工具。

追加式终端输出应只打印新增正文。此前真实模型示例重复显示，是因为每次打印完整累计快照，并用 `\r` 尝试覆盖；换行或日志捕获时无法得到预期效果。

`examples/stage-07-real-model.ts` 已改为：

```ts
const text = visibleText(snapshot);
process.stdout.write(text.slice(printedText.length));
printedText = text;
```

这种写法适用于当前正文持续追加的实现；仅更新 usage 或 thinking 时不会重复打印正文。

## 其余关键结论

- `reasoning_content`：保留了兼容适配，接收、累积并用于历史转换；具体 endpoint 是否支持及如何回传，需要按服务约定确认。扩展 TypeScript 类型不会改变服务端能力。
- Anthropic：Provider 检查事件生命周期与结束条件，Accumulator 保存内容。`startedBlocks` 记录出现过的编号，`openBlocks` 记录尚未关闭的编号；关闭内容块后，累计内容仍须保留。
- 工具 JSON：Anthropic 的中间快照允许占位，Provider 在结束时严格检查最终参数；不能把 OpenAI 当前的 usage 兜底策略当作两者共有的契约。
- thinking 签名：Anthropic 适配保留签名、接收流式更新并在历史请求中回传，签名与正文分开保存。
- 已知范围：`refusal` 尚未适配；并发取消时回收已就绪结果、隔离迟到更新的边界，已约定在 checkpoint/resume 前补齐。

## 接下来从哪里继续

先完成[阶段 8 Coding Tools](./part-3-coding-agent.md#阶段-8-实现-coding-tools)的路径边界、`read_file`、`str_replace`、`bash`，建立读取、修改、检查的闭环。
恢复能力前的并发取消要求见[阶段 12.0](./part-4-production-runtime.md#_12-0-先补齐并发取消边界)。

复习源码时，按下面的顺序阅读：

1. `src/community/openai/model-provider.ts` 的 `stream()`。
2. `src/community/openai/stream-accumulator.ts` 的 `push()` 和 `snapshot()`。
3. `src/community/openai/__tests__/model-provider.test.ts` 的 `handles all tool fragments per chunk without mixing calls or repeating text`，逐个 chunk 推演状态。
4. `src/agent/agent.ts` 的 `_think()`，确认快照、最终消息和工具执行的时机。
