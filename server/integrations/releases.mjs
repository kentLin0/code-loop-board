import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { IntegrationError, requireText } from "./registry.mjs";

// Release providers are independent of issue providers and have no built-in CI.
export function createReleaseService({ configPath }) {
  async function invoke(connectionId, operation, input) {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const connection = config.releaseConnections?.find((item) => item.id === connectionId);
    const registration = config.releaseProviders?.find((item) => item.id === connection?.providerId);
    if (!connection || !registration) throw new IntegrationError("RELEASE_CONNECTION_NOT_CONFIGURED");
    const root = path.dirname(path.resolve(configPath));
    const modulePath = await realpath(path.resolve(root, requireText(registration.module, "releaseProvider.module")));
    const provider = await import(pathToFileURL(modulePath).href);
    if (typeof provider[operation] !== "function") throw new IntegrationError("RELEASE_CAPABILITY_UNSUPPORTED");
    const result = await provider[operation]({ connection, root }, input);
    if (!result || !["queued", "running", "succeeded", "failed", "canceled"].includes(result.status)) {
      throw new IntegrationError("RELEASE_RESULT_INVALID");
    }
    const id = requireText(result.id, "release.id");
    const url = new URL(requireText(result.url, "release.url"));
    if (!["https:", "http:"].includes(url.protocol)) throw new IntegrationError("RELEASE_RESULT_INVALID");
    return { id, url: url.href, status: result.status };
  }
  return {
    triggerRelease: ({ connectionId, ...input }) => invoke(connectionId, "triggerRelease", input),
    getRelease: ({ connectionId, ...input }) => invoke(connectionId, "getRelease", input),
  };
}
