# 会话路由与 CLI 兼容性完善计划

> 制定日期：2026-09-18
> 输入依据：[CLI 兼容性与会话路由审计](cli-compatibility-and-routing-audit.md)
> 原则：先锁定错误行为，再做最小修复；先统一语义，再抽象公共结构

## 实施状态

第一批修复已完成：

- 增加 async conversation context，隔离并发 WeCom 入站消息；
- standalone bridge 的同步回复绑定当前入站 conversation；
- standalone 与 daemon 的异步事件在入队时捕获 slot/turn target；
- 同一 slot 的重复 dispatch 会被拒绝，`sendInput()` 失败会回滚 task 和 conversation；
- 新增并发 context、slot target 优先级和事件 target 快照测试；
- Codex 已验证兼容范围扩展到 `0.155.x`；
- standalone 与 daemon 已复用公共 turn lease、回滚和条件清理语义；
- 增加每周及手动触发的 CLI compatibility workflow；
- compatibility smoke 会验证 Codex schema、Claude capability、OpenCode server health 和 Pi extension capability；
- Pi `/model` 已通过原生 extension API 的 `modelRegistry` 与 `pi.setModel()` 接通；
- `src/core/turn-coordinator.ts` 已将 message gating、turn lease、dispatch 事务、回滚与条件清理、conversation 绑定与 target 解析收敛为 standalone 与 daemon 共用的 `TurnCoordinator` 类，并由 `test/core/turn-coordinator.test.ts` 覆盖。

尚未实施：把 compatibility workflow 设为 required check。

## 1. 目标

本计划解决以下问题：

1. WeCom 私聊与群聊等不同 conversation 并发时，回复不会互相串线；
2. daemon 切换 adapter 后，旧 slot 的输出仍回到该 slot 所属 conversation；
3. 同一 adapter slot 不会被两个远程 turn 同时占用或覆盖 conversation；
4. dispatch 失败不会遗留假的 active task 或 conversation；
5. standalone bridge 与 daemon 最终复用同一套 turn gating 和 ownership 语义；
6. 最新稳定 CLI 的关键协议兼容性可以被持续验证。

## 2. 设计约束

- adapter 不感知 WeChat 或 WeCom；
- `ChannelConversationRef` 继续由 channel/core 层持有；
- 每个 adapter slot 同时最多有一个 active remote turn；
- 命令和 busy reminder 必须回复当前入站 conversation，而不是 active turn conversation；
- 异步 adapter event 必须归属事件产生时的 slot/turn；
- 本地 turn 可以使用 slot 最近一次远程 conversation 作为镜像目标，但不得覆盖正在运行的 remote turn；
- 保持 WeChat 单 owner 与 context-token 行为不变；
- 不改变公开命令语法。

## 3. 建议的数据模型

### 3.1 第一阶段最小模型

先在 bridge orchestration 层增加：

```ts
type ActiveRemoteTurn = {
  id: string;
  conversation: ChannelConversationRef;
  senderId: string;
  startedAtMs: number;
};
```

standalone bridge 持有一个 `activeRemoteTurn`；daemon 的每个 `DaemonSlot` 持有各自的 `activeRemoteTurn`。

第一阶段不强制修改所有 adapter event schema。目标是先替换全局 conversation 推断，并确保 slot ownership 原子化。

### 3.2 后续 correlation 模型

在行为稳定后，可扩展 adapter 输入与事件：

```ts
type BridgeTurnRef = {
  id: string;
  origin: "remote" | "local";
};
```

由 coordinator 保存：

```text
turn ID -> adapter slot -> ChannelConversationRef
```

只有在证明迟到事件仍无法通过 per-slot lease 正确处理时，才把 `turnId` 加入 `BridgeEvent`，避免第一阶段扩大所有 adapter 的修改范围。

## 4. Phase 0：先建立失败用例

### 4.1 WeCom standalone tests

在 `test/bridge` 增加：

1. conversation A 正在 dispatch 时，conversation B 请求 busy reminder，B 的提示必须发给 B；
2. A handler 结束时不得清除 B handler 正在使用的 reply target；
3. A 的最终回复必须发给 A，即使期间收到 B；
4. dispatch 抛错后 active task 和 active conversation 均恢复为空；
5. pending approval/user-input reminder 始终回复触发 reminder 的 conversation。

### 4.2 daemon tests

在 `test/daemon` 增加：

