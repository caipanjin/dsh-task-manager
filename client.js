/**
 * Client half of the local Task Manager bundle.
 *
 * Placement
 * ---------
 * The task list is a FLOATING overlay card registered in the frame-wide floating
 * layer (`shell.overlay`), pinned to the bottom-right of the window and rendered
 * ABOVE the conversation. It is collapsed to a small pill (with a task-count
 * badge) by default and expands on click — so the user can peek at / manage
 * tasks at any time WITHOUT leaving the current conversation. The overlay layer
 * is click-through; this card opts back in with `pointerEvents: 'auto'`.
 *
 * Data sources
 * ------------
 * - Model tasks: read live from this plugin's session projection `taskManager`
 *   through the sessions client service:
 *   `ctx.sessions.binding(id).session.projections.faceOf('taskManager')`, a
 *   `{ getSnapshot, subscribe }` store bound with `useSyncExternalStore`. The
 *   host half writes it via the `task_write` tool, so when the model reports a
 *   task done the row updates by itself.
 * - User tasks: kept client-side per session in `localStorage` (installed
 *   bundles have no client→host RPC), tagged `origin: 'user'`. Adding a task
 *   appends it to the list — it is NOT copied into the chat composer.
 *
 * Starting a task
 * ---------------
 * "Start" sends `Start this task: <title>` into the owning session via
 * `ctx.sessions.scope(id).get('conversation').send(text)` — the same submit path
 * the composer uses. The floating card then collapses so the conversation is
 * unobstructed while the model begins.
 */

