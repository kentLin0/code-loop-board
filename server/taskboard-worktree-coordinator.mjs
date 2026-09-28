import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { ApiError } from "./database.mjs";
import { prohibitedSubmissionPaths, staticSubmissionError } from "../shared/automation-submission-policy.mjs";
import { boundStatus } from "../shared/board-config.mjs";

const execFileAsync = promisify(execFile);
const ACTIVE_EXECUTION_PHASES = new Set([
  "working",
  "ready_to_merge",
  "merging",
]);

export class TaskboardWorktreeCoordinator {
  constructor({
    database,
    riskReviewEvaluator,
    worktreeDiffService,
    runGit = defaultRunGit,
    runNpm = defaultRunNpm,
    linkDirectory = defaultLinkDirectory,
    copyDirectory = defaultCopyDirectory,
  } = {}) {
    this.database = database;
    this.riskReviewEvaluator = riskReviewEvaluator;
    this.worktreeDiffService = worktreeDiffService;
    this.runGit = runGit;
    this.runNpm = runNpm;
    this.linkDirectory = linkDirectory;
    this.copyDirectory = copyDirectory;
    this.dependencyCachePromises = new Map();
  }

  async fillProject({ projectId, workspacePath, concurrencyLimit }) {
    if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 12) {
      throw new ApiError(400, "INVALID_CONCURRENCY", "concurrencyLimit must be an integer from 1 to 12");
    }
    const project = this.database.getProject(projectId);
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);
    const root = path.resolve(workspacePath || project.workspacePath || "");
    if (!path.isAbsolute(root)) {
      throw new ApiError(400, "WORKSPACE_REQUIRED", "An absolute workspacePath is required for automatic claiming");
    }

    const boardConfig = this.database.getProjectBoardConfig(projectId).config;
    if (!boardConfig.automation.enabled) return this.summary(projectId, concurrencyLimit);
    this.database.reconcilePausedAutomationTaskStatuses(projectId);
    const existing = this.database.listProjectAutomationExecutions(projectId, { activeOnly: true });
    await this.#linkExistingWorktreeDependencies({
      project,
      executions: existing,
      workspacePath: root,
    });
    const usedSlots = new Set(existing.map((execution) => execution.slotNumber));
    const activeDevelopmentCount = existing
      .filter((execution) => execution.phase === "working")
      .length;
    const availableSlots = [];
    for (let slot = 1; slot <= concurrencyLimit; slot += 1) {
      if (!usedSlots.has(slot)) availableSlots.push(slot);
    }
    availableSlots.splice(Math.max(0, concurrencyLimit - activeDevelopmentCount));
    if (availableSlots.length === 0) return this.summary(projectId, concurrencyLimit);

    let repositories;
    try {
      repositories = await this.discoverRepositories(root);
    } catch (error) {
      return this.summary(projectId, concurrencyLimit, error instanceof Error ? error.message : String(error));
    }

    const inProgress = this.database.listTasks({ projectId, status: boundStatus(boardConfig, "working"), archived: "false" })
      .filter((task) => task.automationExecution === null);
    const todo = this.database.listTasks({ projectId, status: boundStatus(boardConfig, "ready"), archived: "false" });
    const candidates = [...inProgress, ...todo];
    const claimed = [];
    let claimError = null;
    for (const slotNumber of availableSlots) {
      const taskIndex = candidates.findIndex((candidate) => this.#taskMatchesRepositoryBranches(candidate, repositories));
      const task = taskIndex >= 0 ? candidates.splice(taskIndex, 1)[0] : null;
      if (!task) break;
      try {
        if (task.delivery?.mode === "release" && !boardConfig.automation.releaseEnabled) {
          throw new ApiError(409, "AUTOMATION_RELEASE_DISABLED", "Release delivery is disabled in this project board configuration");
        }
        const taskRepositories = task.delivery?.repositories?.length
          ? repositories.filter((repository) => task.delivery.repositories.some((target) => target.repositoryId === repository.name))
          : repositories;
        claimed.push(await this.#claimTask({ project, task, slotNumber, repositories: taskRepositories, workspacePath: root }));
      } catch (error) {
        claimError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    return { ...this.summary(projectId, concurrencyLimit, claimError), claimed };
  }

  async retryPendingCleanup(projectId) {
    const pending = this.database.listProjectAutomationExecutions(projectId)
      .filter((execution) => execution.phase === "cleanup_pending");
    const results = [];
    for (const execution of pending) {
      const failures = [];
      for (const repository of execution.repositories) {
        try {
          await this.#cleanupRepository(repository, execution.worktreeRoot);
        } catch (error) {
          failures.push({ repository: repository.name, message: error instanceof Error ? error.message : String(error) });
        }
      }
      results.push(failures.length > 0
        ? this.database.markAutomationCleanupPending(execution.taskId, failures)
        : this.database.finishAutomationCleanup(execution.taskId));
    }
    return results;
  }

  async discoverRepositories(workspacePath) {
    const root = await realpath(path.resolve(workspacePath));
    if (await this.#isRepositoryRoot(root)) return [await this.#inspectRepository(root)];

    const entries = await readdir(root, { withFileTypes: true });
    const repositories = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name);
      if (await this.#isRepositoryRoot(candidate)) repositories.push(await this.#inspectRepository(candidate));
    }
    if (repositories.length === 0) {
      throw new ApiError(409, "GIT_REPOSITORY_NOT_FOUND", `No Git repository was found in ${root}`);
    }
    return repositories;
  }

  summary(projectId, concurrencyLimit, error = null) {
    const executions = this.database.listProjectAutomationExecutions(projectId, { activeOnly: true });
    return {
      projectId,
      concurrencyLimit,
      occupied: executions.length,
      mergePaused: false,
      ...(error ? { error } : {}),
      executions,
    };
  }

  getTaskExecution(taskId) {
    const execution = this.database.getTaskAutomationExecution(taskId);
    if (!execution) throw new ApiError(404, "AUTOMATION_EXECUTION_NOT_FOUND", `No automation execution exists for '${taskId}'`);
    return execution;
  }

  async getReview(taskId) {
    return this.worktreeDiffService.list(taskId);
  }

  async getReviewFile(taskId, input) {
    const review = this.database.getAutomationReview(taskId);
    if (review?.status === "approved" || review?.status === "rejected") {
      return this.worktreeDiffService.getFile(taskId, input);
    }
    return this.#withCurrentReviewSnapshot(
      taskId,
      () => this.worktreeDiffService.getFile(taskId, input),
    );
  }

  async approveReview(taskId, input, actor) {
    return this.#withCurrentReviewSnapshot(
      taskId,
      () => this.database.approveAutomationReview(
        taskId,
        input.reviewId,
        input.version,
        actor,
        input.comment,
      ),
    );
  }

  async rejectReview(taskId, input, actor) {
    return this.database.rejectAutomationReview(
      taskId,
      input.reviewId,
      input.version,
      actor,
      input.reason,
    );
  }

  assignApprovedReviews(projectId, concurrencyLimit) {
    if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 12) {
      throw new ApiError(400, "INVALID_CONCURRENCY", "concurrencyLimit must be an integer from 1 to 12");
    }
    const project = this.database.getProject(projectId);
    if (!project) throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${projectId}' does not exist`);

    if (!this.database.getProjectBoardConfig(projectId).config.automation.enabled) return [];
    const activeExecutions = this.database.listProjectAutomationExecutions(projectId, { activeOnly: true });
    const occupiedSlots = new Set(activeExecutions.map((execution) => execution.slotNumber));
    const availableSlots = [];
    for (let slotNumber = concurrencyLimit + 1; slotNumber <= 12; slotNumber += 1) {
      if (!occupiedSlots.has(slotNumber)) availableSlots.push(slotNumber);
    }
    for (let slotNumber = 1; slotNumber <= concurrencyLimit; slotNumber += 1) {
      if (!occupiedSlots.has(slotNumber)) availableSlots.push(slotNumber);
    }

    const reviews = this.database.listApprovedAutomationReviews(projectId);
    const resumed = [];
    for (let index = 0; index < Math.min(availableSlots.length, reviews.length); index += 1) {
      resumed.push(this.database.assignApprovedAutomationSlot(reviews[index].taskId, availableSlots[index]));
    }
    return resumed;
  }

  async acquireRun(taskId, threadId) {
    await this.#prepareExecutionEnvironment(this.getTaskExecution(taskId));
    return this.database.acquireAutomationRun(taskId, threadId);
  }

  releaseRun(taskId, token, threadId) {
    return this.database.releaseAutomationRun(taskId, token, threadId);
  }

  failRun(taskId, token, threadId, reason) {
    return this.database.failAutomationRun(taskId, token, threadId, reason);
  }

  scheduleMergeRetry(taskId, token, threadId) {
    return this.database.scheduleAutomationMergeRetry(taskId, token, threadId);
  }

  async acquireMerge(taskId, token, threadId) {
    const currentExecution = this.getTaskExecution(taskId);
    const boardConfig = this.database.getProjectBoardConfig(currentExecution.projectId).config;
    const currentReview = this.database.getAutomationReviewByExecution(currentExecution.id);
    let execution;

    if (!boardConfig.automation.approvalEnabled && !currentReview) {
      execution = this.database.acquireAutomationMerge(taskId, token, threadId);
    } else if (currentReview?.status === "approved") {
      try {
        await this.worktreeDiffService.assertSnapshotCurrent(currentExecution.taskId);
        assertSubmissionSnapshotAllowed(currentReview);
      } catch (error) {
        if (error?.code !== "AUTOMATION_REVIEW_STALE") throw error;
        const task = this.database.getTask(taskId);
        const project = task ? this.database.getProject(task.projectId) : null;
        if (!task || !project) {
          throw new ApiError(404, "PROJECT_NOT_FOUND", `Project for task '${taskId}' does not exist`);
        }
        const refreshedSnapshot = await this.riskReviewEvaluator.evaluate({ execution: currentExecution });
        refreshedSnapshot.reasons = [
          "Worktree changed after approval; renewed approval is required",
          ...refreshedSnapshot.reasons,
        ];
        const refreshedReview = this.database.refreshApprovedAutomationReview(
          currentExecution.taskId,
          currentReview.id,
          currentReview.version,
          token,
          threadId,
          error.message,
          refreshedSnapshot,
        );
        throw new ApiError(
          409,
          "AUTOMATION_REVIEW_STALE",
          "The approved automation review changed and has been refreshed",
          {
            ...(error.details ?? {}),
            refreshedReview,
            version: refreshedReview.version,
          },
        );
      }
      execution = this.database.acquireAutomationMerge(taskId, token, threadId);
    } else if (currentReview?.status === "pending") {
      if (currentExecution.token !== token) {
        throw new ApiError(403, "AUTOMATION_TOKEN_MISMATCH", "The automation execution token is invalid");
      }
      return currentExecution;
    } else {
      const task = this.database.getTask(taskId);
      const project = this.database.getProject(task.projectId);
      let result;
      try {
        result = await this.riskReviewEvaluator.evaluate({ execution: currentExecution });
      } catch (error) {
        return this.database.failAutomationRun(
          taskId,
          token,
          threadId,
          reviewEvaluationFailureReason(error),
        );
      }
      assertSubmissionSnapshotAllowed(result);
      execution = result.requiresApproval
        ? this.database.beginAutomationReview(taskId, token, threadId, result)
        : this.database.acquireAutomationMerge(taskId, token, threadId);
    }

    if (execution.phase === "merging" && !execution.repositories.some((repository) => repository.status === "parallel_merge_started")) {
      const repositories = execution.repositories.map((repository) => ({ ...repository, status: "parallel_merge_started" }));
      return this.database.updateAutomationExecutionRepositories(taskId, token, repositories);
    }
    return execution;
  }

  async prepareRelease(taskId, token, threadId, repositories) {
    const current = this.getTaskExecution(taskId);
    this.#assertReleaseEnabled(current);
    if (current.token !== token) throw new ApiError(403, "AUTOMATION_TOKEN_MISMATCH", "The automation execution token is invalid");
    if (current.runOwnerThreadId !== threadId) {
      throw new ApiError(409, "AUTOMATION_RUN_NOT_OWNER", "This Codex task does not own the automation run");
    }
    if (current.phase !== "merging") {
      throw new ApiError(409, "AUTOMATION_PHASE_CONFLICT", "The task is not in parallel merge phase");
    }
    const verifiedRepositories = [];
    for (const repository of current.repositories) {
      verifiedRepositories.push(await this.#verifyDeliveredRepository(repository));
    }
    const resultByName = new Map((Array.isArray(repositories) ? repositories : []).map((result) => [result.name, result]));
    return this.database.prepareAutomationRelease(
      taskId,
      token,
      threadId,
      verifiedRepositories.map((repository) => ({
        ...repository,
        validation: resultByName.get(repository.name)?.validation ?? null,
      })),
    );
  }

  async reconcileRelease(taskId, token, threadId, observedStatus) {
    const current = this.getTaskExecution(taskId);
    this.#assertReleaseEnabled(current);
    if (current.token !== token) throw new ApiError(403, "AUTOMATION_TOKEN_MISMATCH", "The automation execution token is invalid");
    if (current.runOwnerThreadId !== threadId) {
      throw new ApiError(409, "AUTOMATION_RUN_NOT_OWNER", "This Codex task does not own the automation run");
    }
    const execution = this.database.reconcileAutomationRelease(taskId, token, threadId, observedStatus);
    const cleanupFailures = [];
    for (const repository of execution.repositories) {
      try {
        await this.#cleanupRepository(repository, execution.worktreeRoot);
      } catch (error) {
        cleanupFailures.push({
          repository: repository.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (cleanupFailures.length > 0) return this.database.markAutomationCleanupPending(taskId, cleanupFailures);
    return this.database.finishAutomationCleanup(taskId);
  }

  pauseMerge(taskId, token, threadId, { reason, conflictFiles = [] }) {
    return this.database.pauseAutomationMerge(taskId, token, threadId, reason, conflictFiles);
  }

  async resumeMerge(taskId) {
    const execution = this.getTaskExecution(taskId);
    if (execution.phase !== "paused_for_human") {
      throw new ApiError(409, "AUTOMATION_NOT_PAUSED", "This execution is not waiting for human conflict resolution");
    }
    for (const repository of execution.repositories) {
      const unresolved = (await this.runGit(repository.worktreePath, ["diff", "--name-only", "--diff-filter=U"])).trim();
      if (unresolved) {
        throw new ApiError(409, "CONFLICTS_REMAIN", "Git conflicts are still unresolved", {
          files: unresolved.split(/\r?\n/).filter(Boolean),
        });
      }
      const branch = (await this.runGit(repository.worktreePath, ["branch", "--show-current"])).trim();
      if (branch !== repository.taskBranch) {
        throw new ApiError(409, "WORKTREE_BRANCH_MISMATCH", `Expected ${repository.taskBranch} in ${repository.worktreePath}`);
      }
    }
    return this.database.resumeAutomationMerge(taskId);
  }

  async #withCurrentReviewSnapshot(taskId, action) {
    try {
      await this.worktreeDiffService.assertSnapshotCurrent(taskId);
      return await action();
    } catch (error) {
      if (error?.code !== "AUTOMATION_REVIEW_STALE") throw error;

      const review = this.database.getAutomationReview(taskId);
      if (!review) {
        throw new ApiError(404, "AUTOMATION_REVIEW_NOT_FOUND", `No automation review exists for '${taskId}'`);
      }
      const execution = this.getTaskExecution(taskId);
      const task = this.database.getTask(taskId);
      const project = task ? this.database.getProject(task.projectId) : null;
      if (!task || !project) {
        throw new ApiError(404, "PROJECT_NOT_FOUND", `Project for task '${taskId}' does not exist`);
      }

      let snapshot;
      try {
        snapshot = await this.riskReviewEvaluator.evaluate({ execution });
      } catch (refreshError) {
        throw new ApiError(
          409,
          "AUTOMATION_REVIEW_STALE",
          "The automation review snapshot changed but could not be refreshed",
          {
            ...(error.details ?? {}),
            refreshError: {
              ...(refreshError?.code ? { code: refreshError.code } : {}),
              message: refreshError instanceof Error ? refreshError.message : String(refreshError),
            },
            review,
            version: review.version,
          },
        );
      }
      const refreshedReview = this.database.replaceStaleAutomationReviewSnapshot(
        taskId,
        review.id,
        review.version,
        error.message,
        snapshot,
      );
      throw new ApiError(
        409,
        "AUTOMATION_REVIEW_STALE",
        "The automation review snapshot changed and has been refreshed",
        {
          ...(error.details ?? {}),
          refreshedReview,
          version: refreshedReview.version,
        },
      );
    }
  }

  async complete(taskId, token, threadId, repositories) {
    const current = this.getTaskExecution(taskId);
    this.#assertReleaseEnabled(current);
    if (current.token !== token) throw new ApiError(403, "AUTOMATION_TOKEN_MISMATCH", "The automation execution token is invalid");
    if (current.runOwnerThreadId !== threadId) {
      throw new ApiError(409, "AUTOMATION_RUN_NOT_OWNER", "This Codex task does not own the automation run");
    }
    const verifiedRepositories = [];
    for (const repository of current.repositories) {
      verifiedRepositories.push(await this.#verifyDeliveredRepository(repository));
    }
    const resultByName = new Map((Array.isArray(repositories) ? repositories : []).map((result) => [result.name, result]));
    const execution = this.database.completeAutomationExecution(
      taskId,
      token,
      threadId,
      verifiedRepositories.map((repository) => ({
        ...repository,
        validation: resultByName.get(repository.name)?.validation ?? null,
      })),
    );
    const cleanupFailures = [];
    for (const repository of execution.repositories) {
      try {
        await this.#cleanupRepository(repository, execution.worktreeRoot);
      } catch (error) {
        cleanupFailures.push({
          repository: repository.name,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (cleanupFailures.length > 0) {
      return this.database.markAutomationCleanupPending(taskId, cleanupFailures);
    }
    return this.database.finishAutomationCleanup(taskId);
  }

  #assertReleaseEnabled(execution) {
    const task = this.database.getTask(execution.taskId);
    const config = this.database.getProjectBoardConfig(execution.projectId).config;
    if (task?.delivery?.mode === "release" && !config.automation.releaseEnabled) {
      throw new ApiError(409, "AUTOMATION_RELEASE_DISABLED", "Release delivery is disabled in this project board configuration");
    }
  }

  async #claimTask({ project, task, slotNumber, repositories, workspacePath }) {
    const token = randomUUID();
    const safeProject = safeSegment(project.name || project.id);
    const safeTask = safeSegment(task.identifier);
    const worktreeRoot = path.join(path.dirname(workspacePath), ".taskboard-worktrees", safeProject, safeTask);
    const previousExecution = this.database.getTaskAutomationExecution(task.id);
    if (previousExecution?.phase === "paused_for_human") {
      return this.#reclaimPausedTask({
        project,
        task,
        slotNumber,
        token,
        repositories,
        previousExecution,
        workspacePath,
        worktreeRoot,
      });
    }

    const executionId = randomUUID();
    const created = [];
    try {
      for (const repository of repositories) {
        const worktreePath = path.join(worktreeRoot, safeSegment(repository.name));
        const taskBranch = `taskboard/${safeBranchSegment(project.id)}/${safeBranchSegment(task.identifier)}-${executionId.slice(0, 8)}`;
        await this.runGit(repository.repositoryPath, [
          "worktree",
          "add",
          "-b",
          taskBranch,
          worktreePath,
          repository.baseCommit,
        ]);
        const createdRepository = { ...repository, worktreePath, taskBranch, status: "working" };
        created.push(createdRepository);
        await this.#linkWorktreeDependencies({
          project,
          repository,
          worktreePath,
          dependencyCacheRoot: path.join(path.dirname(workspacePath), ".taskboard-dependency-cache"),
        });
      }
      return this.database.claimTaskForAutomation({
        executionId,
        token,
        projectId: project.id,
        taskId: task.id,
        taskVersion: task.version,
        expectedStatus: task.status,
        slotNumber,
        workspacePath,
        worktreeRoot,
        repositories: created,
      });
    } catch (error) {
      for (const repository of created.reverse()) {
        try {
          await this.#removeWorktreeDependencyMounts(repository);
          await this.runGit(repository.repositoryPath, ["worktree", "remove", "--force", repository.worktreePath]);
        } catch {
          await rm(repository.worktreePath, { recursive: true, force: true }).catch(() => {});
        }
        await this.runGit(repository.repositoryPath, ["branch", "-D", repository.taskBranch]).catch(() => {});
      }
      throw error;
    }
  }

  async #reclaimPausedTask({
    project,
    task,
    slotNumber,
    token,
    repositories,
    previousExecution,
    workspacePath,
    worktreeRoot,
  }) {
    if (!samePath(path.resolve(previousExecution.worktreeRoot), path.resolve(worktreeRoot))) {
      throw new ApiError(409, "WORKTREE_REUSE_MISMATCH", "The blocked task belongs to a different Worktree root");
    }
    const currentRepositories = new Map(repositories.map((repository) => [repository.name, repository]));
    for (const repository of previousExecution.repositories) {
      const current = currentRepositories.get(repository.name);
      if (!current || !samePath(current.repositoryPath, repository.repositoryPath) || current.targetBranch !== repository.targetBranch) {
        throw new ApiError(409, "WORKTREE_REUSE_MISMATCH", `Repository ${repository.name} no longer matches the blocked task`);
      }
      const [repositoryRoot, branch] = await Promise.all([
        this.runGit(repository.worktreePath, ["rev-parse", "--show-toplevel"]),
        this.runGit(repository.worktreePath, ["branch", "--show-current"]),
      ]);
      if (!samePath(path.resolve(repositoryRoot.trim()), path.resolve(repository.worktreePath))) {
        throw new ApiError(409, "WORKTREE_REUSE_INVALID", `${repository.worktreePath} is not the expected Worktree`);
      }
      if (branch.trim() !== repository.taskBranch) {
        throw new ApiError(409, "WORKTREE_BRANCH_MISMATCH", `Expected ${repository.taskBranch} in ${repository.worktreePath}`);
      }
    }
    await this.#linkExistingWorktreeDependencies({
      project,
      executions: [previousExecution],
      workspacePath,
    });
    return this.database.reclaimTaskForAutomation({
      taskId: task.id,
      taskVersion: task.version,
      executionId: previousExecution.id,
      slotNumber,
      token,
    });
  }

  #taskMatchesRepositoryBranches(task, repositories) {
    return (task.delivery?.repositories ?? []).every((target) => repositories.some((repository) => (
      repository.name === target.repositoryId && repository.targetBranch === target.targetBranch
    )));
  }

  async #verifyDeliveredRepository(repository) {
    const taskCommit = (await this.runGit(repository.worktreePath, ["rev-parse", "HEAD"])).trim();
    const changed = taskCommit !== repository.baseCommit;
    if (changed) {
      const changedPaths = (await this.runGit(repository.worktreePath, [
        "diff",
        "--name-only",
        repository.baseCommit,
        taskCommit,
      ])).trim().split(/\r?\n/).filter(Boolean).map((filePath) => ({ path: filePath }));
      const prohibitedPaths = prohibitedSubmissionPaths(changedPaths);
      if (prohibitedPaths.length > 0) {
        throw new ApiError(422, "AUTOMATION_STATIC_ARTIFACT", staticSubmissionError(prohibitedPaths), {
          paths: prohibitedPaths,
        });
      }
    }
    let upstream;
    try {
      upstream = (await this.runGit(repository.repositoryPath, [
        "rev-parse",
        "--abbrev-ref",
        `${repository.targetBranch}@{upstream}`,
      ])).trim();
    } catch {
      throw new ApiError(409, "TARGET_UPSTREAM_MISSING", `Target branch ${repository.targetBranch} has no upstream`);
    }
    await this.runGit(repository.repositoryPath, ["fetch", "--quiet"]);
    const remoteCommit = (await this.runGit(repository.repositoryPath, ["rev-parse", upstream])).trim();
    if (changed) {
      await this.runGit(repository.worktreePath, ["merge-base", "--is-ancestor", taskCommit, remoteCommit]);
      const remoteName = upstream.split("/")[0];
      const publishedTaskBranch = (await this.runGit(repository.repositoryPath, [
        "ls-remote",
        "--heads",
        remoteName,
        repository.taskBranch,
      ])).trim();
      if (publishedTaskBranch) {
        throw new ApiError(409, "TASK_BRANCH_PUBLISHED", `Temporary task branch ${repository.taskBranch} was pushed and will not be cleaned automatically`);
      }
      return {
        ...repository,
        taskCommit,
        mergedCommit: remoteCommit,
        pushedCommit: remoteCommit,
        status: "pushed",
      };
    }
    return {
      ...repository,
      taskCommit: null,
      mergedCommit: remoteCommit,
      pushedCommit: null,
      status: "unchanged",
    };
  }

  async #linkWorktreeDependencies({ project, repository, worktreePath, dependencyCacheRoot }) {
    if (await pathExists(path.join(repository.repositoryPath, "venv"))) {
      await copyOptionalFile(
        path.join(repository.repositoryPath, "local_settings.py"),
        path.join(worktreePath, "local_settings.py"),
      );
      await this.#linkWorktreeVirtualEnvironment(repository, worktreePath);
    }
    await copyOptionalFile(
      path.join(repository.repositoryPath, ".eslintrc-auto-import.json"),
      path.join(worktreePath, ".eslintrc-auto-import.json"),
    );
    const packageJsonPath = path.join(worktreePath, "package.json");
    const packageLockPath = path.join(worktreePath, "package-lock.json");
    if (!(await fileExists(packageJsonPath))) return;
    const dependencyManifestRoot = (await fileExists(packageLockPath))
      ? worktreePath
      : repository.repositoryPath;

    const worktreeNodeModules = path.join(worktreePath, "node_modules");
    if (await pathExists(worktreeNodeModules)) {
      const existing = await lstat(worktreeNodeModules);
      if (existing.isSymbolicLink() && await dependencyDirectoryIsUsable(dependencyManifestRoot, worktreeNodeModules)) return;
      await rm(worktreeNodeModules, { recursive: true, force: true });
    }

    const repositoryNodeModules = path.join(repository.repositoryPath, "node_modules");
    if (await dependencyDirectoryIsUsable(repository.repositoryPath, repositoryNodeModules)) {
      await this.#installWorktreeDependencies(
        repositoryNodeModules,
        worktreeNodeModules,
        worktreePath,
        repository.repositoryPath,
      );
      return;
    }
    const dependencyLockPath = path.join(dependencyManifestRoot, "package-lock.json");
    if (!(await fileExists(dependencyLockPath))) return;

    const lockContents = await readFile(dependencyLockPath);
    const lockHash = createHash("sha256").update(lockContents).digest("hex");
    const cacheDirectory = path.join(
      dependencyCacheRoot,
      safeSegment(project.name || project.id),
      safeSegment(repository.name),
      lockHash,
    );
    await this.#prepareDependencyCache(cacheDirectory, dependencyManifestRoot);
    await this.#installWorktreeDependencies(
      path.join(cacheDirectory, "node_modules"),
      worktreeNodeModules,
      worktreePath,
      dependencyManifestRoot,
    );
  }

  async #linkWorktreeVirtualEnvironment(repository, worktreePath) {
    const source = path.join(repository.repositoryPath, "venv");
    if (!(await pathExists(source))) return;
    if (!(await virtualEnvironmentIsUsable(source))) {
      throw new ApiError(409, "PYTHON_ENVIRONMENT_INVALID", `The parent virtual environment is incomplete: ${source}`);
    }

    const destination = path.join(worktreePath, "venv");
    if (await pathExists(destination)) {
      const existing = await lstat(destination);
      if (existing.isSymbolicLink() && await virtualEnvironmentIsUsable(destination)) return;
      await rm(destination, { recursive: true, force: true });
    }
    try {
      await this.linkDirectory(source, destination);
    } catch (error) {
      throw new ApiError(
        409,
        "PYTHON_ENVIRONMENT_PREPARATION_FAILED",
        `Cannot mount the parent virtual environment into ${worktreePath}: ${error.message}`,
      );
    }
    if (!(await virtualEnvironmentIsUsable(destination))) {
      throw new ApiError(409, "PYTHON_ENVIRONMENT_INVALID", `Virtual environment preparation is incomplete: ${destination}`);
    }
  }

  async #installWorktreeDependencies(source, destination, worktreePath, packageRoot = worktreePath) {
    try {
      await this.linkDirectory(source, destination);
    } catch (linkError) {
      throw new ApiError(
        409,
        "DEPENDENCY_PREPARATION_FAILED",
        `Cannot mount dependencies into ${worktreePath}: ${linkError.message}`,
      );
    }
    if (!(await dependencyDirectoryIsUsable(packageRoot, destination))) {
      throw new ApiError(409, "DEPENDENCY_CACHE_EMPTY", `Dependency preparation produced an empty node_modules for ${worktreePath}`);
    }
  }

  async #linkExistingWorktreeDependencies({ project, executions, workspacePath }) {
    const dependencyCacheRoot = path.join(path.dirname(workspacePath), ".taskboard-dependency-cache");
    for (const execution of executions) {
      for (const repository of execution.repositories) {
        await this.#linkWorktreeDependencies({
          project,
          repository,
          worktreePath: repository.worktreePath,
          dependencyCacheRoot,
        });
      }
    }
  }

  async #prepareExecutionEnvironment(execution) {
    const project = this.database.getProject(execution.projectId);
    if (!project) {
      throw new ApiError(404, "PROJECT_NOT_FOUND", `Project '${execution.projectId}' does not exist`);
    }
    const workspacePath = path.resolve(execution.workspacePath || project.workspacePath || "");
    if (!path.isAbsolute(workspacePath)) {
      throw new ApiError(400, "WORKSPACE_REQUIRED", "An absolute workspacePath is required to prepare an automation rerun");
    }
    await this.#linkExistingWorktreeDependencies({
      project,
      executions: [execution],
      workspacePath,
    });
  }

  async #prepareDependencyCache(cacheDirectory, worktreePath) {
    const existing = this.dependencyCachePromises.get(cacheDirectory);
    if (existing) return existing;

    const preparation = (async () => {
      const readyMarker = path.join(cacheDirectory, ".taskboard-ready");
      const cacheNodeModules = path.join(cacheDirectory, "node_modules");
      if ((await fileExists(readyMarker)) && (await dependencyDirectoryIsUsable(cacheDirectory, cacheNodeModules))) return;

      await rm(cacheDirectory, { recursive: true, force: true });
      await mkdir(cacheDirectory, { recursive: true });
      await Promise.all([
        copyFile(path.join(worktreePath, "package.json"), path.join(cacheDirectory, "package.json")),
        copyFile(path.join(worktreePath, "package-lock.json"), path.join(cacheDirectory, "package-lock.json")),
        copyOptionalFile(path.join(worktreePath, ".npmrc"), path.join(cacheDirectory, ".npmrc")),
        copyOptionalDirectory(path.join(worktreePath, "patches"), path.join(cacheDirectory, "patches")),
      ]);
      await this.runNpm(cacheDirectory);
      await mkdir(cacheNodeModules, { recursive: true });
      if (!(await dependencyDirectoryIsUsable(cacheDirectory, cacheNodeModules))) {
        throw new ApiError(409, "DEPENDENCY_CACHE_EMPTY", `Dependency installation produced an empty cache for ${worktreePath}`);
      }
      await writeFile(readyMarker, "ready\n", "utf8");
    })();
    this.dependencyCachePromises.set(cacheDirectory, preparation);
    try {
      await preparation;
    } finally {
      this.dependencyCachePromises.delete(cacheDirectory);
    }
  }

  async #isRepositoryRoot(candidate) {
    try {
      const actual = await this.runGit(candidate, ["rev-parse", "--show-toplevel"]);
      return samePath(await realpath(actual.trim()), await realpath(candidate));
    } catch {
      return false;
    }
  }

  async #inspectRepository(repositoryPath) {
    const [targetBranchRaw, statusRaw, baseCommitRaw] = await Promise.all([
      this.runGit(repositoryPath, ["branch", "--show-current"]),
      this.runGit(repositoryPath, ["status", "--porcelain"]),
      this.runGit(repositoryPath, ["rev-parse", "HEAD"]),
    ]);
    const targetBranch = targetBranchRaw.trim();
    if (!targetBranch) throw new ApiError(409, "GIT_DETACHED_HEAD", `${repositoryPath} is in detached HEAD state`);
    if (statusRaw.trim()) throw new ApiError(409, "GIT_WORKSPACE_DIRTY", `${repositoryPath} has uncommitted changes`);
    return {
      name: path.basename(repositoryPath),
      repositoryPath,
      targetBranch,
      baseCommit: baseCommitRaw.trim(),
    };
  }

  async #cleanupRepository(repository, worktreeRoot) {
    const resolvedWorktree = path.resolve(repository.worktreePath);
    const resolvedRoot = path.resolve(worktreeRoot);
    if (resolvedWorktree === resolvedRoot || !resolvedWorktree.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error(`Refusing to clean an unexpected worktree path: ${resolvedWorktree}`);
    }
    await this.#removeWorktreeDependencyMounts(repository);
    try {
      await this.runGit(repository.repositoryPath, ["worktree", "remove", "--force", resolvedWorktree]);
    } catch (error) {
      const registered = await this.runGit(repository.repositoryPath, ["worktree", "list", "--porcelain"]);
      const normalized = process.platform === "win32" ? resolvedWorktree.toLowerCase() : resolvedWorktree;
      const isRegistered = registered.split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => path.resolve(line.slice(9)))
        .some((candidate) => (process.platform === "win32" ? candidate.toLowerCase() : candidate) === normalized);
      if (isRegistered) throw error;
    }
    const branches = await this.runGit(repository.repositoryPath, ["branch", "--list", repository.taskBranch]);
    if (branches.trim()) await this.runGit(repository.repositoryPath, ["branch", "-D", repository.taskBranch]);
  }

  async #removeWorktreeDependencyMounts(repository) {
    const mounts = [path.join(repository.worktreePath, "node_modules"), path.join(repository.worktreePath, "venv")];
    for (const mount of mounts) {
      try {
        const details = await lstat(mount);
        if (details.isSymbolicLink()) await rm(mount, { recursive: true, force: true });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
}

function reviewEvaluationFailureReason(error) {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? ` (${error.code})`
    : "";
  return `风险审查无法安全确认变更范围${code}，请人工检查保留的 Worktree 后重新执行。`;
}

function assertSubmissionSnapshotAllowed(snapshot) {
  const prohibitedPaths = [...new Set([
    ...(Array.isArray(snapshot?.prohibitedPaths) ? snapshot.prohibitedPaths : []),
    ...prohibitedSubmissionPaths(snapshot?.files),
  ])].sort();
  if (prohibitedPaths.length === 0) return;
  throw new ApiError(422, "AUTOMATION_STATIC_ARTIFACT", staticSubmissionError(prohibitedPaths), {
    paths: prohibitedPaths,
  });
}

async function defaultRunGit(repositoryPath, args) {
  const safeDirectory = path.resolve(repositoryPath).replaceAll("\\", "/");
  const result = await execFileAsync("git", ["-c", `safe.directory=${safeDirectory}`, "-C", repositoryPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function defaultRunNpm(directory) {
  const npmArguments = ["ci", "--legacy-peer-deps", "--no-audit", "--no-fund"];
  if (process.platform === "win32") {
    await execFileAsync("cmd.exe", ["/d", "/s", "/c", "npm", ...npmArguments], { cwd: directory, windowsHide: true });
    return;
  }
  await execFileAsync("npm", npmArguments, { cwd: directory, windowsHide: true });
}

async function defaultLinkDirectory(source, destination) {
  await symlink(source, destination, "junction");
}

async function defaultCopyDirectory(source, destination) {
  await cp(source, destination, { recursive: true, dereference: true });
}

async function pathExists(candidate) {
  try {
    await lstat(candidate);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function fileExists(candidate) {
  try {
    return (await lstat(candidate)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function virtualEnvironmentIsUsable(venvPath) {
  const pythonPath = process.platform === "win32"
    ? path.join(venvPath, "Scripts", "python.exe")
    : path.join(venvPath, "bin", "python");
  return (await fileExists(path.join(venvPath, "pyvenv.cfg"))) && (await fileExists(pythonPath));
}

async function directoryExists(candidate) {
  try {
    return (await lstat(candidate)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function copyOptionalFile(source, destination) {
  if (await fileExists(source)) await copyFile(source, destination);
}

async function copyOptionalDirectory(source, destination) {
  if (await directoryExists(source)) await cp(source, destination, { recursive: true });
}

async function dependencyDirectoryIsUsable(packageRoot, nodeModules) {
  let entries;
  try {
    entries = await readdir(nodeModules);
  } catch {
    return false;
  }
  let packageLock;
  try {
    packageLock = JSON.parse(await readFile(path.join(packageRoot, "package-lock.json"), "utf8"));
  } catch {
    return false;
  }
  const packages = packageLock?.packages;
  const needsInstalledModules = packages && typeof packages === "object"
    ? Object.keys(packages).some((key) => key.startsWith("node_modules/"))
    : Object.keys(packageLock?.dependencies ?? {}).length > 0;
  if (!needsInstalledModules) return true;
  return entries.some((entry) => entry !== ".package-lock.json");
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function safeSegment(value) {
  return String(value).trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/[. ]+$/g, "").slice(0, 80) || "task";
}

function safeBranchSegment(value) {
  return String(value).trim().replace(/[^a-z0-9._-]+/gi, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 80) || "task";
}

export { ACTIVE_EXECUTION_PHASES };