1. Codex slot 在 conversation A 运行，切换到 Claude/conversation B 后，Codex notice 仍发给 A；
2. 旧 slot 的 approval、user-input request、failure、fatal error 均使用旧 slot target；
3. 指定 slot busy 时，第二个 conversation 不能覆盖其 active conversation；
4. `ensureSlot()` 或 `sendInput()` 失败后不保留 active turn；
5. task complete/failure 只清理对应 slot 的 turn ownership。

### 4.3 成功标准

- 新测试在当前实现上至少能稳定复现一个误路由或状态覆盖问题；
- 测试不依赖真实 WeCom 网络；
- fake channel port 记录完整 `ChannelConversationRef`，不能只断言 recipient 文本。

## 5. Phase 1：显式 reply target 与 slot target

### 5.1 standalone bridge

修改 `src/bridge/wechat-bridge.ts`：

1. 入站 handler 为当前消息创建局部 `replyTarget`；
2. busy、approval、user-input、status、switch 和 error 等同步回复显式传入 `replyTarget`；
3. 删除这些路径对 `currentWecomConversation` 的依赖；
4. 仅异步 turn output 使用 `activeRemoteTurn.conversation`；
5. `lastWecomConversation` 只作为本地 turn 或主动通知 fallback，不作为当前入站回复依据。

建议增加局部 helper：

```ts
replyToInbound(text, context)
```

该 helper 捕获当前消息的 `ChannelConversationRef`，避免每个回调重复拼接参数。

### 5.2 daemon

修改 `src/daemon/wechat-daemon.ts`：

1. `handleInboundMessage` 显式接收可选 `ChannelConversationRef`；
2. 当前消息产生的同步回复通过该 ref 发送；
3. 为 slot event 增加统一的 `resolveSlotOutputTarget(slot)`；
4. stdout batcher、notice、approval、user input、session switch、task failure 和 fatal error 均传入 slot target；
5. 禁止 `sendWechatMessageNow` 为 slot event 通过全局 active slot 反查 conversation。

### 5.3 成功标准

- 所有 Phase 0 测试通过；
- WeChat 行为无变化；
- WeCom 的每次 send 在测试中都能追溯到明确 target；
- 不以“当前 active adapter”作为旧 slot event 的 target 来源。

## 6. Phase 2：原子化 turn ownership

### 6.1 dispatch 流程

为 standalone adapter 和每个 daemon slot 实现一致流程：

```text
检查状态
→ 原子声明 active turn
→ 调用 sendInput
→ 成功后保持 lease 至 task complete/failure
→ 失败则回滚 lease 和 active task
```

必须处理 `sendInput()` 在调用过程中同步发出 event 的情况，因此 conversation 应在调用前绑定，但 catch 中必须恢复先前状态。

### 6.2 并发策略

同一 slot 的第二个普通输入不得再次调用 `sendInput()`。首选行为：

- command：仍可按现有规则处理；
- pending approval/user input：返回对应 reminder；
- busy：向第二个输入自己的 conversation 返回 busy reminder；
- Codex local-turn defer：保留现有策略，但 deferred item 必须保存自己的 conversation ref；
- 其他 adapter：拒绝并提示等待或 `/stop`。

不在本阶段引入无界通用队列。

### 6.3 清理规则

- `task_complete`：清理对应 slot active turn；
- `task_failed`：先确定并保存 target，再清理并发送错误；
- `fatal_error`：先保存 target，再释放 slot；
- reset/new/resume：只有成功提交状态变更后才能替换 ownership；
- late event：不得使用另一个新 turn 的 conversation。

### 6.4 成功标准

- 两个并发 dispatch 最多一个进入 runtime；
- dispatch rejection 后 slot 回到可接受新输入的状态；
- task failure/fatal error 仍发送到失败 turn 的 conversation；
- deferred input 恢复时使用其原始 conversation。

## 7. Phase 3：抽取公共 Turn Coordinator

仅在 Phase 0–2 行为测试全部稳定后进行。已实施：`src/core/turn-coordinator.ts` 提供 `TurnCoordinator<TTask>`，standalone bridge（WeChat/WeCom 双通道、在线 dispatch、deferred drain）与 daemon（每 adapter slot 一个 coordinator、审批/结构化输入接管、resume 清理）均已接入。

coordinator 负责：

- `routeBridgeMessage` gating；
- active remote turn lease；
- conversation ownership；
- dispatch transaction；
- complete/fail/reset cleanup；
- 当前入站 reply target 与异步 turn target 的区分。

standalone bridge 和 daemon 继续负责：

