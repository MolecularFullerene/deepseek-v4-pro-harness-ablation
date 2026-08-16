# Request #2 reasoning × session-id raw replay

这是一个明确受限的 **raw official-adapter replay**，不是完整 DSH Agent fork。它从同一份冻结的首轮 tool-call response/history 构造 request #2 的四格：

| | 原 session id | 新 session id |
| --- | --- | --- |
| 保留首轮 reasoning | `retain-same` | `retain-new` |
| 删除首轮 reasoning | `drop-same` | `drop-new` |

四格都通过当前 checkout 的真实 `DeepSeekAdapter` 与其内置 serializer；`fetch` 被进程内 mock 截获，因此没有网络 I/O。Adapter 的 credential resolver 只返回代码内固定的非秘密 sentinel，不读取环境变量、`.env` 或 credential 文件，artifact 也剔除 Authorization。

## 为什么不是 live Agent fork

DSH 的 Session 是 append-only durable event log，Agent id 与 Session id 绑定；request 构造会无条件从 `this.session.id` 注入 header session id。没有受支持的生命周期 seam 能在同一个已产生 tool result 的 live Agent 上同时：

- 派生两份仅 reasoning block 不同的 durable history；
- 一份保持相同 session id，另一份换 id；
- 避免 Agent registry、request/header、持久化与 listener 状态也随 fork 改变。

强行克隆/改写 session 会引入比目标因子更多的差异。因此当前实现停在 adapter 边界：它适合检验“显式 CoT passback”与服务端 session header 的因果对照，但不证明完整 Agent 生命周期可无污染 fork。

具体阻断点是：tool-call 后的 request #2 是同一个 open turn 的下一 step（`packages/core/agent-loop/src/agent.ts:263-300,393-399`）；此时最后一个 turn boundary 仍是 `turn/start`。官方 `SessionStore.fork()` 会拒绝这个精确 prefix 并返回 `OPEN_TURN`（`packages/core/session/src/index.ts:1128-1134`）。如果先 cancel/reject 来闭合 turn，公开恢复入口 `followup`/`steer` 又必须携带一条新消息，下一 turn 的 body 因而多出 `user/message`。把 open-turn prefix 直接 seed 给新 Agent 也不会恢复旧 step：loop 只恢复 turn 编号，下一次 wake 会开启新 turn，仍需要新消息。因此 transport-level replay 是当前唯一不污染 base request #2 的路径。

## 离线运行

```sh
node src/cli.mjs request2-replay \
  --fixture experiments/request2-replay/fixtures/tool-call.json \
  --out experiments/request2-replay/artifacts/latest.json
```

输入 fixture 必须恰好包含一条同时具有非空 reasoning 与 tool calls 的 assistant message，并提供不同的 `originalSessionId` / `newSessionId`。输出文件权限为 0600，包含四个 exact raw JSON bodies、非认证 headers、SHA-256、字节数与 diff 证明。

验收断言包括：

- same/new session 因子下 raw body 字节完全相同；
- retain/drop 的 JSON diff 只有 assistant `reasoning_content`；
- 从 retain raw body 删除该字段后，`JSON.stringify` 字节级等于 drop raw body；
- retain/drop 不改变 headers；
- same/new headers 只改变 `x-deepseek-harness-session-id`；
- 四格 `x-deepseek-harness-user-id` 一致；
- Authorization 在真实 mock capture 内存在，但永不导出。

若换入真实轨迹，fixture 和 artifact 会包含用户文本、reasoning、tool arguments/result；它们应继续作为本地敏感实验文件处理。真实发送器尚未实现，也不能在没有单独授权与密钥隔离审计的情况下把这些 payload 发往 API。
