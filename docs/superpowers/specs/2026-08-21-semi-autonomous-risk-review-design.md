# 半自动驾驶与风险变更审批设计

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

## 状态

已于 2026-08-21 完成需求确认。

## 目标

任务面板继续使用独立 Git Worktree 并发修复缺陷，但在代码合并前增加由协调器执行的确定性风险判断。低风险修改保持全自动交付；高风险修改进入“待审批”，由人工在任务详情中查看 GitLab 风格的单文件 Diff，并选择通过或驳回。

本设计满足以下约束：

- 保留现有并发 Worktree，不把并发修改复制到母仓库工作目录。
- 变更行数达到配置阈值时必须审批，默认阈值为 50 行。
- 支持黑名单或白名单目录策略，两者有且只有一个。
- Git 忽略规则命中的文件不参与风险判断。
- 等待审批的任务释放自动认领并发槽位，但保留 Worktree 和审阅快照。
- Diff 采用单文件懒加载，并按文件语言提供语法高亮。

## 非目标

- 不取消 Worktree，也不改为直接在母仓库工作目录并发修改。
- 不在数据库中永久保存每个文件的完整 Diff 文本。
- 不依赖 Codex 根据提示词自行判断风险。
- 不将审批改动串行化；通过审批后的任务仍沿用现有并行 rebase、冲突处理和 push 逻辑。
- 不在本次设计中建设通用代码托管或 Pull Request 平台。

## 当前操作链路与插入点

当前自动化提示在 `shared/taskboard-automation.mjs` 中要求 Codex：

1. 在任务绑定的 Worktree 中分析、修改、验证和提交。
2. 调用 `automation acquire-merge`。
3. 在各自 Worktree 中 fetch、rebase、处理冲突、验证并普通 push。
4. 调用 `automation complete`，由 `server/taskboard-worktree-coordinator.mjs` 和 `server/database.mjs` 完成状态流转及 Worktree 清理。

风险闸门插入 `automation acquire-merge`。此时本地任务提交和验证已经完成，但尚未执行 rebase 或 push，可以阻止未经审批的高风险改动进入目标分支。

## 状态与执行流程

新增任务状态 key `pending_approval`，中文名为“待审批”。新增两个不占用并发槽位的执行阶段：`awaiting_approval` 表示代码修复已经完成、正在等待人工决定；`approval_granted` 表示审批已经通过、正在等待空闲合并槽位。

```text
Codex 在独立 Worktree 修复、测试、提交
                ↓
调用 automation acquire-merge
                ↓
协调器生成审阅快照并执行风险规则
        ┌───────┴────────┐
      低风险             高风险
        ↓                  ↓
继续并行合并、推送      pending_approval
        ↓                  ↓
现有完成流转           释放槽位，保留 Worktree
                           ↓
                     人工查看 Diff
                    ┌──────┴──────┐
                  审批通过        驳回
                    ↓              ↓
             approval_granted     blocked
                    ↓              ↓
             有空槽位时切换为       保留 Worktree
             ready_to_merge 并续跑
                    ↓
             合并、推送、完成
```

具体规则：

- 低风险：`automation acquire-merge` 返回自动通过结果，当前 Codex 会话继续现有合并、push 和完成路径。
- 高风险：协调器保存审阅快照，将任务移入 `pending_approval`，释放运行令牌和并发槽位；当前会话收到需要审批结果后立即结束，不允许 fetch、rebase 或 push。
- 审批通过：保存人工决定，将执行阶段改为不占槽的 `approval_granted`，并把卡片恢复为 `in_progress`。自动认领控制器将该任务排在新待办任务之前；有空槽位时重新分配槽号、切换为 `ready_to_merge`，再使用原执行记录和原 Worktree 启动续跑。续跑只执行合并阶段。
- 驳回：要求人工填写原因，任务进入 `blocked`，Worktree 保留供人工检查或后续重新认领。
- Worktree 仅在现有 `automation complete` 成功后清理。

## 配置文件

任务面板根目录新增两个文件：

- `review-policy.json`：本机实际配置，加入 `.gitignore`。
- `review-policy.example.json`：团队共享模板，可提交。

