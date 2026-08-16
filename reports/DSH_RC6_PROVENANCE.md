# DSH `0.1.0-rc.6` 发布溯源（2026-08-16）

## 结论

截至 2026-08-16，DeepSeek Harness 的公开发布面出现了一个容易误判的版本错位：npm 上 `@deepseek-ai/dsh` 的 `latest` 与 `next` 都已指向 `0.1.0-rc.6`，但 GitHub `master` 仍停在提交 [`47f943859bef60e4160492346772ded9b24f765a`](https://github.com/deepseek-ai/deepseek-harness/tree/47f943859bef60e4160492346772ded9b24f765a)，未发现 tag、release 或新增公开 branch。

对与本研究直接相关的发布物做逐字节比较后，**没有观察到 rc.6 在 CLI 的全部 5 个已发布 runtime JS 文件、四个内置 preset，或五个核心包的全部已发布 runtime JS 文件中引入代码变化**。可见差异集中在发布 manifest：版本号由 `0.1.0-rc.5` 更新为 `0.1.0-rc.6`，内部依赖由 monorepo 的 `workspace:^` 写法改写为 npm 可解析的 semver。

因此，把 rc.6 称为“DSH 大版本代码更新”目前没有证据支持；更准确的描述是：**npm 发布版本前移，而抽样核对到的运行时内容仍对应现有 GitHub `master` 构建。**

## 注册表与仓库状态

| 检查面 | 2026-08-16 观察值 |
|---|---|
| GitHub `master` | `47f943859bef60e4160492346772ded9b24f765a` |
| GitHub tags | 未发现 |
| GitHub releases | 未发现 |
| GitHub branches | 未发现 `master` 之外的新公开 branch |
| npm `latest` | `0.1.0-rc.6` |
| npm `next` | `0.1.0-rc.6` |
| npm 发布时间 | `2026-08-13T12:35:03.812Z` |
| CLI tarball SRI | `sha512-brpZfED7ieRa2PQ5tUxMhHrM1pb2CmKFVM/f6yMULBDMicahk+Z2OsHgTwTDnoiZm23Ftu9rQz0NN4pflaoJcg==` |

## 字节比较范围

本次下载 npm 的 rc.6 tarball，并与提交 `47f943859bef...` 的本地构建产物比较。核对范围为：

- `@deepseek-ai/dsh`：全部 5 个已发布 runtime JS 文件，即 `lib/bin.js` 与 4 个带内容 hash 名称的 bundle chunk；
- CLI 随包发布的四个 preset：`code`、`cordis`、`minimal`、`standard`，共 10 个配置/skill 文件；
- `@deepseek-ai/dsh-agent-presets`：全部 11 个已发布 runtime JS 文件；
- `@deepseek-ai/dsh-llm-deepseek`：全部 2 个已发布 runtime JS 文件；
- `@deepseek-ai/dsh-agent-loop`：全部 2 个已发布 runtime JS 文件；
- `@deepseek-ai/dsh-tool-bash`：全部 2 个已发布 runtime JS 文件；
- `@deepseek-ai/dsh-tool-bash-persistent`：全部 2 个已发布 runtime JS 文件。

以上 34 个 runtime JS／preset 文件均逐字节相同，且 rc.6 中没有已发布 runtime JS 文件在对应本地构建目录缺失。manifest 比较则观察到 `rc.5 → rc.6` 的版本更新，以及内部依赖从 `workspace:^` 到已发布 npm semver 的转换；这类转换符合打包/发布阶段的 manifest 重写，不能单独证明源码或运行时逻辑发生变化。

## 证据边界

- 这是针对 CLI、四个 preset 和五个与当前 schema 研究直接相关包的定向审计，不是对 monorepo 统计口径下全部 221 个包的穷举证明。
- 比较覆盖上述六个包的全部已发布 runtime JS，但不自动证明其余未抽样包、平台相关二进制、安装脚本、类型声明或文档也相同。
- “无 tag/release/新 branch”是 2026-08-16 查询时点的公开 GitHub 状态，不排除未公开提交、后续推送或 npm 发布流程中的私有构建输入。
- 所有 npm 与 GitHub 操作均为只读查询和发布物下载；没有发布、修改或删除远端内容。

这意味着现有实验可继续把 `47f943859bef...` 作为所核对组件的源码基线，但若正式联网复现实验使用 npm CLI，应同时记录 `@deepseek-ai/dsh@0.1.0-rc.6`、tarball integrity 与实际请求 schema hash，避免仅凭 Git commit 或 CLI 显示版本推断运行时身份。
