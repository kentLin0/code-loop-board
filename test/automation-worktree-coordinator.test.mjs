import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { TaskboardDatabase } from "../server/database.mjs";
import { TaskboardWorktreeCoordinator as BaseTaskboardWorktreeCoordinator } from "../server/taskboard-worktree-coordinator.mjs";

const run = promisify(execFile);

class TaskboardWorktreeCoordinator extends BaseTaskboardWorktreeCoordinator {
  constructor(options = {}) {
    super({
      riskReviewEvaluator: {
        async evaluate() {
          return {
            requiresApproval: false,
            reasons: [],
            repositories: [],
            files: [],
            totals: { files: 0, additions: 0, deletions: 0, changedLines: 0 },
          };
        },
      },
      ...options,
    });
  }
}

test("two repositories are isolated, pushed from their worktrees, and cleaned", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-"));
  const workspace = path.join(root, "sample-project");
  await mkdir(workspace);
  for (const name of ["backend", "frontend"]) await createRepository(path.join(workspace, name));

  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: workspace });
  const task = database.createTask({
    projectId: "sample",
    title: "Change both repositories",
    description: "",
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });

  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: workspace, concurrencyLimit: 2 });
  assert.equal(summary.occupied, 1);
  const claimed = database.getTask(task.id);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.automationExecution.repositories.length, 2);
  for (const repository of claimed.automationExecution.repositories) {
    assert.match(repository.worktreePath, /\.taskboard-worktrees[\\/]Sample[\\/]SAMPLE-1/);
    assert.equal((await git(repository.worktreePath, ["branch", "--show-current"])).trim(), repository.taskBranch);
    await writeFile(path.join(repository.worktreePath, "change.txt"), repository.name);
    await git(repository.worktreePath, ["add", "change.txt"]);
    await git(repository.worktreePath, ["commit", "-m", `change ${repository.name}`]);
    repository.taskCommit = (await git(repository.worktreePath, ["rev-parse", "HEAD"])).trim();
  }

  await coordinator.acquireRun(task.id, "codex-thread-main");
  const merging = await coordinator.acquireMerge(task.id, claimed.automationExecution.token, "codex-thread-main");
  assert.equal(merging.phase, "merging");
  for (const repository of merging.repositories) {
    await git(repository.worktreePath, ["push", "origin", `HEAD:${repository.targetBranch}`]);
  }
  const completed = await coordinator.complete(task.id, claimed.automationExecution.token, "codex-thread-main", merging.repositories);
  assert.equal(completed.phase, "completed");
  assert.equal(database.getTask(task.id).status, "in_review");
  assert.equal(database.getTask(task.id).developmentContext, null);
  for (const repository of completed.repositories) {
    await assert.rejects(readFile(path.join(repository.worktreePath, "change.txt")));
    const branches = await git(repository.repositoryPath, ["branch", "--list", repository.taskBranch]);
    assert.equal(branches.trim(), "");
  }
});

test("external issue release preparation moves the panel before the release transition", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-release-order-"));
  const workspace = path.join(root, "sample-project");
  await mkdir(workspace);
  for (const name of ["backend", "frontend"]) await createRepository(path.join(workspace, name));

  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: workspace });
  const task = database.createTask({
    projectId: "sample",
    title: "external issue release order",
    description: "Release task",
    externalIssue: { connectionId: "tracker", scopeId: "sample", externalId: "ISSUE-4001", key: "ISSUE-4001", url: "https://issues.example.test/ISSUE-4001" },
    delivery: { mode: "release", repositories: [{ repositoryId: "backend", targetBranch: "main" }, { repositoryId: "frontend", targetBranch: "main" }] },
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: workspace, concurrencyLimit: 1 });
  const claimed = database.getTask(task.id);
  await coordinator.acquireRun(task.id, "codex-thread-release-order");
  const merging = await coordinator.acquireMerge(task.id, claimed.automationExecution.token, "codex-thread-release-order");
  for (const repository of merging.repositories) {
    await writeFile(path.join(repository.worktreePath, "change.txt"), repository.name);
    await git(repository.worktreePath, ["add", "change.txt"]);
    await git(repository.worktreePath, ["commit", "-m", "release-order change"]);
    await git(repository.worktreePath, ["push", "origin", `HEAD:${repository.targetBranch}`]);
  }

  const prepared = await coordinator.prepareRelease(task.id, claimed.automationExecution.token, "codex-thread-release-order", []);
  assert.equal(prepared.phase, "merging");
  assert.equal(database.getTask(task.id).status, "pending_release");
  const completed = await coordinator.complete(task.id, claimed.automationExecution.token, "codex-thread-release-order", []);
  assert.equal(completed.phase, "completed");
  assert.equal(database.getTask(task.id).status, "pending_release");
});

