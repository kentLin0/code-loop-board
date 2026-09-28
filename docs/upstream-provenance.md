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
