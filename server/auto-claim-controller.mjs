const RUNNABLE_PHASES = new Set(["working", "ready_to_merge", "merging"]);
const TERMINAL_THREAD_STATUSES = new Set(["completed", "failed", "interrupted"]);

export class AutoClaimController {
  constructor(options) {
    this.database = options.database;
    this.worktreeCoordinator = options.worktreeCoordinator;
    this.readSessionStatus = options.readSessionStatus ?? (async () => null);
    this.emit = options.emit ?? (() => {});
    this.timers = new Map();
    this.queues = new Map();
    this.closed = false;
  }

  start() {
    for (const policy of this.database.listAutomationPolicies()) {
      if (policy.enabledByUser) this.schedule(policy.projectId, 0);
    }
  }

  getState(projectId, concurrencyLimit) {
    const policy = this.database.getAutomationPolicy(projectId);
    return {
      policy,
      summary: this.worktreeCoordinator.summary(
        projectId,
        policy?.concurrencyLimit ?? concurrencyLimit ?? 6,
        policy?.lastError ?? null,
      ),
    };
  }

  applyPolicy(policy) {
    const saved = this.database.saveAutomationPolicy(policy);
    if (saved.enabledByUser && saved.quotaAllowsRun) this.schedule(saved.projectId, 0);
    else this.#clearTimer(saved.projectId);
    return this.getState(saved.projectId, saved.concurrencyLimit);
  }

  async reconcileProjectSessions(projectId) {
    const recoverable = this.database.listProjectAutomationExecutions(projectId)
      .filter((execution) => (
        RUNNABLE_PHASES.has(execution.phase)
        && execution.runOwnerThreadId
      ));
    for (const execution of recoverable) {
      await this.#reconcileExecutionSession(execution);
    }
    return {
      executions: this.database.listProjectAutomationExecutions(projectId, { activeOnly: true }),
    };
  }

  schedule(projectId, delay = 0) {
    if (this.closed) return;
    const policy = this.database.getAutomationPolicy(projectId);
    if (!policy?.enabledByUser || !policy.quotaAllowsRun) return;
    const previous = this.timers.get(projectId);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      void this.#enqueue(projectId);
    }, Math.max(0, delay));
    timer.unref();
    this.timers.set(projectId, timer);
  }

  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await Promise.allSettled(this.queues.values());
  }

  #enqueue(projectId) {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => this.#reconcile(projectId))
      .catch((error) => {
        this.database.setAutomationPolicyError(projectId, error instanceof Error ? error.message : String(error));
        this.emit("task.automation.session.error", { projectId, error: error.message });
      })
      .finally(() => {
        if (this.queues.get(projectId) === run) this.queues.delete(projectId);
        const policy = this.database.getAutomationPolicy(projectId);
        if (policy?.enabledByUser && policy.quotaAllowsRun) {
          this.schedule(projectId, this.#nextReconcileDelay(projectId, policy.intervalMinutes));
        }
      });
    this.queues.set(projectId, run);
    return run;
  }

  async #reconcile(projectId) {
    const policy = this.database.getAutomationPolicy(projectId);
    if (!policy?.enabledByUser || !policy.quotaAllowsRun) return;

    this.database.setAutomationPolicyError(projectId, null);
    await this.reconcileProjectSessions(projectId);
    await this.worktreeCoordinator.retryPendingCleanup(projectId);

    const resumed = await this.worktreeCoordinator.assignApprovedReviews(projectId, policy.concurrencyLimit);
    for (const execution of resumed) {
      this.emit("task.automation.updated", execution);
    }

    const summary = await this.worktreeCoordinator.fillProject({
      projectId,
      workspacePath: policy.workspacePath,
      concurrencyLimit: policy.concurrencyLimit,
    });
    for (const claim of summary.claimed ?? []) {
      this.emit("task.automation.updated", claim);
    }

    // Only the desktop injector may launch sessions, through native slot plans.
  }

  async #reconcileExecutionSession(execution) {
    const threadId = execution.runOwnerThreadId;
    const observed = await this.readSessionStatus(threadId);
    if (!TERMINAL_THREAD_STATUSES.has(observed?.status)) return;
    if (!(Date.parse(observed.timestamp) >= Date.parse(execution.runStartedAt))) return;
    if (execution.codexTurnId && observed.turnId !== execution.codexTurnId) return;
    const current = this.database.getTaskAutomationExecution(execution.taskId);
    if (!current || current.id !== execution.id || current.runOwnerThreadId !== threadId) return;
    if (!current.codexThreadId) this.database.adoptAutomationCodexThread(current.taskId, threadId);
    this.database.finishAutomationCodexThread(current.taskId, threadId, observed.status);
    if (RUNNABLE_PHASES.has(current.phase) && current.mergeRetryAt === null) {
      this.#moveToHuman(
        current,
        threadId,
        observed.status === "completed"
          ? "Codex 会话已结束，但任务仍处于开发中。"
          : `Codex 会话异常结束（${observed.status}）。`,
      );
    }
    this.emit("task.automation.session.completed", {
      projectId: execution.projectId,
      task: this.database.getTask(execution.taskId),
      execution: this.database.getTaskAutomationExecution(execution.taskId),
    });
    this.schedule(execution.projectId, 0);
  }

  #moveToHuman(execution, threadId, reason) {
    this.database.pauseAutomationForHuman(execution.taskId, threadId, reason);
    this.emit("task.automation.session.paused", {
      projectId: execution.projectId,
      task: this.database.getTask(execution.taskId),
      execution: this.database.getTaskAutomationExecution(execution.taskId),
    });
  }

  #clearTimer(projectId) {
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
  }

  #nextReconcileDelay(projectId, intervalMinutes) {
    const fallbackDelay = intervalMinutes * 60_000;
    const now = Date.now();
    const retryDelay = this.database.listProjectAutomationExecutions(projectId, { activeOnly: true })
      .map((execution) => execution.mergeRetryAt === null ? Number.POSITIVE_INFINITY : Date.parse(execution.mergeRetryAt) - now)
      .filter((delay) => Number.isFinite(delay) && delay > 0)
      .reduce((earliest, delay) => Math.min(earliest, delay), Number.POSITIVE_INFINITY);
    return Math.min(fallbackDelay, retryDelay);
  }
}
