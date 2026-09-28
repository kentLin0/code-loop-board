# clb CLI

`clb` emits JSON. Add `--json` when making the output contract explicit. This reference defines command arguments, results, and side effects; workflow and recovery rules live in [SKILL.md](../SKILL.md). Read only the section for the command being used. Examples use the CLI name; execute them through the task prompt's fixed runner when supplied.

Without a global CLI installation, run `npm run clb -- <arguments>` or `node cli/clb.mjs <arguments>` from the board repository. Syntax blocks below use `[optional]`, alternatives separated by `|`, and uppercase placeholders; these are notation, not literal shell arguments. Multiline examples use Bash continuations; PowerShell users should join each command onto one line.

## Context and projects

The embedded board reads Codex's project list and creates a board record on first selection, reusing an existing record with the same ID. `project create` is an explicit alternative for standalone use, not a prerequisite. Query `project list` after selecting the project to obtain its persisted ID.

`context current` only matches stored `workspacePath` values against the current directory, preferring the longest match; otherwise it returns `local`, the first project, or null. It does not read Codex's current selection. An automatically created project can have no stored workspace path, so do not treat a fallback result as proof of the intended project. `project map` saves a device mapping for cloud mode; it does not update a local database project's workspacePath.
```bash
clb context current [--cwd PATH] [--json]
clb project list [--json]
clb project create --name NAME [--id ID] [--workspace-path PATH] [--json]
clb project map PROJECT_ID --workspace-path PATH [--json]
```

## Board configuration

```bash
clb board-config export --project PROJECT_ID [--output FILE] [--json]
clb board-config apply --project PROJECT_ID --file FILE [--status-mapping-file FILE] [--json]
```

The CLI response is `{schemaVersion:2,version,config}`. With `--output`, the saved file contains only `config`, whose own schemaVersion is 1; pass that file to apply. Redirecting the entire CLI response to a file does not produce an apply-compatible configuration.
The exported configuration defines state IDs, labels, colors, order, manual transitions and automation bindings.
To rename a state ID already used by tasks, pass an explicit old-ID to new-ID JSON object through `--status-mapping-file`.
Apply stores the authoritative project configuration; editing a local file alone does not change the board.
Apply reads the current version immediately before writing, so the version check detects a concurrent write during that operation, not changes made since the earlier export. Re-read and compare the current configuration before applying an edited export. To enforce a specific expected version, use PUT `/api/projects/:id/board-config` with `{version,config,statusMapping}`.

## External integrations

```bash
clb integration inspect [--connection CONNECTION_ID] [--json]
clb integration get ISSUE_ID [--json]
clb integration sync --connection CONNECTION_ID --project PROJECT_ID [--thread-id ID] [--json]
clb integration action ISSUE_ID --action ACTION [--parameters-file FILE] [--thread-id ID] [--json]
```

Integrations execute on the local companion. Configure trusted local provider modules and project connections in `integrations.json`.
`inspect` lists available connections or capabilities without returning credential references.
`get` reads an external issue using the stored task identity.
`sync` imports new/reopened issues and refreshes source fields while preserving existing local descriptions and delivery snapshots.
`action` performs a declared semantic action, verifies its source result, and saves the external state; it does not move the local task.
For `action`, require `ok:true`, `verified:true`, the expected `state.semantic`, and `localCompleted:true`. When `externalCompleted:true` but `localCompleted:false`, reconcile the local state instead of repeating the external write. This partial result can still have CLI exit code 0; inspect the returned fields. `inspect`, `get` and `sync` do not return this action-result contract.

The operand for `integration get/action` is the local board issue ID or identifier, not the external platform's issue key. `get` is read-only and requires an already linked board task; before first sync, validate an external sample through the adapter's `getIssue` directly. Sync returns `created`, `updated` and `skipped` lists; inspect skipped items. It is not a transaction across all source issues, so an error can follow earlier successful imports.

Set `CODEX_TASKBOARD_URL` to override the default local API origin, `http://127.0.0.1:47824`.

For a shared cloud board, keep `clb` pointed at the loopback companion and configure the upstream HTTPS origin through it:

