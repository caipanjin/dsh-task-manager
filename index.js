/**
 * Host half of the local Task Manager bundle.
 *
 * State model
 * -----------
 * Tasks live in the session log, never in a plugin-private store, so they replay
 * across reload, fork and resume and stay reconstructable from the committed
 * events (the Harness source-of-truth rule). The task list is written by the
 * model-facing `task_write` tool. That tool's rendered result embeds one
 * machine marker line (`TASK_STATE::<json>`) carrying the complete post-change
 * list; a session projection (`taskManager`) folds those markers back into
 * `{ tasks }`. No new event type is introduced (third-party plugins cannot
 * append custom session events), so the fold rides the existing `tool/result`
 * event.
 *
 * The Client half reads the projected value through the sessions service
 * (`ctx.sessions.binding(id).session.projections.faceOf('taskManager')`).
 */

// No imports: a third-party bundle is loaded by path from wherever it is
// linked, so a bare `@deepseek-ai/...` specifier only resolves when the bundle
// happens to ship its own node_modules — and a stale/dangling one takes the
// whole plugin down at boot (`ERR_MODULE_NOT_FOUND`). `ctx.tools.register()`
// accepts a plain definition object with raw JSON Schema, so the tool needs no
// helper at all.

const name = 'task-manager';
// `commands` is the sanctioned Client-callable Host entry point: the Client UI
// runs the `tasks-sync` command through `ctx.remote.commands.execute()`, and the
// command/done lifecycle event it logs carries the same `TASK_STATE::` marker the
// tool result does — so the projection folds BOTH model writes and user writes
// into one replayable list. It is fetched with `ctx.get('commands')` rather than
// injected, so the plugin still activates in profiles that lack the command
// registry (the panel's writes then surface a visible error instead).
const inject = ['tools', 'sessionProjections'];

/** Allowed task statuses. */
const STATUSES = ['todo', 'doing', 'done'];
/** Cursor used to embed the machine-readable task state in the tool's result text. */
const MARKER = 'TASK_STATE::';
/** The model-facing tool whose result carries the marker. */
const TOOL_NAME = 'task_write';
/** The Client-callable command whose result carries the marker. */
const COMMAND_NAME = 'tasks-sync';

let nextIdCounter = 0;
/** Mint a stable, short, collision-resistant task id for this process. */
function mintId() {
  nextIdCounter += 1;
  return `t${Date.now().toString(36)}${nextIdCounter.toString(36)}`;
}

/** A minimal zod-compatible schema: identity parse (validation is not load-bearing here). */
function identitySchema() {
  return { parse: (value) => value };
}

/** Normalize one raw task record into the canonical shape, or throw a clear error. */
function normalizeTask(raw) {
  if (raw === null || typeof raw !== 'object') throw new Error('each task must be an object');
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title.length === 0) throw new Error('each task needs a non-empty `title`');
  const status = STATUSES.includes(raw.status) ? raw.status : 'todo';
  const origin = raw.origin === 'user' || raw.origin === 'model' ? raw.origin : 'model';
  const task = {
    id: typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : mintId(),
    title,
    status,
    origin,
  };
  if (typeof raw.detail === 'string' && raw.detail.trim().length > 0) task.detail = raw.detail.trim();
  // `proposedDone` marks a task the model believes is complete but which awaits
  // the user's confirmation in the floating card. Only meaningful with done.
  if (raw.proposedDone === true && status === 'done') task.proposedDone = true;
  // `archivedAt` hides a task from the active list while KEEPING it in the same
  // list (archived, not deleted): the card offers a separate archive view, and
  // the record survives a reload/fork because it never leaves the session log.
  // Only a done task can be archived — an unfinished task has nothing to file.
  const archivedAt = normalizeArchivedAt(raw.archivedAt);
  if (archivedAt !== undefined && status === 'done') task.archivedAt = archivedAt;
  return task;
}

/** Accept an ISO timestamp (or ms epoch) as an archive stamp; anything else is ignored. */
function normalizeArchivedAt(value) {
  if (typeof value === 'string' && value.length > 0) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
    return undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
}

/** True when a task is filed in the archive instead of the active list. */
function isArchived(task) {
  return typeof task.archivedAt === 'string' && task.archivedAt.length > 0;
}

