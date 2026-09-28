#!/usr/bin/env node
// Modified for CodeLoop.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { resolvePort } from "../server/app.mjs";
import {
  canScheduleTaskboardAutomationExecution,
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
} from "../shared/taskboard-automation.mjs";
import { boundStatus, normalizeBoardConfig } from "../shared/board-config.mjs";
import {
  createStableTargetTracker,
  findResidentInjectorPids,
  handleHostBindingPayload,
  parseWmicProcessList,
  reconcileInjectionRuntime,
  resolveAutomationDataDir,
  restartResidentInjector,
} from "./codex-injector-runtime.mjs";
import { readCodexQuotaStatus } from "./codex-rate-limits.mjs";

const injectorPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(injectorPath), "..");
const defaultCodexDebuggingPort = 9229;
const localCdpHosts = ["127.0.0.1", "localhost", "[::1]"];
const codexRendererStabilityMs = 8_000;
const injectionPath = path.join(projectRoot, "inject", "codex-taskboard.user.js");
const automationDataDir = resolveAutomationDataDir({
  platform: process.platform,
  configuredDir: process.env.CODEX_TASKBOARD_AUTOMATION_DATA_DIR,
  localAppData: process.env.LOCALAPPDATA,
  tempDir: process.env.TEMP || process.env.TMP,
  projectRoot,
});
const automationPoliciesPath = path.join(automationDataDir, "codex-automation-policies.json");
const codexRelaunchStatusPath = path.join(automationDataDir, "codex-relaunch-status.json");
const managedTaskboardPort = resolvePort(process.env.CODEX_TASKBOARD_PORT ?? "47824");
const taskboardOrigin = `http://127.0.0.1:${managedTaskboardPort}`;
const taskboardHealthUrl = `${taskboardOrigin}/health`;
const taskboardPageUrl = `${taskboardOrigin}/?host=codex`;
const hostBindingName = "__codexTaskboardHostV2";
const hostHeartbeatName = "__codexTaskboardHostHeartbeatV2";
const hostPidName = "__codexTaskboardHostPidV2";
const hostStartupTokenName = "__codexTaskboardHostStartupTokenV2";
const injectionSourceHashName = "__CODEX_TASKBOARD_SOURCE_HASH__";
const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__";
const codexAutomationMethods = new Set([
  "list-automations",
  "automation-create",
  "automation-update",
]);
const automationLaunchGraceMs = 4 * 60_000;
let codexAutomationRequestSequence = 0;
const quotaPolicyTimers = new Map();
const quotaPolicyRecords = new Map();
const quotaPolicyQueues = new Map();
const automationEventTimers = new Map();
let quotaPoliciesLoadPromise = null;
let quotaPoliciesWritePromise = Promise.resolve();
let quotaPoliciesRestored = false;

async function writeCodexRelaunchStatus(status, details = {}) {
  await mkdir(automationDataDir, { recursive: true });
  await writeFile(codexRelaunchStatusPath, `${JSON.stringify({
    status,
    updatedAt: new Date().toISOString(),
    ...details,
  }, null, 2)}\n`, "utf8");
}

