import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAbsolutePath } from "./cross-platform-path.mjs";
import { DEFAULT_BOARD_CONFIG, boundStatus, normalizeBoardConfig } from "./board-config.mjs";
import { isSupportedModelEffort } from "./taskboard-automation-options.mjs";

const TASKBOARD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLB_ENTRYPOINT = path.join(TASKBOARD_ROOT, "cli", "clb.mjs");
const CLB_NODE_EXECUTABLE = process.execPath;

const AUTOMATION_OPERATIONS = new Set(["ensure-active", "pause", "list", "apply-policy"]);
const INTERVAL_MINUTES = new Set([5, 10, 15, 30, 60]);
const HOST_REQUEST_FIELDS = new Set([
  "id",
  "action",
  "requestId",
  "operation",
  "taskboardProjectId",
  "codexProjectId",
  "projectName",
  "workspacePath",
  "skillPath",
  "automationId",
  "slotAutomationIds",
  "enabledByUser",
  "quotaAware",
  "concurrencyLimit",
  "intervalMinutes",
  "model",
  "reasoningEffort",
  "boardConfig",
]);

export function selectTaskboardAutomationTasks(tasks, concurrencyLimit, repositories = [], boardConfig = DEFAULT_BOARD_CONFIG) {
  if (!Array.isArray(tasks)) throw new Error("Taskboard returned an invalid task list");
  if (!Number.isSafeInteger(concurrencyLimit) || concurrencyLimit < 1 || concurrencyLimit > 12) {
    throw new Error("Taskboard automation concurrency must be an integer from 1 to 12");
  }
  const occupied = tasks.filter((task) => task?.status === boundStatus(boardConfig, "working")).length;
  const available = Math.max(0, concurrencyLimit - occupied);
  if (available === 0) return [];

  const selected = [];
  for (const task of tasks) {
    if (task?.status !== boundStatus(boardConfig, "ready")) continue;
    if (
      typeof task.identifier !== "string"
      || task.identifier.length === 0
      || typeof task.title !== "string"
      || task.title.length === 0
    ) {
      throw new Error("Loop board returned an invalid ready issue");
    }
    if (!(task.delivery?.repositories ?? []).every((target) => repositories.some((repository) => (
      (repository.repositoryId ?? repository.name) === target.repositoryId && repository.targetBranch === target.targetBranch
    )))) continue;
    selected.push({ identifier: task.identifier, title: task.title, externalIssue: task.externalIssue ?? null, delivery: task.delivery ?? { mode: "review", repositories: [] } });
    if (selected.length === available) break;
  }
  return selected;
}

export function selectNextTaskboardAutomationTask(tasks, repositories, boardConfig) {
  return selectTaskboardAutomationTasks(tasks, 1, repositories, boardConfig)[0] ?? null;
}

export function parseTaskboardAutomationHostRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).some((field) => !HOST_REQUEST_FIELDS.has(field))) return null;
  if (value.action !== "automation") return null;
  if (!validIdentifier(value.id, 80) || !validIdentifier(value.requestId, 100)) return null;
  if (!AUTOMATION_OPERATIONS.has(value.operation)) return null;
  if (!validProjectId(value.taskboardProjectId)) return null;
  if (!validText(value.codexProjectId, 256) || !validText(value.projectName, 200)) return null;
  if (!validAbsolutePath(value.workspacePath) || !validAbsolutePath(value.skillPath)) return null;
  if (!INTERVAL_MINUTES.has(value.intervalMinutes)) return null;
  if (!isSupportedModelEffort(value.model, value.reasoningEffort)) return null;
  if (value.automationId !== undefined && !validText(value.automationId, 256)) return null;
  if (value.slotAutomationIds !== undefined && !validSlotAutomationIds(value.slotAutomationIds)) return null;
  if (typeof value.enabledByUser !== "boolean" || typeof value.quotaAware !== "boolean") return null;
  if (!Number.isSafeInteger(value.concurrencyLimit) || value.concurrencyLimit < 1 || value.concurrencyLimit > 12) {
    return null;
  }

  let boardConfig;
  try {
    boardConfig = value.boardConfig === undefined ? undefined : normalizeBoardConfig(value.boardConfig);
  } catch {
    return null;
  }
  return {
    ...(boardConfig ? { boardConfig } : {}),
    id: value.id,
    action: "automation",
    requestId: value.requestId,
    operation: value.operation,
    taskboardProjectId: value.taskboardProjectId,
    codexProjectId: value.codexProjectId,
    projectName: value.projectName,
    workspacePath: value.workspacePath,
    skillPath: value.skillPath,
    ...(value.automationId === undefined ? {} : { automationId: value.automationId }),
    ...(value.slotAutomationIds === undefined ? {} : { slotAutomationIds: { ...value.slotAutomationIds } }),
    enabledByUser: value.enabledByUser,
    quotaAware: value.quotaAware,
    concurrencyLimit: value.concurrencyLimit,
    intervalMinutes: value.intervalMinutes,
    model: value.model,
    reasoningEffort: value.reasoningEffort,
  };
}

