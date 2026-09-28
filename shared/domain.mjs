// Modified for CodeLoop.
import { DEFAULT_BOARD_CONFIG, boardStateIds } from "./board-config.mjs";

export const TASK_STATUSES = boardStateIds(DEFAULT_BOARD_CONFIG);
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"];

export const DEFAULT_PROJECT_ID = "local";

export function isTaskStatus(value, config = DEFAULT_BOARD_CONFIG) {
  return boardStateIds(config).includes(value);
}

export function isTaskPriority(value) {
  return TASK_PRIORITIES.includes(value);
}