- transport 生命周期；
- daemon slot 创建与切换；
- adapter-specific controller；
- 可见终端启动；
- 通道专属格式和重试。

### 非目标

- 不把 daemon slot map 移进 coordinator；
- 不把 WeChat context-token 逻辑移进 adapter；
- 不一次性合并 `wechat-bridge.ts` 与 `wechat-daemon.ts`；
- 不为单次抽取改写四个 adapter。

## 8. Phase 4：CLI 兼容性维护

### 8.1 Codex

1. 将测试覆盖扩展到 `0.155.0`；
2. 更新当前已验证版本提示；
3. 增加真实 app-server smoke：启动、initialize、可选 thread start、dispose；
4. 保存由最新稳定版生成的最小 schema fixture；
5. 将关键能力缺失与“版本未验证”区分为 error 和 warning。

### 8.2 OpenCode

1. 在独立 compatibility job 安装最新稳定 `opencode`；
2. 验证 `serve`、health、SDK client、SSE connect 和 dispose；
3. 不在普通单元测试中依赖外部账号或真实模型调用。

### 8.3 Claude Code

1. 验证当前 help flag 探测；
2. 生成临时 settings 并验证 Hook 配置可加载；
3. 不执行付费模型 turn；
4. 保留 PTY + Hook 架构，除非上游提供正式持久本地 RPC。

### 8.4 Pi

1. 保留原生 TUI + extension 方案；
2. 为 extension IPC 增加 `list_models` 和 `select_model`；
3. 使用 `ctx.scopedModels` 或 `ctx.modelRegistry` 列表；
4. 使用 `pi.setModel()` 切换；
5. 暂不开放通用 `/plan`。

## 9. CI 计划

建议新增低频或手动 compatibility workflow，而不是扩大每次 push 的主矩阵：

```text
workflow_dispatch
weekly schedule
```

任务分为：

- Codex stable smoke；
- Claude stable config/hook smoke；
- OpenCode stable server smoke；
- Pi stable extension type/launch smoke。

普通 CI 继续运行仓库单元测试和 build。兼容性 workflow 失败应先产生维护告警；在 smoke 稳定前，不立即设为所有 PR 的 required check。

## 10. 预计修改范围

第一批正确性修复预计涉及：

- `src/bridge/wechat-bridge.ts`
- `src/daemon/wechat-daemon.ts`
- `src/core/channel-types.ts`（仅在需要新增 turn ref 时）
- `src/core/bridge-message-router.ts`（仅在需要统一 transaction 接口时）
- `test/bridge/*`
- `test/daemon/*`
- `test/wecom/*`

后续兼容增强预计涉及：

- `src/bridge/bridge-adapters.codex.ts`
- `src/bridge/bridge-adapters.pi.ts`
- `src/companion/pi-tui-bridge-extension.ts`
- `src/bridge/adapter-control.ts`
- `.github/workflows/*`

## 11. 每阶段质量门禁

每阶段先运行最小测试，再扩大：

```bash
bun test test/bridge
bun test test/daemon
bun test test/wecom
npm run lint
npm run typecheck:src
bun test test
npm run build
```

涉及真实 CLI compatibility 时，额外记录：

- CLI 名称与精确版本；
- 启动参数；
- 是否创建 session/thread；
- 是否调用真实模型；
- 清理结果。

## 12. 实施顺序与提交建议

建议拆成独立、可回滚提交：

1. `test: reproduce cross-conversation routing races`
2. `fix: bind inbound replies to explicit conversation targets`
3. `fix: preserve daemon slot output ownership`
4. `refactor: centralize bridge turn ownership`
5. `fix: validate current Codex app-server compatibility`
6. `feat: expose Pi model selection through the bridge extension`
7. `ci: add scheduled CLI compatibility smoke tests`

每个提交都必须保持 standalone WeChat、standalone WeCom、daemon WeChat 和 daemon WeCom 四种运行形态可独立回退。

## 13. 开始实施前的检查点

- [x] 第一批先完成路由正确性，再独立接入 Pi `/model`；
- [x] busy 输入策略为拒绝而不是通用排队；
- [x] 本地 turn 的 fallback target 仍使用 slot 最近 conversation；
- [x] compatibility workflow 初期不设 required；
- [x] 从 Phase 0 回归测试开始，再抽取公共 turn ownership helper；
- [x] Phase 3 的 TurnCoordinator 抽取在四形态行为测试稳定后进行，gating 语义逐点等价迁移。
