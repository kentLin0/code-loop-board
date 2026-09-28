import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function windowsPathEntries(processEnv) {
  const value = processEnv.Path ?? processEnv.PATH ?? "";
  return String(value).split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

async function isFile(filePath) {
  return stat(filePath).then((entry) => entry.isFile()).catch(() => false);
}

async function resolveWindowsCodexExecutable(executable, processEnv) {
  const requested = String(executable || "codex").trim();
  if (path.isAbsolute(requested)) {
    if (/\.exe$/i.test(requested) && await isFile(requested)) return requested;
    const executableSibling = `${requested}.exe`;
    return await isFile(executableSibling) ? executableSibling : requested;
  }
  if (!/^codex(?:\.exe)?$/i.test(requested)) return requested;
  for (const directory of windowsPathEntries(processEnv)) {
    const candidate = path.join(directory, "codex.exe");
    if (await isFile(candidate)) return candidate;
  }
  return requested;
}

function protectedPackageVersion(sourcePath) {
  const match = sourcePath.match(/[\\/]WindowsApps[\\/]OpenAI\.Codex_(.+?)_(?:x64|x86|arm64)__/i);
  return match?.[1]?.replace(/[^a-z0-9._-]+/gi, "-") ?? null;
}

export async function prepareCodexExecutable(options = {}) {
  const executable = options.executable ?? options.processEnv?.CODEX_EXECUTABLE ?? "codex";
  const platform = options.platform ?? process.platform;
  const processEnv = options.processEnv ?? process.env;
  if (platform !== "win32") return executable;

  const sourcePath = await resolveWindowsCodexExecutable(executable, processEnv);
  const version = protectedPackageVersion(sourcePath);
  if (!version) return sourcePath;

  const runtimeDirectory = options.runtimeDirectory
    ?? path.join(processEnv.LOCALAPPDATA || os.tmpdir(), "codex-taskboard", "runtime");
  const runtimePath = path.join(runtimeDirectory, `codex-${version}.exe`);
  const sourceStat = await stat(sourcePath);
  const runtimeStat = await stat(runtimePath).catch(() => null);
  if (runtimeStat?.isFile() && runtimeStat.size === sourceStat.size) return runtimePath;

  await mkdir(runtimeDirectory, { recursive: true });
  const temporaryPath = `${runtimePath}.${process.pid}.tmp`;
  await copyFile(sourcePath, temporaryPath);
  await unlink(runtimePath).catch(() => {});
  await rename(temporaryPath, runtimePath);
  return runtimePath;
}