/** Case- and width-insensitive, punctuation-free form used for title matching. */
function foldTitle(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~，。、；：？！“”‘’（）《》【】…—－]/g, '');
}

/**
 * Resolve one requested task reference to exactly one task.
 *
 * A reference is normally a task id. Models routinely forget ids, so a title is
 * also accepted when it identifies exactly one task: an exact (whitespace- and
 * punctuation-insensitive) title match wins, otherwise a single unique prefix
 * match wins. Ambiguity is an error rather than a guess, because silently
 * marking the wrong task done is worse than asking the model to disambiguate.
 */
function resolveTask(tasks, ref) {
  const byId = tasks.find((task) => task.id === ref);
  if (byId !== undefined) return byId;

  const needle = foldTitle(ref);
  if (needle.length === 0) throw new Error(`no task with id ${JSON.stringify(ref)}`);
  const exact = tasks.filter((task) => foldTitle(task.title) === needle);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new Error(
      `title ${JSON.stringify(ref)} matches ${exact.length} tasks (${exact.map((t) => t.id).join(', ')}); pass \`ids\` instead`,
    );
  }
  const prefix = tasks.filter((task) => foldTitle(task.title).startsWith(needle));
  if (prefix.length === 1) return prefix[0];
  if (prefix.length > 1) {
    throw new Error(
      `title ${JSON.stringify(ref)} is ambiguous: ${prefix
        .map((t) => `${t.title} (${t.id})`)
        .join(', ')}; pass the exact id or a longer title`,
    );
  }
  throw new Error(`no task matching id or title ${JSON.stringify(ref)}`);
}

/** Serialize the task list into the marker line the projection folds. */
function encodeState(tasks) {
  return `${MARKER}${JSON.stringify({ tasks })}`;
}