export function buildTaskboardAutomationName(request) {
  if (validSelectedTask(request.selectedTask)) {
    return `【自动】${request.selectedTask.title}`;
  }
  return `Loop看板 自动认领 · ${request.taskboardProjectId}`;
}

export function canScheduleTaskboardAutomationExecution(execution) {
  return execution !== null
    && typeof execution === "object"
    && execution.runOwnerThreadId === null;
}

function reviewRejectionInstruction(execution) {
  const reason = typeof execution?.error?.reason === "string" ? execution.error.reason.trim() : "";
  if (!reason) return [];
  return [
    "这是人工审批驳回后的重新自动认领。必须优先处理下面的驳回理由，并在新一轮修复总结中说明如何解决；不要把上一轮审批快照当作已通过。",
    `人工审批驳回理由：${reason}`,
  ];
}

function repairSummaryCommentInstruction(issueReference) {
  const issueArgument = issueReference.startsWith("<")
    ? issueReference
    : JSON.stringify(issueReference);
  return [
    `按 Skill 的“自动化 Worktree”章节要求，用 runClb(["comment", "add", ${issueArgument}, "--body", <五段式修复总结>, "--json"]) 写入审批前评论。`,
    "评论失败按 Skill 的“失败恢复”处理；成功前不得进入审批、合并或下一状态。",
  ].join("\n");
}

