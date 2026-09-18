# CLI 兼容性与会话路由审计

> 审计日期：2026-09-18
> 审计对象：CLI WeChat Bridge 当前 `main`、本机最新稳定 CLI，以及 `/Users/nonlinear/GitHub/CLI` 中可用的上游源码快照
> 文档性质：架构与兼容性审计；高优先级路由修复已于同日开始实施，进度见完善计划

## 1. 摘要

当前四个 adapter 的总体技术路线仍然成立：

- Codex 继续使用 app-server WebSocket JSON-RPC；
- Claude Code 继续使用可见 PTY、Hook 回调和 transcript 补充；
- OpenCode 继续使用 `serve`、HTTP SDK 与 SSE；
- Pi 继续使用原生 TUI 和 extension IPC。

目前最需要修复的并不是四个 CLI 全面失配，而是 bridge 自身的 conversation ownership：WeCom 允许来自不同 conversation 的消息并发进入，但 standalone bridge 和 daemon 仍使用全局可变 conversation 推断输出目标。daemon 的部分 slot 输出还会通过当前 active slot 选择目标。这可能使忙碌提示、中间输出、审批、错误或任务完成消息被发送到错误的私聊或群聊。

建议采用渐进式修复，不做 adapter 全面重写：先补回归测试并修复显式目标传递和 per-slot turn ownership，再抽取 standalone/daemon 共用的 turn coordinator，最后处理 CLI 兼容性维护和 Pi 能力补齐。

## 2. 审计基线

### 2.1 最新稳定 CLI

| CLI | 审计版本 | 本机状态 | 主要控制面 |
| --- | --- | --- | --- |
| Codex | `0.155.0` | 已安装并完成真实 headless 启动 smoke | app-server WebSocket JSON-RPC |
| Claude Code | `2.1.276` | 已安装；对照当前 CLI help 与官方 Hook 文档 | 交互式 PTY、Hooks、transcript |
| OpenCode | `1.18.31` | 本机无可执行文件；完成上游源码与 SDK API 对照 | `serve`、HTTP SDK、SSE |
| Pi | `0.85.1` | 已安装；对照当前源码和 extension/RPC API | 原生 TUI、Extension API、RPC mode |

### 2.2 本地上游源码说明

- `/Users/nonlinear/GitHub/CLI/codex` 和 `/Users/nonlinear/GitHub/CLI/pi` 接近最新上游主线，可用于协议与类型核对。
- `/Users/nonlinear/GitHub/CLI/opencode` 只落后上游一个文档提交，SDK 和事件协议对照有效。
- `/Users/nonlinear/GitHub/CLI/claude-code` 保存的是 `2.1.88` 的恢复代码，不是当前 `2.1.276` 的权威源码；Claude 兼容性应以已安装 CLI、官方文档和真实 smoke test 为准。

## 3. 高优先级逻辑问题

### 3.1 WeCom 跨 conversation 竞态

`src/channels/wecom/wecom-transport.ts` 以 conversation 为 key 串行化入站消息。因此，同一 conversation 内有序，但私聊和群聊等不同 conversation 可以并发进入上层。

standalone bridge 使用以下全局可变状态：

- `currentWecomConversation`
- `activeWecomConversation`
- `lastWecomConversation`

daemon 使用：

- `currentInboundConversation`
- `handlingInboundMessage`
- slot 上的 `activeConversation` / `lastConversation`

不同 conversation 并发时，一个 handler 可以覆盖另一个 handler 正在使用的 `current*Conversation`；任一 handler 的 `finally` 也可能在另一个 handler 尚未结束时清空全局状态。所有依赖这些全局变量推断目标的即时回复都有误投风险。

可能受影响的输出包括：

- busy、pending approval、pending user input 等即时提示；
- adapter 切换、状态和错误回复；
- pending message flush；
- 尚未绑定稳定 active conversation 的中间输出。

**结论：这是实际正确性问题，需要修改代码。**

### 3.2 daemon slot 输出通过 active slot 反查目标

`src/daemon/wechat-daemon.ts` 的最终回复会优先读取事件所属 slot 的 `activeConversation` 或 `lastConversation`，但多类事件仍调用：

```ts
queueWechatMessage(this.authorizedUserId, ...)
```

WeCom 分支随后可能根据当前 active slot 选择 target。若 Codex 仍在旧 conversation 中运行，而用户已切换到 Claude，Codex 的中间输出、notice、approval、user-input request、task failure 或 fatal error 可能使用 Claude 的 conversation。

**结论：输出目标必须由事件所属 slot 决定，不能由全局 active slot 决定。**

### 3.3 `BridgeEvent` 缺少 turn correlation

adapter 输出事件当前不携带 turn ID 或 conversation。上层只能通过 `activeTask`、`activeConversation` 和 adapter 当前状态猜测事件归属。这在单输入、单 conversation 下通常成立，但无法可靠覆盖：

- 不同 conversation 并发；
- adapter 切换后旧 slot 继续输出；
- dispatch 失败后的状态回滚；
- 本地 turn 与远程 turn 交错；
- 迟到的 completion 或 error event。

长期应建立通道无关的 turn correlation：adapter 不需要知道 WeChat/WeCom，但 bridge coordinator 需要将一个稳定 turn ID 映射到 `ChannelConversationRef`。

## 4. CLI 兼容性结论

