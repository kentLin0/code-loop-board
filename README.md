# CodeLoop看板

## 推荐：让 AI 帮你配置

在 Codex 中打开本仓库，复制下面的提示词。AI 会先读取已有配置，再逐步提问；你可以对不需要的功能回答“不启用”。

```text
请帮我配置并运行这个仓库的 Loop看板。先阅读 AGENTS.md、README.md 和
skills/code-loop-board/SKILL.md，检查现有环境与配置，再完成可以自动执行的步骤。

请以提问的方式引导我，不要先给一张长表让我自行研究。先确认已有项目、看板状态和
运行方式（本地网页 / 嵌入 Codex / 云端协作）。然后询问是否初始化缺陷拉取与部署。
启用时读取 skills/code-loop-board/references/scheduled-integrations.md，先问我要粘贴的
缺陷列表来源地址和部署地址，再逐步询问同步范围、部署环境、仓库/分支、周期与时区。
每轮只问一个主题，答案及时保存到被忽略的 .loop-integrations/<实际项目ID>/schedule-config.json；
使用 docs/integrations/schedule-config.example.json 作骨架，保留已有值，只问缺失或要改的项。
平台连接写入 integrations.json；基础运行方式使用该本机配置的 setup 字段记录。
页面确认按工具可用性选择：优先 Playwright；没有才用浏览器控制插件；再没有才用
computer use。不依次调用三种工具，不因页面操作报错自动换工具。

完成基础环境准备后，按我选择的运行方式实际启动：
- 仅当运行方式为“嵌入 Codex”时，执行 AGENTS.md 中的“启动Loop看板”流程，
  在 Codex 内打开看板，不要只提供命令。需要重启时使用规定的启动器流程；
  确认服务正常、面板及 iframe 可见且收到页面就绪消息后，再报告启动成功。
- 运行方式为“本地网页”时，启动本地服务并打开网页，不执行嵌入启动流程。
- 运行方式为“云端协作”时，按云端文档配置并连接指定的共享看板，
  不因这个选项自动执行嵌入启动流程或重启 Codex。

优先查询已有看板项目记录，不要求我重复手动创建项目。
在嵌入模式下识别 Codex 已有项目；如果尚无看板记录，引导我在已打开的
Loop看板中选择一次该项目，再读取实际项目 ID。其他模式直接使用已有看板项目。
不要猜测 ID 或使用示例 ID；只有我明确需要新项目时才手动创建。
再按所选功能列出缺少的配置文件、对应模板、保存位置和待填写字段。
可以从模板生成本机配置骨架，但不要覆盖已有配置或编造真实值。
需要我提供的信息，请说明具体字段、取得方式和填写位置；账号、密钥由我在本机填写，
需要登录时引导我完成登录，不要求我把密码、Cookie 或 token 发到对话里。
缺少某项输入时，继续完成不依赖它的配置，并列明未完成项。

自定义状态请先导出项目当前 JSON，修改后通过 board-config apply 应用并回读。
如需接入外部平台，读取 docs/integrations/AI-ADAPTATION.md，按实际 API 或页面
生成、验证并保存适配脚本，日常复用；真实写入只限我明确指定的样例和动作。
若我选择初始化定时任务，按引导生成所选的独立计划，复用已有计划；每轮读取本机配置。
部署 runner 尚未内置，要按实际平台生成并验证，不能调用不存在的发布命令。
缺少配置或验证的计划保持暂停；没有调度工具则保存待创建提示词并说明如何在工具中创建。
交付时给出配置文件位置和修改方法；修改周期/时区后还要更新调度器并回读，不能只改 JSON。
跑完按定时任务引导做闭环验收，回读来源、看板、构建及实际调度记录；没有运行证据就标记待验证。
最后分别报告已生成的文件、我还需填写的配置、已验证的操作和未验证部分。
不要提交或推送 Git，也不要把本机配置或凭据写入公开示例。
```