export function buildTaskboardAutomationPrompt(request) {
  const boardConfig = request.boardConfig ?? DEFAULT_BOARD_CONFIG;
  const working = boundStatus(boardConfig, "working");
  const review = boundStatus(boardConfig, "review");
  const done = boundStatus(boardConfig, "done");
  if (validSelectedTask(request.selectedTask)) {
    const { identifier, title } = request.selectedTask;
    const execution = request.selectedTask.automationExecution;
    const executionRepositories = Array.isArray(execution?.repositories) ? execution.repositories : [];
    const executionLines = executionRepositories.map((repository) => (
      `- ${repository.name}：主仓库 ${repository.repositoryPath}；Worktree ${repository.worktreePath}；本地任务分支 ${repository.taskBranch}；目标分支 ${repository.targetBranch}；基准 ${repository.baseCommit}`
    ));
    if (execution?.mergeRetryAt) {
      return [
        `[$code-loop-board](${request.skillPath}) e-taskboard 继续处理Loop看板「${request.projectName}」项目中的议题「${title}」（${identifier}，项目 ID：${request.taskboardProjectId}）。`,
        ...taskboardCliRunnerInstructions(),
        "合并时遵循 Skill 的 Worktree 合并与验证规则。",
        `这是并发目标分支更新后的合并重试 ${execution.mergeRetryCount}/5：上次代码修复、验证和本地提交已完成，只需在当前任务 Worktree 中重新整理并 push。`,
        "不得重新读取议题或评论、重新定位根因、扩大代码修改、安装依赖或创建新功能 commit；只允许为 rebase 冲突作必要编辑，并重新运行受影响验证。",
        `先执行 runClb(["automation", "context", "${identifier}", "--json"]) 获取 token。若返回 AUTOMATION_RUN_ACTIVE、AUTOMATION_MERGE_RETRY_NOT_DUE 或其他固定入口错误，立即结束本次会话。`,
        `只能在既有 Worktree 中继续合并：${executionLines.join("；")}`,
        `执行 runClb(["automation", "acquire-merge", "${identifier}", "--token", <token>, "--json"])并解析返回的 execution.phase。若为 awaiting_approval，说明协调器已保存审阅快照、移动任务并释放槽位；立即正常结束，不得 fetch、rebase、push、调用 automation fail 或重复调用 acquire-merge。只有返回 merging 才继续；若为任何其他 phase，立即结束并按现有安全错误路径处理，不得猜测或继续合并。`,
        "返回 merging 后，按 Skill 的合并流程继续；并发 non-fast-forward 使用最多 5 次重试及 pause-merge 规则。",
        ...mergeCompletionInstructions(request, identifier),
      ].join("\n");
    }
    if (execution?.phase === "ready_to_merge") {
      return [
        `[$code-loop-board](${request.skillPath}) e-taskboard 继续处理Loop看板「${request.projectName}」项目中已获审批的议题「${title}」（${identifier}，项目 ID：${request.taskboardProjectId}）。`,
        ...taskboardCliRunnerInstructions(),
        "这是人工审批后的合并续跑：代码修复、验证和功能 commit 已完成。不得重新读取议题或评论、重新分析缺陷、扩大代码修改或重复提交功能代码；只允许为 rebase 冲突作必要编辑并重新验证。",
        `只执行 runClb(["automation", "context", "${identifier}", "--json"]) 获取当前执行 token，然后执行 runClb(["automation", "acquire-merge", "${identifier}", "--token", <token>, "--json"])；不得调用其他开发阶段命令。`,
        "只有 acquire-merge 返回 execution.phase 为 merging 才继续；否则立即正常结束，不得 fetch、rebase、push、调用 automation fail 或重复调用 acquire-merge。",
        `只能在既有 Worktree 中继续合并：${executionLines.join("；")}`,
        "返回 merging 后，按 Skill 的 Worktree 合并、验证与并发重试规则交付既有提交。",
        ...mergeCompletionInstructions(request, identifier),
      ].join("\n");
    }
    const standardPrompt = [
      `[$code-loop-board](${request.skillPath}) e-taskboard 自动处理Loop看板「${request.projectName}」项目中的议题「${title}」（${identifier}，项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}）。`,
      ...taskboardCliRunnerInstructions(),
      ...(Number.isSafeInteger(request.slotNumber)
        ? [`这是项目自动认领槽位 ${request.slotNumber}。只使用Loop看板记录的本任务 Worktree；不得直接修改原仓库，不得处理其他槽位或任务。`]
       : []),
      ...(execution
        ? [`在读取议题或编辑前，先执行 runClb(["automation", "context", "${identifier}", "--json"])，确认返回的执行 ID 为 ${execution.id}、槽位为 ${execution.slotNumber}、阶段仍允许继续；必须使用返回的 token 调用后续受控命令。若返回 AUTOMATION_RUN_ACTIVE，说明上一次同槽位运行仍在处理，立刻结束本次会话，不读取、不编辑、不评论、不执行任何其他命令。`]
        : []),
      ...reviewRejectionInstruction(execution),
      `只处理 ${identifier}：用 runClb(["issue", "get", "${identifier}", "--json"]) 读取最新议题内容，并用 runClb(["comment", "list", "${identifier}", "--json"]) 读取全部评论，确认是否包含已完成后被打回的返工要求。读取后、开始定位前，必须基于任务范围评估人工处理时长；若任务的 estimatedHandlingHours 为空，立即用 runClb(["issue", "update", "${identifier}", "--estimated-handling-hours", <以小时计的非负数>, "--json"]) 写回预估值。已有预估值不得覆盖；该回填只用于数据统计，不得为此创建额外会话、计划或评论。`,
      "执行 Skill 的自动认领验证规则：按项目规则实现并验证直接操作路径，用户可见页面使用 Playwright；失败统一按“失败恢复”处理。",
      ...(execution
        ? [
            "本任务的全部仓库上下文如下：",
            ...executionLines,
            "使用 automation context 已准备的 Worktree 依赖，不重新安装；后端使用 Worktree 内的 venv/Scripts/python.exe（非 Windows 为 venv/bin/python）。依赖异常按 Skill 的依赖与失败恢复规则处理。",
            repairSummaryCommentInstruction(identifier),
            "结构化修复总结写入成功后，执行 runClb([\"automation\", \"acquire-merge\", <议题>, \"--token\", <token>, \"--json\"])并检查返回的 execution.phase。若为 awaiting_approval，说明协调器已保存审阅快照、移动任务并释放槽位；立即正常结束，不得 fetch、rebase、push、调用 automation fail 或重复调用 acquire-merge。只有返回 merging 才继续并行合并；该命令不获取项目级或仓库级全局锁，其他 Worktree 可以同时合并。",
            "返回 merging 后，按 Skill 的 Worktree 合并、验证与并发重试规则执行。",
          ]
        : [
            `认领时使用最新 version 将议题移动到 ${working}；若发生版本冲突或最新状态已变化，立即跳过，避免多个 Agent 抢同一任务。`,
            "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
            repairSummaryCommentInstruction(identifier),
          ]),
    ];
    const externalIssue = request.selectedTask.externalIssue;
    const integrationInstructions = externalIssue ? [
      `外部议题来源为 ${JSON.stringify(externalIssue)}。仓库和目标分支以任务 delivery 与 automation context 为准，不从描述推断平台或仓库。`,
      `开始修改代码前执行 runClb(["integration", "action", ${JSON.stringify(identifier)}, "--action", "start_work", "--json"])。返回 ok=true、verified=true、localCompleted=true 且 state.semantic=working 才继续；changed=false 也有效。若 ok=true、verified=true、localCompleted=true 且 state.semantic=fixed，执行 runClb(["automation", "reconcile-release", ${JSON.stringify(identifier)}, "--token", <token>, "--observed-status", "fixed", "--json"]) 后结束。其他失败按 Skill 的失败恢复处理。`,
    ] : [];
    const verificationIndex = standardPrompt.findIndex((line) => line.startsWith("执行 Skill 的自动认领验证规则"));
    standardPrompt.splice(verificationIndex, 0, ...integrationInstructions);
    return [
      ...standardPrompt,
      ...(execution
        ? mergeCompletionInstructions(request, identifier)
        : [`结构化修复总结写入成功后，使用最新 version 将议题移动到 ${review}；不要直接标记为 ${done}。`]),
    ].join("\n");
  }
  return [
    `[$code-loop-board](${request.skillPath}) e-taskboard 每 ${request.intervalMinutes} 分钟检查Loop看板中的「${request.projectName}」项目（项目 ID：${request.taskboardProjectId}，项目目录：${request.workspacePath}，并发上限：${request.concurrencyLimit}）。`,
    ...taskboardCliRunnerInstructions(),
    `只处理看板协调器绑定给当前槽位的一张 ${boundStatus(boardConfig, "ready")} 任务；没有槽位绑定时立即结束，不自行认领其他任务。`,
    "处理前先用 issue get 读取最新议题内容，并用 comment list 读取全部评论。",
    `认领时使用最新 version 将议题移动到 ${working}；若发生版本冲突或最新状态已变化，立即跳过，避免多个 Agent 抢同一任务。`,
    "若议题已绑定 branch 或 worktree，必须在该议题绑定的开发上下文执行，避免并行 Agent 修改同一工作目录。",
    "按 Skill 的前端验证规则执行；用户可见变化需 Playwright 真实页面证据。",
    repairSummaryCommentInstruction("<议题>"),
    `结构化修复总结写入成功后，再使用最新 version 将议题移动到 ${review}；不要直接标记为 ${done}。`,
  ].join("\n");
}