test("a historical external issue release status reconciles a reclaimed task without blocking", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-release-reconcile-"));
  const workspace = path.join(root, "sample-project");
  await mkdir(workspace);
  for (const name of ["backend", "frontend"]) await createRepository(path.join(workspace, name));

  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: workspace });
  const task = database.createTask({
    projectId: "sample",
    title: "Reconcile released task",
    description: "Release task",
    externalIssue: { connectionId: "tracker", scopeId: "sample", externalId: "ISSUE-4002", key: "ISSUE-4002", url: "https://issues.example.test/ISSUE-4002" },
    delivery: { mode: "release", repositories: [{ repositoryId: "backend", targetBranch: "main" }, { repositoryId: "frontend", targetBranch: "main" }] },
    status: "todo",
    priority: "none",
    labels: [],
    threadId: null,
    actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: workspace, concurrencyLimit: 1 });
  const claimed = database.getTask(task.id);
  await coordinator.acquireRun(task.id, "codex-thread-release-reconcile");
  await coordinator.acquireMerge(task.id, claimed.automationExecution.token, "codex-thread-release-reconcile");
  const reconciled = await coordinator.reconcileRelease(
    task.id,
    claimed.automationExecution.token,
    "codex-thread-release-reconcile",
    "fixed",
  );
  assert.equal(reconciled.phase, "completed");
  assert.equal(database.getTask(task.id).status, "pending_release");
  assert.equal(database.listProjectAutomationExecutions("sample", { activeOnly: true }).length, 0);
});

test("a merge conflict blocks only its own task and can resume independently", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-pause-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Conflict", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const execution = database.getTask(task.id).automationExecution;
  await coordinator.acquireRun(task.id, "codex-thread-pause");
  await coordinator.acquireMerge(task.id, execution.token, "codex-thread-pause");
  const paused = coordinator.pauseMerge(task.id, execution.token, "codex-thread-pause", { reason: "semantic conflict", conflictFiles: ["file.txt"] });
  assert.equal(paused.phase, "paused_for_human");
  assert.equal(paused.runOwnerThreadId, null);
  assert.equal(database.getTask(task.id).status, "blocked");
  assert.equal((await coordinator.summary("sample")).mergePaused, false);
  const resumed = await coordinator.resumeMerge(task.id);
  assert.equal(resumed.phase, "merging");
  assert.equal(database.getTask(task.id).status, "in_progress");
  assert.equal((await coordinator.summary("sample")).mergePaused, false);
});

