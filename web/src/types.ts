// Modified for CodeLoop.
export const TASK_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;

export type TaskStatus = string;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export type ActorType = "user" | "agent";
export type AssigneeTarget = "current-user" | "codex-agent";
export type IssueRelationType = "parent" | "blocks" | "blocked_by" | "related";

export interface ActorIdentity {
  type: ActorType;
  id: string;
  name: string;
  avatarUrl: string | null;
}

export type DevelopmentContext =
  | { type: "branch"; branch: string }
  | { type: "worktree"; path: string; branch: string | null };

export type Recurrence = {
  interval: number;
  unit: "day" | "week" | "month" | "year";
};

export interface DevelopmentScan {
  workspacePath: string | null;
  contexts: DevelopmentContext[];
}

export interface TaskboardMetadata {
  codeLoopBoardSkillPath?: string;
  capabilities?: TaskboardCapabilities;
  mode?: "local" | "cloud";
  realtime?: {
    transport: "poll";
    intervalMs: number;
  };
  localCapabilities?: {
    available: boolean;
  };
}

export interface TaskboardCapabilities {
  localAiChat: boolean;
}

export type AiChatSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiChatThreadStatus = "idle" | "running" | "failed";
export type AiChatRunStatus = "running" | "completed" | "failed" | "interrupted";

export interface AiChatModel {
  slug: string;
  displayName: string;
  description: string;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: string[];
  serviceTiers: Array<{ id: string; name: string }>;
}

