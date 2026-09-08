# 阶段验收清单

这份清单用于跟踪学习，不替代各章中的原理、骨架和测试说明。只有“程序可运行 + 测试通过 + 能解释设计”同时满足时才勾选。

每个阶段开始和结束时，还要统一检查以下教学流程：

- [ ] 使用本阶段给出的命令创建目录和空文件，没有手工遗漏路径；
- [ ] 标准实现示例及其注释能够解释一条完整路径；
- [ ] 逐项完成其余 TODO，并检查对应的边界、错误语义和提示；
- [ ] 关键纯逻辑或回归点使用最小聚焦测试完成 Red/Green；
- [ ] 示例输入符合参数规则，示例输出与实际运行结果一致；
- [ ] 观察示例输出并修正实现偏差后，再完整复制教程提供的测试文件；
- [ ] 没有修改断言来迎合实现，并在阶段末运行本阶段的 `bun test`；
- [ ] 本阶段测试通过后，再运行 `bun run check`。

## 总进度

| 阶段 | 状态 | Commit | 完成日期 | 主要证据 |
|---|---|---|---|---|
| 0. 工程起点 | ⬜ |  |  | CLI 输出、check |
| 1. Message | ⬜ |  |  | transcript demo |
| 2. Model | ⬜ |  |  | cumulative stream |
| 3. Tool | ⬜ |  |  | validation/error codes |
| 4. ReAct loop | ⬜ |  |  | offline agent transcript |
| 5. 并发与中止 | ⬜ |  |  | timing、abort test |
| 6. Middleware | ⬜ |  |  | lifecycle order |
| 7. Provider | ⬜ |  |  | converter tests、real smoke |
| 8. Coding tools | ⬜ |  |  | isolated workspace diff |
| 9. Context 能力 | ⬜ |  |  | Skills/Todo/AGENTS demo |
| 10. CLI/TUI 与审批 | ⬜ |  |  | manual test、v0.1.0 |
| 11. Observability | ⬜ |  |  | trace、metrics |
| 12. Recovery | ⬜ |  |  | fault injection、resume/replay |
| 13. Context 与可靠性 | ⬜ |  |  | compression/retry report |
| 14. Evaluation | ⬜ |  |  | eval report |
| 15. Capstone | ⬜ |  |  | benchmark、demo、v1.0.0 |

状态建议只使用：`⬜ 未开始`、`🟨 进行中`、`✅ 完成`、`🟥 需要返工`。

## 阶段 0：工程起点

- [ ] `bun run dev` 输出 `harness-lab ready`；
- [ ] `bun run check` 从干净 checkout 通过；
- [ ] TypeScript strict 已开启；
- [ ] 四层目录和依赖方向建立；
- [ ] ADR-001 完成。

## 阶段 1：Message

- [ ] `Message` 和 Content 都是 discriminated union；
- [ ] `formatTranscript` 显示四种 role；
- [ ] `tool_use_id` 关联可见；
- [ ] exhaustive switch test 生效；
- [ ] ADR-002 完成。

## 阶段 2：Model

- [ ] `Model` 不依赖具体 provider SDK；
- [ ] system prompt 在请求边界注入；
- [ ] scripted stream 是累计快照；
- [ ] 最终 stream snapshot 与 invoke 语义一致；
- [ ] signal 传到 provider；
- [ ] ADR-003 完成。

## 阶段 3：Tool

- [ ] `defineTool` 保留 schema inference；
- [ ] Tool name 唯一；
- [ ] runtime 本地校验 input；
- [ ] expected failure 有稳定 error code；
- [ ] abort 在副作用前检查；
- [ ] ADR-004 完成。

## 阶段 4：ReAct loop

- [ ] 离线 demo 展示 think/act/observe/answer，并能指出四个环节在最小循环中的位置；
- [ ] transcript role 顺序正确；
- [ ] unknown Tool 变成 observation；
- [ ] `maxSteps` 可测试；
- [ ] Tool result serialization 有边界处理；
- [ ] ADR-005 完成。

