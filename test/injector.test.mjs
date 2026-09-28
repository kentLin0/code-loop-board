import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const runtimeSource = await readFile(
  new URL("../scripts/codex-injector-runtime.mjs", import.meta.url),
  "utf8",
);
const injectionSource = await readFile(
  new URL("../inject/codex-taskboard.user.js", import.meta.url),
  "utf8",
);
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the resident injector supervises the fixed local Taskboard service", () => {
  assert.match(source, /function createTaskboardSupervisor/);
  assert.match(
    source,
    /const managedTaskboardPort = resolvePort\(process\.env\.CODEX_TASKBOARD_PORT \?\? "47824"\)/,
  );
  assert.match(source, /CODEX_TASKBOARD_PORT: String\(managedTaskboardPort\)/);
  assert.match(injectionSource, /DEFAULT_TASKBOARD_URL = "http:\/\/127\.0\.0\.1:47824\//);
  assert.match(source, /await isReachable\(taskboardHealthUrl\)/);
  assert.match(source, /ensureInFlight/);
  assert.match(source, /await supervisor\.ensure\(\)/);
  assert.match(source, /it will be restarted automatically/);
  assert.match(source, /AbortSignal\.timeout\(1_500\)/);
});

test("Taskboard background processes do not create Windows console windows", async () => {
  const [chatProcessSource, catalogSource, appSource, rateLimitSource] = await Promise.all([
    readFile(new URL("../server/ai-chat-process.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/ai-chat-catalog.mjs", import.meta.url), "utf8"),
    readFile(new URL("../server/app.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/codex-rate-limits.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(
    source,
    /function startTaskboard\([\s\S]*?stdio: detached \? "ignore" : "inherit",\s*windowsHide: true,/,
  );
  assert.match(
    source,
    /function startResidentInjector\([\s\S]*?stdio: "ignore",\s*windowsHide: true,/,
  );
  assert.match(
    chatProcessSource,
    /function spawnCodexTurn\([\s\S]*?stdio: \["pipe", "pipe", "pipe"\],\s*windowsHide: true,/,
  );
  assert.match(
    catalogSource,
    /function listSkills\([\s\S]*?stdio: \["pipe", "pipe", "ignore"\],\s*windowsHide: true,/,
  );
  assert.match(
    appSource,
    /async function discoverSkills\([\s\S]*?stdio: \["pipe", "pipe", "ignore"\],\s*windowsHide: true,/,
  );
  assert.match(
    rateLimitSource,
    /function startAppServer\([\s\S]*?stdio: \["pipe", "pipe", "ignore"\],\s*windowsHide: true,/,
  );
});

test("the CDP bridge accepts only service ensure and native Skill composer prefill actions", () => {
  assert.match(source, /const hostBindingName = "__codexTaskboardHostV2"/);
  assert.match(runtimeSource, /request\.action === "ensure"/);
  assert.match(runtimeSource, /request\.action === "prefill-task-composer"/);
  assert.match(runtimeSource, /request\.instruction\.length <= 1_024/);
  assert.match(runtimeSource, /request\.skillPath\.length <= 1_024/);
  assert.match(source, /function prefillTaskComposerViaCdp/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: "\$" \}\)/);
  assert.match(source, /data-composer-overlay-floating-ui/);
  assert.match(source, /button\[data-list-navigation-item="true"\]/);
  assert.match(source, /\[skill-mention-name\]/);
  assert.match(source, /skill-mention-path/);
  assert.match(source, /cdp\.send\("Input\.insertText", \{ text: instruction \}\)/);
  assert.match(source, /Runtime\.bindingCalled/);
  assert.match(runtimeSource, /params\.executionContextId/);
  assert.match(source, /hostResponse/);
  assert.match(source, /if \(keepAlive\) await installTaskboardHostBinding/);
  assert.match(source, /publishHostHeartbeat/);
  assert.match(source, /__codexTaskboardHostHeartbeatV2/);
});

test("the CDP bridge exposes only the fixed Taskboard automation operations", () => {
  assert.match(source, /parseTaskboardAutomationHostRequest/);
  assert.match(source, /reconcileTaskboardAutomation/);
  assert.match(runtimeSource, /request\.action === "automation"/);
  assert.match(source, /function requestCodexAutomationViaCdp/);
  assert.match(source, /new Set\(\[\s*"list-automations",\s*"automation-create",\s*"automation-update",\s*\]\)/);
  assert.match(source, /bridge\.sendMessageFromView\(\{\s*type: "fetch",\s*requestId,/);
  assert.match(source, /method: "POST"/);
  assert.match(source, /vscode:\/\/codex\/\$\{method\}/);
  assert.match(source, /body: JSON\.stringify\(params\)/);
  assert.match(source, /message\.type !== "fetch-response"/);
  assert.match(source, /message\.responseType/);
  assert.match(source, /message\.status/);
  assert.match(source, /message\.bodyJsonString/);
  assert.doesNotMatch(source, /automation-delete/);
  assert.doesNotMatch(source, /automations\.toml/);
});

test("listing an automation refreshes the current Taskboard summary", () => {
  const listStart = source.indexOf('if (request.operation === "list")');
  const listEnd = source.indexOf("return result;", listStart);
  const listBranch = source.slice(listStart, listEnd);

  assert.match(listBranch, /readTaskboardAutomationSummary\(request\)/);
  assert.match(listBranch, /return \{ \.\.\.result,[\s\S]*summary/);
});

test("the package injection command remains resident for tab-triggered recovery", () => {
  assert.match(packageJson.scripts["codex:inject"], /--watch/);
  assert.match(packageJson.scripts["codex:daemon"], /--daemon --open/);
  assert.match(source, /function startResidentInjector/);
  assert.match(source, /const defaultCodexDebuggingPort = 9229/);
  assert.match(source, /port: defaultCodexDebuggingPort/);
  assert.match(source, /--startup-token/);
  assert.match(source, /__codexTaskboardHostStartupTokenV2/);
});

test("the desktop launcher starts Codex and hands off to a detached resident injector", () => {
  assert.match(packageJson.scripts.codex, /--launch --daemon --open/);
  const daemonStart = source.indexOf("if (options.daemon) {");
  const daemonEnd = source.indexOf("if (options.refresh || options.refreshIfRunning)");
  const daemonBranch = source.slice(daemonStart, daemonEnd);
  assert.match(daemonBranch, /options\.launch/);
  assert.match(daemonBranch, /launchCodex/);
  assert.match(daemonBranch, /startResidentInjector/);
  assert.match(daemonBranch, /waitForResidentInjectorReady/);
});

test("a session-triggered restart is owned by Windows before closing Codex", () => {
  const scheduledStart = source.indexOf("function startScheduledCodexRelauncher");
  const scheduledEnd = source.indexOf("async function prepareCodexLaunch", scheduledStart);
  const scheduledBranch = source.slice(scheduledStart, scheduledEnd);
  const prepareStart = source.indexOf("async function prepareCodexLaunch");
  const prepareEnd = source.indexOf("function launchCodex", prepareStart);
  const prepareBranch = source.slice(prepareStart, prepareEnd);

  assert.match(source, /function startScheduledCodexRelauncher/);
  assert.match(source, /Register-ScheduledTask/);
  assert.match(source, /Start-ScheduledTask/);
  assert.match(source, /Unregister-ScheduledTask/);
  assert.match(scheduledBranch, /New-ScheduledTaskSettingsSet/);
  assert.match(scheduledBranch, /-AllowStartIfOnBatteries/);
  assert.match(scheduledBranch, /-DontStopIfGoingOnBatteries/);
  assert.match(scheduledBranch, /-Settings \$settings/);
  assert.match(source, /codex-relaunch-status\.json/);
  assert.match(source, /writeCodexRelaunchStatus/);
  assert.match(source, /--wait-for-codex-exit/);
  assert.match(source, /--wait-for-codex-pid/);
  assert.match(source, /codexRootProcessIds/);
  assert.match(source, /waitForCodexExit\(30_000, options\.waitForCodexPids\)/);
  assert.match(source, /if \(options\.waitForCodexExit\) return null/);
  assert.match(scheduledBranch, /"--watch"/);
  assert.doesNotMatch(scheduledBranch, /"--daemon"/);
  assert.ok(
    prepareBranch.indexOf("startScheduledCodexRelauncher")
      < prepareBranch.indexOf('spawnSync("taskkill.exe"'),
    "Windows Task Scheduler must own the relaunch before ChatGPT.exe is stopped",
  );
});

test("the desktop launcher replaces a resident injector that no longer mounts the Taskboard", () => {
  const daemonStart = source.indexOf("if (options.daemon) {");
  const daemonEnd = source.indexOf("if (options.refresh || options.refreshIfRunning)");
  const daemonBranch = source.slice(daemonStart, daemonEnd);

  assert.match(source, /async function isResidentInjectorHealthy/);
  assert.match(daemonBranch, /await isResidentInjectorHealthy\(port, launcher\.pid, sourceHash\)/);
  assert.match(daemonBranch, /await stopResidentInjector\(launcher\.pid\)/);
  assert.match(daemonBranch, /startResidentInjector\(port, options\.open, false, startupToken, true\)/);
});

test("attach reconciles the renderer against a hashed current injection source", () => {
  assert.match(source, /createHash\("sha256"\)/);
  assert.match(source, /__CODEX_TASKBOARD_SOURCE_HASH__/);
  assert.match(source, /sourceHash: window\.__codexTaskboardInjection__\?\.sourceHash \|\| null/);
  assert.match(source, /const injectionScriptIdentifierName = "__CODEX_TASKBOARD_SCRIPT_IDENTIFIER__"/);
  assert.match(source, /scriptIdentifier: window\[\$\{JSON\.stringify\(injectionScriptIdentifierName\)\}\] \|\| null/);
  assert.match(source, /Page\.removeScriptToEvaluateOnNewDocument/);
  assert.match(source, /Page\.addScriptToEvaluateOnNewDocument/);
  assert.match(source, /reconcileInjectionRuntime/);
  assert.match(source, /expectedSourceHash/);
});

test("the injector ignores auxiliary Codex windows", () => {
  assert.match(source, /!target\.url\?\.includes\("initialRoute=%2Fglobal-dictation"\)/);
});

test("cold launch waits for a continuously stable Codex renderer before injection", () => {
  assert.match(source, /createStableTargetTracker/);
  assert.match(source, /const codexRendererStabilityMs = 8_000/);
  assert.match(source, /stableTargets\.update\(targets\)/);
});

test("a completed web build refreshes an already-open Codex iframe", () => {
  assert.match(packageJson.scripts.build, /--refresh-if-running/);
  assert.match(packageJson.scripts["codex:refresh"], /--refresh/);
  assert.match(source, /async function refreshTaskboardFrames/);
  assert.match(source, /function codexDebuggingPorts/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /taskboard\.reloadFrame\(\)/);
  assert.match(source, /__codex_taskboard_refresh/);
  assert.match(source, /await restartResidentInjectorForRefresh\(port\)/);
});

test("refresh identifies the resident injector from the renderer before replacing it", () => {
  assert.match(source, /const hostPidName = "__codexTaskboardHostPidV2"/);
  assert.match(source, /window\[\$\{JSON\.stringify\(hostPidName\)\}\] = \$\{process\.pid\}/);
  assert.match(source, /async function residentInjectorPidsFromRenderer/);
  assert.match(source, /await residentInjectorPidsFromRenderer\(port\)/);
});

test("the injected iframe follows the configured local service port", () => {
  assert.match(source, /const taskboardPageUrl = `\$\{taskboardOrigin\}\/\?host=codex`/);
  assert.match(
    source,
    /window\.__CODEX_TASKBOARD_MANAGED_ORIGIN_V2__ = \$\{JSON\.stringify\(taskboardOrigin\)\}/,
  );
  assert.match(
    source,
    /window\.__CODEX_TASKBOARD_URL_V2__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/,
  );
  assert.match(source, /window\.__CODEX_TASKBOARD_URL__ = \$\{JSON\.stringify\(taskboardPageUrl\)\}/);
});

test("an armed one-shot plan is not reconciled before its native run fires", () => {
  assert.match(source, /nextRunAt - Date\.now\(\) \+ automationLaunchGraceMs/);
  assert.doesNotMatch(source, /nextRunAt - Date\.now\(\) - 15_000/);
});

test("a running slot pauses its existing one-shot plan for later reuse", () => {
  assert.doesNotMatch(source, /if \(runningSlots\.has\(slotNumber\)\)/);
  assert.match(
    source,
    /for \(const \[slot, automationId\] of Object\.entries\(previousIds\)\)[\s\S]*?operation: "pause"/,
  );
});

test("the injector restores native plans from the Taskboard policy source of truth", () => {
  assert.match(source, /async function syncStoredQuotaPolicyFromTaskboard/);
  assert.match(source, /enabledByUser: policy\.enabledByUser/);
  assert.match(source, /await syncStoredQuotaPolicyFromTaskboard\(projectId\)/);
});

test("a user automation update persists the Taskboard policy before scheduling plans", () => {
  assert.match(source, /async function saveTaskboardAutomationPolicy/);
  assert.match(source, /await saveTaskboardAutomationPolicy\(request, quotaAllowsRun\)/);
});
