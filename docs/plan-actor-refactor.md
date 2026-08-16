# 架构重构方案：借鉴 ACP actor 模式 + 流式改增量 delta

> 状态：待审核
> 目标版本：pi-rs v1.82.10（若需改动）+ pi-gui-rs

---

## 一、现状与问题

### 现状（pi-gui-rs）

```
Store (Arc<Store>)
├── state: Mutex<DesktopState>              // UI 元数据
├── runtime: Mutex<Option<AgentSessionRuntime>>  // ← 核心问题
├── session_id: Mutex<Option<String>>
├── is_streaming / abort_flag / generation / abort_epoch / abort_tx(watch)
└── terminals: Mutex<Vec<TerminalSession>>
```

`send_message` 流程：`runtime.lock().take()` → `tokio::spawn` 任务跑 `add_user_text` → 完成后按 `generation` 检查再放回。**所有**会话操作（set_model / compact / fork / import / navigate / select）都要走"拿-跑-还"。

### 问题

1. **拿-跑-还脆弱**：每个命令都要记得把 runtime 放回，panic/遗漏即丢失；`generation` 计数器是为掩盖这个竞态打的补丁（已踩过 3 次 bug：runtime id 不一致、stale runtime 覆盖、session_file 不回填）。
2. **共享可变状态**：`Arc<Store>` + 全局 Mutex，命令间没有串行化保证，靠约定 + 计数器。
3. **abort 机制复杂**：abort_flag + watch channel + 300s timeout 三层，绕开"runtime 在任务里无法直接 abort"的问题。
4. **流式是快照式**：每个 `message_update` 带完整 partial，前端整体替换最后一条消息的 blocks；工具部分结果会被快照抹掉（已打补丁保留），增量文本要重算。

### ACP 的做法（参照物）

```
SessionTask actor（一个 tokio task）
├── session: Arc<AgentSession>        // 与 turn 任务共享，内部锁保证并发安全
├── cmd_rx: mpsc::UnboundedReceiver<SessionCommand>  // 命令邮箱
├── notif_tx: mpsc → EventTranslator → 客户端通知
└── turn_done_rx: 记录 in-flight turn；select 命令/回合结束
```

- 单一拥有者 + 消息传递（channel + oneshot reply）→ 天然串行，无竞态
- prompt 跑在独立 turn task（共享 Arc<AgentSession>）→ actor 保持响应，cancel 直接 `session.abort()` 不死锁

---

## 二、目标架构

### 总体

```
Store (Arc<Store>)
├── state: Mutex<DesktopState>                     // 不变
├── session_handle: Mutex<Option<SessionHandle>>   // 替代 runtime: Mutex<Option<...>>
│     └── SessionHandle { tx: mpsc::UnboundedSender<SessionCommand> }
├── session_id: Mutex<Option<String>>              // 保留（UI 记录映射）
├── is_streaming: AtomicBool                       // 保留
└── terminals: Mutex<Vec<...>>                     // 不变
        │
        │ send command (mpsc) / await reply (oneshot)
        ▼
SessionActor task（新模块 state/actor.rs）
├── runtime: AgentSessionRuntime     // 持有 services + factory（用于 Replace）
├── session: Arc<AgentSession>       // runtime.session_arc() 克隆，turn 任务共享
├── cmd_rx: mpsc::UnboundedReceiver<SessionCommand>
├── turn: Option<turn task 句柄 + done channel>   // in-flight 回合
└── app / store 引用（发事件 + 更新 UI 状态）
```

### SessionCommand（全部带 oneshot reply）

| 命令 | 处理 | 并发说明 |
|---|---|---|
| `SendMessage{text}` | spawn turn task（克隆 Arc session 跑 `add_user_text`），actor 保持响应 | turn 独立 |
| `Abort` | 直接 `session.abort().await`（&self，走内部锁） | 与 turn 并发安全 |
| `SetModel{provider,model}` | `session.set_model()`（&self） | 并发 |
| `SetThinkingLevel{level}` | `session.set_thinking_level()` | 并发 |
| `Compact{instructions}` | `session.compact()` | 并发 |
| `Navigate{entry_id}` | `session.navigate_tree()`（改 &self 后） | 并发 |
| `ForkAt{entry_id}` | `session.session_mgr_fork()` → session id 变了 → 更新 store + 重扫列表 + 发 transcript | 并发 |
| `Import{path}` | `session.session_mgr_switch()` + 同上 | 并发 |
| `Reload` | `session.reload()` | 并发 |
| `SetName{name}` | `session.set_session_name()` | 并发 |
| `GetMessages` / `GetSessionId` / `GetSessionFile` / `GetModel` / `GetTree` | 读操作 | 并发 |
| `Replace{cwd,agent_dir,session_manager}` | 若 turn in-flight 先 abort 等待 settle → 用 factory 重建 runtime（工厂内重新订阅事件）→ 换 session Arc → 回填 store.session_id | 会话切换/新建 |
| `Shutdown` | 终止 | 归档/删除时 |

### 相比现状的收益

1. **删除 generation 计数器**——actor 串行 + 唯一拥有者，stale task 覆盖问题从机制上消失
2. **删除 abort_flag / watch channel**——`Abort` 命令直接 `session.abort()`（ACP 同款），turn 任务只剩 300s 超时兜底
3. **消除拿-跑-还**——所有命令走 channel，回复用 oneshot，无"忘记放回"
4. **会话切换期间可响应**——Replace 之外的命令不被 turn 阻塞（SetModel 在流式时可立即生效，对齐 ACP）
5. **事件订阅不变**——仍由 `build_runtime_factory` 在创建 session 时建立（`session.subscribe` → `app.emit`），actor 不动这块

### 需要的前置 pi-rs 改动（v1.82.10）

