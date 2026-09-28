export type BoardStateCategory = "pending" | "active" | "blocked" | "done" | "canceled";
export type BoardStateIcon = "circle" | "progress" | "pause" | "clock" | "check" | "close";
export type BoardRole = "ready" | "working" | "approval" | "releaseReady" | "releasing" | "review" | "blocked" | "done" | "canceled";
export interface BoardState {
  readonly id: string;
  readonly label: string;
  readonly category: BoardStateCategory;
  readonly color: string;
  readonly icon: BoardStateIcon;
  readonly allowCreate: boolean;
}
export interface BoardConfig {
  readonly schemaVersion: 1;
  readonly initialState: string;
  readonly states: readonly BoardState[];
  readonly manualTransitions: Readonly<Record<string, readonly string[]>>;
  readonly automation: {
    readonly enabled: boolean;
    readonly approvalEnabled: boolean;
    readonly releaseEnabled: boolean;
    readonly bindings: Readonly<Partial<Record<BoardRole, string>>>;
  };
}
export interface BoardTask {
  readonly status?: string;
  readonly automationExecution?: { readonly phase: string } | null;
  readonly delivery?: { readonly mode: "review" | "release" } | null;
}
export interface BoardConfigSnapshot { readonly version: number; readonly config: BoardConfig }
export class BoardConfigError extends Error { readonly code: string; readonly status: number }
export const DEFAULT_BOARD_CONFIG: BoardConfig;
export function normalizeBoardConfig(input: unknown): BoardConfig;
export function boardStateIds(config: BoardConfig): string[];
export function boundStatus(config: BoardConfig, role: BoardRole): string | null;
export function stateDefinition(config: BoardConfig, id: string): BoardState | undefined;
export function taskStatusSequence(task: BoardTask | null, config?: BoardConfig): string[];
export function canMoveTask(config: BoardConfig, task: BoardTask, target: string, options?: { automated?: boolean }): boolean;
