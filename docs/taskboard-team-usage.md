# Loop看板使用手册

首次使用建议复制 [README 开头的 AI 自动配置提示词](../README.md#推荐让-ai-帮你配置)，让 AI 先检查现有环境和缺失文件。只接入外部系统时使用 [平台接入提示词与配置说明](integrations/README.md)。真实账号、密钥与登录操作由各成员在自己的机器上完成。

Loop看板负责管理本地任务、状态和执行会话，外部缺陷平台由项目选择的适配器接入。团队成员可以使用相同 JSON 状态定义和适配器脚本，分别保存各自的登录凭据与仓库路径。

## 首次使用

1. 在仓库根目录运行 `npm install` 和 `npm run build:web`。
2. 启动服务：`npm start`；打开 <http://127.0.0.1:47824>。
3. 需要嵌入 Codex 时，运行 `npm run codex`，或在仓库对话发送“启动Loop看板”。
4. 在嵌入式 Loop看板中选择自动识别出的 Codex 项目；首次选择会自动创建对应看板记录，已有记录直接复用。无需提前手动创建项目。安装 `skills/code-loop-board` 后可让 AI 通过 `$code-loop-board` 操作事项。

仅使用独立网页或 CLI、没有 Codex 宿主项目上下文时，可以通过 `project create` 补充所需项目；云端协作按云端文档配置每台设备的仓库路径映射。

所有成员使用自己的绝对路径；共享示例中使用 `/absolute/path/to/repository` 等占位符。不同成员不得共享包含 Cookie、token 或浏览器 storage state 的文件。

## 状态配置

先在看板选择目标项目，再用 `npm run clb -- project list --json` 查询其实际 ID。将下列 `PROJECT_ID` 替换为该 ID，导出项目当前状态 JSON，再修改并应用：

```bash
npm run clb -- board-config export --project PROJECT_ID --output loop-board.json
npm run clb -- board-config apply --project PROJECT_ID --file loop-board.json
```

参考根目录 [loop-board.default.json](../loop-board.default.json)。状态的显示名称、颜色、顺序、手动流转与自动化动作绑定在同一份配置中维护。自动认领读 `ready`、`working` 等语义绑定，不依赖团队给列起的名字。

修改后重新获取项目配置，检查列顺序和允许的流转；已有事项引用的状态不能直接移除。自动化需要的动作必须绑定到实际存在的状态。

## 提问式生成两个定时任务

向 AI 发送：“使用 $code-loop-board，按定时任务初始化引导，逐步问我问题并把答案保存到配置文件，生成缺陷拉取和部署计划。”完整步骤见 [引导](../skills/code-loop-board/references/scheduled-integrations.md)。AI 先问缺陷列表地址和部署地址，再确认范围、环境、周期及时区，生成脚本并验证；最后闭环验证来源、看板、构建和真实调度运行，并将结果写回配置；两个任务的实际 ID、运行状态和未完成项会分别报告。

以后修改 `.loop-integrations/<实际项目ID>/schedule-config.json` 中的配置。地址、筛选范围和部署参数由生成的 runner 每轮读取；周期、时区或启用状态变更后，让 AI 按原计划 ID 更新调度器并回读。页面结构或连接契约变化还需维护适配器并验证，不能只改地址就声称适配完成。

## 自动认领与外部同步

| 入口 | 职责 |
| --- | --- |
| 看板“自动认领” | 按项目状态绑定领取事项并关联 Codex 会话与 Worktree |
| 平台适配器 | 读取外部事项、映射字段、执行受支持的状态写回 |
| AI 引导生成的定时同步 | 读取本机配置，经固定 runner 调用 integration sync；计划登记在用户所用调度器中 |
| AI 引导生成的部署计划 | 先生成并验证本机发布 runner，再由调度器定期调用；核心仍只提供发布服务模块 |

这些入口独立配置。开启自动认领不会自动创建平台定时同步，也不会为项目自动部署发布流水线。

## 让 AI 适配新平台

参考 [平台适配指南](integrations/README.md)，可以向 AI 提出：

> 为当前项目接入缺陷管理平台。先读取现有适配协议和项目看板 JSON，确认真实列表、详情、字段与状态流转入口。确认页面优先用可用的 Playwright；没有时用浏览器控制插件；两者都没有才用 computer use。根据真实 API 或页面生成并保存适配脚本。把平台选择器和字段映射放入适配器，核心代码只使用统一协议。登录凭据和真实地址从本机私有配置读取。先演示读取一条事项，再用指定的验证事项执行获准的写操作，回读确认目标字段和其他业务字段，保存验证结果后复用脚本。页面结构改变时再更新适配器，不在每个日常任务中重新生成。

没有实际平台账号和验证事项时，只能完成脚本与协议检查，不得报告外部平台已接入成功。

## 发布到 GitHub

共享通用脚本、协议、状态示例和不含业务数据的文档；真实地址、账号、认证缓存和截图留在被忽略的私有目录。生成脚本时同样检查注释、测试数据、日志和文件名，不把生产项目信息复制进公开材料。

本机 `.data/` 保存项目和事项运行数据，不能随仓库发布。云部署配置从 `wrangler.example.jsonc` 复制到私有 `wrangler.jsonc` 后填写，操作方法见 [云端协作](cloud-collaboration.md)。