| 改动 | 说明 |
|---|---|
| `AgentSessionRuntime.session` 改为 `Arc<AgentSession>` | 加 `session_arc() -> Arc<AgentSession>`；`session()` 改为 deref；删除 `session_mut()`（GUI 不再需要 &mut） |
| `navigate_tree` / `session_mgr_fork` / `session_mgr_switch` 改 `&mut self` → `&self` | 函数体只用内部 `Arc<Mutex>`，签名收窄安全；验证 pi-rs 内部无 &mut 调用者 |
| 测试 | runtime Arc 化 + &self 方法编译/单测 |

---

## 三、流式改增量 delta

### 现状

`AgentSessionEvent::MessageUpdate { assistant_message_event }` → 整个事件序列化（含完整 partial）→ `message_update` → 前端整体替换最后一条消息 blocks。

### 目标

按 `AssistantMessageEvent` 变体拆分事件，前端按块追加：

| 后端事件 | payload | 前端动作 |
|---|---|---|
| `message_start`（session 级，保留） | 完整初始 message | 创建 assistant 消息（自愈锚点） |
| `text_delta` | `{contentIndex, delta}` | `blocks[idx].text += delta` |
| `thinking_delta` | `{contentIndex, delta}` | `blocks[idx].thinking += delta` |
| `toolcall_start` | `{contentIndex, partial}` | 确保 idx 处有 toolCall 块（id/name 从 partial 取） |
| `toolcall_delta` | `{contentIndex, delta}` | `blocks[idx].arguments += delta`（流式 JSON 字符串） |
| `toolcall_end` | `{contentIndex, toolCall}` | 用完整 toolCall 定型该块 |
| `message_end`（session 级，保留） | 完整 message | 整体替换（自愈：漏事件也能校正） |
| `tool_execution_start/update/end`（保留） | 不变 | 不变（按 id 合并 status/result） |

**设计要点：**
- **内容索引映射**：blocks 数组与 pi-ai `content` 数组一一对应，`contentIndex` 直接定位；块缺失时按需补建（防 delta 先于 start 到达）
- **自愈性**：增量事件负责平滑，`message_start`/`message_end` 的完整快照负责兜底校正——两者结合，兼顾流畅与可靠
- **删除前端补丁**：移除 useChat 里"message_update 保留工具状态"的合并 hack（快照替换不存在了）；`message_update` 事件整体移除
- **`TextStart`/`TextEnd`/`ThinkingStart`/`ThinkingEnd` 可忽略**（delta 已带内容）或仅用于建块

---

## 四、实施步骤

### Phase 0：pi-rs v1.82.10
1. `AgentSessionRuntime` Arc 化 + `session_arc()` + 删 `session_mut`
2. 3 个方法 `&mut self` → `&self`
3. `cargo test -p pi-coding-agent`（除已知 test_constants 外全绿）→ 打 tag v1.82.10 → push → GUI `cargo update`

### Phase 1：GUI actor 化（新模块 `state/actor.rs`）
1. 定义 `SessionCommand` 枚举 + `SessionActor`（含 `next_event`：命令 / turn-done 二选一）
2. `Store`：`runtime: Mutex<Option<...>>` → `session_handle: Mutex<Option<SessionHandle>>`；`spawn_runtime` 改为 `spawn_actor`（actor 内建 runtime + 订阅 + 回填 session_id）
3. 迁移全部会话命令到 actor（send / abort / select / create / set_model / compact / fork / import / reload / navigate / rename / get_messages / get_session_model / get_session_tree / get_selected_transcript 的 in-memory 分支）
4. 删除：generation、abort_flag、abort_epoch、abort_tx、拿-跑-还
5. `set_session_cwd` 的 SetInPlace/Fork 逻辑迁移（本质是 Replace / ForkAt + Replace）

### Phase 2：流式 delta
1. `transcript.rs::serialize_session_event`：MessageUpdate 按变体拆分
2. `useChat.ts`：`message_update` 处理替换为 text_delta / thinking_delta / toolcall_start / toolcall_delta / toolcall_end 追加逻辑；保留 message_start/end、tool_execution_*
3. 删除工具状态保留 hack

### Phase 3：清理与验证
1. 清理死代码（watch、generation、旧 transcript 合并）
2. 验证清单（手动 + cargo test）：
   - [ ] 流式输出逐字增量渲染（text/thinking/toolcall 交错）
   - [ ] 流式中 Stop 立即停止（Abort 直接调 session.abort）
   - [ ] 流式中切换模型生效（SetModel 不被 turn 阻塞）
   - [ ] 会话切换 / 新建 / 归档 / 删除 / 改 cwd / fork / import / reload
   - [ ] transcript 加载、滚动到底、terminal 多标签
3. 无回归：cargo build / cargo test / tsc / vite build

---

## 五、风险与缓解

| 风险 | 缓解 |
|---|---|
| pi-rs 改动破坏运行时 | 3 个方法改 &self 逐个编译+单测；runtime Arc 化保留 `session()` API 兼容 |
| actor 迁移引入回归（命令多） | 每迁移一个命令就验证对应前端功能；命令保持同名同签名，前端无感知 |
| 并发访问 AgentSession | 内部全是 Arc<Mutex>，ACP 已验证该模式；turn 任务只调 &self 方法 |
| delta 事件丢/乱序 | message_start/end 完整快照兜底自愈；toolcall 按 contentIndex 定位 |
| Replace 与 turn 竞争 | Replace 先 abort 并等待 turn settle（ACP teardown 同款） |

## 六、工作量估计

- pi-rs：~1-2 小时（改动小，测试为主）
- GUI actor：~3-4 小时（命令迁移是大头）
- delta 流式：~1-2 小时
- 验证：~1 小时
