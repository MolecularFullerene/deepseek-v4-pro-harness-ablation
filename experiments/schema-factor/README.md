# 首请求 2×2 schema 因子消融

这个独立实验把首请求的 system、context 和工具数量锁死，只改变两个 schema 因子：

| preset 源目录 | 因子 A：`bash` schema | 因子 B：文件工具 schema | 首请求工具名 |
| --- | --- | --- | --- |
| `persistent-editor` | 官方 Minimal persistent bash | `str_replace_editor` | `bash`, `str_replace_editor` |
| `persistent-read` | 官方 Minimal persistent bash | Standard `read` | `bash`, `read` |
| `oneshot-editor` | Standard one-shot bash | `str_replace_editor` | `bash`, `str_replace_editor` |
| `oneshot-read` | Standard one-shot bash | Standard `read` | `bash`, `read` |

四格都使用官方 Minimal 的 complete persona：`You are a helpful software engineer assistant.`，关闭 runtime context；首请求过滤器强制 `contexts=[]` 和恰好两个真实 DSH tool schemas。`read` 格会在底层注册 Standard 文件工具插件，但首请求只暴露其真实 `read` schema。过滤器只约束首次 durable `tool/call` 之前；这个 smoke 完全不执行工具，也不发 API 请求。

## 离线真实 DSH smoke

从 `dsh-lab-cli` 目录运行：

```sh
node experiments/schema-factor/smoke.mjs
```

它会为四格分别启动真实 DSH headless、挂载 AgentPresets，并调用真实 `system-prompt.assemble({ scope: agent, agent })`。默认结果写到 `artifacts/latest.json`，每个工具只保存：

- header-equivalent `{name, description, parameters}` 的 SHA-256 与字符数；
- description 的 SHA-256 与字符数；
- parameters 的 SHA-256 与字符数。

artifact 还会验证 system 四格一致、context 全为 0、工具数全为 2、同一 schema 跨另一因子保持一致，以及 persistent/one-shot `bash` schema 确实不同。可用 `--out PATH` 或 `--harness-root PATH` 覆盖路径。

## 后续接入主 CLI

本目录没有修改现有策略表或 CLI。接入时可把四个自包含目录复制到临时 `$DSH_HOME/.agent-presets/`，分别命名为 `schema-factor-persistent-editor`、`schema-factor-persistent-read`、`schema-factor-oneshot-editor`、`schema-factor-oneshot-read`，再在策略表中把这四个 preset id 注册为实验策略。Live 阶段应继续使用主 CLI 的 stdin credential、固定 batch identity、随机交错、事件级输出和脱敏逻辑；本 smoke runner 只用于无 API 的 schema 验证。

当前组合只定义 POSIX `bash` 两种 schema；Windows/pwsh 不属于这个因子实验，不能把本结果称为 Windows 复现。
