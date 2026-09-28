import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const skillSource = await readFile(
  new URL("../skills/code-loop-board/SKILL.md", import.meta.url),
  "utf8",
);

test("the Loop board skill coordinates configured issue execution and review handoff", () => {
  assert.match(skillSource, /^name: code-loop-board$/m);
  assert.match(skillSource, /执行前读最新任务和全部评论/);
  assert.match(skillSource, /更新时使用最新 `--if-version`/);
  assert.match(skillSource, /领取配置中 ready 的任务，按允许流转进入 working/);
  assert.match(skillSource, /版本冲突或他人已领取就跳过，不重复实施/);
  assert.match(skillSource, /评论记录修改、实际验证与剩余问题，再移动至 review 绑定状态/);
  assert.match(skillSource, /动作所需状态 ID 都先从 JSON 读取/);
});
