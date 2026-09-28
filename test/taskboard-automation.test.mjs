import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildTaskboardAutomationName,
  buildTaskboardAutomationPrompt,
  buildTaskboardAutomationSpec,
  canScheduleTaskboardAutomationExecution,
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
  selectTaskboardAutomationTasks,
} from "../shared/taskboard-automation.mjs";
import * as taskboardAutomation from "../shared/taskboard-automation.mjs";
import {
  AUTOMATION_MODELS,
  isSupportedModelEffort,
  withAutomationModel,
} from "../shared/taskboard-automation-options.mjs";

const baseRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "iframe-request-1",
  operation: "ensure-active",
  taskboardProjectId: "ppt-skill",
  codexProjectId: "codex-project-123",
  projectName: "PPT Skill",
  workspacePath: "/Users/example/Documents/ppt-skill",
  skillPath: "/Users/example/taskboard/skills/code-loop-board/SKILL.md",
  enabledByUser: true,
  quotaAware: false,
  concurrencyLimit: 6,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

test("automation selection fills the configured free slots with distinct todo tasks", () => {
  assert.equal(typeof selectTaskboardAutomationTasks, "function");
  assert.deepEqual(selectTaskboardAutomationTasks([
    {
      identifier: "LOCAL-1",
      title: "Current task",
      description: "",
      status: "in_progress",
    },
    {
      identifier: "LOCAL-2",
      title: "Next task",
      description: "",
      status: "todo",
    },
    {
      identifier: "LOCAL-3",
      title: "Another task",
      description: "",
      status: "todo",
    },
  ], 3, null), [
    { identifier: "LOCAL-2", title: "Next task", externalIssue: null, delivery: { mode: "review", repositories: [] } },
    { identifier: "LOCAL-3", title: "Another task", externalIssue: null, delivery: { mode: "review", repositories: [] } },
  ]);
  assert.deepEqual(selectTaskboardAutomationTasks([
    { identifier: "LOCAL-1", title: "Current", description: "", status: "in_progress" },
    { identifier: "LOCAL-2", title: "Waiting", description: "", status: "todo" },
  ], 1, null), []);
});

test("an execution owned by a Codex task does not schedule another automatic conversation", () => {
  assert.equal(canScheduleTaskboardAutomationExecution({ runOwnerThreadId: null }), true);
  assert.equal(canScheduleTaskboardAutomationExecution({ runOwnerThreadId: "running-thread" }), false);
});

test("a rejected automation run carries its reason into the next Codex session", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    slotNumber: 1,
    selectedTask: {
      identifier: "LOCAL-REJECTED-1",
      title: "Retry rejected task",
      automationExecution: {
        id: "execution-rejected-1",
        slotNumber: 1,
        token: "execution-token-rejected-1",
        phase: "working",
        error: { reason: "不得提交 static 构建文件", source: "automation_review" },
        repositories: [],
      },
    },
  });

  assert.match(prompt, /人工审批驳回/);
  assert.match(prompt, /不得提交 static 构建文件/);
});

test("an approved external issue merge run prepares taskboard before moving external issue", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    slotNumber: 4,
    selectedTask: {
      identifier: "LOCAL-43",
      title: "[ISSUE-3137] Approved external issue defect",
      externalIssue: { connectionId: "tracker", scopeId: "sample", externalId: "ISSUE-3137", key: "ISSUE-3137", url: "https://issues.example.test/bug/3137" },
      delivery: { mode: "release", repositories: [{ repositoryId: "service", targetBranch: "release/2" }] },
      automationExecution: {
        id: "execution-43",
        slotNumber: 4,
        token: "execution-token-43",
        phase: "ready_to_merge",
        repositories: [],
      },
    },
  });

  assert.match(prompt, /项目 ID：ppt-skill/);
  assert.match(prompt, /"integration", "action", "LOCAL-43", "--action", "mark_fixed"/);
  assert.match(prompt, /state\.semantic=fixed/);
  assert.match(prompt, /前端可以运行项目现有 build 命令作为验证/);
  assert.match(prompt, /构建产物不得暂存、提交或 push/);
  assert.ok(prompt.indexOf('runClb(["automation", "prepare-release"') >= 0);
  assert.ok(
    prompt.indexOf('runClb(["automation", "prepare-release"')
      < prompt.indexOf('"--action", "mark_fixed"'),
  );
  assert.ok(
    prompt.indexOf('"--action", "mark_fixed"')
      < prompt.indexOf('runClb(["automation", "complete"'),
  );
});

