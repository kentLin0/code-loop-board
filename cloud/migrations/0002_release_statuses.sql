PRAGMA defer_foreign_keys = true;

CREATE TABLE release_migration_comments AS SELECT * FROM comments;
CREATE TABLE release_migration_attachments AS SELECT * FROM attachments;
CREATE TABLE release_migration_relations AS SELECT * FROM task_relations;

CREATE TABLE tasks_release_migration (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN (
    'backlog', 'todo', 'in_progress', 'pending_release', 'releasing',
    'in_review', 'blocked', 'done', 'canceled'
  )),
  priority TEXT NOT NULL CHECK (priority IN ('none', 'urgent', 'high', 'medium', 'low')),
  labels TEXT NOT NULL DEFAULT '[]',
  sort_order REAL NOT NULL,
  thread_id TEXT,
  creator_type TEXT NOT NULL CHECK (creator_type IN ('user', 'agent')),
  creator_id TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  creator_avatar_url TEXT,
  assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'agent')),
  assignee_id TEXT NOT NULL,
  assignee_name TEXT NOT NULL,
  assignee_avatar_url TEXT,
  workflow_id TEXT,
  development_context_type TEXT CHECK (
    development_context_type IS NULL
    OR development_context_type IN ('branch', 'worktree')
  ),
  development_branch TEXT,
  due_date TEXT,
  recurrence_interval INTEGER,
  recurrence_unit TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO tasks_release_migration (
  id, identifier, project_id, title, description, status, priority, labels,
  sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
  assignee_type, assignee_id, assignee_name, assignee_avatar_url,
  workflow_id, development_context_type, development_branch,
  due_date, recurrence_interval, recurrence_unit,
  archived_at, version, created_at, status_changed_at, updated_at
)
SELECT
  id, identifier, project_id, title, description, status, priority, labels,
  sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
  assignee_type, assignee_id, assignee_name, assignee_avatar_url,
  workflow_id, development_context_type, development_branch,
  due_date, recurrence_interval, recurrence_unit,
  archived_at, version, created_at, updated_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_release_migration RENAME TO tasks;

INSERT INTO comments SELECT * FROM release_migration_comments;
INSERT INTO attachments SELECT * FROM release_migration_attachments;
INSERT INTO task_relations SELECT * FROM release_migration_relations;
DROP TABLE release_migration_comments;
DROP TABLE release_migration_attachments;
DROP TABLE release_migration_relations;

CREATE INDEX tasks_project_status_sort
  ON tasks(project_id, archived_at, status, sort_order, created_at);

CREATE TRIGGER tasks_revision_insert
AFTER INSERT ON tasks
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER tasks_revision_update
AFTER UPDATE ON tasks
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER tasks_revision_delete
AFTER DELETE ON tasks
BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

PRAGMA defer_foreign_keys = false;

