# AI 平台适配指南

## 从这段提示词开始

```text
请按本指南为我配置 Loop看板的平台适配。我会提供平台地址、看板项目、来源范围、
认证方式及样例事项。看板项目优先使用 Codex 自动识别的项目；尚无记录时引导我在
嵌入式看板选择一次，由看板自动创建后读取实际 ID，不要求重复手动创建。
再检查现有配置，列出缺少的文件、对应模板和待填字段，
能生成的本机骨架先生成；无法确认的配置引导我自行取得并填写，不猜测或覆盖已有值。
引导我在本机完成登录或填写凭据。按真实平台编写并保存适配脚本，实际验证读取；
只执行我明确授权的样例写入。报告已配置、待填写和已验证的结果，不提交或推送 Git。
```

完整输入模板和逐字段填写说明见 [平台接入入口](README.md)。AI 应先区分“文件不存在”“字段未填写”“模块未实现”和“登录未完成”，给出对应路径与下一步；缺少认证时不能生成空会话文件冒充已登录，缺少模块时不能把连接注册成功当作平台接通。

Loop看板只处理结构化来源、任务交付和语义动作。平台 API、页面选择器、状态名和登录逻辑全部保存在适配包中。仓库不内置具体平台，示例不是可直接使用的已验证适配器。

## 操作路径

`clb integration inspect` 读取本地注册 → `sync` 调用包的 `listIssues` → 服务以项目、连接、范围、外部 ID 查重并通过任务 API 写入 → 看板显示导入任务。
`clb integration action TASK_ID --action start_work` 读取任务的 `externalIssue` → 解析连接 → 包执行并核验动作 → 保存外部状态快照。动作不会擅自移动本地看板列。
注册由 `server/integrations/registry.mjs` 完成；服务在 `server/integrations/service.mjs`，同步规则在 `server/integrations/sync.mjs`。前端、数据库、自动化提示词不增加具体平台判断。

## 输入与产物

接入前确认 providerId、连接 ID、项目范围、允许的登录方式、样例事项及需要的语义动作。
创建 `integrations/local/<provider-id>/provider.mjs` 和 `ADAPTER.md`；从 [Playwright 模板](../../integrations/templates/playwright-provider.mjs) 和 [适配记录模板](../../integrations/templates/ADAPTER.md) 开始。
在本地 `integrations.json` 显式注册模块与项目连接，结构见 [配置示例](integrations.example.json)。模块路径相对于配置文件所在目录解析，属于受信任的本地执行代码。绝不从远端事项正文获取脚本路径。

## 发现、实现和验证

1. 先检查目标系统已有 API/CLI。需要页面操作时观察真实登录、列表、详情、分页和动作表单；只使用观察到的接口和选择器。
2. 将平台数据转换为下面的契约。源状态读取映射和动作写入映射分开维护；未知状态返回 `unmapped`。
3. 认证由适配包处理。连接的本地会话目录是 `.loop-integrations/<connectionId>/`；凭据通过本地路径或环境变量引用，不输出或提交任何秘密。模板要求已有 `storage-state.json`，不猜测登录流程。
4. 实际读取指定样例，确认稳定身份、列表分页和详情。若登录失败，返回明确错误，不把登录页当成空列表。
5. 对授权样例执行所需动作，再读取源事项确认结果。未授权写入时只验证读取，并在 ADAPTER.md 明确动作尚未验证。
6. `describe` 只声明实际实现的操作；在 ADAPTER.md 分别记录实现情况与真实验证情况。日常运行复用保存的包；页面变化后按本流程维护同一个包。

更新适配包代码后重启本地 companion，再重复受影响的操作；Node 模块加载会缓存已加载实现。单独修改连接 JSON 在下一次调用时读取，无需重启。

## 模块契约

导出 `describe(context)`、`listIssues(context, input)`、`getIssue(context, input)`、`applyAction(context, input)`。没有实现的操作不写进 `operations`，调用时返回稳定错误码。
`context.connection` 是本地连接配置；`context.runtime` 提供 `root/sessionRoot/resolveLocalPath(value)`。

```js
describe(context) // { name, operations: ['listIssues', 'getIssue', 'applyAction'], actions: ['start_work'], notes: [] }
listIssues(context, { scopeId, filter, cursor }) // { issues: [issue], nextCursor: null | 'opaque-cursor' }
getIssue(context, { issue: externalIssue }) // issue
applyAction(context, { issue: externalIssue, action, parameters }) // actionResult
```

```json
{
  "externalIssue": {
    "connectionId": "example-team", "scopeId": "example-scope",
    "externalId": "stable-id", "key": "BUG-1", "url": "https://tracker.example.com/issues/stable-id"
  },
  "title": "样例标题", "description": "源事项正文",
  "state": { "id": "open", "label": "Open", "semantic": "new" },
  "comments": [{ "id": "source-comment-id", "body": "评论内容" }]
}
```

动作结果 `{ok:true,action,changed,issue:externalIssue,state,verified:true}` 只用于真实确认的结果。`changed:false` 可表示目标已满足；无法确认时抛出稳定错误码，先读取实际状态，不自动重复提交。`start_work/mark_fixed/request_verification` 是首批语义动作，其他动作按实际能力声明。

适配包在访问来源 URL 和写入前核对配置的实例、项目范围和稳定 ID；返回标准来源必须与传入身份一致。不要只依赖可变的显示编号或页面标题选择目标。

同步仅新增 `new/reopened` 事项；已有非归档任务保留正文与交付仓库快照、更新源标题和状态，评论按源 ID 去重。仅当对应角色已绑定且 manualTransitions 允许时，reopened 才将 done/canceled 分类的终态任务转回 ready；源 closed 还需要显式配置 closeOnSourceClosed:true 才尝试进入 done。存在非 completed/canceled 的自动化执行时（包括 paused_for_human），同步不移动该任务。归档事项不在同步查询范围内，相同来源再次导入可能报身份冲突，需先查明归档记录再决定处理。批次不保证整体原子性，失败前可能已保存前面的事项。fixed 不自动解释为已发布。

动作的 `externalCompleted:true/localCompleted:false` 表示源写入已确认、本地保存失败。先读取两侧实际状态并补本地记录，不重复外部动作。

## 历史来源与发布

旧描述不再作为机器协议。需要迁移时先制作明确的任务 ID→标准 externalIssue/delivery 映射，再通过任务 API 更新；不得根据标题猜平台或身份。
发布适配独立实现 `triggerRelease/getRelease`，由 `server/integrations/releases.mjs` 读取 releaseProviders/releaseConnections。当前只有服务模块，没有发布 CLI/HTTP 入口、内置 CI 或自动触发发布；还需实现调用入口。不要把 CI 地址或构建步骤塞进缺陷 provider。