test("a new external issue run keeps the external defect in development before any code delivery", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    slotNumber: 1,
    selectedTask: {
      identifier: "LOCAL-NEW-RELEASE",
      title: "New external issue defect",
      externalIssue: { connectionId: "tracker", scopeId: "sample", externalId: "ISSUE-3139", key: "ISSUE-3139", url: "https://issues.example.test/bug/3139" },
      delivery: { mode: "release", repositories: [{ repositoryId: "service", targetBranch: "release/2" }] },
      automationExecution: {
        id: "execution-new-release",
        slotNumber: 1,
        token: "execution-token-new-release",
        phase: "working",
        repositories: [],
      },
    },
  });

  const statusIndex = prompt.indexOf('"--action", "start_work"');
  const tddIndex = prompt.indexOf("执行 Skill 的自动认领验证规则");
  const mergeIndex = prompt.indexOf('runClb(["automation", "acquire-merge"');
  const pushIndex = prompt.indexOf("全部目标分支 push 成功");
  assert.ok(statusIndex >= 0);
  assert.ok(statusIndex < tddIndex);
  assert.ok(statusIndex < mergeIndex);
  assert.ok(statusIndex < pushIndex);
});

test("a historical external issue release status is reconciled instead of blocking a retry", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    slotNumber: 1,
    selectedTask: {
      identifier: "LOCAL-REJECTED-RELEASE",
      title: "Rejected task with released external issue status",
      externalIssue: { connectionId: "tracker", scopeId: "sample", externalId: "ISSUE-3138", key: "ISSUE-3138", url: "https://issues.example.test/bug/3138" },
      delivery: { mode: "release", repositories: [{ repositoryId: "service", targetBranch: "release/2" }] },
      automationExecution: {
        id: "execution-rejected-release",
        slotNumber: 1,
        token: "execution-token-rejected-release",
        phase: "working",
        error: { reason: "review rejected", source: "automation_review" },
        repositories: [],
      },
    },
  });

  assert.match(prompt, /"--observed-status", "fixed"/);
  assert.match(prompt, /automation", "reconcile-release/);
  assert.doesNotMatch(prompt, /状态流转失败.*automation fail/);
});

test("a running approved merge automation can be paused by its configured slot id", async () => {
  const approvedRequest = {
    ...baseRequest,
    slotNumber: 4,
    selectedTask: {
      identifier: "LOCAL-43",
      title: "[ISSUE-3137] Approved external issue defect",
      automationExecution: {
        id: "execution-43",
        slotNumber: 4,
        token: "execution-token-43",
        phase: "ready_to_merge",
        repositories: [],
      },
    },
  };
  const existing = {
    id: "slot-4",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec(approvedRequest),
  };
  const calls = [];

  const paused = await reconcileTaskboardAutomation(
    {
      ...baseRequest,
      operation: "pause",
      slotNumber: 4,
      automationId: existing.id,
    },
    async (method, params) => {
      calls.push({ method, params });
      if (method === "list-automations") return { items: [existing] };
      return { item: params };
    },
  );

  assert.equal(calls[1]?.method, "automation-update");
  assert.equal(calls[1]?.params.id, existing.id);
  assert.equal(calls[1]?.params.status, "PAUSED");
  assert.equal(paused.item.status, "PAUSED");
});

test("automation selection carries structured source and repository bindings into the generated prompt", () => {
  const externalIssue = { connectionId: "tracker", scopeId: "sample", externalId: "3052", key: "ISSUE-3052", url: "https://issues.example.test/3052" };
  const delivery = { mode: "release", repositories: [{ repositoryId: "service", targetBranch: "release/2" }] };
  const task = { identifier: "LOCAL-3", title: "Repair issue", description: "Ordinary editable description", status: "todo", externalIssue, delivery };
  const repositories = [{ name: "service", targetBranch: "release/2" }];
  const selectedTask = taskboardAutomation.selectNextTaskboardAutomationTask([task], repositories);
  assert.deepEqual(selectedTask, { identifier: task.identifier, title: task.title, externalIssue, delivery });
  assert.equal(taskboardAutomation.selectNextTaskboardAutomationTask([task], [{ name: "service", targetBranch: "main" }]), null);
  assert.equal(taskboardAutomation.selectNextTaskboardAutomationTask([task], []), null);
  const prompt = buildTaskboardAutomationPrompt({ ...baseRequest, selectedTask });
  assert.ok(prompt.includes(JSON.stringify(externalIssue)));
  assert.match(prompt, /"integration", "action", "LOCAL-3", "--action", "start_work"/);
  assert.doesNotMatch(prompt, /--credentials-path/);
});

