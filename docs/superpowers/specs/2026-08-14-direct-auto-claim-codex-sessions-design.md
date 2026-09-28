# Taskboard 直接创建 Codex 自动认领会话设计

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

日期：2026-08-14

## 背景

当前自动认领依赖 Codex 周期计划任务。Taskboard 先认领议题并准备 Worktree，再为槽位创建一个 `cron` 自动化。只要自动化保持启用，Codex 就会按照间隔不断产生新会话；任务级运行锁只能让重复会话在进入任务后退出，不能阻止会话本身被创建。因此，同一任务可能每五分钟新增一次会话，最终造成会话堆积和 Codex 卡顿。

手动“在 Codex 中打开”路径也不能承担无人值守处理：它只导航到新会话页并预填提示词，没有提交输入或获得真实 `threadId`。

Codex App Server 已提供 `thread/start`、`turn/start`、`thread/read` 和会话事件。Taskboard 服务当前也已经通过 App Server 读取技能列表，因此可以复用同一官方能力，直接创建并启动会话，不再借助计划任务。

## 目标

- 自动认领直接创建并启动一个 Codex 会话，不创建 Codex 计划任务。
- 一个任务同一时刻只能绑定一个活动会话。
- 开启自动认领时，先恢复已有进行中任务，再使用空闲槽位认领待办。
- 成功创建会话后，自动把真实 `threadId` 记录到执行记录和任务评论。
- 会话状态变化触发槽位流转，配置的间隔只作为兜底检查周期。
- 合并队列繁忙时，每十分钟创建一次新的合并重试会话，最多五次。
- 单个任务失败或需要人工介入时释放并发槽位，不阻塞其他待办。
- 升级后暂停旧的 Taskboard 自动认领计划，防止旧计划继续产生会话。

## 非目标

- 不改变用户自行创建的 Codex 计划任务。
- 不自动中断关闭自动认领前已经开始执行的会话。
- 不在本次改造中重做任务面板布局或引入新的测试体系。
- 不自动删除失败任务的 Worktree 或未合并提交。

## 当前真实操作路径

### 手动路径

1. `web/src/App.tsx` 的 `openTaskInThread` 发送 `taskboard:create-thread`。
2. `inject/codex-taskboard.user.js` 的 `createThreadForTask` 导航到 `/`。
3. 注入层调用宿主预填能力写入 Skill 与提示词。
4. 页面显示已准备的输入框，但不会提交，也没有真实会话 ID 可回写。

### 自动认领路径

1. `scripts/codex-injector.mjs` 的 `applyTaskboardAutomationPolicy` 调用 Taskboard `fill` 接口认领任务。
2. 它按槽位调用 `reconcileTaskboardAutomation`。
3. `shared/taskboard-automation.mjs` 构造 `kind: "cron"` 的自动化并调用 `automation-create` 或 `automation-update`。
4. 每次 cron 到期，Codex 都创建一个新会话；任务运行锁在新会话开始后才生效。

## 方案选择

采用服务端持久 App Server 客户端。

备选方案未采用的原因：

- 每次认领临时启动 App Server：并发时产生多个进程，状态恢复困难。
- 通过 CDP 操作 Codex 页面并自动点击发送：依赖 DOM、窗口焦点和页面版本，容易再次造成闪烁、抢焦点和升级失效。
- 一次性 Codex 计划任务：仍然引入计划任务调度延迟和计划记录，无法像 App Server 一样直接掌握会话状态。

## 架构

### CodexSessionClient

Taskboard 服务维护一个长期运行的 Codex App Server 子进程，并负责：

- 完成 App Server 初始化握手。
- 为请求分配 JSON-RPC ID 并匹配响应。
- 调用 `thread/start`、`turn/start` 和 `thread/read`。
- 监听 `thread/started`、`turn/started`、`turn/completed` 等通知。
- 在子进程意外退出后重新连接并恢复仍在处理的会话。

所有并发槽位共用一个客户端，避免每个任务启动一个额外 App Server 进程。

### AutoClaimController

自动认领控制器移动到 Taskboard 服务端，负责：

- 保存项目级开关、并发数、间隔、模型和推理强度。
- 在开关开启、任务状态变化、会话状态变化时立即协调槽位。
- 按配置间隔执行兜底协调。
- 优先处理已经存在但尚未绑定活动会话的进行中任务。
- 使用剩余槽位从待办认领新任务。
- 调用 CodexSessionClient 创建并启动会话。
- 在会话结束后根据任务执行状态释放、重试或转人工。

注入层不再负责创建或更新自动认领计划，只保留面板挂载和其他宿主交互。

## 数据模型

在自动化执行记录中持久化：

