# 平台适配记录

状态：模板，尚未连接真实平台。复制到 `integrations/local/<provider-id>/ADAPTER.md` 后填写。

## 接入事实

- providerId、平台版本或页面特征：待记录。
- 连接实例、项目范围、样例事项：记录非敏感标识；内部地址与样例放私有配置。
- 登录方式与本地凭据引用：待记录；不得粘贴凭据、Cookie 或 storageState。
- 稳定事项 ID、显示编号、详情导航方式：待观察。
- 列表筛选与分页、正文、评论 ID、附件：待观察。

## 动作与字段

记录读取状态到 `new/reopened/working/fixed/verifying/closed/unmapped` 的映射。
逐项记录 `start_work/mark_fixed/request_verification` 的允许前置状态、必填字段、真实操作入口和核验方法。
可选动作（例如 `mark_ai`）只有实现并验证后才加入 `describe().actions`。
未知状态必须保留原始 ID/标签并返回 `unmapped`。

## 实际验证

按能力记录验证日期、输入样例、可复现命令、实际结果与尚未验证事项。
模板运行成功、模拟结果、浏览器点击成功都不能证明源平台状态已更新。
动作写入后读取权威状态，确认事项身份及结果，才返回 `verified: true`。

## 页面维护

页面或接口变化时记录具体失败步骤，更新本包保存的脚本，并重新验证受影响能力。
日常业务任务通过统一 CLI 调用，不现场复制新的页面操作脚本。