配置示例：

```json
{
  "$schema": "./review-policy.schema.json",
  "version": 1,
  "defaults": {
    "changedLinesThreshold": 50,
    "blacklist": [
      "frontend/src/flow/**",
      "backend/apps/flow/**"
    ]
  },
  "projects": {
    "example-project": {
      "changedLinesThreshold": 80,
      "whitelist": [
        "frontend/src/views/**",
        "backend/apps/*/tests/**"
      ]
    }
  }
}
```

`projects` 使用任务面板项目名称选择覆盖配置。项目的目录策略为原子覆盖：项目出现 `blacklist` 或 `whitelist` 时，完整替换默认目录策略；`changedLinesThreshold` 等其他字段可单独继承默认值。

### 黑白名单强约束

新增 `review-policy.schema.json`，对默认配置和每个项目配置使用 `oneOf`，要求：

- 必须包含 `blacklist` 或 `whitelist`。
- 不能同时包含两者。

该约束在三层执行：

1. JSON Schema 为编辑器提供即时提示。
2. `ReviewPolicyLoader` 在启动和重新加载时校验原始配置及项目覆盖后的最终配置。
3. `RiskReviewEvaluator` 执行前断言最终策略只有一种目录模式。

配置无效时任务面板仍可读，但自动认领暂停、不创建新会话，已修复任务也不允许自动合并。自动认领面板显示配置文件路径和具体字段错误。修复配置后自动重新加载并恢复，不要求重启 Codex。

## 风险判定

`RiskReviewEvaluator` 读取每个任务 Worktree 的 `baseCommit..headCommit`，形成一次不可变的审阅快照。

### 行数规则

- 总变更行数为所有仓库新增行数与删除行数之和。
- 总变更行数大于或等于 `changedLinesThreshold` 时需要审批。
- 二进制文件不计入行数，但仍参与目录策略判断。

### 目录规则

- 黑名单模式：任意变更路径命中黑名单即需要审批。
- 白名单模式：任意变更路径不在白名单即需要审批。
- 白名单内的全部修改只有在总行数低于阈值时才能自动通过。
- 重命名同时检查旧路径和新路径，避免通过重命名绕过规则。
- 路径归一化为 `frontend/...`、`backend/...`。仓库角色沿用现有 `frontend`、`*frontend`、`backend`、`*backend` 识别方式，不在实现中写死业务仓库名称。
- 使用仓库有效 Git ignore 规则排除被忽略路径；被排除文件不参与行数和目录判断。

风险结果保存所有命中原因，例如：

- `149 行 >= 50 行`
- `修改了黑名单目录 frontend/src/flow/**`
- `backend/apps/common/service.py 不在白名单中`

## 组件边界

### ReviewPolicyLoader

读取、校验和合并 `review-policy.json`；提供按项目解析后的只读策略。配置重新加载使用完整的新快照，不能部分更新当前策略。

### RiskReviewEvaluator

接收执行记录、仓库上下文和最终策略，返回自动通过或需要审批，以及文件统计和命中原因。该组件不修改任务状态。

### ReviewSnapshotStore

持久化待审批快照及人工决定，包括执行 ID、任务 ID、版本、各仓库基准提交和任务提交、文件统计、命中规则、决定人、意见及时间。

### WorktreeDiffService

根据快照生成文件清单和单文件 Diff。它不负责审批和状态流转，也不缓存跨快照结果。

### AutoClaimController

负责高风险任务释放槽位，以及审批通过后将 `approval_granted` 任务排在新待办任务之前分配空闲槽位、切换为 `ready_to_merge` 并恢复执行。

### 变更审批界面

在现有任务详情 `TaskDetail` 中新增“变更审批”页签。该界面只展示快照并调用审批接口，不直接操作 Git。

## 审批入口与界面

主入口位于任务面板“待审批”列：

1. 待审批任务卡片展示“查看变更”和总增删行数。
2. 点击“查看变更”打开现有任务详情，并默认定位到“变更审批”页签。
3. 点击普通任务卡片仍进入同一任务详情，可手动切换页签。
4. 自动评论记录风险原因并提供“查看变更”入口，但不嵌入完整 Diff。