test("parallel worktrees rebase and push without a project merge queue", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-merge-retry-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const tasks = ["Parallel change one", "Parallel change two"].map((title) => database.createTask({
    projectId: "sample", title, description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  }));
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 2 });
  const executions = tasks.map((task) => database.getTask(task.id).automationExecution);
  for (const [index, execution] of executions.entries()) {
    const repository = execution.repositories[0];
    await writeFile(path.join(repository.worktreePath, `parallel-${index + 1}.txt`), `${index + 1}\n`);
    await git(repository.worktreePath, ["add", `parallel-${index + 1}.txt`]);
    await git(repository.worktreePath, ["commit", "-m", `parallel change ${index + 1}`]);
    await coordinator.acquireRun(tasks[index].id, `parallel-thread-${index + 1}`);
  }

  const merging = await Promise.all(executions.map((execution, index) => (
    coordinator.acquireMerge(tasks[index].id, execution.token, `parallel-thread-${index + 1}`)
  )));
  assert.deepEqual(merging.map((execution) => execution.phase), ["merging", "merging"]);

  const firstRepository = merging[0].repositories[0];
  const secondRepository = merging[1].repositories[0];
  await git(firstRepository.worktreePath, ["push", "origin", `HEAD:${firstRepository.targetBranch}`]);
  await assert.rejects(
    git(secondRepository.worktreePath, ["push", "origin", `HEAD:${secondRepository.targetBranch}`]),
    /rejected|fetch first|non-fast-forward/i,
  );
  await git(secondRepository.worktreePath, ["fetch", "origin"]);
  await git(secondRepository.worktreePath, ["rebase", `origin/${secondRepository.targetBranch}`]);
  await git(secondRepository.worktreePath, ["push", "origin", `HEAD:${secondRepository.targetBranch}`]);

  const firstCompleted = await coordinator.complete(tasks[0].id, executions[0].token, "parallel-thread-1", merging[0].repositories);
  const secondCompleted = await coordinator.complete(tasks[1].id, executions[1].token, "parallel-thread-2", merging[1].repositories);
  assert.equal(firstCompleted.phase, "completed");
  assert.equal(secondCompleted.phase, "completed");
  assert.deepEqual(tasks.map((task) => database.getTask(task.id).status), ["in_review", "in_review"]);
});

test("all configured slots claim distinct todo tasks", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-slots-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  for (let index = 0; index < 3; index += 1) {
    database.createTask({
      projectId: "sample", title: `Task ${index + 1}`, description: "", status: "todo", priority: "none", labels: [],
      threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
      assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
      developmentContext: null, dueDate: null, recurrence: null,
    });
  }
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  const initial = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  assert.equal(initial.occupied, 1);
  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 3 });
  assert.equal(summary.occupied, 3);
  assert.deepEqual(summary.executions.map((execution) => execution.slotNumber), [1, 2, 3]);
  assert.equal(new Set(summary.executions.map((execution) => execution.taskId)).size, 3);
  assert.equal(database.listTasks({ projectId: "sample", status: "todo", archived: "false" }).length, 0);
});

test("an unassigned in-progress task is claimed before a new todo task", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-priority-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const active = database.createTask({
    projectId: "sample", title: "Resume active task", description: "", status: "in_progress", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const todo = database.createTask({
    projectId: "sample", title: "New todo task", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });

  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });

  assert.equal(summary.occupied, 1);
  assert.equal(summary.executions[0].taskId, active.id);
  assert.equal(database.getTask(todo.id).status, "todo");
});

test("legacy paused failures shown as in-progress are reconciled to blocked", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-reconcile-paused-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Legacy paused failure", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const execution = database.getTask(task.id).automationExecution;
  await coordinator.acquireRun(task.id, "failed-thread");
  coordinator.failRun(task.id, execution.token, "failed-thread", "legacy failure");
  const blocked = database.getTask(task.id);
  database.moveTask(task.id, blocked.version, "in_progress");

  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });

  assert.equal(database.getTask(task.id).status, "blocked");
  assert.equal(database.getTask(task.id).automationExecution.phase, "paused_for_human");
});

test("only the first Codex task can run a claimed automation execution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-run-lock-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Prevent overlap", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });

  const first = await coordinator.acquireRun(task.id, "codex-thread-first");
  assert.equal(first.runOwnerThreadId, "codex-thread-first");
  assert.equal((await coordinator.acquireRun(task.id, "codex-thread-first")).id, first.id);
  await assert.rejects(
    () => coordinator.acquireRun(task.id, "codex-thread-overlap"),
    { code: "AUTOMATION_RUN_ACTIVE" },
  );
});