希望 AI 逐步提问并生成两个定时任务时，使用 [定时任务初始化引导](skills/code-loop-board/references/scheduled-integrations.md)。只需接入缺陷系统时，可以直接使用 [平台接入提示词](docs/integrations/README.md#推荐提示词)。

Loop看板是本地优先的 AI 任务看板，将事项、评论、附件、工作流、Worktree 和 Codex 会话关联起来。看板状态由项目 JSON 配置决定；外部缺陷系统通过独立适配器接入，核心不内置某个平台的登录方式、页面选择器或状态名。

## 缺少配置文件时

首次仅运行本地看板，无需先创建外部平台或云端配置；服务会创建本地数据，状态使用仓库提供的默认 JSON。按需要启用的功能补充以下文件，已有文件应先读取再修改。

| 使用场景 | 本机文件与来源 | 需要你配置的内容 |
| --- | --- | --- |
| 自定义看板状态 | 用 `board-config export` 导出项目配置为 `loop-board.json`，命令见下文 | 状态、流转和自动化绑定；编辑后必须 apply 才生效，不会自动读取这个文件 |
| 接入外部缺陷平台 | 将 [连接示例](docs/integrations/integrations.example.json) 复制到仓库根目录 `integrations.json` | 实例地址、连接和项目 ID、来源项目范围、模块路径、认证引用及字段/动作映射，详见 [配置说明](docs/integrations/README.md#缺少文件时如何配置) |
| 实现平台适配 | 从 [Playwright 模板](integrations/templates/playwright-provider.mjs) 创建 `integrations/local/<provider-id>/provider.mjs`，同目录保存 `ADAPTER.md` | 由 AI 根据真实平台实现；模板本身不能读写平台，不能只复制后就当作接通 |
| 缺陷拉取与部署定时任务 | 从 [计划配置模板](docs/integrations/schedule-config.example.json) 生成 `.loop-integrations/<实际项目ID>/schedule-config.json` | AI 逐步提问并保存来源/部署地址、范围、环境、周期等；脚本每轮读取，周期/时区/启用状态修改后还需同步调度器，详见 [引导](skills/code-loop-board/references/scheduled-integrations.md) |
| 平台认证 | 按适配器约定准备本机凭据；现有浏览器模板读取 `.loop-integrations/<connectionId>/storage-state.json` | 你完成真实登录，由适配器保存会话；API 认证方式及凭据格式由具体适配器定义 |
| 自定义自动化审批规则 | 将 [规则示例](review-policy.example.json) 复制到实际被处理的代码仓库根目录 `review-policy.json` | 团队需要的变更阈值和路径规则；不是启动看板的必需文件 |
| 云端协作 | 将 [部署模板](wrangler.example.jsonc) 复制到根目录 `wrangler.jsonc`；本地模拟另需 `.dev.vars` | 自己的 Worker、D1、R2 和域名配置；本地密钥填写方式见 [云端协作](docs/cloud-collaboration.md) |

未接入平台时没有 `integrations.json` 是正常情况；不使用云端时无需创建 `wrangler.jsonc` 或 `.dev.vars`。表中的 `<provider-id>`、`<connectionId>` 是需要替换的占位符，不是实际目录名称。真实认证内容由用户本机填写，AI 应提示缺失项及路径，不生成虚假账号或空登录态。

## 快速开始

从源码安装和构建需要 Node.js 22.12 或更高版本、Git；本次实际验证使用 Node.js 24.19。虽然根 package.json 声明 >=22.5，当前 Vite 构建依赖要求更高，不能以 22.5 作为完整使用流程的最低版本。嵌入侧栏需要 Codex 桌面版；AI 会话、Skill/MCP 发现及自动认领还需要可用的 Codex CLI。

```bash
npm install
npm run build:web
npm start
```

打开 <http://127.0.0.1:47824>。本地数据默认位于 `.data/taskboard.sqlite`。开发时运行 `npm run dev`，前端地址为 <http://127.0.0.1:5173>。

在 Codex 中打开本仓库后发送“启动Loop看板”，或手动运行：

```bash
npm run codex
```

启动器复用已开放 9229 调试端口的窗口；必要时通过 Windows 计划任务安排重启。启动成功需要服务健康、调试端口可访问、侧栏入口与面板可见，并收到 iframe 就绪消息。详细启动规则见 [AGENTS.md](AGENTS.md)。

## 项目与事项

在 Codex 内使用时，Loop看板自动识别 Codex 的项目列表。首次在看板中选择某个项目时，会用该项目的 ID 和名称自动创建对应看板记录；已有记录直接复用，无需先执行 `project create`。项目列表识别与看板记录创建是两个步骤，未选择的 Codex 项目不一定已经出现在 CLI 查询结果中。

选择项目后，可以查询其实际 ID，再操作事项。下面的 `PROJECT_ID` 均替换为查询到的 ID，不另取一个示例 ID：

```bash
npm run clb -- project list --json
npm run clb -- issue create --project PROJECT_ID --title "实现下一项功能" --priority high
```

新事项默认进入项目 JSON 定义的初始状态。仅在独立网页/CLI 使用、没有 Codex 宿主项目上下文且确需新增项目时，才使用 `project create`；手动命令参数见 CLI 参考。云端协作的本机仓库路径映射按云端文档配置。

`clb` 可供人工、AI 或脚本调用。任务和评论写入需要当前会话的 `CODEX_THREAD_ID`；在普通终端中运行时，用 `--thread-id` 显式提供真实会话 ID。安装 `skills/code-loop-board` 后，在 Codex 对话中使用 `$code-loop-board`。嵌入式看板生成的任务提示会直接引用仓库内 Skill 路径；手动输入技能名则依赖 Codex 已发现该 Skill。完整命令见 [CLI 参考](skills/code-loop-board/references/cli.md)。

## 用 JSON 定义所有看板状态

[loop-board.default.json](loop-board.default.json) 是默认配置。项目可以单独导出、修改并应用配置：

```bash
npm run clb -- board-config export --project PROJECT_ID --output loop-board.json
npm run clb -- board-config apply --project PROJECT_ID --file loop-board.json
```

HTTP 接口为 `GET /api/projects/:id/board-config` 和 `PUT /api/projects/:id/board-config`。

- `states` 数组定义状态 ID、名称、颜色、图标、分类和是否允许直接创建事项；数组顺序就是看板列顺序。
- `initialState` 定义新事项的默认状态。
- `manualTransitions` 定义每个状态可手动流转到哪些状态。
- `automation.bindings` 将待认领、处理中、审批、发布、回归、阻塞和完成等动作绑定到配置中的状态 ID。
- `automation.enabled`、`approvalEnabled` 和 `releaseEnabled` 控制相应自动化能力。

修改名称不影响状态 ID；改变 ID 时需要同时调整流转和动作绑定，现有事项使用中的状态不能直接删除。无需修改 React 组件或核心状态常量即可增减自定义状态。AI 修改配置前应先读取项目当前配置和事项，再校验所有引用，应用后重新读取并观察看板结果。

导出时使用 `--output` 保存可编辑的配置文件；标准输出另含 CLI 响应包装，不能直接重定向后用于 apply。迁移使用中的状态 ID 时，准备旧 ID 到新 ID 的 JSON 对象并通过 `--status-mapping-file FILE` 传入。apply 写入前读取最新版本，只检测此次读写间的并发冲突；应用前还应比较项目当前配置与自己编辑的版本。

## 接入缺陷管理平台

接入方式和 AI 操作约定见 [平台适配指南](docs/integrations/README.md)。平台接口、字段映射、认证和 Playwright 选择器放在独立适配器内。核心通过统一协议读取和更新来源事项，不根据任务描述中的平台专有文字判断来源。

首次接入或页面变化时，AI 按指南检查真实平台，生成适配脚本、验证操作结果并保存；日常任务复用已验证脚本。认证信息使用本机环境变量或被忽略的私有文件，脚本和文档只记录变量名与格式。同步和外部状态写回应逐项读取结果确认，保留未涉及的业务字段。

发布流水线与缺陷平台单独配置；接入缺陷系统不代表自动触发部署。团队工作方式见 [使用手册](docs/taskboard-team-usage.md)。

## 运行配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `0.0.0.0` | 服务监听地址；仅本机使用时设为 `127.0.0.1` |
| `CODEX_TASKBOARD_PORT` | `47824` | 本地 HTTP 端口 |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite 与本地运行数据目录 |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47824` | CLI 连接地址 |

本地服务没有账户认证，局域网访问适用于可信网络。CDP 端口仅在可信本机环境中启用。环境变量和 CLI 名称保留现有技术标识，产品界面统一使用“Loop看板”。

开启自动化审批能力时，代码仓库可使用各自的 `review-policy.json` 定义规则，模板见 [review-policy.example.json](review-policy.example.json) 与 [schema](review-policy.schema.json)。缺少该文件时，不应用该仓库的阈值/目录审批策略；示例中的 50 行不是缺省生效规则。黑名单与白名单只能配置一种。

云端协作支持 Cloudflare Worker、D1 和 R2，设置方法见 [云端协作](docs/cloud-collaboration.md)。`wrangler.example.jsonc` 仅是模板；实际部署配置使用被忽略的 `wrangler.jsonc`。

## 来源与许可

CodeLoop看板基于 [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)（Codex Taskboard）二次开发，由本项目贡献者独立维护，感谢上游作者与贡献者。主要扩展包括 JSON 可配置状态、通用外部缺陷平台适配、AI 辅助适配指引，以及 `clb` 和 `code-loop-board` 的使用流程。

本项目采用 [Apache License 2.0](LICENSE)，第三方组件与资源保留各自许可。归属说明见 [NOTICE](NOTICE)，资源说明见 [第三方声明](THIRD_PARTY_NOTICES.md)，已核对版本及原始基线的证据边界见 [上游来源记录](docs/upstream-provenance.md)。本项目不代表上游维护者或 OpenAI 官方产品。

本 README 已由 CodeLoop 贡献者修改。分发源码或构建产物时保留适用许可证、版权与归属声明；这些声明不属于脱敏时应删除的私有信息。

## GitHub 发布与本地数据

仓库提供通用代码和示例配置。`.gitignore` 排除本地数据库、认证状态、真实配置、浏览器记录、截图与运行证据目录。生成适配器时，真实主机地址、账号、凭据、客户内容与项目路径留在私有配置中，不写入共享示例或测试夹具。

忽略规则不会移除已经被 Git 跟踪的内容；发布前应检查 `git status --short` 和待提交 diff。Git 提交历史的清理与远端发布由仓库维护者决定。

## 本地检查

```bash
npm run typecheck
npm run build:web
npm test
```

针对改动验证实际操作路径；无需为仅修改文档重复运行产品测试。
