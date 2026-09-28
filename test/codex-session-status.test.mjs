import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { readCodexSessionStatus } from "../server/codex-session-status.mjs";

function event(type, turnId, timestamp) {
  return JSON.stringify({ type: "event_msg", timestamp, payload: { type, turn_id: turnId } }) + "\n";
}

test("reads actual rollout terminal events without loading or taking ownership of a thread", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskboard-session-status-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rollout = path.join(directory, "rollout.jsonl");
  const db = new DatabaseSync(path.join(directory, "state_5.sqlite"));
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT)");
  db.prepare("INSERT INTO threads VALUES (?, ?)").run("thread-1", rollout);
  db.close();
  await writeFile(rollout, event("task_started", "turn-1", "2026-09-11T01:00:00Z"));
  assert.equal((await readCodexSessionStatus(directory, "thread-1")).status, "running");

  // Read only a bounded tail even after a long-running conversation.
  await appendFile(rollout, JSON.stringify({ type: "response_item", payload: { text: "x".repeat(600_000) } }) + "\n");
  assert.equal(await readCodexSessionStatus(directory, "thread-1"), null);
  await appendFile(rollout, event("task_complete", "turn-1", "2026-09-11T01:20:00Z"));
  assert.deepEqual(await readCodexSessionStatus(directory, "thread-1"), {
    status: "completed", turnId: "turn-1", timestamp: "2026-09-11T01:20:00Z",
  });
  await appendFile(rollout, event("task_started", "turn-2", "2026-09-11T01:21:00Z"));
  assert.equal((await readCodexSessionStatus(directory, "thread-1")).status, "running");
  await appendFile(rollout, event("turn_aborted", "turn-2", "2026-09-11T01:22:00Z"));
  assert.equal((await readCodexSessionStatus(directory, "thread-1")).status, "interrupted");
  assert.equal(await readCodexSessionStatus(directory, "missing-thread"), null);

  await writeFile(rollout, event("task_started", "turn-3", "2026-09-11T02:00:00Z")
    + event("task_complete", "turn-3", "2026-09-11T02:01:00Z").slice(0, -2));
  assert.equal((await readCodexSessionStatus(directory, "thread-1")).status, "running");
});