function parseArgs(argv) {
  const options = {
    port: defaultCodexDebuggingPort,
    portExplicit: false,
    launch: false,
    watch: false,
    open: false,
    refresh: false,
    refreshIfRunning: false,
    attachExisting: false,
    startupToken: null,
    daemon: false,
    waitForCodexExit: false,
    waitForCodexPids: [],
    screenshot: null,
    appPath: process.platform === "darwin" ? "/Applications/ChatGPT.app" : null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--launch") options.launch = true;
    else if (arg === "--watch") options.watch = true;
    else if (arg === "--open") options.open = true;
    else if (arg === "--refresh") options.refresh = true;
    else if (arg === "--refresh-if-running") options.refreshIfRunning = true;
    else if (arg === "--attach-existing") options.attachExisting = true;
    else if (arg === "--startup-token") {
      options.startupToken = argv[++index];
      if (!/^[a-z0-9-]{1,100}$/i.test(options.startupToken || "")) {
        throw new Error("--startup-token must be an identifier");
      }
    }
    else if (arg === "--daemon") options.daemon = true;
    else if (arg === "--wait-for-codex-exit") options.waitForCodexExit = true;
    else if (arg === "--wait-for-codex-pid") {
      const pid = Number(argv[++index]);
      if (!Number.isInteger(pid) || pid < 1) {
        throw new Error("--wait-for-codex-pid must be a positive integer");
      }
      options.waitForCodexPids.push(pid);
    }
    else if (arg === "--port") {
      options.port = Number(argv[++index]);
      options.portExplicit = true;
    }
    else if (arg === "--screenshot") options.screenshot = path.resolve(argv[++index]);
    else if (arg === "--app-path") options.appPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  return options;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error?.message || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

function localCdpVersionUrls(port) {
  return localCdpHosts.map((host) => `http://${host}:${port}/json/version`);
}

async function reachableLocalCdpVersionUrl(port) {
  for (const url of localCdpVersionUrls(port)) {
    if (await isReachable(url)) return url;
  }
  return null;
}

async function waitForLocalCdpVersionUrl(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await reachableLocalCdpVersionUrl(port);
    if (url) return url;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for Codex CDP on port ${port}`);
}

async function waitUntilReachable(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isReachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForCodexRenderer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const stableTargets = createStableTargetTracker(codexRendererStabilityMs);
  while (Date.now() < deadline) {
    try {
      const targets = await codexTargets(port);
      if (stableTargets.update(targets)) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for a Codex renderer target");
}

function startTaskboard({ detached }) {
  return spawn(process.execPath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached,
    env: {
      ...process.env,
      CODEX_TASKBOARD_PORT: String(managedTaskboardPort),
    },
    stdio: detached ? "ignore" : "inherit",
    windowsHide: true,
  });
}

function createTaskboardSupervisor({ detached }) {
  let child = null;
  let ensureInFlight = null;
  let retryAfter = 0;
  let stopping = false;

  async function ensure({ force = false } = {}) {
    if (await isReachable(taskboardHealthUrl)) {
      return { status: "ok", restarted: false };
    }
    if (ensureInFlight) return ensureInFlight;
    if (!force && Date.now() < retryAfter) {
      throw new Error("Taskboard restart is waiting before its next attempt");
    }

    ensureInFlight = (async () => {
      if (child?.exitCode === null && !child.killed) {
        try {
          await waitUntilReachable(taskboardHealthUrl, 3_000);
          return { status: "ok", restarted: false };
        } catch (_) {}
      }

      const started = startTaskboard({ detached });
      child = started;
      if (detached) started.unref();
      started.once("error", (error) => {
        if (!stopping) console.error(`Taskboard process error: ${error.message}`);
      });
      started.once("exit", (code, signal) => {
        if (child === started) child = null;
        if (!stopping && !detached && code !== 0) {
          console.error(`Taskboard exited (${signal || code}); it will be restarted automatically.`);
        }
      });

      try {
        await waitUntilReachable(taskboardHealthUrl, 10_000);
        retryAfter = 0;
        return { status: "ok", restarted: true };
      } catch (error) {
        retryAfter = Date.now() + 2_000;
        throw error;
      }
    })();

    try {
      return await ensureInFlight;
    } finally {
      ensureInFlight = null;
    }
  }

  function stop() {
    stopping = true;
    if (child?.exitCode === null && !child.killed) child.kill("SIGTERM");
  }

  return { ensure, stop };
}

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

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForCodexExit(timeoutMs, pids = []) {
  const deadline = Date.now() + timeoutMs;
  const stillRunning = () => (
    pids.length > 0 ? pids.some(processIsRunning) : codexIsRunning()
  );
  while (stillRunning() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (stillRunning()) {
    throw new Error("Timed out waiting for the running Codex app to close.");
  }
}

function codexRootProcessIds() {
  if (process.platform !== "win32") return [];
  const result = spawnSync(
    "wmic.exe",
    ["process", "where", "name='ChatGPT.exe'", "get", "ProcessId,ParentProcessId", "/format:csv"],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.status !== 0) return [];
  const processes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim().split(","))
    .filter((columns) => columns.length >= 3)
    .map((columns) => ({
      parentPid: Number(columns.at(-2)),
      pid: Number(columns.at(-1)),
    }))
    .filter(({ parentPid, pid }) => Number.isInteger(parentPid) && Number.isInteger(pid));
  const pids = new Set(processes.map(({ pid }) => pid));
  return processes.filter(({ parentPid }) => !pids.has(parentPid)).map(({ pid }) => pid);
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function windowsCommandArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function startScheduledCodexRelauncher(options) {
  const args = [
    injectorPath,
    "--watch",
    "--launch",
    "--wait-for-codex-exit",
    "--port",
    String(options.port),
  ];
  for (const pid of codexRootProcessIds()) args.push("--wait-for-codex-pid", String(pid));
  if (options.open) args.push("--open");
  if (options.appPath) args.push("--app-path", options.appPath);

  const taskName = `CodexTaskboard-Relaunch-${randomUUID()}`;
  const actionArguments = args.map(windowsCommandArgument).join(" ");
  const command = [
    "$ErrorActionPreference='Stop'",
    `$taskName=${powershellLiteral(taskName)}`,
    `$action=New-ScheduledTaskAction -Execute ${powershellLiteral(process.execPath)} -Argument ${powershellLiteral(actionArguments)} -WorkingDirectory ${powershellLiteral(projectRoot)}`,
    "$trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).AddDays(1))",
    "$principal=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited",
    "$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
    "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null",
    "Start-ScheduledTask -TaskName $taskName",
    "$deadline=(Get-Date).AddSeconds(5)",
    "do { $state=(Get-ScheduledTask -TaskName $taskName).State; if ($state -eq 'Running') { break }; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $deadline)",
    "if ($state -ne 'Running') { throw 'Windows did not start the Codex relaunch task' }",
    "Unregister-ScheduledTask -TaskName $taskName -Confirm:$false",
  ].join("; ");
  const encodedCommand = Buffer.from(command, "utf16le").toString("base64");
  const scheduled = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
    {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (scheduled.status !== 0) {
    throw new Error(
      scheduled.stderr.trim() || scheduled.error?.message || "Windows could not schedule the Codex relaunch.",
    );
  }
  return {
    taskName,
    started: true,
    delegated: true,
  };
}

async function prepareCodexLaunch(options) {
  if (!codexIsRunning()) return null;
  if (options.waitForCodexExit) return null;
  if (process.platform !== "win32") {
    throw new Error(
      "Codex is already running without this CDP port. Quit Codex completely, then run this command again.",
    );
  }

  const relauncher = startScheduledCodexRelauncher(options);
  const stopped = spawnSync("taskkill.exe", ["/F", "/IM", "ChatGPT.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (stopped.status !== 0 && codexIsRunning()) {
    throw new Error("Could not close the running Codex app. Close it manually, then run this command again.");
  }

  return relauncher;
}

function launchCodex(appPath, port) {
  const debuggingArgs = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ];

  if (process.platform === "win32") {
    if (appPath) {
      return spawn(appPath, debuggingArgs, {
        cwd: path.dirname(appPath),
        stdio: "ignore",
        windowsHide: false,
      });
    }
    const windowsLauncher = path.join(projectRoot, "scripts", "start-windows-codex.ps1");
    const activation = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        windowsLauncher,
        "-Port",
        String(port),
      ],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    if (activation.status !== 0) {
      throw new Error(
        activation.stderr.trim() || "Windows could not activate the Codex desktop app.",
      );
    }
    return null;
  }
  if (process.platform === "darwin") {
    return spawn("/usr/bin/open", ["-W", "-a", appPath, "--args", ...debuggingArgs], {
      stdio: "ignore",
    });
  }
  throw new Error(`Launching Codex is not supported on ${process.platform}`);
}

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.eventHandlers = new Map();
    this.closed = false;
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        const waiters = this.eventWaiters.get(message.method) || [];
        this.eventWaiters.delete(message.method);
        waiters.forEach((waiter) => waiter.resolve(message.params));
        const handlers = this.eventHandlers.get(message.method) || [];
        handlers.forEach((handler) => {
          try {
            Promise.resolve(handler(message.params)).catch((error) => {
              console.error(`CDP ${message.method} handler failed: ${error.message}`);
            });
          } catch (error) {
            console.error(`CDP ${message.method} handler failed: ${error.message}`);
          }
        });
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      this.closed = true;
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
      this.eventWaiters.forEach((waiters) => waiters.forEach((waiter) => waiter.reject(error)));
      this.eventWaiters.clear();
      this.eventHandlers.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiters = this.eventWaiters.get(method) || [];
      const timeout = setTimeout(() => {
        this.eventWaiters.set(
          method,
          (this.eventWaiters.get(method) || []).filter((waiter) => waiter.resolve !== wrappedResolve),
        );
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
      const wrappedResolve = (value) => {
        clearTimeout(timeout);
        resolve(value);
      };
      waiters.push({ resolve: wrappedResolve, reject });
      this.eventWaiters.set(method, waiters);
    });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || [];
    handlers.push(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      this.eventHandlers.set(
        method,
        (this.eventHandlers.get(method) || []).filter((candidate) => candidate !== handler),
      );
    };
  }

  close() {
    this.socket.close();
  }
}

async function codexTargets(port) {
  let lastError;
  for (const host of localCdpHosts) {
    try {
      const targets = await fetchJson(`http://${host}:${port}/json/list`);
      return targets.filter(
        (target) =>
          target.type === "page" &&
          target.webSocketDebuggerUrl &&
          !target.url?.includes("initialRoute=%2Fglobal-dictation") &&
          !target.url?.includes("initialRoute=%2Favatar-overlay") &&
          (
            target.url?.startsWith("app://")
            || (process.platform !== "win32" && target.title === "Codex")
          ),
      ).sort((left, right) => Number(right.url === "app://-/index.html") - Number(left.url === "app://-/index.html"));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("Codex CDP endpoint is unreachable");
}

function codexDebuggingPorts(preferredPort) {
  const ports = new Set([preferredPort]);
  const processes = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [...ports];

  for (const command of processes.stdout.split("\n")) {
    if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
    const match = command.match(/--remote-debugging-port=(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

function processCwd(pid) {
  const result = spawnSync("/usr/sbin/lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "cwd",
    "-Fn",
  ], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  if (result.status !== 0) return null;
  const cwd = result.stdout.split("\n").find((line) => line.startsWith("n"))?.slice(1);
  return cwd ? path.resolve(cwd) : null;
}

function residentInjectorPids(port) {
  const processes = process.platform === "win32"
    ? spawnSync(
        "wmic.exe",
        ["process", "where", "name='node.exe'", "get", "ProcessId,CommandLine", "/format:list"],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      )
    : spawnSync("/bin/ps", ["-axo", "pid=,command="], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      });
  if (processes.status !== 0) return [];
  const processList = process.platform === "win32"
    ? parseWmicProcessList(processes.stdout)
    : processes.stdout;
  return findResidentInjectorPids({
    processList,
    currentPid: process.pid,
    injectorPath,
    projectRoot,
    port,
    defaultPort: defaultCodexDebuggingPort,
    cwdForPid: processCwd,
  });
}

function startResidentInjector(
  port,
  shouldOpen,
  attachExisting = false,
  startupToken = null,
  force = false,
) {
  const [existingPid] = residentInjectorPids(port);
  if (existingPid && !force) return { pid: existingPid, started: false };
  const args = [injectorPath, "--watch", "--port", String(port)];
  if (shouldOpen) args.push("--open");
  if (attachExisting) args.push("--attach-existing");
  if (startupToken) args.push("--startup-token", startupToken);
  const child = spawn(process.execPath, args, {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return { pid: child.pid, started: true };
}

async function stopResidentInjector(pid) {
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      return;
    }
  }
  throw new Error(`Timed out stopping resident Taskboard injector ${pid}`);
}

async function waitForResidentInjectorReady(port, pid, startupToken, expectedSourceHash) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      const targets = await codexTargets(port);
      for (const target of targets) {
        const cdp = new CdpConnection(target.webSocketDebuggerUrl);
        await cdp.open();
        try {
          const readiness = await cdp.send("Runtime.evaluate", {
            expression: `({
              token: window[${JSON.stringify(hostStartupTokenName)}],
              taskboardEntryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
              sourceHash: window.__codexTaskboardInjection__?.sourceHash || null
            })`,
            returnByValue: true,
          });
          if (
            readiness.result.value?.token === startupToken
            && readiness.result.value.taskboardEntryMounted
            && readiness.result.value.sourceHash === expectedSourceHash
          ) return;
        } finally {
          cdp.close();
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for resident Taskboard injector ${pid}`);
}

async function isResidentInjectorHealthy(port, pid, expectedSourceHash) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  try {
    for (const target of await codexTargets(port)) {
      const cdp = new CdpConnection(target.webSocketDebuggerUrl);
      await cdp.open();
      try {
        const health = await cdp.send("Runtime.evaluate", {
          expression: `({
            sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
            entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
            hostPid: Number(window[${JSON.stringify(hostPidName)}]),
            hostHeartbeat: Number(window[${JSON.stringify(hostHeartbeatName)}])
          })`,
          returnByValue: true,
        });
        const value = health.result.value;
        if (
          value?.sourceHash === expectedSourceHash
          && value.entryMounted
          && value.hostPid === pid
          && Date.now() - value.hostHeartbeat < 10_000
        ) return true;
      } finally {
        cdp.close();
      }
    }
  } catch (_) {}
  return false;
}

async function residentInjectorPidsFromRenderer(port) {
  const pids = new Set();
  for (const target of await codexTargets(port)) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `Number(window[${JSON.stringify(hostPidName)}])`,
        returnByValue: true,
      });
      const pid = Number(evaluation.result.value);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) pids.add(pid);
    } finally {
      cdp.close();
    }
  }
  return [...pids];
}

async function restartResidentInjectorForRefresh(port) {
  const publishedPids = await residentInjectorPidsFromRenderer(port);
  const { sourceHash } = await currentInjectionSource();
  return restartResidentInjector(port, {
    findResidents: (targetPort) => [
      ...new Set([...residentInjectorPids(targetPort), ...publishedPids]),
    ],
    stopResident: stopResidentInjector,
    createStartupToken: randomUUID,
    startResident: (targetPort, startupToken) => (
      startResidentInjector(targetPort, false, true, startupToken)
    ),
    waitUntilReady: (targetPort, pid, startupToken) => (
      waitForResidentInjectorReady(targetPort, pid, startupToken, sourceHash)
    ),
  });
}

async function refreshTaskboardFrames(port) {
  const targets = await codexTargets(port);
  const results = [];

  for (const target of targets) {
    const cdp = new CdpConnection(target.webSocketDebuggerUrl);
    await cdp.open();
    try {
      await cdp.send("Runtime.enable");
      const evaluation = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const taskboard = window.__codexTaskboardInjection__;
          if (typeof taskboard?.reloadFrame === "function") {
            return { refreshed: taskboard.reloadFrame(), via: "injection" };
          }
          const frame = document.getElementById("codex-taskboard-frame");
          if (!frame) return { refreshed: false, via: "not-mounted" };
          const url = new URL(frame.getAttribute("src") || frame.src);
          url.searchParams.set("__codex_taskboard_refresh", Date.now().toString(36));
          frame.setAttribute("src", url.href);
          return { refreshed: true, via: "fallback", frameUrl: url.href };
        })()`,
        returnByValue: true,
      });
      if (evaluation.exceptionDetails) {
        throw new Error(
          evaluation.exceptionDetails.exception?.description || "Taskboard frame refresh failed",
        );
      }
      results.push({
        targetId: target.id,
        title: target.title,
        url: target.url,
        ...evaluation.result.value,
      });
    } finally {
      cdp.close();
    }
  }

  return results;
}

function frameTreeContains(frameTree, expectedUrl) {
  if (frameTree.frame?.url === expectedUrl) return true;
  return frameTree.childFrames?.some((child) => frameTreeContains(child, expectedUrl)) || false;
}

async function waitForFrame(cdp, expectedUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [{ targetInfos }, { frameTree }] = await Promise.all([
      cdp.send("Target.getTargets"),
      cdp.send("Page.getFrameTree"),
    ]);
    if (
      targetInfos.some((target) => target.type === "iframe" && target.url === expectedUrl) ||
      frameTreeContains(frameTree, expectedUrl)
    ) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function requestCodexAutomationViaCdp(cdp, executionContextId, method, params) {
  if (!codexAutomationMethods.has(method)) {
    throw new Error(`Unsupported Codex automation method: ${method}`);
  }
  const requestId = [
    "taskboard-automation",
    process.pid,
    Date.now().toString(36),
    (++codexAutomationRequestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const method = ${JSON.stringify(method)};
      const params = ${JSON.stringify(params)};
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "当前 Codex 版本没有提供原生自动任务能力" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        finish({
          ok: true,
          responseType: message.responseType,
          status: message.status,
          bodyJsonString: message.bodyJsonString,
        });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex 自动任务接口没有响应" }),
        10_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: \`vscode://codex/${method}\`,
        body: JSON.stringify(params),
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    ...(Number.isInteger(executionContextId) ? { contextId: executionContextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex automation request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex automation request failed");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Codex automation request returned HTTP ${response.status}`);
  }
  if (typeof response.bodyJsonString !== "string" || response.bodyJsonString.length === 0) {
    return {};
  }
  try {
    return JSON.parse(response.bodyJsonString);
  } catch {
    throw new Error("Codex automation request returned invalid JSON");
  }
}

async function applyTaskboardAutomationPolicy(
  request,
  rpc,
  stillCurrent = () => true,
  { syncTaskboardPolicy = false } = {},
) {
  const quota = request.quotaAware
    ? await readCodexQuotaStatus(request.model)
    : null;
  if (!stillCurrent()) return { quota, stale: true };
  const quotaAllowsRun = !request.quotaAware || quota?.state === "available";
  let summary;
  if (request.enabledByUser && quotaAllowsRun) {
    await reconcileTaskboardAutomationSessions(request);
    if (!stillCurrent()) return { quota, stale: true };
    summary = await fillTaskboardAutomationSlots(request);
  } else {
    summary = await readTaskboardAutomationSummary(request);
  }
  if (!stillCurrent()) return { quota, stale: true };
  const activeExecutions = new Map(
    (Array.isArray(summary?.executions) ? summary.executions : [])
      .map((execution) => [execution.slotNumber, execution]),
  );
  const previousIds = {};
  const seenAutomationIds = new Set();
  const explicitSlotIds = request.slotAutomationIds ?? {};
  const orderedSlots = [
    ...[...activeExecutions.keys()].sort((left, right) => left - right),
    ...Object.keys(explicitSlotIds).map(Number).sort((left, right) => left - right),
  ];
  for (const slotNumber of orderedSlots) {
    const automationId = explicitSlotIds[slotNumber];
    if (!automationId || seenAutomationIds.has(automationId)) continue;
    previousIds[slotNumber] = automationId;
    seenAutomationIds.add(automationId);
  }
  if (Object.keys(previousIds).length === 0 && request.automationId) {
    previousIds[[...activeExecutions.keys()].sort((left, right) => left - right)[0] ?? 1] = request.automationId;
  }
  const listedAutomations = await rpc("list-automations", {});
  const nativeAutomations = Array.isArray(listedAutomations?.items) ? listedAutomations.items : [];
  const recentlyLaunchedAutomationIds = new Set(
    nativeAutomations
      .filter((item) => (
        item?.status === "ACTIVE"
        && Number.isFinite(item?.lastRunAt)
        && Date.now() - item.lastRunAt >= 0
        && Date.now() - item.lastRunAt < automationLaunchGraceMs
      ))
      .map((item) => item.id),
  );
  const slotAutomationIds = {};
  const items = [];
  const runningDevelopmentCount = [...activeExecutions.values()]
    .filter((execution) => execution.phase === "working" && execution.runOwnerThreadId !== null)
    .length;
  const pendingExecutions = [...activeExecutions.values()]
    .filter(canScheduleTaskboardAutomationExecution)
    .sort((left, right) => left.slotNumber - right.slotNumber);
  const runnableExecutions = [
    ...pendingExecutions.filter((execution) => execution.phase !== "working"),
    ...pendingExecutions
      .filter((execution) => execution.phase === "working")
      .slice(0, Math.max(0, request.concurrencyLimit - runningDevelopmentCount)),
  ];
  const scheduledSlots = new Set(runnableExecutions.map((execution) => execution.slotNumber));
  for (const execution of runnableExecutions) {
    if (!stillCurrent()) return { quota, stale: true };
    const slotNumber = execution.slotNumber;
    const configResult = await fetchJson(new URL(`/api/projects/${encodeURIComponent(request.taskboardProjectId)}/board-config`, taskboardOrigin));
    const boardConfig = normalizeBoardConfig(configResult.config);
    const selectedTask = boardConfig.automation.enabled ? await readAutomationTask(execution, boardConfig) : null;
    const existingAutomationId = previousIds[slotNumber];
    if (existingAutomationId && recentlyLaunchedAutomationIds.has(existingAutomationId)) {
      const existing = nativeAutomations.find((item) => item?.id === existingAutomationId);
      slotAutomationIds[slotNumber] = existingAutomationId;
      if (existing) items.push(existing);
      continue;
    }
    const result = await reconcileTaskboardAutomation(
      {
        ...request,
        boardConfig,
        slotNumber,
        automationId: previousIds[slotNumber],
        operation: request.enabledByUser && quotaAllowsRun && selectedTask ? "ensure-active" : "pause",
        ...(selectedTask ? { selectedTask } : {}),
      },
      rpc,
    );
    if (result?.item?.id) {
      slotAutomationIds[slotNumber] = result.item.id;
      items.push(result.item);
    } else if (previousIds[slotNumber]) {
      slotAutomationIds[slotNumber] = previousIds[slotNumber];
    }
  }
  for (const [slot, automationId] of Object.entries(previousIds)) {
    const slotNumber = Number(slot);
    if (scheduledSlots.has(slotNumber) || !automationId) continue;
    const result = await reconcileTaskboardAutomation(
      { ...request, slotNumber, automationId, operation: "pause" },
      rpc,
    );
    if (result?.item?.id) slotAutomationIds[slotNumber] = result.item.id;
  }
  const result = {
    ...(items.length > 0 ? { item: items.find((item) => item?.status === "ACTIVE") ?? items[0] } : {}),
    items,
    slotAutomationIds,
    summary,
    ...(quota ? { quota } : {}),
  };
  if (syncTaskboardPolicy) {
    await saveTaskboardAutomationPolicy(request, quotaAllowsRun);
    if (!stillCurrent()) return { ...result, stale: true };
  }
  return result;
}

async function fillTaskboardAutomationSlots(request) {
  await fetchJson(
    new URL(`/api/local/automation/projects/${encodeURIComponent(request.taskboardProjectId)}/retry-cleanup`, taskboardOrigin),
    { method: "POST", headers: { "x-taskboard-client": "clb" } },
  );
  return fetchJson(
    new URL(`/api/local/automation/projects/${encodeURIComponent(request.taskboardProjectId)}/fill`, taskboardOrigin),
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-taskboard-client": "clb" },
      body: JSON.stringify({
        workspacePath: request.workspacePath,
        concurrencyLimit: request.concurrencyLimit,
      }),
    },
  );
}

async function reconcileTaskboardAutomationSessions(request) {
  return fetchJson(
    new URL(`/api/local/automation/projects/${encodeURIComponent(request.taskboardProjectId)}/reconcile-sessions`, taskboardOrigin),
    { method: "POST", headers: { "x-taskboard-client": "clb" } },
  );
}

async function readTaskboardAutomationSummary(request) {
  const url = new URL(`/api/local/automation/projects/${encodeURIComponent(request.taskboardProjectId)}`, taskboardOrigin);
  url.searchParams.set("concurrencyLimit", String(request.concurrencyLimit));
  return fetchJson(url);
}

async function saveTaskboardAutomationPolicy(request, quotaAllowsRun) {
  return fetchJson(
    new URL(`/api/local/automation/projects/${encodeURIComponent(request.taskboardProjectId)}/policy`, taskboardOrigin),
    {
      method: "PUT",
      headers: { "content-type": "application/json", "x-taskboard-client": "clb" },
      body: JSON.stringify({
        projectName: request.projectName,
        workspacePath: request.workspacePath,
        skillPath: request.skillPath,
        enabledByUser: request.enabledByUser,
        quotaAware: request.quotaAware,
        quotaAllowsRun,
        concurrencyLimit: request.concurrencyLimit,
        intervalMinutes: request.intervalMinutes,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
      }),
    },
  );
}

async function readAutomationTask(execution, boardConfig) {
  const working = boundStatus(boardConfig, "working");
  const result = await fetchJson(
    new URL(`/api/tasks/${encodeURIComponent(execution.taskId)}`, taskboardOrigin),
  );
  let task = result?.task;
  if (!task || task.archivedAt !== null) return null;
  if (task.status !== working) {
    const moved = await fetchJson(
      new URL(`/api/tasks/${encodeURIComponent(execution.taskId)}/move`, taskboardOrigin),
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-taskboard-client": "clb" },
        body: JSON.stringify({ version: task.version, status: working }),
      },
    );
    task = moved?.task;
  }
  if (!task || task.status !== working) {
    throw new Error(`Taskboard did not restore automation task ${execution.taskId} to ${working}`);
  }
  return {
    identifier: task.identifier,
    title: task.title,
    ...(task.automationExecution ? { automationExecution: task.automationExecution } : { automationExecution: execution }),
    externalIssue: task.externalIssue ?? null,
    delivery: task.delivery ?? { mode: "review", repositories: [] },
  };
}

function storedAutomationPolicy(request) {
  return {
    taskboardProjectId: request.taskboardProjectId,
    codexProjectId: request.codexProjectId,
    projectName: request.projectName,
    workspacePath: request.workspacePath,
    skillPath: request.skillPath,
    ...(request.automationId ? { automationId: request.automationId } : {}),
    ...(request.slotAutomationIds ? { slotAutomationIds: request.slotAutomationIds } : {}),
    enabledByUser: request.enabledByUser,
    quotaAware: request.quotaAware,
    concurrencyLimit: request.concurrencyLimit,
    intervalMinutes: request.intervalMinutes,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
  };
}

function restoredAutomationPolicy(value) {
  return parseTaskboardAutomationHostRequest({
    ...value,
    concurrencyLimit: value?.concurrencyLimit ?? 6,
    slotAutomationIds: value?.slotAutomationIds
      ?? (value?.automationId ? { 1: value.automationId } : undefined),
    id: "restored-policy",
    action: "automation",
    requestId: "restored-policy",
    operation: "apply-policy",
  });
}

async function ensureQuotaPoliciesLoaded() {
  if (quotaPoliciesLoadPromise) return quotaPoliciesLoadPromise;
  quotaPoliciesLoadPromise = (async () => {
    let stored = {};
    try {
      stored = JSON.parse(await readFile(automationPoliciesPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
    for (const value of Object.values(stored)) {
      const request = restoredAutomationPolicy(value);
      if (!request) continue;
      quotaPolicyRecords.set(request.taskboardProjectId, { version: 1, request });
    }
  })();
  return quotaPoliciesLoadPromise;
}

async function syncStoredQuotaPolicyFromTaskboard(projectId) {
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return null;
  let policy;
  try {
    const result = await fetchJson(
      new URL(`/api/local/automation/projects/${encodeURIComponent(projectId)}/policy`, taskboardOrigin),
    );
    policy = result?.policy;
  } catch {
    return record;
  }
  if (!policy) return record;

  const request = {
    ...record.request,
    projectName: policy.projectName,
    workspacePath: policy.workspacePath,
    skillPath: policy.skillPath,
    enabledByUser: policy.enabledByUser,
    quotaAware: policy.quotaAware,
    concurrencyLimit: policy.concurrencyLimit,
    intervalMinutes: policy.intervalMinutes,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
  };
  const changed = [
    "projectName",
    "workspacePath",
    "skillPath",
    "enabledByUser",
    "quotaAware",
    "concurrencyLimit",
    "intervalMinutes",
    "model",
    "reasoningEffort",
  ].some((field) => request[field] !== record.request[field]);
  if (!changed) return record;

  const synchronized = { version: record.version + 1, request };
  quotaPolicyRecords.set(projectId, synchronized);
  await persistQuotaPolicies();
  return synchronized;
}

function persistQuotaPolicies() {
  const data = Object.fromEntries(
    [...quotaPolicyRecords.entries()].map(([projectId, record]) => [
      projectId,
      storedAutomationPolicy(record.request),
    ]),
  );
  quotaPoliciesWritePromise = quotaPoliciesWritePromise
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(automationPoliciesPath), { recursive: true });
      await writeFile(automationPoliciesPath, `${JSON.stringify(data, null, 2)}\n`, {
        mode: 0o600,
      });
    });
  return quotaPoliciesWritePromise;
}

function scheduleQuotaPolicyCheck(record, cdp, result) {
  const { request, version } = record;
  const key = request.taskboardProjectId;
  const previous = quotaPolicyTimers.get(key);
  if (previous) clearTimeout(previous);
  quotaPolicyTimers.delete(key);
  if (!request.enabledByUser) return;

  const nextRunAt = Number(result.items?.find((item) => item?.status === "ACTIVE")?.nextRunAt ?? result.item?.nextRunAt);
  const nextRunDelay = result.item?.status === "ACTIVE"
    && Number.isFinite(nextRunAt)
    && nextRunAt > Date.now()
    ? Math.max(1_000, nextRunAt - Date.now() + automationLaunchGraceMs)
    : request.intervalMinutes * 60_000;
  const resetDelay = request.quotaAware
    && result.quota?.state === "blocked"
    && Number.isFinite(result.quota.resetsAt)
    ? Math.max(1_000, result.quota.resetsAt * 1_000 - Date.now() + 1_000)
    : nextRunDelay;
  const timer = setTimeout(async () => {
    if (quotaPolicyRecords.get(key)?.version !== version) return;
    try {
      await enqueueCurrentQuotaPolicy(key, cdp);
    } catch (error) {
      console.error(`Taskboard quota policy check failed: ${error.message}`);
      const current = quotaPolicyRecords.get(key);
      if (current?.version === version) {
        scheduleQuotaPolicyCheck(current, cdp, { quota: { state: "unknown" } });
      }
    }
  }, Math.min(nextRunDelay, resetDelay));
  timer.unref();
  quotaPolicyTimers.set(key, timer);
}

function enqueueQuotaPolicyMutation(record, cdp, rpc, { syncTaskboardPolicy = false } = {}) {
  const key = record.request.taskboardProjectId;
  const previous = quotaPolicyQueues.get(key) ?? Promise.resolve();
  const run = previous
    .catch(() => {})
    .then(async () => {
      const current = quotaPolicyRecords.get(key);
      if (!current || current.version !== record.version) return { stale: true };
      const result = await applyTaskboardAutomationPolicy(
        current.request,
        rpc,
        () => quotaPolicyRecords.get(key)?.version === current.version,
        { syncTaskboardPolicy },
      );
      if (result.stale) return result;
      if (
        quotaPolicyRecords.get(key)?.version === current.version
        && (result.item?.id || result.slotAutomationIds)
      ) {
        current.request = {
          ...current.request,
          ...(result.item?.id ? { automationId: result.item.id } : {}),
          ...(result.slotAutomationIds ? { slotAutomationIds: result.slotAutomationIds } : {}),
        };
        await persistQuotaPolicies();
      }
      scheduleQuotaPolicyCheck(current, cdp, result);
      return result;
    });
  const tracked = run.finally(() => {
    if (quotaPolicyQueues.get(key) === tracked) quotaPolicyQueues.delete(key);
  });
  quotaPolicyQueues.set(key, tracked);
  return tracked;
}

async function updateAndApplyQuotaPolicy(request, cdp, rpc) {
  await ensureQuotaPoliciesLoaded();
  const previous = quotaPolicyRecords.get(request.taskboardProjectId);
  const mergedRequest = {
    ...request,
    ...(previous?.request?.slotAutomationIds && !request.slotAutomationIds
      ? { slotAutomationIds: previous.request.slotAutomationIds }
      : {}),
  };
  const record = {
    version: (previous?.version ?? 0) + 1,
    request: mergedRequest,
  };
  quotaPolicyRecords.set(request.taskboardProjectId, record);
  try {
    await persistQuotaPolicies();
    return await enqueueQuotaPolicyMutation(record, cdp, rpc, { syncTaskboardPolicy: true });
  } catch (error) {
    if (quotaPolicyRecords.get(request.taskboardProjectId)?.version === record.version) {
      if (previous) quotaPolicyRecords.set(request.taskboardProjectId, previous);
      else quotaPolicyRecords.delete(request.taskboardProjectId);
      await persistQuotaPolicies();
    }
    throw error;
  }
}

async function readStoredAutomationPolicy(projectId) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  return record ? storedAutomationPolicy(record.request) : null;
}