- `codex_thread_id`：当前会话 ID。
- `codex_turn_id`：当前轮次 ID。
- `codex_thread_status`：`starting`、`running`、`completed` 或 `failed`。
- `codex_last_error`：最近一次会话启动或恢复错误。

`run_owner_thread_id` 继续作为任务运行所有权字段。创建会话后、启动轮次前，控制器使用返回的 `threadId` 获取运行所有权。随后同一会话执行 `automation context` 时保持幂等。

评论中的 `threadId` 是任务详情显示会话链接的事实来源。任务本身的单一 `threadId` 字段不用于表达自动认领历史。

## 主数据流

### 开启自动认领

1. 控制器读取项目现有执行记录和并发限制。
2. 对已有进行中任务：
   - 有活动会话时继续等待。
   - 没有活动会话时创建新会话。
3. 对剩余空闲槽位调用现有 `fillProject` 认领待办并创建 Worktree。
4. 每个新认领任务只创建一个会话。

### 创建并启动会话

1. 调用 `thread/start`，传入任务 Worktree、模型和权限配置。
2. 获得真实 `threadId` 后，在数据库中绑定执行记录并获取运行所有权。
3. 自动创建一条带 `threadId` 的系统评论。
4. 调用 `turn/start`，传入自动认领提示词和 `code-loop-board` Skill。
5. 保存返回的 `turnId` 并将会话状态更新为 `running`。

运行所有权在 `turn/start` 前完成，因此定时协调或任务事件不会为同一执行再次创建会话。

### 会话正常完成

- 智能体已经调用 `automation complete`：执行完成、清理槽位并立即协调下一项。
- 智能体已经调用 `retry-merge`：保存十分钟后的 `mergeRetryAt`，到期后创建一次新的合并重试会话。
- 智能体已经调用 `pause-merge`：保留 Worktree，标记需要人工介入并释放并发容量。
- 会话结束但任务仍在开发中且没有完成动作：标记需要人工介入，保留 Worktree并释放并发容量，然后继续处理其他待办。

### 关闭自动认领

- 停止周期协调和新的会话创建。
- 不打断已经运行的 Codex 会话。
- 仍然接收已运行会话的完成事件并保存最终状态。

### 合并重试

- `MERGE_QUEUE_BUSY` 触发服务端记录十分钟后的重试时间。
- 到期后控制器创建一个新的直接会话，只执行合并步骤。
- 每次仍繁忙则再次等待十分钟。
- 达到五次后标记需要人工介入，不再创建会话。

## 失败与恢复

### `thread/start` 失败

不绑定会话、不创建会话评论，保存错误并在下一次协调时重试。

### `thread/start` 成功但 `turn/start` 失败

保存失败状态和错误，释放运行所有权，将任务标记为需要人工介入并释放并发容量。已创建但未运行的会话不会被当作活动会话恢复。

### App Server 断开

控制器暂停新会话创建。CodexSessionClient 重连后，对持久化的 `threadId` 调用 `thread/read`：

- 状态仍在运行：继续等待并恢复事件监听。
- 状态已经结束：按当前任务执行状态完成流转。
- 会话无法读取：记录错误并将任务转人工，避免盲目重复创建。

### Taskboard 服务重启

启动时先恢复所有 `starting` 和 `running` 会话，再开启自动认领协调。恢复完成前不认领新任务。

## 旧计划迁移

首次运行新控制器时：

1. 读取现有 Taskboard 自动认领计划 ID。
2. 仅暂停名称或提示词能确认属于 Taskboard 自动认领的计划。
3. 清除项目策略中保存的槽位计划 ID。
4. 后续自动认领不再调用 `automation-create` 或 `automation-update`。

用户创建的其他计划不受影响。

## 面板行为

- 开关仍控制自动认领。
- 并发数仍限制同时运行的直接会话数量。
- 间隔表示兜底协调周期，不再表示 Codex 计划任务频率。
- 模型和推理强度传给 `thread/start` 或 `turn/start`。
- 处理数量来自执行记录和真实会话状态。
- App Server 不可用时显示明确错误，不再显示“计划任务未运行”。

## 直接验证路径

准备两个待办并把并发数设为一：

1. 开启自动认领。
2. 确认第一个任务进入开发中。
3. 确认只创建一个 Codex 会话和一条带链接的任务评论。
4. 等待超过面板间隔，确认没有第二个重复会话。
5. 完成第一个任务，确认槽位立即认领第二个任务。
6. 让第二个会话在任务仍为开发中时异常结束。
7. 确认第二个任务转为需要人工介入、Worktree 被保留且并发槽位得到释放。
8. 确认 Codex 计划任务列表中没有新的 Taskboard 自动认领计划。

在用户确认主路径工作前，不扩展额外回归测试或兼容逻辑。

