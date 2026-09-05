# 第五部分：评测闭环与作品集交付

这一部分完成阶段 14～15。没有 evaluation，context、retry、prompt 或 Tool 的“优化”只能靠主观体验判断；没有可复现交付，评测数字也无法成为可信的简历证据。

## 阶段 14：建立 Evaluation Harness

> 上一阶段回顾：阶段 13 分离了 canonical transcript 与预算内 Model view，并加入 compaction、retry、Tool timeout 和 PolicyEngine。

### 14.1 分开两类评测

不要把所有测试都称为 eval。

| 类型 | 是否调用真实模型 | 主要回答的问题 |
|---|---:|---|
| Runtime conformance | 否 | loop、并发、恢复、compaction 是否符合不变量 |
| Agent capability eval | 是 | 某模型和 harness 配置能否完成真实 Coding 任务 |

前者必须进入 `bun run check`，快速、确定、免费。后者单独运行，允许模型随机性、费用和较长耗时。

### 14.2 Eval task 结构

一键创建首个任务、suite、runner 和测试文件：

```bash
mkdir -p evals/tasks/fix-add/fixture/src evals/tasks/fix-add/graders
mkdir -p evals/suites evals/reports src/eval/__tests__
touch evals/tasks/fix-add/task.yaml evals/tasks/fix-add/prompt.md
touch evals/tasks/fix-add/graders/test.ts evals/suites/smoke.yaml
touch evals/tasks/fix-add/fixture/package.json evals/tasks/fix-add/fixture/src/add.ts
touch src/eval/types.ts src/eval/task-loader.ts src/eval/workspace-factory.ts
touch src/eval/grader-runner.ts src/eval/artifact-store.ts src/eval/eval-runner.ts src/eval/index.ts
touch src/eval/__tests__/task-loader.test.ts src/eval/__tests__/test-harness.ts
touch src/eval/__tests__/eval-runner.test.ts
```

命令不会替你生成 fixture 题目答案；`fixture/` 必须是 Agent 每次 trial 收到的干净项目。

```text
evals/                           # Evaluation Harness 的任务与产物根目录
├── tasks/                       # 独立 eval tasks
│   ├── fix-add/                 # 修复加法逻辑的示例任务
│   │   ├── task.yaml            # 定义任务元数据、限制和 grader
│   │   ├── prompt.md            # 保存只对 Agent 可见的用户需求
│   │   ├── fixture/             # 提供每次 trial 的干净初始项目
│   │   └── graders/             # 保存与 prompt 隔离的评分器
│   │       └── test.ts          # 执行确定性任务验收
│   └── rename-api/              # 另一个 API 重命名任务
├── suites/                      # 组合可重复运行的任务集合
│   ├── smoke.yaml               # 定义快速冒烟评测集
│   └── coding-core.yaml         # 定义核心 Coding 能力评测集
└── reports/                     # 保存 run artifacts 与汇总报告
```

`task.yaml`：

```yaml
id: fix-add
version: 1
category: bug-fix
difficulty: easy
timeoutMs: 120000
maxSteps: 20
allowedTools:
  - read_file
  - grep_search
  - str_replace
  - apply_patch
  - bash
grader:
  command: bun test graders/test.ts
  timeoutMs: 20000
```

`prompt.md` 只描述用户可见需求，不泄漏 grader 断言和答案位置。

下面把首个 eval task 完整写好。目标文件：`evals/tasks/fix-add/prompt.md`

```markdown
`src/add.ts` 中的 `add` 函数在部分输入下返回错误结果。请定位并修复问题，保留现有
函数签名，不要引入新依赖。完成后运行项目测试。
```

目标文件：`evals/tasks/fix-add/fixture/package.json`

```json
{
  "name": "eval-fix-add",
  "private": true,
  "type": "module"
}
```

目标文件：`evals/tasks/fix-add/fixture/src/add.ts`（这是每个 trial 的示例输入）：

```ts
export function add(left: number, right: number): number {
  return left - right;
}
```

参数规则：`left/right` 都是有限 number，输出是两者算术和；不得把只针对一个 fixture
值的常量当作实现。目标文件：`evals/tasks/fix-add/graders/test.ts`