async function enqueueCurrentQuotaPolicy(projectId, cdp) {
  await ensureQuotaPoliciesLoaded();
  const record = quotaPolicyRecords.get(projectId);
  if (!record) return { stale: true };
  return enqueueQuotaPolicyMutation(
    record,
    cdp,
    (method, body) => requestCodexAutomationViaCdp(cdp, undefined, method, body),
  );
}

async function restoreQuotaPolicies(cdp) {
  if (quotaPoliciesRestored) return;
  quotaPoliciesRestored = true;
  await ensureQuotaPoliciesLoaded();
  for (const projectId of quotaPolicyRecords.keys()) {
    const record = await syncStoredQuotaPolicyFromTaskboard(projectId);
    if (record.request.enabledByUser) {
      void enqueueCurrentQuotaPolicy(projectId, cdp).catch((error) => {
        console.error(`Taskboard quota policy restore failed: ${error.message}`);
      });
    }
  }
  void watchTaskboardAutomationEvents(cdp);
}

async function watchTaskboardAutomationEvents(cdp) {
  while (true) {
    try {
      const response = await fetch(new URL("/api/events", taskboardOrigin), {
        headers: { accept: "text/event-stream" },
      });
      if (!response.ok || !response.body) throw new Error(`Taskboard events returned HTTP ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary).replace(/\r/g, "");
          buffer = buffer.slice(boundary + 2);
          const data = block.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          if (!data) continue;
          const event = JSON.parse(data);
          if (
            typeof event?.type !== "string"
            || !event.type.startsWith("task.")
            || event.type.startsWith("task.automation.session.")
            || !event.projectId
          ) continue;
          scheduleAutomationEventReconcile(event.projectId, cdp);
        }
      }
    } catch (error) {
      console.error(`Taskboard automation event stream disconnected: ${error.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

function scheduleAutomationEventReconcile(projectId, cdp) {
  const previous = automationEventTimers.get(projectId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    automationEventTimers.delete(projectId);
    const record = quotaPolicyRecords.get(projectId);
    if (!record?.request.enabledByUser) return;
    void enqueueCurrentQuotaPolicy(projectId, cdp).catch((error) => {
      console.error(`Taskboard automation event reconcile failed: ${error.message}`);
    });
  }, 150);
  timer.unref();
  automationEventTimers.set(projectId, timer);
}

async function prefillTaskComposerViaCdp(cdp, executionContextId, request) {
  const {
    instruction,
    skillDisplayName,
    skillName,
    skillPath,
  } = request;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const prepared = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!editor) return { ready: false };
        const mention = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => (
            candidate.getAttribute("skill-mention-name") === skillName
            && candidate.getAttribute("skill-mention-path") === skillPath
          ));
        if (mention && (editor.textContent || "").includes(instruction)) {
          return { ready: true, matches: true };
        }
        editor.focus();
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection?.removeAllRanges();
        selection?.addRange(range);
        return { ready: true, matches: false };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (!prepared.result.value?.ready) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      continue;
    }
    if (prepared.result.value.matches) return { prefilled: true };

    await cdp.send("Input.insertText", { text: "$" });
    break;
  }

  let selectedSkill = false;
  while (Date.now() < deadline) {
    const selection = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const displayName = ${JSON.stringify(skillDisplayName)};
        const overlay = Array.from(document.querySelectorAll(
          '[data-composer-overlay-floating-ui="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!overlay) return { ready: false };
        const button = Array.from(overlay.querySelectorAll(
          'button[data-list-navigation-item="true"]'
        )).find((candidate) => Array.from(candidate.querySelectorAll("span"))
          .some((label) => (label.textContent || "").trim() === displayName));
        if (!button) return { ready: true, found: false };
        button.click();
        return { ready: true, found: true };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (selection.result.value?.found) {
      selectedSkill = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!selectedSkill) {
    throw new Error(`Timed out while selecting the ${skillDisplayName} Skill`);
  }

  let mentionReady = false;
  while (Date.now() < deadline) {
    const mention = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        if (!editor) return { ready: false };
        const selected = Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => candidate.getAttribute("skill-mention-name") === skillName);
        return {
          ready: Boolean(selected),
          pathMatches: selected?.getAttribute("skill-mention-path") === skillPath,
        };
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (mention.result.value?.ready) {
      if (!mention.result.value.pathMatches) {
        throw new Error(`Codex selected a different ${skillDisplayName} Skill`);
      }
      mentionReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  if (!mentionReady) {
    throw new Error(`Timed out while creating the ${skillDisplayName} Skill mention`);
  }

  await cdp.send("Input.insertText", { text: instruction });
  while (Date.now() < deadline) {
    const verified = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const instruction = ${JSON.stringify(instruction)};
        const skillName = ${JSON.stringify(skillName)};
        const skillPath = ${JSON.stringify(skillPath)};
        const editor = Array.from(document.querySelectorAll(
          '[data-codex-composer="true"][contenteditable="true"]'
        )).find((candidate) => candidate.getClientRects().length > 0);
        const mention = editor && Array.from(editor.querySelectorAll("[skill-mention-name]"))
          .find((candidate) => (
            candidate.getAttribute("skill-mention-name") === skillName
            && candidate.getAttribute("skill-mention-path") === skillPath
          ));
        return Boolean(mention && (editor.textContent || "").includes(instruction));
      })()`,
      contextId: executionContextId,
      returnByValue: true,
    });
    if (verified.result.value === true) return { prefilled: true };
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out while writing the issue instruction into the Codex composer");
}

async function sendHostResponse(cdp, executionContextId, response) {
  await cdp.send("Runtime.evaluate", {
    expression: `window.__codexTaskboardInjection__?.hostResponse(${JSON.stringify(response)})`,
    contextId: executionContextId,
    returnByValue: true,
  });
}

async function installTaskboardHostBinding(cdp, supervisor) {
  cdp.on("Runtime.bindingCalled", async (params) => {
    if (params.name !== hostBindingName) return;
    await handleHostBindingPayload(params, {
      parseAutomationRequest: parseTaskboardAutomationHostRequest,
      ensure: () => supervisor.ensure({ force: true }),
      runAutomation: (request, executionContextId) => (
        (async () => {
          const rpc = (method, body) => requestCodexAutomationViaCdp(
            cdp,
            executionContextId,
            method,
            body,
          );
          const result = request.operation === "apply-policy"
            ? await updateAndApplyQuotaPolicy(request, cdp, rpc)
            : await reconcileTaskboardAutomation(request, rpc);
          if (request.operation === "list") {
            const [policy, summary] = await Promise.all([
              readStoredAutomationPolicy(request.taskboardProjectId),
              readTaskboardAutomationSummary(request),
            ]);
            return { ...result, ...(policy ? { policy } : {}), summary };
          }
          return result;
        })()
      ),
      prefill: (request, executionContextId) => (
        prefillTaskComposerViaCdp(cdp, executionContextId, request)
      ),
      sendResponse: (executionContextId, response) => (
        sendHostResponse(cdp, executionContextId, response)
      ),
    });
  });
  await cdp.send("Runtime.addBinding", { name: hostBindingName });
  await restoreQuotaPolicies(cdp);
}

async function publishHostHeartbeat(cdp, startupToken) {
  await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      window[${JSON.stringify(hostHeartbeatName)}] = Date.now();
      window[${JSON.stringify(hostPidName)}] = ${process.pid};
      window[${JSON.stringify(hostStartupTokenName)}] = ${JSON.stringify(startupToken)};
    })()`,
    returnByValue: true,
  });
}

async function readInjectionStatus(cdp) {
  const status = await cdp.send("Runtime.evaluate", {
    expression: `({
      version: window.__codexTaskboardInjection__?.version || null,
      sourceHash: window.__codexTaskboardInjection__?.sourceHash || null,
      scriptIdentifier: window[${JSON.stringify(injectionScriptIdentifierName)}] || null,
      entryMounted: Boolean(document.getElementById("codex-taskboard-entry")),
      pageMounted: Boolean(document.getElementById("codex-taskboard-page")),
      pageVisible: document.getElementById("codex-taskboard-page")?.hidden === false,
      startupStatus: window.__codexTaskboardInjection__?.startupStatus || null,
      frameUrl: document.getElementById("codex-taskboard-frame")?.src || null
    })`,
    returnByValue: true,
  });
  return status.result.value;
}

async function waitForInjectionStatus(cdp, shouldOpen, expectedSourceHash, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let status = await readInjectionStatus(cdp);
  while (
    Date.now() < deadline
    && (
      status.sourceHash !== expectedSourceHash
      || !status.entryMounted
      || (shouldOpen && (!status.pageVisible || !status.frameUrl))
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    status = await readInjectionStatus(cdp);
  }
  return status;
}

async function evaluateInjectionSource(cdp, source) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: source,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description || "Taskboard injection failed",
    );
  }
}

