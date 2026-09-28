PRAGMA defer_foreign_keys = true;

ALTER TABLE projects ADD COLUMN board_config TEXT;
ALTER TABLE projects ADD COLUMN board_config_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE board_migration_comments AS SELECT * FROM comments;
CREATE TABLE board_migration_attachments AS SELECT * FROM attachments;
CREATE TABLE board_migration_relations AS SELECT * FROM task_relations;

CREATE TABLE tasks_configurable_board (
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
  creator_type TEXT NOT NULL CHECK (creator_type IN ('user', 'agent')),
  creator_id TEXT NOT NULL,
  creator_name TEXT NOT NULL,
  creator_avatar_url TEXT,
  assignee_type TEXT NOT NULL CHECK (assignee_type IN ('user', 'agent')),
  assignee_id TEXT NOT NULL,
  assignee_name TEXT NOT NULL,
  assignee_avatar_url TEXT,
  workflow_id TEXT,
  development_context_type TEXT CHECK (development_context_type IS NULL OR development_context_type IN ('branch', 'worktree')),
  development_branch TEXT,
  due_date TEXT,
  recurrence_interval INTEGER,
  recurrence_unit TEXT,
  archived_at TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at TEXT NOT NULL,
  status_changed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  external_issue TEXT,
  external_state TEXT,
  delivery TEXT,
  external_connection_id TEXT,
  external_scope_id TEXT,
  external_id TEXT
);

INSERT INTO tasks_configurable_board (
  id, identifier, project_id, title, description, status, priority, labels,
  sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
  assignee_type, assignee_id, assignee_name, assignee_avatar_url,
  workflow_id, development_context_type, development_branch,
  due_date, recurrence_interval, recurrence_unit,
  archived_at, version, created_at, status_changed_at, updated_at
)
SELECT id, identifier, project_id, title, description, status, priority, labels,
  sort_order, thread_id, creator_type, creator_id, creator_name, creator_avatar_url,
  assignee_type, assignee_id, assignee_name, assignee_avatar_url,
  workflow_id, development_context_type, development_branch,
  due_date, recurrence_interval, recurrence_unit,
  archived_at, version, created_at, status_changed_at, updated_at
FROM tasks;

DROP TABLE tasks;
ALTER TABLE tasks_configurable_board RENAME TO tasks;

INSERT INTO comments SELECT * FROM board_migration_comments;
INSERT INTO attachments SELECT * FROM board_migration_attachments;
INSERT INTO task_relations SELECT * FROM board_migration_relations;
DROP TABLE board_migration_comments;
DROP TABLE board_migration_attachments;
DROP TABLE board_migration_relations;

CREATE INDEX tasks_project_status_sort ON tasks(project_id, archived_at, status, sort_order, created_at);
CREATE UNIQUE INDEX tasks_external_identity ON tasks(project_id, external_connection_id, external_scope_id, external_id)
  WHERE external_id IS NOT NULL;

CREATE TRIGGER tasks_revision_insert AFTER INSERT ON tasks BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER tasks_revision_update AFTER UPDATE ON tasks BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;
CREATE TRIGGER tasks_revision_delete AFTER DELETE ON tasks BEGIN
  UPDATE global_revision SET revision = revision + 1 WHERE singleton = 1;
END;

CREATE TRIGGER projects_board_states BEFORE UPDATE OF board_config ON projects
WHEN NEW.board_config IS NOT NULL BEGIN
  SELECT RAISE(ABORT, 'BOARD_STATUS_IN_USE') WHERE EXISTS (
    SELECT 1 FROM tasks WHERE project_id = NEW.id AND status NOT IN (
      SELECT json_extract(value, '$.id') FROM json_each(NEW.board_config, '$.states')
    )
  );
END;

PRAGMA defer_foreign_keys = false;