test("the automation model catalog matches Codex and normalizes unsupported efforts", () => {
  assert.deepEqual(AUTOMATION_MODELS, [
    {
      label: "6 Astra",
      slug: "gpt-6-astra",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      label: "5.6 Sol",
      slug: "gpt-5.6-sol",
      defaultEffort: "low",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      label: "5.6 Terra",
      slug: "gpt-5.6-terra",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      label: "5.6 Luna",
      slug: "gpt-5.6-luna",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      label: "5.5",
      slug: "gpt-5.5",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      label: "5.4",
      slug: "gpt-5.4",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh"],
    },
    {
      label: "5.4 Mini",
      slug: "gpt-5.4-mini",
      defaultEffort: "medium",
      efforts: ["low", "medium", "high", "xhigh"],
    },
  ]);

  const current = {
    status: "ACTIVE",
    intervalMinutes: 5,
    model: "gpt-5.6-sol",
    reasoningEffort: "ultra",
  };
  assert.deepEqual(withAutomationModel(current, "gpt-5.6-terra"), {
    ...current,
    model: "gpt-5.6-terra",
  });
  assert.deepEqual(withAutomationModel(current, "gpt-5.6-luna"), {
    ...current,
    model: "gpt-5.6-luna",
    reasoningEffort: "medium",
  });
});

test("the automation host request accepts only whitelisted project automation options", () => {
  assert.deepEqual(parseTaskboardAutomationHostRequest(baseRequest), baseRequest);
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, operation: "delete" }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, method: "automation-delete" }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, prompt: "arbitrary" }),
    null,
  );
  assert.deepEqual(
    parseTaskboardAutomationHostRequest({ ...baseRequest, intervalMinutes: 10 }),
    { ...baseRequest, intervalMinutes: 10 },
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, intervalMinutes: 7 }),
    null,
  );
  for (const concurrencyLimit of [1, 6, 12]) {
    assert.equal(
      parseTaskboardAutomationHostRequest({ ...baseRequest, concurrencyLimit })?.concurrencyLimit,
      concurrencyLimit,
    );
  }
  for (const concurrencyLimit of [0, 13, 1.5, "6", null]) {
    assert.equal(
      parseTaskboardAutomationHostRequest({ ...baseRequest, concurrencyLimit }),
      null,
    );
  }
  assert.equal(
    parseTaskboardAutomationHostRequest({
      ...baseRequest,
      model: "gpt-5.6-sol",
      reasoningEffort: "ultra",
    })?.reasoningEffort,
    "ultra",
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, model: "gpt-future" }),
    null,
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, reasoningEffort: "xhigh" })?.reasoningEffort,
    "xhigh",
  );
  assert.equal(
    parseTaskboardAutomationHostRequest({
      ...baseRequest,
      model: "gpt-5.4",
      reasoningEffort: "ultra",
    }),
    null,
  );
  const allEfforts = ["low", "medium", "high", "xhigh", "max", "ultra"];
  for (const intervalMinutes of [5, 10, 15, 30, 60]) {
    for (const model of AUTOMATION_MODELS) {
      for (const effort of allEfforts) {
        assert.equal(
          parseTaskboardAutomationHostRequest({
            ...baseRequest,
            intervalMinutes,
            model: model.slug,
            reasoningEffort: effort,
          }) !== null,
          model.efforts.includes(effort),
          `${intervalMinutes}m/${model.slug}/${effort}`,
        );
      }
    }
  }
  assert.equal(isSupportedModelEffort("gpt-5.6-luna", "max"), true);
  assert.equal(isSupportedModelEffort("gpt-5.6-luna", "ultra"), false);
  assert.equal(
    parseTaskboardAutomationHostRequest({ ...baseRequest, workspacePath: "relative/path" }),
    null,
  );
});