async function openTaskboardWithRecovery(cdp, timeoutMs = 20_000) {
  await cdp.send("Page.enable");
  await cdp.send("Page.setBypassCSP", { enabled: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await evaluateInjectionSource(cdp, "window.__codexTaskboardInjection__?.open()");
    const deadline = Date.now() + timeoutMs;
    let status;
    do {
      status = await readInjectionStatus(cdp);
      if (status.startupStatus?.ready) return { ready: true, reloaded: attempt === 1 };
      if (status.startupStatus?.cspBlocked) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    if (!status.startupStatus?.cspBlocked) throw new Error("Loop看板未完成加载，未刷新 Codex");
    if (attempt === 1) throw new Error("刷新一次后Loop看板仍被 CSP 拦截，已停止重试");
    const loaded = cdp.waitFor("Page.loadEventFired", timeoutMs);
    await Promise.all([loaded, cdp.send("Page.reload")]);
  }
}

async function publishInjectionScriptIdentifier(cdp, scriptIdentifier) {
  await cdp.send("Runtime.evaluate", {
    expression: `window[${JSON.stringify(injectionScriptIdentifierName)}] = ${JSON.stringify(scriptIdentifier)}`,
    returnByValue: true,
  });
}

async function registerInjectionSource(cdp, source) {
  const registration = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `${source}\n//# sourceURL=codex-taskboard.user.js`,
  });
  return registration.identifier;
}

