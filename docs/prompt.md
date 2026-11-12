# 让模型更愿意建任务的提示词

`task_write` 的工具描述本身已经写了"有实施顺序就登记成任务"，但模型每轮的注意力有限，多步任务时常常只在正文里列计划、不调用工具。想让任务卡片更像"任务列表"，把下面这段话贴进 `AGENTS.md`（它会作为 workspace instructions 注入每次请求）。

## 推荐片段（贴到 `~/.dsh/AGENTS.md` 或项目根目录 `AGENTS.md`）

```markdown
## 任务列表（task_write）

- 开始一个多步任务前，先把你打算做的步骤用 `task_write`（action `replace`，或逐条 `add`）写进任务列表，然后再动手；单步、一问一答的小事不必建任务。
- 执行过程中维护状态：开始做某步时 `set_status` 为 `doing`，做完立刻对这一步 `propose_done`，不要攒到最后一次性上报。
- 只有当你判断全部步骤完成时，才对剩余任务批量 `propose_done`；不要用 `set_status done` 代替 `propose_done`（后者会请用户确认）。
- 用户口述的待办、需求清单、后续想法，同样先 `add` 成任务再回答，而不是只写在回复正文里。
- `replace` 重写列表时沿用已有标题，机器会按标题复用 id，用户的任务不会丢。
```

（如果只想在本项目的会话里生效，就写到项目根目录的 `AGENTS.md`；想全局生效写到 `~/.dsh/AGENTS.md`。）

## 为什么只写 `AGENTS.md` 就够了

- Harness 的 `@deepseek-ai/dsh-agent-instructions` 会在每次请求前，把 `$DSH_HOME/AGENTS.md`（默认 `~/.dsh/AGENTS.md`）作为**用户全局**指令，加上从项目根到当前工作目录的每一级 `AGENTS.md` / `CLAUDE.md`，一次性注入成一条 durable 消息，不需要重启，改完下一条消息就生效。
- 不想改文件的话，也可以改系统提示词本身：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 里给 `system-prompt` 行加 `personaSuffix`（persona 后缀固定排在系统提示词里）。注意 patch 是**整块替换** `config`、不合并，所以要连同原有的 `personaPrefix` 一起写。缺点是要重启宿主，而且只对所有 Agent 统一生效，不像 `AGENTS.md` 可以按项目区分。
- 不建议在每一轮对话里临时说"记得建任务"——那只能管当前这轮。

## 检查清单（做完了还是不建任务就逐条看）

1. **插件装在哪**：`task_write` 是宿主侧工具，必须出现在 `~/.dsh/profiles/<当前 profile>/package.json` 的 `dependencies` 和 `dsh.profile.bundles` 里，改完要**重启宿主**。只在某个别的 profile 里装了，这个 profile 的会话里就没有这个工具。
2. **当前会话用的哪个 preset**：Web 的会话跑在 agent preset（Standard / Creator / PTC / Minimal / 自定义）里，每个 preset 是一份独立的插件列表；`task_write` 来自 profile 的 bundle 层，不随 preset 切换而消失，但如果在某个 preset 的 YAML 里把插件禁用了就会没有。在设置 → Agent 预设里点"查看配置"能看到当前 preset 的插件清单。
3. **是不是被"待办工具"抢了**：同一个会话里还挂着一个内置的 `todo_write`，两个工具的语义接近，模型经常只用其中一个。上面的提示词里点名 `task_write` 就是为了压过这个默认倾向。
4. **工具在不在**：让模型说一句"列出你能用的工具，找 task_write"，或者直接问"你现在能调用 task_write 吗"。不在的话看宿主导出里有没有插件加载报错。
