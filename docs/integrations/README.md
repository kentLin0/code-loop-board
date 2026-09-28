# 外部平台接入

## 推荐提示词

在本仓库的 Codex 对话中复制下列内容，填写平台和项目资料；不清楚的字段可以标记“待确认”，让 AI 说明从哪里获取。

```text
请为 Loop看板配置外部缺陷平台接入。先阅读 AGENTS.md、docs/integrations/AI-ADAPTATION.md、
docs/integrations/integrations.example.json 和 skills/code-loop-board/SKILL.md。

目标平台与实例：[名称、地址]
本地看板项目：[使用当前 Codex 项目，或指定已有项目名称]
来源项目范围：[平台项目 ID 或路径]
认证方式：[浏览器登录 / API 凭据 / 待确认]
读取样例：[一条事项链接或 ID]
允许写入的样例与动作：[暂不写入，或明确的事项和动作]

先识别已有 Codex 项目并查询对应看板记录，使用实际项目 ID，不重复手动创建。
如果尚无看板记录，引导我在嵌入式 Loop看板中选择一次该项目，由看板自动创建记录。
再检查 integrations.json、注册的适配模块和认证文件是否存在。
缺失时列出模板、目标路径和待填字段；可以生成配置骨架，但真实地址、项目标识及
认证信息必须以我提供或实际确认的资料为准。需要我自行配置的部分，逐项说明如何获取、
在哪里填写、完成后运行什么命令；引导我在本机登录或填写凭据，不在对话中收集秘密。
不要覆盖已有配置，不把示例占位符当作有效配置。

按真实 API 或页面实现并保存 integrations/local/<provider-id>/provider.mjs 和 ADAPTER.md。
核对身份、状态及动作映射，读取样例后再同步；只执行上面明确允许的外部写入并回读核验。
日常任务复用已保存的脚本。inspect 成功只能说明能力声明可读取，不能据此宣称平台已接通。
结束时报告已配置、待我配置和已验证的项目，不提交或推送 Git。
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

发布扩展位于 `server/integrations/releases.mjs`，支持独立的 releaseProviders/releaseConnections 和 triggerRelease/getRelease。当前只是供代码调用的服务模块，尚无发布 HTTP 路由或 CLI 命令，也没有内置 CI 实现或自动发布定时任务；仅填写连接 JSON 不会启动发布，需要另行实现调用入口并验证目标 CI。

本地私有配置、认证状态、运行截图和验证材料由 `.gitignore` 排除。准备公开自己的适配包时，还应将租户地址、账号和实际事项内容移出代码与 ADAPTER.md。
