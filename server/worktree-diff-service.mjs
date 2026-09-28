import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import { normalizeRepositoryPath, repositoryRole } from "../shared/repository-role.mjs";
import { ApiError } from "./database.mjs";

const MAX_GIT_BUFFER = 8 * 1024 * 1024;
const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_CACHE_MAX_ENTRIES = 64;
const DEFAULT_CACHE_MAX_BYTES = 32 * 1024 * 1024;

export class WorktreeDiffService {
  constructor({
    database,
    runGit = defaultRunGit,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    cacheMaxEntries = DEFAULT_CACHE_MAX_ENTRIES,
    cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES,
    now = Date.now,
  } = {}) {
    this.database = database;
    this.runGit = runGit;
    this.cacheTtlMs = cacheTtlMs;
    this.cacheMaxEntries = cacheMaxEntries;
    this.cacheMaxBytes = cacheMaxBytes;
    this.now = now;
    this.diffCache = new Map();
    this.diffCacheBytes = 0;
    this.oversizedDiffCache = new Map();
  }

  async list(taskId) {
    const review = this.#review(taskId);
    return { ...review, totals: summarize(review.files) };
  }

  async assertSnapshotCurrent(taskId) {
    const review = this.#review(taskId);
    for (const repository of review.repositories) {
      assertRepositorySnapshot(repository);
      let currentHead;
      try {
        currentHead = (await this.runGit(repository.worktreePath, ["rev-parse", "HEAD"])).trim();
      } catch (cause) {
        throw new ApiError(
          409,
          "AUTOMATION_REVIEW_WORKTREE_UNAVAILABLE",
          `Review Worktree for repository '${repository.name}' is unavailable`,
          { repository: repository.name, cause: cause?.message },
        );
      }
      if (currentHead !== repository.headCommit) {
        throw new ApiError(
          409,
          "AUTOMATION_REVIEW_STALE",
          `Review snapshot for repository '${repository.name}' no longer matches Worktree HEAD`,
          { repository: repository.name, expected: repository.headCommit, actual: currentHead },
        );
      }
      try {
        await this.runGit(repository.worktreePath, ["cat-file", "-e", `${repository.baseCommit}^{commit}`]);
        await this.runGit(repository.worktreePath, ["cat-file", "-e", `${repository.headCommit}^{commit}`]);
      } catch (cause) {
        throw new ApiError(
          409,
          "AUTOMATION_REVIEW_COMMIT_MISSING",
          `Review commits for repository '${repository.name}' are unavailable`,
          { repository: repository.name, cause: cause?.message },
        );
      }
    }
    return review;
  }

