export interface ExternalIssue {
  readonly connectionId: string;
  readonly scopeId: string;
  readonly externalId: string;
  readonly key: string;
  readonly url: string;
}
export interface Delivery {
  readonly mode: "review" | "release";
  readonly repositories: readonly { readonly repositoryId: string; readonly targetBranch: string }[];
}
export class ExternalIssueError extends Error { readonly code: string; readonly status: number }
export function normalizeExternalIssue(input: unknown): ExternalIssue | null;
export function normalizeDelivery(input: unknown): Delivery;
export function hasSameExternalBinding(current: ExternalIssue | null, next: ExternalIssue | null): boolean;
export interface ExternalState {
  readonly id: string | null;
  readonly label: string;
  readonly semantic: "new" | "reopened" | "working" | "fixed" | "verifying" | "closed" | "unmapped";
  readonly observedAt: string;
}
export function normalizeExternalState(input: unknown): ExternalState | null;