test("slot automation names are stable and isolated within one project", () => {
  const first = {
    ...baseRequest,
    slotNumber: 1,
    selectedTask: { identifier: "LOCAL-1", title: "First" },
  };
  const sixth = {
    ...baseRequest,
    slotNumber: 6,
    selectedTask: { identifier: "LOCAL-6", title: "Sixth" },
  };
  assert.equal(buildTaskboardAutomationName(first), "【自动】First");
  assert.equal(buildTaskboardAutomationName(sixth), "【自动】Sixth");
  assert.match(buildTaskboardAutomationPrompt(first), /槽位 1/);
  assert.match(buildTaskboardAutomationPrompt(first), /Worktree/);
  assert.notEqual(buildTaskboardAutomationName(first), buildTaskboardAutomationName(sixth));
});

test("a claimed defect automation name starts with its defect number", () => {
  assert.equal(buildTaskboardAutomationName({
    ...baseRequest,
    slotNumber: 1,
    selectedTask: { identifier: "LOCAL-3051", title: "[ISSUE-3051] Example workflow" },
  }), "【自动】[ISSUE-3051] Example workflow");
});

test("a claimed worktree prompt reuses the prepared dependencies", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    selectedTask: {
      identifier: "LOCAL-1",
      title: "Prepared dependencies",
      automationExecution: {
        id: "execution-1",
        slotNumber: 1,
        token: "execution-token",
        repositories: [{
          name: "frontend",
          repositoryPath: "/Users/example/Documents/ppt-skill/frontend",
          worktreePath: "/Users/example/.taskboard-worktrees/PPT-Skill/LOCAL-1/frontend",
          taskBranch: "taskboard/ppt-skill/LOCAL-1",
          targetBranch: "main",
          baseCommit: "1234567890abcdef",
        }],
      },
    },
  });
  assert.match(prompt, /automation context 已准备的 Worktree 依赖，不重新安装/);
  assert.match(prompt, /通用流程以所引用的 code-loop-board Skill 为准/);
  assert.match(prompt, /references\/cli\.md 仅按当前命令读取对应章节/);
  assert.doesNotMatch(prompt, /lstat|realpath|readdir/);
  assert.match(prompt, /mcp__node_repl__js/);
  assert.match(prompt, /node:fs\/promises/);
  assert.match(prompt, /node:child_process/);
  assert.match(prompt, /windowsHide:true/);
  assert.match(prompt, /nodeRepl\.requestMeta\.threadId/);
  assert.match(prompt, /clb\.mjs/);
  assert.match(prompt, /"automation", "acquire-merge"/);
  assert.match(prompt, /Skill 的“自动化 Worktree”/);
  assert.ok(
    prompt.indexOf('runClb(["comment", "add", "LOCAL-1"')
      < prompt.indexOf('runClb(["automation", "acquire-merge"'),
  );
  assert.match(prompt, /评论失败按 Skill 的“失败恢复”处理/);
  assert.doesNotMatch(prompt, /comment add 失败.*立即.*automation fail/);
  assert.match(prompt, /其他 Worktree 可以同时合并/);
  assert.ok(
    prompt.indexOf('runClb(["automation", "context", "LOCAL-1"')
      < prompt.indexOf('runClb(["issue", "get", "LOCAL-1"'),
  );
  assert.doesNotMatch(prompt, /MERGE_QUEUE_BUSY|MERGE_QUEUE_PAUSED|串行合并|项目合并队列|合并令牌/);
  assert.doesNotMatch(prompt, /Windows error 740/);
  assert.doesNotMatch(prompt, /若 PowerShell\/shell_command/);
  assert.doesNotMatch(prompt, /clb automation context/);
});

test("a claimed backend worktree uses its prepared virtual environment", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    selectedTask: {
      identifier: "LOCAL-2",
      title: "Prepared backend environment",
      automationExecution: {
        id: "execution-2",
        slotNumber: 2,
        token: "execution-token",
        repositories: [{
          name: "backend",
          repositoryPath: "D:\\workspace\\backend",
          worktreePath: "D:\\worktrees\\LOCAL-2\\backend",
          taskBranch: "taskboard/sample/LOCAL-2",
          targetBranch: "main",
          baseCommit: "1234567890abcdef",
        }],
      },
    },
  });
  assert.match(prompt, /automation context 已准备的 Worktree 依赖/);
  assert.match(prompt, /venv\/Scripts\/python\.exe/);
  assert.match(prompt, /mcp__node_repl__js/);
  assert.match(prompt, /node:child_process\.execFile/);
});

