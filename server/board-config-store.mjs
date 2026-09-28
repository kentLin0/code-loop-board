import { DEFAULT_BOARD_CONFIG, normalizeBoardConfig, boardStateIds } from "../shared/board-config.mjs";

export function migrateBoardStorage(database) {
  const schema = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'tasks'").get().sql;
  const statusCheck = /status TEXT NOT NULL CHECK\s*\(status IN\s*\([\s\S]*?\)\)/i;
  if (statusCheck.test(schema)) {
    const indexes = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'tasks' AND sql IS NOT NULL").all();
    const columns = database.prepare("PRAGMA table_info(tasks)").all().map(({ name }) => `"${name}"`).join(", ");
    database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
    try {
      database.exec(schema.replace(/CREATE TABLE\s+"?tasks"?/i, "CREATE TABLE tasks_board_migration").replace(statusCheck, "status TEXT NOT NULL"));
      database.exec(`INSERT INTO tasks_board_migration (${columns}) SELECT ${columns} FROM tasks;
        DROP TABLE tasks; ALTER TABLE tasks_board_migration RENAME TO tasks;`);
      for (const index of indexes) database.exec(index.sql);
      const violation = database.prepare("PRAGMA foreign_key_check").get();
      if (violation) throw new Error(`Board migration foreign key violation: ${violation.table}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    } finally {
      database.exec("PRAGMA foreign_keys = ON");
    }
  }
  database.exec(`CREATE TABLE IF NOT EXISTS project_board_configs (
    project_id TEXT PRIMARY KEY REFERENCES projects(id),
    version INTEGER NOT NULL, config TEXT NOT NULL, updated_at TEXT NOT NULL
  )`);
  const columns = new Set(database.prepare("PRAGMA table_info(tasks)").all().map(({ name }) => name));
  for (const [name, definition] of [
    ["external_issue", "TEXT"], ["external_state", "TEXT"], ["external_connection_id", "TEXT"],
    ["external_scope_id", "TEXT"], ["external_id", "TEXT"],
    ["delivery", "TEXT NOT NULL DEFAULT '{\"mode\":\"review\",\"repositories\":[]}'"],
  ]) {
    if (!columns.has(name)) database.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
  }
  database.exec(`CREATE UNIQUE INDEX IF NOT EXISTS tasks_external_identity
    ON tasks(project_id, external_connection_id, external_scope_id, external_id)
    WHERE external_id IS NOT NULL`);
}

export function getBoardConfig(database, projectId) {
  const row = database.prepare("SELECT version, config FROM project_board_configs WHERE project_id = ?").get(projectId);
  return row ? { version: row.version, config: JSON.parse(row.config) }
    : { version: 0, config: structuredClone(DEFAULT_BOARD_CONFIG) };
}

export function saveBoardConfig(database, projectId, input, ApiError) {
  if (!Number.isSafeInteger(input.version) || input.version < 0) {
    throw new ApiError(400, "INVALID_FIELD", "version must be a nonnegative safe integer");
  }
  if (input.statusMapping !== undefined && (
    input.statusMapping === null || typeof input.statusMapping !== "object"
    || ![Object.prototype, null].includes(Object.getPrototypeOf(input.statusMapping))
  )) {
    throw new ApiError(400, "INVALID_FIELD", "statusMapping must be an object mapping state IDs");
  }
  const config = normalizeBoardConfig(input.config);
  database.exec("BEGIN IMMEDIATE");
  try {
    if (!database.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId)) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    }
    const current = getBoardConfig(database, projectId);
    if (input.version !== current.version) throw new ApiError(409, "VERSION_CONFLICT", "Board configuration changed", { actualVersion: current.version });
    const previousIds = boardStateIds(current.config);
    const nextIds = boardStateIds(config);
    const mappings = input.statusMapping ?? {};
    if (Object.entries(mappings).some(([from, to]) => !previousIds.includes(from) || !nextIds.includes(to))) {
      throw new ApiError(400, "INVALID_FIELD", "statusMapping must map current state IDs to configured target state IDs");
    }
    const structuralChange = JSON.stringify([...previousIds].sort()) !== JSON.stringify([...nextIds].sort())
      || JSON.stringify(current.config.automation) !== JSON.stringify(config.automation)
      || Object.entries(mappings).some(([from, to]) => from !== to);
    if (structuralChange && database.prepare(`SELECT 1 FROM automation_executions
      WHERE project_id = ? AND phase NOT IN ('completed', 'canceled') LIMIT 1`).get(projectId)) {
      throw new ApiError(409, "BOARD_AUTOMATION_ACTIVE", "Finish active automation before changing state IDs or bindings");
    }
    const statuses = database.prepare("SELECT DISTINCT status FROM tasks WHERE project_id = ?").all(projectId);
    const targets = new Map();
    for (const { status } of statuses) {
      const target = mappings[status] ?? status;
      if (!nextIds.includes(target)) throw new ApiError(400, "BOARD_STATUS_MAPPING_REQUIRED", `Map task state '${status}' to a configured state`);
      if (target !== status) targets.set(status, target);
    }
    const timestamp = new Date().toISOString();
    if (targets.size) {
      const cases = [...targets].map(() => "WHEN ? THEN ?").join(" ");
      database.prepare(`UPDATE tasks SET status = CASE status ${cases} ELSE status END,
        status_changed_at = ?, updated_at = ?, version = version + 1
        WHERE project_id = ? AND status IN (${[...targets].map(() => "?").join(",")})`)
        .run(...[...targets].flat(), timestamp, timestamp, projectId, ...targets.keys());
    }
    database.prepare(`INSERT INTO project_board_configs(project_id, version, config, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT(project_id) DO UPDATE SET
      version = excluded.version, config = excluded.config, updated_at = excluded.updated_at`)
      .run(projectId, current.version + 1, JSON.stringify(config), timestamp);
    database.exec("COMMIT");
    return { version: current.version + 1, config };
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