test("a failed automation moves its task to blocked and releases the slot", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-failed-run-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const tasks = ["Always fails", "Next task"].map((title) => database.createTask({
    projectId: "sample", title, description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  }));
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const execution = database.getTask(tasks[0].id).automationExecution;
  await coordinator.acquireRun(tasks[0].id, "failed-thread");

  const paused = coordinator.failRun(tasks[0].id, execution.token, "failed-thread", "Codex execution failed");

  assert.equal(database.getTask(tasks[0].id).status, "blocked");
  assert.equal(paused.phase, "paused_for_human");
  assert.equal(paused.runOwnerThreadId, null);
  const next = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  assert.equal(next.occupied, 1);
  assert.equal(next.executions[0].taskId, tasks[1].id);
});

test("rejecting automation review comments the reason and reopens a working execution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-review-rejection-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Review rejection", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const claimed = database.getTask(task.id);
  await coordinator.acquireRun(task.id, "review-thread");
  database.beginAutomationReview(task.id, claimed.automationExecution.token, "review-thread", {
    repositories: [],
    files: [],
    reasons: ["risk"],
    totals: { files: 0, additions: 0, deletions: 0, changedLines: 0 },
  });
  const review = database.getAutomationReview(task.id);
  const reason = "不得提交 static 构建文件";
  const rejected = database.rejectAutomationReview(
    task.id,
    review.id,
    review.version,
    { type: "user", id: "reviewer", name: "Reviewer", avatarUrl: null },
    reason,
  );

  assert.equal(rejected.status, "rejected");
  assert.equal(database.getTask(task.id).status, "blocked");
  assert.equal(database.getTaskAutomationExecution(task.id).phase, "working");
  assert.equal(database.getTaskAutomationExecution(task.id).runOwnerThreadId, null);
  assert.equal(database.getTaskAutomationExecution(task.id).error.reason, reason);
  assert.match(database.listComments(task.id).at(-1).body, new RegExp(`驳回理由：${reason}`));
});

test("automation merge refuses static build output before creating a review", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-static-output-"));
  const repositoryPath = path.join(root, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Static output", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({
    database,
    riskReviewEvaluator: {
      async evaluate() {
        return {
          requiresApproval: true,
          reasons: ["static output"],
          repositories: [],
          files: [{ path: "static/dist/index.js" }],
          prohibitedPaths: ["static/dist/index.js"],
          totals: { files: 1, additions: 1, deletions: 0, changedLines: 1 },
        };
      },
    },
  });
  await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const execution = database.getTask(task.id).automationExecution;
  await coordinator.acquireRun(task.id, "static-thread");

  await assert.rejects(
    () => coordinator.acquireMerge(task.id, execution.token, "static-thread"),
    { code: "AUTOMATION_STATIC_ARTIFACT" },
  );
  assert.equal(database.getTaskAutomationExecution(task.id).phase, "working");
  assert.equal(database.getAutomationReview(task.id), null);
});

test("moving a blocked task back to todo reuses its existing worktree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-reclaim-"));
  const workspacePath = path.join(root, "workspace");
  const repositoryPath = path.join(workspacePath, "repo");
  await createRepository(repositoryPath);
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath });
  const task = database.createTask({
    projectId: "sample", title: "Retry blocked work", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({ database });
  await coordinator.fillProject({ projectId: "sample", workspacePath, concurrencyLimit: 1 });
  const original = database.getTask(task.id).automationExecution;
  const worktreePath = original.repositories[0].worktreePath;
  await writeFile(path.join(worktreePath, "preserved.txt"), "keep this change\n");
  await coordinator.acquireRun(task.id, "failed-thread");
  coordinator.failRun(task.id, original.token, "failed-thread", "retry after manual intervention");
  await createRepository(path.join(workspacePath, "new-repository"));
  const blockedTask = database.getTask(task.id);
  database.moveTask(task.id, blockedTask.version, "todo");

  const reclaimed = await coordinator.fillProject({ projectId: "sample", workspacePath, concurrencyLimit: 1 });

  assert.equal(reclaimed.error, undefined);
  assert.equal(reclaimed.occupied, 1);
  const execution = database.getTask(task.id).automationExecution;
  assert.equal(execution.id, original.id);
  assert.notEqual(execution.token, original.token);
  assert.equal(execution.phase, "working");
  assert.equal(execution.slotNumber, 1);
  assert.equal(execution.codexThreadId, null);
  assert.equal(execution.codexThreadStatus, null);
  assert.equal(execution.repositories.length, 1);
  assert.equal(execution.repositories[0].worktreePath, worktreePath);
  assert.equal(await readFile(path.join(worktreePath, "preserved.txt"), "utf8"), "keep this change\n");
});

