import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class IntegrationError extends Error {
  constructor(code, message = code, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function requireText(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new IntegrationError("INTEGRATION_CONFIG_INVALID", `${name} must be non-empty text`);
  }
  return value.trim();
}

export async function loadIntegrationRegistry(configPath) {
  const root = path.dirname(path.resolve(configPath));
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { config: { connections: [], projects: [] }, root, providers: new Map() };
    throw new IntegrationError("INTEGRATION_CONFIG_INVALID", "Cannot read local integrations configuration");
  }
  if (config.schemaVersion !== 1 || !Array.isArray(config.connections) || !Array.isArray(config.projects)) {
    throw new IntegrationError("INTEGRATION_CONFIG_INVALID", "schemaVersion 1, connections and projects are required");
  }
  const providers = new Map();
  for (const entry of config.providers ?? []) {
    const id = requireText(entry.id, "provider.id");
    if (providers.has(id)) throw new IntegrationError("INTEGRATION_PROVIDER_DUPLICATE");
    const modulePath = await realpath(path.resolve(root, requireText(entry.module, "provider.module")));
    const module = await import(pathToFileURL(modulePath).href);
    if (typeof module.describe !== "function") throw new IntegrationError("INTEGRATION_PROVIDER_INVALID");
    providers.set(id, module);
  }
  const ids = new Set();
  for (const connection of config.connections) {
    const id = requireText(connection.id, "connection.id");
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new IntegrationError("INTEGRATION_CONNECTION_INVALID");
    ids.add(id);
    if (!providers.has(connection.providerId)) throw new IntegrationError("INTEGRATION_PROVIDER_NOT_FOUND");
    let url;
    try { url = new URL(connection.baseUrl); } catch { throw new IntegrationError("INTEGRATION_BASE_URL_INVALID"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      throw new IntegrationError("INTEGRATION_BASE_URL_INVALID");
    }
  }
  return { config, root, providers };
}

export function resolveConnection(registry, connectionId) {
  const connection = registry.config.connections.find((item) => item.id === connectionId);
  if (!connection) throw new IntegrationError("INTEGRATION_CONNECTION_NOT_FOUND", "Connection is not configured", 404);
  return {
    connection,
    provider: registry.providers.get(connection.providerId),
    runtime: {
      root: registry.root,
      sessionRoot: path.join(registry.root, ".loop-integrations", connection.id),
      resolveLocalPath: (value) => path.resolve(registry.root, value),
    },
  };
}

export function projectConnection(registry, projectId, connectionId) {
  const mapping = registry.config.projects.find((item) => item.projectId === projectId && item.connectionId === connectionId);
  if (!mapping) throw new IntegrationError("INTEGRATION_PROJECT_NOT_CONFIGURED");
  return mapping;
}
