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
 * ONE source of truth: this plugin's session projection `taskManager`, read live
 * through the sessions client service:
 * `ctx.sessions.binding(id).session.projections.faceOf('taskManager')`, a
 * `{ getSnapshot, subscribe }` store bound with `useSyncExternalStore`.
 * - Model tasks: the host half writes them via the `task_write` tool (the model
 *   reports a plan, marks progress, proposes completion), so rows update by
 *   themselves as the model acts.
 * - User tasks: the card writes them back to the SAME projection via the host
 *   `tasks-sync` command (`ctx.remote.commands.execute`). Every user edit — add,
 *   status change, remove, confirm/dismiss a completion proposal — is applied by
 *   the command handler and folded from the resulting `command/done` event, so
 *   the user's tasks are durable across fork/reload and visible to the model's
 *   next `list`. Both writers are told apart by `origin: 'model' | 'user'`.
 *   Adding a task appends it to the list — it is NOT copied into the composer.
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
    // Host command name used as the Client→Host write path (see `syncToHost`).
    const SYNC_COMMAND = 'tasks-sync';

    // Fallback strings; overridden by the locale service when available.
    const FALLBACK = {
      title: 'Tasks',
      empty: 'No tasks yet. Ask the model for a plan, or add one below.',
      addPlaceholder: 'Add a task…',
      edit: 'Edit',
      editTitlePlaceholder: 'Title',
      editDetailPlaceholder: 'Detail (optional)',
      save: 'Save',
      add: 'Add',
      start: 'Start',
      remove: 'Remove',
      markDone: 'Mark done',
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
      archiveDone: 'Archive done',
      archive: 'Archive',
      archiveTitle: 'Archive',
      archiveSectionTitle: 'Archived (kept, not deleted)',
      archiveEmpty: 'No archived tasks yet.',
      archiveHint: 'Archived tasks are kept, not deleted.',
      restore: 'Restore',
      deleteForever: 'Delete forever',
      showArchive: 'Archive',
      expandArchive: 'Show archive',
      collapseArchive: 'Hide archive',
      backToTasks: 'Back to list',
      emptyAll: 'No tasks yet — add one below.',
      emptyAllArchived: 'Nothing active. {n} task(s) are in the archive — open it above, or add a new one below.',
      openPanel: 'Show tasks',
      collapse: 'Collapse',
      dragHint: 'Drag to move',
      complete: 'Complete',
      proposed: 'Awaiting confirm',
      confirmBanner: 'The model reports {n} task(s) done — confirm?',
      confirmAll: 'Confirm all',
      confirm: 'Confirm',
      dismiss: 'Dismiss',
      addAsTask: 'Add as task',
      addAsTasksN: 'Add {n} tasks',
      removeModel: 'Remove',
      startConfirm: 'Send this task to the conversation and start it?',
      sendNow: 'Send',
      cancel: 'Cancel',
      stTodo: 'To do',
      stDoing: 'In progress',
      stDone: 'Done',
      reopen: 'Reopen',
      syncFailed: 'Could not reach the host — the change was not saved. Try again.',
      syncDismiss: 'Dismiss',
      resizeHint: 'Drag to resize',
    };

    // Flat dictionaries registered with the locale service (locale/*.json only
    // supplies the plugin's meta.title/description, NOT panel strings).
    const DICT_EN = FALLBACK;
    const DICT_ZH = {
      title: '任务',
      empty: '还没有任务。可以让模型给出实施顺序，或在下方添加。',
      addPlaceholder: '添加任务…',
      edit: '编辑',
      editTitlePlaceholder: '标题',
      editDetailPlaceholder: '正文（可留空）',
      save: '保存',
      add: '添加',
      start: '开始',
      remove: '删除',
      markDone: '标记完成',
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
      archiveDone: '归档已完成',
      archive: '归档',
      archiveTitle: '归档',
      archiveSectionTitle: '已归档（保留，未删除）',
      archiveEmpty: '还没有归档的任务。',
      archiveHint: '归档只移出列表，不会删除。',
      restore: '恢复',
      deleteForever: '彻底删除',
      showArchive: '归档',
      expandArchive: '展开归档',
      collapseArchive: '收起归档',
      backToTasks: '返回列表',
      emptyAll: '还没有任务，在下面添加。',
      emptyAllArchived: '当前没有待办，{n} 项已归档——可在上方展开归档查看，或在下方新建。',
      openPanel: '显示任务',
      collapse: '收起',
      dragHint: '拖动移动位置',
      complete: '完成',
      proposed: '待确认完成',
      confirmBanner: '模型判断有 {n} 项任务已完成，确认吗？',
      confirmAll: '全部确认',
      confirm: '确认',
      dismiss: '忽略',
      addAsTask: '添加为任务',
      addAsTasksN: '添加 {n} 个任务',
      removeModel: '移除',
      startConfirm: '要把这个任务发送到对话并开始执行吗？',
      sendNow: '发送',
      cancel: '取消',
      stTodo: '待办',
      stDoing: '进行中',
      stDone: '已完成',
      reopen: '重新打开',
      syncFailed: '没能连上宿主，改动没有保存。请重试。',
      syncDismiss: '知道了',
      resizeHint: '拖动调整宽度',
    };

    // Archived stamps are stored as ISO strings. Show a short, locale-neutral
    // "MM-DD HH:mm" (same year) or "YYYY-MM-DD" otherwise — enough to answer
    // "when did I finish this?" without spending a whole row on it.
    function formatArchivedAt(value) {
      if (typeof value !== 'string' || value.length === 0) return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      const sameYear = date.getFullYear() === new Date().getFullYear();
      const md = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
      const hm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
      return sameYear ? `${md} ${hm}` : `${date.getFullYear()}-${md}`;
    }

    function fill(template, vars) {
      return String(template).replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
    }

    // Three DISTINCT hues so the row never relies on colour alone: neutral for
    // to-do, amber for in-progress, green for done. `brand-primary` is
    // deliberately NOT used — it is an inverting neutral (near-black in light,
    // near-white in dark), which made "in progress" look like a blank/white dot.
    const STATUS_COLOR = {
      todo: 'var(--dsw-alias-state-idle-primary, #8a8f98)',
      doing: 'var(--dsw-alias-state-warn-primary, #f5a524)',
      done: 'var(--dsw-alias-state-success-primary, #2e9e5b)',
    };

    // ---- client → host write-back (user edits) ------------------------------
    //
    // The projection is read-only from a plugin, so every user edit — add,
    // status change, remove, confirm/dismiss — is sent to the host `tasks-sync`
    // command through the `commands` remote. The command handler applies the edit
    // to the current list and returns the marker text; the projection folds the
    // resulting `command/done`, so the SAME list the model reads also picks up
    // the user's change. This keeps one source of truth (the session log) instead
    // of a localStorage copy that forks/reloads would silently drop.
    // Writes are SERIALIZED per session. Each `tasks-sync` handler reads the
    // current list, applies its edit, and the projection only folds the resulting
    // `command/done` after the handler settles — so two overlapping writes would
    // both read the same pre-edit list and the later one would silently drop the
    // earlier edit (a lost update: click "add" twice quickly and one task
    // disappears). Chaining on a per-session promise makes each write start from
    // the state the previous one produced.
    const writeQueues = new Map();

    function enqueueWrite(sessionId, run) {
      const previous = writeQueues.get(sessionId) || Promise.resolve();
      const next = previous.then(run, run);
      // Keep the chain alive but never let it grow: a settled tail is replaced on
      // the next call, and failures are already handled inside `run`.
      writeQueues.set(sessionId, next.then(() => {}, () => {}));
      return next;
    }

    // Resolve the `commands` remote endpoint once. `remote`/`remote.commands`
    // are declared in `inject`, which is what makes `ctx.remote` legal: cordis
    // gates service PROPERTY access on the fiber's inject declaration and throws
    // synchronously otherwise — reading `ctx.remote` undeclared used to abort the
    // click handler before any write happened, so buttons looked dead.
    function commandExec(ctx) {
      if (!ctx) return null;
      // `ctx.get(name)` is the optional-lookup form and never throws, so try it
      // first; `ctx.remote` is the declared form (see `inject` below).
      let remote;
      if (typeof ctx.get === 'function') {
        try {
          remote = ctx.get('remote');
        } catch {
          remote = undefined;
        }
      }
      if (remote === undefined) {
        try {
          remote = ctx.remote;
        } catch {
          remote = undefined;
        }
      }
      const commands = remote && remote.commands;
      if (!commands || typeof commands.execute !== 'function') return null;
      return commands.execute.bind(commands);
    }

    function syncToHost(ctx, sessionId, payload) {
      if (!sessionId) return Promise.resolve({ ok: false });
      let exec = null;
      try {
        exec = commandExec(ctx);
      } catch {
        exec = null;
      }
      if (exec === null) return Promise.resolve({ ok: false });
      const line = `/tasks-sync ${JSON.stringify(payload)}`;
      return enqueueWrite(sessionId, () => Promise.resolve(exec(sessionId, line, [])).then((resp) => {
        if (!resp || !resp.ok) {
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[task-manager] tasks-sync failed', resp);
          }
        }
        return resp;
      }).catch((err) => {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[task-manager] tasks-sync error', err);
        }
        return { ok: false };
      }));
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
    const LIST_ITEM_RE = /^\s*(?:[-*•·▪◦]|\d+[.)、]|[①-⑳]|\(\d+\))\s*(.+?)\s*$/;
    // Split a one-line passage that lists items INLINE, e.g.
    //   "- 甲 / - 乙 / - 丙"   or   "1. 甲、2. 乙、3. 丙"   or   "- 甲 - 乙 - 丙"
    // Returns [] when it cannot see >=2 such inline items.
    function splitInlineList(text) {
      // Only consider an explicit separator between items (/ 、 ， ; ；) or the
      // very start; bare whitespace is NOT enough, to avoid shredding prose.
      const re = /(?:^|[/、，;；])\s*(?:[-*•·▪◦]|\d+[.)、]|[①-⑳]|\(\d+\))\s*/g;
      const marks = [];
      let m;
      while ((m = re.exec(text)) !== null) {
        marks.push({ idx: m.index + m[0].length, markLen: m[0].length });
        if (m[0].length === 0) re.lastIndex += 1;
      }
      if (marks.length < 2) return [];
      const items = [];
      for (let i = 0; i < marks.length; i += 1) {
        const start = marks[i].idx;
        const end = i + 1 < marks.length ? marks[i + 1].idx - marks[i + 1].markLen : text.length;
        let seg = text.slice(start, end).trim();
        seg = seg.replace(/[\s/、，;；]+$/, '').trim();
        seg = seg.replace(/^[\s/、，;；]+/, '').trim();
        // Guard: an inline item must be short; a long sentence means this was
        // prose, not a list — bail out so the whole selection stays one task.
        if (!seg || seg.length > 60) return [];
        items.push(seg);
      }
      return items.length >= 2 ? items : [];
    }
    function parseSelectionToTasks(raw) {
      const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n').trim();
      if (!text) return [];
      const lines = text.split('\n');
      const markerCount = lines.filter((l) => LIST_ITEM_RE.test(l)).length;
      // Fallback 1: no per-line list, but the passage has INLINE enumeration such
      // as "- 甲 / - 乙 / - 丙" or "1. 甲、2. 乙、3. 丙" written on one line.
      if (markerCount < 2) {
        const inline = splitInlineList(text);
        if (inline.length >= 2) return inline;
        // Not a list at all → keep the whole selection as a single task verbatim.
        return [text];
      }
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

    // ---- selection → task titles --------------------------------------------
    //
    // Markdown lists are rendered as REAL <ul>/<ol> + <li> elements, and the
    // "-" / "1." marker is NOT part of the text — it is drawn by CSS (::marker).
    // So `selection.toString()` returns the item text WITHOUT any marker, which
    // means the line-based LIST_ITEM_RE below can never recognise a rendered
    // list. Reading the DOM is the only way to tell that the user selected a
    // list; the text parsers stay as the fallback for literal markers typed in
    // plain text or inside a code block.
    function ownListItemText(li) {
      let out = '';
      const walk = (node) => {
        if (node.nodeType === 3) { out += node.nodeValue; return; }
        if (node.nodeType !== 1) return;
        // Skip nested lists so a parent item does not swallow its children.
        if (node !== li && (node.tagName === 'LI' || node.tagName === 'UL' || node.tagName === 'OL')) return;
        for (let i = 0; i < node.childNodes.length; i += 1) walk(node.childNodes[i]);
      };
      walk(li);
      return out.replace(/\s+/g, ' ').trim();
    }
    function selectionDomListItems(sel) {
      let range = null;
      try { range = sel.getRangeAt(0); } catch { return []; }
      let all = [];
      try { all = Array.prototype.slice.call(document.querySelectorAll('li')); } catch { return []; }
      const items = [];
      const seen = new Set();
      for (const li of all) {
        let hit = false;
        try { hit = range.intersectsNode(li); } catch { hit = false; }
        if (!hit) continue;
        const text = ownListItemText(li);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        items.push(text);
      }
      return items.length >= 2 ? items : [];
    }
    // Titles for the current selection: DOM list first, text heuristics after.
    function selectionToTitles(sel, text) {
      const fromDom = selectionDomListItems(sel);
      if (fromDom.length >= 2) return fromDom;
      return parseSelectionToTasks(text);
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
          // Clamp to the CURRENT window: a position saved on a large display would
          // otherwise reopen off-screen on a smaller one, leaving the card
          // unreachable with no way to drag it back.
          const maxX = Math.max(0, (window.innerWidth || 0) - 120);
          const maxY = Math.max(0, (window.innerHeight || 0) - 60);
          return {
            x: Math.min(maxX, Math.max(0, parsed.x)),
            y: Math.min(maxY, Math.max(0, parsed.y)),
          };
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

    // Persisted card width (null = the default `min(560px, 100vw - 40px)`).
    function widthKey() {
      return `${NS}:widget-width`;
    }

    const MIN_CARD_WIDTH = 320;

    function loadCardWidth() {
      try {
        const raw = localStorage.getItem(widthKey());
        if (!raw) return null;
        const n = Number(raw);
        return Number.isFinite(n) && n >= MIN_CARD_WIDTH ? n : null;
      } catch {
        return null;
      }
    }

    function saveCardWidth(width) {
      try {
        localStorage.setItem(widthKey(), String(Math.round(width)));
      } catch {
        /* ignore */
      }
    }

    // ---- projection reader (the one task list) -----------------------------

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

    function useProjectionTasks(ctx, sessionId) {
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

    // `usePanelInfo` exposes the frame's main-panel key: `null` means the
    // ordinary conversation page, any other id means a GLOBAL page (the plugin
    // manager, settings, the marketplace …). The task card belongs to a
    // conversation, so it must hide on those pages instead of floating over
    // them. Read it through one helper so both overlay entries agree, and fall
    // back to "conversation" when the prop is absent (older frame builds) so the
    // card never disappears entirely.
    function useOnConversationPage(usePanelInfo) {
      const select = typeof usePanelInfo === 'function' ? usePanelInfo : null;
      if (!select) return true;
      return select((info) => (info && info.activePanelId !== undefined ? info.activePanelId === null : true));
    }

    function TaskWidget(props) {
      const { ctx, useSessions, usePanelInfo, t } = props;
      const sessionId = useActiveSessionId(useSessions);
      const onConversation = useOnConversationPage(usePanelInfo);

      // All tasks now live in the one host projection (`taskManager`): the model
      // writes via `task_write`, the user writes via the `tasks-sync` command, and
      // both fold into the same list. The `origin` field tells them apart for the
      // badge; there is no separate localStorage list anymore.
      const tasks = useProjectionTasks(ctx, sessionId);

      // A selection bubble elsewhere in the overlay can push text here; send each
      // title to the host as a user task and expand the card so the user sees it
      // land. We read the latest sessionId via a ref so the subscription stays
      // stable.
      const sessionRef = React.useRef(sessionId);
      sessionRef.current = sessionId;
      React.useEffect(() => {
        return taskBus.subscribe((titles) => {
          const sid = sessionRef.current;
          if (!sid) return;
          for (const title of titles) {
            write({ action: 'add', title, origin: 'user' }, sid);
          }
          setOpen(true);
        });
      }, []);

      const [draft, setDraft] = React.useState('');
      const [open, setOpen] = React.useState(false);
      // Task awaiting the user's "really send this?" confirmation.
      const [confirmStart, setConfirmStart] = React.useState(null);
      // Set when the last write could not reach the host. Without this the panel
      // would look like it silently ignored the click: the list is host-owned now,
      // so a failed write means the row simply never appears.
      const [syncError, setSyncError] = React.useState(false);
      // The archive is a SECTION under the list, not a separate view: replacing
      // the whole card made the toggle read as "leave task management" and hid
      // the working list, so the user could not tell where they were. Collapsed
      // by default; opening it appends the filed-away rows below the list, and
      // the list stays visible (and scrollable) above them.
      const [archiveOpen, setArchiveOpen] = React.useState(false);
      // The task being edited inline (`{ id, title, detail }`) plus the draft the
      // user is typing. The card's single add box only ever sets the title; this
      // is where the second line (detail) becomes reachable for user tasks, and
      // where a typo in an existing title gets fixed.
      const [editing, setEditing] = React.useState(null);
      // Deleting from the archive is destructive and irreversible, so it goes
      // through one inline confirmation instead of firing on the first click.
      const [deleteConfirm, setDeleteConfirm] = React.useState(null);

      // Drag-to-move: null = default anchored position (bottom-right). Once the
      // user drags, we pin an absolute {x,y} (top-left of the widget) instead and
      // persist it so the panel stays where they dropped it across remounts.
      const [pos, setPos] = React.useState(() => loadWidgetPos());
      // Card width; null = default. Persisted so a resize survives remounts.
      const [cardWidth, setCardWidth] = React.useState(() => loadCardWidth());

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

      // Width resize: the left edge is the handle. `resizeRef` mirrors dragRef so
      // mousemove does not need a re-render per candidate value.
      const resizeRef = React.useRef(null);

      function beginResize(e) {
        if (e.button !== 0) return;
        // The card lives inside the move-drag wrapper; stop the resize gesture
        // from also being read as a move.
        e.preventDefault();
        e.stopPropagation();
        const card = e.currentTarget.parentElement;
        const rect = card ? card.getBoundingClientRect() : null;
        if (!rect) return;
        resizeRef.current = {
          startX: e.clientX,
          startWidth: rect.width,
          // Hard cap so the card never exceeds the viewport minus the 20px
          // margins on both sides.
          maxWidth: Math.max(MIN_CARD_WIDTH, (window.innerWidth || 0) - 40),
        };
        window.addEventListener('mousemove', onResizeMove);
        window.addEventListener('mouseup', endResize);
      }

      function onResizeMove(e) {
        const r = resizeRef.current;
        if (!r) return;
        // Dragging the left edge leftwards (negative dx) grows the card.
        const next = Math.min(r.maxWidth, Math.max(MIN_CARD_WIDTH, r.startWidth - (e.clientX - r.startX)));
        setCardWidth(Math.round(next));
      }

      function endResize() {
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', endResize);
        resizeRef.current = null;
        setCardWidth((cur) => {
          if (cur) saveCardWidth(cur);
          return cur;
        });
      }

      React.useEffect(() => () => {
        window.removeEventListener('mousemove', onResizeMove);
        window.removeEventListener('mouseup', endResize);
      }, []);

      // ---- host write-back primitives --------------------------------------

      // Wrap a write so a failure is visible in the card instead of silently
      // dropping the user's click. The host list is authoritative, so a failed
      // write leaves the row absent and the user would otherwise think the button
      // is broken.
      function write(payload, target) {
        // `target` exists for the selection-bubble subscription: that effect is
        // mounted once, so it must pass the live session id from its ref instead
        // of the `sessionId` captured by this render.
        const sid = target === undefined ? sessionId : target;
        let pending;
        try {
          pending = syncToHost(ctx, sid, payload);
        } catch (err) {
          // A synchronous throw here (service access, JSON, a broken remote) used
          // to kill the click handler silently — the button looked dead and no
          // error line appeared. Surface it instead.
          if (typeof console !== 'undefined' && console.warn) {
            console.warn('[task-manager] tasks-sync threw', err);
          }
          if (sid) setSyncError(true);
          return Promise.resolve({ ok: false });
        }
        Promise.resolve(pending).then((resp) => {
          if (resp && resp.ok) setSyncError(false);
          else if (sid) setSyncError(true);
        }, () => {
          if (sid) setSyncError(true);
        });
        return pending;
      }

      function addTask() {
        const title = draft.trim();
        if (title.length === 0) return;
        // Add to the list only; never copy into the chat composer. The host
        // `tasks-sync` command applies the add and the projection folds it, so the
        // new row appears from the same source the model reads.
        write({ action: 'add', title, origin: 'user' });
        setDraft('');
      }

      function removeTask(id) {
        write({ action: 'remove', id });
      }

      function setStatus(id, status) {
        write({ action: 'set_status', id, status });
      }

      // Begin editing a row. Status/origin/archive stay untouched: the host
      // `edit` action rewrites only the title and the detail line.
      function beginEdit(task) {
        setEditing({ id: task.id, title: task.title, detail: task.detail || '' });
      }

      function cancelEdit() {
        setEditing(null);
      }

      // Commit the edit. A blank title is refused (the host would reject it too)
      // rather than silently discarding the row; an unchanged draft is a no-op.
      function commitEdit() {
        if (!editing) return;
        const title = editing.title.trim();
        if (title.length === 0) return;
        const detail = editing.detail.trim();
        write({ action: 'edit', id: editing.id, title, detail });
        setEditing(null);
      }

      // "Archive done" files every completed task that is NOT still awaiting the
      // user's completion confirmation out of the active list. It used to DELETE
      // them ("clear done"), which threw away the record of finished work; now a
      // single `archive` write stamps `archivedAt` on the host tasks, so they move
      // to the archive view and survive reload/fork. The host skips pending and
      // unfinished tasks itself, so the payload stays a plain `{}`-ish object.
      function archiveDoneTasks() {
        write({ action: 'archive' });
      }

      function archiveOne(task) {
        write({ action: 'archive', id: task.id });
      }

      function restoreTask(task) {
        write({ action: 'unarchive', id: task.id });
      }

      // Deleting from the archive is the only truly destructive action left, so
      // it asks first (a misclick in the archive used to be unrecoverable).
      function deleteArchived(task) {
        write({ action: 'remove', id: task.id });
      }

      // Ask before sending: the user asked for an explicit confirmation step so a
      // stray click never drops a prompt into the conversation.
      function requestStart(task) {
        if (!sessionId) return;
        setConfirmStart(task);
      }

      function startTask(task) {
        if (!sessionId) return;
        setConfirmStart(null);
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
        // A task that was just handed to the model is by definition in progress;
        // reflect that immediately instead of leaving it sitting in "to do" until
        // the user clicks the status button. Never downgrade an already-done task.
        if (sent && task.status !== 'doing' && task.status !== 'done') {
          setStatus(task.id, 'doing');
        }
        // Collapse the floating card so the conversation is unobstructed.
        if (sent) setOpen(false);
      }

      // Merge: model tasks then user tasks, split only for the origin badge. The
      // host status is authoritative — there is no local overlay anymore. A model
      // task stays `proposedDone` (and therefore shows the confirm affordance)
      // until the user confirms/dismisses it; that answer is itself a `set_status`
      // write (done on confirm, todo on dismiss) which clears `proposedDone`.
      const modelRows = tasks
        .filter((task) => task.origin !== 'user')
        .map((task) => ({
          ...task,
          _source: 'model',
          _pendingConfirm: task.proposedDone === true,
        }));
      const merged = [
        ...modelRows,
        ...tasks
          .filter((task) => task.origin === 'user')
          .map((task) => ({ ...task, _source: 'user', _pendingConfirm: false })),
      ];
      // Archived tasks stay in the same host list (nothing is deleted) but are
      // not part of the working set: they are excluded from the list, the counts
      // and the pill badge, and are shown in their own view instead. Sorted
      // newest-archived first so the view reads like a log.
      const archivedRows = merged
        .filter((task) => typeof task.archivedAt === 'string' && task.archivedAt.length > 0)
        .sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
      const activeRows = merged.filter((task) => !(typeof task.archivedAt === 'string' && task.archivedAt.length > 0));

      // Tasks the model proposed as done that the user has not yet confirmed.
      const pendingConfirms = activeRows.filter((task) => task._pendingConfirm);

      // Count done only for confirmed/completed tasks; pending ones are surfaced
      // in the confirm banner rather than counted as finished.
      const counts = { todo: 0, doing: 0, done: 0 };
      for (const task of activeRows) {
        if (task._pendingConfirm) continue;
        if (counts[task.status] != null) counts[task.status] += 1;
      }
      const pendingCount = pendingConfirms.length;

      const activeCount = counts.todo + counts.doing;
      const styles = makeStyles({ width: cardWidth });

      function confirmAll() {
        for (const task of pendingConfirms) setStatus(task.id, 'done');
      }
      function dismissAll() {
        for (const task of pendingConfirms) setStatus(task.id, 'todo');
      }

      // Advance a task's status. Both origins now live in the host projection, so
      // every change is a `set_status` write; "done" on a model task that had a
      // pending completion proposal also clears `proposedDone` (the host drops it
      // on any `set_status`). The row's single status control always shows TEXT
      // ("mark in progress" / "complete" / "reopen") so the state never has to be
      // guessed from a colour, and a done task offers "reopen" instead of a second
      // "complete" that would do nothing.
      function statusButton(task) {
        if (task.status === 'done') {
          return h('button', {
            style: styles.btn, title: t('reopen'), 'aria-label': t('reopen'),
            onClick: () => setStatus(task.id, 'todo'),
          }, t('reopen'));
        }
        if (task.status === 'doing') {
          return h('button', {
            style: styles.btn, title: t('markDone'), 'aria-label': t('markDone'),
            onClick: () => setStatus(task.id, 'done'),
          }, `✓ ${t('complete')}`);
        }
        return h('button', {
          style: styles.btn, title: t('markDoing'), 'aria-label': t('markDoing'),
          onClick: () => setStatus(task.id, 'doing'),
        }, t('markDoing'));
      }

      // Visible state chip: text, not colour, is the primary signal.
      function statusChip(task) {
        const label = task.status === 'done' ? t('stDone') : task.status === 'doing' ? t('stDoing') : t('stTodo');
        return h('span', {
          style: { ...styles.statusChip, color: STATUS_COLOR[task.status] || STATUS_COLOR.todo },
          title: label,
        }, label);
      }

      // Inline editor for one row: a title input, a detail input (the second,
      // smaller line) and save/cancel. Enter saves, Escape cancels; Enter in the
      // title moves on to the detail instead of saving, so the common "fix the
      // title, add a note" pass does not need the mouse. IME composition is
      // ignored for the same reason as the add box: the Enter that commits a
      // Chinese candidate must not fire the action.
      function editor(task) {
        const commit = () => commitEdit();
        const bump = (key) => (e) => setEditing((cur) => (cur ? { ...cur, [key]: e.target.value } : cur));
        const guardEnter = (action) => (e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            cancelEdit();
            return;
          }
          if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
          e.preventDefault();
          action(e);
        };
        return h('span', { style: styles.editBox, 'data-tm-editor': task.id },
          h('input', {
            style: styles.editInput,
            value: editing.title,
            autoFocus: true,
            placeholder: t('editTitlePlaceholder'),
            onChange: bump('title'),
            onKeyDown: guardEnter((e) => {
              // Enter in the title continues to the detail line instead of saving.
              const next = e.target.parentElement && e.target.parentElement.querySelector('[data-tm-edit-detail]');
              if (next) next.focus();
              else commit();
            }),
          }),
          h('input', {
            style: styles.editInputDetail,
            value: editing.detail,
            placeholder: t('editDetailPlaceholder'),
            'data-tm-edit-detail': '1',
            onChange: bump('detail'),
            onKeyDown: guardEnter(commit),
          }),
          h('span', { style: styles.editActions },
            h('button', {
              style: styles.primaryBtn,
              onClick: commit,
              disabled: editing.title.trim().length === 0,
              title: t('save'),
            }, t('save')),
            h('button', { style: styles.btn, onClick: cancelEdit, title: t('cancel') }, t('cancel')),
          ),
        );
      }

      // One row = TWO lines: line 1 carries the small badges + the action
      // buttons, line 2 carries the task text. The old layout put every chip and
      // every button on the same flex line as the title, so at a 400px card the
      // title was squeezed into a ~60px column and broke one character per line
      // (a Chinese task became a vertical ribbon). Stacking gives the title the
      // full card width; the buttons only cost the header line, which is short by
      // nature.
      const rows = activeRows.map((task) => {
        const isUser = task._source === 'user';
        const pending = task._pendingConfirm;
        const labelStyle = {
          ...styles.label,
          ...(task.status === 'done' && !pending ? styles.doneLabel : {}),
        };
        return h('li', { key: `${task._source}:${task.id}`, style: styles.row },
          h('div', { style: styles.rowHead },
            h('span', { style: { ...styles.dot, background: STATUS_COLOR[task.status] || STATUS_COLOR.todo } }),
            h('span', { style: styles.badge, title: isUser ? t('originUser') : t('originModel') },
              isUser ? t('fromUser') : t('fromModel')),
            statusChip(task),
            pending
              ? h('span', { style: styles.pendingBadge, title: t('proposed') }, t('proposed'))
              : null,
            // Pushes the buttons to the right edge of the head line.
            h('span', { style: styles.rowSpacer }),
            pending
              ? h('button', {
                  style: styles.primaryBtn, title: t('confirm'), onClick: () => setStatus(task.id, 'done'),
                }, t('confirm'))
              : null,
            statusButton(task),
            // "Start" only makes sense while the task is still to-do/in progress;
            // a done task has nothing left to send.
            task.status === 'done'
              ? null
              : h('button', { style: styles.btn, onClick: () => requestStart(task), title: t('start') }, t('start')),
            // Editing is offered for BOTH sources: the add box only ever set a
            // title, so this is the only way a user task gets a detail line, and
            // it is also how a model-written title gets a typo fixed.
            editing && editing.id === task.id
              ? null
              : h('button', {
                  style: styles.btn,
                  onClick: () => beginEdit(task),
                  title: t('edit'),
                  'aria-label': t('edit'),
                  'data-tm-edit': task.id,
                }, '✎'),
            h('button', {
              style: styles.btn,
              onClick: () => removeTask(task.id),
              title: isUser ? t('remove') : t('removeModel'),
            }, '✕'),
          ),
          editing && editing.id === task.id
            ? editor(task)
            : h('span', {
                style: labelStyle,
                title: task.detail ? `${task.title} — ${task.detail}` : task.title,
              },
                h('span', { style: styles.labelTitle }, task.title),
                task.detail
                  ? h('span', { style: styles.labelDetail }, task.detail)
                  : null,
              ),
        );
      });

      // Archived rows: same two-line shape as the active rows, but the only
      // actions left are restore and a confirmed delete. No status buttons and no
      // "start" — a filed-away task is not part of the current work.
      const archiveRows = archivedRows.map((task) => {
        const isUser = task._source === 'user';
        const stamp = formatArchivedAt(task.archivedAt);
        return h('li', { key: `archived:${task.id}`, style: styles.row, 'data-tm-archived': '1' },
          h('div', { style: styles.rowHead },
            h('span', { style: { ...styles.dot, background: STATUS_COLOR.done } }),
            h('span', { style: styles.badge, title: isUser ? t('originUser') : t('originModel') },
              isUser ? t('fromUser') : t('fromModel')),
            stamp ? h('span', { style: styles.archiveStamp }, stamp) : null,
            h('span', { style: styles.rowSpacer }),
            h('button', {
              style: styles.btn, title: t('restore'),
              onClick: () => restoreTask(task),
            }, t('restore')),
            h('button', {
              style: styles.btn, title: t('deleteForever'),
              onClick: () => setDeleteConfirm(task),
            }, '✕'),
          ),
          h('span', { style: { ...styles.label, ...styles.doneLabel }, title: task.title },
            h('span', { style: styles.labelTitle }, task.title),
            task.detail ? h('span', { style: styles.labelDetail }, task.detail) : null,
          ),
        );
      });

      const countsText =
        `${fill(t('countPending'), { n: counts.todo })} · ` +
        `${fill(t('countDoing'), { n: counts.doing })} · ` +
        `${fill(t('countDone'), { n: counts.done })}`;

      // Wrap style: when dragged, pin to absolute x/y (top-left); otherwise keep
      // the default bottom-right anchor.
      // A remembered x is clamped to the CURRENT viewport: a position saved on a
      // wide screen (or a card dragged to the right edge) would otherwise put the
      // card's right half off-screen in a narrow window, and the card is
      // `position: fixed` so nothing scrolls it back.
      const maxLeft = Math.max(0, (window.innerWidth || 0) - 24);
      const clampedX = pos ? Math.max(0, Math.min(pos.x, maxLeft)) : 0;
      const wrapStyle = pos
        ? { ...styles.wrap, left: `${clampedX}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto' }
        : styles.wrap;

      // A global page (plugin manager, settings, marketplace …) is not a
      // conversation: hide the card entirely there. Placed after every hook so
      // hook order stays stable across the two page kinds.
      if (!onConversation) return null;

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
          // Left-edge resize handle (grab it and drag left/right).
          h('div', {
            style: styles.resizeHandle,
            onMouseDown: beginResize,
            title: t('resizeHint'),
            'aria-label': t('resizeHint'),
            role: 'separator',
            'data-tm-resize': '1',
          }),
          h('div', { style: styles.header, onMouseDown: beginDrag, title: t('dragHint') },
            h('span', { style: styles.headerIcon }, h(TaskGlyph, { size: 15 })),
            h('span', { style: styles.title }, t('title')),
            h('span', { style: styles.counts }, countsText),
            // Pushes the archive controls to the right edge; absorbs the shrink
            // when the card is narrow so the buttons stay on one line.
            h('span', { style: styles.headerSpacer }),
            // Archive toggle: always visible (with its count) so the archive is
            // discoverable even when it is empty. It is a disclosure control now,
            // not a navigation one — the caret says "this expands".
            h('button', {
              style: archiveOpen ? styles.activeBtn : styles.btn,
              onClick: () => setArchiveOpen((cur) => !cur),
              title: archiveOpen ? t('collapseArchive') : t('expandArchive'),
              'aria-expanded': archiveOpen ? 'true' : 'false',
              'data-tm-archive': '1',
            },
              `${archiveOpen ? '▾' : '▸'} ${t('showArchive')} (${archivedRows.length})`),
            counts.done > 0
              ? h('button', { style: styles.btn, onClick: archiveDoneTasks, title: t('archiveHint'), 'data-tm-archive-done': '1' }, t('archiveDone'))
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
                confirmStart
                  ? h('div', { style: styles.startBar },
                      h('span', { style: styles.confirmText },
                        `${t('startConfirm')} “${confirmStart.title}”`),
                      h('button', {
                        style: styles.primaryBtn,
                        onClick: () => startTask(confirmStart),
                        title: t('sendNow'),
                      }, t('sendNow')),
                      h('button', {
                        style: styles.btn,
                        onClick: () => setConfirmStart(null),
                        title: t('cancel'),
                      }, t('cancel')),
                    )
                  : null,
                pendingCount > 0
                  ? h('div', { style: styles.confirmBar },
                      h('span', { style: styles.confirmText },
                        fill(t('confirmBanner'), { n: pendingCount })),
                      h('button', { style: styles.primaryBtn, onClick: confirmAll }, t('confirmAll')),
                      h('button', { style: styles.btn, onClick: dismissAll }, t('dismiss')),
                    )
                  : null,
                syncError
                  ? h('div', { style: styles.syncBar },
                      h('span', { style: styles.confirmText }, t('syncFailed')),
                      h('button', {
                        style: styles.btn,
                        onClick: () => setSyncError(false),
                        title: t('syncDismiss'),
                      }, t('syncDismiss')),
                    )
                  : null,
                deleteConfirm
                  ? h('div', { style: styles.confirmBar },
                      h('span', { style: styles.confirmText },
                        `${t('deleteForever')} “${deleteConfirm.title}”?`),
                      h('button', {
                        style: styles.dangerBtn,
                        onClick: () => { deleteArchived(deleteConfirm); setDeleteConfirm(null); },
                      }, t('deleteForever')),
                      h('button', {
                        style: styles.btn,
                        onClick: () => setDeleteConfirm(null),
                      }, t('cancel')),
                    )
                  : null,
                // The working list is ALWAYS rendered: opening the archive adds a
                // section below it instead of swapping the card's contents, so the
                // user never loses sight of where they are or of the todo list.
                activeRows.length === 0
                  ? h('div', { style: styles.empty },
                      // An empty list means one of three different things; saying
                      // "no tasks yet" while the header shows "Archive (1)" is
                      // contradictory, so point at the archive instead.
                      merged.length === 0
                        ? t('emptyAll')
                        : archivedRows.length > 0
                          ? fill(t('emptyAllArchived'), { n: archivedRows.length })
                          : t('empty'))
                  : h('ul', { style: styles.list }, rows),
                archiveOpen
                  ? h('div', { style: styles.archiveSection, 'data-tm-archive-section': '1' },
                      h('div', { style: styles.archiveHead },
                        h('span', { style: styles.archiveHeadTitle },
                          `${t('archiveSectionTitle')} · ${archivedRows.length}`),
                        h('span', { style: styles.headerSpacer }),
                        h('button', {
                          style: styles.btn,
                          onClick: () => setArchiveOpen(false),
                          title: t('collapseArchive'),
                          'data-tm-archive-collapse': '1',
                        }, `▴ ${t('collapseArchive')}`),
                      ),
                      archivedRows.length === 0
                        ? h('div', { style: styles.empty }, t('archiveEmpty'))
                        : h('ul', { style: styles.list, 'data-tm-archive-list': '1' }, archiveRows),
                    )
                  : null,
                h('div', { style: styles.addRow },
                  h('input', {
                    style: styles.input,
                    value: draft,
                    placeholder: t('addPlaceholder'),
                    onChange: (e) => setDraft(e.target.value),
                    onKeyDown: (e) => {
                      // Ignore Enter while an IME is composing: with Chinese
                      // input, the Enter that commits a candidate would otherwise
                      // add the half-typed pinyin as a task. keyCode 229 is the
                      // legacy signal browsers still emit mid-composition.
                      if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
                      e.preventDefault();
                      addTask();
                    },
                  }),
                  h('button', { style: styles.primaryBtn, onClick: addTask }, t('add')),
                ),
              ),
          ),
        ),
      );
    }

    function makeStyles(opts) {
      // Live width of the expanded card (null = default). Passed in rather than
      // read from a closure so the sheet stays a pure function of the props.
      const cardWidth = opts && typeof opts.width === 'number' ? opts.width : null;
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
        danger: 'var(--dsw-alias-state-error-primary)',
        onAccent: 'var(--dsw-alias-bg-base)',
      };
      return {
        // Fixed overlay pinned bottom-right, above the conversation. The
        // shell.overlay layer is click-through, so this wrapper opts back in.
        wrap: {
          position: 'fixed',
          right: '20px',
          bottom: '88px',
          // Anchor BOTH sides. A `position: fixed` wrapper is content-sized, so a
          // card wider than the viewport pushed the wrapper itself past the right
          // edge and half the card went off-screen (no scroll can reach it). With
          // the left edge also pinned, the wrapper's width is `100vw - 40px` and
          // the card can only ever shrink to fit.
          left: '20px',
          maxWidth: 'calc(100vw - 40px)',
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
        // "Really send this task?" bar — accent-tinted so it reads as an
        // affirmative prompt rather than another status banner.
        startBar: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
          padding: '7px 9px',
          borderRadius: '8px',
          border: `1px solid ${C.accent}`,
          background: C.surface2,
          backgroundColor: 'color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)',
        },
        // Write failed: the host list is authoritative, so the edit was lost.
        // Error-tinted bar so it is never mistaken for a normal status banner.
        syncBar: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          flexWrap: 'wrap',
          padding: '7px 9px',
          borderRadius: '8px',
          border: `1px solid ${C.danger}`,
          background: C.surface2,
          backgroundColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)',
        },
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
          // Expanded card width. The task text lives on its own line now, but a
          // 400px card still felt cramped for Chinese task text, so the default is
          // wider (still capped by the viewport) and the user can drag the left
          // edge to resize — see `cardWidth` / `beginResize`.
          // `width` is clamped again at render time: a width saved on a wide
          // screen would otherwise overflow a narrow window, and the inline
          // editor's full-width inputs made that overflow obvious.
          // `width` only sets the PREFERRED width: the wrapper is pinned on both
          // sides, so the card is still clipped to the window on narrow screens.
          width: cardWidth ? `${cardWidth}px` : 'min(560px, 100%)',
          maxWidth: 'calc(100vw - 40px)',
          maxHeight: 'min(60vh, 520px)',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
          borderRadius: '12px',
          border: `1px solid ${C.border}`,
          background: C.overlay,
          boxShadow: '0 12px 32px rgba(0,0,0,0.36)',
          overflow: 'hidden',
        },
        // Grab strip on the card's left edge. The card is anchored bottom-right,
        // so dragging this edge left grows it without moving the corner the user
        // already positioned.
        resizeHandle: {
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: '6px',
          cursor: 'ew-resize',
          zIndex: 1,
        },
        header: {
          display: 'flex',
          alignItems: 'center',
          // `minWidth: 0` + no-wrap buttons: a long title/count line ellipsises
          // rather than growing the card past the viewport.
          minWidth: '0px',
          flexWrap: 'nowrap',
          gap: '8px',
          padding: '10px 12px',
          borderBottom: `1px solid ${C.border}`,
          cursor: 'move',
          userSelect: 'none',
        },
        headerIcon: { display: 'inline-flex', color: C.accent, flex: '0 0 auto' },
        // Absorbs the shrink on a narrow card so the right-hand controls never
        // wrap and the ✕ stays flush with the card's right edge.
        headerSpacer: { flex: '1 1 auto', minWidth: '0px', height: '1px' },
        title: { fontWeight: 600, fontSize: '14px', color: C.text, flex: '0 0 auto' },
        counts: { color: C.text2, fontSize: '11px', minWidth: '0px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
        // Archive section under the list: a hairline above, its own scroll area
        // so a long history never pushes the working list off the card.
        archiveSection: {
          marginTop: '6px',
          paddingTop: '6px',
          borderTop: `1px dashed ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          minHeight: '0px',
          maxHeight: '40vh',
          overflow: 'auto',
        },
        archiveHead: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0px', flexWrap: 'nowrap' },
        archiveHeadTitle: { color: C.text2, fontSize: '11px', fontWeight: 600, flex: '0 0 auto' },
        archiveHintText: { color: C.text2, fontSize: '11px' },
        archiveStamp: { color: C.text2, fontSize: '11px', whiteSpace: 'nowrap' },
        // A count appended to the button label. Kept as plain dimmed text: a
        // bordered pill inside a bordered button reads like a nested button.
        // Header button in its pressed/active state (the archive toggle while the
        // archive view is open).
        activeBtn: {
          padding: '2px 8px', borderRadius: '6px', fontSize: '11px', lineHeight: '18px',
          border: `1px solid ${C.border}`, background: C.surface2, color: C.text,
          cursor: 'pointer', whiteSpace: 'nowrap', fontWeight: 600,
        },
        dangerBtn: {
          padding: '2px 8px', borderRadius: '6px', fontSize: '11px', lineHeight: '18px',
          border: '1px solid transparent', cursor: 'pointer', whiteSpace: 'nowrap',
          // `danger` is the token already in C; its text comes from `onAccent`
          // (the inverse neutral) rather than #fff, so it stays readable in both
          // themes — see the note on `accent` in makeStyles.
          background: C.danger, color: C.onAccent,
        },
        bodyInner: { display: 'flex', flexDirection: 'column', gap: '8px' },
        list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '6px' },
        // Two-line row: head (dot + badges + buttons) above the task text.
        row: {
          display: 'flex', flexDirection: 'column', gap: '4px',
          padding: '6px 9px 7px', borderRadius: '8px',
          border: `1px solid ${C.border}`,
          background: C.surface2,
        },
        rowHead: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 },
        rowSpacer: { flex: '1 1 auto', minWidth: 0, height: '1px' },
        dot: { width: '9px', height: '9px', borderRadius: '50%', flex: '0 0 auto' },
        // Text state chip: colour reinforces, but the WORD carries the state.
        statusChip: {
          flex: '0 0 auto',
          fontSize: '10px',
          lineHeight: '15px',
          fontWeight: 600,
          whiteSpace: 'nowrap',
        },
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
        // The task text spans the whole row width; wrapping is normal, breaking
        // mid-token is only the last resort.
        label: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0, color: C.text },
        labelTitle: { overflowWrap: 'anywhere', wordBreak: 'break-word', whiteSpace: 'normal', lineHeight: '18px', fontSize: '13px' },
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
        // Inline row editor: the title and detail inputs stack (same two-line
        // rhythm as the read view) and the buttons sit at the end of the second
        // line, so a narrow card still gets a usable input width.
        editBox: { display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '2px' },
        editInput: {
          width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px',
          color: C.text, background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: '6px', outline: 'none',
        },
        editInputDetail: {
          width: '100%', boxSizing: 'border-box', padding: '3px 6px', fontSize: '11px',
          color: C.text2, background: C.surface, border: `1px solid ${C.border}`,
          borderRadius: '6px', outline: 'none',
        },
        editActions: { display: 'flex', gap: '6px', justifyContent: 'flex-end' },
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
      const { t, usePanelInfo } = props;
      const onConversation = useOnConversationPage(usePanelInfo);
      const [state, setState] = React.useState({ visible: false, x: 0, y: 0, text: '', titles: [] });

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
          if (!text || text.length > 800) {
            // Too long (or empty): HIDE, do not just bail out. A bare `return`
            // left a previously shown bubble floating over an old position, so
            // clicking it would add the OLD text instead of the current selection.
            setState((s) => (s.visible ? { ...s, visible: false } : s));
            return;
          }
          if (insideOwnUi(sel.anchorNode) || insideOwnUi(sel.focusNode)) {
            setState((s) => (s.visible ? { ...s, visible: false } : s));
            return;
          }
          let rect = null;
          try { rect = sel.getRangeAt(0).getBoundingClientRect(); } catch { rect = null; }
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            // No usable geometry: hide for the same reason as above.
            setState((s) => (s.visible ? { ...s, visible: false } : s));
            return;
          }
          // Anchor to the SELECTION itself, not to the app's native pill.
          // The native pill (引用文本 / 添加到对话 / 旁问) floats near the top-left
          // of the selection; putting our button at the selection's bottom-right
          // keeps the two clusters apart instead of overlapping them. We never
          // read the native surface's rect: while it is hidden its rect is zero
          // or stale, which previously parked our button underneath it.
          const MARGIN = 8;
          const bubbleW = 130;
          const bubbleH = 30;
          let x = Math.min(window.innerWidth - bubbleW - MARGIN, rect.right + MARGIN);
          let y = rect.bottom + MARGIN;
          // No room below → flip above the selection's first line.
          if (y + bubbleH > window.innerHeight - MARGIN) {
            y = Math.max(MARGIN, rect.top - bubbleH - MARGIN);
          }
          x = Math.max(MARGIN, x);
          y = Math.max(MARGIN, y);
          // Resolve the titles ONCE here, while we still hold the live selection
          // (and its DOM), and carry them in state. Recomputing later from the
          // plain text alone would lose rendered <li> structure.
          const titles = selectionToTitles(sel, text);
          setState({ visible: true, x, y, text, titles });
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
        const titles = state.titles && state.titles.length ? state.titles : parseSelectionToTasks(state.text);
        if (titles.length) taskBus.emit(titles);
        setState((s) => ({ ...s, visible: false }));
        try { window.getSelection().removeAllRanges(); } catch { /* ignore */ }
      }

      if (!state.visible || !onConversation) return null;
      const titles = state.titles && state.titles.length ? state.titles : parseSelectionToTasks(state.text);
      const count = titles.length;
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
        title: label,
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
      // `remote` + `remote.commands` are declared because cordis gates service
      // PROPERTY access on the fiber's inject declaration: reading `ctx.remote`
      // while undeclared throws synchronously, which made every card button look
      // dead (the click handler died before any write). Declaring them is also
      // what dsh-btw does for the same `commands.execute` call. `syncToHost` still
      // guards the lookup so a profile without the remote degrades to a visible
      // "could not reach the host" line instead of losing the panel.
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
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

        // The `tasks-sync` command is a UI→Host transport, not something the user
        // typed: its `command/done` text carries the `TASK_STATE::` marker line.
        // The chat stream renders every command node with that text as its summary
        // (`GenericCommandCard`), which would dump raw JSON into the conversation.
        // Registering a `null` renderer for this one command name keeps the
        // lifecycle in the log (needed for projection replay) but out of the UI.
        // Waiting for the slot to appear (instead of registering eagerly) mirrors
        // how other bundles hook a slot owned by the chat package.
        ctx.slots.inject('conversation.chat.commandview', () => {
          let dispose = null;
          try {
            dispose = ctx.slots.register({
              name: 'conversation.chat.commandview',
              key: SYNC_COMMAND,
            }, () => null);
          } catch {
            dispose = null;
          }
          return () => {
            if (dispose) { try { dispose(); } catch {} dispose = null; }
          };
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