test("repositories prepare node_modules from manifests regardless of their names", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-backend-dependencies-"));
  const repositoryPath = path.join(root, "backend");
  await createRepository(repositoryPath, {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "backend", version: "1.0.0", dependencies: { sample: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      name: "backend",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "backend", version: "1.0.0", dependencies: { sample: "1.0.0" } },
        "node_modules/sample": { version: "1.0.0" },
      },
    }),
  });
  await mkdir(path.join(repositoryPath, "node_modules", "sample"), { recursive: true });
  await writeFile(path.join(repositoryPath, "node_modules", "sample", "package.json"), "{}\n");
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  database.createTask({
    projectId: "sample", title: "Prepare declared Node dependencies", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });

  const coordinator = new TaskboardWorktreeCoordinator({ database });
  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });

  assert.equal(summary.occupied, 1, summary.error);
  const dependencyPath = path.join(summary.executions[0].repositories[0].worktreePath, "node_modules");
  assert.equal((await lstat(dependencyPath)).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(dependencyPath, "sample", "package.json"), "utf8"), "{}\n");
});

test("a backend worktree mounts the parent virtual environment", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-backend-venv-copy-"));
  const repositoryPath = path.join(root, "backend");
  await createRepository(repositoryPath, { ".gitignore": "venv/\n" });
  const sourceVenv = path.join(repositoryPath, "venv");
  const pythonDirectory = path.join(sourceVenv, process.platform === "win32" ? "Scripts" : "bin");
  const pythonExecutable = path.join(pythonDirectory, process.platform === "win32" ? "python.exe" : "python");
  await mkdir(pythonDirectory, { recursive: true });
  await writeFile(path.join(sourceVenv, "pyvenv.cfg"), "home = test\n");
  await writeFile(pythonExecutable, "test\n");

  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Use backend venv", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({
    database,
    runNpm: async () => assert.fail("backend venv preparation must not run npm"),
  });

  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const execution = database.getTask(task.id).automationExecution;
  const destinationVenv = path.join(execution.repositories[0].worktreePath, "venv");

  assert.equal(summary.occupied, 1, summary.error);
  assert.equal((await lstat(destinationVenv)).isSymbolicLink(), true);
  assert.equal(await realpath(destinationVenv), await realpath(sourceVenv));
  assert.equal(await readFile(path.join(destinationVenv, "pyvenv.cfg"), "utf8"), "home = test\n");
  await coordinator.acquireRun(task.id, "codex-thread-backend-cleanup");
  await coordinator.acquireMerge(task.id, execution.token, "codex-thread-backend-cleanup");
  await coordinator.complete(task.id, execution.token, "codex-thread-backend-cleanup", []);
  assert.equal(await readFile(pythonExecutable, "utf8"), "test\n");
});

