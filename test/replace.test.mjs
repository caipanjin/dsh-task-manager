/**
 * Regression tests for `task_write`'s list-rewriting actions.
 *
 * These drive the real `index.js` through a fake registrant context: the tool is
 * executed for real and its rendered result is folded back through the real
 * `taskManager` projection, so what is asserted here is exactly what the card and
 * the next model turn would see.
 *
 * The bug they lock down: `replace` used to return the incoming array verbatim,
 * so a model that opened a new round with a fresh plan silently DELETED every
 * task from the previous round — including work it had just proposed as done and
 * the user had not confirmed yet, and including tasks the user added by hand.
 * Nothing was archived, so the record was simply gone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../index.js';

/** Boot the plugin against a fake context and return a `call` helper. */
async function boot() {
  let tool = null;
  let projection = null;
  let state = null;

  const ctx = {
    tools: { register: (def) => { tool = def; } },
    sessionProjections: {
      register: async (def) => {
        projection = def;
        state = def.init();
        return { stateOf: () => state };
      },
    },
    get: () => undefined,
    effect: () => {},
  };

  await apply(ctx);

  let seq = 0;
  let lastText = '';
  /** Run one `task_write` call end-to-end and return the resulting task list. */
  async function call(args) {
    const callId = `c${++seq}`;
    state = projection.apply(state, { type: 'tool/call', data: { callId, name: 'task_write' } });
    const value = await tool.execute(args, { agent: { session: 's1' } });
    const content = tool.output.render(args, value);
    lastText = content.map((part) => part.text || '').join('\n');
    state = projection.apply(state, {
      type: 'tool/result',
      data: { message: { source: { callId }, content } },
    });
    return state.tasks;
  }

  return { call, tool, text: () => lastText };
}

const titles = (tasks) => tasks.map((task) => task.title);
const active = (tasks) => tasks.filter((task) => task.archivedAt === undefined);
const archived = (tasks) => tasks.filter((task) => task.archivedAt !== undefined);

test('replace keeps tasks the new plan does not mention', async () => {
  const { call } = await boot();
  await call({ action: 'replace', tasks: [{ title: '步骤一' }, { title: '步骤二' }] });
  const tasks = await call({ action: 'replace', tasks: [{ title: '新任务 A' }] });

  assert.deepEqual(titles(tasks).sort(), ['新任务 A', '步骤一', '步骤二'].sort());
});

test('replace does not drop a completion the user has not confirmed', async () => {
  const { call } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '写测试' }, { title: '跑测试' }] });
  const id = tasks[0].id;
  tasks = await call({ action: 'propose_done', ids: [id] });
  assert.equal(tasks[0].proposedDone, true);

  tasks = await call({ action: 'replace', tasks: [{ title: '发布' }] });
  const kept = tasks.find((task) => task.title === '写测试');

  assert.ok(kept, 'the unconfirmed task must still exist');
  assert.equal(kept.status, 'done');
  assert.equal(kept.proposedDone, true, 'it must still be awaiting the user');
  assert.equal(kept.archivedAt, undefined, 'an unanswered proposal must not be filed away');
});

test('replace archives finished-and-confirmed tasks instead of deleting them', async () => {
  const { call } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '写测试' }, { title: '跑测试' }] });
  const id = tasks[0].id;
  // A confirmation is a `set_status done`, which clears `proposedDone`.
  await call({ action: 'propose_done', ids: [id] });
  tasks = await call({ action: 'set_status', id, status: 'done' });
  assert.equal(tasks.find((task) => task.id === id).proposedDone, undefined);

  tasks = await call({ action: 'replace', tasks: [{ title: '跑测试' }] });
  const filed = tasks.find((task) => task.id === id);

  assert.ok(filed, 'the finished task must not vanish');
  assert.ok(filed.archivedAt, 'it must be filed into the archive');
  assert.deepEqual(active(tasks).map((task) => task.title), ['跑测试']);
  assert.equal(archived(tasks).length, 1);
});

test('replace keeps the id and progress of a task it re-lists', async () => {
  const { call } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '写测试' }, { title: '跑测试' }] });
  const id = tasks[0].id;
  await call({ action: 'set_status', id, status: 'doing' });
  await call({ action: 'edit', id, detail: '覆盖 replace 分支' });

  tasks = await call({ action: 'replace', tasks: [{ title: '写测试' }, { title: '跑测试' }, { title: '发布' }] });
  const kept = tasks.find((task) => task.title === '写测试');

  assert.equal(kept.id, id, 'the id must be reused so client state survives');
  assert.equal(kept.status, 'doing', 're-listing must not reset progress to todo');
  assert.equal(kept.detail, '覆盖 replace 分支', 'an unstated detail must be inherited');
});

