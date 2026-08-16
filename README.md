# DeepSeek V4 Pro Harness Ablation Lab

用于比较 DeepSeek Harness agent preset 的精简命令行实验器与去标识化研究记录。它启动**真实 DSH headless、AgentPresets、agent loop、工具执行与持久事件链**，不是 `modeltest/evaluator/trigger_probe` 那类直接拼 Chat Completions 请求的探针。

第三方仓库保持只读。每次实验通过临时 patch 挂载独立 runner；结果从 `request/header`、`assistant/message`、`tool/call`、`tool/result` 和 `turn/end` 等持久事件生成。

## 主要结果

- 预注册的 schema-bridge 2×2 中，四臂 minimal-like 比例为 65.0%、52.5%、
  35.0%、22.5%。one-shot description 相对 persistent description 的主效应为
  −30.0 个百分点（Holm-adjusted `p = 0.000330`）；parameters 主效应与交互均未
  通过确认性检验。终点仅为词法轨迹标签，不是能力分数。
- 固定样本量首请求 2×2 消融中，persistent shell schema bundle 为
  17/20 minimal-like，one-shot shell 为 6/20；file-tool 主效应证据弱。
- 40/40 首动作均合法且任务相关，因此 `We need / Let me` 只能作为轨迹
  指纹，不能当作能力开关。
- request #2 protocol pilot 的 retain/drop reasoning × same/new session 四格
  均被 API 接受且简单答案正确，但每格仅 n=1，不能据此宣称复杂任务无效应。
- 历史 Project2 98/99 对应 legacy Windows `pwsh/read → 25 tools`，不是后来
  加入的 exact-Minimal pair；本项目不把历史分数归因给当前实现。

公开数据仅保留分格计数、token 汇总与效应量；不包含真实 API key、完整模型
reasoning、真实 API request body、真实 user/session id 或其稳定 hash、绝对路径、
Project2 题面与隐藏测试内容。详见 [`data/`](./data/) 与
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)。

## 准备

实验器按下列 sibling checkout 布局解析官方 Harness 与社区 preset；仓库目录本身
可以任意改名。只运行 `standard` / `minimal` 与内置 2×2 cells 时，除本仓库外只
需要 `deepseek-harness`。`historical-anchored`、其余社区策略和 screening 分析器
分别需要相应的只读 sibling checkout。

```text
workspace/
├── deepseek-v4-pro-harness-ablation/   # 本仓库，名称可变
├── deepseek-harness/                    # 47f943859bef...
├── modeltest/                           # 04255b55f16c...
├── dsh-anchored-standard/               # db4527a2a70a...
├── dsh-minimal-anchored/                # d27e4df2f635...
└── dsh-router-standard/                 # f9667f72d45e...
```

报告对应上述固定提交；社区仓库的新版本应作为新的实验条件记录，不能静默继承
这里的结果。`scripts/analyze-screening.mjs` 从 sibling `modeltest` 导入分类器，
本仓库没有复制其源码。

执行 live 或 mount smoke 前，在固定 lockfile 下准备官方 Harness：

```sh
cd ../deepseek-harness
pnpm install --frozen-lockfile
pnpm run build:lib
```

不要修改 lockfile。随后检查：

```sh
cd ../deepseek-v4-pro-harness-ablation
node src/cli.mjs doctor
```

完全离线且本地 store 已缓存完整依赖时，可使用仓库内已审计的 lockfile 跳过需要 registry metadata 的 trust-policy 查询：`pnpm install --offline --frozen-lockfile --trust-lockfile`。本工作区已安装锁定依赖并执行过 `build:lib`；这些都是 ignored 生成物，第三方仓库源码与 lockfile 没有改动。

`doctor` 不读取、显示或枚举环境变量。

## 策略

```sh
node src/cli.mjs list
```

默认 `all` 只包含可用或有明确平台限定的四条基线：

- `standard`：官方 Standard。
- `minimal`：官方精确 RL Minimal（persistent `bash` + `str_replace_editor`）。
- `historical-anchored`：`modeltest` 中冻结的 2026-08-14 `shell/read → 25 tools` 版本，也就是 98/99 实际对应的配置。
- `anchored-standard`：当前 exact-Minimal bootstrap → 小型 resident 目录版本。

平台限定很重要：98/99 是 Windows 原生的 `pwsh/read` 结果。本机是 macOS arm64，`historical-anchored` 会组装为 `bash/read`；CLI 会把实际首请求目录、平台和 `historicalWindowsReproduction: false` 写进结果，绝不会把它标成 98/99 的完整复现。

`minimal-anchored`、`router-standard` 和 `router-spec` 也可显式选择，但不进入默认集合。当前 checkout 的 `minimal-anchored` 已由真实 mount smoke 证实不可用：persistent 与 Standard `bash` 在同一 scope 重名注册（Windows 另有 inspector 兼容问题）。两个 router 可以挂载，但 live 插件在首条真实 `user/message` 上调用了未导入的 `extractText`；`router-spec` 的首轮目录还随任务分类变化，因此 task-free smoke 不宣称固定预期。批处理会记录单项失败并继续剩余任务。