test("the generated clb runner adds thread identity only to scoped commands", () => {
  const prompt = buildTaskboardAutomationPrompt({
    ...baseRequest,
    selectedTask: {
      identifier: "LOCAL-1",
      title: "Scoped clb identity",
      automationExecution: {
        id: "execution-1",
        slotNumber: 1,
        token: "execution-token",
        repositories: [],
      },
    },
  });

  assert.match(prompt, /threadAwareClbCommands/);
  assert.match(prompt, /"automation context"/);
  assert.match(prompt, /"automation fail"/);
  assert.match(prompt, /"comment add"/);
  assert.match(prompt, /禁止调用 --help/);
  assert.match(prompt, /USAGE_ERROR.*修正参数后继续/);
  assert.match(
    prompt,
    /runClb\(\["comment", "add", <议题>, "--body", <交付摘要>, "--json"\]\)/,
  );
  assert.doesNotMatch(prompt, /HTTP 404、连接失败或其他错误/);
  assert.match(prompt, /threadAwareClbCommands\.has\(command\)/);
  assert.doesNotMatch(
    prompt,
    /定义 runClb\(args\)：runNodeScript\([^\n]+\[\.\.\.args, "--thread-id", nodeRepl\.requestMeta\.threadId\]\)/,
  );
});

test("a deferred target-branch retry switches only its task to a ten minute merge-only run", () => {
  const request = {
    ...baseRequest,
    intervalMinutes: 30,
    slotNumber: 2,
    selectedTask: {
      identifier: "LOCAL-2",
      title: "[ISSUE-9999] Target branch retry",
      automationExecution: {
        id: "execution-2",
        slotNumber: 2,
        token: "execution-token-2",
        mergeRetryCount: 1,
        mergeRetryAt: new Date(Date.now() + (10 * 60 * 1000)).toISOString(),
        repositories: [{
          name: "backend",
          repositoryPath: "/Users/example/Documents/ppt-skill/backend",
          worktreePath: "/Users/example/.taskboard-worktrees/PPT-Skill/LOCAL-2/backend",
          taskBranch: "taskboard/ppt-skill/LOCAL-2",
          targetBranch: "main",
          baseCommit: "1234567890abcdef",
        }],
      },
    },
  };

  assert.equal(buildTaskboardAutomationSpec(request).rrule, "RRULE:FREQ=MINUTELY;INTERVAL=10");
  const prompt = buildTaskboardAutomationPrompt(request);
  assert.match(prompt, /合并重试 1\/5/);
  assert.match(prompt, /retry-merge/);
  assert.match(prompt, /non-fast-forward/);
  assert.doesNotMatch(prompt, /MERGE_QUEUE_BUSY|MERGE_QUEUE_PAUSED|串行合并|项目合并队列|合并令牌/);
  assert.doesNotMatch(prompt, /在前后端仓库定位根因/);
});

test("the stable name and generated prompt are project-scoped and encode the claim protocol", () => {
  assert.equal(
    buildTaskboardAutomationName(baseRequest),
    "Loop看板 自动认领 · ppt-skill",
  );

  const prompt = buildTaskboardAutomationPrompt(baseRequest);
  assert.match(
    prompt,
    /\[\$code-loop-board\]\(\/Users\/example\/taskboard\/skills\/code-loop-board\/SKILL\.md\)/,
  );
  assert.match(prompt, /\[\$code-loop-board\]\([^)]*\) e-taskboard /);
  assert.match(prompt, /PPT Skill/);
  assert.match(prompt, /每 5 分钟检查/);
  assert.match(prompt, /ppt-skill/);
  assert.match(prompt, /\/Users\/example\/Documents\/ppt-skill/);
  assert.match(prompt, /协调器绑定给当前槽位的一张 todo/);
  assert.match(prompt, /issue get/);
  assert.match(prompt, /comment list/);
  assert.match(prompt, /最新 version/);
  assert.match(prompt, /in_progress/);
  assert.match(prompt, /版本冲突.*跳过/);
  assert.match(prompt, /Skill 的“自动化 Worktree”/);
  assert.match(prompt, /in_review/);
  assert.match(prompt, /已绑定.*branch.*worktree/);
  assert.doesNotMatch(prompt, /--credentials-path/);
});

