import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReviewPolicyLoader } from "../server/review-policy-loader.mjs";
import { RiskReviewEvaluator } from "../server/risk-review-evaluator.mjs";

test("repository policies are loaded independently from each repository root", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-review-policy-"));
  const backend = path.join(root, "sample-backend");
  const frontend = path.join(root, "sample-frontend");
  await Promise.all([mkdir(backend), mkdir(frontend)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    writePolicy(backend, {
      version: 1,
      changedLinesThreshold: 60,
      blacklist: ["apps/*flow*/**"],
    }),
    writePolicy(frontend, {
      version: 1,
      changedLinesThreshold: 30,
      whitelist: ["src/views/**"],
    }),
  ]);

  const loader = new ReviewPolicyLoader();
  assert.deepEqual(await loader.policyForRepository(backend), {
    version: 1,
    changedLinesThreshold: 60,
    blacklist: ["apps/*flow*/**"],
  });
  assert.deepEqual(await loader.policyForRepository(frontend), {
    version: 1,
    changedLinesThreshold: 30,
    whitelist: ["src/views/**"],
  });
});

test("risk review evaluates paths against the policy owned by each repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-review-evaluator-"));
  const backend = path.join(root, "sample-backend");
  const frontend = path.join(root, "sample-frontend");
  await Promise.all([mkdir(backend), mkdir(frontend)]);
  t.after(() => rm(root, { recursive: true, force: true }));

  await Promise.all([
    writePolicy(backend, {
      version: 1,
      changedLinesThreshold: 50,
      blacklist: ["apps/*flow*/**"],
    }),
    writePolicy(frontend, {
      version: 1,
      changedLinesThreshold: 50,
      whitelist: ["src/views/**"],
    }),
  ]);

  const changes = new Map([
    [backend, "apps/emergency_flows/service.py"],
    [frontend, "src/views/dashboard.vue"],
  ]);
  const evaluator = new RiskReviewEvaluator({
    policyLoader: new ReviewPolicyLoader(),
    runGit: async (repositoryPath, args) => {
      if (args[0] === "rev-parse") return "head\n";
      if (args[0] === "check-ignore") return "";
      const changedPath = changes.get(repositoryPath);
      if (args.includes("--numstat")) return `1\t0\t${changedPath}\0`;
      if (args.includes("--name-status")) return `M\0${changedPath}\0`;
      throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    },
  });

  const result = await evaluator.evaluate({
    execution: {
      repositories: [
        repository("sample-backend", backend),
        repository("sample-frontend", frontend),
      ],
    },
  });

  assert.equal(result.requiresApproval, true);
  assert.deepEqual(result.reasons, [
    "sample-backend: Changed path matches blacklist pattern apps/*flow*/**",
  ]);
});

test("risk review marks static build output as a prohibited submission", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "taskboard-review-static-output-"));
  const frontend = path.join(root, "sample-frontend");
  await mkdir(frontend);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writePolicy(frontend, {
    version: 1,
    changedLinesThreshold: 500,
    whitelist: ["src/**"],
  });

  const evaluator = new RiskReviewEvaluator({
    policyLoader: new ReviewPolicyLoader(),
    runGit: async (_repositoryPath, args) => {
      if (args[0] === "rev-parse") return "head\n";
      if (args[0] === "check-ignore") return "";
      if (args.includes("--numstat")) return "1\t0\tstatic/dist/index.js\0";
      if (args.includes("--name-status")) return "M\0static/dist/index.js\0";
      throw new Error(`Unexpected git arguments: ${args.join(" ")}`);
    },
  });

  const result = await evaluator.evaluate({ execution: { repositories: [repository("sample-frontend", frontend)] } });

  assert.equal(result.requiresApproval, true);
  assert.deepEqual(result.prohibitedPaths, ["frontend/static/dist/index.js"]);
  assert.match(result.reasons[0], /static.*不允许提交或 push/);
});

function repository(name, repositoryPath) {
  return {
    name,
    repositoryPath,
    worktreePath: repositoryPath,
    baseCommit: "base",
  };
}

async function writePolicy(repositoryPath, policy) {
  await writeFile(
    path.join(repositoryPath, "review-policy.json"),
    `${JSON.stringify(policy, null, 2)}\n`,
  );
}
