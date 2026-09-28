> 本文件已为 CodeLoop 修改。
# Project Development Rules

For feature work in this repository, use this order:

1. Before implementation, prove the real operation path to the user: entry point → user or agent action → data change or other side effect → observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This proof is not a test.
2. Implement the requested main path with the smallest direct change that makes it work.
3. After implementation, demonstrate or verify only that direct operation path and give the result to the user for confirmation.
4. Before the user confirms the feature works, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallback behavior.
5. User confirmation does not automatically authorize that follow-up work. Add targeted protection or tests only when the user explicitly asks for them, or when the user reports a concrete failure scenario that requires them.

The primary objective is to make the requested function work. Focus on the feature implementation itself and avoid over-design; safety, guardrails, and testing must not dominate the work or turn the feature into a surrounding engineering project. This rule supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.

This ordering does not waive higher-priority safety or security requirements. Keep validation that is necessary at real external boundaries, such as user input or external APIs, but do not expand it into hypothetical protection beyond the requested path.

## “启动Loop看板”口令

当用户在本仓库的 Codex 会话中发送“启动Loop看板”或“启动任务面板”时，直接执行下列固定流程，不要再临时探索启动方式：

1. 在仓库根目录调用当前 Node.js 运行时，执行 `scripts/codex-injector.mjs --launch --daemon --open --port 9229`。人工在终端操作时，等价的快捷命令是 `npm run codex`。
2. 如果当前 Codex 已经开放 9229 调试端口，启动器会复用当前窗口并挂载菜单；如果尚未开放，启动器会先把重启动作交给 Windows 计划任务，再关闭旧窗口。不要把关闭 Codex 和重新启动拆成两条人工命令，也不要先执行裸 `taskkill`。
3. 等待启动命令完成。只有以下条件都成立时，才向用户报告成功：`http://127.0.0.1:47824/health` 返回正常、`http://127.0.0.1:9229/json/version` 可访问、Codex 主窗口的 `#codex-taskboard-entry` 可见、面板及 iframe 可见且收到页面就绪消息。不能仅凭入口存在或 iframe 地址判断启动成功。
4. Windows 计划任务必须允许电池模式启动并在切换到电池供电后继续运行，避免 Codex 被关闭后重启任务停留在“已排队”。
5. 正常启动不刷新 Codex。仅在确认任务面板 iframe 被 CSP 拦截时，启动器先设置嵌入配置，再自动刷新当前窗口一次并重新打开面板，无需逐次询问。普通加载超时不得触发刷新；刷新后仍失败就报错停止，不循环刷新。只刷新页面，不关闭 Codex 进程。

在 Windows 上由 Codex 执行此流程时，可以直接调用 Node.js 可执行文件，也可以通过 PowerShell 启动。通过 Node 启动子进程时传递参数数组，使用 `shell:false` 和 `windowsHide:true`；后台启动不得额外弹出可见终端窗口。

## 平台适配与公开材料

产品名称使用“Loop看板”。状态名称、顺序、手动流转和自动化动作绑定以项目看板 JSON 为准，默认示例见 `loop-board.default.json`；不得在新代码或提示词中写死某个平台的状态枚举。

接入外部缺陷系统前阅读 `docs/integrations/README.md`。平台 API、字段映射、登录与 Playwright 选择器归独立适配器所有。AI 在首次接入或页面变化时生成、实际验证并保存脚本，日常操作复用已验证的适配器。没有真实平台操作证据时，不得声称外部接入已验证。

公开代码和文档仅包含通用示例。真实域名、账号、token、Cookie、认证状态、客户内容和个人绝对路径保存在被忽略的本机配置中；不要复制到示例、测试夹具、日志或截图。状态配置修改后通过项目接口重新读取并观察看板结果。

