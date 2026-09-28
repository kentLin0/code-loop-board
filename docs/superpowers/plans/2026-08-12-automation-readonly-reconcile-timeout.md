# Automation Read-only Reconcile and Timeout Implementation Plan

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

> **For agentic workers:** Apply the steps inline in the current workspace.

**Goal:** Prevent status reconciliation from pausing active automations and allow multi-slot updates to complete within 60 seconds.

**Architecture:** Keep state reads and mutations separate. `reconcileProjectAutomation` always lists host state, while explicit setting changes continue to apply policy; both browser-side waits use a shared 60-second contract.

**Tech Stack:** React, TypeScript, injected browser JavaScript, Node test runner.

---

### Task 1: Lock the expected request contract

**Files:**
- Modify: `test/project-automation-settings.test.mjs`
- Modify: `test/inject.test.mjs`

- [ ] Assert that reconciliation sends `list` even when a stored record exists.
- [ ] Assert that both UI and host automation waits are 60 seconds.

### Task 2: Implement the minimal fix

**Files:**
- Modify: `web/src/App.tsx`
- Modify: `inject/codex-taskboard.user.js`

- [ ] Replace reconciliation's conditional `apply-policy` with `list`.
- [ ] Change both request timeouts to `60_000`.

### Task 3: Verify the direct path

- [ ] Run the focused automation settings and injection tests.
- [ ] Run TypeScript checking and the web build.
- [ ] Refresh the running injection without changing current task or automation state.


