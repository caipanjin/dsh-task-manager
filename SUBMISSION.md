## Title

```
[插件提交] caipanjin/dsh-task-manager — 在聊天里管理模型建议/自己添加的任务，一键交给模型执行
```

## Body

```markdown
### 仓库地址
<https://github.com/caipanjin/dsh-task-manager>

### 一句话价值
给 DeepSeek Harness 增加一个可拖动的悬浮任务面板：任务可以来自模型建议（模型给出实施顺序）或用户手动添加，每条标注来源；用户点一下就能把某个任务发到对话框让模型开始执行。

### 能力分类
工具与能力

### 安装命令
`dsh plugin --profile web add @caipj/dsh-task-manager`

（源码安装备用：`dsh plugin --profile web add github:caipanjin/dsh-task-manager`）

### 兼容与运行要求
- 平台：Web（Harness 桌面/网页 UI）
- 依赖 Harness 暴露 `shell.overlay` 插槽、`sessionProjections` 服务，以及客户端 `conversation.send` / `sessions.scope` 服务
- 仅使用公开主题 token（`--dsw-alias-*`），自动适配浅色/深色

### 许可证
MIT

### 截图 / 演示
见仓库 README 截图（docs/task-panel.png）：悬浮面板含任务列表、来源徽标（模型建议/手动添加）、状态点、开始/完成按钮、"添加任务"输入框。

### 补充说明
- 无网络请求、无外部服务、无遥测
- 权限：读取任务投影；仅写自己的 localStorage 键（`@caipj/dsh-task-manager:*`）；新增一个模型工具 `task_write`
- 已知限制：任务"完成确认"状态按会话存于 localStorage，不回写会话日志；用户自建任务在你点"开始"前不进入模型上下文
- 模型判断任务完成时只"提议完成"，由用户批量确认才生效

### 提交前自查
- [x] 仓库已公开
- [x] 已添加 GitHub topic：dsh-plugin
- [x] README 包含安装命令
- [x] 插件导出 apply(ctx) 模块
- [x] 仓库根目录包含 package.json
```

## Pre-filled issue URL (opens GitHub with title only; paste body above)

https://github.com/dshplugin/dsh-plugin-hub/issues/new
