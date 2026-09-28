const ISSUE_QUERY_PARAM = "issue";
const ISSUE_PANEL_QUERY_PARAM = "panel";

export type IssuePanel = "details" | "review";

export function readIssueIdentifier(search: string): string | null {
  const identifier = new URLSearchParams(search).get(ISSUE_QUERY_PARAM)?.trim().toUpperCase();
  return identifier || null;
}

export function readIssuePanel(search: string): IssuePanel {
  return new URLSearchParams(search).get(ISSUE_PANEL_QUERY_PARAM) === "review"
    ? "review"
    : "details";
}

export function buildIssueUrl(
  href: string,
  projectId: string | null,
  issueIdentifier: string | null,
  panel: IssuePanel = "details",
): URL {
  const url = new URL(href);

  if (projectId) url.searchParams.set("project", projectId);
  else url.searchParams.delete("project");

  if (issueIdentifier) {
    url.searchParams.set(ISSUE_QUERY_PARAM, issueIdentifier.trim().toUpperCase());
    if (panel === "review") url.searchParams.set(ISSUE_PANEL_QUERY_PARAM, panel);
    else url.searchParams.delete(ISSUE_PANEL_QUERY_PARAM);
  } else {
    url.searchParams.delete(ISSUE_QUERY_PARAM);
    url.searchParams.delete(ISSUE_PANEL_QUERY_PARAM);
  }

  return url;
}
