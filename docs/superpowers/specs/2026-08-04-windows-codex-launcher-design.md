# Windows Codex Launcher Design

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

## Goal

Make `npm run codex` work on Windows by restarting the installed Codex desktop app with a local Chrome DevTools Protocol port and then injecting Taskboard into the native Codex sidebar and main workspace.

## Current Operation Path

`npm run codex` invokes `scripts/codex-injector.mjs --launch --watch --open`. The injector checks whether Codex is running, starts the Taskboard service, launches Codex with a remote-debugging port, connects to the Codex renderer, and installs `inject/codex-taskboard.user.js`. The injected script adds the Taskboard entry after Plugins and mounts the Taskboard iframe across the main workspace.

The path currently fails on Windows before launch because `codexIsRunning()` calls `/usr/bin/pgrep` and `launchCodex()` calls `/usr/bin/open`, both of which are macOS-only.

## Design

Keep the launcher logic in `scripts/codex-injector.mjs` and add narrow platform branches:

- Preserve the current macOS process detection and launch behavior.
- On Windows, resolve the desktop executable from an explicit `--app-path` first. Otherwise run `where.exe codex.exe`, identify the Codex CLI at `app/resources/codex.exe`, and derive the sibling desktop executable at `app/ChatGPT.exe`.
- When `--launch` is used on Windows, terminate the existing `ChatGPT.exe` process tree, wait briefly for it to exit, then launch the resolved desktop executable with `--remote-debugging-port` and `--remote-allow-origins`.
- Wait for an injectable main Codex renderer after the CDP browser endpoint becomes reachable, and ignore auxiliary renderer targets such as the avatar overlay.
- Continue through the existing Taskboard supervisor, CDP connection, renderer injection, watch, and open paths without changing the injection protocol.
- Keep `--app-path` as the fallback for nonstandard installations.

## User Experience

From an external PowerShell window, the user runs:

```powershell
cd D:/workspace/loop-board
npm run codex
```

The current Codex window closes, Codex restarts with CDP enabled, and Taskboard appears as a native-looking sidebar item after Plugins. The command remains running to supervise the Taskboard service and reinject replacement renderers.

## Project Mapping

Project creation and mapping remain unchanged. Codex projects become available to the embedded Taskboard through the existing host bridge. Saved Taskboard projects can also be created or mapped with `clb project create` and `clb project map`.

## Error Handling

- If automatic executable discovery fails, report a direct error that tells the user to pass `--app-path`.
- If the current Codex process cannot be terminated, stop instead of launching a non-debuggable replacement.
- If the CDP endpoint does not become reachable, retain the existing launch timeout error.

## Verification

Run the project build, then invoke the Windows launcher from an external PowerShell window. Verify that Codex restarts, port `9229` exposes `/json/version`, the Taskboard sidebar entry appears after Plugins, selecting it fills the main workspace, and the local Taskboard service remains reachable at `127.0.0.1:47823`.

## Scope

This change covers Windows desktop launching and documentation only. It does not change Taskboard data, project APIs, issue behavior, injection markup, or macOS launching.

