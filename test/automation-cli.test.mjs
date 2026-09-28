import assert from "node:assert/strict";
import test from "node:test";

import { main } from "../cli/clb.mjs";

function capture() {
  let value = "";
  return { stream: { write(chunk) { value += chunk; } }, json() { return JSON.parse(value); } };
}

async function execute(argv, payload = {}) {
  const stdout = capture();
  const stderr = capture();
  const calls = [];
  const exitCode = await main(argv, {
    stdout: stdout.stream,
    stderr: stderr.stream,
    env: { CODEX_THREAD_ID: "thread" },
    readFile: async () => JSON.stringify([{ name: "repo", validation: "ok" }]),
    fetch: async (url, init) => {
      calls.push({
        url: url.toString(),
        method: init.method,
        body: init.body ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { exitCode, calls, output: exitCode === 0 ? stdout.json() : stderr.json() };
}

test("automation commands use narrow local coordinator routes", async () => {
  const context = await execute(["automation", "context", "TASK-1"], { execution: { id: "e" } });
  assert.equal(context.calls[0].url, "http://127.0.0.1:47824/api/local/automation/tasks/TASK-1/context");
  assert.equal(context.calls[0].method, "POST");
  assert.deepEqual(context.calls[0].body, { threadId: "thread" });

  const acquire = await execute(["automation", "acquire-merge", "TASK-1", "--token", "secret"], { execution: {} });
  assert.deepEqual(acquire.calls[0].body, { token: "secret", threadId: "thread" });
  assert.match(acquire.calls[0].url, /\/acquire-merge$/);

  const retry = await execute(["automation", "retry-merge", "TASK-1", "--token", "secret"], { execution: {} });
  assert.deepEqual(retry.calls[0].body, { token: "secret", threadId: "thread" });
  assert.match(retry.calls[0].url, /\/retry-merge$/);

  const release = await execute(["automation", "release-run", "TASK-1", "--token", "secret"], { execution: {} });
  assert.deepEqual(release.calls[0].body, { token: "secret", threadId: "thread" });
  assert.match(release.calls[0].url, /\/release-run$/);

  const prepareRelease = await execute([
    "automation", "prepare-release", "TASK-1", "--token", "secret",
    "--repository-results-file", "result.json",
  ], { execution: {} });
  assert.deepEqual(prepareRelease.calls[0].body, {
    token: "secret",
    threadId: "thread",
    repositories: [{ name: "repo", validation: "ok" }],
  });
  assert.match(prepareRelease.calls[0].url, /\/prepare-release$/);

  const reconcileRelease = await execute([
    "automation", "reconcile-release", "TASK-1", "--token", "secret", "--observed-status", "已修复待部署",
  ], { execution: {} });
  assert.deepEqual(reconcileRelease.calls[0].body, {
    token: "secret",
    threadId: "thread",
    observedStatus: "已修复待部署",
  });
  assert.match(reconcileRelease.calls[0].url, /\/reconcile-release$/);

  const fail = await execute([
    "automation", "fail", "TASK-1", "--token", "secret", "--reason", "dependencies missing",
  ], { execution: {} });
  assert.deepEqual(fail.calls[0].body, {
    token: "secret",
    threadId: "thread",
    reason: "dependencies missing",
  });
  assert.match(fail.calls[0].url, /\/fail$/);

  const pause = await execute([
    "automation", "pause-merge", "TASK-1", "--token", "secret",
    "--reason", "conflict", "--conflict-files", "a.ts,b.ts",
  ], { execution: {} });
  assert.deepEqual(pause.calls[0].body, {
    token: "secret",
    threadId: "thread",
    reason: "conflict",
    conflictFiles: ["a.ts", "b.ts"],
  });

  const complete = await execute([
    "automation", "complete", "TASK-1", "--token", "secret",
    "--repository-results-file", "result.json",
  ], { execution: {} });
  assert.deepEqual(complete.calls[0].body, {
    token: "secret",
    threadId: "thread",
    repositories: [{ name: "repo", validation: "ok" }],
  });
});