async function injectTarget(
  target,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const cdp = new CdpConnection(target.webSocketDebuggerUrl);
  let retained = false;
  await cdp.open();
  try {
    await cdp.send("Page.enable");
    await cdp.send("Page.setBypassCSP", { enabled: true });
    await cdp.send("Runtime.enable");
    if (keepAlive) await installTaskboardHostBinding(cdp, supervisor);
    const currentStatus = await readInjectionStatus(cdp);
    const reconciled = await reconcileInjectionRuntime({
      currentStatus,
      source,
      sourceHash,
      shouldOpen,
      removeRegisteredSource: (identifier) => cdp.send(
        "Page.removeScriptToEvaluateOnNewDocument",
        { identifier },
      ),
      registerCurrentSource: (currentSource) => registerInjectionSource(cdp, currentSource),
      evaluateCurrentSource: (currentSource) => evaluateInjectionSource(cdp, currentSource),
      publishRegistration: (identifier) => publishInjectionScriptIdentifier(cdp, identifier),
      reopen: () => cdp.send("Runtime.evaluate", {
        expression: "window.__codexTaskboardInjection__?.open()",
        returnByValue: true,
      }),
    });
    cdp.on("Page.loadEventFired", async () => {
      await publishInjectionScriptIdentifier(cdp, reconciled.scriptIdentifier);
      if (keepAlive) await publishHostHeartbeat(cdp, startupToken);
    });
    if (keepAlive) await publishHostHeartbeat(cdp, startupToken);
    if (reconciled.shouldRemainOpen) await openTaskboardWithRecovery(cdp);
    const status = await waitForInjectionStatus(cdp, reconciled.shouldRemainOpen, sourceHash, 15_000);
    const frameLoaded = status.frameUrl
      ? await waitForFrame(cdp, status.frameUrl, 15_000)
      : false;
    if (shouldOpen && !frameLoaded) {
      throw new Error("Taskboard iframe did not finish loading in the Codex renderer");
    }
    const result = {
      ...status,
      cspBypassed: true,
      frameLoaded,
    };
    if (screenshotPath) {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" });
      await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
      result.screenshot = screenshotPath;
    }
    retained = keepAlive;
    return { result, connection: retained ? cdp : null };
  } finally {
    if (!retained) cdp.close();
  }
}

