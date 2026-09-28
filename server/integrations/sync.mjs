import { createHash } from "node:crypto";
import { IntegrationError } from "./registry.mjs";
import { normalizeIssue, sameIdentity } from "./results.mjs";

async function syncComments(taskClient, task, issue, threadId) {
  if (!issue.comments.length) return;
  const comments = await taskClient.listComments(task.id);
  for (const comment of issue.comments) {
    const key = createHash("sha256").update(JSON.stringify([issue.externalIssue.connectionId, issue.externalIssue.scopeId, issue.externalIssue.externalId, comment.id])).digest("hex");
    const marker = `<!-- loop-source-comment:${key} -->`;
    if (comments.some((existing) => existing.body.includes(marker))) continue;
    const created = await taskClient.createComment(task.id, { body: `${marker}\n${comment.body}`, threadId });
    comments.push(created);
  }
}

function syncTarget(task, issue, board, mapping) {
  const binding = board.automation.bindings;
  const category = board.states.find((state) => state.id === task.status)?.category;
  if (task.automationExecution && !["completed", "canceled"].includes(task.automationExecution.phase)) return null;
  if (issue.state.semantic === "reopened" && ["done", "canceled"].includes(category)) return binding.ready;
  if (issue.state.semantic === "closed" && mapping.sync?.closeOnSourceClosed === true) return binding.done;
  return null;
}

export async function synchronizeIssues({ value, mapping, delivery, board, taskClient, filter, threadId }) {
  const tasks = await taskClient.listTasks({ projectId: mapping.projectId });
  const result = { connectionId: value.connection.id, projectId: mapping.projectId, created: [], updated: [], skipped: [] };
  let cursor = null;
  const visited = new Set();
  do {
    const page = await value.provider.listIssues(value, { scopeId: mapping.scopeId, filter: filter ?? mapping.filter ?? {}, cursor });
    if (!Array.isArray(page?.issues)) throw new IntegrationError("INTEGRATION_LIST_INVALID");
    for (const raw of page.issues) {
      const issue = normalizeIssue(raw, value.connection.id, mapping.scopeId);
      let task = tasks.find((item) => item.externalIssue && sameIdentity(item.externalIssue, issue.externalIssue));
      if (!task) {
        if (!["new", "reopened"].includes(issue.state.semantic)) { result.skipped.push(issue.externalIssue); continue; }
        task = await taskClient.createTask({
          projectId: mapping.projectId, title: issue.title, description: issue.description,
          status: board.automation.bindings.ready ?? board.initialState,
          externalIssue: issue.externalIssue, externalState: issue.state, delivery, threadId,
        });
        tasks.push(task);
        result.created.push(task.id);
      } else {
        const target = syncTarget(task, issue, board, mapping);
        task = await taskClient.updateTask(task.id, { version: task.version, title: issue.title, externalState: issue.state, threadId });
        if (target && target !== task.status) {
          if (!board.manualTransitions[task.status]?.includes(target)) {
            result.skipped.push({ taskId: task.id, code: "INTEGRATION_TRANSITION_UNAVAILABLE", target });
          } else task = await taskClient.moveTask(task.id, { version: task.version, status: target, threadId });
        }
        const index = tasks.findIndex((item) => item.id === task.id);
        tasks[index] = task;
        result.updated.push(task.id);
      }
      await syncComments(taskClient, task, issue, threadId);
    }
    cursor = page.nextCursor ?? null;
    if (cursor !== null) {
      if (typeof cursor !== "string" || visited.has(cursor)) throw new IntegrationError("INTEGRATION_CURSOR_INVALID");
      visited.add(cursor);
    }
  } while (cursor !== null);
  return result;
}
