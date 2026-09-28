import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TAIL_BYTES = 512 * 1024;
const EVENT_STATUSES = new Map([
  ["task_started", "running"],
  ["task_complete", "completed"],
  ["turn_aborted", "interrupted"],
]);

// Never resume a thread to inspect it: that acquires its writer lock in another app-server.
export async function readCodexSessionStatus(codexHome, threadId) {
  let file;
  try {
    const databases = (await readdir(codexHome))
      .filter((name) => /^state_\d+\.sqlite$/.test(name))
      .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
    if (!databases.length) return null;
    const database = new DatabaseSync(path.join(codexHome, databases[0]), { readOnly: true });
    let rolloutPath;
    try {
      rolloutPath = database.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(threadId)?.rollout_path;
    } finally {
      database.close();
    }
    if (!rolloutPath) return null;
    file = await open(rolloutPath, "r");
    const { size } = await file.stat();
    const position = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(size, TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    if (position > 0) lines.shift();
    // An in-flight final JSON line is not evidence that the turn ended.
    lines.pop();
    let result = null;
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      const status = EVENT_STATUSES.get(event.payload?.type);
      if (event.type !== "event_msg" || !status) continue;
      result = { status, turnId: event.payload.turn_id ?? null, timestamp: event.timestamp };
    }
    return result;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  } finally {
    await file?.close();
  }
}