  async getFile(taskId, { repository, path: requestedPath, startLine = 0, lineCount = 500 }) {
    const normalizedStartLine = normalizeRangeInteger(startLine, "startLine", { allowZero: true });
    const normalizedLineCount = normalizeRangeInteger(lineCount, "lineCount", { allowZero: false });
    const review = this.#review(taskId);
    const file = review.files.find((candidate) => (
      candidate.repository === repository && candidate.path === requestedPath
    ));
    if (!file || hasTraversal(requestedPath)) {
      throw new ApiError(404, "AUTOMATION_REVIEW_FILE_NOT_FOUND", "The requested file is not part of this review snapshot");
    }
    const repositorySnapshot = review.repositories.find((candidate) => candidate.name === repository);
    if (!repositorySnapshot) {
      throw new ApiError(409, "AUTOMATION_REVIEW_SNAPSHOT_INVALID", `Review repository '${repository}' is missing`);
    }
    const relativePath = snapshotRelativePath(repository, requestedPath);
    const relativePaths = [...new Set([
      file.previousPath ? snapshotRelativePath(repository, file.previousPath) : null,
      relativePath,
    ].filter(Boolean))];
    const historical = review.status === "approved" || review.status === "rejected";
    let diffRepository = repositorySnapshot;
    if (historical) {
      assertRepositorySnapshot(repositorySnapshot);
      const execution = this.database.getAutomationExecutionById(review.executionId);
      const source = execution?.repositories.find((candidate) => candidate.name === repository);
      diffRepository = {
        ...repositorySnapshot,
        worktreePath: source?.repositoryPath ?? repositorySnapshot.worktreePath,
      };
    } else {
      await this.assertSnapshotCurrent(taskId);
    }

    const common = {
      repository,
      path: requestedPath,
      language: languageForPath(requestedPath),
      startLine: normalizedStartLine,
    };
    if (file.binary) {
      return {
        ...common,
        binary: true,
        summary: `Binary file changed: ${requestedPath}`,
        lines: [],
        hasMore: false,
        nextStartLine: null,
      };
    }

    const cacheKey = JSON.stringify([
      review.id,
      review.version,
      repository,
      repositorySnapshot.baseCommit,
      repositorySnapshot.headCommit,
      file.previousPath,
      requestedPath,
    ]);
    const cachedDiffLines = this.#cachedDiff(cacheKey);
    const lines = cachedDiffLines
      ? cachedDiffLines.slice(normalizedStartLine, normalizedStartLine + normalizedLineCount + 1)
      : await this.#loadDiffPage(
          cacheKey,
          diffRepository,
          relativePaths,
          normalizedStartLine,
          normalizedLineCount,
        );
    const hasMore = lines.length > normalizedLineCount;
    if (hasMore) lines.pop();
    return {
      ...common,
      lines,
      hasMore,
      nextStartLine: hasMore ? normalizedStartLine + normalizedLineCount : null,
    };
  }

  async #loadDiffPage(cacheKey, repositorySnapshot, relativePaths, startLine, lineCount) {
    const shouldAttemptCache = !this.#isOversizedDiff(cacheKey);
    const collector = createDiffStreamCollector(
      startLine,
      lineCount,
      shouldAttemptCache ? Math.min(MAX_GIT_BUFFER, this.cacheMaxBytes) : 0,
    );
    const output = await this.runGit(repositorySnapshot.worktreePath, [
      "diff",
      "--no-ext-diff",
      "--find-renames",
      "--unified=3",
      repositorySnapshot.baseCommit,
      repositorySnapshot.headCommit,
      "--",
      ...relativePaths.map((relativePath) => `:(literal)${relativePath}`),
    ], { onStdout: collector.push, captureStdout: false });
    if (!collector.received && output) collector.push(output);
    const { pageLines, patch } = collector.finish();
    if (patch !== null) {
      this.#cacheDiff(cacheKey, splitPatchLines(patch), Buffer.byteLength(patch));
    } else if (shouldAttemptCache) {
      this.#markOversizedDiff(cacheKey);
    }
    return pageLines;
  }

  #cachedDiff(cacheKey) {
    this.#pruneDiffCache();
    const entry = this.diffCache.get(cacheKey);
    if (!entry) return null;
    this.diffCache.delete(cacheKey);
    this.diffCache.set(cacheKey, entry);
    return entry.lines;
  }

  #cacheDiff(cacheKey, lines, bytes) {
    if (bytes > this.cacheMaxBytes) return;
    this.oversizedDiffCache.delete(cacheKey);
    const existing = this.diffCache.get(cacheKey);
    if (existing) {
      this.diffCache.delete(cacheKey);
      this.diffCacheBytes -= existing.bytes;
    }
    this.diffCache.set(cacheKey, {
      lines,
      bytes,
      expiresAt: this.now() + this.cacheTtlMs,
    });
    this.diffCacheBytes += bytes;
    this.#pruneDiffCache();
    while (this.diffCache.size > this.cacheMaxEntries || this.diffCacheBytes > this.cacheMaxBytes) {
      const oldestKey = this.diffCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.#deleteCachedDiff(oldestKey);
    }
  }

  #pruneDiffCache() {
    const now = this.now();
    for (const [cacheKey, entry] of this.diffCache) {
      if (entry.expiresAt <= now) this.#deleteCachedDiff(cacheKey);
    }
    for (const [cacheKey, expiresAt] of this.oversizedDiffCache) {
      if (expiresAt <= now) this.oversizedDiffCache.delete(cacheKey);
    }
  }

  #isOversizedDiff(cacheKey) {
    this.#pruneDiffCache();
    const expiresAt = this.oversizedDiffCache.get(cacheKey);
    if (!expiresAt) return false;
    this.oversizedDiffCache.delete(cacheKey);
    this.oversizedDiffCache.set(cacheKey, expiresAt);
    return true;
  }

  #markOversizedDiff(cacheKey) {
    this.oversizedDiffCache.delete(cacheKey);
    this.oversizedDiffCache.set(cacheKey, this.now() + this.cacheTtlMs);
    while (this.oversizedDiffCache.size > this.cacheMaxEntries) {
      const oldestKey = this.oversizedDiffCache.keys().next().value;
      if (oldestKey === undefined) break;
      this.oversizedDiffCache.delete(oldestKey);
    }
  }

  #deleteCachedDiff(cacheKey) {
    const entry = this.diffCache.get(cacheKey);
    if (!entry) return;
    this.diffCache.delete(cacheKey);
    this.diffCacheBytes -= entry.bytes;
  }

  #review(taskId) {
    const review = this.database?.getAutomationReview(taskId);
    if (!review) {
      throw new ApiError(404, "AUTOMATION_REVIEW_NOT_FOUND", `No automation review exists for '${taskId}'`);
    }
    return review;
  }
}

