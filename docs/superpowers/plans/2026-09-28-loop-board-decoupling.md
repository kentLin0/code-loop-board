# Loop看板解耦实施记录

状态：实施与直接路径验证完成；改动保留在工作区，由用户自行提交。

## 已完成

- [x] `loop-board.default.json` 与 `shared/board-config.mjs` 定义状态、顺序、显示、人工流转和自动化角色绑定。
- [x] 本地 SQLite 与 Cloud/D1 保存项目配置、配置版本及结构化 `externalIssue`、`externalState`、`delivery`，移除固定状态约束。
- [x] 前端读取项目生效配置；创建、移动、筛选、详情与实时刷新使用配置中的状态，产品名为 Loop看板。
- [x] 自动化通过角色绑定和 repositoryId 工作；执行阶段与看板状态分离，暂停待人工处理仍可按配置移回待领取。
- [x] `server/integrations` 提供独立适配模块注册、事项读取、同步和已核验动作；发布接口独立于缺陷来源。
- [x] API 与 CLI 提供 board-config export/apply 和 integration inspect/get/sync/action。
- [x] Skill 目录、元数据、注入入口、AI 提示与文档统一为 `code-loop-board`；按配置、普通任务、自动化和适配维护重组。
- [x] AI 接入文档说明首次生成、验证、保存与复用脚本；公开仓库只保留通用 Playwright 模板。
- [x] 清除旧平台专属实现与资料、已知组织及个人标识；本地配置、认证、私有适配器与运行材料由忽略规则排除。

## 已验证的实际路径

1. 隔离临时服务 → 真实 CLI 导入/导出 11 状态 JSON → 创建任务进入配置初始列 → 移动后数据库回读一致。
2. 浏览器打开真实页面 → 创建任务 → 点击移动 → 修改状态 ID 并导入显式映射 → 已有任务迁移，页面通过事件刷新列名。
3. 保存的本地 fixture 模块 → HTTP/CLI 同步 → 来源身份及评论去重 → get → action 返回核验结果并保存 externalState。
4. 本地数据库迁移与 D1 迁移保留关联数据；自定义状态、配置版本、来源身份冲突和结构化字段回读已核对。
5. 暂停任务移回待领取后可重新认领并复用原 Worktree；活动执行仍由协调器推进状态。

类型检查和前端构建通过；全部公开候选 `.mjs` 语法检查通过。55 项既有 Skill、自动化提示、交互、Cloud Worker 检查通过。核心 CLI/API/协调器 84 项中 83 项通过，唯一失败是 Windows fake-codex 启动；详细结果见忽略目录 `artifacts/verification/core-final.log`。

## 验证边界

- 外部平台验证使用临时本地 fixture，没有登录或修改真实平台；未提供具体 CI，发布接口也未连接真实流水线。
- Cloud Worker 15 项通过；云迁移 16 项中 13 项通过，剩余两项 POSIX 权限断言及一项 Wrangler 直接执行在当前 Windows 环境失败。
- 服务测试中的 fake-codex 可执行脚本在 Windows 启动失败；完整测试套件不宣称全绿。
- Skill 的标准 Python 校验器缺少 PyYAML；已核对 frontmatter、命名、UI 元数据及本地引用，并运行既有 Skill 检查。
- Codex 主窗口没有重启或刷新；本轮验证使用独立浏览器和临时服务，没有执行启动口令。

## 发布与交付

只读扫描覆盖 Git 跟踪文件与非忽略新文件，未发现旧平台名、旧 Skill 名、已知公司/个人名称、真实个人工作路径或常见密钥格式。对公开示例中的域名与路径进行了核对；测试中的局域网地址是请求来源测试夹具。

私有适配器默认保存在 `integrations/local/`，认证与连接配置留在 `.private/`、`.loop-integrations/` 和 `integrations.json`。有用的本地验证截图及记录保留在被忽略的 `artifacts/verification/`，一次性验证脚本与临时数据库已清理。

没有执行暂存、提交、推送、历史改写或远端发布。Git 历史不在本轮工作树脱敏扫描范围内。
