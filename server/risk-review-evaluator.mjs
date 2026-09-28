import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { normalizeRepositoryPath, reviewPath } from "../shared/repository-role.mjs";
import { prohibitedSubmissionPaths, staticSubmissionError } from "../shared/automation-submission-policy.mjs";

const execFileAsync = promisify(execFile);
const MAX_GIT_BUFFER = 8 * 1024 * 1024;

export class RiskReviewEvaluator {
  constructor({ runGit = defaultRunGit, policyLoader } = {}) {
    this.runGit = runGit;
    this.policyLoader = policyLoader;
  }

  async evaluate({ execution }) {
    const repositories = [];
    const files = [];
    const prohibitedPaths = new Set();
    const reasons = new Set();

    for (const repository of execution.repositories) {
      const headCommit = (await this.runGit(repository.worktreePath, ["rev-parse", "HEAD"])).trim();
      const [numstatOutput, nameStatusOutput] = await Promise.all([
        this.runGit(repository.worktreePath, [
          "diff",
          "--numstat",
          "-z",
          "-M",
          repository.baseCommit,
          headCommit,
        ]),
        this.runGit(repository.worktreePath, [
          "diff",
          "--name-status",
          "-z",
          "-M",
          repository.baseCommit,
          headCommit,
        ]),
      ]);
      const repositoryFiles = mergeDiffRecords(
        repository.name,
        parseNumstat(numstatOutput),
        parseNameStatus(nameStatusOutput),
      );
      const repositoryProhibitedPaths = prohibitedSubmissionPaths(repositoryFiles);
      for (const prohibitedPath of repositoryProhibitedPaths) prohibitedPaths.add(prohibitedPath);
      if (repositoryProhibitedPaths.length > 0) {
        reasons.add(`${repository.name}: ${staticSubmissionError(repositoryProhibitedPaths)}`);
      }
      // A changed .gitignore must not be allowed to hide other tracked files from
      // the same review snapshot. In that case every changed tracked path stays
      // visible and participates in both the line threshold and directory policy.
      const changesIgnoreRules = repositoryFiles.some((file) => (
        file.rawPaths.some((candidate) => path.posix.basename(candidate) === ".gitignore")
      ));
      const ignoredPaths = changesIgnoreRules
        ? new Set()
        : await this.#ignoredPaths(repository.worktreePath, repositoryFiles);

      const visibleFiles = repositoryFiles
        .filter((file) => file.rawPaths.some((candidate) => !ignoredPaths.has(candidate)))
        .map((file) => ({
          ...file,
          policyPaths: file.rawPaths.filter((candidate) => !ignoredPaths.has(candidate)),
        }));

      repositories.push({
        name: repository.name,
        worktreePath: repository.worktreePath,
        baseCommit: repository.baseCommit,
        headCommit,
      });
      files.push(...visibleFiles);

      try {
        if (!this.policyLoader?.policyForRepository) {
          throw policyConfigurationError("REVIEW_POLICY_UNAVAILABLE", "No review policy loader is configured");
        }
        const policy = await this.policyLoader.policyForRepository(repository.repositoryPath);
        if (policy === null) continue;
        assertFinalPolicy(policy);
        const repositoryReasons = new Set();
        applyPolicy(policy, visibleFiles, summarize(visibleFiles), repositoryReasons);
        for (const reason of repositoryReasons) reasons.add(`${repository.name}: ${reason}`);
      } catch (error) {
        reasons.add(`${repository.name}: ${formatPolicyError(error)}`);
      }
    }

    const totals = summarize(files);
    return {
      requiresApproval: reasons.size > 0,
      reasons: [...reasons],
      repositories,
      files: files.map(({ policyPaths: _policyPaths, rawPaths: _rawPaths, ...file }) => file),
      prohibitedPaths: [...prohibitedPaths].sort(),
      totals,
    };
  }

  async #ignoredPaths(worktreePath, files) {
    const candidates = [...new Set(files.flatMap((file) => file.rawPaths))];
    if (candidates.length === 0) return new Set();
    try {
      const output = await this.runGit(
        worktreePath,
        ["check-ignore", "--no-index", "-z", "--stdin"],
        { input: `${candidates.join("\0")}\0`, allowedExitCodes: [0, 1] },
      );
      return new Set(splitNul(output));
    } catch (error) {
      if (Number(error?.exitCode ?? error?.code) === 1) return new Set();
      throw error;
    }
  }
}

function parseNumstat(output) {
  const tokens = String(output).split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++];
    const firstTab = header.indexOf("\t");
    const secondTab = header.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    const additionsRaw = header.slice(0, firstTab);
    const deletionsRaw = header.slice(firstTab + 1, secondTab);
    let currentPath = header.slice(secondTab + 1);
    let previousPath = null;
    if (currentPath === "") {
      previousPath = tokens[index++] ?? "";
      currentPath = tokens[index++] ?? "";
    }
    records.push({
      path: normalizeGitPath(currentPath),
      previousPath: previousPath === null ? null : normalizeGitPath(previousPath),
      additions: additionsRaw === "-" ? null : Number(additionsRaw),
      deletions: deletionsRaw === "-" ? null : Number(deletionsRaw),
    });
  }
  return records;
}

function parseNameStatus(output) {
  const tokens = splitNul(output);
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = normalizeGitPath(tokens[index++] ?? "");
      const currentPath = normalizeGitPath(tokens[index++] ?? "");
      records.push({ status, path: currentPath, previousPath });
      continue;
    }
    records.push({ status, path: normalizeGitPath(tokens[index++] ?? ""), previousPath: null });
  }
  return records;
}