function assertRepositorySnapshot(repository) {
  if (!repository || typeof repository.name !== "string" || !repository.name
    || typeof repository.worktreePath !== "string" || !repository.worktreePath
    || typeof repository.baseCommit !== "string" || !repository.baseCommit
    || typeof repository.headCommit !== "string" || !repository.headCommit) {
    throw new ApiError(409, "AUTOMATION_REVIEW_SNAPSHOT_INVALID", "Review repository snapshot is incomplete");
  }
}

function snapshotRelativePath(repositoryName, requestedPath) {
  const prefix = `${repositoryRole(repositoryName)}/`;
  if (!requestedPath.startsWith(prefix)) {
    throw new ApiError(409, "AUTOMATION_REVIEW_SNAPSHOT_INVALID", "Review file path does not match its repository");
  }
  const relativePath = requestedPath.slice(prefix.length);
  if (!relativePath || hasTraversal(relativePath)) {
    throw new ApiError(409, "AUTOMATION_REVIEW_SNAPSHOT_INVALID", "Review file path is invalid");
  }
  return relativePath;
}

function hasTraversal(candidate) {
  if (typeof candidate !== "string") return true;
  const normalized = normalizeRepositoryPath(candidate);
  if (path.isAbsolute(candidate) || path.posix.isAbsolute(normalized)) return true;
  return normalized.split("/").some((segment) => segment === "..");
}

function normalizeRangeInteger(value, field, { allowZero }) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new ApiError(400, "INVALID_REVIEW_DIFF_RANGE", `${field} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return value;
}

function summarize(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return { files: files.length, additions, deletions, changedLines: additions + deletions };
}

function languageForPath(filePath) {
  const extension = path.posix.extname(filePath.toLowerCase());
  return ({
    ".js": "javascript",
    ".jsx": "jsx",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".vue": "vue",
    ".py": "python",
    ".json": "json",
  })[extension] ?? "text/plain";
}

function splitPatchLines(patch) {
  if (!patch) return [];
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line) => line.endsWith("\r") ? line.slice(0, -1) : line);
}

function createDiffStreamCollector(startLine, lineCount, cacheLimitBytes) {
  const pageCollector = createLineCollector(startLine, lineCount);
  let cacheChunks = cacheLimitBytes > 0 ? [] : null;
  let cacheBytes = 0;
  let received = false;
  return {
    get received() {
      return received;
    },
    push(chunk) {
      received = true;
      pageCollector.push(chunk);
      if (cacheChunks === null) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (cacheBytes + buffer.length > cacheLimitBytes) {
        cacheChunks = null;
        cacheBytes = 0;
        return;
      }
      cacheChunks.push(buffer);
      cacheBytes += buffer.length;
    },
    finish() {
      return {
        pageLines: pageCollector.finish(),
        patch: cacheChunks === null ? null : Buffer.concat(cacheChunks, cacheBytes).toString("utf8"),
      };
    },
  };
}

function createLineCollector(startLine, lineCount) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineIndex = 0;
  const lines = [];
  const accept = (line) => {
    if (lineIndex >= startLine && lines.length < lineCount + 1) {
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    lineIndex += 1;
  };
  return {
    push(chunk) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        accept(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
    },
    finish() {
      pending += decoder.end();
      if (pending) accept(pending);
      return lines;
    },
  };
}

function defaultRunGit(repositoryPath, args, { onStdout, captureStdout = true } = {}) {
  return new Promise((resolve, reject) => {
    const safeDirectory = path.resolve(repositoryPath).replaceAll("\\", "/");
    const child = spawn("git", ["-c", `safe.directory=${safeDirectory}`, "-C", repositoryPath, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = null;
    child.stdout.on("data", (chunk) => {
      onStdout?.(chunk);
      if (!captureStdout) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_BUFFER) overflow = new Error("Git stdout exceeded 8 MiB");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_BUFFER) overflow = new Error("Git stderr exceeded 8 MiB");
      else stderr.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (overflow) return reject(overflow);
      const output = Buffer.concat(stdout).toString("utf8");
      if (exitCode === 0) return resolve(output);
      const error = new Error(Buffer.concat(stderr).toString("utf8").trim() || `Git exited with code ${exitCode}`);
      error.exitCode = exitCode;
      error.stdout = output;
      reject(error);
    });
  });
}
