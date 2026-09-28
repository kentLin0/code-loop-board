# Loop看板：JSON 状态与平台适配设计

状态：已批准并实施；真实外部平台需提供目标实例和授权样例后接入。

## 产品与边界

产品可见名称为 Loop看板，Skill 为 `code-loop-board`。任务核心负责看板、执行、仓库交付和数据保存；平台脚本负责认证、列表、详情及源事项动作。平台脚本由 AI 按需生成、验证并保存，日常任务复用。

仓库提供通用接口、连接示例和 Playwright 模板，不包含任何内置业务平台或公司配置。CLI、API、数据库和前端不依赖具体平台字段、URL 或状态名。

## 看板 JSON

默认文件为 `loop-board.default.json`。完整自定义示例见 [JSON 示例](2026-09-28-loop-board.example.json)。

- `states`：状态 ID、名称、分类、颜色、图标、是否可直接创建；数组顺序为列顺序。
- `initialState`：新建默认状态。
- `manualTransitions`：人工可执行的状态流转。
- `automation`：功能开关和 ready、working、approval、releaseReady、releasing、review、blocked、done、canceled 的实际状态绑定。

所有状态 ID 可自定义。机器动作仍有明确语义，配置决定它们进入哪个状态。执行阶段 `phase` 与看板状态分离，审批操作必须通过审批入口执行。

`clb board-config export --project PROJECT_ID --output loop-board.json` 导出；`clb board-config apply --project PROJECT_ID --file loop-board.json` 导入。

GET/PUT `/api/projects/:id/board-config` 返回 `{version,config}`。SQLite 或 D1 保存生效快照，前端及执行器读取项目生效配置。替换已有任务使用的状态 ID 时，需要 `--status-mapping-file` 明确迁移；未完成执行（包括 paused_for_human）存在时，不能更换状态 ID、任务状态映射或 automation 配置。CLI apply 会在写入前读取最新版本，版本检查只覆盖此次读写之间的并发变化，并不保护从导出到编辑期间的变化；需要保留特定版本前提时用 PUT 显式传入预期 version。

## 来源和交付

任务以 `externalIssue` 保存来源身份：connectionId、scopeId、externalId、key、url。去重身份为本地 projectId + connectionId + scopeId + externalId。描述只承担正文，不作为机器协议。

`externalState` 保存源状态 ID、名称、标准语义及采集时间；与看板状态分别保存。标准语义包括 new、reopened、working、fixed、verifying、closed、unmapped。

`delivery` 保存 review/release 模式和 `{repositoryId,targetBranch}` 列表。repositoryId 匹配实际仓库目录名，targetBranch 匹配认领时当前分支；协调器不会按配置自动切换母仓库分支。review 模式的空列表表示认领时使用发现的全部仓库，release 必须指定仓库。支持单仓和多仓，不固定前后端角色。导入后的交付配置不会被同步覆盖，认领时的具体执行快照保存在 execution 中。

旧描述数据不自动猜测身份；已有来源需要明确映射后通过正式 API 写入结构化字段。

## 适配接口

连接配置存于本地 `integrations.json`，包含 providers、connections 和 projects。适配模块来自配置中显式注册的本地文件。

| 操作 | 职责 |
| --- | --- |
| describe | 声明实际实现的能力 |
| listIssues | 按项目/筛选条件读取分页事项 |
| getIssue | 读取指定身份的标准详情 |
| applyAction | 执行 start_work、mark_fixed 等动作并返回核验结果 |

`clb integration inspect/get/sync/action` 通过本机 `/api/local/integrations/*` 路由调用。浏览器和凭据留在本机；通用数据通过现有本地/云端 API 保存。

动作结果包含 ok、verified、changed、issue、state、externalCompleted、localCompleted。只有实际状态可核验且本地记录完成才继续工作；外部完成但本地保存失败时先读取两侧结果，不重复源写入。

发布服务模块在 `server/integrations/releases.mjs` 提供 triggerRelease/getRelease，不绑定缺陷平台，不内置 CI。目前未接入 HTTP/CLI 或定时调度，不能仅配置 JSON 就触发发布；接入目标 CI 时还需实现调用入口并验证。

## AI 引导与技能

[AI 适配指南](../../integrations/AI-ADAPTATION.md) 定义探索真实页面/API、保存脚本、认证引用、验证和维护方法。[平台接入说明](../../integrations/README.md) 给出目录、配置和命令。

`skills/code-loop-board/SKILL.md` 按配置、普通任务、自动执行、适配维护组织；所有看板状态先读取 JSON，不依据列名称或旧描述推断。

## 实施路径与确认

1. 配置 JSON → CLI 导入 → 页面渲染自定义状态 → 创建/移动 → 数据库保存 → 刷新显示一致。
2. 结构化来源 → 保存适配模块 → 同步 → 认领 → 标准源动作 → 本地记录核验。
3. 配置仓库与交付模式 → Worktree 执行 → 审批或交付 → 配置目标状态。

已进行的本地/云端/浏览器验证与实际外部验证必须分开报告。默认不添加额外回归测试工程。工作区改动留给用户审查和提交，不进行 Git 暂存、提交或推送。