function mergeCompletionInstructions(request, identifier) {
  const release = request.selectedTask?.delivery?.mode === "release";
  const releaseReady = boundStatus(request.boardConfig ?? DEFAULT_BOARD_CONFIG, "releaseReady");
  return [
    ...(release ? [`全部目标分支 push 成功后，执行 runClb(["automation", "prepare-release", ${JSON.stringify(identifier)}, "--token", <token>, "--repository-results-file", <仓库结果 JSON 文件>, "--json"])，确认看板状态为 ${releaseReady}。`] : []),
    ...(request.selectedTask?.externalIssue ? [`全部目标分支 push 成功后，执行 runClb(["integration", "action", ${JSON.stringify(identifier)}, "--action", "mark_fixed", "--json"])，确认 ok=true、verified=true、localCompleted=true 且 state.semantic=fixed。`] : []),
    `用 runClb(["comment", "add", ${JSON.stringify(identifier)}, "--body", <各仓库最终 commit、合并与 push 结果>, "--json"]) 记录结果，再调用 runClb(["automation", "complete", ${JSON.stringify(identifier)}, "--token", <token>, "--repository-results-file", <仓库结果 JSON 文件>, "--json"]) 清理 Worktree 并完成本次执行，由协调器决定下一状态。`,
  ];
}

