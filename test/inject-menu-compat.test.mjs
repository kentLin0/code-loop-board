import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("../inject/codex-taskboard.user.js", import.meta.url), "utf8");
const findSource = source.slice(source.indexOf("function findReferenceButton"), source.indexOf("function replaceEntryIcon"));

test("icon rail anchors outside the legacy scroll area", () => {
  const rail = {};
  const find = vm.runInNewContext(`(${findSource})`, {
    document: { querySelector: (selector) => selector.includes('builtin:customize') ? rail : null },
  });
  assert.equal(find(), rail);
});

test("legacy text menu still anchors to Plugins", () => {
  const plugin = { parentElement: {} };
  const scroll = { querySelectorAll: () => [plugin] };
  const find = vm.runInNewContext(`(${findSource})`, {
    document: { querySelector: (selector) => selector === "[data-app-action-sidebar-scroll]" ? scroll : null },
    PLUGIN_LABELS: ["插件", "plugins"],
    buttonMatches: (button) => button === plugin,
  });
  assert.equal(find(), plugin);
});

test("new titlebar trailing slot participates in native-content restoration", () => {
  const hidden = [];
  const slot = { setAttribute: (...args) => hidden.push(args) };
  const hideSource = source.slice(source.indexOf("function hideNativeHeader"), source.indexOf("function currentTheme"));
  const hide = vm.runInNewContext(`(${hideSource})`, {
    HIDDEN_ATTRIBUTE: "data-codex-taskboard-native-hidden",
    document: { querySelectorAll: (selector) => selector.includes('header-slot="end"') ? [slot] : [] },
  });
  hide();
  assert.deepEqual(hidden, [["data-codex-taskboard-native-hidden", "true"]]);
});
