# 07 · cordis-rs API 备忘（已验证）

本文记录**在本仓库实测通过**的 cordis-rs 用法，作为后端内核与插件 SDK 的事实参考。
签名以 `cordis-core v0.6.1`（crates.io 发布版，edition 2024，MSRV 1.88）为准。
验证证据：`cargo run -p cordis-boot`（见 [spikes/cordis-boot/src/main.rs](../spikes/cordis-boot/src/main.rs)）。

> 隔离原则（R2）：插件与内核业务代码**只依赖 `fm-contracts` 薄封装**，不直接散引 cordis 类型；
> 本文是封装层实现时的对照表。

---

## 1. 依赖与解析

| crate | 版本 | 用途 |
|---|---|---|
| `cordis-core` | `0.6.1` | 运行时内核：`Context`/`Plugin`/`Service`/`Event`/`Effect`/`Fiber` |
| `cordis-loader` | `0.6.x` | 加载计划（manifest → 依赖排序 → spawn），后端插件引导用 |
| `cordis-timer` | `0.6.x` | 时间能力（`sleep`/`timeout`/`interval`），内核不默认带 `time` |
| `cordis-rs`（facade） | `0.11.1` | 保留 `use cordis::...` 历史导入名；本仓库直接用 `cordis-core` |

`cordis-core = "0.6"` 可从 crates.io 正常解析（实测下载 `cordis-core v0.6.1`）。
core 依赖极轻：tokio（无 `time`）、parking_lot、thiserror、futures。

## 2. 引导一个内核 + 插件（实测序列）

```rust
use std::convert::Infallible;
use cordis_core::event::{ListenerRegistrationError, observer_sync};
use cordis_core::{BoxError, Context, Event, FiberState, Plugin, PreparedPlugin, Routing};

// (1) 建根 Context —— 一个 Context 即一个 Runtime 的入口
let ctx = Context::new();

// (2) prepare → seal：先同步 prepare 出 Input，再密封成 PreparedPlugin
let input  = Echo.prepare(())?;                       // Plugin::prepare
let sealed = PreparedPlugin::from_input(Echo, input); // 证明 Plugin↔Input 类型关联

// (3) spawn：异步准入，交回一个 live/quiescent 的 FiberHandle
let handle = ctx.spawn(sealed).await?;

// (4) ready：驱动到静止态（Active=apply 成功；Pending=缺依赖 Service）
match handle.ready().await? {
    FiberState::Active  => { /* up */ }
    FiberState::Pending => { /* 等 Service，用 handle.pending_missing() 查缺哪些 */ }
    other               => { /* Disposed 等 */ }
}

// (5) 发事件：Routing 必须显式给（Scoped=按 Event 可达域；Unscoped=本 Runtime 跨域）
ctx.emit::<Ping>(Routing::Unscoped, "world".into()).await?;

// (6) 显式拆除：dispose 是终结屏障，走完 cleanup + Disposed 发布 + 精确 unlink
handle.dispose().await?;
```

实测输出：`emit #1` 收到监听回调打印；`dispose` 后 `emit #2` **静默**——
证明**监听器随 fiber 代际清理**（Effect 生命周期归属，ADR 0028）。

## 3. 关键类型签名（实测/对照 consumer-guide）

### Plugin trait

```rust
impl Plugin for Echo {
    type Config       = ();                          // 源配置（loader 场景为 JSON）
    type Input        = EchoInput;                   // prepare 产出的密封输入
    type PrepareError = Infallible;                  // prepare 是同步、先于生命周期准入
    type ApplyError   = ListenerRegistrationError;   // apply 的错误类型（用具体类型，别用 BoxError）

    fn prepare(&self, cfg: ()) -> Result<EchoInput, Infallible>;
    async fn apply(&self, ctx: Context, input: &EchoInput) -> Result<(), Self::ApplyError>;
}
```

