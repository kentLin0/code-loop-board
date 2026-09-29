# 外部平台接入

## 用 AI 初始化两个定时任务

复制这句开始：

```text
请使用 $code-loop-board，按 skills/code-loop-board/references/scheduled-integrations.md
以逐步提问的方式初始化缺陷拉取和部署定时任务。先读已有配置，只问缺失或我要修改的内容，
让我粘贴缺陷列表来源地址和部署地址；把答案保存到本机配置文件，生成并验证脚本，
最后创建或更新两个计划，按引导闭环验证真实执行与数据回读，并将结果写入本机配置，
告诉我以后修改哪个文件。不要把真实资料写入公开示例。
```

完整问题顺序、脚本产物、计划提示词及修改流程见 [提问式引导](../../skills/code-loop-board/references/scheduled-integrations.md)，配置骨架见 [schedule-config.example.json](schedule-config.example.json)。页面确认按工具可用性优先选择 Playwright；没有时用浏览器控制插件；两者都没有才用 computer use。

## 推荐提示词

只接入缺陷平台、不创建定时任务时，复制下面的提示词：

```text
请为 Loop看板配置外部缺陷平台接入。先阅读 AGENTS.md、docs/integrations/AI-ADAPTATION.md、
docs/integrations/integrations.example.json 和 skills/code-loop-board/SKILL.md。
请先查询已有项目与连接，再逐步提问：让我粘贴缺陷列表来源地址，确认项目范围与筛选条件，
引导我在本机登录，最后询问可用于验证的事项及允许的动作。每轮只问一个主题。
确认的连接与项目映射保存到私有 integrations.json；页面入口与筛选字段按适配器契约保存。
缺文件先生成骨架，只问尚缺或我要求修改的内容，不覆盖已有配置，不使用示例 ID。
项目没有记录时引导我在嵌入式看板选择已识别的 Codex 项目，由看板自动创建后读取实际 ID。
页面确认优先用可用的 Playwright；没有时用浏览器控制插件；两者都没有才用 computer use。
根据真实观察生成 integrations/local/<provider-id>/provider.mjs 和 ADAPTER.md，
实际验证保存的脚本，只执行我授权的写入并回读结果，日常复用这些脚本。
不要在对话中收集密码、Cookie 或 token，不把真实资料写入公开示例。
最后报告配置路径、已验证操作、待配置项与修改方式；本流程不创建定时任务，不提交或推送 Git。
```

Loop看板通过保存的本地适配脚本接入缺陷系统。仓库没有预置公司平台、账号或已验证的远程连接。

## 缺少文件时如何配置

所有下列路径均相对于看板仓库根目录。没有 `integrations.json` 时，服务返回空连接列表，本地看板仍可使用。首次接入按以下顺序准备；只补缺失内容，不覆盖已有连接。

1. **连接配置**：复制 `docs/integrations/integrations.example.json` 为根目录 `integrations.json`，按下表替换示例。模块尚未实现、认证尚未准备好时，配置仍是待完成状态。
2. **适配模块**：创建 `integrations/local/<provider-id>/`，复制 `integrations/templates/playwright-provider.mjs` 为其中的 `provider.mjs`，复制 `integrations/templates/ADAPTER.md` 为同目录 `ADAPTER.md`。让 AI 观察真实平台后实现模块，并在连接配置中注册实际文件路径。
3. **认证文件**：浏览器模板要求 `.loop-integrations/<connectionId>/storage-state.json` 已存在。由你在本机完成登录，适配器通过 Playwright 保存会话，不手写空 JSON 代替登录。API 适配器则按其 `ADAPTER.md` 指定的本机文件或环境变量配置凭据。
4. **确认可用**：先检查能力声明，再真实读取你指定的样例。缺少登录态、模块或映射时先按提示补齐，不能继续声称同步成功。模块修改后重启本机服务，再验证受影响的操作。

