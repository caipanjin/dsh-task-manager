# dsh-task-manager

Tasks in the DeepSeek Harness chat: the model proposes them, you add them, and a
single click hands one to the model to start.

A tiny, dependency-free plugin that gives the Harness a floating task panel. Task
items can come from **the model itself** (e.g. it suggests an implementation order)
or from **you** (typed in the panel). Each task shows its origin — *Model* vs
*Mine* — so you always know where it came from. When the model reports a task as
finished, the panel raises a **bulk confirmation** prompt instead of silently
marking things done: you decide. Pick a task and hit **Start** to drop
`Start this task: <title>` into the conversation and let the model begin.

![Task manager panel](docs/task-panel.png)

## Features

- **Two sources of tasks** — model-suggested (via the `task_write` tool) and
  user-added (typed in the panel), with a per-row origin badge (**Model** /
  **Mine**).
- **Floating, draggable panel** — lives in the shell overlay, opens from a compact
  pill, can be dragged anywhere and remembers where you left it (per browser).
- **Explicit completion + confirm-before-done** — every task has a **Complete**
  action; when the model judges tasks done it only *proposes* it, and the panel
  shows a **Confirm all / Dismiss** banner. Nothing is finalized without you.
- **Start a task from the list** — **Start** sends the task to the chat so the
  model picks it up; the panel then gets out of the way.
- **Light & dark** — uses only real Harness theme tokens, so it follows the app
  theme automatically.
- **Bilingual** — English and 简体中文.

## Install

Published on npm:

```bash
dsh plugin --profile web add @caipj/dsh-task-manager
```

Or straight from source:

```bash
dsh plugin --profile web add github:caipanjin/dsh-task-manager
```

Then restart the Harness host once so the host-side tool
(`task_write`) registers, and reload the window. The task pill appears in the
bottom-right; click it to expand, drag it to move.

## Usage

- **Add a task**: expand the pill and type into the input, then **Add**. It stays
  in the list — it is not copied into the chat.
- **Model tasks**: when the model calls `task_write` (e.g. proposes an order of
  work), the tasks appear automatically, badged **Model**.
- **Start a task**: click **Start** on a row — the prompt is sent to the
  conversation.
- **Complete**: click **Complete** on a row. If the model reports completion, a
  confirmation banner appears; use **Confirm all** or per-row **Confirm**.
- **Remove / clear**: user tasks have a **✕**; **Clear done** removes finished
  ones.

## How it works

- **Host half** (`index.js`) registers a model-facing tool `task_write`
  (`add` / `set_status` / `propose_done` / `remove` / `replace` / `clear` /
  `list`) and a session projection `taskManager`. The tool's rendered result
  embeds one machine marker line `TASK_STATE::<json>` carrying the full list; the
  projection folds those markers out of the existing `tool/result` event — no
  custom session event type is introduced.
- **Client half** (`client.js`) registers a widget into the `shell.overlay` slot.
  It reads model tasks from the projection and keeps user tasks + confirmations
  in `localStorage` (installed plugins cannot write the host projection, so
  confirmations are client-side by design). **Start** calls the active session's
  `conversation.send(text)`.

## Compatibility

- Platform: **web** (the Harness desktop/web UI).
- Requires a Harness build that exposes the `shell.overlay` slot, the
  `sessionProjections` service, and the `conversation.send` / `sessions.scope`
  client services. Uses only public, stable theme tokens
  (`--dsw-alias-*`).

## Permissions / trust

- No network access, no external services, no telemetry.
- Reads the session projection for tasks; writes only its own `localStorage` keys
  under `@caipj/dsh-task-manager:*`.
- Adds one model tool (`task_write`). Nothing else is touched.

## Known limitations

- Bulk "confirm done" state is stored per session in `localStorage`; it is not
  written back into the session log (by design for a third-party plugin).
- User tasks are local to the browser/session, not synced into the model context
  until you **Start** one.

## License

[MIT](LICENSE) © caipanjin
