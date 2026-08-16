# Schema bridge live protocol

`schema-bridge-live-v1` 是一个预注册、只读、diagnostic-only 的真实 Agent
首响应实验。它固定真实注册的 persistent `bash` executor，只交叉模型可见的
`bash.description` 与 `bash.parameters`；`str_replace_editor`、Minimal system
prompt、工具顺序和执行器均保持不变。主要终点是首个 assistant trajectory 的
`minimal-like` 词法风格标签，不代表任务能力、回答质量或模型内部机制。

正式联网前冻结的设计、停止规则和统计终点见
[`PREREGISTRATION.md`](./PREREGISTRATION.md)。

原始 artifact 含模型 trajectory 和运行标识，**禁止发布**。只能发布本目录严格
scorer 生成的 allowlisted summary；详见[发布边界](#发布边界)。

## 四个实验臂

所有臂都注册同一个 official persistent `bash` executor，并在任何工具执行前停止。
字母顺序为 `description × parameters`：

| arm | strategy | description | parameters |
| --- | --- | --- | --- |
| `pp` | `schema-bridge-pp` | persistent | persistent |
| `po` | `schema-bridge-po` | persistent | one-shot |
| `op` | `schema-bridge-op` | one-shot | persistent |
| `oo` | `schema-bridge-oo` | one-shot | one-shot |

每次 request assembly 和最终 `llm/stream` 边界都会检查固定 system SHA-256、
`bash, str_replace_editor` 顺序及逐工具 raw schema SHA-256。bridge preset 同时安装
单调拒绝的 tool guard 和 prepend `tools/execute` tripwire；runner 在第一条
`assistant/message` 同步发布时取消，因此模型产生的 tool call 只能得到
`ABORTED_BEFORE_DISPATCH`，不得进入 executor。

## 冻结协议

规范来源是 [`oracle.json`](./oracle.json)，并由代码中的 canonical SHA-256
`02cd87c686ce4385d2413f0a0d3bba4bf4df7b3d6b4c0c0544a3e96fedd97821`
绑定。命令拒绝字段、数值、prompt 顺序、classifier bytes 或 seed-derived plan 的
任何漂移。固定项包括：

- provider/model/base URL：`deepseek-official` / `deepseek-v4-pro` /
  `https://api.deepseek.com`；
- Harness commit：`47f943859bef60e4160492346772ded9b24f765a`，平台：
  `darwin-arm64`；Harness 与本研究仓的 Git-visible worktree（含非 ignored
  untracked 文件）必须干净；
- `reasoningEffort=max`、temperature 为 `null`（请求中省略）、`maxTokens=768`、
  单进程 timeout `900000 ms`；
- `capture=trajectory`、`permissionMode=read-only`、第一条 assistant 后停止；
- bridge job 的生成 patch 明确禁用 `llm-retry`，每个已接受 observation 还必须满足
  `retryCount=0`、恰好一个 request header 和恰好一条 assistant message；
- 1 个冻结 pilot prompt、10 个冻结主任务（5 English、5 Chinese）、4 个固定
  runtime-home identity；prompt 和 classifier 均由 oracle 中的 SHA-256 绑定。

运行凭据仅由 `--api-key-stdin` 读取，再经 child stdin 传入；不得放入 argv、环境、
patch 或 artifact。所有 oracle、prompt、classifier、Git、Harness mount 和输出路径
检查均在读取凭据前完成。通过 keyless preflight 后，runner 先以 `0600`、禁止覆盖
的方式写入完整 planned artifact，再读取凭据。

正式 bridge 子进程使用 `minimal-allowlist` 环境，只继承进程启动和 locale 所需的
少量固定键，并把 `HOME`/XDG/DSH home 显式指向本次私有 runtime home。它不继承
`NODE_OPTIONS`/`NODE_PATH`、代理、证书覆盖、云凭据、SSH agent 或 ambient
`DSH_*`/`DEEPSEEK_*` 配置；实际 route 与 DSH 配置由 launcher 的字面固定值注入。

## 命令门控

从仓库根目录运行：

```sh
node src/cli.mjs schema-bridge-live \
  --oracle experiments/schema-bridge-live/oracle.json \
  --out runs/schema-bridge-live/PRIVATE_RAW.json \
  --api-key-stdin \
  --allow-network \
  --max-tokens 768
```

`--out` 必须尚不存在。若路径位于本仓内，它必须位于
`runs/schema-bridge-live/` 下；也可以使用仓外私有路径。命令等待 stdin 输入凭据；
请交互式输入并结束 stdin，不要把 key 写进命令行、脚本或文件。

专用命令强制使用上述 route、workspace、read-only、trajectory、fixed identity、
first-assistant stop、timeout 和采样参数；除必须显式给出的 `--max-tokens 768` 外，
这些固定值不接受重复的 generic override，即使所给值碰巧相同。它拒绝 generic
sampling 或调试入口，包括 `--strategy`、`--task`/`--task-file`、`--seed`、显式 `--repeat`/`--order`、
`--fixture`、`--mock-script`、`--pilot-only`、`--dry-run`、`--keep-runtime`，以及
任何显式 generic route/runtime/allocation override；平台仍必须与 oracle 相同。
`--api-key-stdin`、`--allow-network` 和
`--max-tokens 768` 必须显式给出。

generic `run --strategy schema-bridge-*` 也不能绕过安全边界：它在 manifest 写入和
凭据读取前 fail-closed，禁止与非 bridge strategy 混用，并要求所有固定运行控制、
固定 Harness commit 和干净 Git-visible Harness worktree。不过 generic `run` 不生成
预注册的 4+160 allocation，也不产生本 scorer 接受的完整 artifact；正式协议必须
使用 `schema-bridge-live` 专用命令。

## 164 次 attempt 上限与身份语义

keyless preflight 会为四个臂各启动一次真实 DSH mount，用来验证平台、commit、
system 和工具 schema；mount 不发 provider HTTP 请求，不计入 164 次上限。

联网阶段的冻结上限是 `4 pilot + 160 main = 164` 个 model attempt：

1. pilot 对四个臂各运行一次，并让四个固定 identity 各贡献一次；只有四格全部满足
   protocol/surface/one-assistant/no-retry/no-dispatch gate 才进入主样本。pilot gate
   明确忽略词法 classifier 标签；失败时不发送任何 main request。
2. 主样本为 `10 tasks × 4 identities × 4 arms = 160`。失败或 aborted unit 保留在
   原位置，绝不 retry、replace 或追加样本。
3. 每个 unit 都启动一个全新的 DSH 子进程和全新的 session。每个 identity 在整个
   协议内复用自己的固定 runtime home，以稳定 anonymous user identity；四个 home
   必须互不相同。成功 artifact 必须证明 164 个 session/run id 均唯一、每个 home
   恰好贡献 1 个 pilot 和 40 个 main unit。
4. bridge plugin 在每个新进程内禁止第二次 `llm/stream`，生成 patch 禁用
   `llm-retry`。completed artifact 必须恰有 164 个已接受 unit、164 个 logical model
   request header、164 条 assistant message、0 retry、0 executor dispatch。

临时 runtime homes 在 terminal artifact 写入前删除。任何主样本单元失败都会使整份
artifact 终态为 `aborted`；scorer 只接受完整且全部通过的 `completed` artifact。
从命令入口到收尾收到 `SIGINT`、`SIGTERM` 或 `SIGHUP` 时，runner 会先中止当前
preflight/live child（有限 `SIGTERM` grace 后强制 `SIGKILL`），再删除临时 mount
runtime、四个 identity home 与 protocol snapshot，并以非零状态退出。若 planned raw
尚未创建则不伪造 artifact；若已经创建则写入 `runner-failed` terminal artifact。
signal listener 在收尾后全部移除；第二个终止信号会恢复操作系统默认强制退出。

keyless preflight 还会把 bridge preset、credential pipe 和 lab runner 一次性复制到
私有 protocol snapshot，并把整个 closure digest 冻进 oracle/config/artifact。四次
mount 与后续 164 个 unit 都只从该 snapshot stage；每个 unit 在 provider call 前再次
核对 research HEAD/status 与 snapshot digest。任何中途漂移会把该 unit 原位标为
aborted，不发送 provider request、不 retry、不 replacement。snapshot 与四个 runtime
home 一样在 terminal seal 前删除。

## Task-level Latin 随机化与检验

完整 allocation 在凭据输入前由固定 design seed
`schema-bridge-live-main-20260816-v1` 生成并哈希：

- 每个 task 独立 seeded-shuffle 四个 arm，得到该 task 的 Latin base；
- 四个 identity 分别使用该 base 的 0、1、2、3 位循环移位。因此在同一个 task 内，
  每个 arm 在四个 identity 中恰好各占一次 position 1、2、3、4；
- 每个 `identity × task` 构成一个含四臂的 block，四次调用必须连续执行；40 个完整
  block 再用固定 seed 做一次 shuffle，不在 block 内插入其他 identity/task；
- validator 不仅检查平衡和连续性，还重新生成 seed-derived plan 并要求 canonical
  JSON 完全相同。

主要统计量基于 main 样本各臂的 `minimal-like` rate：

- `D = 0.5 × ((OP + OO) - (PP + PO))`：one-shot description 减 persistent；
- `Q = 0.5 × ((PO + OO) - (PP + OP))`：one-shot parameter schema 减 persistent；
- `I = OO - OP - PO + PP`：factorial interaction。

两侧 Monte Carlo randomization test 使用 analysis seed
`schema-bridge-live-analysis-20260816-v1` 做 100,000 draws。每一 draw 都在**每个
task 内**重新随机一条四臂 Latin base，再对四个 identity 使用同样的循环移位，把
固定的 position outcomes 重新赋给 arms；它不是逐 observation 的任意置换。p 值以
`(|T*| >= |Tobs|)` 计数并作 `(count + 1) / (draws + 1)` 修正。`D/Q/I` 使用 Holm
方法控制 familywise alpha 0.05。`OP-PO` 是 family 外的 secondary contrast。

95% 区间来自 20,000 draws 的 task-cluster bootstrap：每次从 10 个 task 中有放回
抽取 10 个完整 cluster，并保留被抽 task 的全部 16 个 observation；不在 task 内
逐行重抽。报告 2.5%/97.5% percentile interval，且明确只作 descriptive uncertainty。

## 发布边界

原始 artifact 是私有工作文件，即使运行成功也**不得发布、上传、粘贴或作为附件
分发**。它可包含 assistant reasoning/text、模型生成的 tool arguments、tool/event
payload、identity/session/request/call 标识或其 hash、绝对路径和逐请求时间。
文件以 `0600` 写入且禁止覆盖；这些权限是本地防护，不改变“不得发布”的规则。

只允许用本目录 scorer 生成新的 allowlisted summary：

```sh
node experiments/schema-bridge-live/score-artifact.mjs \
  --artifact runs/schema-bridge-live/PRIVATE_RAW.json \
  --oracle experiments/schema-bridge-live/oracle.json \
  --out PUBLIC_SUMMARY.json
```

scorer 拒绝覆盖已有输出，并重新验证 oracle、prompts、classifier、完整 seed-derived
plan、artifact integrity、四次 preflight、全部 164 个 observation、身份/session
约束和零 dispatch。其输出仅含预先 allowlist 的 provenance、聚合统计、去标识主要
label matrix 和不含绝对路径的 publication policy。matrix 的 task/row/block ordinal
由公开 analysis seed 可重建，因此只是去除了真实 runtime 标识与原文，**不是密码学
匿名化**；其中公开 design identity pseudonym 不映射 request header 的真实 identity。
**允许发布的是 scorer 输出，
不是 raw artifact，也不是 raw artifact 的删节版或手工摘要。**

summary 中允许的 `rawArtifactIntegritySha256` 仅用于确认私有 raw 文件内部自洽及结果
对账；它不是 provider 签名，也不能证明作者没有整体重写 raw response 后重新封装。
strict scorer 能发现字段间矛盾和不满足冻结协议的内容，但不提供外部真实性证明。

## 已知 provenance 局限

Harness commit 和 clean-worktree 检查只证明 Git **tracked** bytes 对应
`47f943859bef60e4160492346772ded9b24f765a`。实际运行还会使用被 Harness
`.gitignore` 忽略的生成物和依赖，包括 `apps/cli/lib/`、其他 package `lib/` 以及
`node_modules/`；当前协议只检查它们是否足以运行，并未对整个 runtime closure 做
固定 digest、签名、可复现构建证明或二进制 attestation。因此，**这些 ignored
Harness `lib`/`node_modules` bytes 没有被密码学证明是由所报告 commit 构建或安装
得到的**。

模型可见 system/tool raw SHA-256、request config、事件计数和零 dispatch 检查能发现
一部分有实验意义的漂移，但不能弥补上述代码/依赖 provenance 缺口；对结果的
commit 归因必须保留这一限定。