## 阶段 5：并发与中止

- [ ] 从顺序循环提取 `_think()`、`_act()` 后，阶段 4 测试仍通过；
- [ ] 创建并填写 `think-hints.test.ts`，在 5.1 运行全部 6 项聚焦测试；
- [ ] assistant 消息在 `stream()` 中追加并输出一次，Tool observation 在 `_act()` 中回写；
- [ ] 同批 Tool 并发启动；
- [ ] 快 Tool 结果先可见；
- [ ] 单个 Tool failure 不取消其他 Tool；
- [ ] abort 到达 provider、Tool 和子进程；
- [ ] 所有退出路径清理 `_streaming`；
- [ ] ADR-006 完成。

## 阶段 6：Middleware

- [ ] host 与 Middleware 两份测试共 24 项通过；
- [ ] progress 接收及 yield 恢复后响应取消，不多拉取或发布 snapshot；
- [ ] 单个已完成 Tool 结果在取消时保留，实际 ABORTED 与普通 failure 分开；
- [ ] ADR-007 记录并发取消的剩余边界，并关联阶段 12.0 前置任务；
- [ ] lifecycle 顺序有测试；
- [ ] Middleware 串行顺序固定；
- [ ] `AgentContext` 与 `ModelContext` mutation boundary 明确；
- [ ] `beforeToolUse` skip 不破坏 transcript；
- [ ] error/maxSteps hook 语义固定；
- [ ] ADR-007 完成。

## 阶段 7：Provider

- [ ] 按 7A invoke → 7B stream → 7C 第二个 Provider → 7D 联网验证推进；
- [ ] OpenAI converter pure tests；
- [ ] Anthropic converter pure tests；
- [ ] fragmented Tool JSON 测试；
- [ ] 多 Tool stream 不串线；
- [ ] token usage 统一为 canonical type；
- [ ] API key 不进入日志/fixture；
- [ ] ADR-008 完成。

## 阶段 8：Coding tools

- [ ] 先通过 read_file、str_replace、bash 小里程碑，再注册完整工具集；
- [ ] 所有只读 Tools 有 happy/error/boundary tests；
- [ ] 所有修改 Tools 有副作用 tests；
- [ ] path traversal、相似前缀、symlink escape 被拒绝；
- [ ] `str_replace` 拒绝隐式多处替换；
- [ ] 替换和 patch 成功后读取磁盘断言内容，失败后断言原文件未变；
- [ ] bash 超量输出仍被排空，运行中 timeout/abort 后子进程不能继续写文件；
- [ ] 测试只修改临时 workspace；
- [ ] ADR-009 完成。

## 阶段 9：Context 能力

- [ ] Coding Agent 只在 composition root 组装；
- [ ] `AGENTS.md` 不存在/超限均有明确行为；
- [ ] Skills progressive loading 可观察；
- [ ] Todo merge/reminder 可测试；
- [ ] Ask user Tool 保留 call id；
- [ ] ADR-010 完成。

## 阶段 10：CLI/TUI 与审批

- [ ] 10A 文本客户端可离线运行，10B 最小 Ink 界面可提交和中止；
- [ ] tsconfig 包含 JSX 与 .tsx，基础 lint 配置可执行；
- [ ] 配置 schema 和 default model resolution 测试；
- [ ] 配置不保存 secret value；
- [ ] 忙碌状态、最终消息、token、Todo 在 TUI 可见；正文流式显示若实现则另有契约与测试；
- [ ] Ctrl+C 中止并可开始下一轮；
- [ ] 审批队列 FIFO 且 overflow fail closed；
- [ ] deny 结果反馈模型；
- [ ] `docs/manual-test.md` 跑通；
- [ ] `bun run check` 通过；
- [ ] ADR-011 和 `v0.1.0` 完成。

## 阶段 11：Observability