- `prepare` **同步**、发生在准入之前：prepare 失败或直接 panic 不会留下已准入的 fiber。
- `apply` 每次 poll 必须**非阻塞**；阻塞段丢 `tokio::task::spawn_blocking`。
- **不要依赖 spawn 时的运行时亲和性**：apply 可能跑在 Cordis 自有运行时上，
  `apply` 里的 `tokio::spawn`/`Handle::current()` 指向的是**正在 poll 它的那个运行时**。
  → 内核集成要点（R1）：把宿主的 `tokio::runtime::Handle` 放进 `Input` 带进来，
  需要长驻宿主运行时的任务经该 Handle 派生。

### Event trait

```rust
impl Event for Ping {
    const NAME: &'static str = "ping";   // 事件名（本仓库约定 domain:action，如 "file:changed"）
    type Args   = String;                // 负载
    type Output = ();                    // 返回
}
```

注册监听：`ctx.on::<E, _>(observer_sync(|ctx, args| -> Result<O, Err> { ... }))?`
返回一个 listener 注册句柄；**Drop 即惰性**，代际清理才真正撤销。
适配器角色：Observer / Responder / Mapper / Around。

### FiberHandle 控制面

| 方法 | 语义 |
|---|---|
| `ready().await -> Result<FiberState>` | 驱动最新目标到静止（含 Pending） |
| `wait_state(..)` | 被动等某状态发布，带超时；分别处理 `Elapsed`/`Recursion`/`DeadlineUnavailable` |
| `state() -> FiberState` | 同步读当前态 |
| `name() -> &str` | fiber 名（默认取 `type_name`，用于日志行） |
| `pending_missing()` | Pending 时缺哪些 Service 名 |
| `dispose().await` | 终结屏障；一旦 commit，即便 future 被 drop 也会走完 |
| `update(..)` / `era_swap(..)` | 同 ID 换输入 / 换代（新 fiber、结束旧 fiber） |

**Drop handle 不会 dispose fiber**——必须显式 `dispose().await`。
不要在 tokio worker 线程上 `block_on` 一个 Cordis 生命周期 future（committed 工作可能正排在该 worker 上）；
同步代码里用 `block_in_place` 或 `spawn_blocking`。→ Tauri 集成走 `tauri::async_runtime`。

## 4. Service（DI）要点（对照 consumer-guide，后续 P1-2 用）

- `InjectSpec`：`require` / `require_configured` 声明前置 Service；`build` 后密封进 `PreparedPlugin`。
- 发布：`ctx.provide::<S>(value)` → 得 `ServicePublication`；`set` 换负载、`remove` 撤回。
- 查取：`ctx.try_service::<S>()`；缺依赖 → fiber 停在 `Pending`，发布后 `ready()` 收敛。
- 能力层（`fs.readChunk`/`hash.compute`/`db.*`）以 `Service` 暴露给后端插件，进程内直调（非 IPC）。

## 5. 加载器（loader）要点（后续 P1-6 用）

- `LoadPlanBuilder` → `finish` 冻结计划；结构性父序只定执行顺序，不拥有 fiber。
- 每次执行创建**全新**的生命周期与 realm 实例；用 `EntryId` 关联（跨 clone/reuse 稳定）。
- Load 是**部分成功**语义：`is_ok` = 无 Failed 条目，≠ 所有 fiber Active。
- `fiber_handles()` 取回交付的控制句柄，纳入应用 roster 显式拆除。

---

## 未决 / 待在 Tauri 内验证（P0-3 剩余部分）

- [ ] `Context::new()` 在 `tauri::Builder::setup` 内构造，内核跑在 `tauri::async_runtime`（tokio 多线程）上是否与 cordis 自有运行时冲突。
- [ ] 后端 `ctx.emit` → Tauri `emit` → 前端总线的桥接（P1-3）。
- [ ] loader 从 manifest 生成计划并 spawn 已启用后端插件（P1-6）。
