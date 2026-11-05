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

import { defineTool } from '@deepseek-ai/dsh-tools';

const name = 'task-manager';
const inject = ['tools', 'sessionProjections'];

/** Allowed task statuses. */
const STATUSES = ['todo', 'doing', 'done'];
/** Cursor used to embed the machine-readable task state in the tool's result text. */
const MARKER = 'TASK_STATE::';

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
  return task;
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

/** Human-readable + marker rendering of a tool result for the given task list. */
function renderState(tasks) {
  const counts = { todo: 0, doing: 0, done: 0 };
  for (const task of tasks) counts[task.status] = (counts[task.status] || 0) + 1;
  const lines = [
    `Task list updated: ${counts.todo} to do, ${counts.doing} in progress, ${counts.done} done.`,
  ];
  if (tasks.length > 0) {
    lines.push('Current tasks:');
    for (const task of tasks) {
      const mark = task.status === 'done' && task.proposedDone ? 'done, awaiting confirmation' : task.status;
      lines.push(`- [${mark}] ${task.title}${task.id ? ` (${task.id})` : ''}`);
    }
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
      return tasks;
    }
    case 'set_status': {
      const task = tasks.find((candidate) => candidate.id === args.id);
      if (task === undefined) throw new Error(`no task with id ${JSON.stringify(args.id)}`);
      if (!STATUSES.includes(args.status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
      task.status = args.status;
      // An explicit set_status is authoritative: clear any pending proposal.
      if (task.proposedDone !== undefined) delete task.proposedDone;
      return tasks;
    }
    case 'propose_done': {
      // Mark one or more tasks as DONE-but-awaiting-user-confirmation. The user
      // confirms (or dismisses) them in the floating task card in bulk.
      let ids = [];
      if (Array.isArray(args.ids) && args.ids.length > 0) ids = args.ids;
      else if (typeof args.id === 'string' && args.id.length > 0) ids = [args.id];
      else throw new Error('propose_done needs `ids` (array) or `id`');
      const found = [];
      for (const id of ids) {
        const task = tasks.find((candidate) => candidate.id === id);
        if (task === undefined) throw new Error(`no task with id ${JSON.stringify(id)}`);
        task.status = 'done';
        task.proposedDone = true;
        found.push(task);
      }
      return tasks;
    }
    case 'remove': {
      const idx = tasks.findIndex((candidate) => candidate.id === args.id);
      if (idx < 0) throw new Error(`no task with id ${JSON.stringify(args.id)}`);
      tasks.splice(idx, 1);
      return tasks;
    }
    case 'replace': {
      if (action === 'replace' && !Array.isArray(args.tasks)) throw new Error('`tasks` must be an array');
      const seen = new Set();
      const out = [];
      for (const raw of args.tasks) {
        const task = normalizeTask(raw);
        if (seen.has(task.id)) task.id = mintId();
        seen.add(task.id);
        out.push(task);
      }
      return out;
    }
    case 'clear':
      return [];
    case 'list':
    case undefined:
    case null:
      return tasks;
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}; use add, set_status, remove, replace, clear or list`);
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
    stateVersion: 1,
    stateSchema,
    init: () => ({ tasks: [] }),
    apply: (state, event) => {
      if (event.type !== 'tool/result') return state;
      const content = event.data && event.data.message && event.data.message.content;
      const tasks = decodeStateFromContent(content);
      if (tasks === undefined) return state;
      return { tasks };
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

  ctx.tools.register(defineTool({
    name: 'task_write',
    description:
      'Maintain this session\'s task list, shown in a floating task card in the bottom-right corner of the window (collapsed to a pill by default; click to expand — it stays on top of the conversation). Use it to propose an ordered implementation plan (action "replace" or repeated "add"), to add follow-up tasks, and to report progress. To report that a task (or several) is COMPLETE, prefer action "propose_done" (pass `ids`): this marks the tasks done but AWAITING the user\'s confirmation, which the card surfaces as a bulk confirm prompt — do NOT use set_status done for completion unless the user explicitly told you they are done. Use action "set_status" only to move a task to todo/doing or to apply a status the user explicitly requested. Task fields: id, title, status (todo|doing|done), origin (model|user). The tool returns the complete updated list; ids are stable and are how you later update or remove a task.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['add', 'set_status', 'propose_done', 'remove', 'replace', 'clear', 'list'],
        description: 'add: append one task; set_status: change one task status by id; propose_done: mark one or more tasks DONE pending the user\'s confirmation (use this to report completion); remove: delete by id; replace: set the whole list (use for an ordered plan); clear: empty the list; list: read without changing.',
      },
      title: { type: 'string', description: 'For action "add": the task title.' },
      detail: { type: 'string', description: 'For action "add": optional one-line detail.' },
      status: { type: 'string', enum: STATUSES, description: 'For "add" (default todo) or "set_status": the target status.' },
      id: { type: 'string', description: 'For "set_status" / "remove" / single-target "propose_done": the task id.' },
      ids: {
        type: 'array',
        description: 'For action "propose_done": the task ids to mark done pending confirmation (batch).',
        items: { type: 'string' },
      },
      position: { type: 'integer', description: 'For "add": 1-based insertion index; omit to append.' },
      origin: { type: 'string', enum: ['model', 'user'], description: 'For "add": who created the task (default model).' },
      tasks: {
        type: 'array',
        description: 'For action "replace": the complete ordered task list.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            title: { type: 'string', required: true },
            status: { type: 'string', enum: STATUSES },
            detail: { type: 'string' },
            origin: { type: 'string', enum: ['model', 'user'] },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: STATUSES },
                origin: { type: 'string', required: true, enum: ['model', 'user'] },
                detail: { type: 'string' },
                proposedDone: { type: 'boolean' },
              },
            },
          },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              todo: { type: 'integer', required: true },
              doing: { type: 'integer', required: true },
              done: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => renderState(value.tasks),
    },
    execute(args, exec) {
      if (!exec.agent) throw new Error('task_write requires an owning agent session');
      const next = applyAction(args.action, args, currentTasks(exec.agent));
      const counts = { todo: 0, doing: 0, done: 0 };
      for (const task of next) counts[task.status] = (counts[task.status] || 0) + 1;
      return Promise.resolve({ tasks: next, counts });
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Update task list',
      kind: 'other',
      rawInput: args,
    }),
  }));
}

export { apply, inject, name };