- [ ] Agent 只引用 foundation 契约，存储实现由 composition root 注入；
- [ ] 每个 run 有稳定 runId 和单调 sequence；
- [ ] success/failure/abort/maxSteps 都产生 `run_end`；
- [ ] model/tool/approval spans 可关联；
- [ ] JSONL 支持逐行诊断；
- [ ] secret 和大 payload 被 redaction；
- [ ] metrics 由纯 reducer 派生；
- [ ] ADR-012 完成。

## 阶段 12：Recovery

- [ ] 写 checkpoint/resume 前完成 12.0：已完成结果回收、未完成任务退出、迟到 hook 隔离三项回归；
- [ ] 并发取消时已交付结果恰好记录一次，关闭后迟到任务不能再修改状态；
- [ ] 取消 checkpoint 后 resume，两个并发写入计数器各保持 1，observations 不重复；
- [ ] 阶段 6 的 24 项测试持续通过；
- [ ] checkpoint schema versioned；
- [ ] atomic temp-write + rename；
- [ ] Tool 副作用前保存 intent；
- [ ] running crash 恢复为 unknown；
- [ ] 已确认成功 Tool 不重复执行；
- [ ] 已保存结果补回缺失 observation，重复结果按 tool call id 去重；
- [ ] `continueFromStep` 是实际公开 API，不通过类型断言伪造；
- [ ] unsafe unknown Tool 请求人工决策；
- [ ] 真实 Agent 计数器场景通过：写入后中断、先阻塞、确认结果后续跑，最终值为 1；
- [ ] replay 不调用 model/Tool；
- [ ] fault injection suite 通过；
- [ ] ADR-013 完成。

## 阶段 13：Context 与可靠性

- [ ] canonical transcript 不被 compaction 修改；
- [ ] prepared Model view 在 token budget 内；
- [ ] 最近用户约束保留；
- [ ] Tool call/result 无孤儿；
- [ ] retry 仅处理 transient error；
- [ ] retry sleep 可 abort；
- [ ] unsafe Tool 不自动 retry；
- [ ] policy decision/reason 进入 trace；
- [ ] ADR-014、ADR-015 完成。

## 阶段 14：Evaluation

- [ ] 至少 10 个覆盖不同失败模式的任务；
- [ ] 真实文件测试证明每个 trial 使用独立 fixture 副本，哈希来自实际内容；
- [ ] allowedTools 过滤实际 Registry，首个本地任务仅使用有路径边界的文件 Tools；
- [ ] grader 不提供给 Agent；允许命令执行的任务有实际 sandbox，不能仅依靠 cwd；
- [ ] Agent failure 与 infra error 分开；
- [ ] report 包含 commit/config fingerprints；
- [ ] baseline/candidate 只改变一个主变量；
- [ ] failed trial 保留 trace、patch 和 grader output；
- [ ] ADR-016 完成。

## 阶段 15：Capstone

- [ ] README 明确项目定位和 Helixent 来源；
- [ ] architecture/security/recovery/context/eval 文档完成；
- [ ] offline、recovery、real coding 三个 demo 可运行；
- [ ] benchmark 提供原始分子/分母和失败分析；
- [ ] 全新目录验证安装步骤；
- [ ] 简历数字均能追溯到报告；
- [ ] 15 个答辩问题可以脱离代码回答；
- [ ] `v1.0.0` 完成。

## 阶段卡住时的诊断顺序

1. 先运行本阶段最小单测，不运行完整真实模型 demo；
2. 打印 canonical Message，而不是 provider raw response；
3. 检查错误属于 protocol、runtime、Tool、provider 还是 UI；
4. 用 scripted provider 复现，排除网络和模型随机性；
5. 用 fake clock/id/sleeper 排除时间不确定性；
6. 检查 transcript 中 `tool_use` / `tool_result` 配对；
7. 检查 abort signal 是否贯穿调用链；
8. 最后才查看 Helixent 对应实现并记录差异。