test("acquiring a rerun repairs dependencies in existing frontend and backend worktrees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-rerun-environment-"));
  const workspace = path.join(root, "workspace");
  const frontendPath = path.join(workspace, "frontend");
  const backendPath = path.join(workspace, "backend");
  await mkdir(workspace);
  await createRepository(frontendPath, {
    ".gitignore": "node_modules/\n.eslintrc-auto-import.json\n",
    "package.json": JSON.stringify({ name: "frontend", version: "1.0.0", dependencies: { sample: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      name: "frontend",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "frontend", version: "1.0.0", dependencies: { sample: "1.0.0" } },
        "node_modules/sample": { version: "1.0.0" },
      },
    }),
  });
  await writeFile(path.join(frontendPath, ".eslintrc-auto-import.json"), "{\"globals\":{\"generated\":true}}\n");
  await mkdir(path.join(frontendPath, "node_modules", "sample"), { recursive: true });
  await writeFile(path.join(frontendPath, "node_modules", "sample", "package.json"), "{}\n");

  await createRepository(backendPath, { ".gitignore": "venv/\nlocal_settings.py\n" });
  await writeFile(path.join(backendPath, "local_settings.py"), "DATABASES = {\"default\": {\"NAME\": \"local-test\"}}\n");
  const sourceVenv = path.join(backendPath, "venv");
  const sourcePython = path.join(
    sourceVenv,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  await mkdir(path.dirname(sourcePython), { recursive: true });
  await writeFile(path.join(sourceVenv, "pyvenv.cfg"), "home = test\n");
  await writeFile(sourcePython, "test\n");

  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: workspace });
  const task = database.createTask({
    projectId: "sample", title: "Repair a previously blocked worktree", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({
    database,
    runNpm: async (directory) => {
      await mkdir(path.join(directory, "node_modules", "sample"), { recursive: true });
      await writeFile(path.join(directory, "node_modules", "sample", "package.json"), "{}\n");
    },
  });
  await coordinator.fillProject({ projectId: "sample", workspacePath: workspace, concurrencyLimit: 1 });
  const execution = database.getTask(task.id).automationExecution;
  const frontendWorktree = execution.repositories.find((repository) => repository.name === "frontend").worktreePath;
  const backendWorktree = execution.repositories.find((repository) => repository.name === "backend").worktreePath;
  await rm(path.join(frontendWorktree, "node_modules"), { recursive: true, force: true });
  await rm(path.join(frontendWorktree, ".eslintrc-auto-import.json"), { force: true });
  await rm(path.join(frontendWorktree, "package-lock.json"), { force: true });
  await rm(path.join(frontendPath, "node_modules"), { recursive: true, force: true });
  await rm(path.join(backendWorktree, "venv"), { recursive: true, force: true });
  await rm(path.join(backendWorktree, "local_settings.py"), { force: true });

  await coordinator.acquireRun(task.id, "codex-thread-rerun");

  assert.equal(await readFile(path.join(frontendWorktree, "node_modules", "sample", "package.json"), "utf8"), "{}\n");
  assert.equal(
    await readFile(path.join(frontendWorktree, ".eslintrc-auto-import.json"), "utf8"),
    "{\"globals\":{\"generated\":true}}\n",
  );
  assert.equal(await readFile(path.join(backendWorktree, "venv", "pyvenv.cfg"), "utf8"), "home = test\n");
  assert.equal(
    await readFile(path.join(backendWorktree, "local_settings.py"), "utf8"),
    "DATABASES = {\"default\": {\"NAME\": \"local-test\"}}\n",
  );
});

test("a worktree mounts the parent node_modules", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-dependency-copy-"));
  const repositoryPath = path.join(root, "frontend");
  await createRepository(repositoryPath, {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "frontend", version: "1.0.0", dependencies: { sample: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      name: "frontend",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "frontend", version: "1.0.0", dependencies: { sample: "1.0.0" } },
        "node_modules/sample": { version: "1.0.0" },
      },
    }),
  });
  await mkdir(path.join(repositoryPath, "node_modules", "sample"), { recursive: true });
  await writeFile(path.join(repositoryPath, "node_modules", "sample", "package.json"), "{}\n");
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  database.createTask({
    projectId: "sample", title: "Copy dependencies", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });

  const coordinator = new TaskboardWorktreeCoordinator({
    database,
    runNpm: async () => {
      throw new Error("npm must not run when parent dependencies are available");
    },
  });
  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  assert.equal(summary.occupied, 1, summary.error);
  const worktreeNodeModules = path.join(summary.executions[0].repositories[0].worktreePath, "node_modules");
  assert.equal((await lstat(worktreeNodeModules)).isSymbolicLink(), true);
  assert.equal(await realpath(worktreeNodeModules), await realpath(path.join(repositoryPath, "node_modules")));
  assert.equal(JSON.parse(await readFile(path.join(worktreeNodeModules, "sample", "package.json"), "utf8")) instanceof Object, true);
});