审批页采用已确认的单文件工作台：

- 顶部显示任务、文件数量、总增删行和风险原因。
- 左侧展示可筛选的变更文件树和每个文件的增删统计。
- 右侧一次展示一个文件的统一 Diff。
- 底部提供“驳回并转为已阻塞”和“审批通过”。
- 驳回必须填写原因。

代码区保留红绿增删背景，并使用 PrismJS 对当前文件进行语言语法高亮。JavaScript、TypeScript、Vue、Python、JSON 等常见语言按需加载规则；未知文件退化为已转义的纯文本。高亮只影响文字颜色，不改变 Diff 行号和增删背景。

## 数据与接口

数据库只保存审阅快照元数据，不保存完整 Diff 文本。新增独立的 `automation_reviews` 表，使审批状态与自动化执行记录保持清晰边界。表中包含审阅 ID、任务 ID、唯一执行 ID、状态、乐观锁版本、各仓库基准与任务提交、文件统计、风险原因、审批人、审批意见、创建时间和决定时间。审批人使用任务面板当前用户身份；未启用用户身份的本地部署统一记录为 `local-user`。

接口：

- `GET /api/local/automation/tasks/:id/review`：返回风险摘要、文件清单、快照版本和审批状态。
- `GET /api/local/automation/tasks/:id/review/diff?repository=...&path=...`：返回选中文件的单文件 Diff。
- `POST /api/local/automation/tasks/:id/review/approve`：携带快照版本和可选意见，审批通过。
- `POST /api/local/automation/tasks/:id/review/reject`：携带快照版本和必填原因，驳回。

这些接口沿用现有 `/api/local/` 回环地址限制。接口中的仓库和文件必须来自当前快照文件清单；服务端拒绝路径穿越、未知仓库和快照外文件，不接受任意本地路径。

## 性能设计

- 首屏仅使用 `git diff --numstat --name-status` 获取文件清单和统计。
- 点击文件时才执行该文件的 `git diff baseCommit headCommit -- path`。
- 前端一次只保留当前文件的代码 DOM，切换文件时释放上一文件。
- 大文件按区块加载；二进制文件仅展示摘要。
- 单文件结果按执行 ID、基准提交、任务提交和文件路径进行短期内存缓存。
- PrismJS 仅为当前文件加载对应语言并高亮，不对未打开文件执行解析。
- Diff 文本统一转义，不执行文件中的 HTML 或脚本。

## 一致性与异常恢复

- 打开审批页和提交审批前复核 Worktree HEAD 是否等于快照 `headCommit`。
- HEAD 变化时旧快照失效，审批接口返回版本冲突，并重新生成风险快照。
- 两人同时审批使用快照版本做乐观锁，只有第一个决定生效。
- Worktree、`baseCommit` 或 `headCommit` 丢失时禁止合并，任务转为 `blocked` 并释放槽位。
- 单文件 Diff 临时读取失败不改变审批状态，页面显示可重试错误。
- 服务重启后从数据库恢复待审批记录；内存缓存丢失只会触发 Diff 重新生成。
- 评论写入失败不回滚已经持久化的审批决定；系统记录错误并允许补写评论。
- 审批通过后的并发 push 冲突继续使用现有 fetch、rebase、语义化解决和最多五次重试规则。

## 首轮直接验收

按照仓库开发规则，首轮实现后只证明请求的真实操作路径，不提前扩展无关保护：

1. 低于阈值且符合白名单的修改继续自动合并。
2. 恰好达到阈值、命中黑名单或超出白名单的修改进入“待审批”。
3. 待审批卡片能够打开单文件懒加载、语法高亮的 Diff。
4. 审批通过后原 Worktree 优先续跑并完成现有合并流程。
5. 驳回后任务进入已阻塞，Worktree 保留。
6. 黑白名单同时存在或同时缺失时，自动认领暂停并显示明确配置错误。

功能经用户在真实任务中确认后，再根据实际失败场景或明确要求增加针对性回归保护。

