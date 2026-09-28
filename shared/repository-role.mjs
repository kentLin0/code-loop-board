import { platform as operatingSystemPlatform } from "node:os";

export function repositoryRole(name) {
  const normalized = String(name ?? "").trim().toLowerCase();
  if (normalized === "frontend" || normalized.endsWith("-frontend")) return "frontend";
  if (normalized === "backend" || normalized.endsWith("-backend")) return "backend";
  return normalized || "repository";
}

export function normalizeRepositoryPath(relativePath, platform = operatingSystemPlatform()) {
  const normalized = String(relativePath);
  return platform === "win32" ? normalized.replaceAll("\\", "/") : normalized;
}

export function reviewPath(repositoryName, relativePath, platform = operatingSystemPlatform()) {
  return `${repositoryRole(repositoryName)}/${normalizeRepositoryPath(relativePath, platform)}`;
}