```ts
import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const workspace = process.env.HARNESS_EVAL_WORKSPACE;
if (!workspace) throw new Error("HARNESS_EVAL_WORKSPACE is required");

const moduleUrl = pathToFileURL(join(workspace, "src", "add.ts")).href;
const { add } = await import(moduleUrl) as {
  add(left: number, right: number): number;
};

describe("add", () => {
  test("adds positive, negative and fractional values", () => {
    expect(add(2, 3)).toBe(5);
    expect(add(-2, 5)).toBe(3);
    expect(add(0.25, 0.5)).toBe(0.75);
  });
});
```

目标文件：`evals/suites/smoke.yaml`

```yaml
name: smoke
version: 1
tasks:
  - ../tasks/fix-add
```

这个 grader 是教程完整提供的隐藏测试，读者不需要补断言；Agent workspace 只收到
`fixture/`，不会收到 `graders/`。示例输出是 grader exit code 0 和 `1 pass`。

Runner 只把 `fixture/` 复制到 trial workspace，并把 Agent 的 `cwd` 限制在该目录。Grader 从 task root 运行，通过只读环境变量 `HARNESS_EVAL_WORKSPACE` 获取 trial workspace 路径；`graders/` 不复制进 Agent workspace，因此模型不能直接读取隐藏断言。

目标文件：`src/eval/types.ts`

```ts
export interface EvalTask {
  id: string;
  version: number;
  prompt: string;
  fixturePath: string;
  timeoutMs: number;
  maxSteps: number;
  allowedTools: string[];
  grader: { command: string; timeoutMs: number };
}

export interface EvalSuite {
  name: string;
  version: number;
  tasks: EvalTask[];
}
```

目标文件：`src/eval/task-loader.ts`

实现任务加载器：

```ts
export class TaskLoader {
  constructor(options: { evalRoot: string }) {
    // TODO 1：保存 realpath 后的 evalRoot；构造阶段不加载任何 task。
  }

  async loadTask(taskDirectory: string): Promise<EvalTask> {
    // TODO 2：读取 task.yaml/prompt.md 并校验 manifest；返回规范化绝对路径。
    // TODO 3：拒绝 evalRoot 外路径，错误包含具体字段或路径。
    throw new Error("TODO: implement TaskLoader.loadTask");
  }

  async loadSuite(suitePath: string): Promise<EvalSuite> {
    // TODO 4：先校验 suite，再按声明顺序 loadTask；重复 task id 必须拒绝。
    throw new Error("TODO: implement TaskLoader.loadSuite");
  }
}
```

### 14.3 从小型任务集开始

第一版准备 10 个任务，覆盖不同失败模式：

1. 单文件纯函数 bug；
2. 跨文件 API rename；
3. 补充输入校验；
4. 添加一个带测试的小功能；
5. 修复 async race；
6. 在明确范围内重构；
7. 根据 failing test 定位问题；
8. 处理路径边界；
9. 更新配置且保持兼容；
10. 信息不足时正确提出问题，而不是擅自修改。

先让 10 个任务质量足够高，再扩大到 30～50 个。大量含糊 task 不会自动变成高质量 benchmark。

### 14.4 隔离运行

每个 trial 必须：

1. 创建新的临时目录；
2. 复制 fixture，不复用上次修改；
3. 初始化独立 runId 和 trace；
4. 限制 cwd、timeout、maxSteps 和 Tools；
5. 运行 Agent；
6. 停止 Agent 后运行 grader；
7. 保存 patch、trace、checkpoint、grader output；
8. 删除临时 workspace，或失败时按配置保留以便调试。

目标文件：`src/eval/types.ts`

```ts
export interface EvalTrialResult {
  taskId: string;
  taskVersion: number;
  trial: number;
  runId: string;
  status: "passed" | "failed" | "timeout" | "infra_error";
  graderScore: number;
  metrics: RunMetrics;
  patchPath: string;
  tracePath: string;
  failureReason?: string;
}
```

`infra_error` 与 Agent 任务失败必须分开。API outage、fixture 缺失、grader 自身崩溃不能算成模型能力失败。

### 14.5 Grader 优先级

优先使用确定性 grader：