```bash
clb cloud login --url HTTPS_ORIGIN --actor-name NAME [--json]
clb cloud status [--json]
clb project list [--json]
clb project map PROJECT_ID --workspace-path /absolute/local/path [--json]
clb cloud logout [--json]
```

`cloud login` reads the shared password from a private `Shared key:` prompt. The actor name is the display attribution sent through Basic Authentication. The companion requests mode `0600` when writing its configuration on systems supporting POSIX permissions; this is not a Windows ACL guarantee. Project mappings stay on the current device and can differ between collaborators. In cloud mode, failed upstream writes fail rather than falling back to or double-writing the local SQLite database.

Every issue or comment write must be attributed to a Codex conversation. In Codex, `clb` reads the current conversation from `CODEX_THREAD_ID`. Outside Codex, pass `--thread-id ID` explicitly. An explicit option takes precedence over the environment. Read commands do not require a conversation id.

Every successful command writes one JSON object with `schemaVersion` to stdout. The current schema version is `2`. Errors write one JSON object to stderr. Exit codes are `0` for success, `2` for invalid input, `3` when the service is unavailable, `4` for API or response errors, and `5` for conflicts.

## Read issues

```bash
clb issue list [--project PROJECT_ID] [--status STATUS] [--json]
clb issue get ID [--json]
```

## Create issues

```bash
clb issue create \
  --project PROJECT_ID \
  --title TITLE \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--json]
```

State IDs and allowed transitions come from the project's exported board JSON. Never infer IDs from column labels. Priorities are `none`, `urgent`, `high`, `medium`, and `low`.

Issues created through `clb` are assigned to Codex Agent by default. Other CLI writes preserve the existing assignee.

## Update issues

`--if-version` compares the supplied value with the issue's current `version`; a mismatch returns a conflict without applying the update.

When omitted for issue update/move/archive/restore/relation, the CLI fetches the current version immediately before writing. Pass the version you actually read when the operation depends on that earlier content. Comment update/delete always require an explicit version.

```bash
clb issue update ID \
  [--title TITLE] \
  [--estimated-handling-hours HOURS] \
  [--description TEXT | --description-file FILE] \
  [--status STATUS] \
  [--priority PRIORITY] \
  [--labels a,b] \
  [--thread-id ID] \
  [--git-branch BRANCH] \
  [--worktree-path PATH] \
  [--worktree-branch BRANCH] \
  [--due-date YYYY-MM-DD] \
  [--recurrence-interval N --recurrence-unit day|week|month|year] \
  [--if-version N] \
  [--json]

clb issue move ID --status STATUS [--thread-id ID] [--if-version N] [--json]
clb issue archive ID [--thread-id ID] [--if-version N] [--json]
clb issue restore ID [--thread-id ID] [--if-version N] [--json]
```

Use either `--git-branch` or `--worktree-path`/`--worktree-branch`; an issue has only one development context. Issue JSON stores it as `developmentContext`, either `{ "type": "branch", "branch": "..." }` or `{ "type": "worktree", "path": "...", "branch": "..." }`. Its singular `threadId` is the Codex conversation that most recently created or changed the issue itself. Recurrence requires a due date.

## Issue relations

Relation writes use the anchor issue's `version` for `--if-version` and require Codex conversation attribution.

```bash
clb issue relation add ISSUE_ID \
  --type parent \
  --issue PARENT_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

clb issue relation add ISSUE_ID \
  --type blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]

clb issue relation remove ISSUE_ID \
  --type parent|blocks|blocked_by|related \
  --issue RELATED_ISSUE_ID \
  [--thread-id ID] \
  [--if-version N] \
  [--json]
```

For `--type parent`, `ISSUE_ID` is the child and `PARENT_ISSUE_ID` is its parent. Adding another parent replaces the child's current parent atomically. To add an existing issue as a sub-issue of `LOCAL-6`, anchor the command on the child and pass `--issue LOCAL-6`.