export interface AiChatSkill {
  id: string;
  label: string;
  description: string;
  path: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface AiChatAttachmentInput {
  filename: string;
  contentType: string;
  dataBase64: string;
}

export interface AiChatCatalog {
  models: AiChatModel[];
  skills: AiChatSkill[];
  sandboxes: string[];
}

export interface AiChatOrigin {
  projectId: string;
  projectName: string;
  workspacePath: string;
  issueId?: string;
  issueIdentifier?: string;
}

export interface AiChatRun {
  id: string;
  threadId: string;
  status: AiChatRunStatus;
  exitCode?: number | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export interface AiChatThread {
  id: string;
  title: string;
  status: AiChatThreadStatus;
  origin: AiChatOrigin;
  codexThreadId: string | null;
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
  createdAt: string;
  updatedAt: string;
  currentRun?: AiChatRun | null;
}

export interface AiChatEvent {
  id: string;
  threadId?: string;
  runId?: string | null;
  type: string;
  role: "user" | "assistant" | "activity" | "error";
  content: string;
  data?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface AiChatThreadSnapshot {
  thread: AiChatThread;
  events: AiChatEvent[];
  runs: AiChatRun[];
}

export interface WorkflowCapabilityOption {
  id: string;
  label: string;
  scope: "user" | "repo" | "system" | "admin";
}

export interface WorkflowMcpServerOption {
  id: string;
  label: string;
  transport: string;
}

export interface WorkflowCapabilities {
  skills: WorkflowCapabilityOption[];
  mcpServers: WorkflowMcpServerOption[];
}

export interface WorkflowOption {
  id: string;
  name: string;
}

export interface WorkflowWorkspaceRecord<T = unknown> {
  projectId: string;
  workspace: T | null;
  version: number;
  updatedAt: string | null;
}

export interface Project {
  id: string;
  name: string;
  workspacePath: string | null;
  issueCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskRelationSummary {
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: ActorIdentity;
  archivedAt: string | null;
}

export interface TaskRelations {
  parent: TaskRelationSummary | null;
  subIssues: TaskRelationSummary[];
  blockedBy: TaskRelationSummary[];
  blocks: TaskRelationSummary[];
  related: TaskRelationSummary[];
}

export type AutomationExecutionPhase =
  | "working"
  | "awaiting_approval"
  | "approval_granted"
  | "ready_to_merge"
  | "merging"
  | "paused_for_human"
  | "cleanup_pending"
  | "completed"
  | "canceled";

export type AutomationReviewStatus = "pending" | "approved" | "rejected" | "stale";

export interface AutomationReviewRepository {
  name: string;
  worktreePath: string;
  baseCommit: string;
  headCommit: string | null;
}

export interface AutomationReviewTotals {
  files: number;
  additions: number;
  deletions: number;
  changedLines: number;
}

export interface AutomationReviewFile {
  repository: string;
  path: string;
  previousPath: string | null;
  status: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface AutomationReview {
  id: string;
  taskId: string;
  executionId: string;
  status: AutomationReviewStatus;
  repositories: AutomationReviewRepository[];
  files: AutomationReviewFile[];
  riskReasons: string[];
  reviewerId: string | null;
  reviewerName: string | null;
  decisionComment: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
  updatedAt: string;
}

export interface AutomationReviewSummary extends AutomationReview {
  totals: AutomationReviewTotals;
}

export interface AutomationReviewCardSummary {
  reviewId: string;
  status: AutomationReviewStatus;
  riskReasons: string[];
  files: number;
  additions: number;
  deletions: number;
  version: number;
}

export interface ReviewDiffRequest {
  repository: string;
  path: string;
  startLine?: number;
  lineCount?: number;
}

export interface ReviewDiffChunk {
  repository: string;
  path: string;
  language: string;
  startLine: number;
  binary?: boolean;
  summary?: string;
  lines: string[];
  hasMore: boolean;
  nextStartLine: number | null;
}

export interface AutomationExecutionRepository {
  name: string;
  repositoryPath: string;
  worktreePath: string;
  taskBranch: string;
  targetBranch: string;
  baseCommit: string;
  taskCommit?: string;
  mergedCommit?: string;
  pushedCommit?: string;
  status: string;
}

export interface AutomationExecution {
  id: string;
  projectId: string;
  taskId: string;
  slotNumber: number;
  token: string;
  phase: AutomationExecutionPhase;
  workspacePath: string;
  worktreeRoot: string;
  repositories: AutomationExecutionRepository[];
  error: { reason?: string; conflictFiles?: string[] } | null;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface ExternalIssue {
  connectionId: string;
  scopeId: string;
  externalId: string;
  key: string;
  url: string;
}

export interface TaskDelivery {
  mode: "review" | "release";
  repositories: Array<{ repositoryId: string; targetBranch: string }>;
}

export interface Task {
  externalIssue: ExternalIssue | null;
  delivery: TaskDelivery;
  id: string;
  identifier: string;
  projectId: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  sortOrder: number;
  threadId: string | null;
  creatorType: ActorType;
  creatorId: string;
  creatorName: string;
  creatorAvatarUrl: string | null;
  assignee: ActorIdentity;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  automationExecution: AutomationExecution | null;
  automationReview?: AutomationReviewCardSummary;
  dueDate: string | null;
  recurrence: Recurrence | null;
  estimatedHandlingHours: number | null;
  actualHandlingHours: number | null;
  archivedAt: string | null;
  relations: TaskRelations;
  version: number;
  createdAt: string;
  statusChangedAt: string;
  updatedAt: string;
}

export interface Comment {
  id: string;
  taskId: string;
  body: string;
  authorType: ActorType;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  threadId: string | null;
  attachments: Attachment[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  taskId: string;
  commentId: string | null;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

export interface HostContext {
  user?: ActorIdentity;
  workspacePath?: string;
  threadId?: string;
  theme?: "light" | "dark";
  projectId?: string;
  projects?: Array<{ id: string; name: string }>;
  titlebarLeftInset?: number;
  sidebarCollapsed?: boolean;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  labels: string[];
  assigneeTarget?: AssigneeTarget;
  workflowId: string | null;
  developmentContext: DevelopmentContext | null;
  dueDate: string | null;
  recurrence: Recurrence | null;
}

export interface TaskEvent {
  type: string;
  projectId?: string;
  taskId?: string;
  task?: Task;
  comment?: Comment;
  attachment?: Attachment;
  project?: Project;
  at: string;
}
