import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { boundStatus, boardStateIds, canMoveTask, stateDefinition, taskStatusSequence } from "../shared/board-config.mjs";
import { normalizeExternalIssue, normalizeExternalState, normalizeDelivery, hasSameExternalBinding } from "../shared/external-issue.mjs";
import { migrateBoardStorage, getBoardConfig, saveBoardConfig } from "./board-config-store.mjs";
import { prohibitedSubmissionPaths, staticSubmissionError } from "../shared/automation-submission-policy.mjs";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function now() {
  return new Date().toISOString();
}

function elapsedHours(startedAt, finishedAt) {
  const startedMs = Date.parse(startedAt ?? "");
  const finishedMs = Date.parse(finishedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(finishedMs)) return 0;
  return Math.round(Math.max(0, finishedMs - startedMs) / 36_000) / 100;
}

function taskWriteError(error) {
  if (error?.errcode === 2067 && error.message.includes("tasks.external_connection_id")) {
    return new ApiError(409, "EXTERNAL_ISSUE_EXISTS", "This external issue already exists in the project");
  }
  return error;
}

const AUTOMATION_RUNNABLE_PHASES = new Set(["working", "ready_to_merge", "merging"]);
const MERGE_RETRY_INTERVAL_MS = 10 * 60 * 1000;
const MAX_MERGE_RETRIES = 5;

function taskFromRow(row) {
  const developmentContext = row.worktree_path
    ? { type: "worktree", path: row.worktree_path, branch: row.worktree_branch }
    : row.git_branch
      ? { type: "branch", branch: row.git_branch }
      : null;
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    description: row.description,
    externalIssue: row.external_issue ? JSON.parse(row.external_issue) : null,
    externalState: row.external_state ? JSON.parse(row.external_state) : null,
    delivery: JSON.parse(row.delivery),
    status: row.status,
    priority: row.priority,
    labels: JSON.parse(row.labels),
    sortOrder: row.sort_order,
    threadId: row.thread_id,
    creatorType: row.creator_type,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    workflowId: row.workflow_id,
    developmentContext,
    dueDate: row.due_date,
    recurrence: row.recurrence_interval && row.recurrence_unit
      ? { interval: row.recurrence_interval, unit: row.recurrence_unit }
      : null,
    estimatedHandlingHours: row.estimated_handling_hours,
    actualHandlingHours: row.actual_handling_hours,
    archivedAt: row.archived_at,
    version: row.version,
    createdAt: row.created_at,
    statusChangedAt: row.status_changed_at,
    updatedAt: row.updated_at,
  };
}

function automationExecutionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    slotNumber: row.slot_number,
    token: row.token,
    phase: row.phase,
    runOwnerThreadId: row.run_owner_thread_id,
    runStartedAt: row.run_started_at,
    mergeRetryCount: row.merge_retry_count,
    mergeRetryAt: row.merge_retry_at,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    codexThreadStatus: row.codex_thread_status,
    codexLastError: row.codex_last_error,
    workspacePath: row.workspace_path,
    worktreeRoot: row.worktree_root,
    repositories: JSON.parse(row.repositories),
    error: row.error_details === null ? null : JSON.parse(row.error_details),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  };
}

function automationReviewFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    taskId: row.task_id,
    executionId: row.execution_id,
    status: row.status,
    repositories: JSON.parse(row.repositories),
    files: JSON.parse(row.files),
    riskReasons: JSON.parse(row.risk_reasons),
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_name,
    decisionComment: row.decision_comment,
    version: row.version,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    updatedAt: row.updated_at,
  };
}

function automationReviewCardSummaryFromRow(row) {
  if (!row) return null;
  const files = JSON.parse(row.files);
  const totals = files.reduce((summary, file) => {
    if (file.binary || file.additions == null || file.deletions == null) return summary;
    summary.files += 1;
    summary.additions += file.additions;
    summary.deletions += file.deletions;
    return summary;
  }, { files: 0, additions: 0, deletions: 0 });
  return {
    reviewId: row.id,
    status: row.status,
    riskReasons: JSON.parse(row.risk_reasons),
    ...totals,
    version: row.version,
  };
}

function automationPolicyFromRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    projectName: row.project_name,
    workspacePath: row.workspace_path,
    skillPath: row.skill_path,
    enabledByUser: row.enabled_by_user === 1,
    quotaAware: row.quota_aware === 1,
    quotaAllowsRun: row.quota_allows_run === 1,
    concurrencyLimit: row.concurrency_limit,
    intervalMinutes: row.interval_minutes,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function taskRelationSummaryFromRow(row) {
  return {
    id: row.id,
    identifier: row.identifier,
    projectId: row.project_id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assignee: {
      type: row.assignee_type,
      id: row.assignee_id,
      name: row.assignee_name,
      avatarUrl: row.assignee_avatar_url,
    },
    archivedAt: row.archived_at,
  };
}

function commentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    body: row.body,
    threadId: row.thread_id,
    authorType: row.author_type,
    authorId: row.author_id,
    authorName: row.author_name,
    authorAvatarUrl: row.author_avatar_url,
    attachments: [],
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function attachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id,
    commentId: row.comment_id,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    createdAt: row.created_at,
  };
}

function projectFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    workspacePath: row.workspace_path,
    issueCount: Number(row.issue_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function workflowWorkspaceFromRow(row) {
  return {
    projectId: row.project_id,
    workspace: JSON.parse(row.workspace),
    version: row.version,
    updatedAt: row.updated_at,
  };
}

function aiChatRunFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function aiChatThreadFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    origin: {
      projectId: row.origin_project_id,
      projectName: row.origin_project_name,
      workspacePath: row.origin_workspace_path,
      ...(row.origin_issue_id ? { issueId: row.origin_issue_id } : {}),
      ...(row.origin_issue_identifier ? { issueIdentifier: row.origin_issue_identifier } : {}),
    },
    codexThreadId: row.codex_thread_id,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    sandbox: row.sandbox,
    currentRun: null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function aiChatEventFromRow(row) {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    type: row.type,
    role: row.role,
    content: row.content,
    data: row.data === null ? null : JSON.parse(row.data),
    createdAt: row.created_at,
  };
}

function projectPrefix(projectId) {
  const prefix = projectId.toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return (prefix || "TASK").slice(0, 12);
}