async function injectAll(
  port,
  source,
  sourceHash,
  shouldOpen,
  screenshotPath,
  injectedTargets,
  keepAlive,
  supervisor,
  attachExisting,
  startupToken,
) {
  const targets = await codexTargets(port);
  if (targets.length === 0) throw new Error("No Codex renderer target found");

  const activeIds = new Set(targets.map((target) => target.id));
  for (const [id, connection] of injectedTargets) {
    if (!activeIds.has(id) || connection.closed) {
      connection.close();
      injectedTargets.delete(id);
    }
  }

  const results = [];
  for (const target of targets) {
    if (injectedTargets.has(target.id)) continue;
    const firstTarget = injectedTargets.size === 0 && results.length === 0;
    const { result, connection } = await injectTarget(
      target,
      source,
      sourceHash,
      shouldOpen && firstTarget,
      firstTarget ? screenshotPath : null,
      keepAlive,
      supervisor,
      attachExisting,
      startupToken,
    );
    if (connection) injectedTargets.set(target.id, connection);
    results.push({ targetId: target.id, title: target.title, url: target.url, ...result });
  }
  return results;
}

async function currentInjectionSource() {
  const userScript = await readFile(injectionPath, "utf8");
  const runtimeSource = `window.__CODEX_TASKBOARD_MANAGED_ORIGIN_V2__ = ${JSON.stringify(taskboardOrigin)};
window.__CODEX_TASKBOARD_URL_V2__ = ${JSON.stringify(taskboardPageUrl)};
window.__CODEX_TASKBOARD_MANAGED_ORIGIN__ = ${JSON.stringify(taskboardOrigin)};
if (typeof window.__CODEX_TASKBOARD_URL__ !== "string" || !window.__CODEX_TASKBOARD_URL__.trim()) {
  window.__CODEX_TASKBOARD_URL__ = ${JSON.stringify(taskboardPageUrl)};
}
${userScript}`;
  const sourceHash = createHash("sha256").update(runtimeSource).digest("hex");
  return {
    sourceHash,
    source: `window[${JSON.stringify(injectionSourceHashName)}] = ${JSON.stringify(sourceHash)};
${runtimeSource}`,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.waitForCodexExit) {
    await writeCodexRelaunchStatus("waiting_for_exit", { port: options.port });
    await waitForCodexExit(30_000, options.waitForCodexPids);
    await writeCodexRelaunchStatus("launching", { port: options.port });
  }

  if (options.daemon) {
    let port = options.port;
    const candidates = options.portExplicit
      ? [options.port]
      : codexDebuggingPorts(options.port);
    const activePort = await Promise.any(candidates.map(async (candidate) => {
      if (!(await reachableLocalCdpVersionUrl(candidate))) {
        throw new Error("unreachable");
      }
      return candidate;
    })).catch(() => null);

    if (activePort) {
      port = activePort;
    } else {
      if (!options.launch) throw new Error("No debuggable Codex window found");
      const delegated = await prepareCodexLaunch(options);
      if (delegated) {
        console.log(JSON.stringify({ launcher: delegated, port: options.port }, null, 2));
        return;
      }
      const launched = launchCodex(options.appPath, options.port);
      launched?.unref();
      await waitForLocalCdpVersionUrl(options.port, 30_000);
      port = options.port;
    }

    const { sourceHash } = await currentInjectionSource();
    let startupToken = randomUUID();
    let launcher = startResidentInjector(port, options.open, false, startupToken);
    if (
      !launcher.started
      && !(await isResidentInjectorHealthy(port, launcher.pid, sourceHash))
    ) {
      await stopResidentInjector(launcher.pid);
      startupToken = randomUUID();
      launcher = startResidentInjector(port, options.open, false, startupToken, true);
    }
    if (launcher.started) {
      await waitForResidentInjectorReady(port, launcher.pid, startupToken, sourceHash);
    }
    if (options.open) {
      const targets = await codexTargets(port);
      const target = targets.find((candidate) => candidate.url === "app://-/index.html") || targets[0];
      const cdp = new CdpConnection(target.webSocketDebuggerUrl);
      await cdp.open();
      try {
        await openTaskboardWithRecovery(cdp);
      } finally {
        cdp.close();
      }
    }
    if (options.waitForCodexExit) {
      await writeCodexRelaunchStatus("ready", { port, launcherPid: launcher.pid });
    }
    console.log(JSON.stringify({ launcher, port }, null, 2));
    return;
  }

  if (options.refresh || options.refreshIfRunning) {
    const ports = options.portExplicit
      ? [options.port]
      : codexDebuggingPorts(options.port);
    const refreshed = [];
    for (const port of ports) {
      if (!(await reachableLocalCdpVersionUrl(port))) continue;
      if (options.refreshIfRunning) await restartResidentInjectorForRefresh(port);
      const results = await refreshTaskboardFrames(port);
      refreshed.push(...results.map((result) => ({ port, ...result })));
    }
    if (refreshed.length === 0) {
      if (options.refreshIfRunning) {
        console.log(JSON.stringify({ refreshed: [], skipped: "No debuggable Codex window is running" }));
        return;
      }
      throw new Error(`No debuggable Codex window found on ports: ${ports.join(", ")}`);
    }
    console.log(JSON.stringify({ refreshed }, null, 2));
    return;
  }

  let codexProcess = null;
  const supervisor = createTaskboardSupervisor({ detached: !options.watch });

  try {
    const cdpReachable = Boolean(await reachableLocalCdpVersionUrl(options.port));
    if (!cdpReachable) {
      if (!options.launch) {
        throw new Error(`Codex CDP is not listening on port ${options.port}`);
      }
      const delegated = await prepareCodexLaunch(options);
      if (delegated) {
        console.log(JSON.stringify({ launcher: delegated, port: options.port }, null, 2));
        return;
      }
    }

    await supervisor.ensure({ force: true });

    if (!cdpReachable) {
      codexProcess = launchCodex(options.appPath, options.port);
      await waitForLocalCdpVersionUrl(options.port, 30_000);
    }
    await waitForCodexRenderer(options.port, 30_000);

    const { source, sourceHash } = await currentInjectionSource();
    const injectedTargets = new Map();
    const firstResults = await injectAll(
      options.port,
      source,
      sourceHash,
      options.open,
      options.screenshot,
      injectedTargets,
      options.watch,
      supervisor,
      options.attachExisting,
      options.startupToken,
    );
    if (options.waitForCodexExit) {
      await writeCodexRelaunchStatus("ready", { port: options.port, launcherPid: process.pid });
    }
    console.log(JSON.stringify({ injected: firstResults }, null, 2));

    if (!options.watch) {
      codexProcess?.unref();
      return;
    }

    const stop = () => {
      injectedTargets.forEach((connection) => connection.close());
      supervisor.stop();
      process.exit(0);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    while (true) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      try {
        await supervisor.ensure();
      } catch (error) {
        console.error(`Waiting for Taskboard service: ${error.message}`);
      }
      for (const connection of injectedTargets.values()) {
        try {
          await publishHostHeartbeat(connection, options.startupToken);
        } catch (_) {}
      }
      try {
        const results = await injectAll(
          options.port,
          source,
          sourceHash,
          false,
          null,
          injectedTargets,
          true,
          supervisor,
          options.attachExisting,
          options.startupToken,
        );
        if (results.length > 0) console.log(JSON.stringify({ injected: results }, null, 2));
      } catch (error) {
        if (codexProcess && codexProcess.exitCode !== null) break;
        console.error(`Waiting for Codex renderer: ${error.message}`);
      }
    }
    supervisor.stop();
  } catch (error) {
    supervisor.stop();
    throw error;
  }
}

main().catch(async (error) => {
  if (process.argv.includes("--wait-for-codex-exit")) {
    await writeCodexRelaunchStatus("failed", { error: error.message }).catch(() => {});
  }
  console.error(error.message);
  process.exitCode = 1;
});