1. 自动化测试；
2. 文件内容/AST/JSON schema 检查；
3. command exit code；
4. 必要时人工 rubric；
5. 最后才是 LLM-as-judge。

LLM judge 适合评价解释质量或开放式结果，但会引入额外模型偏差。若使用，固定 judge model、prompt version，并保存原始判定理由；不要让 judge 读取被评模型身份。

### 14.6 EvalRunner 骨架

目标文件：`src/eval/types.ts`

定义 `EvalRunner` 依赖的接口：

<details>
<summary>展开完整代码：<code>types.ts</code></summary>

```ts
export type EvalConfig = Record<string, unknown>;

export interface EvalWorkspace {
  path: string;
  initialFixtureHash: string;
  cleanup(): Promise<void>;
}

export interface EvalTaskLoader {
  loadSuite(suitePath: string): Promise<EvalSuite>;
}

export interface EvalWorkspaceFactory {
  create(options: { task: EvalTask; trial: number }): Promise<EvalWorkspace>;
}

export interface EvalAgentFactory {
  runTrial(options: {
    task: EvalTask;
    workspacePath: string;
    config: EvalConfig;
    index: number;
    signal?: AbortSignal;
  }): Promise<{ runId: string; metrics: RunMetrics }>;
}

export interface GraderRunner {
  grade(options: {
    task: EvalTask;
    workspacePath: string;
    signal?: AbortSignal;
  }): Promise<{ passed: boolean; score: number; output: string }>;
}

export interface EvalArtifactStore {
  saveTrial(artifact: unknown): Promise<{ patchPath: string; tracePath: string }>;
}

export interface EvalIdentityProvider {
  create(options: { suite: EvalSuite; config: EvalConfig }): Promise<EvalRunIdentity>;
}

export interface EvalSuiteResult {
  identity: EvalRunIdentity;
  trials: EvalTrialResult[];
  aggregate: {
    validTrials: number;
    infraErrors: number;
    successRate: number;
  };
}
```

</details>

目标文件：`src/eval/eval-runner.ts`

<details>
<summary>展开完整代码：<code>eval-runner.ts</code></summary>

```ts
export class EvalRunner {
  private readonly _taskLoader: EvalTaskLoader;
  private readonly _workspaceFactory: EvalWorkspaceFactory;
  private readonly _agentFactory: EvalAgentFactory;
  private readonly _graderRunner: GraderRunner;
  private readonly _artifactStore: EvalArtifactStore;
  private readonly _identityProvider: EvalIdentityProvider;
  private readonly _concurrency: number;

  constructor(options: {
    taskLoader: EvalTaskLoader;
    workspaceFactory: EvalWorkspaceFactory;
    agentFactory: EvalAgentFactory;
    graderRunner: GraderRunner;
    artifactStore: EvalArtifactStore;
    identityProvider: EvalIdentityProvider;
    concurrency: number;
  }) {
    // 标准实现示例：构造阶段只固定依赖，并立即拒绝非正整数 concurrency。
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new Error("EvalRunner concurrency must be a positive integer");
    }
    this._taskLoader = options.taskLoader;
    this._workspaceFactory = options.workspaceFactory;
    this._agentFactory = options.agentFactory;
    this._graderRunner = options.graderRunner;
    this._artifactStore = options.artifactStore;
    this._identityProvider = options.identityProvider;
    this._concurrency = options.concurrency;
  }

  async runSuite(options: {
    suitePath: string;
    trials: number;
    config: EvalConfig;
    signal?: AbortSignal;
  }): Promise<EvalSuiteResult> {
    // 标准实现示例：先加载并完整校验 suite，再创建任何 trial workspace。
    const suite = await this._taskLoader.loadSuite(options.suitePath);

    // TODO 1：根据 concurrency 建固定数量 worker；不得一次启动所有 Promise。
    // TODO 2：每个 trial 调 workspaceFactory，fixture 复制完成后再创建 Agent。
    // TODO 3：区分 Agent failed、timeout 与 grader/fixture infra_error。
    // TODO 4：无论成功失败都保存 patch、trace、grader output；路径必须在 eval root 内。
    // TODO 5：aggregate 时排除 infra_error 的能力分母，同时单独报告其数量。
    // TODO 6：signal 中止后不启动新 trial，等待已启动 trial 清理后持久化部分报告。
  }
}
```

