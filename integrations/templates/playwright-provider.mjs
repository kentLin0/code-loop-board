import { chromium } from "playwright-core";
import path from "node:path";
import { mkdir, access } from "node:fs/promises";

function unsupported(operation) {
  const error = new Error(`Implement and verify ${operation} against the target platform first`);
  error.code = "INTEGRATION_CAPABILITY_UNSUPPORTED";
  throw error;
}

export function describe() {
  return {
    name: "Unconfigured Playwright adapter",
    operations: [],
    actions: [],
    notes: ["Template only. No external platform has been connected or verified."],
  };
}

// Copy this module into integrations/<provider-id>/provider.mjs before adapting.
// Keep authentication and page/API details in that package, not in task core.
export async function withAuthenticatedPage({ connection, runtime }, operate) {
  const storageStatePath = path.join(runtime.sessionRoot, "storage-state.json");
  await access(storageStatePath);
  const browser = await chromium.launch({
    executablePath: runtime.resolveLocalPath(connection.options.chromeExecutable),
    headless: true,
  });
  try {
    const context = await browser.newContext({ storageState: storageStatePath });
    try {
      const page = await context.newPage();
      const result = await operate({ page, request: context.request });
      await mkdir(runtime.sessionRoot, { recursive: true });
      await context.storageState({ path: storageStatePath });
      return result;
    } finally { await context.close(); }
  } finally { await browser.close(); }
}

export async function listIssues() { return unsupported("listIssues"); }
export async function getIssue() { return unsupported("getIssue"); }
export async function applyAction() { return unsupported("applyAction"); }