function taskboardCliRunnerInstructions() {
  return [
    "前端可以运行项目现有 build 命令作为验证；build 前后必须核对 git status，任何仓库的 static/** 及其他由 build 生成或改写的构建产物不得暂存、提交或 push；清理本次生成的产物，只保留本缺陷源码与测试改动。",
    "通用流程以所引用的 code-loop-board Skill 为准；references/cli.md 仅按当前命令读取对应章节，不重复加载无关命令。",
    "本地文件读取、写入、目录检查和命令执行可使用持久 Node 运行时（mcp__node_repl__js）或 PowerShell；根据任务选择合适的工具。",
    "使用 mcp__node_repl__js 时，文件操作使用 node:fs/promises；命令执行使用 node:child_process.execFile、参数数组、shell:false 和 windowsHide:true。",
    "Loop看板 CLI 的所有读取和写入必须使用下方固定入口；不得运行 clb 裸命令。",
    `使用 Node MCP 时，从 nodeRepl.requestMeta.threadId 读取当前会话 ID；定义 runNodeScript(scriptPath, args)：execFile(${JSON.stringify(CLB_NODE_EXECUTABLE)}, [scriptPath, ...args], { shell: false, windowsHide: true })；定义 threadAwareClbCommands = new Set(["integration sync", "integration action", "issue update", "automation context", "automation acquire-merge", "automation retry-merge", "automation release-run", "automation prepare-release", "automation reconcile-release", "automation fail", "automation pause-merge", "automation complete", "comment add", "comment update", "comment delete"])；再定义 runClb(args)：先令 command = args.slice(0, 2).join(" ")，再令 scopedArgs = threadAwareClbCommands.has(command) ? [...args, "--thread-id", nodeRepl.requestMeta.threadId] : args，最后返回 runNodeScript(${JSON.stringify(CLB_ENTRYPOINT)}, scopedArgs)。`,
    "使用 PowerShell 时可等价定义这两个函数：以参数数组调用同一 Node 可执行文件与 CLI 文件，沿用上述 threadAwareClbCommands，只给这些命令附加当前 CODEX_THREAD_ID 或会话上下文中的真实 ID；不得猜测 ID。缺少 Node MCP 不是阻塞原因。",
    "下文所有 runClb([...]) 均指选定工具中的等价固定入口；它直接调用 CLI 文件，不依赖 PATH。",
    "下文给出的 runClb([...]) 已是完整调用；禁止调用 --help 或其他探测命令，直接执行对应下一步。添加交付评论必须使用 runClb([\"comment\", \"add\", <议题>, \"--body\", <交付摘要>, \"--json\"])。",
    "固定入口若返回 USAGE_ERROR，说明参数在本地解析阶段被拒绝、尚未访问Loop看板服务；仅按本提示词给出的完整调用修正参数后继续。若报 HTTP 404、连接失败、服务不可用或其他传输错误，立即结束本次会话；不得诊断或比较 Taskboard/CLI 版本、47824 服务、路由或 PATH，也不得向议题评论这些环境错误。",
  ];
}