| 配置字段 | 填写来源和含义 |
| --- | --- |
| `providers[].id`、`module` | 自定适配器 ID 及已保存模块的路径；相对路径以 `integrations.json` 所在目录为基准 |
| `connections[].id`、`providerId` | 自定连接 ID；providerId 必须匹配已注册适配器；connectionId 同时决定本机会话目录 |
| `connections[].baseUrl` | 你实际使用的平台实例地址 |
| `connections[].auth` | 适配器约定的认证引用。示例 `credentialsPath` 不是统一登录协议；浏览器模板实际读取上述 storage state |
| `connections[].options.chromeExecutable` | 本机 Chrome 可执行文件路径；示例是 Windows 路径，其他系统或安装目录需要自行修改 |
| `connections[].stateMap`、`actions` | 由适配器根据真实状态和操作填写；核心不会自动解释空映射或猜测平台字段 |
| `projects[].projectId` | 先在嵌入式看板选择自动识别出的 Codex 项目，由看板创建或复用记录；再用 `npm run clb -- project list --json` 查询实际 ID，不自行编造或重复创建 |
| `projects[].connectionId`、`scopeId` | 匹配连接 ID，以及从目标平台确认的项目/空间范围 ID |
| `projects[].filter`、`sync.closeOnSourceClosed` | 实际同步范围，以及源关闭时是否尝试关闭本地任务；默认不自动关闭 |
| `projects[].delivery` | 交付模式及实际 repositoryId/目标分支。review 允许 repositories 为空，但自动认领时空列表表示使用发现的全部仓库，不表示禁止代码交付；release 必须指定仓库 |

配置字段的具体认证格式、筛选条件和映射格式由保存的适配器在 `ADAPTER.md` 中说明。无法确认的字段应保留为待配置项，不能直接使用 `example-*`、`tracker.example.com` 或示例 `app/main` 值运行真实同步。

自动认领时，repositoryId 必须匹配实际代码仓库的目录名，targetBranch 必须匹配该仓库当前检出的分支；配置不会替你切换母仓库分支。协调器发现工作区本身的 Git 仓库，或其直接子目录中的 Git 仓库，不递归搜索任意深度。仅希望同步事项、不执行代码时，应保持自动认领关闭，不能靠空 repositories 列表控制。

## 实施与使用

以下命令展示 CLI 参数。未全局安装 `clb` 时，在看板仓库根目录使用 `npm run clb --` 替代命令开头的 `clb`；固定 runner 场景使用提示词提供的入口。`ISSUE_ID` 是已导入的看板事项 ID/编号，不是源平台编号。首次同步前的单条源事项验证，由 AI 直接调用保存模块的 `getIssue` 完成。

1. 阅读 [AI 适配指南](AI-ADAPTATION.md)，向 AI 提供目标平台、项目范围、允许的认证方式和样例事项。
2. 以 `integrations/templates/playwright-provider.mjs` 为入口创建 `integrations/local/<provider-id>/provider.mjs`，按真实 API/页面实现能力，在同目录 `ADAPTER.md` 记录观察与验证结果。API 访问也实现同一接口。
3. 参考 [连接配置示例](integrations.example.json)，在仓库根目录创建私有 `integrations.json`；凭据和浏览器状态由本地引用传入，不写入模块。
4. 用 inspect 查看声明的能力，再执行授权的同步或事项动作。修改模块后重启本机服务；连接 JSON 在每次调用时读取。

```text
clb integration inspect --json
clb integration inspect --connection CONNECTION_ID --json
clb integration sync --connection CONNECTION_ID --project PROJECT_ID --thread-id THREAD_ID --json
clb integration get ISSUE_ID --json
clb integration action ISSUE_ID --action start_work --thread-id THREAD_ID --json
```

`--parameters-file` 为 action 提供必要的 JSON 参数。sync/action 可通过 `CODEX_THREAD_ID` 归属当前会话。

运行时只调用适配器 `describe` 声明的能力。模板的能力列表为空，必须实现并验证后再声明，不能把空模板当成已接通的平台。

外部 action 成功必须检查 `ok`、`verified`、`state.semantic` 和 `localCompleted`，不能只看 CLI 退出码。`changed:false` 可以表示已达到目标；`externalCompleted:true,localCompleted:false` 表示先补本地记录，不能自动再次写源平台。inspect/get/sync 没有这些动作结果字段；sync 应查看 created/updated/skipped 列表，批次失败前可能已有部分事项写入。

同步按结构化身份查重，保留任务修复正文与仓库快照，源评论按 ID 去重。closeOnSourceClosed 是否启用由连接的项目配置决定，移动仍遵守项目 JSON 状态规则。

发布扩展位于 `server/integrations/releases.mjs`，支持独立的 releaseProviders/releaseConnections 和 triggerRelease/getRelease。当前只是供代码调用的服务模块，尚无发布 HTTP 路由或 CLI 命令，也没有内置 CI 实现或自动发布定时任务。按上述引导，AI 根据用户答案生成本机发布 runner，实际验证目标 CI，再通过可用调度工具创建计划；仅填写连接 JSON 不会启动发布。

本地私有配置、认证状态、运行截图和验证材料由 `.gitignore` 排除。准备公开自己的适配包时，还应将租户地址、账号和实际事项内容移出代码与 ADAPTER.md。