test("the generated cron spec uses the selected whitelisted local Codex options", () => {
  assert.deepEqual(buildTaskboardAutomationSpec(baseRequest), {
    kind: "cron",
    name: "Loop看板 自动认领 · ppt-skill",
    prompt: buildTaskboardAutomationPrompt(baseRequest),
    projectId: "codex-project-123",
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: "gpt-5.5",
    reasoningEffort: "high",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
  });
  assert.deepEqual(buildTaskboardAutomationSpec({
    ...baseRequest,
    intervalMinutes: 30,
    model: "gpt-5.4",
    reasoningEffort: "medium",
  }), {
    ...buildTaskboardAutomationSpec(baseRequest),
    prompt: buildTaskboardAutomationPrompt({ ...baseRequest, intervalMinutes: 30 }),
    model: "gpt-5.4",
    reasoningEffort: "medium",
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=30",
  });
});

test("ensure-active updates a matching automation by id with a complete active spec", async () => {
  const existing = {
    id: "automation-1",
    status: "PAUSED",
    kind: "cron",
    name: "Loop看板 自动认领 · ppt-skill",
    prompt: "old prompt",
    projectId: "old-project",
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    rrule: "FREQ=HOURLY",
    createdAt: "2026-07-25T00:00:00.000Z",
    internalRevision: 4,
  };
  const calls = [];
  const response = await reconcileTaskboardAutomation(
    { ...baseRequest, automationId: "automation-1" },
    async (method, params) => {
      calls.push({ method, params });
      if (method === "list-automations") return { items: [existing] };
      return { item: params };
    },
  );

  const spec = buildTaskboardAutomationSpec(baseRequest);
  assert.deepEqual(calls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-update",
      params: {
        ...spec,
        id: "automation-1",
        status: "ACTIVE",
      },
    },
  ]);
  assert.deepEqual(response, {
    item: { ...spec, id: "automation-1", status: "ACTIVE" },
  });
});

test("a configured slot automation is renamed in place when the claimed task changes", async () => {
  const previousRequest = {
    ...baseRequest,
    slotNumber: 1,
    selectedTask: { identifier: "LOCAL-1", title: "Previous task" },
  };
  const request = {
    ...baseRequest,
    slotNumber: 1,
    automationId: "slot-1",
    selectedTask: { identifier: "LOCAL-2", title: "Replacement task" },
  };
  const existing = {
    id: "slot-1",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec(previousRequest),
  };
  const calls = [];

  await reconcileTaskboardAutomation(request, async (method, params) => {
    calls.push({ method, params });
    if (method === "list-automations") return { items: [existing] };
    return { item: params };
  });

  assert.deepEqual(calls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-update",
      params: {
        ...buildTaskboardAutomationSpec(request),
        id: "slot-1",
        status: "ACTIVE",
      },
    },
  ]);
});

test("ensure-active is idempotent when the listed automation already matches", async () => {
  const existing = {
    id: "automation-1",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec(baseRequest),
    rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5;UNTIL=20260818T040000Z",
    nextRunAt: Date.now() + 5 * 60_000,
    createdAt: "2026-07-25T00:00:00.000Z",
  };
  const calls = [];
  const response = await reconcileTaskboardAutomation(
    { ...baseRequest, automationId: "automation-1" },
    async (method, params) => {
      calls.push({ method, params });
      return { items: [existing] };
    },
  );

  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(response, { item: existing });
});

test("a foreign automation id never grants control outside the project", async () => {
  const foreign = {
    id: "foreign-automation",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec({
      ...baseRequest,
      taskboardProjectId: "another-project",
    }),
  };
  const ensureCalls = [];
  await reconcileTaskboardAutomation(
    { ...baseRequest, automationId: foreign.id },
    async (method, params) => {
      ensureCalls.push({ method, params });
      if (method === "list-automations") return { items: [foreign] };
      return { item: params };
    },
  );
  assert.deepEqual(ensureCalls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-create",
      params: {
        ...buildTaskboardAutomationSpec(baseRequest),
        rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
      },
    },
  ]);

  const pauseCalls = [];
  const paused = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "pause", automationId: foreign.id },
    async (method, params) => {
      pauseCalls.push({ method, params });
      return { items: [foreign] };
    },
  );
  assert.deepEqual(pauseCalls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(paused, { error: "not-found" });
});