test('replace matches by explicit id even when the title changed', async () => {
  const { call } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '旧标题' }] });
  const id = tasks[0].id;

  tasks = await call({ action: 'replace', tasks: [{ id, title: '新标题' }] });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, id);
  assert.equal(tasks[0].title, '新标题');
});

test('clear files finished tasks and keeps the archive, dropping only open work', async () => {
  const { call } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '甲' }, { title: '乙' }, { title: '丙' }] });
  const [a, b, c] = tasks.map((task) => task.id);
  // 甲 finished but not yet filed; 乙 finished and already filed by the user;
  // 丙 still open, which is the only thing `clear` may drop.
  await call({ action: 'set_status', id: a, status: 'done' });
  await call({ action: 'set_status', id: b, status: 'done' });
  await call({ action: 'archive', ids: [b] });

  tasks = await call({ action: 'clear' });

  assert.deepEqual(active(tasks), [], 'the working list is empty');
  assert.deepEqual(titles(archived(tasks)).sort(), ['甲', '乙'].sort(), 'done work is filed, not destroyed');
  assert.equal(tasks.find((task) => task.id === c), undefined, 'open work is dropped by an explicit clear');
});

test('an archived task is not resurrected by a plan that re-lists its title', async () => {
  const { call } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '已完成' }] });
  const id = tasks[0].id;
  await call({ action: 'set_status', id, status: 'done' });
  await call({ action: 'archive', ids: [id] });

  tasks = await call({ action: 'replace', tasks: [{ title: '已完成' }, { title: '新计划' }] });
  const kept = tasks.find((task) => task.title === '已完成');

  assert.ok(kept.archivedAt, 'the archive is the user\'s filing decision, not plan text');
});

test('ids stay unique when a plan repeats a title', async () => {
  const { call } = await boot();
  const tasks = await call({
    action: 'replace',
    tasks: [{ title: '同名' }, { title: '同名' }, { title: '同名' }],
  });
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
});

test('replace tells the model which tasks it kept', async () => {
  const { call, text } = await boot();
  let tasks = await call({ action: 'replace', tasks: [{ title: '已完成的' }, { title: '还没做的' }] });
  const [doneId, openId] = tasks.map((task) => task.id);
  await call({ action: 'set_status', id: doneId, status: 'done' });

  await call({ action: 'replace', tasks: [{ title: '新计划' }] });
  const rendered = text();

  // Without this feedback the model reads its own result, sees tasks it did not
  // just write, and "repairs" it by re-sending `replace` — the loop that used to
  // delete the user's tasks in the first place.
  assert.match(rendered, /Kept from the previous list.*还没做的/);
  assert.match(rendered, /Moved to the archive.*已完成的/);
  assert.ok(openId, 'sanity: the open task survived');
});

test('a plain replace that keeps nothing says nothing extra', async () => {
  const { call, text } = await boot();
  await call({ action: 'replace', tasks: [{ title: '甲' }] });
  await call({ action: 'replace', tasks: [{ title: '甲' }, { title: '乙' }] });

  assert.doesNotMatch(text(), /Kept from the previous list|Moved to the archive/);
});

test('set_status and remove accept a title, as the tool description promises', async () => {
  const { call } = await boot();
  await call({ action: 'replace', tasks: [{ title: '写测试' }, { title: '跑测试' }] });

  // Models forget ids constantly and pass the title they see in the card.
  let tasks = await call({ action: 'set_status', id: '写测试', status: 'doing' });
  assert.equal(tasks.find((task) => task.title === '写测试').status, 'doing');

  tasks = await call({ action: 'remove', id: '跑测试' });
  assert.deepEqual(titles(tasks), ['写测试']);
});

test('an ambiguous title is refused instead of guessed', async () => {
  const { call } = await boot();
  await call({ action: 'replace', tasks: [{ title: '同名任务' }, { title: '同名任务' }] });

  await assert.rejects(
    () => call({ action: 'set_status', id: '同名任务', status: 'doing' }),
    /ambiguous|matches/,
  );
});
