import assert from "node:assert/strict";
import test from "node:test";

import { AutoClaimController } from "../server/auto-claim-controller.mjs";

test("the plan-based controller neither launches nor reinterprets Codex sessions", { timeout: 3_000 }, async () => {
  let execution = {
    id: "execution-1",
    projectId: "project-1",
    taskId: "task-1",
    slotNumber: 1,
    phase: "working",
    runOwnerThreadId: null,
    codexThreadId: "failed-thread",
    codexThreadStatus: "failed",
    codexTurnId: "failed-turn",
    mergeRetryAt: null,
  };
  let task = { id: "task-1", projectId: "project-1", status: "in_progress" };
  let pauseCalls = 0;
  let startCalls = 0;
  const emitted = [];
  let reconcileFinished;
  const reconciled = new Promise((resolve) => { reconcileFinished = resolve; });
  const policy = {
    projectId: "project-1",
    workspacePath: "D:\\workspace",
    concurrencyLimit: 1,
    intervalMinutes: 5,
    enabledByUser: true,
    quotaAllowsRun: true,
  };
  const database = {
    getAutomationPolicy: () => policy,
    setAutomationPolicyError: () => {},
    listProjectAutomationExecutions: (_projectId, options = {}) => (
      options.activeOnly && execution.phase === "paused_for_human" ? [] : [execution]
    ),
    getTaskAutomationExecution: () => execution,
    pauseAutomationForHuman: (_taskId, _threadId, reason) => {
      pauseCalls += 1;
      execution = { ...execution, phase: "paused_for_human", runOwnerThreadId: null, codexLastError: reason };
      task = { ...task, status: "blocked" };
      return execution;
    },
    getTask: () => task,
  };
  const worktreeCoordinator = {
    retryPendingCleanup: async () => {},
    assignApprovedReviews: async () => [],
    fillProject: async () => {
      reconcileFinished();
      return { occupied: 1, executions: [execution], claimed: [execution] };
    },
    summary: () => ({ occupied: 0, executions: [] }),
  };
  const sessions = {
    subscribe: () => () => {},
    startThread: async () => {
      startCalls += 1;
      throw new Error("failed execution must not be launched again");
    },
    close: async () => {},
  };
  const controller = new AutoClaimController({
    database,
    worktreeCoordinator,
    sessions,
    emit: (type, value) => emitted.push({ type, value }),
  });

  controller.schedule(policy.projectId, 0);
  await Promise.race([reconciled, new Promise((resolve) => setTimeout(resolve, 100))]);
  await controller.close();

  assert.equal(pauseCalls, 0);
  assert.equal(task.status, "in_progress");
  assert.equal(execution.phase, "working");
  assert.equal(startCalls, 0);
  assert.deepEqual(emitted, [{ type: "task.automation.updated", value: execution }]);
});

test("three native slots are reconciled independently without caching running status", async () => {
  const executions = [1, 2, 3].map((slot) => ({
    id: `execution-${slot}`, taskId: `task-${slot}`, projectId: "project-1",
    slotNumber: slot, phase: "working", runOwnerThreadId: `thread-${slot}`,
    codexThreadId: `thread-${slot}`, codexTurnId: `turn-${slot}`,
    codexThreadStatus: "running", mergeRetryAt: null,
    runStartedAt: "2026-09-11T01:00:00.000Z",
  }));
  const observations = new Map();
  const paused = [];
  const controller = new AutoClaimController({
    database: {
      getAutomationPolicy: () => null,
      listProjectAutomationExecutions: () => executions,
      getTaskAutomationExecution: (id) => executions.find((item) => item.taskId === id),
      getTask: (id) => ({ id }),
      finishAutomationCodexThread: (id, threadId, status) => {
        const execution = executions.find((item) => item.taskId === id);
        assert.equal(threadId, execution.runOwnerThreadId);
        execution.codexThreadStatus = status;
      },
      pauseAutomationForHuman: (id, threadId) => {
        const execution = executions.find((item) => item.taskId === id);
        assert.equal(threadId, execution.runOwnerThreadId);
        execution.phase = "paused_for_human";
        execution.runOwnerThreadId = null;
        paused.push(id);
      },
    },
    worktreeCoordinator: {},
    readSessionStatus: async (threadId) => observations.get(threadId) ?? null,
  });
  observations.set("thread-1", { status: "running" });
  observations.set("thread-2", { status: "notLoaded" });
  await controller.reconcileProjectSessions("project-1");
  assert.equal(paused.length, 0);

  observations.set("thread-1", {
    status: "interrupted", turnId: "turn-1", timestamp: "2026-09-11T01:10:00.000Z",
  });
  // A previous turn's terminal state must not end the current run.
  observations.set("thread-2", {
    status: "completed", turnId: "old-turn", timestamp: "2026-09-11T00:59:00.000Z",
  });
  await controller.reconcileProjectSessions("project-1");
  assert.deepEqual(paused, ["task-1"]);
  assert.equal(executions[1].runOwnerThreadId, "thread-2");
  assert.equal(executions[2].runOwnerThreadId, "thread-3");

  observations.set("thread-2", {
    status: "completed", turnId: "turn-2", timestamp: "2026-09-11T01:11:00.000Z",
  });
  // Approval has already released this slot; an old completed session is not a failure.
  executions[2].phase = "approval_granted";
  executions[2].runOwnerThreadId = null;
  observations.set("thread-3", {
    status: "completed", turnId: "turn-3", timestamp: "2026-09-11T01:12:00.000Z",
  });
  await controller.reconcileProjectSessions("project-1");
  await controller.reconcileProjectSessions("project-1");
  assert.deepEqual(paused, ["task-1", "task-2"]);
  assert.equal(executions[2].phase, "approval_granted");
  await controller.close();
});
