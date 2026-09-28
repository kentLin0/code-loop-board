# 上游来源与二次开发记录

## 来源

- 上游项目：[chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard)，项目文档中使用 Codex Taskboard 名称。
- 本项目：CodeLoop看板，由本项目贡献者独立维护。
- 项目许可证：[Apache License 2.0](../LICENSE)；归属信息见 [NOTICE](../NOTICE)，第三方资源见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 已核对的版本与证据边界

2026-09-28 核对了上游提交 [`98d3d34703d52aaf0ebcf8e92fa3f972464994d8`](https://github.com/chuspeeism/dashi-taskboard/tree/98d3d34703d52aaf0ebcf8e92fa3f972464994d8)。该版本包含 [Apache-2.0 LICENSE](https://github.com/chuspeeism/dashi-taskboard/blob/98d3d34703d52aaf0ebcf8e92fa3f972464994d8/LICENSE)，未发现独立 NOTICE 文件。根目录 LICENSE 从该版本复制，未改写协议正文。

**该提交仅用于本次许可与文件核对，不是已确认的二开起点。** 本地现有 Git 历史从 README 初始化开始，随后整体导入项目代码，没有保留可确认上游起点的提交链。因此无法据此精确还原原始上游版本，也不能声称已经完成全部历史版本的版权声明比对。

文件级声明仅用于存在内容修改的上游对应文件，包括下列改名路径；不对所有同路径文件统一添加声明。为缩小范围，本次去掉新增声明后，将文件统一为 LF 换行并计算 Git blob SHA，与上游 main 分支历史中的对象比对。20 个文件找到完全一致的上游内容，已撤去这些文件中本次新增的声明；其余对应文件保留简短的一行说明。这个比对证明文件内容相同，不用于推定整个项目的原始二开提交。

| 当前路径 | 上游对应路径 |
| --- | --- |
| `cli/clb.mjs` | `cli/taskctl.mjs` |
| `skills/code-loop-board/` | `skills/manage-taskboard/` |
| `test/code-loop-board-skill.test.mjs` | `test/manage-taskboard-skill.test.mjs` |
| `wrangler.example.jsonc` | `wrangler.jsonc` |

脚本、样式和配置使用其格式支持的一行 `Modified for CodeLoop.` 注释；Markdown 使用一行可见修改说明。严格 JSON 格式的 package.json 和 package-lock.json 使用 `x-code-loop-board-notice` 字段，避免插入无效的 JSON 注释。许可正文和完整归属信息集中在根目录 LICENSE、NOTICE 中。既有字体许可证和二进制资源保持原样。

## CodeLoop 的主要扩展

- 看板状态、顺序、流转及自动化绑定通过项目 JSON 配置。
- 外部缺陷平台通过独立 provider 接口适配，支持按需生成、验证和保存适配脚本。
- CLI 对外命令改为 `clb`，Skill 改为 `code-loop-board`，整理相应 AI 操作指引。
- 调整 Windows 启动、Codex 嵌入及就绪检查流程。
- 整理通用配置示例和公开使用文档，将本机认证及平台实例配置独立保存。

以上是本分支的扩展说明，不表示底层看板、CLI、云端或 Codex 集成均为本项目原创。

## 后续维护

以后合入上游改动时记录实际提交 SHA，保留适用的版权、专利、商标及归属声明，并在改动文件中保留修改说明。发现更早的可靠来源记录后，补充原始基线信息；不要用上游最新提交替代未知基线。去除私有配置时，保留应随代码分发的作者署名和许可证。

## 2026-09-28 选择性同步

本次按下表顺序独立提交，提交正文以 `Upstream-Commit` 记录完整来源 SHA。采用功能移植，未整体合并上游分支；上游固定状态、Jira 耦合和删除工作流数据的迁移不在本次范围内。

| 顺序 | 合入范围 | 上游 SHA | 本地适配 |
| --- | --- | --- | --- |
| 1 | 检查命令使用纯前端构建 | `26f8ea7f6c49f7599d4dabe31b5b2b00d7cfd67a` | `npm run check` 不触发 Codex 刷新 |
| 2 | Windows Codex 配套程序缓存 | `fe0392d5ac74c32668e1d56241723c23c7d9c70b` | 放入服务端运行时模块，主程序和三个配套程序按版本缓存 |
| 3 | Codex 导航栏、原生窗口布局、会话选择与资料菜单 | `a2de257112c9117fa110cdb0099c5598b2238aa3`、`b457deb04423e7e29ebe9566d8d56b3e20a76a4b`、`1af460af64096c633f53bb828561f51ebc8e73bd`、`510607d838708df9fd6b409a25a89c57c73309d4` | 保留 V2 宿主通信、Loop看板入口、既有侧栏入口和自动化逻辑 |
| 4 | SSE 连接稳定性 | `3ea370ee29243f66446de96e99577698b34d8522` | 切换项目或详情时复用连接，保留 JSON 状态配置和工作流更新事件 |
| 5 | 筛选计数缓存、显示排序、统一通知 | `a90e71ba7a65ef3e533516abc7384c472e2b2675`、`2529e22ece2f984b676380a0854fc876e97752f7`、`550ae5fe1a0fb356b7d712530bc67ddc24d74f8f` | 状态来自项目 JSON；名称和优先级排序不改写手动顺序；保留撤回快捷键，并修复移除通知后悬停状态未退出的问题 |

核对来源时可使用 `https://github.com/chuspeeism/dashi-taskboard/commit/<SHA>`。后续同步应比较这些功能的增量，不把此表当作整个仓库已经追平上游的声明。
