import { normalizeDelivery } from "../../shared/external-issue.mjs";
import { IntegrationError, loadIntegrationRegistry, projectConnection, resolveConnection } from "./registry.mjs";
import { normalizeActionResult, normalizeIssue, sameIdentity } from "./results.mjs";
import { synchronizeIssues } from "./sync.mjs";

export function createIntegrationService({ configPath, taskClient, boardConfigForProject }) {
  async function context(connectionId) {
    const registry = await loadIntegrationRegistry(configPath);
    return { registry, ...resolveConnection(registry, connectionId) };
  }

  async function capability(value, operation, action) {
    const description = await value.provider.describe(value);
    if (!description.operations?.includes(operation) || typeof value.provider[operation] !== "function"
      || (action && !description.actions?.includes(action))) {
      throw new IntegrationError("INTEGRATION_CAPABILITY_UNSUPPORTED", `${operation}${action ? `:${action}` : ""} is not available`, 400);
    }
  }

  return {
    async inspect({ connectionId } = {}) {
      if (!connectionId) {
        const registry = await loadIntegrationRegistry(configPath);
        return { connections: registry.config.connections.map(({ id, providerId }) => ({ id, providerId })) };
      }
      const value = await context(connectionId);
      const description = await value.provider.describe(value);
      return {
        connectionId, providerId: value.connection.providerId,
        name: description.name ?? value.connection.providerId,
        operations: description.operations ?? [], actions: description.actions ?? [],
        notes: description.notes ?? [],
        projects: value.registry.config.projects.filter((item) => item.connectionId === connectionId).map(({ projectId, scopeId }) => ({ projectId, scopeId })),
      };
    },

    async get({ taskId }) {
      const task = await taskClient.getTask(taskId);
      if (!task.externalIssue) throw new IntegrationError("INTEGRATION_SOURCE_REQUIRED");
      const value = await context(task.externalIssue.connectionId);
      const mapping = projectConnection(value.registry, task.projectId, value.connection.id);
      if (mapping.scopeId !== task.externalIssue.scopeId) throw new IntegrationError("INTEGRATION_SCOPE_MISMATCH");
      await capability(value, "getIssue");
      const issue = normalizeIssue(await value.provider.getIssue(value, { issue: task.externalIssue }), value.connection.id, mapping.scopeId);
      if (!sameIdentity(issue.externalIssue, task.externalIssue)) throw new IntegrationError("INTEGRATION_ISSUE_IDENTITY_MISMATCH");
      return issue;
    },

    async sync({ connectionId, projectId, filter, threadId }) {
      const value = await context(connectionId);
      const mapping = projectConnection(value.registry, projectId, connectionId);
      await capability(value, "listIssues");
      const delivery = normalizeDelivery(mapping.delivery);
      const board = await boardConfigForProject(projectId);
      return synchronizeIssues({ value, mapping, delivery, board, taskClient, filter, threadId });
    },

    async action({ taskId, action, parameters = {}, threadId }) {
      const task = await taskClient.getTask(taskId);
      if (!task.externalIssue) throw new IntegrationError("INTEGRATION_SOURCE_REQUIRED");
      const value = await context(task.externalIssue.connectionId);
      const mapping = projectConnection(value.registry, task.projectId, value.connection.id);
      if (mapping.scopeId !== task.externalIssue.scopeId) throw new IntegrationError("INTEGRATION_SCOPE_MISMATCH");
      await capability(value, "applyAction", action);
      const result = normalizeActionResult(await value.provider.applyAction(value, { issue: task.externalIssue, action, parameters }), task.externalIssue, action);
      try {
        const latest = await taskClient.getTask(taskId);
        await taskClient.updateTask(taskId, { version: latest.version, externalState: result.state, ...(result.title ? { title: result.title } : {}), threadId });
        return { ...result, externalCompleted: true, localCompleted: true };
      } catch {
        return { ...result, externalCompleted: true, localCompleted: false, code: "INTEGRATION_LOCAL_WRITE_FAILED" };
      }
    },
  };
}
