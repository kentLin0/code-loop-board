import { spawn } from "node:child_process";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function appServerError(error, fallback) {
  const message = typeof error?.message === "string" && error.message.trim()
    ? error.message.trim()
    : fallback;
  const result = new Error(message);
  if (error?.code !== undefined) result.code = error.code;
  return result;
}

export class CodexAppServerClient {
  constructor(options = {}) {
    this.executable = options.executable ?? "codex";
    this.cwd = options.cwd;
    this.processEnv = options.processEnv ?? process.env;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.child = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.buffer = "";
    this.closing = false;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async request(method, params = {}) {
    await this.start();
    return this.#sendRequest(method, params);
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    if (this.child) return;
    this.closing = false;
    this.startPromise = new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.executable, ["app-server", "--stdio"], {
        cwd: this.cwd,
        env: this.processEnv,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      });
      this.child = child;
      this.buffer = "";

      const failStart = (error) => {
        if (this.child === child) this.child = null;
        reject(error);
      };

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.#consume(chunk));
      child.stdin.on("error", (error) => this.#disconnect(child, error));
      child.once("error", (error) => {
        failStart(error);
        this.#disconnect(child, error);
      });
      child.once("exit", (code, signal) => {
        const error = new Error(`Codex app-server exited (${signal || code})`);
        failStart(error);
        this.#disconnect(child, error);
      });
      child.once("spawn", () => {
        this.#sendRequest("initialize", {
          clientInfo: { name: "codex-taskboard", title: "Codex Taskboard", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        }, { skipStart: true })
          .then(() => {
            if (this.child !== child) throw new Error("Codex app-server disconnected during initialization");
            child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
            resolve();
          })
          .catch((error) => {
            failStart(error);
            try { child.kill("SIGTERM"); } catch {}
          });
      });
    }).finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  startThread(params) {
    return this.request("thread/start", params);
  }

  setThreadName(threadId, name) {
    return this.request("thread/name/set", { threadId, name });
  }

  startTurn(params) {
    return this.request("turn/start", params);
  }

  readThread(threadId) {
    return this.request("thread/read", { threadId, includeTurns: true });
  }

  async close() {
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    this.#rejectPending(new Error("Codex app-server client closed"));
    if (!child) return;
    try { child.stdin.end(); } catch {}
    try { child.kill("SIGTERM"); } catch {}
  }

  #sendRequest(method, params, options = {}) {
    if (!options.skipStart && !this.child) {
      return this.start().then(() => this.#sendRequest(method, params, { skipStart: true }));
    }
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not connected"));
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.requestTimeoutMs);
      timeout.unref();
      this.pending.set(id, { resolve, reject, timeout, method });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  #consume(chunk) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) {
        try { this.#handleMessage(JSON.parse(line)); } catch {}
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  #handleMessage(message) {
    if (message?.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(appServerError(message.error, `${pending.method} failed`));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message?.method !== "string") return;
    for (const listener of this.listeners) {
      try { listener(message); } catch {}
    }
  }

  #disconnect(child, error) {
    if (this.child !== child) return;
    this.child = null;
    this.#rejectPending(error);
    if (this.closing) return;
    for (const listener of this.listeners) {
      try { listener({ method: "app-server/disconnected", params: { error: error.message } }); } catch {}
    }
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