function mergeDiffRecords(repositoryName, numstatRecords, nameStatusRecords) {
  const numstatByPath = new Map(numstatRecords.map((record) => [record.path, record]));
  return nameStatusRecords.map((statusRecord) => {
    const numstat = numstatByPath.get(statusRecord.path);
    const additions = numstat ? numstat.additions : 0;
    const deletions = numstat ? numstat.deletions : 0;
    return {
      repository: repositoryName,
      path: reviewPath(repositoryName, statusRecord.path),
      previousPath: statusRecord.previousPath === null
        ? null
        : reviewPath(repositoryName, statusRecord.previousPath),
      status: statusRecord.status,
      additions,
      deletions,
      binary: additions === null || deletions === null,
      rawPaths: [statusRecord.path, statusRecord.previousPath].filter((candidate) => candidate !== null),
    };
  });
}

function summarize(files) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions ?? 0;
    deletions += file.deletions ?? 0;
  }
  return {
    files: files.length,
    additions,
    deletions,
    changedLines: additions + deletions,
  };
}

function assertFinalPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw policyConfigurationError("REVIEW_POLICY_FIELD", "Resolved review policy must be an object");
  }
  const hasBlacklist = Object.hasOwn(policy, "blacklist");
  const hasWhitelist = Object.hasOwn(policy, "whitelist");
  if (hasBlacklist === hasWhitelist) {
    throw policyConfigurationError(
      "REVIEW_POLICY_DIRECTORY_MODE",
      "Resolved review policy must contain exactly one of blacklist or whitelist",
    );
  }
  if (!Number.isInteger(policy.changedLinesThreshold) || policy.changedLinesThreshold < 1) {
    throw policyConfigurationError(
      "REVIEW_POLICY_FIELD",
      "Resolved review policy changedLinesThreshold must be a positive integer",
    );
  }
  const patterns = hasBlacklist ? policy.blacklist : policy.whitelist;
  if (!Array.isArray(patterns) || patterns.some((pattern) => typeof pattern !== "string" || !pattern)) {
    throw policyConfigurationError("REVIEW_POLICY_FIELD", "Resolved review policy paths must be strings");
  }
  if (typeof path.matchesGlob !== "function") {
    throw policyConfigurationError(
      "REVIEW_POLICY_GLOB_UNAVAILABLE",
      "This Node.js runtime does not provide path.matchesGlob",
    );
  }
}

function applyPolicy(policy, files, totals, reasons) {
  if (totals.changedLines >= policy.changedLinesThreshold) {
    reasons.add(`${totals.changedLines} changed lines >= threshold ${policy.changedLinesThreshold}`);
  }
  if (Object.hasOwn(policy, "blacklist")) {
    for (const pattern of policy.blacklist) {
      const normalizedPattern = normalizeReviewPattern(pattern);
      if (files.some((file) => fileReviewPaths(file).some((candidate) => path.matchesGlob(candidate, normalizedPattern)))) {
        reasons.add(`Changed path matches blacklist pattern ${normalizedPattern}`);
      }
    }
    return;
  }
  const patterns = policy.whitelist.map(normalizeReviewPattern);
  for (const file of files) {
    for (const candidate of fileReviewPaths(file)) {
      if (!patterns.some((pattern) => path.matchesGlob(candidate, pattern))) {
        reasons.add(`${candidate} is outside the review whitelist`);
      }
    }
  }
}

function fileReviewPaths(file) {
  return file.policyPaths ?? [file.path, file.previousPath].filter((candidate) => candidate !== null);
}

function normalizeGitPath(value) {
  return normalizeRepositoryPath(value);
}

function normalizeReviewPattern(value) {
  return String(value).replaceAll("\\", "/");
}

function splitNul(output) {
  return String(output).split("\0").filter(Boolean).map(normalizeGitPath);
}

function policyConfigurationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function formatPolicyError(error) {
  const code = error?.code ? ` [${error.code}]` : "";
  return `Review policy configuration error${code}: ${error?.message ?? String(error)}`;
}

async function defaultRunGit(repositoryPath, args, { input, allowedExitCodes = [0] } = {}) {
  const gitArgs = gitArguments(repositoryPath, args);
  if (input === undefined) {
    try {
      const result = await execFileAsync("git", gitArgs, {
        encoding: "utf8",
        shell: false,
        windowsHide: true,
        maxBuffer: MAX_GIT_BUFFER,
      });
      return result.stdout;
    } catch (error) {
      if (allowedExitCodes.includes(Number(error?.code))) return error.stdout ?? "";
      throw error;
    }
  }
  return spawnGit(gitArgs, { input, allowedExitCodes });
}

function spawnGit(args, { input, allowedExitCodes }) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let overflow = null;
    let settled = false;
    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_GIT_BUFFER) overflow = new Error("Git stdout exceeded 8 MiB");
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_GIT_BUFFER) overflow = new Error("Git stderr exceeded 8 MiB");
      else stderr.push(chunk);
    });
    child.on("error", settleReject);
    child.stdin.on("error", settleReject);
    child.on("close", (exitCode) => {
      if (overflow) return settleReject(overflow);
      const output = Buffer.concat(stdout).toString("utf8");
      if (allowedExitCodes.includes(exitCode)) return settleResolve(output);
      const error = new Error(Buffer.concat(stderr).toString("utf8").trim() || `Git exited with code ${exitCode}`);
      error.exitCode = exitCode;
      error.stdout = output;
      settleReject(error);
    });
    try {
      child.stdin.end(input);
    } catch (error) {
      settleReject(error);
    }
  });
}

function gitArguments(repositoryPath, args) {
  const safeDirectory = path.resolve(repositoryPath).replaceAll("\\", "/");
  return ["-c", `safe.directory=${safeDirectory}`, "-C", repositoryPath, ...args];
}