</details>

并发数必须有上限，否则会同时打满 provider rate limit、CPU 和临时磁盘。Agent 内 Tool 并发与 eval task 并发是两个不同层级的并发控制。

### 14.7 保存实验身份

目标文件：`src/eval/types.ts`

每份 report 必须包含：

```ts
export interface EvalRunIdentity {
  evalRunId: string;
  startedAt: string;
  gitCommit: string;
  dirtyWorktree: boolean;
  suite: string;
  suiteVersion: number;
  modelProvider: string;
  modelName: string;
  modelOptions: Record<string, unknown>;
  promptFingerprint: string;
  toolsetFingerprint: string;
  harnessConfig: Record<string, unknown>;
  runtimeVersion: string;
  platform: string;
}
```

不要记录 API key。dirty worktree 可以运行，但报告必须显式标记，避免以后无法复现对应代码。

### 14.8 指标和统计

基础指标：

```text
successRate = passed trials / valid trials
averageSteps
averageToolCalls
invalidToolCallRate
averageInputTokens
averageOutputTokens
averageWallTimeMs
recoverySuccessRate
```

每个 task 多次 trial 时记录 pass@k。至少理解：

- `pass@1` 更接近用户单次运行体验；
- 较高 `pass@k` 说明多次尝试中至少一次成功，不等于稳定性；
- 样本很少的时候，百分点差异不代表真实提升。

报告同时展示原始分子/分母，例如 `17/20 (85%)`，不要只展示百分比。

费用不硬编码在代码中。把 provider/model 的单位价格放入带生效日期的可更新配置；未知价格就只报告 token，不虚构 cost。

### 14.9 Baseline 与 Candidate

评测一项变更时只改变一个主变量。例如 context compaction：

```yaml
baseline:
  context:
    mode: full

candidate:
  context:
    mode: compact
    maxInputTokens: 12000
```

保持以下条件一致：

- model 和 provider；
- model options；
- task/suite version；
- Tool set；
- system prompt；
- trial count；
- 并发和 timeout。

否则无法把结果差异归因到 compaction。

### 14.10 Regression gate

初版只做报告，不要根据 10 个随机任务立刻阻断 CI。积累稳定数据后再配置：

```yaml
gates:
  successRateDropMax: 0.05
  invalidToolCallRateMax: 0.02
  averageInputTokensIncreaseMax: 0.10
```

Runtime conformance tests 可以强制 gate；真实模型 capability eval 更适合 nightly/manual，除非你能控制模型版本和服务稳定性。

### CLI 与输出

```bash
harness-lab eval run evals/suites/smoke.yaml --trials 1
harness-lab eval compare <baseline-id> <candidate-id>
harness-lab eval inspect <eval-run-id> --failed
```

对比表：

```text
Metric                 Baseline       Candidate       Delta
successRate            16/20 80.0%    17/20 85.0%    +5.0pp
avgInputTokens         18,240         11,380          -37.6%
avgSteps               7.3            7.5             +2.7%
invalidToolCallRate    3.1%           2.8%            -0.3pp
avgWallTime            42.1s          40.8s           -3.1%
```

`pp` 是 percentage point，不要把 80% 到 85% 写成“提升 5%”；相对提升是 6.25%。

### 14.11 完整测试

完整测试使用运行时创建的临时 fixture、fake Agent 和内存 artifact store；不会访问真实
模型，也不要求读者维护一份容易过期的固定 fixture。

目标文件：`src/eval/__tests__/task-loader.test.ts`

<details>
<summary>展开完整代码：<code>task-loader.test.ts</code></summary>

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TaskLoader } from "../task-loader";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function taskFixture(id = "fix-add") {
  root = await mkdtemp(join(tmpdir(), "harness-eval-loader-"));
  const taskDir = join(root, "tasks", id);
  await mkdir(join(taskDir, "fixture"), { recursive: true });
  await mkdir(join(root, "suites"), { recursive: true });
  await writeFile(join(taskDir, "prompt.md"), "Fix add.", "utf8");
  await writeFile(join(taskDir, "task.yaml"), [
    `id: ${id}`,
    "version: 1",
    "category: bug-fix",
    "difficulty: easy",
    "timeoutMs: 1000",
    "maxSteps: 5",
    "allowedTools: [read_file]",
    "grader:",
    "  command: bun test",
    "  timeoutMs: 500",
  ].join("\n"), "utf8");
  return { taskDir, loader: new TaskLoader({ evalRoot: root }) };
}

