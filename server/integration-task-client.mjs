import { ApiError } from "./database.mjs";

const ACTOR = { type: "agent", id: "loop-integration", name: "Loop Integration", avatarUrl: null };

export function createIntegrationTaskClient({ database, cloudConfig, cloudProxy, emit }) {
  async function execute(method, pathname, body, local, key) {
    const connection = await cloudConfig.read();
    if (!connection.remoteUrl) return local();
    const response = await cloudProxy.forward(new Request(`http://127.0.0.1${pathname}`, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const result = await response.json();
    if (!response.ok) throw new ApiError(response.status, result.error?.code ?? "INTEGRATION_STORAGE_FAILED", result.error?.message ?? "Task storage request failed");
    return key ? result[key] : result;
  }

  function changed(type, task) {
    emit(type, { task, projectId: task.projectId });
    return task;
  }

  return {
    boardConfigForProject(projectId) {
      return execute("GET", `/api/projects/${encodeURIComponent(projectId)}/board-config`, undefined,
        () => database.getProjectBoardConfig(projectId), null).then((snapshot) => snapshot.config);
    },
    listTasks({ projectId }) {
      return execute("GET", `/api/tasks?projectId=${encodeURIComponent(projectId)}&archived=false`, undefined,
        () => database.listTasks({ projectId, archived: "false" }), "tasks");
    },
    getTask(id) {
      return execute("GET", `/api/tasks/${encodeURIComponent(id)}`, undefined, () => {
        const task = database.getTask(id);
        if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Issue not found");
        return task;
      }, "task");
    },
    createTask(input) {
      return execute("POST", "/api/tasks", input,
        () => changed("task.created", database.createTask({
          description: "", priority: "none", labels: [], workflowId: null, developmentContext: null,
          dueDate: null, recurrence: null, ...input, actor: ACTOR, assignee: ACTOR,
        })), "task");
    },
    updateTask(id, input) {
      const { version, threadId, ...changes } = input;
      return execute("PATCH", `/api/tasks/${encodeURIComponent(id)}`, input,
        () => changed("task.updated", database.updateTask(id, version, changes, threadId)), "task");
    },
    moveTask(id, input) {
      return execute("POST", `/api/tasks/${encodeURIComponent(id)}/move`, input,
        () => changed("task.moved", database.moveTask(id, input.version, input.status, undefined, input.threadId)), "task");
    },
    listComments(id) {
      return execute("GET", `/api/tasks/${encodeURIComponent(id)}/comments`, undefined,
        () => database.listComments(id), "comments");
    },
    createComment(id, input) {
      return execute("POST", `/api/tasks/${encodeURIComponent(id)}/comments`, input,
        () => database.createComment(id, { ...input, actor: ACTOR }), "comment");
    },
  };
}