export class TaskboardDatabase {
  constructor(filename) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.database = new DatabaseSync(filename);
    this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.#migrate();
    this.interruptAbandonedAiChatRuns();
  }

  #migrate() {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        workspace_path TEXT,
        next_task_number INTEGER NOT NULL DEFAULT 1 CHECK (next_task_number > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        identifier TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id),
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
        labels TEXT NOT NULL DEFAULT '[]',
        sort_order REAL NOT NULL,
        thread_id TEXT,
        creator_type TEXT NOT NULL DEFAULT 'user',
        creator_id TEXT NOT NULL DEFAULT 'local-user',
        creator_name TEXT NOT NULL DEFAULT '本地用户',
        creator_avatar_url TEXT,
        assignee_type TEXT NOT NULL DEFAULT 'user' CHECK (assignee_type IN ('user', 'agent')),
        assignee_id TEXT NOT NULL DEFAULT 'local-user',
        assignee_name TEXT NOT NULL DEFAULT '本地用户',
        assignee_avatar_url TEXT,
        workflow_id TEXT,
        git_branch TEXT,
        worktree_path TEXT,
        worktree_branch TEXT,
        due_date TEXT,
        recurrence_interval INTEGER,
        recurrence_unit TEXT,
        estimated_handling_hours REAL CHECK (estimated_handling_hours IS NULL OR estimated_handling_hours >= 0),
        actual_handling_hours REAL CHECK (actual_handling_hours IS NULL OR actual_handling_hours >= 0),
        archived_at TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        status_changed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at);

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        body TEXT NOT NULL,
        thread_id TEXT,
        author_type TEXT NOT NULL DEFAULT 'user',
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        author_avatar_url TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS comments_task_created
        ON comments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS attachments_task_created
        ON attachments(task_id, created_at, id);

      CREATE TABLE IF NOT EXISTS workflow_workspaces (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        workspace TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_chat_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'failed')),
        origin_project_id TEXT NOT NULL,
        origin_project_name TEXT NOT NULL,
        origin_workspace_path TEXT NOT NULL,
        origin_issue_id TEXT,
        origin_issue_identifier TEXT,
        codex_thread_id TEXT,
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        sandbox TEXT NOT NULL CHECK (sandbox IN (
          'read-only', 'workspace-write', 'danger-full-access'
        )),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_threads_updated
        ON ai_chat_threads(updated_at DESC, id);

      CREATE TABLE IF NOT EXISTS ai_chat_runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK (status IN (
          'running', 'completed', 'failed', 'interrupted'
        )),
        exit_code INTEGER,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE INDEX IF NOT EXISTS ai_chat_runs_thread_started
        ON ai_chat_runs(thread_id, started_at, id);

      CREATE UNIQUE INDEX IF NOT EXISTS ai_chat_runs_one_active
        ON ai_chat_runs(thread_id)
        WHERE status = 'running';

      CREATE TABLE IF NOT EXISTS ai_chat_events (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES ai_chat_threads(id) ON DELETE CASCADE,
        run_id TEXT REFERENCES ai_chat_runs(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'activity', 'error')),
        content TEXT NOT NULL,
        data TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS ai_chat_events_thread_created
        ON ai_chat_events(thread_id, created_at, id);

      CREATE TABLE IF NOT EXISTS automation_executions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 12),
        token TEXT NOT NULL UNIQUE,
        phase TEXT NOT NULL CHECK (phase IN (
          'working', 'awaiting_approval', 'approval_granted',
          'ready_to_merge', 'merging', 'paused_for_human',
          'cleanup_pending', 'completed', 'canceled'
        )),
        run_owner_thread_id TEXT,
        run_started_at TEXT,
        merge_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (merge_retry_count >= 0),
        merge_retry_at TEXT,
        codex_thread_id TEXT,
        codex_turn_id TEXT,
        codex_thread_status TEXT CHECK (codex_thread_status IS NULL OR codex_thread_status IN (
          'starting', 'running', 'completed', 'failed', 'interrupted'
        )),
        codex_last_error TEXT,
        workspace_path TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        repositories TEXT NOT NULL,
        error_details TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS automation_execution_project_created
        ON automation_executions(project_id, created_at, id);

      CREATE TABLE IF NOT EXISTS automation_reviews (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        execution_id TEXT NOT NULL UNIQUE REFERENCES automation_executions(id) ON DELETE CASCADE,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','stale')),
        repositories TEXT NOT NULL,
        files TEXT NOT NULL,
        risk_reasons TEXT NOT NULL,
        reviewer_id TEXT,
        reviewer_name TEXT,
        decision_comment TEXT,
        version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
        created_at TEXT NOT NULL,
        decided_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS automation_review_task_latest
        ON automation_reviews(task_id, updated_at DESC, created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS automation_merge_state (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        execution_id TEXT REFERENCES automation_executions(id) ON DELETE SET NULL,
        paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_policies (
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        project_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        skill_path TEXT NOT NULL,
        enabled_by_user INTEGER NOT NULL CHECK (enabled_by_user IN (0, 1)),
        quota_aware INTEGER NOT NULL CHECK (quota_aware IN (0, 1)),
        quota_allows_run INTEGER NOT NULL CHECK (quota_allows_run IN (0, 1)),
        concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 12),
        interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 10, 15, 30, 60)),
        model TEXT NOT NULL,
        reasoning_effort TEXT NOT NULL,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );

    `);

    const projectColumns = this.database.prepare("PRAGMA table_info(projects)").all();
    if (!projectColumns.some((column) => column.name === "workspace_path")) {
      this.database.exec("ALTER TABLE projects ADD COLUMN workspace_path TEXT");
    }
    const automationExecutionColumns = this.database.prepare("PRAGMA table_info(automation_executions)").all();
    if (!automationExecutionColumns.some((column) => column.name === "run_owner_thread_id")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN run_owner_thread_id TEXT");
    }
    if (!automationExecutionColumns.some((column) => column.name === "run_started_at")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN run_started_at TEXT");
    }
    if (!automationExecutionColumns.some((column) => column.name === "merge_retry_count")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN merge_retry_count INTEGER NOT NULL DEFAULT 0");
    }
    if (!automationExecutionColumns.some((column) => column.name === "merge_retry_at")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN merge_retry_at TEXT");
    }
    if (!automationExecutionColumns.some((column) => column.name === "codex_thread_id")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN codex_thread_id TEXT");
    }
    if (!automationExecutionColumns.some((column) => column.name === "codex_turn_id")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN codex_turn_id TEXT");
    }
    if (!automationExecutionColumns.some((column) => column.name === "codex_thread_status")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN codex_thread_status TEXT");
    }
    if (!automationExecutionColumns.some((column) => column.name === "codex_last_error")) {
      this.database.exec("ALTER TABLE automation_executions ADD COLUMN codex_last_error TEXT");
    }
    this.#migrateAutomationExecutionPhases();
    this.database.exec(`
      DROP INDEX IF EXISTS automation_execution_active_task;
      DROP INDEX IF EXISTS automation_execution_active_slot;
      CREATE INDEX IF NOT EXISTS automation_execution_project_created
        ON automation_executions(project_id, created_at, id);
      CREATE UNIQUE INDEX automation_execution_active_task
        ON automation_executions(task_id)
        WHERE phase IN ('working', 'ready_to_merge', 'merging')
          AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ${MAX_MERGE_RETRIES} AND merge_retry_at IS NULL);
      CREATE UNIQUE INDEX automation_execution_active_slot
        ON automation_executions(project_id, slot_number)
        WHERE phase IN ('working', 'ready_to_merge', 'merging')
          AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ${MAX_MERGE_RETRIES} AND merge_retry_at IS NULL);
    `);

    const taskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const hasThreadId = taskColumns.some((column) => column.name === "thread_id");
    const hasLinkedThreadId = taskColumns.some((column) => column.name === "linked_thread_id");
    if (!hasThreadId) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN thread_id TEXT");
    }
    if (hasLinkedThreadId) {
      this.database.exec(`
        UPDATE tasks
        SET thread_id = COALESCE(thread_id, linked_thread_id)
      `);
      this.database.exec("ALTER TABLE tasks DROP COLUMN linked_thread_id");
    }
    if (!taskColumns.some((column) => column.name === "git_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN git_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_path")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_path TEXT");
    }
    if (!taskColumns.some((column) => column.name === "worktree_branch")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN worktree_branch TEXT");
    }
    if (!taskColumns.some((column) => column.name === "due_date")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN due_date TEXT");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_interval")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_interval INTEGER");
    }
    if (!taskColumns.some((column) => column.name === "recurrence_unit")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN recurrence_unit TEXT");
    }
    if (!taskColumns.some((column) => column.name === "estimated_handling_hours")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN estimated_handling_hours REAL");
    }
    if (!taskColumns.some((column) => column.name === "actual_handling_hours")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN actual_handling_hours REAL");
    }
    const migratedTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!migratedTaskColumns.some((column) => column.name === "creator_type")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_id TEXT NOT NULL DEFAULT 'local-user'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_name")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_name TEXT NOT NULL DEFAULT '本地用户'");
    }
    if (!migratedTaskColumns.some((column) => column.name === "creator_avatar_url")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN creator_avatar_url TEXT");
    }
    if (!migratedTaskColumns.some((column) => column.name === "workflow_id")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN workflow_id TEXT");
    }
    this.database.exec(`
      UPDATE tasks
      SET creator_type = 'agent', creator_id = 'codex-agent', creator_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND version = 1 AND creator_id = 'local-user'
    `);
    const identityTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    const assigneeMigrations = [
      ["assignee_type", "TEXT CHECK (assignee_type IN ('user', 'agent'))", "creator_type"],
      ["assignee_id", "TEXT", "creator_id"],
      ["assignee_name", "TEXT", "creator_name"],
      ["assignee_avatar_url", "TEXT", "creator_avatar_url"],
    ].filter(([column]) => !identityTaskColumns.some((current) => current.name === column));
    if (assigneeMigrations.length > 0) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        for (const [column, definition, source] of assigneeMigrations) {
          this.database.exec(`ALTER TABLE tasks ADD COLUMN ${column} ${definition}`);
          this.database.exec(`UPDATE tasks SET ${column} = ${source}`);
        }
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
    const completeTaskColumns = this.database.prepare("PRAGMA table_info(tasks)").all();
    if (!completeTaskColumns.some((column) => column.name === "status_changed_at")) {
      this.database.exec("ALTER TABLE tasks ADD COLUMN status_changed_at TEXT");
    }
    this.database.exec(`
      UPDATE tasks
      SET status_changed_at = COALESCE(status_changed_at, updated_at)
    `);
    migrateBoardStorage(this.database);
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS tasks_project_status_sort
        ON tasks(project_id, archived_at, status, sort_order, created_at)
    `);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS task_relations (
        relation_type TEXT NOT NULL CHECK (relation_type IN ('parent', 'blocks', 'related')),
        source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        CHECK (source_task_id <> target_task_id),
        CHECK (relation_type <> 'related' OR source_task_id < target_task_id),
        PRIMARY KEY (relation_type, source_task_id, target_task_id)
      );

      CREATE INDEX IF NOT EXISTS task_relations_target
        ON task_relations(relation_type, target_task_id);

      CREATE UNIQUE INDEX IF NOT EXISTS task_relations_one_parent
        ON task_relations(target_task_id)
        WHERE relation_type = 'parent';
    `);

    const commentColumns = this.database.prepare("PRAGMA table_info(comments)").all();
    if (!commentColumns.some((column) => column.name === "thread_id")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN thread_id TEXT");
    }
    if (!commentColumns.some((column) => column.name === "author_type")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_type TEXT NOT NULL DEFAULT 'user'");
    }
    if (!commentColumns.some((column) => column.name === "author_avatar_url")) {
      this.database.exec("ALTER TABLE comments ADD COLUMN author_avatar_url TEXT");
    }
    this.database.exec(`
      UPDATE comments
      SET author_type = 'agent', author_id = 'codex-agent', author_name = 'Codex Agent'
      WHERE thread_id IS NOT NULL AND author_id = 'local'
    `);
    this.database.exec(`
      UPDATE comments
      SET author_id = 'local-user'
      WHERE author_id = 'local'
    `);

    const hasTaskThreads = this.database.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'task_threads'
    `).get();
    if (hasTaskThreads) {
      const tasksWithoutThread = this.database.prepare("SELECT id FROM tasks WHERE thread_id IS NULL").all();
      const selectThread = this.database.prepare(`
        SELECT task_threads.thread_id
        FROM task_threads
        WHERE task_threads.task_id = ?
        ORDER BY
          CASE WHEN EXISTS (
            SELECT 1 FROM comments
            WHERE comments.task_id = ?
              AND comments.thread_id = task_threads.thread_id
          ) THEN 1 ELSE 0 END,
          task_threads.created_at DESC,
          task_threads.thread_id DESC
        LIMIT 1
      `);
      const updateThread = this.database.prepare("UPDATE tasks SET thread_id = ? WHERE id = ? AND thread_id IS NULL");
      for (const task of tasksWithoutThread) {
        const thread = selectThread.get(task.id, task.id);
        if (thread) updateThread.run(thread.thread_id, task.id);
      }
      this.database.exec("DROP TABLE task_threads");
    }

    const attachmentColumns = this.database.prepare("PRAGMA table_info(attachments)").all();
    if (!attachmentColumns.some((column) => column.name === "comment_id")) {
      this.database.exec("ALTER TABLE attachments ADD COLUMN comment_id TEXT REFERENCES comments(id) ON DELETE CASCADE");
    }
    this.database.exec("CREATE INDEX IF NOT EXISTS attachments_comment_created ON attachments(comment_id, created_at, id)");

    const timestamp = now();
    this.database.prepare(`
      INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
      VALUES ('local', 'Local', NULL, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(timestamp, timestamp);
  }

  close() {
    this.database.close();
  }

  #migrateAutomationExecutionPhases() {
    const executionsSql = this.database.prepare(`
      SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'automation_executions'
    `).get()?.sql ?? "";
    if (executionsSql.includes("'approval_granted'")) return;

    this.database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      this.database.exec(`
        CREATE TABLE automation_executions_phase_migration (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
          slot_number INTEGER NOT NULL CHECK (slot_number BETWEEN 1 AND 12),
          token TEXT NOT NULL UNIQUE,
          phase TEXT NOT NULL CHECK (phase IN (
            'working', 'awaiting_approval', 'approval_granted',
            'ready_to_merge', 'merging', 'paused_for_human',
            'cleanup_pending', 'completed', 'canceled'
          )),
          run_owner_thread_id TEXT,
          run_started_at TEXT,
          merge_retry_count INTEGER NOT NULL DEFAULT 0 CHECK (merge_retry_count >= 0),
          merge_retry_at TEXT,
          codex_thread_id TEXT,
          codex_turn_id TEXT,
          codex_thread_status TEXT CHECK (codex_thread_status IS NULL OR codex_thread_status IN (
            'starting', 'running', 'completed', 'failed', 'interrupted'
          )),
          codex_last_error TEXT,
          workspace_path TEXT NOT NULL,
          worktree_root TEXT NOT NULL,
          repositories TEXT NOT NULL,
          error_details TEXT,
          version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO automation_executions_phase_migration (
          id, project_id, task_id, slot_number, token, phase,
          run_owner_thread_id, run_started_at, merge_retry_count, merge_retry_at,
          codex_thread_id, codex_turn_id, codex_thread_status, codex_last_error,
          workspace_path, worktree_root, repositories, error_details,
          version, created_at, updated_at
        )
        SELECT
          id, project_id, task_id, slot_number, token, phase,
          run_owner_thread_id, run_started_at, merge_retry_count, merge_retry_at,
          codex_thread_id, codex_turn_id, codex_thread_status, codex_last_error,
          workspace_path, worktree_root, repositories, error_details,
          version, created_at, updated_at
        FROM automation_executions;

        DROP TABLE automation_executions;
        ALTER TABLE automation_executions_phase_migration RENAME TO automation_executions;

        CREATE INDEX automation_execution_project_created
          ON automation_executions(project_id, created_at, id);
        CREATE UNIQUE INDEX automation_execution_active_task
          ON automation_executions(task_id)
          WHERE phase IN ('working', 'ready_to_merge', 'merging')
            AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ${MAX_MERGE_RETRIES} AND merge_retry_at IS NULL);
        CREATE UNIQUE INDEX automation_execution_active_slot
          ON automation_executions(project_id, slot_number)
          WHERE phase IN ('working', 'ready_to_merge', 'merging')
            AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ${MAX_MERGE_RETRIES} AND merge_retry_at IS NULL);
      `);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    } finally {
      this.database.exec("PRAGMA foreign_keys = ON");
    }

    const violation = this.database.prepare("PRAGMA foreign_key_check").get();
    if (violation) {
      throw new Error(`Automation execution phase migration produced a foreign key violation in '${violation.table}'`);
    }
  }

  getProjectBoardConfig(projectId) {
    if (!this.getProject(projectId)) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    return getBoardConfig(this.database, projectId);
  }

  saveProjectBoardConfig(projectId, input) {
    return saveBoardConfig(this.database, projectId, input, ApiError);
  }

  #boundTaskStatus(taskId, role) {
    const task = this.database.prepare("SELECT project_id FROM tasks WHERE id = ? OR identifier = ?").get(taskId, taskId);
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${taskId}' does not exist`);
    const status = boundStatus(getBoardConfig(this.database, task.project_id).config, role);
    if (!status) throw new ApiError(409, "BOARD_ACTION_UNAVAILABLE", `No state is configured for '${role}'`);
    return status;
  }

  #taskStatusSql(taskId, role) {
    return "'" + this.#boundTaskStatus(taskId, role).replaceAll("'", "''") + "'";
  }

  #projectStatusSql(projectId, role) {
    const status = boundStatus(getBoardConfig(this.database, projectId).config, role);
    if (!status) throw new ApiError(409, "BOARD_ACTION_UNAVAILABLE", `No state is configured for '${role}'`);
    return "'" + status.replaceAll("'", "''") + "'";
  }

  #assertManualTaskStatus(task, nextStatus) {
    if (task.status === nextStatus) return;
    const execution = this.database.prepare(`SELECT 1 FROM automation_executions
      WHERE task_id = ? AND phase NOT IN ('paused_for_human', 'completed', 'canceled') LIMIT 1`).get(task.id);
    if (execution) {
      throw new ApiError(409, "AUTOMATION_STATUS_MANAGED", "Active automation controls this task's state");
    }
  }

  listProjects() {
    return this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at
      ORDER BY projects.created_at, projects.id
    `).all().map(projectFromRow);
  }

  createProject(input) {
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO projects (id, name, workspace_path, next_task_number, created_at, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)
      `).run(input.id, input.name, input.workspacePath, timestamp, timestamp);
    } catch (error) {
      if (String(error.message).includes("UNIQUE constraint failed")) {
        throw new ApiError(409, "PROJECT_EXISTS", `Project '${input.id}' already exists`);
      }
      throw error;
    }
    return this.getProject(input.id);
  }

  getProject(id) {
    const row = this.database.prepare(`
      SELECT
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at,
        COUNT(tasks.id) AS issue_count
      FROM projects
      LEFT JOIN tasks
        ON tasks.project_id = projects.id
        AND tasks.archived_at IS NULL
      WHERE projects.id = ?
      GROUP BY
        projects.id,
        projects.name,
        projects.workspace_path,
        projects.created_at,
        projects.updated_at
    `).get(id);
    return row ? projectFromRow(row) : null;
  }

  getWorkflowWorkspace(projectId) {
    if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const row = this.database.prepare(`
      SELECT project_id, workspace, version, updated_at
      FROM workflow_workspaces
      WHERE project_id = ?
    `).get(projectId);
    return row
      ? workflowWorkspaceFromRow(row)
      : { projectId, workspace: null, version: 0, updatedAt: null };
  }

  saveWorkflowWorkspace(projectId, expectedVersion, workspace) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      if (!this.database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
      }
      const current = this.database.prepare(`
        SELECT version FROM workflow_workspaces WHERE project_id = ?
      `).get(projectId);
      const actualVersion = current?.version ?? 0;
      if (actualVersion !== expectedVersion) {
        throw new ApiError(409, "VERSION_CONFLICT", "Workflow was changed by another client", {
          expectedVersion,
          actualVersion,
        });
      }
      if (current) {
        this.database.prepare(`
          UPDATE workflow_workspaces
          SET workspace = ?, version = version + 1, updated_at = ?
          WHERE project_id = ? AND version = ?
        `).run(JSON.stringify(workspace), timestamp, projectId, expectedVersion);
      } else {
        this.database.prepare(`
          INSERT INTO workflow_workspaces (project_id, workspace, version, updated_at)
          VALUES (?, ?, 1, ?)
        `).run(projectId, JSON.stringify(workspace), timestamp);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getWorkflowWorkspace(projectId);
  }

  listAiChatThreads() {
    return this.database.prepare(`
      SELECT * FROM ai_chat_threads
      ORDER BY updated_at DESC, id
    `).all().map((row) => this.#aiChatThreadWithCurrentRun(row));
  }

  getAiChatThread(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_threads WHERE id = ?").get(id);
    return row ? this.#aiChatThreadWithCurrentRun(row) : null;
  }

  createAiChatThread(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_threads (
        id, title, status,
        origin_project_id, origin_project_name, origin_workspace_path,
        origin_issue_id, origin_issue_identifier,
        codex_thread_id, model, reasoning_effort, sandbox,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.status ?? "idle",
      input.origin.projectId,
      input.origin.projectName,
      input.origin.workspacePath,
      input.origin.issueId ?? null,
      input.origin.issueIdentifier ?? null,
      input.codexThreadId ?? null,
      input.model,
      input.reasoningEffort,
      input.sandbox,
      timestamp,
      input.updatedAt ?? timestamp,
    );
    return this.getAiChatThread(id);
  }

  updateAiChatThread(id, changes) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    const columns = {
      title: "title",
      status: "status",
      codexThreadId: "codex_thread_id",
      model: "model",
      reasoningEffort: "reasoning_effort",
      sandbox: "sandbox",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;
    assignments.push("updated_at = ?");
    values.push(changes.updatedAt ?? now(), id);
    this.database.prepare(`
      UPDATE ai_chat_threads SET ${assignments.join(", ")} WHERE id = ?
    `).run(...values);
    return this.getAiChatThread(id);
  }

  deleteAiChatThread(id) {
    const current = this.getAiChatThread(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_THREAD_NOT_FOUND", `AI chat thread '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM ai_chat_threads WHERE id = ?").run(id);
    return current;
  }

  listAiChatRuns(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ?
      ORDER BY started_at, id
    `).all(threadId).map(aiChatRunFromRow);
  }

  getAiChatRun(id) {
    const row = this.database.prepare("SELECT * FROM ai_chat_runs WHERE id = ?").get(id);
    return row ? aiChatRunFromRow(row) : null;
  }

  createAiChatRun(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.startedAt ?? now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO ai_chat_runs (
          id, thread_id, status, exit_code, error, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.threadId,
        input.status ?? "running",
        input.exitCode ?? null,
        input.error ?? null,
        timestamp,
        input.finishedAt ?? null,
      );
      if ((input.status ?? "running") === "running") {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'running', updated_at = ?
          WHERE id = ?
        `).run(timestamp, input.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  updateAiChatRun(id, changes) {
    const current = this.getAiChatRun(id);
    if (!current) {
      throw new ApiError(404, "AI_CHAT_RUN_NOT_FOUND", `AI chat run '${id}' does not exist`);
    }
    const columns = {
      status: "status",
      exitCode: "exit_code",
      error: "error",
      finishedAt: "finished_at",
    };
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(columns)) {
      if (!Object.hasOwn(changes, key)) continue;
      assignments.push(`${column} = ?`);
      values.push(changes[key]);
    }
    if (assignments.length === 0) return current;

    this.database.exec("BEGIN IMMEDIATE");
    try {
      values.push(id);
      this.database.prepare(`
        UPDATE ai_chat_runs SET ${assignments.join(", ")} WHERE id = ?
      `).run(...values);
      const status = changes.status ?? current.status;
      if (status !== "running") {
        const threadStatus = status === "failed" ? "failed" : "idle";
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = ?, updated_at = ?
          WHERE id = ?
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE thread_id = ? AND status = 'running'
            )
        `).run(threadStatus, changes.finishedAt ?? now(), current.threadId, current.threadId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiChatRun(id);
  }

  insertAiChatEvent(input) {
    const id = input.id ?? randomUUID();
    const timestamp = input.createdAt ?? now();
    this.database.prepare(`
      INSERT INTO ai_chat_events (
        id, thread_id, run_id, type, role, content, data, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.threadId,
      input.runId ?? null,
      input.type,
      input.role,
      input.content,
      input.data === undefined || input.data === null ? null : JSON.stringify(input.data),
      timestamp,
    );
    const row = this.database.prepare("SELECT * FROM ai_chat_events WHERE id = ?").get(id);
    return aiChatEventFromRow(row);
  }

  listAiChatEvents(threadId) {
    return this.database.prepare(`
      SELECT * FROM ai_chat_events
      WHERE thread_id = ?
      ORDER BY created_at, rowid
    `).all(threadId).map(aiChatEventFromRow);
  }

  interruptAbandonedAiChatRuns() {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE ai_chat_runs
        SET
          status = 'interrupted',
          error = COALESCE(error, 'Taskboard service restarted'),
          finished_at = COALESCE(finished_at, ?)
        WHERE status = 'running'
      `).run(timestamp);
      if (result.changes > 0) {
        this.database.prepare(`
          UPDATE ai_chat_threads
          SET status = 'idle', updated_at = ?
          WHERE status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM ai_chat_runs
              WHERE ai_chat_runs.thread_id = ai_chat_threads.id
                AND ai_chat_runs.status = 'running'
            )
        `).run(timestamp);
      }
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listTasks(filters) {
    const where = [];
    const values = [];
    if (filters.projectId) {
      where.push("project_id = ?");
      values.push(filters.projectId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    if (filters.archived === "false") {
      where.push("archived_at IS NULL");
    } else if (filters.archived === "true") {
      where.push("archived_at IS NOT NULL");
    }

    const sql = `
      SELECT * FROM tasks
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        sort_order,
        created_at,
        id
    `;
    const configs = new Map();
    return this.database.prepare(sql).all(...values).map((row) => this.#taskWithRelations(row)).sort((a, b) => {
      for (const task of [a, b]) {
        if (!configs.has(task.projectId)) configs.set(task.projectId, boardStateIds(getBoardConfig(this.database, task.projectId).config));
      }
      return configs.get(a.projectId).indexOf(a.status) - configs.get(b.projectId).indexOf(b.status);
    });
  }

  getTask(id) {
    const row = this.database.prepare("SELECT * FROM tasks WHERE id = ? OR identifier = ?").get(id, id);
    return row ? this.#taskWithRelations(row) : null;
  }

  listProjectAutomationExecutions(projectId, { activeOnly = false } = {}) {
    const rows = this.database.prepare(`
      SELECT * FROM automation_executions
      WHERE project_id = ?
        ${activeOnly ? `AND phase IN ('working', 'ready_to_merge', 'merging')
          AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ${MAX_MERGE_RETRIES} AND merge_retry_at IS NULL)` : ""}
      ORDER BY slot_number, created_at, id
    `).all(projectId);
    return rows.map(automationExecutionFromRow);
  }

  getTaskAutomationExecution(taskId) {
    const task = this.#requireTask(taskId);
    const row = this.database.prepare(`
      SELECT * FROM automation_executions
      WHERE task_id = ?
      ORDER BY
        CASE WHEN phase IN (
          'working', 'awaiting_approval', 'approval_granted',
          'ready_to_merge', 'merging', 'paused_for_human', 'cleanup_pending'
        )
          THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
      LIMIT 1
    `).get(task.id);
    return automationExecutionFromRow(row);
  }

  getAutomationExecutionByCodexThread(threadId) {
    const row = this.database.prepare(`
      SELECT * FROM automation_executions
      WHERE codex_thread_id = ? OR run_owner_thread_id = ?
      ORDER BY updated_at DESC, id DESC
      LIMIT 1
    `).get(threadId, threadId);
    return automationExecutionFromRow(row);
  }

  getAutomationReview(taskId) {
    return automationReviewFromRow(this.database.prepare(`
      SELECT * FROM automation_reviews
      WHERE task_id = ?
      ORDER BY updated_at DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(taskId));
  }

  getAutomationReviewByExecution(executionId) {
    return automationReviewFromRow(this.database.prepare(`
      SELECT * FROM automation_reviews WHERE execution_id = ?
    `).get(executionId));
  }

  getAutomationExecutionById(executionId) {
    return automationExecutionFromRow(this.database.prepare(`
      SELECT * FROM automation_executions WHERE id = ?
    `).get(executionId));
  }

  listApprovedAutomationReviews(projectId) {
    return this.database.prepare(`
      SELECT automation_reviews.*
      FROM automation_reviews
      JOIN automation_executions
        ON automation_executions.id = automation_reviews.execution_id
      WHERE automation_executions.project_id = ?
        AND automation_executions.phase = 'approval_granted'
        AND automation_reviews.status = 'approved'
      ORDER BY automation_reviews.decided_at, automation_reviews.updated_at, automation_reviews.id
    `).all(projectId).map(automationReviewFromRow);
  }

  getAutomationPolicy(projectId) {
    return automationPolicyFromRow(
      this.database.prepare("SELECT * FROM automation_policies WHERE project_id = ?").get(projectId),
    );
  }

  listAutomationPolicies() {
    return this.database.prepare("SELECT * FROM automation_policies ORDER BY project_id")
      .all()
      .map(automationPolicyFromRow);
  }

  saveAutomationPolicy(input) {
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO automation_policies (
        project_id, project_name, workspace_path, skill_path,
        enabled_by_user, quota_aware, quota_allows_run,
        concurrency_limit, interval_minutes, model, reasoning_effort,
        last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(project_id) DO UPDATE SET
        project_name = excluded.project_name,
        workspace_path = excluded.workspace_path,
        skill_path = excluded.skill_path,
        enabled_by_user = excluded.enabled_by_user,
        quota_aware = excluded.quota_aware,
        quota_allows_run = excluded.quota_allows_run,
        concurrency_limit = excluded.concurrency_limit,
        interval_minutes = excluded.interval_minutes,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        last_error = NULL,
        updated_at = excluded.updated_at
    `).run(
      input.projectId,
      input.projectName,
      input.workspacePath,
      input.skillPath,
      input.enabledByUser ? 1 : 0,
      input.quotaAware ? 1 : 0,
      input.quotaAllowsRun ? 1 : 0,
      input.concurrencyLimit,
      input.intervalMinutes,
      input.model,
      input.reasoningEffort,
      timestamp,
    );
    return this.getAutomationPolicy(input.projectId);
  }

  setAutomationPolicyError(projectId, error) {
    this.database.prepare(`
      UPDATE automation_policies SET last_error = ?, updated_at = ? WHERE project_id = ?
    `).run(error, now(), projectId);
    return this.getAutomationPolicy(projectId);
  }

  startAutomationCodexThread(taskId, threadId) {
    const execution = this.#requireAutomationExecution(taskId);
    if (!AUTOMATION_RUNNABLE_PHASES.has(execution.phase)) {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot start Codex from phase '${execution.phase}'`);
    }
    if (execution.runOwnerThreadId !== null && execution.runOwnerThreadId !== threadId) {
      throw new ApiError(409, "AUTOMATION_RUN_ACTIVE", "This automation slot already has a running Codex task");
    }
    if (execution.codexThreadId === threadId && execution.codexThreadStatus === "starting") return execution;
    const timestamp = now();
    this.database.prepare(`
      UPDATE automation_executions
      SET run_owner_thread_id = ?, run_started_at = ?, codex_thread_id = ?, codex_turn_id = NULL,
          codex_thread_status = 'starting', codex_last_error = NULL,
          version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(threadId, timestamp, threadId, timestamp, execution.id);
    this.database.prepare(`
      UPDATE tasks
      SET thread_id = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(threadId, timestamp, execution.taskId);
    this.createComment(taskId, {
      body: "自动认领已启动 Codex 会话。",
      threadId,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  adoptAutomationCodexThread(taskId, threadId) {
    const execution = this.#requireAutomationExecution(taskId);
    this.database.prepare(`
      UPDATE automation_executions
      SET codex_thread_id = ?, codex_thread_status = COALESCE(codex_thread_status, 'running'),
          version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(threadId, now(), execution.id);
    return this.getTaskAutomationExecution(taskId);
  }

  markAutomationCodexThreadRunning(taskId, threadId, turnId) {
    const execution = this.#requireAutomationExecution(taskId);
    if (execution.codexThreadId !== threadId) return execution;
    this.database.prepare(`
      UPDATE automation_executions
      SET codex_turn_id = COALESCE(?, codex_turn_id),
          codex_thread_status = CASE
            WHEN codex_thread_status IN ('completed', 'failed', 'interrupted') THEN codex_thread_status
            ELSE 'running'
          END,
          codex_last_error = NULL, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(turnId, now(), execution.id);
    return this.getTaskAutomationExecution(taskId);
  }

  finishAutomationCodexThread(taskId, threadId, status, error = null) {
    const execution = this.#requireAutomationExecution(taskId);
    if (execution.codexThreadId !== threadId) return execution;
    const normalizedStatus = status === "completed" || status === "failed" || status === "interrupted"
      ? status
      : "failed";
    const errorMessage = error === null || error === undefined
      ? null
      : typeof error === "string" ? error : JSON.stringify(error);
    const timestamp = now();
    const actualHandlingHours = elapsedHours(execution.runStartedAt, timestamp);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE automation_executions
        SET codex_thread_status = ?, codex_last_error = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND codex_thread_status NOT IN ('completed', 'failed', 'interrupted')
      `).run(normalizedStatus, errorMessage, timestamp, execution.id);
      if (result.changes === 1) {
        this.database.prepare(`
          UPDATE tasks
          SET actual_handling_hours = COALESCE(actual_handling_hours, 0) + ?,
              version = version + 1, updated_at = ?
          WHERE id = ?
        `).run(actualHandlingHours, timestamp, taskId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTaskAutomationExecution(taskId);
  }

  pauseAutomationForHuman(taskId, threadId, reason) {
    const execution = this.#requireAutomationExecution(taskId);
    if (!AUTOMATION_RUNNABLE_PHASES.has(execution.phase)) return execution;
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'paused_for_human', run_owner_thread_id = NULL, run_started_at = NULL,
            codex_thread_status = CASE
              WHEN codex_thread_status IN ('starting', 'running') THEN 'failed'
              ELSE codex_thread_status
            END,
            codex_last_error = ?, error_details = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(reason, JSON.stringify({ reason, source: "codex_session" }), timestamp, execution.id);
      this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "blocked")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "blocked")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND status = ${this.#taskStatusSql(taskId, "working")} AND archived_at IS NULL
      `).run(execution.projectId, timestamp, timestamp, execution.taskId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.createComment(taskId, {
      body: `自动认领会话未完成任务，已转入「已阻塞」并释放并发槽位。\n原因：${reason}`,
      threadId,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  failAutomationRun(taskId, token, threadId, reason) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    return this.pauseAutomationForHuman(taskId, threadId, reason);
  }

  acquireAutomationRun(taskId, threadId) {
    const execution = this.#requireAutomationExecution(taskId);
    if (!AUTOMATION_RUNNABLE_PHASES.has(execution.phase)) {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot run automation from phase '${execution.phase}'`);
    }
    if (execution.runOwnerThreadId === threadId) return execution;
    if (execution.runOwnerThreadId !== null) {
      throw new ApiError(409, "AUTOMATION_RUN_ACTIVE", "This automation slot already has a running Codex task");
    }
    if (execution.mergeRetryCount >= MAX_MERGE_RETRIES && execution.mergeRetryAt === null) {
      throw new ApiError(409, "AUTOMATION_MERGE_RETRY_EXHAUSTED", "The target branch could not be updated after five retries");
    }
    if (execution.mergeRetryAt !== null && Date.parse(execution.mergeRetryAt) > Date.now()) {
      throw new ApiError(409, "AUTOMATION_MERGE_RETRY_NOT_DUE", "The next merge retry is not due yet");
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE automation_executions
        SET run_owner_thread_id = ?, run_started_at = ?, codex_thread_id = ?,
            codex_thread_status = 'running', codex_last_error = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND run_owner_thread_id IS NULL
      `).run(threadId, timestamp, threadId, timestamp, execution.id);
      if (result.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_RUN_ACTIVE", "This automation slot already has a running Codex task");
      }
      this.database.prepare(`
        UPDATE tasks SET thread_id = ?, version = version + 1, updated_at = ? WHERE id = ?
      `).run(threadId, timestamp, execution.taskId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.createComment(taskId, {
      body: "自动认领已启动 Codex 会话。",
      threadId,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  releaseAutomationRun(taskId, token, threadId) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase !== "working" && execution.phase !== "ready_to_merge") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot release automation run from phase '${execution.phase}'`);
    }
    this.database.prepare(`
      UPDATE automation_executions
      SET run_owner_thread_id = NULL, run_started_at = NULL, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(now(), execution.id);
    return this.getTaskAutomationExecution(taskId);
  }

  beginAutomationReview(taskId, token, threadId, snapshot) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase !== "working" && execution.phase !== "ready_to_merge") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot begin review from phase '${execution.phase}'`);
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO automation_reviews (
          id, task_id, execution_id, status, repositories, files, risk_reasons,
          reviewer_id, reviewer_name, decision_comment,
          version, created_at, decided_at, updated_at
        ) VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, NULL, 1, ?, NULL, ?)
        ON CONFLICT(execution_id) DO UPDATE SET
          status = 'pending',
          repositories = excluded.repositories,
          files = excluded.files,
          risk_reasons = excluded.risk_reasons,
          reviewer_id = NULL,
          reviewer_name = NULL,
          decision_comment = NULL,
          version = automation_reviews.version + 1,
          decided_at = NULL,
          updated_at = excluded.updated_at
      `).run(
        randomUUID(),
        execution.taskId,
        execution.id,
        JSON.stringify(snapshot.repositories),
        JSON.stringify(snapshot.files),
        JSON.stringify(snapshot.reasons),
        timestamp,
        timestamp,
      );
      const executionResult = this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'awaiting_approval',
            run_owner_thread_id = NULL, run_started_at = NULL,
            codex_thread_id = NULL, codex_turn_id = NULL,
            codex_thread_status = NULL, codex_last_error = NULL,
            version = version + 1, updated_at = ?
        WHERE id = ? AND phase IN ('working', 'ready_to_merge')
          AND run_owner_thread_id = ?
      `).run(timestamp, execution.id, threadId);
      if (executionResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "The automation execution is no longer ready for review");
      }
      const taskResult = this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "approval")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "approval")} AND archived_at IS NULL
            ),
            thread_id = NULL, status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL AND status = ${this.#taskStatusSql(taskId, "working")}
      `).run(execution.projectId, timestamp, timestamp, execution.taskId);
      if (taskResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_TASK_CONFLICT", "The task is no longer available for automation review");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const totals = snapshot.totals;
    const reviewComment = [
      "当前 Worktree 检测到需要人工审批的风险，已保存审阅快照、将任务移入「待审批」并释放并发槽位。",
      ...snapshot.reasons.map((reason) => `- ${reason}`),
      ...(totals
        ? [`变更统计：${totals.files} 个文件，新增 ${totals.additions} 行，删除 ${totals.deletions} 行。`]
        : []),
      "请在任务详情查看变更并完成审批。",
    ].join("\n");
    try {
      this.createComment(taskId, {
        body: reviewComment,
        actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
      });
    } catch (error) {
      console.warn(`Failed to create automation review comment: ${error instanceof Error ? error.message : String(error)}`);
    }
    return this.getTaskAutomationExecution(taskId);
  }

  approveAutomationReview(taskId, reviewId, reviewVersion, actor, comment) {
    const task = this.#requireTask(taskId);
    const review = this.getAutomationReview(taskId);
    if (!review) {
      throw new ApiError(404, "AUTOMATION_REVIEW_NOT_FOUND", `No automation review exists for '${taskId}'`);
    }
    if (review.id !== reviewId) throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
    const prohibitedPaths = prohibitedSubmissionPaths(review.files);
    if (prohibitedPaths.length > 0) {
      throw new ApiError(422, "AUTOMATION_STATIC_ARTIFACT", staticSubmissionError(prohibitedPaths), {
        paths: prohibitedPaths,
      });
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'approved', reviewer_id = ?, reviewer_name = ?, decision_comment = ?,
            version = version + 1, decided_at = ?, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'pending'
      `).run(actor.id, actor.name, comment ?? null, timestamp, timestamp, taskId, reviewId, reviewVersion);
      if (result.changes !== 1) throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);

      const executionResult = this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'approval_granted', version = version + 1, updated_at = ?
        WHERE id = ? AND phase = 'awaiting_approval'
      `).run(timestamp, review.executionId);
      if (executionResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "The automation execution is not awaiting approval");
      }
      const taskResult = this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "working")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "working")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL AND status = ${this.#taskStatusSql(taskId, "approval")}
      `).run(task.projectId, timestamp, timestamp, taskId);
      if (taskResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_TASK_CONFLICT", "The task is no longer awaiting automation review");
      }
      this.createComment(taskId, {
        body: [
          "审批已通过，正在启动 Worktree 代码合并会话。",
          ...(comment ? [`审批备注：${comment}`] : []),
        ].join("\n"),
        actor,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationReview(taskId);
  }

  rejectAutomationReview(taskId, reviewId, reviewVersion, actor, reason) {
    const normalizedReason = typeof reason === "string" ? reason.trim() : "";
    if (!normalizedReason) {
      throw new ApiError(400, "AUTOMATION_REVIEW_REJECTION_REASON_REQUIRED", "A rejection reason is required");
    }
    const task = this.#requireTask(taskId);
    const review = this.getAutomationReview(taskId);
    if (!review) {
      throw new ApiError(404, "AUTOMATION_REVIEW_NOT_FOUND", `No automation review exists for '${taskId}'`);
    }
    if (review.id !== reviewId) throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'rejected', reviewer_id = ?, reviewer_name = ?, decision_comment = ?,
            version = version + 1, decided_at = ?, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'pending'
      `).run(actor.id, actor.name, normalizedReason, timestamp, timestamp, taskId, reviewId, reviewVersion);
      if (result.changes !== 1) throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);

      const executionResult = this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'working', error_details = ?,
            run_owner_thread_id = NULL, run_started_at = NULL,
            codex_thread_id = NULL, codex_turn_id = NULL,
            codex_thread_status = NULL, codex_last_error = ?,
            version = version + 1, updated_at = ?
        WHERE id = ? AND phase = 'awaiting_approval'
      `).run(
        JSON.stringify({ reason: normalizedReason, source: "automation_review" }),
        normalizedReason,
        timestamp,
        review.executionId,
      );
      if (executionResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "The automation execution is not awaiting approval");
      }
      const taskResult = this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "blocked")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "blocked")} AND archived_at IS NULL
            ),
            thread_id = NULL, status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL AND status = ${this.#taskStatusSql(taskId, "approval")}
      `).run(task.projectId, timestamp, timestamp, taskId);
      if (taskResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_TASK_CONFLICT", "The task is no longer awaiting automation review");
      }
      this.createComment(taskId, {
        body: [
          "审批已驳回，任务已转入「已阻塞」。自动化将带着该理由重新认领并触发新的 Codex 会话。",
          `驳回理由：${normalizedReason}`,
        ].join("\n"),
        actor,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationReview(taskId);
  }

  assignApprovedAutomationSlot(taskId, slotNumber) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database.prepare(`
        SELECT
          automation_reviews.id AS review_id,
          automation_reviews.execution_id,
          automation_reviews.status AS review_status,
          automation_executions.project_id,
          automation_executions.task_id AS execution_task_id,
          automation_executions.phase,
          tasks.status AS task_status,
          tasks.archived_at
        FROM automation_reviews
        JOIN automation_executions
          ON automation_executions.id = automation_reviews.execution_id
        JOIN tasks
          ON tasks.id = automation_reviews.task_id
        WHERE automation_reviews.task_id = ?
        ORDER BY automation_reviews.updated_at DESC, automation_reviews.created_at DESC, automation_reviews.id DESC
        LIMIT 1
      `).get(taskId);
      if (!state || state.review_status !== "approved") {
        throw new ApiError(409, "AUTOMATION_REVIEW_NOT_APPROVED", "The automation review is not approved");
      }
      if (
        state.execution_task_id !== taskId
        || state.phase !== "approval_granted"
        || state.archived_at !== null
        || state.task_status !== this.#boundTaskStatus(taskId, "working")
      ) {
        throw new ApiError(409, "AUTOMATION_REVIEW_STATE_CONFLICT", "The approved automation review is no longer eligible for a slot");
      }
      const slotOccupied = this.database.prepare(`
        SELECT 1 FROM automation_executions
        WHERE project_id = ? AND slot_number = ? AND id <> ?
          AND phase IN ('working', 'ready_to_merge', 'merging')
          AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ? AND merge_retry_at IS NULL)
      `).get(state.project_id, slotNumber, state.execution_id, MAX_MERGE_RETRIES);
      if (slotOccupied) {
        throw new ApiError(409, "AUTOMATION_SLOT_OCCUPIED", `Automation slot ${slotNumber} is occupied`);
      }
      const executionResult = this.database.prepare(`
        UPDATE automation_executions
        SET slot_number = ?, phase = 'ready_to_merge',
            run_owner_thread_id = NULL, run_started_at = NULL,
            codex_thread_id = NULL, codex_turn_id = NULL,
            codex_thread_status = NULL, codex_last_error = NULL,
            error_details = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND task_id = ? AND phase = 'approval_granted'
      `).run(slotNumber, timestamp, state.execution_id, taskId);
      if (executionResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_STATE_CONFLICT", "The approved automation execution is no longer waiting for a slot");
      }
      const taskResult = this.database.prepare(`
        UPDATE tasks
        SET thread_id = NULL, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL AND status = ${this.#taskStatusSql(taskId, "working")}
      `).run(timestamp, taskId);
      if (taskResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_TASK_CONFLICT", "The task is no longer available for approved automation");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTaskAutomationExecution(taskId);
  }

  markAutomationReviewStale(taskId, reviewId, reviewVersion, reason) {
    const review = this.getAutomationReview(taskId);
    if (!review) {
      throw new ApiError(404, "AUTOMATION_REVIEW_NOT_FOUND", `No automation review exists for '${taskId}'`);
    }
    if (review.id !== reviewId) throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'stale', decision_comment = ?, version = version + 1,
            decided_at = ?, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'pending'
      `).run(reason, timestamp, timestamp, taskId, reviewId, reviewVersion);
      if (result.changes !== 1) throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationReview(taskId);
  }

  refreshStaleAutomationReview(taskId, reviewId, staleVersion, snapshot) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const review = this.database.prepare(`
        SELECT * FROM automation_reviews
        WHERE task_id = ? AND id = ?
      `).get(taskId, reviewId);
      if (!review || review.version !== staleVersion || review.status !== "stale") {
        throw this.#automationReviewVersionConflict(taskId, reviewId, staleVersion);
      }
      const state = this.database.prepare(`
        SELECT 1
        FROM automation_reviews
        JOIN automation_executions
          ON automation_executions.id = automation_reviews.execution_id
          AND automation_executions.task_id = automation_reviews.task_id
        JOIN tasks
          ON tasks.id = automation_reviews.task_id
        WHERE automation_reviews.task_id = ?
          AND automation_reviews.id = ?
          AND automation_executions.phase = 'awaiting_approval'
          AND tasks.archived_at IS NULL
          AND tasks.status = ${this.#taskStatusSql(taskId, "approval")}
      `).get(taskId, reviewId);
      if (!state) {
        throw new ApiError(409, "AUTOMATION_REVIEW_STATE_CONFLICT", "The stale automation review is no longer safe to refresh");
      }
      const result = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'pending', repositories = ?, files = ?, risk_reasons = ?,
            reviewer_id = NULL, reviewer_name = NULL, decision_comment = NULL,
            version = version + 1, decided_at = NULL, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'stale'
      `).run(
        JSON.stringify(snapshot.repositories),
        JSON.stringify(snapshot.files),
        JSON.stringify(snapshot.reasons),
        timestamp,
        taskId,
        reviewId,
        staleVersion,
      );
      if (result.changes !== 1) throw this.#automationReviewVersionConflict(taskId, reviewId, staleVersion);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationReview(taskId);
  }

  replaceStaleAutomationReviewSnapshot(taskId, reviewId, reviewVersion, reason, snapshot) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const invalidated = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'stale', decision_comment = ?, decided_at = ?, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'pending'
      `).run(reason, timestamp, timestamp, taskId, reviewId, reviewVersion);
      if (invalidated.changes !== 1) {
        throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
      }

      const state = this.database.prepare(`
        SELECT 1
        FROM automation_reviews
        JOIN automation_executions
          ON automation_executions.id = automation_reviews.execution_id
          AND automation_executions.task_id = automation_reviews.task_id
        JOIN tasks
          ON tasks.id = automation_reviews.task_id
        WHERE automation_reviews.task_id = ?
          AND automation_reviews.id = ?
          AND automation_reviews.version = ?
          AND automation_reviews.status = 'stale'
          AND automation_executions.phase = 'awaiting_approval'
          AND tasks.archived_at IS NULL
          AND tasks.status = ${this.#taskStatusSql(taskId, "approval")}
      `).get(taskId, reviewId, reviewVersion);
      if (!state) {
        throw new ApiError(409, "AUTOMATION_REVIEW_STATE_CONFLICT", "The stale automation review is no longer safe to replace");
      }

      const replaced = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'pending', repositories = ?, files = ?, risk_reasons = ?,
            reviewer_id = NULL, reviewer_name = NULL, decision_comment = NULL,
            version = version + 1, decided_at = NULL, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'stale'
      `).run(
        JSON.stringify(snapshot.repositories),
        JSON.stringify(snapshot.files),
        JSON.stringify(snapshot.reasons),
        timestamp,
        taskId,
        reviewId,
        reviewVersion,
      );
      if (replaced.changes !== 1) {
        throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationReview(taskId);
  }

  refreshApprovedAutomationReview(taskId, reviewId, reviewVersion, token, threadId, reason, snapshot) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const state = this.database.prepare(`
        SELECT
          automation_reviews.execution_id,
          automation_reviews.status AS review_status,
          automation_executions.project_id,
          automation_executions.phase,
          automation_executions.token,
          automation_executions.run_owner_thread_id,
          tasks.status AS task_status,
          tasks.archived_at
        FROM automation_reviews
        JOIN automation_executions
          ON automation_executions.id = automation_reviews.execution_id
          AND automation_executions.task_id = automation_reviews.task_id
        JOIN tasks ON tasks.id = automation_reviews.task_id
        WHERE automation_reviews.task_id = ?
          AND automation_reviews.id = ?
          AND automation_reviews.version = ?
      `).get(taskId, reviewId, reviewVersion);
      if (!state || state.review_status !== "approved") {
        throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
      }
      if (state.token !== token) {
        throw new ApiError(403, "AUTOMATION_TOKEN_MISMATCH", "The automation execution token is invalid");
      }
      if (state.run_owner_thread_id !== threadId) {
        throw new ApiError(409, "AUTOMATION_RUN_NOT_OWNER", "This Codex task does not own the automation run");
      }
      if (
        state.phase !== "ready_to_merge"
        || state.task_status !== this.#boundTaskStatus(taskId, "working")
        || state.archived_at !== null
      ) {
        throw new ApiError(409, "AUTOMATION_REVIEW_STATE_CONFLICT", "The approved automation review is no longer safe to refresh");
      }

      const reviewResult = this.database.prepare(`
        UPDATE automation_reviews
        SET status = 'pending', repositories = ?, files = ?, risk_reasons = ?,
            reviewer_id = NULL, reviewer_name = NULL, decision_comment = NULL,
            version = version + 1, decided_at = NULL, updated_at = ?
        WHERE task_id = ? AND id = ? AND version = ? AND status = 'approved'
      `).run(
        JSON.stringify(snapshot.repositories),
        JSON.stringify(snapshot.files),
        JSON.stringify(snapshot.reasons),
        timestamp,
        taskId,
        reviewId,
        reviewVersion,
      );
      if (reviewResult.changes !== 1) {
        throw this.#automationReviewVersionConflict(taskId, reviewId, reviewVersion);
      }

      const executionResult = this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'awaiting_approval',
            run_owner_thread_id = NULL, run_started_at = NULL,
            codex_thread_id = NULL, codex_turn_id = NULL,
            codex_thread_status = NULL, codex_last_error = NULL,
            error_details = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND phase = 'ready_to_merge'
          AND token = ? AND run_owner_thread_id = ?
      `).run(
        JSON.stringify({ reason, source: "automation_review" }),
        timestamp,
        state.execution_id,
        token,
        threadId,
      );
      if (executionResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_STATE_CONFLICT", "The approved automation execution changed before refresh");
      }

      const taskResult = this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "approval")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "approval")} AND archived_at IS NULL
            ),
            thread_id = NULL, status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL AND status = ${this.#taskStatusSql(taskId, "working")}
      `).run(state.project_id, timestamp, timestamp, taskId);
      if (taskResult.changes !== 1) {
        throw new ApiError(409, "AUTOMATION_REVIEW_TASK_CONFLICT", "The task changed before review refresh");
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAutomationReview(taskId);
  }

  getAutomationMergeState(projectId) {
    const row = this.database.prepare(`
      SELECT project_id, execution_id, paused, updated_at
      FROM automation_merge_state WHERE project_id = ?
    `).get(projectId);
    return row ? {
      projectId: row.project_id,
      executionId: row.execution_id,
      paused: row.paused === 1,
      updatedAt: row.updated_at,
    } : null;
  }

  claimTaskForAutomation(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(input.taskId);
      if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${input.taskId}' does not exist`);
      if (current.version !== input.taskVersion || current.status !== input.expectedStatus || current.archived_at !== null) {
        throw new ApiError(409, "TASK_NOT_AVAILABLE", "Task is no longer available for automatic claiming");
      }
      const slotOccupied = this.database.prepare(`
        SELECT 1 FROM automation_executions
        WHERE project_id = ? AND slot_number = ?
          AND phase IN ('working', 'ready_to_merge', 'merging')
          AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ? AND merge_retry_at IS NULL)
      `).get(input.projectId, input.slotNumber, MAX_MERGE_RETRIES);
      if (slotOccupied) throw new ApiError(409, "AUTOMATION_SLOT_OCCUPIED", `Automation slot ${input.slotNumber} is occupied`);

      this.database.prepare(`
        INSERT INTO automation_executions (
          id, project_id, task_id, slot_number, token, phase, workspace_path,
          worktree_root, repositories, error_details, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'working', ?, ?, ?, NULL, 1, ?, ?)
      `).run(
        input.executionId,
        input.projectId,
        input.taskId,
        input.slotNumber,
        input.token,
        input.workspacePath,
        input.worktreeRoot,
        JSON.stringify(input.repositories),
        timestamp,
        timestamp,
      );
      const firstRepository = input.repositories[0];
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(input.taskId, "working")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(input.taskId, "working")} AND archived_at IS NULL
            ),
            worktree_path = ?, worktree_branch = ?, git_branch = NULL,
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ? AND status = ? AND archived_at IS NULL
      `).run(
        input.projectId,
        firstRepository.worktreePath,
        firstRepository.taskBranch,
        timestamp,
        timestamp,
        input.taskId,
        input.taskVersion,
        input.expectedStatus,
      );
      if (result.changes !== 1) throw new ApiError(409, "TASK_NOT_AVAILABLE", "Task is no longer available for automatic claiming");
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const task = this.getTask(input.taskId);
    const comment = this.createComment(task.id, {
      body: [
        `自动认领槽位 ${input.slotNumber} 已创建隔离 Worktree。`,
        ...input.repositories.map((repository) => `- ${repository.name}: ${repository.worktreePath}（${repository.taskBranch} → ${repository.targetBranch}）`),
      ].join("\n"),
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return { task: this.getTask(input.taskId), execution: this.getTaskAutomationExecution(input.taskId), comment };
  }

  reconcilePausedAutomationTaskStatuses(projectId) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#projectStatusSql(projectId, "blocked")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#projectStatusSql(projectId, "blocked")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE project_id = ? AND status = ${this.#projectStatusSql(projectId, "working")} AND archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM automation_executions
            WHERE automation_executions.task_id = tasks.id
              AND automation_executions.project_id = tasks.project_id
              AND automation_executions.phase = 'paused_for_human'
          )
          AND NOT EXISTS (
            SELECT 1 FROM automation_executions
            WHERE automation_executions.task_id = tasks.id
              AND automation_executions.project_id = tasks.project_id
              AND automation_executions.phase IN ('working', 'ready_to_merge', 'merging')
          )
      `).run(projectId, timestamp, timestamp, projectId);
      this.database.exec("COMMIT");
      return result.changes;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  reclaimTaskForAutomation(input) {
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const current = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(input.taskId);
      if (!current) throw new ApiError(404, "TASK_NOT_FOUND", `Task '${input.taskId}' does not exist`);
      if (current.version !== input.taskVersion || current.status !== this.#boundTaskStatus(input.taskId, "ready") || current.archived_at !== null) {
        throw new ApiError(409, "TASK_NOT_AVAILABLE", "Task is no longer available for automatic reclaiming");
      }
      const execution = this.database.prepare(`
        SELECT * FROM automation_executions WHERE id = ? AND task_id = ?
      `).get(input.executionId, input.taskId);
      if (!execution || execution.phase !== "paused_for_human") {
        throw new ApiError(409, "AUTOMATION_NOT_PAUSED", "The previous automation execution is not blocked");
      }
      const slotOccupied = this.database.prepare(`
        SELECT 1 FROM automation_executions
        WHERE project_id = ? AND slot_number = ? AND id <> ?
          AND phase IN ('working', 'ready_to_merge', 'merging')
          AND NOT (phase = 'ready_to_merge' AND merge_retry_count >= ? AND merge_retry_at IS NULL)
      `).get(execution.project_id, input.slotNumber, execution.id, MAX_MERGE_RETRIES);
      if (slotOccupied) throw new ApiError(409, "AUTOMATION_SLOT_OCCUPIED", `Automation slot ${input.slotNumber} is occupied`);

      this.database.prepare(`
        UPDATE automation_executions
        SET slot_number = ?, token = ?, phase = 'working',
            run_owner_thread_id = NULL, run_started_at = NULL,
            merge_retry_count = 0, merge_retry_at = NULL,
            codex_thread_id = NULL, codex_turn_id = NULL,
            codex_thread_status = NULL, codex_last_error = NULL,
            error_details = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(input.slotNumber, input.token, timestamp, execution.id);
      const repositories = JSON.parse(execution.repositories);
      const primaryRepository = repositories[0] ?? null;
      this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(input.taskId, "working")}, thread_id = NULL,
            worktree_path = ?, worktree_branch = ?,
            sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(input.taskId, "working")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        primaryRepository?.worktreePath ?? null,
        primaryRepository?.taskBranch ?? null,
        execution.project_id,
        timestamp,
        timestamp,
        input.taskId,
        input.taskVersion,
      );
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const comment = this.createComment(input.taskId, {
      body: `自动认领已恢复原隔离 Worktree，并重新分配到槽位 ${input.slotNumber}。`,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return { task: this.getTask(input.taskId), execution: this.getTaskAutomationExecution(input.taskId), comment };
  }

  acquireAutomationMerge(taskId, token, threadId) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase === "merging") return execution;
    if (execution.phase !== "working" && execution.phase !== "ready_to_merge") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot acquire merge from phase '${execution.phase}'`);
    }
    this.database.prepare(`
      UPDATE automation_executions
      SET phase = 'merging', merge_retry_at = NULL, error_details = NULL,
          version = version + 1, updated_at = ? WHERE id = ?
    `).run(now(), execution.id);
    return this.getTaskAutomationExecution(taskId);
  }

  scheduleAutomationMergeRetry(taskId, token, threadId) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase !== "working" && execution.phase !== "ready_to_merge") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot schedule a merge retry from phase '${execution.phase}'`);
    }
    const timestamp = now();
    const exhausted = execution.mergeRetryCount >= MAX_MERGE_RETRIES;
    const retryAt = exhausted ? null : new Date(Date.now() + MERGE_RETRY_INTERVAL_MS).toISOString();
    this.database.prepare(`
      UPDATE automation_executions
      SET phase = 'ready_to_merge', merge_retry_count = ?, merge_retry_at = ?,
          error_details = ?, run_owner_thread_id = NULL, run_started_at = NULL,
          version = version + 1, updated_at = ? WHERE id = ?
    `).run(
      exhausted ? execution.mergeRetryCount : execution.mergeRetryCount + 1,
      retryAt,
      exhausted ? JSON.stringify({ code: "MERGE_RETRY_EXHAUSTED", maxRetries: MAX_MERGE_RETRIES }) : null,
      timestamp,
      execution.id,
    );
    return this.getTaskAutomationExecution(taskId);
  }

  updateAutomationExecutionRepositories(taskId, token, repositories) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.database.prepare(`
      UPDATE automation_executions
      SET repositories = ?, version = version + 1, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(repositories), now(), execution.id);
    return this.getTaskAutomationExecution(taskId);
  }

  pauseAutomationMerge(taskId, token, threadId, reason, conflictFiles) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase !== "merging" && execution.phase !== "paused_for_human") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "Only the current task can pause its parallel merge");
    }
    const timestamp = now();
    const error = { reason, conflictFiles };
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'paused_for_human', error_details = ?, run_owner_thread_id = NULL,
            run_started_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(error), timestamp, execution.id);
      this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "blocked")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "blocked")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL
      `).run(execution.projectId, timestamp, timestamp, execution.taskId);
      this.database.exec("COMMIT");
    } catch (caught) {
      this.database.exec("ROLLBACK");
      throw caught;
    }
    this.createComment(taskId, {
      body: `当前 Worktree 在并行合并中仍有无法自动解决的冲突，只有本任务已转入「已阻塞」，其他任务继续合并。\n冲突文件：${conflictFiles.length > 0 ? conflictFiles.join("、") : "未报告"}\n请在本任务 Worktree 中处理后点击“继续合并”。`,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  resumeAutomationMerge(taskId) {
    const execution = this.#requireAutomationExecution(taskId);
    if (execution.phase !== "paused_for_human") {
      throw new ApiError(409, "AUTOMATION_NOT_PAUSED", "This execution is not waiting for human conflict resolution");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'merging', error_details = NULL, run_owner_thread_id = NULL, run_started_at = NULL,
            version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, execution.id);
      this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "working")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "working")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL
      `).run(execution.projectId, timestamp, timestamp, execution.taskId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.createComment(taskId, {
      body: "当前 Worktree 的冲突现场已通过重新校验，本任务继续并行合并。",
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  prepareAutomationRelease(taskId, token, threadId, repositoryResults = []) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase !== "merging") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "The task is not in parallel merge phase");
    }
    const task = this.#requireTask(taskId);
    if (task.delivery.mode !== "release") {
      throw new ApiError(409, "AUTOMATION_RELEASE_UNSUPPORTED", "Only release-delivery tasks can prepare a release");
    }
    const resultsByName = new Map(repositoryResults.map((result) => [result.name, result]));
    const repositories = execution.repositories.map((repository) => ({
      ...repository,
      ...(resultsByName.get(repository.name) ?? {}),
    }));
    if (task.status === this.#boundTaskStatus(taskId, "releaseReady")) return execution;
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET repositories = ?, error_details = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(JSON.stringify(repositories), timestamp, execution.id);
      this.database.prepare(`
        UPDATE tasks
        SET status = ${this.#taskStatusSql(taskId, "releaseReady")}, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ${this.#taskStatusSql(taskId, "releaseReady")} AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL
      `).run(task.projectId, timestamp, timestamp, task.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.createComment(taskId, {
      body: `并行合并和 push 已完成，任务已进入 ${this.#boundTaskStatus(taskId, "releaseReady")}，可执行外部修复状态回写。`,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  reconcileAutomationRelease(taskId, token, threadId, observedStatus) {
    if (observedStatus !== "fixed") {
      throw new ApiError(
        400,
        "EXTERNAL_RELEASE_STATUS_INVALID",
        "observedStatus must be the normalized fixed semantic",
      );
    }
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (
      execution.phase !== "working"
      && execution.phase !== "ready_to_merge"
      && execution.phase !== "merging"
    ) {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", `Cannot reconcile release from phase '${execution.phase}'`);
    }
    const task = this.#requireTask(taskId);
    if (!task.externalIssue) {
      throw new ApiError(409, "EXTERNAL_ISSUE_REQUIRED", "Only externally linked tasks can reconcile source state");
    }
    const targetStatus = this.#boundTaskStatus(taskId, task.delivery.mode === "release" ? "releaseReady" : "review");
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'cleanup_pending', error_details = ?, run_owner_thread_id = NULL,
            run_started_at = NULL, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify({ source: "external_status_reconciliation", observedStatus }),
        timestamp,
        execution.id,
      );
      this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ? AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND archived_at IS NULL
      `).run(targetStatus, task.projectId, targetStatus, timestamp, timestamp, task.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.createComment(taskId, {
      body: `来源平台已确认修复，Loop看板已同步为 ${targetStatus}。`,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  completeAutomationExecution(taskId, token, threadId, repositoryResults = []) {
    const execution = this.#requireAutomationExecution(taskId, token);
    this.#requireAutomationRunOwner(execution, threadId);
    if (execution.phase !== "merging" && execution.phase !== "cleanup_pending") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "The task is not in parallel merge phase");
    }
    if (execution.phase === "cleanup_pending") return execution;
    const resultsByName = new Map(repositoryResults.map((result) => [result.name, result]));
    const repositories = execution.repositories.map((repository) => ({
      ...repository,
      ...(resultsByName.get(repository.name) ?? {}),
    }));
    const task = this.#requireTask(taskId);
    const requiresRelease = task.delivery.mode === "release";
    if (requiresRelease && task.status !== this.#boundTaskStatus(taskId, "releaseReady")) {
      throw new ApiError(
        409,
        "AUTOMATION_RELEASE_NOT_PREPARED",
        "The task must enter the configured releaseReady state before completing release delivery",
      );
    }
    const targetStatus = this.#boundTaskStatus(taskId, requiresRelease ? "releaseReady" : "review");
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'cleanup_pending', repositories = ?, error_details = NULL,
            run_owner_thread_id = NULL, run_started_at = NULL,
            version = version + 1, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(repositories), timestamp, execution.id);
      this.database.prepare(`
        UPDATE tasks
        SET status = ?, sort_order = (
              SELECT COALESCE(MAX(sort_order), 0) + 1000 FROM tasks
              WHERE project_id = ? AND status = ? AND archived_at IS NULL
            ),
            status_changed_at = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(targetStatus, task.projectId, targetStatus, timestamp, timestamp, task.id);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    this.createComment(taskId, {
      body: `当前 Worktree 已完成并行合并并 push，任务已进入 ${targetStatus}；正在清理本地 Worktree。`,
      actor: { type: "agent", id: "codex-agent", name: "Codex Agent", avatarUrl: null },
    });
    return this.getTaskAutomationExecution(taskId);
  }

  markAutomationCleanupPending(taskId, failures) {
    const execution = this.#requireAutomationExecution(taskId);
    this.database.prepare(`
      UPDATE automation_executions SET error_details = ?, version = version + 1, updated_at = ? WHERE id = ?
    `).run(JSON.stringify({ cleanupFailures: failures }), now(), execution.id);
    return this.getTaskAutomationExecution(taskId);
  }

  finishAutomationCleanup(taskId) {
    const execution = this.#requireAutomationExecution(taskId);
    if (execution.phase === "completed") return execution;
    if (execution.phase !== "cleanup_pending") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "Cleanup is not pending for this task");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        UPDATE automation_executions
        SET phase = 'completed', error_details = NULL, version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, execution.id);
      this.database.prepare(`
        UPDATE tasks
        SET worktree_path = NULL, worktree_branch = NULL, version = version + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, execution.taskId);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTaskAutomationExecution(taskId);
  }

  #automationReviewVersionConflict(taskId, expectedReviewId, expectedVersion) {
    const current = this.getAutomationReview(taskId);
    return new ApiError(
      409,
      "AUTOMATION_REVIEW_VERSION_CONFLICT",
      "Automation review was changed by another client",
      {
        expectedReviewId,
        actualReviewId: current?.id ?? null,
        expectedVersion,
        actualVersion: current?.version ?? null,
      },
    );
  }

  #requireAutomationExecution(taskId, token) {
    const execution = this.getTaskAutomationExecution(taskId);
    if (!execution) throw new ApiError(404, "AUTOMATION_EXECUTION_NOT_FOUND", `No automation execution exists for '${taskId}'`);
    if (token !== undefined && execution.token !== token) {
      throw new ApiError(403, "AUTOMATION_TOKEN_MISMATCH", "The automation execution token is invalid");
    }
    return execution;
  }

  #requireAutomationRunOwner(execution, threadId) {
    if (execution.runOwnerThreadId !== threadId) {
      throw new ApiError(409, "AUTOMATION_RUN_NOT_OWNER", "This Codex task does not own the automation run");
    }
  }

  createTask(input) {
    const config = this.getProjectBoardConfig(input.projectId).config;
    input = { ...input, status: input.status ?? config.initialState,
      externalIssue: normalizeExternalIssue(input.externalIssue), externalState: normalizeExternalState(input.externalState),
      delivery: normalizeDelivery(input.delivery) };
    if (!stateDefinition(config, input.status)?.allowCreate || !taskStatusSequence(input, config).includes(input.status)) {
      throw new ApiError(400, "INVALID_STATUS_TRANSITION", "Task cannot be created in this state");
    }
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const project = this.database.prepare(`
        SELECT id, next_task_number FROM projects WHERE id = ?
      `).get(input.projectId);
      if (!project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${input.projectId}' does not exist`);
      }

      const number = project.next_task_number;
      const identifier = `${projectPrefix(project.id)}-${number}`;
      const id = randomUUID();
      const timestamp = now();
      let sortOrder = input.sortOrder;
      if (sortOrder === undefined) {
        const row = this.database.prepare(`
          SELECT COALESCE(MAX(sort_order), 0) AS maximum
          FROM tasks
          WHERE project_id = ? AND status = ? AND archived_at IS NULL
        `).get(input.projectId, input.status);
        sortOrder = row.maximum + 1000;
      }

      this.database.prepare(`
        UPDATE projects SET next_task_number = next_task_number + 1, updated_at = ? WHERE id = ?
      `).run(timestamp, input.projectId);
      this.database.prepare(`
        INSERT INTO tasks (
          id, identifier, project_id, title, description, status, priority, labels,
          external_issue, external_state, external_connection_id, external_scope_id, external_id, delivery,
          sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
          assignee_type, assignee_id, assignee_name, assignee_avatar_url,
          workflow_id, git_branch, worktree_path, worktree_branch,
          due_date, recurrence_interval, recurrence_unit,
          archived_at, version, created_at, status_changed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)
      `).run(
        id,
        identifier,
        input.projectId,
        input.title,
        input.description,
        input.status,
        input.priority,
        JSON.stringify(input.labels),
        input.externalIssue ? JSON.stringify(input.externalIssue) : null,
        input.externalState ? JSON.stringify(input.externalState) : null,
        input.externalIssue?.connectionId ?? null,
        input.externalIssue?.scopeId ?? null,
        input.externalIssue?.externalId ?? null,
        JSON.stringify(input.delivery),
        sortOrder,
        input.threadId ?? null,
        input.actor.type,
        input.actor.id,
        input.actor.name,
        input.actor.avatarUrl,
        input.assignee.type,
        input.assignee.id,
        input.assignee.name,
        input.assignee.avatarUrl,
        input.workflowId,
        input.developmentContext?.type === "branch" ? input.developmentContext.branch : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.path : null,
        input.developmentContext?.type === "worktree" ? input.developmentContext.branch : null,
        input.dueDate,
        input.recurrence?.interval ?? null,
        input.recurrence?.unit ?? null,
        timestamp,
        timestamp,
        timestamp,
      );
      this.database.exec("COMMIT");
      return this.getTask(id);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw taskWriteError(error);
    }
  }

  updateTask(id, version, changes, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const nextStatus = Object.hasOwn(changes, "status")
      ? changes.status
      : current.status;
    this.#assertManualTaskStatus(current, nextStatus);
    const config = this.getProjectBoardConfig(current.projectId).config;
    const externalIssue = Object.hasOwn(changes, "externalIssue") ? normalizeExternalIssue(changes.externalIssue) : current.externalIssue;
    const externalState = Object.hasOwn(changes, "externalState") ? normalizeExternalState(changes.externalState) : current.externalState;
    const delivery = Object.hasOwn(changes, "delivery") ? normalizeDelivery(changes.delivery) : current.delivery;
    if (current.externalIssue && !hasSameExternalBinding(current.externalIssue, externalIssue)) {
      throw new ApiError(400, "EXTERNAL_BINDING_IMMUTABLE", "External issue identity cannot change after binding");
    }
    if (current.externalIssue && JSON.stringify(current.delivery) !== JSON.stringify(delivery)) {
      throw new ApiError(400, "DELIVERY_IMMUTABLE", "Imported task delivery snapshot cannot change");
    }
    if (!canMoveTask(config, { ...current, delivery }, nextStatus)) {
      throw new ApiError(400, "INVALID_STATUS_TRANSITION", "This state transition is not allowed by the board configuration");
    }
    const dueDate = Object.hasOwn(changes, "dueDate") ? changes.dueDate : current.dueDate;
    const recurrence = Object.hasOwn(changes, "recurrence") ? changes.recurrence : current.recurrence;
    if (recurrence && !dueDate) {
      throw new ApiError(400, "INVALID_FIELD", "A recurring issue requires a due date");
    }

    const columns = {
      title: "title",
      description: "description",
      status: "status",
      priority: "priority",
      labels: "labels",
      workflowId: "workflow_id",
      dueDate: "due_date",
      estimatedHandlingHours: "estimated_handling_hours",
    };
    const assignments = [];
    const values = [];
    const timestamp = now();
    for (const [key, value] of Object.entries(changes)) {
      if (key === "externalState") {
        assignments.push("external_state = ?");
        values.push(externalState ? JSON.stringify(externalState) : null);
        continue;
      }
      if (key === "externalIssue") {
        assignments.push("external_issue = ?", "external_connection_id = ?", "external_scope_id = ?", "external_id = ?");
        values.push(externalIssue ? JSON.stringify(externalIssue) : null, externalIssue?.connectionId ?? null,
          externalIssue?.scopeId ?? null, externalIssue?.externalId ?? null);
        continue;
      }
      if (key === "delivery") {
        assignments.push("delivery = ?");
        values.push(JSON.stringify(delivery));
        continue;
      }
      if (key === "developmentContext") {
        assignments.push("git_branch = ?", "worktree_path = ?", "worktree_branch = ?");
        values.push(
          value?.type === "branch" ? value.branch : null,
          value?.type === "worktree" ? value.path : null,
          value?.type === "worktree" ? value.branch : null,
        );
        continue;
      }
      if (key === "recurrence") {
        assignments.push("recurrence_interval = ?", "recurrence_unit = ?");
        values.push(value?.interval ?? null, value?.unit ?? null);
        continue;
      }
      if (key === "assignee") {
        assignments.push(
          "assignee_type = ?",
          "assignee_id = ?",
          "assignee_name = ?",
          "assignee_avatar_url = ?",
        );
        values.push(value.type, value.id, value.name, value.avatarUrl);
        continue;
      }
      assignments.push(`${columns[key]} = ?`);
      values.push(key === "labels" ? JSON.stringify(value) : value);
    }
    if (nextStatus !== current.status) {
      assignments.push("status_changed_at = ?");
      values.push(timestamp);
    }
    if (threadId !== undefined) {
      assignments.push("thread_id = ?");
      values.push(threadId);
    }
    assignments.push("version = version + 1", "updated_at = ?");
    values.push(timestamp, current.id, version);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks SET ${assignments.join(", ")} WHERE id = ? AND version = ?
      `).run(...values);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw taskWriteError(error);
    }
    return this.getTask(current.id);
  }

  moveTask(id, version, status, sortOrder, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt !== null) {
      throw new ApiError(409, "TASK_ARCHIVED", "Archived tasks cannot be moved");
    }
    this.#assertManualTaskStatus(current, status);
    if (!canMoveTask(this.getProjectBoardConfig(current.projectId).config, current, status)) {
      throw new ApiError(400, "INVALID_STATUS_TRANSITION", "This state transition is not allowed by the board configuration");
    }
    if (sortOrder === undefined) {
      const row = this.database.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM tasks
        WHERE project_id = ? AND status = ? AND archived_at IS NULL AND id != ?
      `).get(current.projectId, status, current.id);
      sortOrder = row.maximum + 1000;
    }

    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET
          status = ?,
          sort_order = ?,
          thread_id = COALESCE(?, thread_id),
          status_changed_at = CASE WHEN status <> ? THEN ? ELSE status_changed_at END,
          version = version + 1,
          updated_at = ?
        WHERE id = ? AND version = ?
      `).run(
        status,
        sortOrder,
        threadId ?? null,
        status,
        timestamp,
        timestamp,
        current.id,
        version,
      );
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  archiveTask(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(timestamp, threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  restoreTask(id, version, threadId) {
    const current = this.#requireTask(id);
    this.#requireVersion(current, version);
    if (current.archivedAt === null) {
      throw new ApiError(409, "TASK_NOT_ARCHIVED", "Only archived tasks can be restored");
    }
    const timestamp = now();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = this.database.prepare(`
        UPDATE tasks
        SET archived_at = NULL, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `).run(threadId ?? null, timestamp, current.id, version);
      if (result.changes !== 1) {
        this.#throwMissingOrConflict(id, version);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getTask(current.id);
  }

  addTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);

      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      if (relationType === "parent") {
        this.#assertNoParentCycle(task.id, relatedTask.id);
        const existing = this.database.prepare(`
          SELECT source_task_id
          FROM task_relations
          WHERE relation_type = 'parent' AND target_task_id = ?
        `).get(task.id);
        if (existing?.source_task_id === relatedTask.id) {
          throw new ApiError(409, "RELATION_EXISTS", "This parent relation already exists");
        }
        if (existing) {
          this.database.prepare(`
            DELETE FROM task_relations
            WHERE relation_type = 'parent' AND target_task_id = ?
          `).run(task.id);
        }
      } else {
        const existing = this.database.prepare(`
          SELECT 1
          FROM task_relations
          WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
        `).get(relationType, sourceTaskId, targetTaskId);
        if (existing) {
          throw new ApiError(409, "RELATION_EXISTS", "This issue relation already exists");
        }
      }

      this.database.prepare(`
        INSERT INTO task_relations (
          relation_type, source_task_id, target_task_id, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(relationType, sourceTaskId, targetTaskId, now());
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  removeTaskRelation(id, version, type, relatedId, threadId) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const task = this.#requireTask(id);
      const relatedTask = this.#requireTask(relatedId);
      this.#requireVersion(task, version);
      this.#validateRelationTasks(task, relatedTask);
      const { relationType, sourceTaskId, targetTaskId } = this.#relationEndpoints(
        type,
        task.id,
        relatedTask.id,
      );
      const removed = this.database.prepare(`
        DELETE FROM task_relations
        WHERE relation_type = ? AND source_task_id = ? AND target_task_id = ?
      `).run(relationType, sourceTaskId, targetTaskId);
      if (removed.changes !== 1) {
        throw new ApiError(404, "RELATION_NOT_FOUND", "This issue relation does not exist");
      }
      this.#touchTask(task.id, version, threadId);
      this.database.exec("COMMIT");
      return {
        task: this.getTask(task.id),
        relatedTask: this.getTask(relatedTask.id),
      };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  listComments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM comments
      WHERE task_id = ?
      ORDER BY created_at, id
    `).all(task.id).map((row) => this.#commentWithAttachments(row));
  }

  createComment(taskId, input) {
    const task = this.#requireTask(taskId);
    const id = randomUUID();
    const timestamp = now();
    this.database.prepare(`
      INSERT INTO comments (
        id, task_id, body, thread_id, author_type, author_id, author_name, author_avatar_url,
        version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      task.id,
      input.body,
      input.threadId ?? null,
      input.actor.type,
      input.actor.id,
      input.actor.name,
      input.actor.avatarUrl,
      timestamp,
      timestamp,
    );
    return this.getComment(id);
  }

  getComment(id) {
    const row = this.database.prepare("SELECT * FROM comments WHERE id = ?").get(id);
    return row ? this.#commentWithAttachments(row) : null;
  }

  updateComment(id, version, body, threadId) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      UPDATE comments
      SET body = ?, thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(body, threadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return this.getComment(id);
  }

  deleteComment(id, version) {
    const current = this.#requireComment(id);
    this.#requireCommentVersion(current, version);
    const result = this.database.prepare(`
      DELETE FROM comments WHERE id = ? AND version = ?
    `).run(id, version);
    if (result.changes !== 1) {
      this.#throwMissingCommentOrConflict(id, version);
    }
    return current;
  }

  listAttachments(taskId) {
    const task = this.#requireTask(taskId);
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE task_id = ? AND comment_id IS NULL
      ORDER BY created_at, id
    `).all(task.id).map(attachmentFromRow);
  }

  createAttachment(taskId, input) {
    const task = this.#requireTask(taskId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, NULL, ?, ?, ?, ?)
    `).run(input.id, task.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  listCommentAttachments(commentId) {
    const comment = this.database.prepare("SELECT id FROM comments WHERE id = ?").get(commentId);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${commentId}' does not exist`);
    }
    return this.#attachmentsForComment(commentId);
  }

  createCommentAttachment(commentId, input) {
    const comment = this.#requireComment(commentId);
    this.database.prepare(`
      INSERT INTO attachments (id, task_id, comment_id, filename, content_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.id, comment.taskId, comment.id, input.filename, input.contentType, input.size, now());
    return this.getAttachment(input.id);
  }

  getAttachment(id) {
    const row = this.database.prepare("SELECT * FROM attachments WHERE id = ?").get(id);
    return row ? attachmentFromRow(row) : null;
  }

  deleteAttachment(id) {
    const attachment = this.getAttachment(id);
    if (!attachment) {
      throw new ApiError(404, "ATTACHMENT_NOT_FOUND", `Attachment '${id}' does not exist`);
    }
    this.database.prepare("DELETE FROM attachments WHERE id = ?").run(id);
    return attachment;
  }

  #commentWithAttachments(row) {
    const comment = commentFromRow(row);
    comment.attachments = this.#attachmentsForComment(comment.id);
    return comment;
  }

  #aiChatThreadWithCurrentRun(row) {
    const thread = aiChatThreadFromRow(row);
    const currentRun = this.database.prepare(`
      SELECT * FROM ai_chat_runs
      WHERE thread_id = ? AND status = 'running'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get(thread.id);
    thread.currentRun = currentRun ? aiChatRunFromRow(currentRun) : null;
    return thread;
  }

  #attachmentsForComment(commentId) {
    return this.database.prepare(`
      SELECT * FROM attachments
      WHERE comment_id = ?
      ORDER BY created_at, id
    `).all(commentId).map(attachmentFromRow);
  }

  #taskWithRelations(row) {
    const task = taskFromRow(row);
    const parent = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.target_task_id = ?
    `).get(task.id);
    const subIssues = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'parent'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blockedBy = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.source_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.target_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const blocks = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = task_relations.target_task_id
      WHERE task_relations.relation_type = 'blocks'
        AND task_relations.source_task_id = ?
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id);
    const related = this.database.prepare(`
      SELECT tasks.*
      FROM task_relations
      JOIN tasks ON tasks.id = CASE
        WHEN task_relations.source_task_id = ? THEN task_relations.target_task_id
        ELSE task_relations.source_task_id
      END
      WHERE task_relations.relation_type = 'related'
        AND (
          task_relations.source_task_id = ?
          OR task_relations.target_task_id = ?
        )
      ORDER BY tasks.sort_order, tasks.created_at, tasks.id
    `).all(task.id, task.id, task.id);
    task.relations = {
      parent: parent ? taskRelationSummaryFromRow(parent) : null,
      subIssues: subIssues.map(taskRelationSummaryFromRow),
      blockedBy: blockedBy.map(taskRelationSummaryFromRow),
      blocks: blocks.map(taskRelationSummaryFromRow),
      related: related.map(taskRelationSummaryFromRow),
    };
    const automationExecution = this.database.prepare(`
      SELECT * FROM automation_executions
      WHERE task_id = ?
      ORDER BY
        CASE WHEN phase IN (
          'working', 'awaiting_approval', 'approval_granted',
          'ready_to_merge', 'merging', 'paused_for_human', 'cleanup_pending'
        )
          THEN 0 ELSE 1 END,
        created_at DESC,
        id DESC
      LIMIT 1
    `).get(task.id);
    task.automationExecution = automationExecutionFromRow(automationExecution);
    const automationReview = automationReviewCardSummaryFromRow(this.database.prepare(`
        SELECT id, status, files, risk_reasons, version
        FROM automation_reviews
        WHERE task_id = ?
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      `).get(task.id));
    if (automationReview) task.automationReview = automationReview;
    return task;
  }

  #validateRelationTasks(task, relatedTask) {
    if (task.id === relatedTask.id) {
      throw new ApiError(400, "SELF_RELATION", "An issue cannot be related to itself");
    }
    if (task.projectId !== relatedTask.projectId) {
      throw new ApiError(400, "CROSS_PROJECT_RELATION", "Issue relations must stay within one project");
    }
  }

  #relationEndpoints(type, taskId, relatedTaskId) {
    if (type === "parent") {
      return {
        relationType: "parent",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    if (type === "blocks") {
      return {
        relationType: "blocks",
        sourceTaskId: taskId,
        targetTaskId: relatedTaskId,
      };
    }
    if (type === "blocked_by") {
      return {
        relationType: "blocks",
        sourceTaskId: relatedTaskId,
        targetTaskId: taskId,
      };
    }
    const [sourceTaskId, targetTaskId] = [taskId, relatedTaskId].sort();
    return { relationType: "related", sourceTaskId, targetTaskId };
  }

  #assertNoParentCycle(childId, parentId) {
    const cycle = this.database.prepare(`
      WITH RECURSIVE ancestors(id) AS (
        SELECT source_task_id
        FROM task_relations
        WHERE relation_type = 'parent' AND target_task_id = ?
        UNION
        SELECT task_relations.source_task_id
        FROM task_relations
        JOIN ancestors ON task_relations.target_task_id = ancestors.id
        WHERE task_relations.relation_type = 'parent'
      )
      SELECT 1 FROM ancestors WHERE id = ?
    `).get(parentId, childId);
    if (cycle) {
      throw new ApiError(409, "RELATION_CYCLE", "This parent would create a cycle");
    }
  }

  #touchTask(id, version, threadId) {
    const result = this.database.prepare(`
      UPDATE tasks
      SET thread_id = COALESCE(?, thread_id), version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?
    `).run(threadId ?? null, now(), id, version);
    if (result.changes !== 1) {
      this.#throwMissingOrConflict(id, version);
    }
  }

  #requireTask(id) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    return task;
  }

  #requireComment(id) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    return comment;
  }

  #requireVersion(task, expectedVersion) {
    if (task.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
        expectedVersion,
        actualVersion: task.version,
      });
    }
  }

  #requireCommentVersion(comment, expectedVersion) {
    if (comment.version !== expectedVersion) {
      throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
        expectedVersion,
        actualVersion: comment.version,
      });
    }
  }

  #throwMissingOrConflict(id, expectedVersion) {
    const task = this.getTask(id);
    if (!task) {
      throw new ApiError(404, "TASK_NOT_FOUND", `Task '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Task was changed by another client", {
      expectedVersion,
      actualVersion: task.version,
    });
  }

  #throwMissingCommentOrConflict(id, expectedVersion) {
    const comment = this.getComment(id);
    if (!comment) {
      throw new ApiError(404, "COMMENT_NOT_FOUND", `Comment '${id}' does not exist`);
    }
    throw new ApiError(409, "VERSION_CONFLICT", "Comment was changed by another client", {
      expectedVersion,
      actualVersion: comment.version,
    });
  }
}
