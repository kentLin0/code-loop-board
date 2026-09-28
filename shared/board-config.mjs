import defaultConfig from "../loop-board.default.json" with { type: "json" };

export class BoardConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardConfigError";
    this.code = "INVALID_BOARD_CONFIG";
    this.status = 400;
  }
}

const CATEGORIES = new Set(["pending", "active", "blocked", "done", "canceled"]);
const ICONS = new Set(["circle", "progress", "pause", "clock", "check", "close"]);
const ROLES = new Set(["ready", "working", "approval", "releaseReady", "releasing", "review", "blocked", "done", "canceled"]);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function normalizeBoardConfig(input) {
  const fail = (message) => { throw new BoardConfigError(message); };
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.states) || !input.states.length) {
    fail("schemaVersion must be 1 and states must be a non-empty array");
  }
  const states = input.states.map((state) => {
    if (!state || typeof state.id !== "string" || !ID.test(state.id)
      || typeof state.label !== "string" || !state.label.trim() || state.label.length > 80
      || !CATEGORIES.has(state.category) || !ICONS.has(state.icon)
      || typeof state.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(state.color)
      || typeof state.allowCreate !== "boolean") fail("Invalid state definition");
    return { id: state.id, label: state.label.trim(), category: state.category, color: state.color, icon: state.icon, allowCreate: state.allowCreate };
  });
  const ids = new Set(states.map((state) => state.id));
  if (ids.size !== states.length) fail("State IDs must be unique");
  if (!ids.has(input.initialState)) fail("initialState must reference a defined state");
  if (!states.find((state) => state.id === input.initialState).allowCreate) fail("initialState must allow creation");
  if (!input.manualTransitions || typeof input.manualTransitions !== "object" || Array.isArray(input.manualTransitions)) {
    fail("manualTransitions must map state IDs to target arrays");
  }
  if (Object.keys(input.manualTransitions).some((id) => !ids.has(id))) fail("Unknown transition source");
  const manualTransitions = Object.fromEntries(states.map(({ id }) => {
    const targets = input.manualTransitions[id];
    if (!Array.isArray(targets) || targets.some((target) => !ids.has(target))) fail(`Invalid transitions for ${id}`);
    return [id, [...new Set(targets)]];
  }));
  const automation = input.automation;
  if (!automation || typeof automation.enabled !== "boolean"
    || typeof automation.approvalEnabled !== "boolean" || typeof automation.releaseEnabled !== "boolean"
    || !automation.bindings || typeof automation.bindings !== "object" || Array.isArray(automation.bindings)) {
    fail("Invalid automation configuration");
  }
  const bindings = { ...automation.bindings };
  for (const [role, id] of Object.entries(bindings)) {
    if (!ROLES.has(role) || !ids.has(id)) fail(`Invalid automation binding: ${role}`);
  }
  const required = automation.enabled ? ["ready", "working", "review", "blocked", "done", "canceled"] : [];
  if (automation.approvalEnabled) required.push("approval");
  if (automation.releaseEnabled) required.push("releaseReady", "releasing");
  if (required.some((role) => !bindings[role])) fail("Enabled automation capabilities require their state bindings");
  if (new Set(Object.values(bindings)).size !== Object.values(bindings).length) fail("Automation roles must reference distinct states");
  if (automation.approvalEnabled && (manualTransitions[bindings.approval].length
    || states.find((state) => state.id === bindings.approval).allowCreate
    || Object.values(manualTransitions).some((targets) => targets.includes(bindings.approval)))) {
    fail("Approval state is managed by the approval action, not manual transitions");
  }
  return {
    schemaVersion: 1, initialState: input.initialState, states, manualTransitions,
    automation: { enabled: automation.enabled, approvalEnabled: automation.approvalEnabled, releaseEnabled: automation.releaseEnabled, bindings },
  };
}

export const DEFAULT_BOARD_CONFIG = normalizeBoardConfig(defaultConfig);

export function boardStateIds(config) {
  return config.states.map((state) => state.id);
}

export function boundStatus(config, role) {
  return config.automation.bindings[role] ?? null;
}

export function stateDefinition(config, id) {
  return config.states.find((state) => state.id === id);
}

export function taskStatusSequence(task, config = DEFAULT_BOARD_CONFIG) {
  const releaseStates = [boundStatus(config, "releaseReady"), boundStatus(config, "releasing")];
  return boardStateIds(config).filter((id) => (
    (config.automation.approvalEnabled || id !== boundStatus(config, "approval"))
    && ((config.automation.releaseEnabled && task?.delivery?.mode === "release") || !releaseStates.includes(id))
  ));
}

export function canMoveTask(config, task, target, { automated = false } = {}) {
  if (!taskStatusSequence(task, config).includes(target)) return false;
  if (task?.status === target) return true;
  if (automated) return true;
  if (task?.automationExecution && !["paused_for_human", "completed", "canceled"].includes(task.automationExecution.phase)) return false;
  return Boolean(config.manualTransitions[task?.status]?.includes(target));
}
