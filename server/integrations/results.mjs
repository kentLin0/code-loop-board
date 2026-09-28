import { normalizeExternalIssue } from "../../shared/external-issue.mjs";
import { IntegrationError, requireText } from "./registry.mjs";

const SEMANTICS = new Set(["new", "reopened", "working", "fixed", "verifying", "closed", "unmapped"]);

export function sameIdentity(first, second) {
  return ["connectionId", "scopeId", "externalId"].every((key) => first[key] === second[key]);
}

export function normalizeState(input) {
  if (!input || !SEMANTICS.has(input.semantic)) throw new IntegrationError("INTEGRATION_STATE_INVALID");
  return {
    id: requireText(input.id, "state.id"), label: requireText(input.label, "state.label"),
    semantic: input.semantic, observedAt: new Date().toISOString(),
  };
}

export function normalizeIssue(input, connectionId, scopeId) {
  const externalIssue = normalizeExternalIssue(input?.externalIssue);
  if (!externalIssue || externalIssue.connectionId !== connectionId || externalIssue.scopeId !== scopeId) {
    throw new IntegrationError("INTEGRATION_ISSUE_IDENTITY_MISMATCH");
  }
  const result = {
    externalIssue, title: requireText(input.title, "issue.title"), state: normalizeState(input.state),
    description: typeof input.description === "string" ? input.description : "",
    comments: [],
  };
  for (const comment of input.comments ?? []) {
    result.comments.push({ id: requireText(comment.id, "comment.id"), body: requireText(comment.body, "comment.body") });
  }
  return result;
}

export function normalizeActionResult(input, issue, action) {
  if (input?.ok !== true || input.verified !== true) {
    throw new IntegrationError("INTEGRATION_ACTION_UNVERIFIED", "Read the external issue before retrying an unverified action", 409);
  }
  const identity = normalizeExternalIssue(input.issue);
  if (!identity || !sameIdentity(issue, identity) || input.action !== action || typeof input.changed !== "boolean") {
    throw new IntegrationError("INTEGRATION_ACTION_RESULT_INVALID");
  }
  return { ok: true, action, issue: identity, changed: input.changed, verified: true, state: normalizeState(input.state), ...(typeof input.title === "string" ? { title: input.title } : {}) };
}
