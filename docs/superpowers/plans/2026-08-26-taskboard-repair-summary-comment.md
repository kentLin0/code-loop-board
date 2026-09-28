# Taskboard Repair Summary Comment Implementation Plan

> 历史设计记录，非当前操作手册。下文的状态名、命令、实施步骤、测试结果及‘当前’均属于当时的设计或记录，不代表本版本已经实现或仍然适用。不要按其中的提交、测试优先或重启步骤直接执行；现行流程以 [README](../../../README.md)、[项目规则](../../../AGENTS.md) 和 [Skill](../../../skills/code-loop-board/SKILL.md) 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require every Taskboard repair prompt to write one structured repair summary before review, merge, or status transition.

**Architecture:** Keep the behavior in the existing prompt generator. Add one shared prompt-fragment helper so Worktree, ordinary selected-task, and fallback prompts use the same five-section comment contract; place the fragment before `automation acquire-merge`, then document the observable review flow in the team guide.

**Tech Stack:** Node.js ESM, Taskboard `clb` CLI, Markdown documentation

---

### Task 1: Require the structured comment before review or merge

**Files:**
- Modify: `shared/taskboard-automation.mjs:144-248`
- Modify: `docs/taskboard-team-usage.md:228-238`

- [ ] **Step 1: Add one shared prompt-fragment helper**

Add this helper before `buildTaskboardAutomationPrompt`:

```js
function repairSummaryCommentInstruction(issueReference, { automated = false } = {}) {
  return [
    `修复完成并验证后，必须先且只通过一次 runClb(["comment", "add", ${JSON.stringify(issueReference)}, "--body", <结构化修复总结>, "--json"]) 写入任务详情评论；评论成功前不得进入审批、合并、push 或状态流转。`,
    "<结构化修复总结>必须使用 Markdown 二级标题，按顺序完整包含：## 分析过程、## 缺陷根因、## 修复内容、## 验证结果、## 剩余风险。分析过程写明复现现象、排查路径和关键证据；缺陷根因写明因果链，不得只重复表面现象；修复内容写明修改位置、行为变化和范围；验证结果写明实际命令或用例、TDD Red/Green 结果及未验证项；剩余风险没有时明确写‘无已知剩余风险’。不得在评论中包含凭据或其他敏感信息。",
    automated
      ? "若 comment add 失败，不得调用 automation acquire-merge；立即按既有 automation fail 路径记录非敏感原因并释放槽位。"
      : "若 comment add 失败，立即停止，不得把议题移动到下一状态。",
  ].join("\n");
}
```

- [ ] **Step 2: Put the comment before `automation acquire-merge`**

In the automatic Worktree branch, insert the shared fragment after local verification and commit requirements but before the current `automation acquire-merge` instruction:

```js
repairSummaryCommentInstruction(identifier, { automated: true }),
```

Keep the approval-resume-only prompt unchanged so it cannot repeat the analysis comment. Change the post-push comment wording so it records only final merge and push results rather than duplicating the five-section repair analysis.

- [ ] **Step 3: Apply the same contract to non-Worktree prompts**

Replace the generic “记录关键改动、验证结果” instruction in the selected-task non-Worktree branch with:

```js
repairSummaryCommentInstruction(identifier),
"结构化修复总结写入成功后，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。",
```

Replace the fallback prompt’s generic completion comment with:

```js
repairSummaryCommentInstruction("<议题>"),
"结构化修复总结写入成功后，再使用最新 version 将议题移动到 in_review；不要直接标记为 done。",
```

- [ ] **Step 4: Document what the approver sees**

After the paragraph describing `pending_approval` in `docs/taskboard-team-usage.md`, add:

```markdown
进入待审批前，修复会话必须先在任务详情写入一条结构化修复总结，依次包含“分析过程、缺陷根因、修复内容、验证结果、剩余风险”。验证结果需要记录实际命令或用例及 TDD Red/Green 结果；没有剩余风险时明确写“无已知剩余风险”。评论写入失败时不得进入待审批或继续合并，因此审批人打开 Diff 时可以同时核对修复依据。
```

- [ ] **Step 5: Verify the generated operation path**

Run the existing focused prompt tests:

```bash
node --test test/taskboard-automation.test.mjs
```

Expected: all tests in `test/taskboard-automation.test.mjs` pass.

Generate one Worktree prompt with `buildTaskboardAutomationPrompt` and verify:

```js
const prompt = buildTaskboardAutomationPrompt(requestWithAutomationExecution);
for (const heading of ["## 分析过程", "## 缺陷根因", "## 修复内容", "## 验证结果", "## 剩余风险"]) {
  if (!prompt.includes(heading)) throw new Error(`missing ${heading}`);
}
if (prompt.indexOf("<结构化修复总结>") > prompt.indexOf("automation\", \"acquire-merge")) {
  throw new Error("repair summary must precede acquire-merge");
}
```

Expected: no exception; the five-section comment requirement appears before the first merge acquisition instruction.

- [ ] **Step 6: Check formatting and commit**

Run:

```bash
git diff --check
```

Expected: exit code 0 with no output.

Commit only the prompt and team-guide changes:

```bash
git add shared/taskboard-automation.mjs docs/taskboard-team-usage.md
git commit -m "feat: require repair summary before review"
```