test("worktrees with the same package lock reuse one prepared dependency directory", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-dependencies-"));
  const repositoryPath = path.join(root, "frontend");
  await createRepository(repositoryPath, {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "frontend", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({
      name: "frontend",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "frontend", version: "1.0.0" } },
    }),
  });
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  for (let index = 0; index < 2; index += 1) {
    database.createTask({
      projectId: "sample", title: `Dependency task ${index + 1}`, description: "", status: "todo", priority: "none", labels: [],
      threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
      assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
      developmentContext: null, dueDate: null, recurrence: null,
    });
  }

  let installs = 0;
  const coordinator = new TaskboardWorktreeCoordinator({
    database,
    runNpm: async (directory) => {
      installs += 1;
      await mkdir(path.join(directory, "node_modules"), { recursive: true });
    },
  });
  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 2 });
  assert.equal(summary.occupied, 2, summary.error);
  const nodeModules = summary.executions.map((execution) => path.join(execution.repositories[0].worktreePath, "node_modules"));
  const resolved = await Promise.all(nodeModules.map((directory) => realpath(directory)));

  assert.equal(installs, 1);
  assert.equal(new Set(resolved).size, 1);
  assert.match(resolved[0], /\.taskboard-dependency-cache[\\/]Sample[\\/]frontend[\\/][a-f0-9]{64}[\\/]node_modules$/);
});

test("an empty dependency cache with a ready marker is rebuilt for existing worktrees", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-empty-cache-"));
  const repositoryPath = path.join(root, "frontend");
  await createRepository(repositoryPath, {
    "package.json": JSON.stringify({ name: "frontend", version: "1.0.0", dependencies: { sample: "1.0.0" } }),
    "package-lock.json": JSON.stringify({
      name: "frontend",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "frontend", version: "1.0.0", dependencies: { sample: "1.0.0" } },
        "node_modules/sample": { version: "1.0.0" },
      },
    }),
  });
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  database.createTask({
    projectId: "sample", title: "Repair empty cache", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });

  const install = async (directory) => {
    await mkdir(path.join(directory, "node_modules", "sample"), { recursive: true });
    await writeFile(path.join(directory, "node_modules", "sample", "package.json"), "{}\n");
  };
  const initial = await new TaskboardWorktreeCoordinator({ database, runNpm: install })
    .fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const worktreeNodeModules = path.join(initial.executions[0].repositories[0].worktreePath, "node_modules");
  const cacheRepositoryRoot = path.join(root, ".taskboard-dependency-cache", "Sample", "frontend");
  const [lockHash] = await readdir(cacheRepositoryRoot);
  const cacheNodeModules = path.join(cacheRepositoryRoot, lockHash, "node_modules");
  await rm(cacheNodeModules, { recursive: true, force: true });
  await mkdir(cacheNodeModules, { recursive: true });
  await rm(worktreeNodeModules, { recursive: true, force: true });

  let repairs = 0;
  const repaired = await new TaskboardWorktreeCoordinator({
    database,
    runNpm: async (directory) => {
      repairs += 1;
      await install(directory);
    },
  }).fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });

  assert.equal(repaired.occupied, 1);
  assert.equal(repairs, 1);
  assert.equal(JSON.parse(await readFile(path.join(worktreeNodeModules, "sample", "package.json"), "utf8")) instanceof Object, true);
});

