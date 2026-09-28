import { createContext, useContext } from "react";
import { DEFAULT_BOARD_CONFIG, stateDefinition } from "../../shared/board-config.mjs";
import type { BoardConfig } from "../../shared/board-config.mjs";

export const BoardConfigContext = createContext<BoardConfig>(DEFAULT_BOARD_CONFIG);
export function useBoardConfig(): BoardConfig {
  return useContext(BoardConfigContext);
}
export function statusDetails(config: BoardConfig, status: string) {
  const state = stateDefinition(config, status);
  return state ?? { id: status, label: status, color: "currentColor", category: "pending", icon: "circle", allowCreate: false };
}