/** Parse the marker line out of a tool-result message's text blocks; returns tasks or undefined. */
function decodeStateFromContent(content) {
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      const at = block.text.indexOf(MARKER);
      if (at >= 0) {
        const json = block.text.slice(at + MARKER.length).split('\n')[0].trim();
        try {
          const parsed = JSON.parse(json);
          if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** Parse the marker line out of a plain string (a command result text); returns tasks or undefined. */
function decodeStateFromText(text) {
  if (typeof text !== 'string') return undefined;
  const at = text.indexOf(MARKER);
  if (at < 0) return undefined;
  const json = text.slice(at + MARKER.length).split('\n')[0].trim();
  try {
    const parsed = JSON.parse(json);
    if (parsed && Array.isArray(parsed.tasks)) return parsed.tasks;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Human-readable + marker rendering of a tool result for the given task list. */
function renderState(tasks, carried) {
  const counts = { todo: 0, doing: 0, done: 0 };
  let archived = 0;
  for (const task of tasks) {
    if (isArchived(task)) {
      archived += 1;
      continue;
    }
    counts[task.status] = (counts[task.status] || 0) + 1;
  }
  const doneNote = archived > 0 ? `${counts.done} done, ${archived} archived` : `${counts.done} done`;
  const lines = [
    `Task list updated: ${counts.todo} to do, ${counts.doing} in progress, ${doneNote}.`,
  ];
  // A `replace` that carried tasks over must SAY so: otherwise the model reads
  // its own rendered list, sees entries it did not just write, and concludes the
  // write went wrong (or silently re-sends `replace` to "fix" it — which is the
  // very loop that used to delete the user's tasks).
  if (Array.isArray(carried) && carried.length > 0) {
    const filed = carried.filter((task) => task.filed === true).map((task) => task.title);
    const live = carried.filter((task) => task.filed !== true).map((task) => task.title);
    if (live.length > 0) {
      lines.push(`Kept from the previous list (not in this plan): ${live.map((title) => `"${title}"`).join(', ')}. Archive or remove them explicitly if they are done.`);
    }
    if (filed.length > 0) {
      lines.push(`Moved to the archive (finished and not in this plan): ${filed.map((title) => `"${title}"`).join(', ')}.`);
    }
  }
  // The model only needs the ACTIVE list — archived tasks are filed away, and
  // replaying them every turn would drown the real working set. They are still
  // carried in the marker line, so `list` and the Client archive view see them.
  const active = tasks.filter((task) => !isArchived(task));
  if (active.length > 0) {
    lines.push('Current tasks:');
    for (const task of active) {
      const mark = task.status === 'done' && task.proposedDone ? 'done, awaiting confirmation' : task.status;
      lines.push(`- [${mark}] ${task.title}${task.id ? ` (${task.id})` : ''}`);
    }
  }
  if (archived > 0) {
    lines.push(`(${archived} archived task(s) hidden; archive view is in the task card.)`);
  }
  lines.push('');
  lines.push(encodeState(tasks));
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Apply one tool action against the current task list, returning the new list.
 * Pure: never mutates the input array or its task objects.
 */
function applyAction(action, args, current) {
  const tasks = current.map((task) => ({ ...task }));
  let carried = [];
  switch (action) {
    case 'add': {
      const task = normalizeTask({
        title: args.title,
        detail: args.detail,
        origin: args.origin === 'user' ? 'user' : 'model',
        status: args.status,
      });
      // `position` appends by default; a 1-based `position` inserts before that index.
      const pos = Number.isInteger(args.position) && args.position > 0
        ? Math.min(args.position - 1, tasks.length)
        : tasks.length;
      tasks.splice(pos, 0, task);
      return { tasks, carried };
    }
    case 'edit': {
      // Rewrite one task's title and/or detail WITHOUT touching its id, status,
      // origin, completion proposal or archive stamp. This is what the card's
      // "✎" button sends when the user fixes a typo or fills in the body text;
      // `replace` cannot be used for that because it rebuilds the list from the
      // incoming objects and would drop the per-task state the user set.
      const task = resolveTask(tasks, args.id);
      const title = typeof args.title === 'string' ? args.title.trim() : undefined;
      if (title !== undefined && title.length === 0) throw new Error('`title` cannot be empty');
      const detailProvided = Object.prototype.hasOwnProperty.call(args, 'detail');
      if (title === undefined && !detailProvided) throw new Error('edit needs `title` and/or `detail`');
      if (title !== undefined) task.title = title;
      if (detailProvided) {
        const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
        // An explicitly empty detail CLEARS it; the key being absent leaves it be.
        if (detail.length > 0) task.detail = detail;
        else delete task.detail;
      }
      return { tasks, carried };
    }
    case 'set_status': {
      // Resolved (not a bare id lookup) because models routinely forget the id
      // and pass the title they can see in the card; the tool description has
      // always promised that. Ambiguous titles still throw rather than guess.
      if (args.id === undefined) throw new Error('set_status needs `id`');
      const task = resolveTask(tasks, args.id);
      if (!STATUSES.includes(args.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      task.status = args.status;
      // An explicit set_status is authoritative: clear any pending proposal.
      if (task.proposedDone !== undefined) delete task.proposedDone;
      return { tasks, carried };
    }
    case 'propose_done': {
      // Mark one or more tasks as DONE-but-awaiting-user-confirmation. The user
      // confirms (or dismisses) them in the floating task card in bulk.
      let ids = [];
      if (Array.isArray(args.ids) && args.ids.length > 0) ids = args.ids;
      else if (typeof args.id === 'string' && args.id.length > 0) ids = [args.id];
      else throw new Error('propose_done needs `ids` (array) or `id`');
      const found = [];
      for (const ref of ids) {
        const task = resolveTask(tasks, ref);
        task.status = 'done';
        task.proposedDone = true;
        found.push(task);
      }
      return { tasks, carried };
    }
    case 'remove': {
      if (args.id === undefined) throw new Error('remove needs `id`');
      const target = resolveTask(tasks, args.id);
      tasks.splice(tasks.indexOf(target), 1);
      return { tasks, carried };
    }
    case 'archive': {
      // File one or more DONE tasks into the archive. This is what the card's
      // "archive done" button does instead of deleting them, so a finished list
      // can be cleared without losing the record. `ids` (batch) and `id` (single)
      // are both accepted; without either, every done, non-pending task in the
      // active list is archived (the bulk button's payload).
      const targets = [];
      if (Array.isArray(args.ids) && args.ids.length > 0) {
        for (const ref of args.ids) targets.push(resolveTask(tasks, ref));
      } else if (typeof args.id === 'string' && args.id.length > 0) {
        targets.push(resolveTask(tasks, args.id));
      } else {
        for (const task of tasks) {
          if (task.status === 'done' && task.proposedDone !== true && !isArchived(task)) targets.push(task);
        }
      }
      if (targets.length === 0) return { tasks, carried };
      const stamp = normalizeArchivedAt(args.at) || new Date().toISOString();
      for (const task of targets) {
        // An unfinished task has nothing to file away; skip rather than lying
        // about it, so a mixed batch archives exactly its done members.
        if (task.status !== 'done') continue;
        delete task.proposedDone;
        task.archivedAt = stamp;
      }
      return { tasks, carried };
    }
    case 'unarchive': {
      // Restore archived tasks to the active list (still done).
      const targets = [];
      if (Array.isArray(args.ids) && args.ids.length > 0) {
        for (const ref of args.ids) targets.push(resolveTask(tasks, ref));
      } else if (typeof args.id === 'string' && args.id.length > 0) {
        targets.push(resolveTask(tasks, args.id));
      } else {
        const all = args.all === true;
        for (const task of tasks) {
          if (all || task.id === args.id) targets.push(task);
        }
      }
      if (targets.length === 0) throw new Error('unarchive needs `id`, `ids`, or `all: true`');
      for (const task of targets) if (task.archivedAt !== undefined) delete task.archivedAt;
      return { tasks, carried };
    }
    case 'replace': {
      if (!Array.isArray(args.tasks)) throw new Error('`tasks` must be an array');
      // `replace` rewrites the PLAN, not the history. It used to return exactly
      // the incoming array, so a model that opened a new round with a fresh plan
      // silently DELETED everything the previous plan still held — including the
      // tasks it had just proposed as done and the user had not confirmed yet,
      // and including tasks the user added by hand. Nothing was archived, so the
      // work was simply gone. Now:
      //  - an incoming entry matches an existing task by explicit `id`, else by
      //    folded title, and INHERITS the fields it does not restate (status,
      //    detail, origin, pending completion, archive stamp), so re-listing a
      //    plan no longer resets progress back to `todo`;
      //  - every existing task the new list does NOT mention is carried over:
      //    finished-and-confirmed work is auto-ARCHIVED (filed, not deleted),
      //    while open work and an unanswered completion proposal stay in the
      //    active list. `clear` is the only action that actually empties it.
      const available = tasks.slice();
      const seen = new Set();
      const out = [];
      for (const raw of args.tasks) {
        const task = normalizeTask(raw);
        let at = -1;
        if (typeof raw.id === 'string' && raw.id.length > 0) {
          at = available.findIndex((candidate) => candidate.id === raw.id);
        }
        if (at < 0) {
          const folded = foldTitle(task.title);
          at = available.findIndex((candidate) => foldTitle(candidate.title) === folded);
        }
        if (at >= 0) {
          const prev = available[at];
          task.id = prev.id;
          // An omitted field means "leave it as it is", not "reset it": a plan
          // rewrite that only restates titles must not undo progress.
          if (raw.status === undefined) task.status = prev.status;
          if (raw.detail === undefined && prev.detail !== undefined) task.detail = prev.detail;
          if (raw.origin === undefined) task.origin = prev.origin;
          if (prev.proposedDone === true && task.status === 'done') task.proposedDone = true;
          // A rewrite must not silently UN-archive (or re-archive) a task: the
          // archive is the user's filing decision, not part of the plan text.
          if (prev.archivedAt !== undefined && task.status === 'done') {
            task.archivedAt = prev.archivedAt;
          }
          available.splice(at, 1);
        }
        if (seen.has(task.id)) task.id = mintId();
        seen.add(task.id);
        out.push(task);
      }
      const stamp = new Date().toISOString();
      for (const prev of available) {
        // Finished and already confirmed: the plan moved on, so file it away.
        // The record survives in the archive view instead of vanishing.
        if (prev.status === 'done' && prev.proposedDone !== true && !isArchived(prev)) {
          out.push({ ...prev, archivedAt: stamp });
          carried.push({ title: prev.title, filed: true });
          continue;
        }
        // Open work, and a completion proposal the user has NOT answered yet,
        // are still live: keep them with their id, status and detail intact.
        out.push({ ...prev });
        carried.push({ title: prev.title, filed: false });
      }
      return { tasks: out, carried };
    }
    case 'clear': {
      // Emptying the WORKING list must not wipe the archive, and finished work
      // is filed rather than destroyed: done tasks get an archive stamp, tasks
      // already archived stay archived, and only genuinely open tasks are
      // dropped — that is what an explicit `clear` asks for.
      const stamp = new Date().toISOString();
      const out = [];
      for (const task of tasks) {
        if (isArchived(task)) {
          out.push({ ...task });
          continue;
        }
        if (task.status === 'done') {
          const filed = { ...task, archivedAt: stamp };
          delete filed.proposedDone;
          out.push(filed);
          carried.push({ title: task.title, filed: true });
        }
      }
      return { tasks: out, carried };
    }
    case 'list':
    case undefined:
    case null:
      return { tasks, carried };
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}; use add, edit, set_status, propose_done, archive, unarchive, remove, replace, clear or list`);
  }
}

/**
 * Register the `tasks` projection and the `task_write` tool.
 * @param ctx - registrant context carrying tools + session projection registries.
 */
async function apply(ctx) {
  const stateSchema = identitySchema();
  const viewSchema = identitySchema();

  const handle = await ctx.sessionProjections.register({
    key: 'taskManager',
    // v2 attributes each marker to its producer (see `apply`); v1 folded the
    // marker wherever it appeared, so a session log echoed into the transcript
    // (a `cat`, a grep hit, a pasted diff) could inject foreign tasks. Bumping
    // the version invalidates those poisoned checkpoints.
    stateVersion: 2,
    stateSchema,
    init: () => ({ tasks: [], calls: {}, commands: {} }),
    apply: (state, event) => {
      // Two writers feed the one list:
      //  - `tool/result`: the model's `task_write` output marker (model writes).
      //  - `command/done`: the `tasks-sync` command the Client UI runs for user
      //    edits (add / status / confirm / remove). Its result text carries the
      //    same marker, so user edits become durable, replayable session events
      //    exactly like model writes — no plugin-private store.
      //
      // Neither event names its producer (`tool/result` carries only a callId,
      // `command/done` only a commandId), so each marker is trusted only when
      // the matching start event — `tool/call` / `command/run` — named this
      // plugin's tool or command. Anything else, including a marker quoted
      // inside some unrelated tool's output, is ignored.
      //
      // Only our own calls are remembered (an absent callId is already
      // untrusted), so the maps hold at most the handful of our calls that are
      // still in flight rather than one entry per tool call in the session.
      if (event.type === 'tool/call') {
        const { callId, name } = event.data || {};
        if (typeof callId !== 'string' || name !== TOOL_NAME) return state;
        return { ...state, calls: { ...state.calls, [callId]: true } };
      }
      if (event.type === 'command/run') {
        const { commandId, name } = event.data || {};
        if (typeof commandId !== 'string' || name !== COMMAND_NAME) return state;
        return { ...state, commands: { ...state.commands, [commandId]: true } };
      }
      if (event.type === 'tool/result') {
        const message = event.data && event.data.message;
        const callId = message && message.source && message.source.callId;
        if (typeof callId !== 'string' || state.calls[callId] !== true) return state;
        const calls = { ...state.calls };
        delete calls[callId];
        const tasks = decodeStateFromContent(message.content);
        return tasks === undefined ? { ...state, calls } : { tasks, calls, commands: state.commands };
      }
      if (event.type === 'command/done') {
        const commandId = event.data && event.data.commandId;
        if (typeof commandId !== 'string' || state.commands[commandId] !== true) return state;
        const commands = { ...state.commands };
        delete commands[commandId];
        const text = event.data && event.data.text;
        const tasks = typeof text === 'string' ? decodeStateFromText(text) : undefined;
        return tasks === undefined ? { ...state, commands } : { tasks, calls: state.calls, commands };
      }
      // Deliberately no per-turn cleanup: a `tasks-sync` the user triggers as a
      // turn ends can log its `command/done` just after `turn/end`, and
      // dropping the entry would silently discard that edit. The maps only ever
      // hold our own in-flight calls, so an aborted call leaves at most one
      // stale entry — and because call ids are unique, a stale entry can never
      // authorize a later, unrelated result.
      return state;
    },
    wire: {
      viewSchema,
      view: (state) => ({ tasks: state.tasks }),
      summary: true,
    },
  });

  /** Read the current task list for the calling session. */
  function currentTasks(agent) {
    if (agent === undefined) return [];
    const state = handle.stateOf(agent.session);
    return state && Array.isArray(state.tasks) ? state.tasks : [];
  }

  ctx.tools.register({
    name: 'task_write',
    description:
      'Maintain this session\'s task list, shown in a floating task card in the bottom-right corner of the window (collapsed to a pill by default; click to expand — it stays on top of the conversation). IMPORTANT: whenever you lay out an ordered implementation plan or a multi-step set of next actions for the user (e.g. "1. do X, 2. do Y, 3. do Z"), ALSO record those steps as tasks here — use action "replace" with the full ordered list, or one "add" per step — so the user sees and can start them from the card instead of having to copy text manually. Also use it to add follow-up tasks and to report progress. To report that a task (or several) is COMPLETE, prefer action "propose_done" (pass `ids`): this marks the tasks done but AWAITING the user\'s confirmation, which the card surfaces as a bulk confirm prompt — do NOT use set_status done for completion unless the user explicitly told you they are done. `ids` entries may be task ids OR titles that uniquely identify a task, so you do not need to re-`list` just to recover an id. Use action "set_status" only to move a task to todo/doing or to apply a status the user explicitly requested. Task fields: id, title, status (todo|doing|done), origin (model|user), detail (optional second line shown under the title). The tool returns the complete updated list; ids are stable and are how you later update or remove a task. Never open a new round by calling "replace" with a fresh list to get rid of old tasks: `replace` rewrites the plan but keeps the tasks you omit (archiving the finished ones), so stale tasks must be archived or removed deliberately — and a completion the user has not confirmed yet is never dropped by a rewrite.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'edit', 'set_status', 'propose_done', 'archive', 'unarchive', 'remove', 'replace', 'clear', 'list'],
          description: 'add: append one task; edit: rewrite one task\'s title and/or detail in place (id/status/origin/archive kept); set_status: change one task status by id; propose_done: mark one or more tasks DONE pending the user\'s confirmation (use this to report completion; accepts ids or unique titles); archive: file DONE tasks into the archive (hidden from the active list, still queryable via list) — this is how the card clears finished work instead of deleting it; unarchive: put archived tasks back; remove: delete by id (the ONLY action that destroys a record — avoid it for work the user may still want); replace: rewrite the plan with the full ordered list, keeping the id of any task whose title matches and INHERITING the fields you do not restate (status, detail, origin, pending confirmation, archive stamp) — tasks the new list omits are not deleted: finished ones are archived automatically and open ones (including a completion the user has not confirmed yet) stay in the list; clear: empty the active list, filing finished tasks into the archive instead of destroying them; list: read without changing.',
        },
        title: { type: 'string', description: 'For action "add": the task title. For "edit": the new title (omit to keep it).' },
        detail: { type: 'string', description: 'For actions "add" and "edit": optional detail (the smaller second line under the title). For "edit", passing an empty string clears it; omitting the key keeps it.' },
        status: { type: 'string', enum: STATUSES, description: 'For "add" (default todo) or "set_status": the target status.' },
        id: { type: 'string', description: 'For "edit" / "set_status" / "remove" / single-target "propose_done": the task id (all of them also accept a title that uniquely identifies one task).' },
        ids: {
          type: 'array',
          description: 'For action "propose_done" (tasks to mark done pending confirmation) or "archive" / "unarchive" (tasks to file / restore) (batch). Each entry is a task id, or a title — a title must identify exactly one task (exact match, or a unique prefix, ignoring case/whitespace/punctuation); ambiguous titles are rejected. Use "list" first if unsure.',
          items: { type: 'string' },
        },
        all: { type: 'boolean', description: 'For action "unarchive": restore every archived task.' },
        at: { type: 'string', description: 'For action "archive": ISO timestamp to record (defaults to now).' },
        position: { type: 'integer', description: 'For "add": 1-based insertion index; omit to append.' },
        origin: { type: 'string', enum: ['model', 'user'], description: 'For "add": who created the task (default model).' },
        tasks: {
          type: 'array',
          description: 'For action "replace": the complete ordered task list. Entries are matched to existing tasks by `id` or by title, so restating a task keeps its id and progress; anything you omit from the fields is carried over. Tasks from the previous list that you do not mention are kept (finished ones archived, open ones left in place) rather than deleted.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['title'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string', enum: STATUSES },
              detail: { type: 'string' },
              origin: { type: 'string', enum: ['model', 'user'] },
              archivedAt: { type: 'string' },
            },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['tasks', 'counts', 'archived'],
        properties: {
          tasks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'title', 'status', 'origin'],
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                status: { type: 'string', enum: STATUSES },
                origin: { type: 'string', enum: ['model', 'user'] },
                detail: { type: 'string' },
                proposedDone: { type: 'boolean' },
                archivedAt: { type: 'string' },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: ['todo', 'doing', 'done'],
            properties: {
              todo: { type: 'integer' },
              doing: { type: 'integer' },
              done: { type: 'integer' },
            },
          },
          archived: { type: 'integer' },
          carried: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['title', 'filed'],
              properties: {
                title: { type: 'string' },
                filed: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => renderState(value.tasks, value.carried),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('task_write requires an owning agent session');
      const { tasks: next, carried } = applyAction(args.action, args, currentTasks(exec.agent));
      // Archived tasks are filed away, so they must not inflate the working
      // counts the card and the model both read.
      const counts = { todo: 0, doing: 0, done: 0 };
      for (const task of next) if (!isArchived(task)) counts[task.status] = (counts[task.status] || 0) + 1;
      // `archived` rides along so the model can tell "3 done" apart from "3 done,
      // 10 filed away" without having to parse the rendered text.
      const archivedCount = next.filter(isArchived).length;
      return Promise.resolve({ tasks: next, counts, archived: archivedCount, carried });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Update task list',
      kind: 'other',
      rawInput: args,
    }),
  });

  // ---- Client-callable write path (user edits) ----------------------------
  //
  // The Client card lets the user add tasks, change a status, confirm/dismiss a
  // model completion probe, or remove a task. Those edits must land in the SAME
  // session-log list the model reads, or the model keeps working from a stale
  // list and the user's tasks vanish on fork/reload. A plugin cannot append a
  // custom session event, but `commands` is the sanctioned Client→Host entry
  // point, and the command lifecycle logs `command/run` + `command/done` as
  // ordinary events. So we register an internal `tasks-sync` command whose
  // handler applies the edit to the current list and returns the marker text;
  // the projection folds that `command/done` text. The command is hidden from
  // the model (it is the UI's transport, not a slash command a human types).
  const commands = ctx.get('commands');
  if (commands && typeof commands.register === 'function') {
    // Registered inside `ctx.effect` so the disposer actually runs when this
    // plugin unloads/reloads: `commands.register` rejects a duplicate name
    // ("command \"tasks-sync\" is already registered"), and a leaked registration
    // from a previous activation would then fail the whole Host half on reload.
    ctx.effect(() => {
      const dispose = commands.register({
        name: 'tasks-sync',
        description: 'Apply a task-list edit from the task card UI.',
        // The payload JSON is the transport for a UI edit; it must not leak into
        // the `command/run` event as `args` (the model would read it as raw JSON
        // noise). Only the returned marker text — the authoritative new list — is
        // logged via `command/done` and folded by the projection.
        recordInput: false,
        handler: async (invocation) => {
          let payload;
          try {
            payload = JSON.parse(invocation.rawInput || '{}');
          } catch {
            return { kind: 'error', text: 'tasks-sync: invalid payload' };
          }
          try {
            const current = currentTasks(invocation.agent);
            const next = applyAction(payload.action, payload, current).tasks;
            return { kind: 'success', text: encodeState(next) };
          } catch (error) {
            return { kind: 'error', text: `tasks-sync: ${error instanceof Error ? error.message : String(error)}` };
          }
        },
      });
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    }, 'task-manager: tasks-sync command');
  }
}

export { apply, inject, name };