test("cleaning a worktree unmounts dependencies before git removes it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-dependency-cleanup-"));
  const repositoryPath = path.join(root, "frontend");
  await createRepository(repositoryPath, {
    ".gitignore": "node_modules/\n",
    "package.json": JSON.stringify({ name: "frontend", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({ name: "frontend", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "frontend", version: "1.0.0" } } }),
  });
  const parentNodeModules = path.join(repositoryPath, "node_modules");
  await mkdir(path.join(parentNodeModules, "sample"), { recursive: true });
  await writeFile(path.join(parentNodeModules, "sample", "marker.txt"), "keep\n");
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  const task = database.createTask({
    projectId: "sample", title: "Cleanup cache", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });
  const coordinator = new TaskboardWorktreeCoordinator({
    database,
    runNpm: async () => assert.fail("npm must not run when parent dependencies are available"),
  });
  const summary = await coordinator.fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });
  const execution = database.getTask(task.id).automationExecution;
  assert.equal(await realpath(path.join(execution.repositories[0].worktreePath, "node_modules")), await realpath(parentNodeModules));
  await coordinator.acquireRun(task.id, "codex-thread-cleanup");
  await coordinator.acquireMerge(task.id, execution.token, "codex-thread-cleanup");
  const completed = await coordinator.complete(task.id, execution.token, "codex-thread-cleanup", []);

  assert.equal(completed.phase, "completed");
  assert.equal(await readFile(path.join(parentNodeModules, "sample", "marker.txt"), "utf8"), "keep\n");
});

test("the default dependency preparation runs npm for a locked worktree", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-worktrees-default-npm-"));
  const repositoryPath = path.join(root, "frontend");
  await createRepository(repositoryPath, {
    "package.json": JSON.stringify({ name: "frontend", version: "1.0.0" }),
    "package-lock.json": JSON.stringify({ name: "frontend", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "frontend", version: "1.0.0" } } }),
  });
  const database = new TaskboardDatabase(path.join(root, "data", "taskboard.db"));
  t.after(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  database.createProject({ id: "sample", name: "Sample", workspacePath: repositoryPath });
  database.createTask({
    projectId: "sample", title: "Default npm", description: "", status: "todo", priority: "none", labels: [],
    threadId: null, actor: { type: "user", id: "u", name: "User", avatarUrl: null },
    assignee: { type: "user", id: "u", name: "User", avatarUrl: null }, workflowId: null,
    developmentContext: null, dueDate: null, recurrence: null,
  });

  const summary = await new TaskboardWorktreeCoordinator({ database })
    .fillProject({ projectId: "sample", workspacePath: repositoryPath, concurrencyLimit: 1 });

  assert.equal(summary.occupied, 1, summary.error);
  assert.equal((await lstat(path.join(summary.executions[0].repositories[0].worktreePath, "node_modules"))).isSymbolicLink(), true);
});

async function createRepository(directory, files = {}) {
  const bareRemote = `${directory}-remote.git`;
  await mkdir(bareRemote, { recursive: true });
  await git(bareRemote, ["init", "--bare"]);
  await mkdir(directory, { recursive: true });
  await git(directory, ["init", "-b", "main"]);
  await git(directory, ["config", "user.name", "Taskboard Test"]);
  await git(directory, ["config", "user.email", "taskboard@example.test"]);
  await writeFile(path.join(directory, "README.md"), "initial\n");
  for (const [relativePath, content] of Object.entries(files)) {
    const file = path.join(directory, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  await git(directory, ["add", "README.md", ...Object.keys(files)]);
  await git(directory, ["commit", "-m", "initial"]);
  await git(directory, ["remote", "add", "origin", bareRemote]);
  await git(directory, ["push", "-u", "origin", "main"]);
}

async function git(directory, args) {
  const result = await run("git", ["-C", directory, ...args], { encoding: "utf8", windowsHide: true });
  return result.stdout;
}