export function buildTaskboardAutomationSpec(request) {
  const mergeRetryPending = Boolean(request.selectedTask?.automationExecution?.mergeRetryAt);
  const intervalMinutes = mergeRetryPending ? 10 : request.intervalMinutes;
  return {
    kind: "cron",
    name: buildTaskboardAutomationName(request),
    prompt: buildTaskboardAutomationPrompt(request),
    projectId: request.codexProjectId,
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${intervalMinutes}`,
  };
}

export async function reconcileTaskboardAutomation(request, rpc) {
  const listed = await rpc("list-automations", {});
  const items = Array.isArray(listed?.items) ? listed.items : [];
  const name = buildTaskboardAutomationName(request);
  const legacyName = `Taskboard 自动认领 · ${request.taskboardProjectId}`;
  const projectPromptMarker = `项目 ID：${request.taskboardProjectId}`;
  const slotScoped = Number.isSafeInteger(request.slotNumber);
  const configuredAutomation = request.automationId
    ? items.find((item) => (
      item?.id === request.automationId
      && (
        item?.name === name
        || (
          (item?.projectId ?? item?.target?.projectId) === request.codexProjectId
          && typeof item?.prompt === "string"
          && item.prompt.includes(projectPromptMarker)
        )
      )
    ))
    : null;
  const matchingItems = items.filter((item) => (
    item?.name === name
    || (!slotScoped && (
      item?.name === legacyName
      || (typeof item?.prompt === "string" && item.prompt.includes(projectPromptMarker))
    ))
  ));

  if (request.operation === "list") {
    return { items: matchingItems.map(sanitizeAutomation).filter(Boolean) };
  }

  const existing = configuredAutomation ?? matchingItems[0];
  const spec = buildTaskboardAutomationSpec(request);

  if (request.operation === "pause") {
    if (!existing) return { error: "not-found" };
    if (automationMatchesSpec(existing, spec, "PAUSED")) return { item: existing };
    return rpc("automation-update", { ...spec, id: existing.id, status: "PAUSED" });
  }

  if (request.operation !== "ensure-active") {
    throw new Error(`Unsupported automation operation: ${request.operation}`);
  }
  if (existing) {
    if (
      automationMatchesSpec(existing, spec, "ACTIVE")
      && existing.rrule?.startsWith(`${spec.rrule};UNTIL=`)
      && Number.isFinite(existing.nextRunAt)
      && existing.nextRunAt > Date.now()
    ) return { item: existing };
    const scheduled = await rpc("automation-update", {
      ...spec,
      id: existing.id,
      status: "ACTIVE",
    });
    return convertToOneShot(existing.id, spec, scheduled, rpc);
  }
  const created = await rpc("automation-create", spec);
  if (!created?.item?.id) return created;
  return convertToOneShot(created.item.id, spec, created, rpc);
}

function convertToOneShot(id, spec, scheduled, rpc) {
  const nextRunAt = Number(scheduled?.item?.nextRunAt);
  if (!Number.isFinite(nextRunAt) || nextRunAt <= Date.now()) return scheduled;
  const until = new Date(nextRunAt + 60_000)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(".000", "");
  return rpc("automation-update", {
    ...spec,
    id,
    status: "ACTIVE",
    rrule: `${spec.rrule};UNTIL=${until}`,
  });
}

function sanitizeAutomation(item) {
  if (
    !validText(item?.id, 256)
    || (item.status !== "ACTIVE" && item.status !== "PAUSED")
    || !isSupportedModelEffort(item.model, item.reasoningEffort)
    || !validRrule(item.rrule)
  ) return null;
  return {
    id: item.id,
    status: item.status,
    model: item.model,
    reasoningEffort: item.reasoningEffort,
    rrule: item.rrule,
    ...(
      item.nextRunAt === null || Number.isFinite(item.nextRunAt)
        ? { nextRunAt: item.nextRunAt }
        : {}
    ),
  };
}

function validRrule(value) {
  return typeof value === "string"
    && /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)(?:;UNTIL=\d{8}T\d{6}Z)?$/.test(value);
}

function automationMatchesSpec(item, spec, status) {
  return item?.status === status
    && Object.entries(spec).every(([field, value]) => (
      field === "projectId"
        ? (item.projectId ?? item.target?.projectId) === value
        : field === "rrule"
          ? item[field] === value || item[field]?.startsWith(`${value};UNTIL=`)
          : item[field] === value
    ));
}

function validIdentifier(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && /^[a-z0-9-]+$/i.test(value);
}

function validSelectedTask(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && validText(value.identifier, 128)
    && validText(value.title, 500)
    && (
      value.externalIssue == null
      || validExternalIssue(value.externalIssue)
    )
    && (value.delivery === undefined || validDelivery(value.delivery))
    && (
      value.automationExecution === undefined
      || validAutomationExecution(value.automationExecution)
    );
}

function validAutomationExecution(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && validText(value.id, 128)
    && Number.isSafeInteger(value.slotNumber)
    && value.slotNumber >= 1
    && value.slotNumber <= 12
    && validText(value.token, 128)
    && (
      value.mergeRetryCount === undefined
      || (Number.isSafeInteger(value.mergeRetryCount) && value.mergeRetryCount >= 0 && value.mergeRetryCount <= 5)
    )
    && (
      value.mergeRetryAt === undefined
      || value.mergeRetryAt === null
      || (typeof value.mergeRetryAt === "string" && Number.isFinite(Date.parse(value.mergeRetryAt)))
    )
    && Array.isArray(value.repositories)
    && value.repositories.every((repository) => (
      repository
      && typeof repository === "object"
      && !Array.isArray(repository)
      && validText(repository.name, 256)
      && validAbsolutePath(repository.repositoryPath)
      && validAbsolutePath(repository.worktreePath)
      && validText(repository.taskBranch, 512)
      && validText(repository.targetBranch, 512)
      && validText(repository.baseCommit, 128)
    ));
}

function validExternalIssue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && validText(value.connectionId, 128)
    && validText(value.scopeId, 256)
    && validText(value.externalId, 256)
    && (value.key == null || validText(value.key, 256))
    && (value.url == null || validHttpUrl(value.url));
}

function validDelivery(value) {
  return value && (value.mode === "review" || value.mode === "release")
    && Array.isArray(value.repositories)
    && value.repositories.every((repository) => validText(repository.repositoryId, 256) && validText(repository.targetBranch, 512));
}

function validHttpUrl(value) {
  if (!validText(value, 2_048)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.href === value;
  } catch (_) {
    return false;
  }
}

function validSlotAutomationIds(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value).every(([slot, automationId]) => (
    /^(?:[1-9]|1[0-2])$/.test(slot) && validText(automationId, 256)
  ));
}

function validProjectId(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && /^[a-z0-9._-]+$/i.test(value);
}

function validText(value, maxLength) {
  return typeof value === "string"
    && value.trim() === value
    && value.length > 0
    && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function validAbsolutePath(value) {
  return validText(value, 2_048) && isAbsolutePath(value);
}
