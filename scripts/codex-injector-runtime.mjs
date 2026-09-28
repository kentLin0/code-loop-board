import path from "node:path";

const HOST_REQUEST_ERROR = "自动认领配置暂时无法应用，请刷新后重试";
const AUTOMATION_SCHEMA_DIAGNOSTIC = "AUTOMATION_SCHEMA_MISMATCH";

export function resolveAutomationDataDir({
  platform,
  configuredDir,
  localAppData,
  tempDir,
  projectRoot,
}) {
  const configuredPath = configuredDir?.trim();
  if (configuredPath) {
    return platform === "win32"
      ? path.win32.resolve(configuredPath)
      : path.resolve(configuredPath);
  }

  const windowsTempPath = tempDir?.trim();
  if (platform === "win32" && windowsTempPath) {
    return path.win32.join(windowsTempPath, "CodexTaskboard");
  }

  const windowsUserDataPath = localAppData?.trim();
  if (platform === "win32" && windowsUserDataPath) {
    return path.win32.join(windowsUserDataPath, "Temp", "CodexTaskboard");
  }

  return path.join(projectRoot, ".data");
}

function parseHostRequest(payload, parseAutomationRequest) {
  if (typeof payload !== "string" || payload.length > 4_096) {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  let request;
  try {
    request = JSON.parse(payload);
  } catch {
    return { id: null, request: null, error: HOST_REQUEST_ERROR };
  }

  const id = (
    request
    && typeof request.id === "string"
    && /^[a-z0-9-]{1,80}$/i.test(request.id)
  ) ? request.id : null;
  if (!id) return { id: null, request: null, error: HOST_REQUEST_ERROR };
  if (request.action === "ensure") return { id, request, error: null };
  if (request.action === "automation") {
    const parsed = parseAutomationRequest(request);
    return parsed
      ? { id, request: parsed, error: null }
      : {
          id,
          request: null,
          error: HOST_REQUEST_ERROR,
          diagnosticCode: AUTOMATION_SCHEMA_DIAGNOSTIC,
        };
  }
  if (
    request.action === "prefill-task-composer"
    && typeof request.instruction === "string"
    && request.instruction.length > 0
    && request.instruction.length <= 1_024
    && typeof request.skillName === "string"
    && /^[a-z0-9][a-z0-9-]{0,79}$/i.test(request.skillName)
    && typeof request.skillDisplayName === "string"
    && request.skillDisplayName.length > 0
    && request.skillDisplayName.length <= 120
    && typeof request.skillPath === "string"
    && request.skillPath.length > 0
    && request.skillPath.length <= 1_024
  ) {
    return { id, request, error: null };
  }
  return { id, request: null, error: HOST_REQUEST_ERROR };
}

export async function handleHostBindingPayload(params, handlers) {
  const parsed = parseHostRequest(params.payload, handlers.parseAutomationRequest);
  if (!parsed.request) {
    if (!parsed.id) return { responded: false, accepted: false };
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.id,
      ok: false,
      error: parsed.error,
      ...(parsed.diagnosticCode ? { diagnosticCode: parsed.diagnosticCode } : {}),
    });
    return { responded: true, accepted: false };
  }

  try {
    let result;
    if (parsed.request.action === "ensure") {
      result = await handlers.ensure();
    } else if (parsed.request.action === "automation") {
      result = await handlers.runAutomation(parsed.request, params.executionContextId);
    } else {
      result = await handlers.prefill(parsed.request, params.executionContextId);
    }
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: true,
      ...result,
    });
  } catch (error) {
    await handlers.sendResponse(params.executionContextId, {
      id: parsed.request.id,
      ok: false,
      error: error.message,
    });
  }
  return { responded: true, accepted: true };
}

export async function reconcileInjectionRuntime({
  currentStatus,
  source,
  sourceHash,
  shouldOpen = false,
  removeRegisteredSource,
  registerCurrentSource,
  evaluateCurrentSource,
  publishRegistration,
  reopen,
}) {
  if (currentStatus.scriptIdentifier) {
    try {
      await removeRegisteredSource(currentStatus.scriptIdentifier);
    } catch {}
  }
  const scriptIdentifier = await registerCurrentSource(source);
  await evaluateCurrentSource(source);
  await publishRegistration(scriptIdentifier);
  const replaced = currentStatus.sourceHash !== sourceHash;
  const shouldRemainOpen = shouldOpen || currentStatus.pageVisible === true;
  if (shouldOpen || (replaced && shouldRemainOpen)) await reopen();
  return { replaced, scriptIdentifier, shouldRemainOpen };
}

export function createStableTargetTracker(stabilityMs) {
  let signature = null;
  let firstSeenAt = null;

  return {
    update(targets, now = Date.now()) {
      if (targets.length === 0) {
        signature = null;
        firstSeenAt = null;
        return false;
      }
      const nextSignature = targets
        .map((target) => `${target.id}\u0000${target.url}`)
        .sort()
        .join("\n");
      if (signature !== nextSignature) {
        signature = nextSignature;
        firstSeenAt = now;
      }
      return nextSignature === signature && now - firstSeenAt >= stabilityMs;
    },
  };
}

export function findResidentInjectorPids({
  processList,
  currentPid,
  injectorPath,
  projectRoot,
  port,
  defaultPort,
  cwdForPid,
}) {
  const absoluteScript = new RegExp(
    `(?:^|\\s)${escapeRegExp(injectorPath)}(?=\\s|$)`,
  );
  const relativeScript = /(?:^|\s)(?:\.\/)?scripts\/codex-injector\.mjs(?=\s|$)/;
  const residents = [];

  for (const line of processList.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (pid === currentPid || !/(?:^|\s)--watch(?=\s|$)/.test(command)) continue;
    const scriptMatches = absoluteScript.test(command)
      || (relativeScript.test(command) && cwdForPid(pid) === projectRoot);
    if (!scriptMatches || commandPort(command, defaultPort) !== port) continue;
    residents.push(pid);
  }
  return residents;
}

export function parseWmicProcessList(value) {
  const processes = [];
  let command = "";
  for (const rawLine of String(value).replaceAll("\r", "").split("\n")) {
    if (rawLine.startsWith("CommandLine=")) {
      command = rawLine.slice("CommandLine=".length).trim();
      continue;
    }
    if (!rawLine.startsWith("ProcessId=")) continue;
    const pid = Number(rawLine.slice("ProcessId=".length).trim());
    if (command && Number.isInteger(pid) && pid > 0) processes.push(`${pid} ${command}`);
    command = "";
  }
  return processes.join("\n");
}

export async function restartResidentInjector(port, handlers) {
  const previousPids = handlers.findResidents(port);
  if (previousPids.length === 0) return { previousPids: [], pid: null, restarted: false };

  for (const pid of previousPids) {
    try {
      await handlers.stopResident(pid);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const startupToken = handlers.createStartupToken();
  const started = handlers.startResident(port, startupToken);
  await handlers.waitUntilReady(port, started.pid, startupToken);
  return {
    previousPids,
    pid: started.pid,
    restarted: true,
  };
}

function commandPort(command, defaultPort) {
  const match = command.match(/(?:^|\s)--port(?:=(\d+)|\s+(\d+))(?=\s|$)/);
  return match ? Number(match[1] ?? match[2]) : defaultPort;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