### 4.1 Codex

当前代码只把 `0.149.x` 至 `0.151.x` 标记为兼容。最新稳定版为 `0.155.0`。

真实 smoke 结果：本仓库 `CodexPtyAdapter` 能使用 `0.155.0` 启动 app-server、完成 RPC 初始化并进入 idle，但日志错误地显示：

```text
Codex protocol compatibility: outside-supported-range=0.155.0.
```

因此当前不是启动阻断，而是兼容性判定和维护策略过期。

短期应把已验证范围更新到 `0.155.x`。长期应以 capability probe 和版本匹配 schema fixture 为主，而不是仅依赖硬编码版本窗口。Codex 当前提供：

```bash
codex app-server generate-ts
codex app-server generate-json-schema
```

可用于生成协议契约并建立兼容性测试。

### 4.2 Claude Code

当前 adapter 使用的核心机制仍受最新 Claude Code 支持：

- `UserPromptSubmit`
- `PermissionRequest`
- `Stop`
- `StopFailure`
- `PreCompact` / `PostCompact`
- `SessionStart`
- PTY bracketed paste
- transcript fallback

Claude Code 新增的 remote-control/background 命令不是通用本地 adapter RPC，不能直接替代当前需要的可见终端、动态审批和本地/远程双向同步。因此暂不建议重写 Claude adapter。

### 4.3 OpenCode

当前使用的 API 和事件在 `1.18.31` 上游仍存在：

- `session.promptAsync`
- `session.status`
- `global.event`
- `event.subscribe`
- `permission.asked`
- `question.asked`
- `session.idle`
- `message.part.updated`
- `tui.selectSession`
- `v2.session.switchModel`
- `v2.session.switchAgent`

现有 `>=1.18.0 <2.0.0` 版本边界合理。当前没有发现必须立即调整的协议逻辑，但因为本机没有 OpenCode executable，仍需补真实启动 smoke。

### 4.4 Pi

Pi 原生 TUI + extension TCP IPC 的方向仍然合理，且符合“复用可见 CLI”的产品目标。没有必要为了 RPC mode 重写整个 adapter。

不过 Pi `0.85.1` 已通过 extension API 暴露：

- `ctx.modelRegistry`
- `ctx.model`
- `ctx.scopedModels`
- `pi.setModel()`
- `pi.setThinkingLevel()`

审计时本仓库仍明确禁止 Pi `/model`；本轮完善已通过原生 extension API 接入模型列表和切换。Pi plan mode 通常由扩展提供，不是基础运行时保证，因此仍未与 `/model` 一起强行开放。

## 5. 结构性维护风险

### 5.1 standalone bridge 与 daemon 重复路由逻辑

`src/bridge/wechat-bridge.ts` 与 `src/daemon/wechat-daemon.ts` 分别实现了：

- 消息 gating；
- busy、approval、user input 处理；
- adapter dispatch；
- conversation 绑定；
- output forwarding；
- pending outbound retry；
- task 完成和失败清理。

这使新入口容易只复用 dispatch，而绕过完整状态机，也使两种运行形态对相同事件产生不同语义。

### 5.2 `RuntimeHost` 与 `BridgeAdapter` 边界较弱

`RuntimeHost` 继承 `BridgeAdapter`，而 `LegacyAdapterRuntime` 对大部分方法只是透传。当前差异主要服务于 Codex runtime endpoint 类型和 visible client 协议。它不是立即 bug，但说明抽象尚未稳定，不应继续在两套接口上分别增加业务状态。

### 5.3 channel-neutral core 尚未完全实现

仓库已经有 `ChannelConversationRef`、`BridgeChannelPort` 和 channel-neutral message router，但 orchestration 仍大量依赖 `queueWechatMessage`、`currentWecomConversation` 等通道与全局状态。现状是“transport 已抽象，turn ownership 尚未抽象”，不能认为整个 bridge core 已经通道无关。

## 6. 是否需要修改代码

需要，但应按以下优先级进行：

### 必须修复

1. 不再通过全局 current conversation 为即时回复选择 WeCom target。
2. daemon 所有 slot event 显式使用事件所属 slot 的 conversation。
3. 为每个 adapter slot 建立原子、稳定的 active turn ownership。
4. dispatch 失败时回滚 active task 和 conversation。
5. 增加跨 conversation 和 adapter 切换竞态测试。

### 短期兼容维护

1. 将 Codex 已验证版本更新至 `0.155.x`。
2. 增加 Codex capability/schema smoke。
3. 为 OpenCode 增加真实 executable smoke。

### 后续能力增强

1. Pi extension `/model` 与共享 turn ownership helper 已在本轮落地。
2. 后续可继续把 message gating 抽取为 standalone/daemon 共用的完整 Turn Coordinator。

## 7. 非目标

本轮不建议：

- 全面重写四个 adapter；
- 以 Claude remote-control 替代 Claude PTY + Hooks；
- 以 Pi RPC mode 替代可见原生 TUI；
- 为了命名统一一次性重命名全部 `Wechat*` 标识符；
- 在没有行为回归测试前合并 standalone 与 daemon 主循环。

## 8. 相关文档

- [通信架构](architecture.md)
- [开发说明](development.md)
- [指令、入口与协议审计](command-audit.md)
- [会话路由完善计划](turn-routing-hardening-plan.md)