另有四条 `schema-bridge-{pp,po,op,oo}` 诊断策略，在固定真实 persistent
executor 的同时，只交叉替换 model-visible `bash` description 与 parameters。
它们有 guard 与 dispatch tripwire，禁止执行任何工具，只能用于首响应轨迹消融；
不能用于端到端能力测试。设计与 schema hash 见
[`experiments/schema-bridge/`](./experiments/schema-bridge/README.md)。

已完成的正式联网采样使用独立的 guarded `schema-bridge-live` 命令与冻结 oracle；
它不是通用 bridge batch。4-cell pilot、10-task × 4-identity × 4-arm allocation、
只读/零 dispatch 安全边界、publication-only scorer 和 `network-v1` 结果见
[`experiments/schema-bridge-live/`](./experiments/schema-bridge-live/README.md)。

## 无 API 的 mount smoke

这会实际启动 DSH、挂载 preset，并经过 `system-prompt/assemble` 读取首请求工具面，不调用模型：

```sh
node src/cli.mjs smoke \
  --strategy all-known \
  --order grouped \
  --out ./runs/mount-smoke
```

应先用它确认某个社区 preset 在当前平台和当前 DSH commit 上能否装载。

## Live 实验

从调用者环境读取 key：

```sh
node src/cli.mjs run \
  --strategy all \
  --task-file ./prompt.txt \
  --model deepseek-v4-pro \
  --reasoning-effort max \
  --repeat 5 \
  --seed project2-v1 \
  --out ./runs/project2-v1
```

一次性 key 推荐走 stdin：

```sh
node src/cli.mjs run --api-key-stdin --strategy minimal --task-file ./prompt.txt
```

命令会等待 stdin 到 EOF。请交互式粘贴 key 后结束输入；不要用 `--api-key VALUE`（该选项有意不存在），也不要把 key 拼进 shell 管道、重定向文件或命令行。

常用控制项见 `node src/cli.mjs help`，包括 `--temperature`、`--max-tokens`、`--capture`、`--permission-mode`、`--timeout-ms` 和 `--stop-after-first-assistant`。

`--stop-after-first-assistant` 在 `assistant/message` 被持久化、任何工具开始执行之前同步取消；含工具调用的回复只会得到 Harness 生成的 skipped result，不会进入 executor。这适合低成本首轮探针，也避免探针意外修改测试工作区。

## 批次与身份控制

`--repeat N` 会为每个策略启动 N 个新 DSH 进程与新 session。默认 `--order random`，顺序由 manifest 中的 seed 确定；`--order grouped` 可关闭交错。

同一 batch 默认使用 `--identity fixed`：共享一个临时 DSH home，因此 outbound `x-deepseek-harness-user-id` 保持稳定，只更换 session id。这避免把服务端按 user-id 的 A/B／路由差异混进 preset 对照。`--identity rotate` 明确用于每次更换 user-id 的消融。

结果只保存 anonymous user id 和 session id 的 SHA-256，不保存原值。临时 DSH home 默认在 batch 结束后删除；`--keep-runtime` 会保留含完整 session JSONL 的目录，仅用于本地调试。

## 输出与脱敏

每个 batch 产生一个 `batch.json` 和每次运行一个 JSON 文件。它们包含：

- public config fingerprint、时间、commit、preset 文件摘要、模型和 base URL；
- 每次完整 `request/header` 的 config、adapter defaults、工具名与 schema 摘要；
- reasoning/text、token usage、tool call、tool result 摘要、晋升事件序号和退出状态；
- 预期与实际首请求工具面，以及平台限定判定。

默认 `trajectory` 保留模型 reasoning/text 和模型生成的 tool arguments，但 system prompt／tool results 只保存摘要；`summary` 更克制，`full` 会保存 system、完整 schemas 和 tool results，可能包含代码或工作区内容。

密钥链路采用以下约束：

1. 父 CLI 从 `DEEPSEEK_API_KEY` 或显式 `--api-key-stdin` 读取一次；
2. 启动 DSH 前移除子进程环境中的 credential-like 变量；
3. key 仅通过匿名 stdin pipe 传给只读内存 CredentialProvider；
4. 官方 file/env CredentialProvider 在临时 patch 中禁用；
5. key 不进入 argv、Cordis YAML、`.env`、`.credentials.yaml`、结果 JSON 或 session shell 环境；
6. 捕获的 stdout/stderr 还会按 exact key 与 Authorization/Bearer 形式二次脱敏。

离线测试使用 canary key 验证 argv、子环境、stdout/stderr 和 dry-run 文件均不含 key：

```sh
npm test
```

## 一个优先级很高的因果混杂