describe("TaskLoader", () => {
  test("loads and validates a complete task", async () => {
    const { taskDir, loader } = await taskFixture();
    expect(await loader.loadTask(taskDir)).toMatchObject({
      id: "fix-add",
      version: 1,
      prompt: "Fix add.",
      allowedTools: ["read_file"],
    });
  });

  test("reports the manifest field path on invalid data", async () => {
    const { taskDir, loader } = await taskFixture();
    await writeFile(join(taskDir, "task.yaml"), "id: fix-add\ntimeoutMs: -1\n", "utf8");
    await expect(loader.loadTask(taskDir)).rejects.toThrow("timeoutMs");
  });

  test("rejects duplicate task ids in a suite", async () => {
    const { loader } = await taskFixture();
    const suitePath = join(root!, "suites", "duplicate.yaml");
    await writeFile(suitePath, [
      "name: duplicate",
      "version: 1",
      "tasks:",
      "  - ../tasks/fix-add",
      "  - ../tasks/fix-add",
    ].join("\n"), "utf8");

    await expect(loader.loadSuite(suitePath)).rejects.toThrow("duplicate");
  });

  test("rejects task paths outside eval root", async () => {
    const { loader } = await taskFixture();
    const suitePath = join(root!, "suites", "escape.yaml");
    await writeFile(suitePath, [
      "name: escape",
      "version: 1",
      "tasks:",
      "  - ../../../outside-task",
    ].join("\n"), "utf8");

    await expect(loader.loadSuite(suitePath)).rejects.toThrow("outside eval root");
  });
});
```

</details>

为使调度测试可读，先完整复制测试专用 harness。

目标文件：`src/eval/__tests__/test-harness.ts`

<details>
<summary>展开完整代码：<code>test-harness.ts</code></summary>

```ts
interface HarnessOptions {
  taskCount?: number;
  delayMs?: number;
  timeoutMs?: number;
  agentError?: Error;
  graderError?: Error;
  onTrialStart?: (params: { index: number }) => void;
}

const ZERO_METRICS = {
  steps: 1,
  modelCalls: 1,
  toolCalls: 0,
  failedToolCalls: 0,
  deniedToolCalls: 0,
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  modelTimeMs: 1,
  toolTimeMs: 0,
  approvalWaitMs: 0,
  wallTimeMs: 1,
};