window.__ModuleLoader__.load({
  id: '@caipj/dsh-task-manager',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = '@caipj/dsh-task-manager';
    const OVERLAY_ID = 'task-manager';

    // Fallback strings; overridden by the locale service when available.
    const FALLBACK = {
      title: 'Tasks',
      empty: 'No tasks yet. Ask the model for a plan, or add one below.',
      addPlaceholder: 'Add a task…',
      add: 'Add',
      start: 'Start',
      remove: 'Remove',
      markDone: 'Mark done',
      markTodo: 'Mark to do',
      markDoing: 'Mark in progress',
      sendPrompt: 'Start this task: {title}',
      countPending: '{n} to do',
      countDoing: '{n} in progress',
      countDone: '{n} done',
      fromModel: 'Model',
      fromUser: 'Mine',
      originModel: 'Proposed by the model',
      originUser: 'Added by you',
      noSession: 'Open a conversation to use the task panel.',
      clearDone: 'Clear done',
      openPanel: 'Show tasks',
      closePanel: 'Hide tasks',
      collapse: 'Collapse',
      dragHint: 'Drag to move',
      complete: 'Complete',
      proposed: 'Awaiting confirm',
      confirmBanner: 'The model reports {n} task(s) done — confirm?',
      confirmAll: 'Confirm all',
      confirm: 'Confirm',
      dismiss: 'Dismiss',
      confirmDismissed: 'Dismissed',
      addAsTask: 'Add as task',
      addAsTasksN: 'Add {n} tasks',
      addedAsTask: 'Added to tasks',
    };

    // Flat dictionaries registered with the locale service (locale/*.json only
    // supplies the plugin's meta.title/description, NOT panel strings).
    const DICT_EN = FALLBACK;
    const DICT_ZH = {
      title: '任务',
      empty: '还没有任务。可以让模型给出实施顺序，或在下方添加。',
      addPlaceholder: '添加任务…',
      add: '添加',
      start: '开始',
      remove: '删除',
      markDone: '标记完成',
      markTodo: '标记待办',
      markDoing: '标记进行中',
      sendPrompt: '开始执行这个任务：{title}',
      countPending: '{n} 项待办',
      countDoing: '{n} 项进行中',
      countDone: '{n} 项已完成',
      fromModel: '模型建议',
      fromUser: '手动添加',
      originModel: '由模型建议',
      originUser: '由你添加',
      noSession: '打开一个对话即可使用任务面板。',
      clearDone: '清除已完成',
      openPanel: '显示任务',
      closePanel: '隐藏任务',
      collapse: '收起',
      dragHint: '拖动移动位置',
      complete: '完成',
      proposed: '待确认完成',
      confirmBanner: '模型判断有 {n} 项任务已完成，确认吗？',
      confirmAll: '全部确认',
      confirm: '确认',
      dismiss: '忽略',
      confirmDismissed: '已忽略',
      addAsTask: '添加为任务',
      addAsTasksN: '添加 {n} 个任务',
      addedAsTask: '已加入任务',
    };

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
    }

    const STATUS_COLOR = {
      todo: 'var(--dsw-alias-state-idle-primary, #8a8f98)',
      doing: 'var(--dsw-alias-brand-primary, #2f6feb)',
      done: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
    };

    // ---- per-session user-task store (localStorage) -------------------------

    function storageKey(sessionId) {
      return `${NS}:user-tasks:${sessionId}`;
    }

    function loadUserTasks(sessionId) {
      if (!sessionId) return [];
      try {
        const raw = localStorage.getItem(storageKey(sessionId));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }

    function saveUserTasks(sessionId, tasks) {
      if (!sessionId) return;
      try {
        localStorage.setItem(storageKey(sessionId), JSON.stringify(tasks));
      } catch {
        /* quota / privacy mode — ignore, in-memory still works this session */
      }
    }

    let userSeq = 0;
    function mintUserId() {
      userSeq += 1;
      return `u${Date.now().toString(36)}${userSeq.toString(36)}`;
    }

    // ---- cross-component "add to tasks" bus ---------------------------------
    //
    // The selection bubble lives in a SEPARATE overlay entry from the task card,
    // so it cannot reach the card's local React state directly. Instead it pushes
    // a text payload here; the card subscribes, appends it as a user task, and
    // expands itself. One shared module-level emitter (the factory runs once).
    // Split a selected block of text into one title per list item when it looks
    // like a bulleted / numbered list ("- a", "* b", "1. c", "2) d", "• e").
    // Otherwise return a single title (the whole trimmed selection).
    //
    // Rules:
    //  - If at least 2 lines carry a list marker, treat it as a list and emit
    //    ONE task per item, stripping the marker. Wrapped continuation lines
    //    (no marker) are appended to the previous item so multi-line bullets
    //    stay one task.
    //  - Leading/trailing blank lines are ignored.
    const LIST_ITEM_RE = /^\s*(?:[-*•·▪◦]|\d+[.)、]|[①-⑳]|\(\d+\))\s*(.+?\S)\s*$/;
    function parseSelectionToTasks(raw) {
      const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
      if (!text) return [];
      const lines = text.split('\n');
      const markerCount = lines.filter((l) => LIST_ITEM_RE.test(l)).length;
      // Not a real list (fewer than 2 marked lines) → keep the whole selection
      // as a single task verbatim.
      if (markerCount < 2) return [text];
      const items = [];
      let started = false;
      for (const line of lines) {
        const m = line.match(LIST_ITEM_RE);
        if (m) {
          started = true;
          items.push(m[1].trim());
        } else if (started && items.length && line.trim()) {
          // Continuation (wrapped) line of the current bullet.
          items[items.length - 1] = `${items[items.length - 1]} ${line.trim()}`.trim();
        }
        // Any unmarked line BEFORE the first bullet (e.g. "说明如下：") is dropped.
      }
      return items.filter(Boolean);
    }

    const taskBus = {
      _subs: new Set(),
      subscribe(fn) {
        taskBus._subs.add(fn);
        return () => taskBus._subs.delete(fn);
      },
      emit(payload) {
        // Accept a single string OR an array of strings (a selected list becomes
        // several tasks). Normalize to a non-empty array of trimmed titles.
        const list = (Array.isArray(payload) ? payload : [payload])
          .map((s) => String(s == null ? '' : s).trim())
          .filter(Boolean);
        if (!list.length) return;
        taskBus._subs.forEach((fn) => {
          try { fn(list); } catch { /* ignore one bad subscriber */ }
        });
      },
    };

    // ---- per-session confirmation store (model-task done proposals) ---------
    //
    // The model marks a task `proposedDone` by calling `propose_done`; that lives
    // in the host projection and cannot be rewritten from here. So the user's
    // confirmation ("yes, it's really done") / dismissal lives client-side, keyed
    // by the model task id, in `{[taskId]: 'confirmed' | 'dismissed'}`.

    function confirmKey(sessionId) {
      return `${NS}:confirmations:${sessionId}`;
    }

    function loadConfirmations(sessionId) {
      if (!sessionId) return {};
      try {
        const raw = localStorage.getItem(confirmKey(sessionId));
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function saveConfirmations(sessionId, map) {
      if (!sessionId) return;
      try {
        localStorage.setItem(confirmKey(sessionId), JSON.stringify(map));
      } catch {
        /* ignore quota / privacy mode */
      }
    }

    // ---- persisted floating-widget position ---------------------------------

    function posKey() {
      return `${NS}:widget-pos`;
    }

    function loadWidgetPos() {
      try {
        const raw = localStorage.getItem(posKey());
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          return { x: parsed.x, y: parsed.y };
        }
        return null;
      } catch {
        return null;
      }
    }

    function saveWidgetPos(pos) {
      try {
        localStorage.setItem(posKey(), JSON.stringify({ x: Math.round(pos.x), y: Math.round(pos.y) }));
      } catch {
        /* ignore */
      }
    }

    // ---- projection reader (model tasks) -----------------------------------

    const EMPTY = { getSnapshot: () => undefined, subscribe: () => () => {} };

    function projectionFace(ctx, sessionId) {
      if (!sessionId) return EMPTY;
      const sessions = ctx.get('sessions');
      if (!sessions || typeof sessions.binding !== 'function') return EMPTY;
      try {
        const binding = sessions.binding(sessionId);
        const proj = binding && binding.session && binding.session.projections;
        if (!proj || typeof proj.faceOf !== 'function') return EMPTY;
        return proj.faceOf('taskManager') || EMPTY;
      } catch {
        return EMPTY;
      }
    }

    function useModelTasks(ctx, sessionId) {
      const face = React.useMemo(() => projectionFace(ctx, sessionId), [ctx, sessionId]);
      const snapshot = React.useSyncExternalStore(
        face.subscribe,
        face.getSnapshot,
        face.getSnapshot,
      );
      return snapshot && Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    }

    // ---- active session (overlay is root-scoped) ---------------------------

    function useActiveSessionId(useSessions) {
      const select = typeof useSessions === 'function' ? useSessions : null;
      if (!select) return undefined;
      return select((state) => {
        const byId = (state && state.byId) || {};
        const found = Object.values(byId).find((s) => s && s.retainedBy && (s.retainedBy.mainView ?? 0) > 0);
        return found ? found.id : undefined;
      });
    }

    // ---- floating task widget ----------------------------------------------

    function TaskWidget(props) {
      const { ctx, useSessions, t } = props;
      const sessionId = useActiveSessionId(useSessions);

      const modelTasks = useModelTasks(ctx, sessionId);

      const [userTasks, setUserTasks] = React.useState(() => loadUserTasks(sessionId));
      // Reload user tasks when the active session changes.
      React.useEffect(() => {
        setUserTasks(loadUserTasks(sessionId));
      }, [sessionId]);

      // A selection bubble elsewhere in the overlay can push text here; append it
      // as a user task and expand the card so the user sees it land. We read the
      // latest sessionId via a ref so the subscription stays stable.
      const sessionRef = React.useRef(sessionId);
      sessionRef.current = sessionId;
      React.useEffect(() => {
        return taskBus.subscribe((titles) => {
          const sid = sessionRef.current;
          if (!sid) return;
          const current = loadUserTasks(sid);
          const added = titles.map((title) => ({ id: mintUserId(), title, status: 'todo', origin: 'user' }));
          const next = [...current, ...added];
          saveUserTasks(sid, next);
          setUserTasks(next);
          setOpen(true);
        });
      }, []);

      const [draft, setDraft] = React.useState('');
      const [open, setOpen] = React.useState(false);

      // Drag-to-move: null = default anchored position (bottom-right). Once the
      // user drags, we pin an absolute {x,y} (top-left of the widget) instead and
      // persist it so the panel stays where they dropped it across remounts.
      const [pos, setPos] = React.useState(() => loadWidgetPos());
      React.useEffect(() => {
        // Reset persisted position per session is not needed; keep it global to
        // the widget (one floating panel per window).
      }, []);

      // Drag state machine. `dragRef` holds transient values that must not
      // trigger re-renders each mousemove.
      const dragRef = React.useRef(null);
      // Set true right after a real drag so the subsequent click is swallowed
      // (prevents a drag from also toggling the pill open / firing row buttons).
      const pillJustDragged = React.useRef(false);
      const resetDragFlagTimer = React.useRef(null);

      function beginDrag(e, opts) {
        // Ignore right/other mouse buttons and drags starting on an interactive
        // control (buttons/inputs) so clicking them still works. The collapsed
        // pill IS a button, so callers can pass { fromPill:true } to make that
        // button itself a drag handle (nested controls still block the drag).
        if (e.button !== 0) return;
        const fromPill = !!(opts && opts.fromPill);
        const tgt = e.target;
        if (tgt && tgt.closest) {
          const blocked = tgt.closest('button,input,textarea,a');
          // When dragging the pill, its own <button> is the handle; ignore only
          // deeper interactive descendants (there are none today, but be safe).
          if (blocked && !(fromPill && blocked === e.currentTarget)) return;
        }
        const wrap = e.currentTarget;
        const rect = wrap.getBoundingClientRect();
        dragRef.current = {
          startX: e.clientX,
          startY: e.clientY,
          originX: rect.left,
          originY: rect.top,
          moved: false,
        };
        // Prevent text selection while dragging.
        if (e.preventDefault) e.preventDefault();
        window.addEventListener('mousemove', onDragMove);
        window.addEventListener('mouseup', endDrag);
      }

      function onDragMove(e) {
        const d = dragRef.current;
        if (!d) return;
        const dx = e.clientX - d.startX;
        const dy = e.clientY - d.startY;
        if (!d.moved && Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        if (!d.moved) return;
        // Clamp so the widget cannot be dragged fully off-screen.
        const maxX = Math.max(0, window.innerWidth - 60);
        const maxY = Math.max(0, window.innerHeight - 40);
        const x = Math.min(maxX, Math.max(0, d.originX + dx));
        const y = Math.min(maxY, Math.max(0, d.originY + dy));
        setPos({ x, y });
      }

      function endDrag() {
        window.removeEventListener('mousemove', onDragMove);
        window.removeEventListener('mouseup', endDrag);
        const d = dragRef.current;
        dragRef.current = null;
        // Persist the final position (only if it was a real drag) and remember
        // that this gesture was a drag so a following click does not toggle the
        // panel / fire a row action.
        if (d && d.moved) {
          pillJustDragged.current = true;
          // Clear the flag shortly after, in case no click follows (e.g. the
          // mouseup landed outside the element).
          if (resetDragFlagTimer.current) clearTimeout(resetDragFlagTimer.current);
          resetDragFlagTimer.current = setTimeout(() => { pillJustDragged.current = false; }, 0);
          setPos((cur) => {
            if (cur) saveWidgetPos(cur);
            return cur;
          });
        }
      }

      // Tear down any in-flight listeners if we unmount mid-drag.
      React.useEffect(() => () => {
        window.removeEventListener('mousemove', onDragMove);
        window.removeEventListener('mouseup', endDrag);
      }, []);

      const [confirmations, setConfirmations] = React.useState(() => loadConfirmations(sessionId));
      // Reload confirmations when the active session changes.
      React.useEffect(() => {
        setConfirmations(loadConfirmations(sessionId));
      }, [sessionId]);

      function commitConfirmations(next) {
        setConfirmations(next);
        saveConfirmations(sessionId, next);
      }

      function setConfirmation(id, value) {
        commitConfirmations({ ...confirmations, [id]: value });
      }

      function commitUserTasks(next) {
        setUserTasks(next);
        saveUserTasks(sessionId, next);
      }

      function addTask() {
        const title = draft.trim();
        if (title.length === 0) return;
        const task = {
          id: mintUserId(),
          title,
          status: 'todo',
          origin: 'user',
        };
        // Add to the list only; never copy into the chat composer.
        commitUserTasks([...userTasks, task]);
        setDraft('');
      }

      function removeUserTask(id) {
        commitUserTasks(userTasks.filter((task) => task.id !== id));
      }

      function setUserStatus(id, status) {
        commitUserTasks(userTasks.map((task) => (task.id === id ? { ...task, status } : task)));
      }

      function clearDoneUserTasks() {
        commitUserTasks(userTasks.filter((task) => task.status !== 'done'));
      }

      function startTask(task) {
        if (!sessionId) return;
        const sessions = ctx.get('sessions');
        let sent = false;
        try {
          const scope = sessions && typeof sessions.scope === 'function' ? sessions.scope(sessionId) : undefined;
          const conversation = scope && typeof scope.get === 'function' ? scope.get('conversation') : undefined;
          if (conversation && typeof conversation.send === 'function') {
            Promise.resolve(conversation.send(fill(t('sendPrompt'), { title: task.title }))).catch(() => {});
            sent = true;
          }
        } catch {
          sent = false;
        }
        // Collapse the floating card so the conversation is unobstructed.
        if (sent) setOpen(false);
      }

      // Merge: model tasks (live) then user tasks (local), each group ordered.
      // For model tasks the model may have proposed completion (`proposedDone`);
      // the row shows "awaiting confirmation" until the user confirms/dismisses it
      // (stored in `confirmations[taskId]`).
      const modelRows = modelTasks.map((task) => {
        const decision = confirmations[task.id];
        const pendingConfirm = task.proposedDone === true && decision !== 'confirmed';
        return { ...task, _source: 'model', _pendingConfirm: pendingConfirm };
      });
      const merged = [
        ...modelRows,
        ...userTasks.map((task) => ({ ...task, _source: 'user', _pendingConfirm: false })),
      ];

      // Tasks the model proposed as done that the user has not yet confirmed.
      const pendingConfirms = merged.filter((task) => task._pendingConfirm && confirmations[task.id] !== 'dismissed');

      // Count done only for confirmed/completed tasks; pending ones are surfaced
      // in the confirm banner rather than counted as finished.
      const counts = { todo: 0, doing: 0, done: 0 };
      for (const task of merged) {
        if (task._pendingConfirm) continue;
        if (counts[task.status] != null) counts[task.status] += 1;
      }
      const pendingCount = pendingConfirms.length;

      const activeCount = counts.todo + counts.doing;
      const styles = makeStyles();

      function confirmAll() {
        const next = { ...confirmations };
        for (const task of pendingConfirms) next[task.id] = 'confirmed';
        commitConfirmations(next);
      }
      function dismissAll() {
        const next = { ...confirmations };
        for (const task of pendingConfirms) next[task.id] = 'dismissed';
        commitConfirmations(next);
      }

      function statusButton(task) {
        const isUser = task._source === 'user';
        const advance = () => {
          const next = task.status === 'todo' ? 'doing' : task.status === 'doing' ? 'done' : 'todo';
          if (isUser) {
            setUserStatus(task.id, next);
          } else if (next === 'done') {
            // Model task: mark done locally (overrides the projection display).
            setConfirmation(task.id, 'confirmed');
          } else {
            // Non-done transitions for model tasks are handed back to the model.
            startTask(task);
          }
        };
        const label = task.status === 'todo' ? t('markDoing') : task.status === 'doing' ? t('markDone') : t('markTodo');
        const glyph = task.status === 'todo' ? '▶' : task.status === 'doing' ? '✓' : '↺';
        return h('button', {
          style: styles.btn, title: label, 'aria-label': label,
          onClick: advance,
        }, glyph);
      }

      // A row's explicit "Complete" button — the missing entry point the user
      // asked for. Works for both user and model tasks (model → local confirm).
      function completeButton(task) {
        if (task.status === 'done' && !task._pendingConfirm) return null;
        const done = () => {
          if (task._source === 'user') setUserStatus(task.id, 'done');
          else setConfirmation(task.id, 'confirmed');
        };
        return h('button', {
          style: styles.btn, title: t('complete'), 'aria-label': t('complete'),
          onClick: done,
        }, `✓ ${t('complete')}`);
      }

      const rows = merged.map((task) => {
        const isUser = task._source === 'user';
        const pending = task._pendingConfirm;
        const labelStyle = {
          ...styles.label,
          ...(task.status === 'done' && !pending ? styles.doneLabel : {}),
        };
        return h('li', { key: `${task._source}:${task.id}`, style: styles.row },
          h('span', { style: { ...styles.dot, background: STATUS_COLOR[task.status] || STATUS_COLOR.todo } }),
          h('span', { style: styles.badge, title: isUser ? t('originUser') : t('originModel') },
            isUser ? t('fromUser') : t('fromModel')),
          h('span', {
            style: labelStyle,
            title: task.detail ? `${task.title} — ${task.detail}` : task.title,
          },
            h('span', { style: styles.labelTitle }, task.title),
            task.detail
              ? h('span', { style: styles.labelDetail }, task.detail)
              : null,
          ),
          pending
            ? h('span', { style: styles.pendingBadge, title: t('proposed') }, t('proposed'))
            : null,
          pending
            ? h('button', {
                style: styles.primaryBtn, title: t('confirm'), onClick: () => setConfirmation(task.id, 'confirmed'),
              }, t('confirm'))
            : completeButton(task),
          h('button', { style: styles.btn, onClick: () => startTask(task), title: t('start') }, t('start')),
          isUser
            ? h('button', { style: styles.btn, onClick: () => removeUserTask(task.id), title: t('remove') }, '✕')
            : null,
        );
      });

      const countsText =
        `${fill(t('countPending'), { n: counts.todo })} · ` +
        `${fill(t('countDoing'), { n: counts.doing })} · ` +
        `${fill(t('countDone'), { n: counts.done })}`;

      // Wrap style: when dragged, pin to absolute x/y (top-left); otherwise keep
      // the default bottom-right anchor.
      const wrapStyle = pos
        ? { ...styles.wrap, left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' }
        : styles.wrap;

      // ---- collapsed pill ----------------------------------------------------
      if (!open) {
        return h('div', { style: wrapStyle, 'data-task-manager': '', 'data-tm-ui': '1' },
          h('button', {
            style: styles.pill,
            title: t('openPanel'),
            'aria-label': t('openPanel'),
            onMouseDown: (e) => beginDrag(e, { fromPill: true }),
            onClick: () => {
              // Suppress the open-toggle if this was a drag gesture. endDrag
              // clears dragRef.current, so we must check the flag it left on the
              // ref-transition; simplest: track "was dragged" separately.
              if (pillJustDragged.current) { pillJustDragged.current = false; return; }
              setOpen(true);
            },
          },
            h('span', { style: styles.pillIcon }, h(TaskGlyph, { size: 15 })),
            h('span', { style: styles.pillText }, t('title')),
            activeCount > 0
              ? h('span', { style: styles.pillBadge }, String(activeCount))
              : null,
            pendingCount > 0
              ? h('span', { style: styles.pillPending, title: t('proposed') }, `✓${pendingCount}`)
              : null,
          ),
        );
      }

      // ---- expanded card -----------------------------------------------------
      return h('div', { style: wrapStyle, 'data-task-manager': '', 'data-tm-ui': '1' },
        h('div', { style: styles.card },
          h('div', { style: styles.header, onMouseDown: beginDrag, title: t('dragHint') },
            h('span', { style: styles.headerIcon }, h(TaskGlyph, { size: 15 })),
            h('span', { style: styles.title }, t('title')),
            h('span', { style: styles.counts }, countsText),
            counts.done > 0
              ? h('button', { style: styles.btn, onClick: clearDoneUserTasks, title: t('clearDone') }, t('clearDone'))
              : null,
            h('button', {
              style: styles.closeBtn,
              title: t('collapse'),
              'aria-label': t('collapse'),
              onClick: () => setOpen(false),
            }, '✕'),
          ),
          h('div', { style: styles.body },
            sessionId === undefined
              ? h('div', { style: styles.empty }, t('noSession'))
              : h('div', { style: styles.bodyInner },
                pendingCount > 0
                  ? h('div', { style: styles.confirmBar },
                      h('span', { style: styles.confirmText },
                        fill(t('confirmBanner'), { n: pendingCount })),
                      h('button', { style: styles.primaryBtn, onClick: confirmAll }, t('confirmAll')),
                      h('button', { style: styles.btn, onClick: dismissAll }, t('dismiss')),
                    )
                  : null,
                merged.length === 0
                  ? h('div', { style: styles.empty }, t('empty'))
                  : h('ul', { style: styles.list }, rows),
                h('div', { style: styles.addRow },
                  h('input', {
                    style: styles.input,
                    value: draft,
                    placeholder: t('addPlaceholder'),
                    onChange: (e) => setDraft(e.target.value),
                    onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); addTask(); } },
                  }),
                  h('button', { style: styles.primaryBtn, onClick: addTask }, t('add')),
                ),
              ),
          ),
        ),
      );
    }

    function makeStyles() {
      // Theme tokens follow light/dark automatically (see listTokens). Never
      // bake a light-mode hex here as the primary value: an unknown var() falls
      // back to it and the panel goes unreadable in dark mode. The 2nd argument
      // is only a last-resort fallback if the token itself is missing.
      const C = {
        text: 'var(--dsw-alias-label-primary)',
        text2: 'var(--dsw-alias-label-secondary)',
        border: 'var(--dsw-alias-border-l1)',
        border2: 'var(--dsw-alias-border-l2)',
        surface: 'var(--dsw-alias-bg-layer-1)',
        surface2: 'var(--dsw-alias-bg-layer-2)',
        overlay: 'var(--dsw-alias-bg-overlay)',
        // NOTE: brand-primary is an INVERTING NEUTRAL, not a hue: it resolves to
        // near-black rgb(15,17,21) in light theme and near-white rgb(249,250,251)
        // in dark. So anything filled with `accent` must take its text from the
        // *inverse* token `bg-base` (white in light / near-black in dark) — never
        // a hard #fff, which would be white-on-white in dark mode.
        accent: 'var(--dsw-alias-brand-primary)',
        success: 'var(--dsw-alias-state-success-primary)',
        onAccent: 'var(--dsw-alias-bg-base)',
      };
      return {
        // Fixed overlay pinned bottom-right, above the conversation. The
        // shell.overlay layer is click-through, so this wrapper opts back in.
        wrap: {
          position: 'fixed',
          right: '20px',
          bottom: '88px',
          zIndex: 60,
          pointerEvents: 'auto',
          font: 'inherit',
          fontSize: '13px',
          color: C.text,
        },
        pill: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: '7px',
          padding: '7px 12px 7px 10px',
          borderRadius: '999px',
          border: `1px solid ${C.border}`,
          background: C.surface,
          boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
          color: C.text,
          // Collapsed pill reads as CLICKABLE (open the panel); dragging still
          // works from here, but `move` made it look like a non-action handle.
          cursor: 'pointer',
          userSelect: 'none',
          font: 'inherit',
          fontSize: '13px',
        },
        pillIcon: { display: 'inline-flex', color: C.accent },
        pillText: { fontWeight: 600 },
        pillBadge: {
          minWidth: '18px',
          height: '18px',
          lineHeight: '18px',
          textAlign: 'center',
          borderRadius: '9px',
          padding: '0 5px',
          background: C.accent,
          color: C.onAccent,
          fontSize: '11px',
          fontWeight: 600,
        },
        pillPending: {
          minWidth: '18px',
          height: '18px',
          lineHeight: '18px',
          textAlign: 'center',
          borderRadius: '9px',
          padding: '0 5px',
          // success is a real green hue (not inverting), so its text stays white
          // in both themes — do NOT use onAccent/bg-base here.
          background: C.success,
          color: '#ffffff',
          fontSize: '11px',
          fontWeight: 600,
        },
        confirmBar: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
          padding: '7px 9px',
          borderRadius: '8px',
          border: `1px solid ${C.success}`,
          // Tint that reads on both themes: a translucent success wash over the
          // card surface rather than a hard light hex. `background` before
          // `backgroundColor` gives a solid fallback where color-mix is missing.
          background: C.surface2,
          backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)',
        },
        confirmText: { flex: '1 1 auto', minWidth: 0, fontSize: '12px', color: C.text },
        pendingBadge: {
          flex: '0 0 auto',
          fontSize: '10px',
          lineHeight: '15px',
          padding: '0 5px',
          borderRadius: '6px',
          border: `1px solid ${C.success}`,
          color: C.success,
          whiteSpace: 'nowrap',
        },
        card: {
          // 340 → 510 (+50% expanded width)
          width: '510px',
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'min(60vh, 520px)',
          display: 'flex',
          flexDirection: 'column',
          borderRadius: '12px',
          border: `1px solid ${C.border}`,
          background: C.overlay,
          boxShadow: '0 12px 32px rgba(0,0,0,0.36)',
          overflow: 'hidden',
        },
        header: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 12px',
          borderBottom: `1px solid ${C.border}`,
          cursor: 'move',
          userSelect: 'none',
        },
        headerIcon: { display: 'inline-flex', color: C.accent },
        title: { fontWeight: 600, fontSize: '14px', color: C.text },
        counts: { color: C.text2, fontSize: '11px', marginLeft: 'auto' },
        closeBtn: {
          flex: '0 0 auto',
          border: 'none',
          background: 'transparent',
          color: C.text2,
          cursor: 'pointer',
          fontSize: '13px',
          padding: '2px 4px',
          borderRadius: '6px',
        },
        body: { padding: '10px 12px', overflow: 'auto' },
        bodyInner: { display: 'flex', flexDirection: 'column', gap: '8px' },
        list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
        row: {
          display: 'flex', alignItems: 'flex-start', gap: '6px',
          padding: '6px 8px', borderRadius: '8px',
          border: `1px solid ${C.border}`,
          background: C.surface2,
        },
        dot: { width: '9px', height: '9px', borderRadius: '50%', flex: '0 0 auto' },
        badge: {
          flex: '0 0 auto',
          fontSize: '10px',
          lineHeight: '15px',
          padding: '0 5px',
          borderRadius: '6px',
          border: `1px solid ${C.border}`,
          color: C.text2,
          whiteSpace: 'nowrap',
        },
        label: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px', color: C.text },
        labelTitle: { overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'normal', lineHeight: '18px' },
        labelDetail: { overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'normal', color: C.text2, fontSize: '11px', lineHeight: '16px' },
        doneLabel: { textDecoration: 'line-through', opacity: 0.65 },
        btn: {
          flex: '0 0 auto',
          border: `1px solid ${C.border}`,
          background: 'transparent', color: C.text,
          borderRadius: '7px', padding: '1px 7px', fontSize: '11px', cursor: 'pointer',
        },
        primaryBtn: {
          border: '1px solid transparent',
          background: C.accent, color: C.onAccent,
          borderRadius: '7px', padding: '4px 12px', fontSize: '12px', cursor: 'pointer', whiteSpace: 'nowrap',
        },
        addRow: { display: 'flex', gap: '6px', marginTop: '4px' },
        input: {
          flex: '1 1 auto', minWidth: 0,
          border: `1px solid ${C.border}`,
          borderRadius: '7px', padding: '5px 9px',
          background: C.surface2, color: C.text, font: 'inherit', fontSize: '12px',
        },
        empty: { color: C.text2, fontSize: '12px', padding: '6px 2px' },
      };
    }

    // ---- selection bubble ---------------------------------------------------
    //
    // A tiny floating "+任务" button that appears next to the user's text
    // selection anywhere in the app. Clicking it pushes the selected text into
    // the task bus (added as a user task). We only react to non-empty selections
    // of reasonable length, and ignore selections made inside our own card.
    function SelectionBubble(props) {
      const { t } = props;
      const [state, setState] = React.useState({ visible: false, x: 0, y: 0, text: '' });

      React.useEffect(() => {
        function insideOwnUi(node) {
          let el = node && node.nodeType === 3 ? node.parentElement : node;
          while (el && el !== document.body) {
            if (el.getAttribute && el.getAttribute('data-tm-ui') === '1') return true;
            el = el.parentElement;
          }
          return false;
        }

        function evaluate() {
          const sel = window.getSelection();
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            // Selection collapsed/cleared: hide.
            setState((s) => (s.visible ? { ...s, visible: false } : s));
            return;
          }
          const text = String(sel.toString() || '').trim();
          if (!text || text.length > 800) return;
          if (insideOwnUi(sel.anchorNode) || insideOwnUi(sel.focusNode)) {
            setState((s) => (s.visible ? { ...s, visible: false } : s));
            return;
          }
          let rect = null;
          try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
          if (!rect || (rect.width === 0 && rect.height === 0)) return;
          // Prefer to sit right beside the app's own floating selection pill
          // ("引用文本" surface, element [data-text-interaction-surface]) so the
          // two actions read as one cluster. That surface is positioned by the
          // chat view near the selection; we anchor to its top-right corner.
          let x, y;
          let native = null;
          try { native = document.querySelector('[data-text-interaction-surface]'); } catch { native = null; }
          let nativeVisible = false;
          if (native) {
            const cs = window.getComputedStyle ? window.getComputedStyle(native) : null;
            const nr = native.getBoundingClientRect();
            nativeVisible = !native.getAttribute('aria-hidden') ||
              (cs && cs.visibility !== 'hidden' && cs.display !== 'none' && (nr.width > 0 || nr.height > 0));
          }
          if (native && nativeVisible) {
            const nr = native.getBoundingClientRect();
            if (nr.width > 0 || nr.height > 0) {
              // Place immediately to the right of the native pill, same top line.
              x = Math.min(window.innerWidth - 120, nr.right + 6);
              y = nr.top;
            }
          }
          if (x === undefined) {
            const cx = Math.min(window.innerWidth - 140, Math.max(8, rect.left + rect.width / 2 - 52));
            x = cx;
            y = Math.max(8, rect.top - 38);
          }
          setState({ visible: true, x, y, text });
        }

        // Primary trigger: `selectionchange` fires reliably on every selection
        // mutation regardless of whether mouse events reach the document
        // (the conversation may intercept pointer events). Debounced to let a
        // drag settle before we read the rect.
        let tSel = null;
        let tSel2 = null;
        function onSelectionChange() {
          if (tSel) clearTimeout(tSel);
          if (tSel2) clearTimeout(tSel2);
          tSel = setTimeout(evaluate, 160);
          // The native "引用文本" surface is created by an interaction dispatch
          // that may run a beat later; re-run once so we can snap beside it.
          tSel2 = setTimeout(evaluate, 360);
        }
        // Secondary: mouseup / keyup (keyboard selection via Shift+Arrows).
        let tUp = null;
        function onMouseUp() { if (tUp) clearTimeout(tUp); tUp = setTimeout(evaluate, 10); }
        function onKeyUp(e) {
          if (e.shiftKey || e.key === 'Shift') { if (tUp) clearTimeout(tUp); tUp = setTimeout(evaluate, 10); }
        }

        function onMouseDown(e) {
          const el = e.target;
          if (el && el.closest && el.closest('[data-tm-bubble="1"]')) return;
          // A new mousedown starts a fresh selection gesture — hide the old bubble.
          setState((s) => (s.visible ? { ...s, visible: false } : s));
        }
        function onHide() { setState((s) => (s.visible ? { ...s, visible: false } : s)); }
        function onKeyDown(e) { if (e.key === 'Escape') onHide(); }

        document.addEventListener('selectionchange', onSelectionChange);
        document.addEventListener('mouseup', onMouseUp, true);
        document.addEventListener('keyup', onKeyUp, true);
        document.addEventListener('mousedown', onMouseDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        window.addEventListener('scroll', onHide, true);
        window.addEventListener('resize', onHide, true);
        return () => {
          if (tSel) clearTimeout(tSel);
          if (tSel2) clearTimeout(tSel2);
          if (tUp) clearTimeout(tUp);
          document.removeEventListener('selectionchange', onSelectionChange);
          document.removeEventListener('mouseup', onMouseUp, true);
          document.removeEventListener('keyup', onKeyUp, true);
          document.removeEventListener('mousedown', onMouseDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
          window.removeEventListener('scroll', onHide, true);
          window.removeEventListener('resize', onHide, true);
        };
      }, []);

      function handleAdd(e) {
        e.preventDefault();
        e.stopPropagation();
        const titles = parseSelectionToTasks(state.text);
        if (titles.length) taskBus.emit(titles);
        setState((s) => ({ ...s, visible: false }));
        try { window.getSelection().removeAllRanges(); } catch { /* ignore */ }
      }

      if (!state.visible) return null;
      const count = parseSelectionToTasks(state.text).length;
      const label = count > 1 ? t('addAsTasksN').replace('{n}', String(count)) : t('addAsTask');
      // Viewport-anchored (position:fixed) because we align to the native
      // selection pill via getBoundingClientRect() (viewport coords). The
      // shell.overlay layer sits inside .frame which has no transform, so a
      // fixed child is not re-anchored; `.overlayLayer > *` grants pointer events.
      return h('div', {
        'data-tm-ui': '1',
        'data-tm-bubble': '1',
        style: { position: 'fixed', left: `${state.x}px`, top: `${state.y}px`, zIndex: 100000, pointerEvents: 'auto' },
      }, h('button', {
        type: 'button',
        onMouseDown: (e) => e.preventDefault(),
        onClick: handleAdd,
        title: t('addAsTask'),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '4px',
          padding: '4px 10px', fontSize: '12px', lineHeight: '18px',
          cursor: 'pointer', borderRadius: '6px',
          border: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-brand-primary)',
          color: 'var(--dsw-alias-bg-base)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
          whiteSpace: 'nowrap',
        },
      }, `+ ${label}`));
    }

    // ---- icon ---------------------------------------------------------------
    const ICON_PATH =
      'M2 3.5h2v2H2v-2zm4 0.25h8v1.5H6v-1.5zM2 7.25h2v2H2v-2zm4 0.25h8v1.5H6V7.5zM2 11h2v2H2v-2zm4 0.25h8v1.5H6v-1.5z';

    function TaskGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size,
        fill: 'currentColor', 'aria-hidden': 'true', focusable: 'false',
        dangerouslySetInnerHTML: { __html: `<path d="${ICON_PATH}"/>` },
      });
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // `locale` is a hard inject here (accessed as ctx.locale): ctx.get('locale')
        // can be undefined for a merely-service-aware context, which silently
        // left the panel stuck on the English FALLBACK. Registering via the
        // injected service guarantees the active-locale lookup can see our dict.
        const locale = ctx.locale || ctx.get('locale');
        // Register panel dictionaries (locale/*.json only feeds meta.title/description).
        // Use the single-locale form (like dsh-better-sidebar) so a single bad
        // locale tag cannot drop the whole dictionary set.
        let disposeLocaleZh = null;
        let disposeLocaleEn = null;
        if (locale && typeof locale.register === 'function') {
          try { disposeLocaleZh = locale.register(NS, 'zh', DICT_ZH); } catch { disposeLocaleZh = null; }
          try { disposeLocaleEn = locale.register(NS, 'en', DICT_EN); } catch { disposeLocaleEn = null; }
        }
        const disposeLocale = () => {
          if (disposeLocaleZh) { try { disposeLocaleZh(); } catch {} disposeLocaleZh = null; }
          if (disposeLocaleEn) { try { disposeLocaleEn(); } catch {} disposeLocaleEn = null; }
        };

        // Translate a key, falling back to the built-in English dict when the
        // locale service has no entry (returns the key itself).
        const bindT = () => {
          const t = locale && typeof locale.bind === 'function' ? locale.bind(NS) : null;
          return (key, params) => {
            let value = t ? t(key, params) : undefined;
            if (value === undefined || value === key) {
              value = FALLBACK[key] !== undefined ? FALLBACK[key] : key;
              if (params) value = fill(value, params);
            }
            return value;
          };
        };

        let disposeOverlay = null;
        let disposeBubble = null;

        const mount = () => {
          if (disposeOverlay) return;
          disposeOverlay = ctx.slots.register({
            name: 'shell.overlay',
            id: OVERLAY_ID,
            order: 50,
            label: () => bindT()('title'),
            locale: NS,
          }, (props) => h(TaskWidget, { ...props, ctx, t: bindT() }));
          // The selection bubble is a second, independent overlay entry (order 51)
          // that floats next to any text the user highlights. It feeds the task
          // bus so the card above picks the text up as a user task.
          if (!disposeBubble) {
            try {
              disposeBubble = ctx.slots.register({
                name: 'shell.overlay',
                id: `${OVERLAY_ID}-bubble`,
                order: 51,
                locale: NS,
              }, (props) => h(SelectionBubble, { ...props, t: bindT() }));
            } catch {
              disposeBubble = null;
            }
          }
        };

        const unmount = () => {
          if (disposeOverlay) { try { disposeOverlay(); } catch {} disposeOverlay = null; }
          if (disposeBubble) { try { disposeBubble(); } catch {} disposeBubble = null; }
        };

        ctx.slots.inject('shell.overlay', () => {
          mount();
          return () => unmount();
        });

        // Dispose the locale dictionaries when the plugin itself unloads.
        if (typeof ctx.effect === 'function') {
          ctx.effect(() => () => {
            disposeLocale();
          }, 'task-manager: locale cleanup');
        }
      },
    };
  },
});
