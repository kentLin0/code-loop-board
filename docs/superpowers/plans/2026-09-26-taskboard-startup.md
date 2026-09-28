# Taskboard startup Implementation Plan

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

**Goal:** 固化已确认的启动路径，仅遇到面板 CSP 拦截时刷新一次。

**Architecture:** 注入脚本上报真实就绪状态及限定到面板源的 CSP 事件；启动器统一执行打开、检查、单次刷新与重新打开。正常路径和普通超时不刷新。

**Tech Stack:** Node.js、CDP、现有注入脚本、node:test。

- [x] `inject/codex-taskboard.user.js` 增加 `startupStatus`，监听并清理 `securitypolicyviolation`，每次加载重置拦截状态。
- [x] `scripts/codex-injector.mjs` 增加 `openTaskboardWithRecovery`，主窗口优先；收到 ready 才成功，CSP 最多刷新一次，普通超时报错。
- [x] `AGENTS.md` 更新启动验收条件和已授权的单次刷新行为。
- [x] `test/injector-csp-recovery.test.mjs` 验证正常、CSP 恢复、持续 CSP、普通超时；保留 `test/injector-no-reload.test.mjs` 原有不刷新约束。
- [x] 实际运行固定启动命令：CSP 恢复刷新 1 次，ready=true；普通启动刷新 0 次；服务 health 正常。刷新后重新发布启动器心跳，避免误报启动超时。
- [x] 41 项相关测试、语法检查及 `npm run build:web` 通过。提交范围仅源文件、测试和文档，不包含构建产物。

