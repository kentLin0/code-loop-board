# Todo-Aware Automatic Claim Design

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

## Goal

Prevent Taskboard automatic claiming from starting a Codex run when the selected project has no `todo` issues. Keep the configured claim interval and process at most one issue per interval. Name each resulting Codex task `【自动】` followed immediately by the issue title.

## Current Operation Path

`ProjectAutomationMenu` saves an enabled policy through `App.tsx`. The resident injector passes that policy to `applyTaskboardAutomationPolicy`, which currently decides whether the native Codex cron is active using only the user setting and Codex quota. `reconcileTaskboardAutomation` creates or updates that cron with a project-scoped name and a prompt that asks Codex itself to find a `todo` issue. Consequently, every scheduled run starts Codex before the empty-list decision is made.

## Approved Design

Move the empty-list decision into the resident injector's existing policy timer.

On each configured interval, the injector requests the local Taskboard API:

`GET /api/tasks?projectId=<project-id>&status=todo&archived=false`

- When the response contains no issues, the injector keeps the user policy enabled but leaves the native Codex automation paused. It schedules the next local check using the configured interval. No Codex run is created.
- When the response contains issues, the injector selects the first issue returned by the board, builds an issue-specific automation spec, and creates or updates the existing native automation in the active state. The automation name is `【自动】<issue title>`, and its prompt identifies that exact issue rather than asking Codex to search the whole `todo` list.
- Before each later native run, the injector repeats the local check. This preserves the existing rate of at most one issue per configured interval while preventing empty runs.

The existing automation ID remains the stable identity used for updates even though its visible name changes for each selected issue.

## Components

### `scripts/codex-injector.mjs`

- Read the next `todo` issue from the local Taskboard API.
- Include the issue in the decision to activate or pause the native automation.
- Run policy timers for every enabled policy, including policies that are not quota-aware and policies currently paused because no `todo` exists.
- Use the configured interval when scheduling another code-only check while no native run is pending.

### `shared/taskboard-automation.mjs`

- Accept the selected issue as internal reconciliation input.
- Generate `【自动】<issue title>` as the automation name.
- Generate a prompt targeted at the selected issue identifier.
- Locate an existing automation by its stored automation ID so changing the visible name does not create duplicates.

The UI settings and Taskboard issue data model remain unchanged.

## Observable Results

1. With automatic claiming enabled and no `todo` issues, repeated configured intervals create no new Codex tasks.
2. When a `todo` issue exists, the next eligible interval creates one Codex task for that issue.
3. The task title is exactly `【自动】` plus the issue title.
4. Multiple `todo` issues continue to be handled at a maximum of one per configured interval.

## Error Handling

If the local Taskboard query fails, the injector does not activate a new Codex run for that check. It reports the policy-check error through the existing injector logging path and schedules another local check. Existing quota behavior remains unchanged.

## Verification Scope

After implementation, verify only the two direct paths requested:

- an empty `todo` response does not create or activate a Codex run;
- a non-empty `todo` response activates one issue-specific run named `【自动】<issue title>`.

No additional regression or defensive test work is included before user confirmation.

