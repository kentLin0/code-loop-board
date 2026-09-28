---
name: code-loop-board
description: Configure Loop board states, manage projects and tasks through clb, execute assigned Worktree tasks, and create or maintain saved external issue adapters when explicitly requested.
---

# Loop看板

使用 `$code-loop-board` 管理 Loop看板。任务、评论和自动化动作统一通过 `clb`；提示词提供固定 runner 时必须用该入口。命令与副作用见 [CLI 参考](references/cli.md)。平台接入或维护时，从固定 runner 的 `cli/clb.mjs` 路径定位看板仓库，读取其中的 `docs/integrations/AI-ADAPTATION.md`。安装 Skill 后不能把 Skill 所在目录当作看板仓库。

## 先选工作路径

- 看板配置：导出项目生效 JSON，修改、校验并显式导入。状态 ID、名称、顺序、颜色、人工流转与自动化绑定以项目配置为准。
- 普通任务：读取任务与评论，按版本操作任务和关系；不要创建对简单工作没有价值的追踪事项。
- 自动化执行：任务绑定活动 `automationExecution` 时使用受控执行入口和返回的 Worktree/token，不走普通人工移列。completed/canceled 是历史执行；paused_for_human 的恢复按当前任务指令处理，可在允许流转内移回待领取，或在解决合并冲突后使用 resume-merge。
- 平台接入或页面变化：按明确授权维护保存的适配包，再由通用集成命令调用。日常业务执行不临时生成新脚本。

## 看板 JSON

先运行 `clb board-config export --project PROJECT_ID --json` 获取生效配置。
`states` 定义显示列；`initialState` 定义新建状态；`manualTransitions` 定义人工移动；`automation.bindings` 将 ready、working、approval、releaseReady、releasing、review、blocked、done、canceled 绑定到实际 ID。

不能把上述语义角色当作固定状态 ID，也不能根据中文列名推断状态。新增自定义状态修改 JSON 后必须 apply；替换任务仍在使用的状态 ID 时提供显式映射。自动化关闭时可能未配置角色绑定，不能自行猜测对应列。应用前重读生效配置并比较修改；CLI apply 的版本校验仅保护其读取到写入之间的并发变化。未完成执行（包括 paused_for_human）存在时，服务会拒绝状态 ID、状态映射及 automation 配置的结构变更。

## 普通任务

1. 优先使用任务提示或看板已选项目的真实 ID，并通过 `project list` 核对。`context current` 只按已存 workspacePath 匹配，不读取 Codex 当前选择；返回 local 或首个项目时不能据此认定目标。Codex 项目首次在嵌入式看板选择后会自动创建记录，不重复手动创建。先查询已有任务，相同需求补充原事项；存在依赖时建立关系。
2. 执行前读最新任务和全部评论。正文内 `/api/attachments/<id>/content` 图片按需用 `attachment download` 下载查看。
3. 任务、评论与 integration sync/action 写入由 `CODEX_THREAD_ID` 或明确 `--thread-id` 归属到当前会话，任务及评论更新时使用最新 `--if-version`。project 与 board-config 命令不接受 `--thread-id`。
4. 领取配置中 ready 的任务，按允许流转进入 working。版本冲突或他人已领取就跳过，不重复实施。
5. 按项目规则完成主路径并验证，评论记录修改、实际验证与剩余问题，再移动至 review 绑定状态。
6. 用户明确验收后才进入 done。无法继续进入 blocked，明确取消进入 canceled。动作所需状态 ID 都先从 JSON 读取。

## 自动化 Worktree

1. 先取 `automation context`。仅在返回的各仓库 Worktree 工作，使用返回的 token。delivery.repositories 的 repositoryId 匹配仓库目录名，targetBranch 匹配认领时母仓库当前分支；空列表表示使用发现的全部仓库。实际操作以 execution 返回的仓库、分支和基准提交快照为准，不自行切换母仓库。
2. 未改动仓库记录 unchanged。改动仓库按项目规则验证和提交；自动化授权的交付遵循执行上下文，用户本轮明确禁止 Git 写入时不得提交或推送。
3. 第一次 `acquire-merge` 前写修复总结：分析过程、缺陷根因或需求依据、修复内容、实际验证结果、剩余风险。评论失败先恢复，不能绕过。
4. `acquire-merge` 返回 awaiting_approval 时停止该阶段，不 fetch/rebase/push/fail/complete。只有 merging 才允许继续交付。
5. 在任务 Worktree fetch 指定目标、rebase、验证、正常 push `HEAD:<target>`，不切换母仓库、不 force-push。不快进失败时重新读取远端并处理，最多五次；无法安全合并用 `pause-merge` 保存原因及冲突文件。
6. 所有目标推送确认后，release 模式先 `prepare-release`；有 externalIssue 的事项按执行提示调用 `integration action ... --action mark_fixed`，review 模式同样可能需要源状态回写。没有来源绑定的事项跳过外部动作，不自动假设需要发布。
7. 外部 action 必须 `ok:true`、`verified:true`、`localCompleted:true` 且 state.semantic 符合目标；inspect/get/sync 不使用这个动作返回格式。外部已完成而本地未保存时读取当前两侧状态，补本地记录，不重复源写入。
8. 记录最终提交与交付结果，调用 `automation complete`。协调器核验、清理 Worktree、推进状态和释放槽位，不能手动移列替代。

审批后续跑仅执行批准的合并阶段，不重新开发。执行阶段 phase 与看板列状态是不同协议；JSON 更名不改变 phase。

## 验证和依赖

遵循当前项目 AGENTS.md 与用户明确要求。先证明真实主路径，再做最小修改并验证该路径；不得自动扩展为回归体系、防御代码或全量重构。需要测试时使用项目已有工具和必要范围，不能用虚构输出声称验证成功。

Worktree 已准备的依赖直接复用，不重复安装或重建环境。确有缺失时先查看项目依赖声明和原始错误，再执行范围内的恢复。运行 Python 工具使用项目环境；前端浏览器验证使用项目适用的真实页面路径。不要把固定前端/后端命名、语言或目录约定当作所有项目通用规则。

## 外部平台

`externalIssue` 的 connectionId/scopeId/externalId 是来源身份，key/url 用于展示导航。禁止从描述中的平台专属文字推断身份、仓库或交付方式。

先 `integration inspect --connection CONNECTION_ID` 确认能力。统一动作是 start_work、mark_fixed、request_verification；可选动作仅在包声明支持时调用。平台状态名、字段、DOM、认证、标题标记策略均由适配包维护。

没有实现的能力必须明确失败。`changed:false` 可以是目标已满足，但必须 `verified:true`。登录失败不是空列表，未知状态是 unmapped，fixed 不等于发布完成。普通拖动只更新本地状态，不自动写外部平台。

用户明确要求接入或维护时，可以按 AI 适配指南编写并保存 Playwright/API 模块；实际读写验证限授权范围。完成后记录实现能力、实际验证与未验证部分。不得输出、评论或提交凭据、Cookie、storageState。

## 失败恢复

token、槽位所有权或固定 runner 要求结束的错误立即停止当前执行，不干预其他任务。其他问题先读取真实错误与状态，进行一次范围内恢复，再重跑原失败动作；不能不改变条件反复尝试。

仍失败或缺少权限、凭据、业务输入时，记录非敏感证据，通过 `automation fail` 保存原因、释放槽位并保留 Worktree。评论写入本身持续失败时把证据放入 fail 原因。没有执行上下文时使用普通任务路径，不虚构 token。
