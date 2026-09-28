// Modified for CodeLoop.
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

test("native header stays outside the hidden workspace content", () => {
  const mountSource = source.slice(source.indexOf("function mountActivePage"), source.indexOf("function closeTaskboard"));
  const hidden = [];
  const content = { getAttribute: () => null, setAttribute: (...args) => hidden.push(args) };
  const surface = { children: [content], setAttribute() {}, getBoundingClientRect: () => ({ left: 0 }) };
  const page = { parentElement: surface, style: {}, hidden: true };
  const mount = vm.runInNewContext(`(${mountSource})`, {
    active: true, page, findPageMount: () => ({ surface, rail: { getBoundingClientRect: () => ({ right: 52 }) } }),
    HOST_ATTRIBUTE: "host", OWNED_ATTRIBUTE: "owned", HIDDEN_ATTRIBUTE: "hidden",
    syncNativeRailIcons() {}, document: { documentElement: { setAttribute() {} } },
  });
  mount();
  assert.equal(page.style.left, "52px");
  assert.equal(page.hidden, false);
  assert.deepEqual(hidden, [["hidden", "true"]]);
  assert.doesNotMatch(mountSource, /hideNativeHeader/);
  assert.match(source, /top: var\(--app-shell-titlebar-height, 0px\)/);
});