For `blocks`, the anchor issue blocks the related issue. For `blocked_by`, the related issue blocks the anchor. `related` is symmetric. Self-relations, duplicates, parent cycles, and relations between different projects are rejected.

## Issue comments

Use the issue id to read or append comments. Comment updates and deletes require the latest comment `version` returned by `comment list`.

```bash
clb comment list ISSUE_ID [--json]
clb comment add ISSUE_ID --body TEXT [--thread-id ID] [--json]
clb comment update COMMENT_ID --body TEXT --if-version N [--thread-id ID] [--json]
clb comment delete COMMENT_ID --if-version N [--thread-id ID] [--json]
```

Each comment JSON object independently records the most recent conversation that created or changed that comment as `threadId`. Comment operations never change the parent issue's `threadId`.

## Automatic Worktree execution

These local-only commands are for issues whose JSON includes `automationExecution`:

Except `resume-merge`, these commands accept `--thread-id ID` and require it or `CODEX_THREAD_ID`, including `context` despite its name. A terminal historical execution is not a new active assignment.

```bash
clb automation context ISSUE_ID [--json]
clb automation acquire-merge ISSUE_ID --token TOKEN [--json]

clb automation retry-merge ISSUE_ID --token TOKEN [--json]

clb automation release-run ISSUE_ID --token TOKEN [--json]
clb automation prepare-release ISSUE_ID --token TOKEN --repository-results-file FILE [--json]
clb automation reconcile-release ISSUE_ID --token TOKEN --observed-status STATUS [--json]
clb automation fail ISSUE_ID --token TOKEN --reason TEXT [--json]
clb automation pause-merge ISSUE_ID \
  --token TOKEN \
  --reason TEXT \
  [--conflict-files path/a,path/b] \
  [--json]
clb automation resume-merge ISSUE_ID [--json]
clb automation complete ISSUE_ID \
  --token TOKEN \
  --repository-results-file FILE \
  [--json]
```

| Command | Result and side effects |
| --- | --- |
| `context` | Prepares dependencies and acquires run ownership; not a read-only diagnostic. Returns original/Worktree paths, task/target branches, base commits, slot, phase, and token. |
| `retry-merge` | Defers the current merge attempt under the coordinator's retry schedule and releases run ownership. It does not immediately run Git merge. |
| `release-run` | Releases ownership held by this conversation; it does not trigger a deployment. |
| `acquire-merge` | Returns `execution.phase`: `awaiting_approval` saves the snapshot, moves to the configured approval state, and releases the slot; `merging` authorizes merging this execution. Human approval sets `ready_to_merge`, which still requires this command. |
| `prepare-release` | Verifies delivery results for a release-mode task and moves it to the configured releaseReady state; does not change an external issue. |
| `reconcile-release` | Accepts a verified normalized external state (`fixed`), synchronizes the panel, and cleans up the execution. |
| `fail` / `pause-merge` | Moves only this issue to the configured blocked state, releases its slot, and preserves Worktrees. `pause-merge` also records conflict files. |
| `resume-merge` | Resumes the paused merge after conflict resolution; requires human direction. |
| `complete` | Verifies delivery, cleans Worktrees, finalizes the issue status, releases its slot, and triggers refill. |

The completion file is a JSON array of objects matched by `name`, using the repository names returned by `automation context`, for example `[{"name":"app","validation":"Project build passed"}]`. The service independently determines pushed/unchanged status and verifies Git ancestry, upstream push state, and temporary branch publication before cleanup; claims in this file are not proof of delivery. Complete enters the configured review state for review mode, or remains in releaseReady for release mode. It does not mean deployed or accepted; cleanup failure returns a cleanup_pending execution.

## Download inline images

Issue descriptions and comments may contain inline images at exact positions in their Markdown:

```markdown
![alt text](/api/attachments/ATTACHMENT_ID/content)
```

Download an inline image to an explicit local path before inspecting it:

```bash
clb attachment download ATTACHMENT_ID --output PATH [--json]
```

The command writes the response body as binary data and returns the absolute output path, content type, and size in its JSON result. Choose the output filename yourself; `clb` does not infer or append an extension.
