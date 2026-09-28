# Todo-Aware Automatic Claim Implementation Plan

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

> **For agentic workers:** Implement these steps inline in the current workspace. The repository rules require direct-path verification before adding regression protection.

**Goal:** Check the local Taskboard `todo` list before activating Codex automatic claiming and title each created Codex task `【自动】<issue title>`.

**Architecture:** Extend the resident injector's existing policy timer so it reads one `todo` issue through the local HTTP API before reconciling the native Codex automation. Pass that selected issue into the shared automation builder, while retaining the stored automation ID as the stable identity across visible-name changes.

**Tech Stack:** Node.js ESM, native `fetch`, Codex desktop automation bridge.

---

### Task 1: Build an issue-specific automation specification

**Files:**
- Modify: `shared/taskboard-automation.mjs`

- [x] Allow internal reconciliation requests to carry `selectedTask: { identifier, title }` without exposing it through the browser host-request parser.
- [x] When `selectedTask` exists, return `【自动】${selectedTask.title}` from `buildTaskboardAutomationName`.
- [x] When `selectedTask` exists, generate a prompt that instructs Codex to read and process only `selectedTask.identifier`.
- [x] Match an existing dynamic-name automation by its stored ID plus the project marker in its prompt, while retaining legacy-name discovery for existing installations.

### Task 2: Gate Codex activation on the local `todo` list

**Files:**
- Modify: `scripts/codex-injector.mjs`

- [x] Add a local API reader for `/api/tasks?projectId=<id>&status=todo&archived=false` that returns the first issue's identifier and title or `null`.
- [x] In `applyTaskboardAutomationPolicy`, read the next issue only when the policy and quota allow execution.
- [x] Activate reconciliation with `selectedTask` only when an issue exists; otherwise reconcile the automation to `PAUSED` without creating one.
- [x] Schedule code-only policy checks for every enabled policy, using the configured interval when no active native run supplies `nextRunAt`.
- [x] Restore timers for enabled non-quota-aware policies as well as quota-aware policies.

### Task 3: Verify the two requested operation paths

**Files:**
- No persistent test changes before user confirmation.

- [x] Run an isolated Node verification with an empty Taskboard response and confirm the Codex RPC receives no `automation-create` request.
- [x] Run an isolated Node verification with one `todo` response and confirm the active spec name is exactly `【自动】<issue title>` and the prompt targets that issue identifier.
- [x] Run the production build to confirm the edited modules parse and bundle.

No commits are planned because this workspace does not contain Git metadata.