export function defineEvalTestHarness(options: HarnessOptions = {}) {
  const taskCount = options.taskCount ?? 1;
  let active = 0;
  let maximumActive = 0;
  let started = 0;
  const paths: string[] = [];
  const hashes: string[] = [];
  const savedArtifacts: unknown[] = [];
  const expectedFixtureHash = "fixture-v1";
  const tasks = Array.from({ length: taskCount }, (_, index) => ({
    id: `task-${index}`,
    version: 1,
    prompt: `Task ${index}`,
    fixturePath: `/fixtures/task-${index}`,
    timeoutMs: options.timeoutMs ?? 1000,
    maxSteps: 5,
    allowedTools: ["read_file"],
    grader: { command: "fake-grade", timeoutMs: 100 },
  }));

  const dependencies = {
    taskLoader: {
      loadSuite: async () => ({ name: "fixture-suite", version: 1, tasks }),
    },
    workspaceFactory: {
      create: async ({ task, trial }: { task: { id: string }; trial: number }) => {
        const path = `/tmp/eval-${task.id}-${trial}-${paths.length}`;
        paths.push(path);
        hashes.push(expectedFixtureHash);
        return {
          path,
          initialFixtureHash: expectedFixtureHash,
          cleanup: async () => undefined,
        };
      },
    },
    agentFactory: {
      runTrial: async ({ index, signal }: { index: number; signal?: AbortSignal }) => {
        options.onTrialStart?.({ index });
        started += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          if (options.delayMs) await Bun.sleep(options.delayMs);
          signal?.throwIfAborted();
          if (options.agentError) throw options.agentError;
          return { runId: `run-${index}`, metrics: ZERO_METRICS };
        } finally {
          active -= 1;
        }
      },
    },
    graderRunner: {
      grade: async () => {
        if (options.graderError) throw options.graderError;
        return { passed: true, score: 1, output: "ok" };
      },
    },
    artifactStore: {
      saveTrial: async (artifact: unknown) => {
        savedArtifacts.push(structuredClone(artifact));
        return {
          patchPath: "/reports/patch.diff",
          tracePath: "/reports/trace.jsonl",
        };
      },
    },
    identityProvider: {
      create: async () => ({
        evalRunId: "eval-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        gitCommit: "abc123",
        dirtyWorktree: false,
        suite: "fixture-suite",
        suiteVersion: 1,
        modelProvider: "scripted",
        modelName: "fake",
        modelOptions: {},
        promptFingerprint: "prompt-v1",
        toolsetFingerprint: "tools-v1",
        harnessConfig: {},
        runtimeVersion: "0.1.0",
        platform: "test",
      }),
    },
  };

  return {
    dependencies,
    suitePath: "/evals/suites/fixture.yaml",
    config: {} as never,
    expectedFixtureHash,
    maxActiveTrials: () => maximumActive,
    startedTrialCount: () => started,
    workspacePaths: () => [...paths],
    initialFixtureHashes: () => [...hashes],
    savedArtifacts: () => structuredClone(savedArtifacts),
  };
}
```

</details>

目标文件：`src/eval/__tests__/eval-runner.test.ts`

<details>
<summary>展开完整代码：<code>eval-runner.test.ts</code></summary>

```ts
import { describe, expect, test } from "bun:test";

import { EvalRunner } from "../eval-runner";
import { defineEvalTestHarness } from "./test-harness";