官方 DeepSeek serializer 只在 assistant 同时含有 tool calls 时，把该轮完整 `reasoning_content` 回传给下一次请求；纯文本首答不会回传 reasoning。历史 anchored 首轮通常正好产生 tool call，因此后续“轨迹保持”可能来自显式 in-context CoT 自激，而不一定是服务端隐藏 mode 被锁定。

报告已为每条 assistant message 写入 `reasoningPassbackEligible`，可直接判断该轮是否满足官方回传条件，并同时保存首轮 reasoning 与 tool call。现已另行实现 adapter 边界的 request2 因果探针；它不能从现有 anchored 分数中直接排除完整 Agent 生命周期的其他影响。

### Request2 transport replay

`request2-replay` 是完全离线的四格 serializer 证明；`request2-live-replay` 则使用真实官方 `DeepSeekAdapter` transport，但明确不是 Agent/Session fork。后者采用独立 request1 source 的区组随机设计：每个 source 只 live 发送 `retain/drop reasoning × same/new session` 中预先分配的一格，避免把四格顺序写进同一个可能有状态的服务端 session。默认每格 3 次；主样本前另跑四个独立 source 的完整 protocol pilot。四格全成功才进入主样本；只有两个 retain 控制成功且 drop cell 出现 HTTP 400，才归类为 drop 协议拒绝，其余失败均不可识别。首次联网应加 `--pilot-only`，通过后也不会自动进入主样本。

live 命令强制 `--api-key-stdin`，不会回退到任何 key 环境变量；无 `--mock-script` 时还必须显式给出 `--allow-network`。fixture 的 system 与 persistent `bash` / `str_replace_editor` 完整 schemas 来自真实官方 Minimal mount，不是手工近似；命令会在读取 key 前重新做一次 keyless real mount，逐字/逐 schema/逐 SHA/commit/platform 断言相等。随后才写入 0600 planned manifest，冻结 seed、区组顺序、样本量、session identity hash、停止规则和 `expectedJson`。第二轮的协议成功与答案正确分开报告；答案通过“提取唯一 JSON 对象 + 与预注册 expectedJson 字段/值完全相等”机械评分，`We need` / `Let me` 只作诊断。`--oracle PATH` 用于严格验证并绑定本仓 v2 机械评分 oracle；它会在读取凭据和发送请求前，把 oracle 的 canonical SHA-256 一并冻结进 manifest 与 config fingerprint。

完整 mock/live 用法、安全边界和输出字段见 `experiments/request2-live-replay/README.md`。
更具区分力的只读两阶段 tool-routing fixture、严格 artifact validator 与补充 scorer
见 [`experiments/request2-live-replay-v2/`](./experiments/request2-live-replay-v2/README.md)；
其冻结 network-v1 已完成：12 个主样本全部 protocol-success，11/12 精确命中目标
tool/arguments；结果、限制和 publication boundary 见
[`network-v1/RESULTS.md`](./experiments/request2-live-replay-v2/results/network-v1/RESULTS.md)。

## 当前实验报告

- [`experiments/schema-bridge-live/results/network-v1/RESULTS.md`](./experiments/schema-bridge-live/results/network-v1/RESULTS.md)：
  固定 executor 的 description × parameters 四臂预注册消融；只有 description
  bundle 主效应通过 Holm 校正后的确认性检验。
- [`reports/SCREENING_REPORT.md`](./reports/SCREENING_REPORT.md)：官方 exact Minimal 与本机历史 `bash/read` surrogate 的首请求筛查。
- [`reports/FACTORIAL_REPORT.md`](./reports/FACTORIAL_REPORT.md)：persistent/one-shot `bash` × editor/read 的固定样本量 2×2 消融；shell schema bundle 是本轮词法轨迹偏移中最大的观测边际关联。
- [`reports/REQUEST2_PILOT_REPORT.md`](./reports/REQUEST2_PILOT_REPORT.md)：retain/drop reasoning × same/new session 的四格独立-source live protocol pilot；四格均被 API 接受且简单答案正确，主样本未自动启动。
- [`reports/DSH_RC6_PROVENANCE.md`](./reports/DSH_RC6_PROVENANCE.md)：npm `0.1.0-rc.6` 与 GitHub `47f9438` 的发布溯源及逐字节抽样比较；所核对运行时文件未观察到代码变化。

## 限制

- 这是研究工具，不为损坏的社区 preset 静默打补丁；源码失败本身就是结果。
- macOS 上没有 `pwsh`，不会安装，也不会用 schema-only 仿真冒充 Windows 工具执行。
- `--permission-mode danger-full-access` 会扩大工具权限，必须只对明确准备的测试工作区使用。
- 默认禁用 DSH telemetry 和额外的 LLM session-title 调用，避免额外请求污染计数。

## 归属

实验运行与公开结论由 `MolecularFullerene` 复核。实验器实现、统计复核与
报告整理由 OpenAI Codex 辅助。项目代码采用 MIT License；复用或改编的
DeepSeek Harness 内容保留其 MIT notice。
