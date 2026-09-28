import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

import { reconcileInjectionRuntime } from "../scripts/codex-injector-runtime.mjs";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const injectTargetSource = source.slice(
  source.indexOf("async function injectTarget("),
  source.indexOf("\nasync function injectAll("),
);

function injectionHarness(initialStatus) {
  const calls = [];
  const status = {
    sourceHash: "current-hash",
    scriptIdentifier: "existing-registration",
    entryMounted: true,
    pageVisible: false,
    frameUrl: "http://127.0.0.1:47824/?host=codex",
    ...initialStatus,
  };
  const cdp = {
    closed: false,
    open: async () => {},
    close() { this.closed = true; },
    on: () => {},
    waitFor: async () => {},
    send: async (method, params) => {
      calls.push(method);
      if (method === "Runtime.evaluate" && params.expression.includes(".open()")) {
        status.pageVisible = true;
      }
      return {};
    },
  };
  const injectTarget = vm.runInNewContext(`(${injectTargetSource})`, {
    CdpConnection: class { constructor() { return cdp; } },
    reconcileInjectionRuntime,
    installTaskboardHostBinding: async () => calls.push("install-host-binding"),
    readInjectionStatus: async () => ({ ...status }),
    registerInjectionSource: async () => "current-registration",
    evaluateInjectionSource: async () => {
      if (status.sourceHash !== "current-hash") status.pageVisible = false;
      status.sourceHash = "current-hash";
    },
    publishInjectionScriptIdentifier: async () => {},
    publishHostHeartbeat: async () => calls.push("publish-heartbeat"),
    waitForInjectionStatus: async () => ({ ...status }),
    waitForFrame: async () => true,
    openTaskboardWithRecovery: async () => {},
    setTimeout: (callback) => callback(),
  });
  return { calls, cdp, injectTarget };
}

for (const scenario of [
  { name: "ordinary watch attach", keepAlive: true, attachExisting: false, shouldOpen: false },
  { name: "one-shot attach", keepAlive: false, attachExisting: false, shouldOpen: false },
  { name: "one-shot without --open on a visible panel", keepAlive: false, attachExisting: false, pageVisible: true },
  { name: "watch reconnect", keepAlive: true, attachExisting: false, shouldOpen: false, pageVisible: true, sourceHash: "old-hash" },
  { name: "explicit open on an existing runtime", keepAlive: true, attachExisting: true, shouldOpen: true },
  { name: "one-shot explicit open", keepAlive: false, attachExisting: false, shouldOpen: true },
]) {
  test(`${scenario.name} preserves the Codex document and honors panel visibility`, async () => {
    const harness = injectionHarness({
      pageVisible: scenario.pageVisible ?? false,
      sourceHash: scenario.sourceHash ?? "current-hash",
    });

    const result = await harness.injectTarget(
      { webSocketDebuggerUrl: "ws://codex-renderer" },
      "current-source",
      "current-hash",
      scenario.shouldOpen,
      null,
      scenario.keepAlive,
      {},
      scenario.attachExisting,
      "startup-token",
    );

    assert.equal(harness.calls.includes("Page.reload"), false, "attaching must not reload the Codex document");
    assert.equal(result.result.pageVisible, scenario.shouldOpen || Boolean(scenario.pageVisible));
    assert.equal(Boolean(result.connection), scenario.keepAlive);
    assert.equal(harness.cdp.closed, !scenario.keepAlive);
    assert.equal(harness.calls.includes("install-host-binding"), scenario.keepAlive);
    assert.equal(harness.calls.includes("publish-heartbeat"), scenario.keepAlive);
  });
}

test("daemon --open opens the panel even when its resident is already healthy", async () => {
  const calls = [];
  const cdp = {
    open: async () => {},
    close: () => calls.push({ method: "close" }),
    send: async (method, params) => { calls.push({ method, ...params }); return {}; },
  };
  const evaluateSource = source.slice(
    source.indexOf("async function evaluateInjectionSource("),
    source.indexOf("\nasync function openTaskboardWithRecovery("),
  );
  const mainSource = source.slice(source.indexOf("async function main()"), source.indexOf("\nmain().catch("));
  const main = vm.runInNewContext(`(${mainSource})`, {
    process: { argv: [] },
    parseArgs: () => ({ daemon: true, open: true, port: 9229, portExplicit: true }),
    reachableLocalCdpVersionUrl: async () => "http://127.0.0.1:9229/json/version",
    currentInjectionSource: async () => ({ source: "current-source", sourceHash: "current-hash" }),
    randomUUID: () => "startup-token",
    startResidentInjector: () => ({ pid: 123, started: false }),
    isResidentInjectorHealthy: async () => true,
    codexTargets: async () => [{ webSocketDebuggerUrl: "ws://codex-renderer" }],
    CdpConnection: class { constructor() { return cdp; } },
    evaluateInjectionSource: vm.runInNewContext(`(${evaluateSource})`),
    openTaskboardWithRecovery: async (connection) => {
      await connection.send("Runtime.evaluate", { expression: "window.__codexTaskboardInjection__?.open()" });
    },
    console: { log: () => {} },
  });

  await main();

  assert.equal(calls.filter((call) => call.method === "Runtime.evaluate" && call.expression.includes(".open()")).length, 1);
  assert.equal(calls.some((call) => call.method === "Page.reload"), false);
  assert.equal(calls.at(-1)?.method, "close");
});