describe("EvalRunner", () => {
  test("never exceeds configured concurrency", async () => {
    const harness = defineEvalTestHarness({ taskCount: 6, delayMs: 20 });
    const runner = new EvalRunner({ ...harness.dependencies, concurrency: 2 });

    await runner.runSuite({ suitePath: harness.suitePath, trials: 1, config: harness.config });
    expect(harness.maxActiveTrials()).toBe(2);
  });

  test("creates a clean fixture copy for every trial", async () => {
    const harness = defineEvalTestHarness({ taskCount: 1 });
    const runner = new EvalRunner({ ...harness.dependencies, concurrency: 1 });

    await runner.runSuite({ suitePath: harness.suitePath, trials: 2, config: harness.config });
    expect(harness.workspacePaths()).toHaveLength(2);
    expect(new Set(harness.workspacePaths()).size).toBe(2);
    expect(harness.initialFixtureHashes()).toEqual([
      harness.expectedFixtureHash,
      harness.expectedFixtureHash,
    ]);
  });

  test("classifies grader crashes as infra_error and still saves artifacts", async () => {
    const harness = defineEvalTestHarness({ graderError: new Error("grader crashed") });
    const runner = new EvalRunner({ ...harness.dependencies, concurrency: 1 });
    const result = await runner.runSuite({
      suitePath: harness.suitePath,
      trials: 1,
      config: harness.config,
    });

    expect(result.trials[0]).toMatchObject({ status: "infra_error" });
    expect(harness.savedArtifacts()).toHaveLength(1);
  });

  test("separates Agent failure and timeout from infrastructure errors", async () => {
    const failed = defineEvalTestHarness({ agentError: new Error("agent failed") });
    const failedResult = await new EvalRunner({
      ...failed.dependencies,
      concurrency: 1,
    }).runSuite({ suitePath: failed.suitePath, trials: 1, config: failed.config });
    expect(failedResult.trials[0]).toMatchObject({ status: "failed" });

    const timedOut = defineEvalTestHarness({ delayMs: 30, timeoutMs: 5 });
    const timeoutResult = await new EvalRunner({
      ...timedOut.dependencies,
      concurrency: 1,
    }).runSuite({ suitePath: timedOut.suitePath, trials: 1, config: timedOut.config });
    expect(timeoutResult.trials[0]).toMatchObject({ status: "timeout" });
  });

  test("does not start new trials after suite abort", async () => {
    const controller = new AbortController();
    const harness = defineEvalTestHarness({
      taskCount: 5,
      onTrialStart: ({ index }) => {
        if (index === 0) controller.abort();
      },
    });
    const runner = new EvalRunner({ ...harness.dependencies, concurrency: 1 });

    await expect(runner.runSuite({
      suitePath: harness.suitePath,
      trials: 1,
      config: harness.config,
      signal: controller.signal,
    })).rejects.toBeDefined();
    expect(harness.startedTrialCount()).toBe(1);
  });

  test("stores identity and excludes infra errors from the capability denominator", async () => {
    const harness = defineEvalTestHarness({ taskCount: 2, graderError: new Error("grader") });
    const runner = new EvalRunner({ ...harness.dependencies, concurrency: 2 });
    const result = await runner.runSuite({
      suitePath: harness.suitePath,
      trials: 1,
      config: harness.config,
    });

    expect(result.identity).toMatchObject({
      evalRunId: "eval-1",
      gitCommit: "abc123",
      suiteVersion: 1,
      toolsetFingerprint: "tools-v1",
    });
    expect(result.aggregate).toMatchObject({ validTrials: 0, infraErrors: 2 });
  });
});
```

</details>

这些测试固定了 schema、path boundary、干净 workspace、timeout、错误分类、并发上限、
abort、artifact、identity 和 aggregate；没有需要读者填写的测试 TODO。

最后执行本阶段的完整测试：

```bash
bun test src/eval
```

### 验收

- [ ] 10 个高质量任务；
- [ ] runtime conformance suite 完全离线；
- [ ] capability eval 每个 trial workspace 隔离；
- [ ] 失败 trial 可通过 trace 和 patch 定位；
- [ ] report 可以复现代码与配置；
- [ ] baseline/candidate 只改变一个主变量；
- [ ] `ADR-016` 解释 deterministic test 与 stochastic eval 的区别。

## 阶段 15：Capstone 与作品集交付

> 上一阶段回顾：阶段 14 建立了隔离运行的 Evaluation Harness、可复现实验身份、指标报告和 baseline/candidate regression gate。

### 15.1 最终项目定义

你的 README 第一屏应在 30 秒内回答：

1. 这是一个什么项目？
2. 它解决什么 Agent 工程问题？
3. 与基础 Helixent 相比新增了什么？
4. 如何运行离线 demo？
5. 如何运行真实模型 demo？
6. 哪些数字证明设计有效？

推荐定位：

> Harness Lab 是一个基于 Bun/TypeScript 的 Coding Agent runtime。项目从统一 transcript 和 ReAct loop 出发，提供并发 Tool 调度、策略审批、结构化 tracing、原子 checkpoint、resume/replay、context compaction 和可复现 eval。

### 15.2 必备文档

一键创建文档文件（已有文件不会被清空）：

```bash
mkdir -p docs/decisions
touch docs/architecture.md docs/security-model.md docs/recovery-semantics.md
touch docs/context-management.md docs/evaluation-methodology.md
touch docs/benchmark-report.md docs/manual-test.md
```

```text
README.md                       # 概述项目定位、运行方式与量化结果
docs/                           # 保存设计、验证与决策文档
├── architecture.md            # 解释分层依赖与一次 run 的数据流
├── security-model.md          # 描述 Tool 权限、审批和信任边界
├── recovery-semantics.md      # 定义 checkpoint、unknown 与恢复语义
├── context-management.md      # 说明预算、分组和 compaction 策略
├── evaluation-methodology.md  # 记录任务、grader 与统计方法
├── benchmark-report.md        # 保存实验身份、结果和限制
├── manual-test.md             # 固化可重复的人工验收步骤
└── decisions/                 # 收纳各阶段 ADR
```

`architecture.md` 画依赖方向和一次 run 数据流；`recovery-semantics.md` 明确 unknown side effect；`benchmark-report.md` 保存实验身份、原始结果和限制。

### 15.3 必备演示

保留三个不会互相替代的 demo：

1. **Offline runtime demo**：scripted provider，展示 loop/concurrency/abort；
2. **Failure recovery demo**：故障注入，展示 checkpoint/resume/replay；
3. **Real coding demo**：真实模型修改 fixture repo，展示审批、trace 和 grader。

录屏控制在 3～5 分钟。不要剪掉审批、失败或 eval 输出，只保留聊天成功结果会掩盖 harness 的真正价值。

### 15.4 发布前 gate

```bash
bun run check
bun run eval:conformance
bun run examples/runtime-demo.ts
bun run examples/recovery-demo.ts
git status --short
```

再从全新目录验证 README 安装步骤。开发机上“因为全局依赖存在而成功”不算可复现。

### 15.5 Benchmark 报告模板

```markdown
# Benchmark Report