test("ensure-active falls back to the stable name and otherwise creates", async () => {
  const matching = {
    id: "automation-by-name",
    status: "PAUSED",
    ...buildTaskboardAutomationSpec(baseRequest),
  };
  const updateCalls = [];
  await reconcileTaskboardAutomation(baseRequest, async (method, params) => {
    updateCalls.push({ method, params });
    if (method === "list-automations") return { items: [matching] };
    return { item: params };
  });
  assert.equal(updateCalls[1].method, "automation-update");
  assert.equal(updateCalls[1].params.id, "automation-by-name");

  const createCalls = [];
  const nextRunAt = Date.now() + 5 * 60_000;
  const until = new Date(nextRunAt + 60_000)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "");
  const created = await reconcileTaskboardAutomation(baseRequest, async (method, params) => {
    createCalls.push({ method, params });
    if (method === "list-automations") return { items: [] };
    return {
      item: {
        id: "created-1",
        status: "ACTIVE",
        ...params,
        ...(method === "automation-create" ? { nextRunAt } : {}),
      },
    };
  });
  assert.deepEqual(createCalls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-create",
      params: {
        ...buildTaskboardAutomationSpec(baseRequest),
        rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
      },
    },
    {
      method: "automation-update",
      params: {
        ...buildTaskboardAutomationSpec(baseRequest),
        id: "created-1",
        status: "ACTIVE",
        rrule: `RRULE:FREQ=MINUTELY;INTERVAL=5;UNTIL=${until}`,
      },
    },
  ]);
  assert.equal(created.item.id, "created-1");
});

test("pause never creates and list returns only sanitized matching project automations", async () => {
  const matching = {
    id: "matching",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec(baseRequest),
    untrustedListField: "must not be echoed into an update",
  };
  const unrelated = {
    id: "unrelated",
    status: "ACTIVE",
    ...buildTaskboardAutomationSpec({
      ...baseRequest,
      taskboardProjectId: "another-project",
    }),
  };

  const pauseCalls = [];
  const paused = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "pause" },
    async (method, params) => {
      pauseCalls.push({ method, params });
      if (method === "list-automations") return { items: [unrelated, matching] };
      return { item: params };
    },
  );
  assert.deepEqual(pauseCalls, [
    { method: "list-automations", params: {} },
    {
      method: "automation-update",
      params: {
        ...buildTaskboardAutomationSpec(baseRequest),
        id: "matching",
        status: "PAUSED",
      },
    },
  ]);
  assert.deepEqual(paused, {
    item: {
      ...buildTaskboardAutomationSpec(baseRequest),
      id: "matching",
      status: "PAUSED",
    },
  });

  const notFoundCalls = [];
  const notFound = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "pause", taskboardProjectId: "missing" },
    async (method, params) => {
      notFoundCalls.push({ method, params });
      return { items: [matching, unrelated] };
    },
  );
  assert.deepEqual(notFoundCalls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(notFound, { error: "not-found" });

  const listed = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "list" },
    async () => ({ items: [unrelated, matching] }),
  );
  assert.deepEqual(listed, {
    items: [{
      id: "matching",
      status: "ACTIVE",
      model: "gpt-5.5",
      reasoningEffort: "high",
      rrule: "RRULE:FREQ=MINUTELY;INTERVAL=5",
    }],
  });

  const invalidPair = {
    ...matching,
    id: "invalid-pair",
    model: "gpt-5.4",
    reasoningEffort: "ultra",
  };
  const invalidListed = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "list" },
    async () => ({ items: [invalidPair] }),
  );
  assert.deepEqual(invalidListed, { items: [] });
});

test("pause is idempotent for an already paused matching automation", async () => {
  const matching = {
    id: "matching",
    status: "PAUSED",
    ...buildTaskboardAutomationSpec(baseRequest),
  };
  const calls = [];
  const response = await reconcileTaskboardAutomation(
    { ...baseRequest, operation: "pause" },
    async (method, params) => {
      calls.push({ method, params });
      return { items: [matching] };
    },
  );
  assert.deepEqual(calls, [{ method: "list-automations", params: {} }]);
  assert.deepEqual(response, { item: matching });
});

