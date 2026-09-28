import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../scripts/codex-injector.mjs", import.meta.url), "utf8");
const recoverySource = source.slice(source.indexOf("async function openTaskboardWithRecovery("), source.indexOf("\nasync function publishInjectionScriptIdentifier("));

for (const scenario of [
  { name: "ready page does not reload", states: [{ ready: true }], reloads: 0 },
  { name: "CSP reloads once and waits for readiness", states: [{ cspBlocked: true }, { ready: true }], reloads: 1 },
  { name: "persistent CSP stops after one reload", states: [{ cspBlocked: true }, { cspBlocked: true }], reloads: 1, error: /仍被 CSP/ },
  { name: "ordinary timeout does not reload", states: [{}], reloads: 0, error: /未完成加载/ },
]) {
  test(scenario.name, async () => {
    const calls = [];
    const states = [...scenario.states];
    const cdp = {
      send: async (method) => calls.push(method),
      waitFor: async (event) => calls.push(event),
    };
    const recover = vm.runInNewContext(`(${recoverySource})`, {
      evaluateInjectionSource: async () => calls.push("open"),
      readInjectionStatus: async () => ({ startupStatus: states.shift() || {} }),
      setTimeout: (callback) => callback(),
    });
    if (scenario.error) await assert.rejects(recover(cdp, 0), scenario.error);
    else assert.equal((await recover(cdp, 0)).ready, true);
    assert.equal(calls.filter((call) => call === "Page.reload").length, scenario.reloads);
    assert.ok(calls.indexOf("Page.setBypassCSP") < calls.indexOf("open"));
    if (scenario.reloads) assert.ok(calls.indexOf("Page.loadEventFired") < calls.indexOf("Page.reload"));
  });
}