## Hypothesis
Context compaction 在不显著降低成功率的情况下减少 input token。

## Controlled variables
- commit: ...
- model/provider: ...
- suite/version: ...
- trials: ...
- toolset fingerprint: ...

## Independent variable
- baseline: full transcript
- candidate: compacted context, maxInputTokens=...

## Results
粘贴原始分子/分母、均值和失败分类。

## Failure analysis
至少分析 3 个失败 trace，不只解释平均值。

## Limitations
样本规模、模型版本漂移、grader 覆盖范围等。

## Decision
接受、拒绝或继续实验，以及原因。
```

### 15.6 简历描述模板

没有数据前使用事实描述：

> 基于 Helixent 架构独立复刻 Bun/TypeScript Coding Agent Harness，实现 canonical Message 协议、流式 ReAct loop、并发 Tool 调度、Middleware、权限审批与多模型适配。

有可复现实验后再加入数字：

> 设计 JSONL tracing 与原子 checkpoint，支持中断恢复和无副作用 replay；通过故障注入覆盖模型返回、Tool 执行和持久化边界，恢复测试通过 X/Y。

> 构建由 N 个隔离 Coding 任务组成的 eval suite；context compaction 将平均输入 token 从 A 降至 B（-C%），成功率从 D/E 变化为 F/G，实验配置和 trace 可复现。

`X/Y/N/A/B...` 必须替换成真实数据。没有测量就删除数字，不使用“显著提升”“大幅优化”等无证据表述。

### 15.7 面试答辩题

项目完成后，脱离代码回答：

1. 为什么 canonical Message 不能直接使用 OpenAI SDK type？
2. 为什么 Tool result 应按完成顺序反馈？
3. `Promise.all` 与 pending-set `Promise.race` 的用户体验差异是什么？
4. 为什么 Tool failure 通常是 observation，而不是 run failure？
5. Middleware 为什么不能承担所有 tracing？
6. trace、checkpoint 和 replay 分别服务什么目标？
7. 为什么任意 `bash` 无法保证 exactly-once recovery？
8. context compaction 如何保证 Tool call/result 配对？
9. 为什么完整 transcript 和本次 Model view 要分离？
10. 哪些错误可以 retry，哪些不能？
11. 为什么修改型 Tool 默认不能自动 retry？
12. 如何证明一个 prompt/context 改动真的更好？
13. eval 的 infra error 为什么不能计入任务失败？
14. 你的 benchmark 中最大的不确定性是什么？
15. 如果增加 multi-agent，会新增哪些状态、权限和评测问题？

无法清晰回答的问题，就是下一轮应该回到代码和 ADR 深挖的地方。

### 15.8 最终 Definition of Done

- [ ] 基础能力由离线 scripted tests 覆盖；
- [ ] 真实模型只是 adapter，不侵入 Agent runtime；
- [ ] 每个副作用都经过 Tool 和 Policy；
- [ ] 每个 run 都能 trace；
- [ ] crash 后可以 inspect 并按明确语义 resume；
- [ ] replay 不调用 model/Tool；
- [ ] context view 在预算内且不破坏 call/result pairing；
- [ ] eval fixture 隔离、grader 可复现；
- [ ] benchmark 包含失败分析和限制；
- [ ] README 明确标注 Helixent 来源和你的扩展；
- [ ] 创建 `v1.0.0` tag。

完成这些条件后，项目目标——“一个可观测、可恢复、可评测的 Coding Agent Harness”——才算真正闭环。
