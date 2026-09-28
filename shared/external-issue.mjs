export class ExternalIssueError extends Error {
  constructor(message) {
    super(message);
    this.name = "ExternalIssueError";
    this.code = "INVALID_EXTERNAL_ISSUE";
    this.status = 400;
  }
}

function text(value, field) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\u0000-\u001f]/.test(value)) {
    throw new ExternalIssueError(`${field} must be non-empty text`);
  }
  return value.trim();
}

export function normalizeExternalIssue(input) {
  if (input == null) return null;
  if (typeof input !== "object" || Array.isArray(input)) throw new ExternalIssueError("externalIssue must be an object");
  const result = Object.fromEntries(["connectionId", "scopeId", "externalId", "key", "url"].map((key) => [key, text(input[key], key)]));
  let url;
  try { url = new URL(result.url); } catch { throw new ExternalIssueError("Invalid external issue URL"); }
  if (!["http:", "https:"].includes(url.protocol)) throw new ExternalIssueError("External issue URL must use HTTP(S)");
  return { ...result, url: url.href };
}

export function normalizeDelivery(input) {
  if (input == null) return { mode: "review", repositories: [] };
  if (!["review", "release"].includes(input.mode) || !Array.isArray(input.repositories)) {
    throw new ExternalIssueError("delivery requires mode and repositories");
  }
  const repositories = input.repositories.map((repository) => ({
    repositoryId: text(repository?.repositoryId, "repositoryId"),
    targetBranch: text(repository?.targetBranch, "targetBranch"),
  }));
  if (new Set(repositories.map((repository) => repository.repositoryId)).size !== repositories.length) {
    throw new ExternalIssueError("Delivery repository IDs must be unique");
  }
  if (input.mode === "release" && !repositories.length) throw new ExternalIssueError("Release delivery requires a repository");
  return { mode: input.mode, repositories };
}

export function hasSameExternalBinding(current, next) {
  if (!current) return true;
  return Boolean(next && ["connectionId", "scopeId", "externalId"].every((key) => current[key] === next[key]));
}

export function normalizeExternalState(input) {
  if (input == null) return null;
  const semantics = ["new", "reopened", "working", "fixed", "verifying", "closed", "unmapped"];
  if (!semantics.includes(input.semantic)) throw new ExternalIssueError("Invalid external state semantic");
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (typeof observedAt !== "string" || !Number.isFinite(Date.parse(observedAt))) throw new ExternalIssueError("Invalid state observation time");
  return {
    id: input.id == null ? null : text(input.id, "state.id"),
    label: text(input.label, "state.label"),
    semantic: input.semantic,
    observedAt,
  };
}
