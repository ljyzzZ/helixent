# 阶段验收清单

这份清单用于跟踪学习，不替代各章中的原理、骨架和测试说明。只有“程序可运行 + 测试通过 + 能解释设计”同时满足时才勾选。

每个阶段开始和结束时，还要统一检查以下教学流程：

- [ ] 使用本阶段给出的命令创建目录和空文件，没有手工遗漏路径；
- [ ] 完整复制教程提供的测试文件，没有修改断言来迎合实现；
- [ ] 先观察测试失败（Red），再完成实现并观察测试通过（Green）；
- [ ] 标准实现示例及其注释能够解释一条完整路径；
- [ ] 逐项完成其余 TODO，并检查对应的边界、错误语义和提示；
- [ ] 示例输入符合参数规则，示例输出与实际运行结果一致；
- [ ] 只运行本阶段测试迭代，最后再运行 `bun run check`。

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

- [ ] 离线 demo 展示 think/act/observe/answer；
- [ ] transcript role 顺序正确；
- [ ] unknown Tool 变成 observation；
- [ ] `maxSteps` 可测试；
- [ ] Tool result serialization 有边界处理；
- [ ] ADR-005 完成。

## 阶段 5：并发与中止

- [ ] 同批 Tool 并发启动；
- [ ] 快 Tool 结果先可见；
- [ ] 单个 Tool failure 不取消其他 Tool；
- [ ] abort 到达 provider、Tool 和子进程；
- [ ] 所有退出路径清理 `_streaming`；
- [ ] ADR-006 完成。

## 阶段 6：Middleware

- [ ] lifecycle 顺序有测试；
- [ ] Middleware 串行顺序固定；
- [ ] `AgentContext` 与 `ModelContext` mutation boundary 明确；
- [ ] `beforeToolUse` skip 不破坏 transcript；
- [ ] error/maxSteps hook 语义固定；
- [ ] ADR-007 完成。

## 阶段 7：Provider

- [ ] OpenAI converter pure tests；
- [ ] Anthropic converter pure tests；
- [ ] fragmented Tool JSON 测试；
- [ ] 多 Tool stream 不串线；
- [ ] token usage 统一为 canonical type；
- [ ] API key 不进入日志/fixture；
- [ ] ADR-008 完成。

## 阶段 8：Coding tools

- [ ] 所有只读 Tools 有 happy/error/boundary tests；
- [ ] 所有修改 Tools 有副作用 tests；
- [ ] path traversal、相似前缀、symlink escape 被拒绝；
- [ ] `str_replace` 拒绝隐式多处替换；
- [ ] bash timeout/abort 无残留进程；
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

- [ ] 配置 schema 和 default model resolution 测试；
- [ ] 配置不保存 secret value；
- [ ] streaming、token、Todo 在 TUI 可见；
- [ ] Ctrl+C 中止并可开始下一轮；
- [ ] 审批队列 FIFO 且 overflow fail closed；
- [ ] deny 结果反馈模型；
- [ ] `docs/manual-test.md` 跑通；
- [ ] `bun run check` 通过；
- [ ] ADR-011 和 `v0.1.0` 完成。

## 阶段 11：Observability

- [ ] 每个 run 有稳定 runId 和单调 sequence；
- [ ] success/failure/abort/maxSteps 都产生 `run_end`；
- [ ] model/tool/approval spans 可关联；
- [ ] JSONL 支持逐行诊断；
- [ ] secret 和大 payload 被 redaction；
- [ ] metrics 由纯 reducer 派生；
- [ ] ADR-012 完成。

## 阶段 12：Recovery

- [ ] checkpoint schema versioned；
- [ ] atomic temp-write + rename；
- [ ] Tool 副作用前保存 intent；
- [ ] running crash 恢复为 unknown；
- [ ] 已确认成功 Tool 不重复执行；
- [ ] unsafe unknown Tool 请求人工决策；
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
- [ ] 每个 trial 使用干净 workspace；
- [ ] grader 与 prompt 不互相泄漏；
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
