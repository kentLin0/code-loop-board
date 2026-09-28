# Windows Codex Launcher Implementation Plan

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run codex` restart the installed Windows Codex desktop app with CDP enabled and inject Taskboard into the native sidebar and main workspace.

**Architecture:** Add a narrow `win32` branch to the existing launcher. Discover `ChatGPT.exe` from the packaged `codex.exe`, stop the currently running Windows app before launch, then reuse the existing CDP, supervision, injection, and watch flow without changing Taskboard data or UI code.

**Tech Stack:** Node.js 24, Windows `where.exe` and `taskkill.exe`, Electron/Chromium CDP, existing Taskboard injector.

---

### Task 1: Add Windows process and executable handling

**Files:**
- Modify: `scripts/codex-injector.mjs`

- [ ] **Step 1: Add synchronous file existence support and a platform-specific default app path**

Add this import:

```js
import { existsSync } from "node:fs";
```

Change the `appPath` default in `parseArgs()` to:

```js
appPath: process.platform === "darwin" ? "/Applications/ChatGPT.app" : null,
```

- [ ] **Step 2: Replace the macOS-only process and launch helpers with platform branches**

Replace `codexIsRunning()` and `launchCodex()` with:

```js
function codexIsRunning() {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq ChatGPT.exe", "/NH"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return result.status === 0 && /ChatGPT\.exe/i.test(result.stdout);
  }
  return spawnSync("/usr/bin/pgrep", ["-x", "ChatGPT"], { stdio: "ignore" }).status === 0;
}

function resolveWindowsCodexApp(appPath) {
  if (appPath) return appPath;

  const located = spawnSync("where.exe", ["codex.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (located.status === 0) {
    for (const line of located.stdout.split(/\r?\n/)) {
      const cliPath = line.trim();
      if (!cliPath) continue;
      const candidate = path.resolve(path.dirname(cliPath), "..", "ChatGPT.exe");
      if (existsSync(candidate)) return candidate;
    }
  }

  throw new Error(
    "Could not find the Windows Codex desktop app. Pass --app-path with the full path to ChatGPT.exe.",
  );
}

async function prepareCodexLaunch() {
  if (!codexIsRunning()) return;
  if (process.platform !== "win32") {
    throw new Error(
      "Codex is already running without this CDP port. Quit Codex completely, then run this command again.",
    );
  }

  const stopped = spawnSync("taskkill.exe", ["/F", "/IM", "ChatGPT.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (stopped.status !== 0 && codexIsRunning()) {
    throw new Error("Could not close the running Codex app. Close it manually, then run this command again.");
  }

  const deadline = Date.now() + 10_000;
  while (codexIsRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (codexIsRunning()) {
    throw new Error("Timed out waiting for the running Codex app to close.");
  }
}

function launchCodex(appPath, port) {
  const debuggingArgs = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ];

  if (process.platform === "win32") {
    return spawn(resolveWindowsCodexApp(appPath), debuggingArgs, {
      stdio: "ignore",
      windowsHide: false,
    });
  }
  if (process.platform === "darwin") {
    return spawn("/usr/bin/open", ["-W", "-a", appPath, "--args", ...debuggingArgs], {
      stdio: "ignore",
    });
  }
  throw new Error(`Launching Codex is not supported on ${process.platform}`);
}
```

- [ ] **Step 3: Invoke the restart preparation from the existing launch path**

Replace the current `codexIsRunning()` error block in `main()` with:

```js
await prepareCodexLaunch();
```

- [ ] **Step 4: Check syntax**

Run:

```powershell
node --check scripts/codex-injector.mjs
```

Expected: exit code `0` with no syntax error.

### Task 2: Document Windows usage

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add a Windows launcher section**

Under `## Embed in Codex`, add:

````markdown
### Windows: restart Codex with Taskboard enabled

Run the launcher from a separate PowerShell window so it remains alive while Codex restarts:

```powershell
cd D:/workspace/loop-board
$env:CODEX_TASKBOARD_HOST = "127.0.0.1"
npm run codex
```

The launcher locates the installed Codex desktop app, closes the current Codex window, restarts it with a loopback-only CDP port, and adds Taskboard after Plugins in the sidebar. Keep the PowerShell window open while using Taskboard. For a nonstandard installation, append `-- --app-path "C:\path\to\ChatGPT.exe"`.
````

- [ ] **Step 2: Clarify that the existing separate-window commands are for macOS**

Rename the existing recommended heading to:

```markdown
### macOS: keep your current window and open a separate Taskboard window
```

Rename the existing alternative heading to:

```markdown
### macOS alternative: restart Codex with the standalone launcher
```

- [ ] **Step 3: Run the production build**

Run:

```powershell
npm run build
```

Expected: Vite reports a successful production build and the injector refresh step either refreshes a debuggable Codex renderer or reports that none is running.

### Task 2A: Handle Windows renderer startup ordering

**Files:**
- Modify: `scripts/codex-injector.mjs`

- [ ] **Step 1: Wait for a renderer after the CDP endpoint starts**

Add `waitForCodexRenderer()` and invoke it before the first `injectAll()` call so Windows cannot expose `/json/version` before an injectable page exists.

- [ ] **Step 2: Ignore the Windows avatar overlay target**

Exclude URLs containing `initialRoute=%2Favatar-overlay` in `codexTargets()` so the first injection target is the complete Codex main window.

### Task 3: Verify the real Windows operation path

**Files:**
- Read: `taskboard.stdout.log`
- Read: `taskboard.stderr.log`

- [ ] **Step 1: Start the launcher from an external PowerShell window**

Run:

```powershell
cd D:/workspace/loop-board
$env:CODEX_TASKBOARD_HOST = "127.0.0.1"
npm run codex
```

Expected observable path: the current Codex app closes, `ChatGPT.exe` restarts, `http://127.0.0.1:9229/json/version` returns HTTP 200, the injector prints an `injected` result, and Taskboard opens from a sidebar entry after Plugins across the complete main workspace.

- [ ] **Step 2: Confirm the Taskboard service remains healthy**

Run from another PowerShell window:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:47823/health
```

Expected: HTTP status `200`.

- [ ] **Step 3: Ask the user to confirm the native menu and full-workspace result**

Do not add regression tests or compatibility extensions until the user confirms this direct operation path, in accordance with `AGENTS.md`.

## Repository note

The workspace path above is an example. This historical plan contains no commit steps; inspect the actual repository before any Git operation.


