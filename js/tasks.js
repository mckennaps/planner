// Tasks: list panel, editor, completing (incl. repeating tasks), reminders via Google Calendar.
import { h, ymd, hm, todayStr, parseYmd, addDays, atTime, addMinutes, isoLocal, TZ, relDay, fmtTime, durationLabel, uid, readableText, startOfDay } from './util.js';
import { openSheet, confirmDialog, toast, showError, icon } from './ui.js';
import { repeatPicker, describe, nextDate } from './recurrence.js';
import { evStart, cleanCopy } from './events.js';
import { tasksViaNtfy } from './notify.js';

export const PRIORITIES = [
  { v: 0, label: 'None' }, { v: 1, label: 'Low' }, { v: 2, label: 'Medium' }, { v: 3, label: 'High' },
];
const REMINDER_OPTS = [
  [null, 'No notification'], [0, 'At the due time'], [5, '5 minutes before'], [10, '10 minutes before'],
  [15, '15 minutes before'], [30, '30 minutes before'], [60, '1 hour before'], [120, '2 hours before'],
  [1440, '1 day before'],
];
const ESTIMATES = [null, 15, 30, 45, 60, 90, 120, 180, 240];

export function newTask(app, extra = {}) {
  return {
    id: null, title: '', notes: '', calendarId: app.lastCalendarId(), due: null, dueTime: null,
    priority: 0, subtasks: [], repeat: '', repeatAnchor: null, reminder: null, estimate: null,
    reminderEventId: null, done: false, doneAt: null, ...extra,
  };
}

// ---------- reminders: a small event in a "Task reminders" calendar so Google notifies your phone ----------
export async function syncTaskReminder(app, task) {
  const B = app.backend;
  const want = task && !task.deleted && !task.done && task.due && task.dueTime && task.reminder != null && !tasksViaNtfy(app);
  try {
    const calId = await app.reminderCalendar(!!want);
    if (!want) {
      if (task && task.reminderEventId && calId) await B.deleteEvent(calId, task.reminderEventId);
      if (task && task.reminderEventId && !task.deleted) { task.reminderEventId = null; app.data.putTask(task); }
      return;
    }
    const st = atTime(task.due, task.dueTime);
    const ev = {
      summary: '☐ ' + task.title,
      description: 'Task reminder from your planner. Open the planner to check it off.',
      start: { dateTime: isoLocal(st), timeZone: TZ },
      end: { dateTime: isoLocal(addMinutes(st, 15)), timeZone: TZ },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: task.reminder }] },
      transparency: 'transparent',
      extendedProperties: { private: { plannerTaskId: task.id } },
    };
    if (task.reminderEventId) {
      try { await B.patchEvent(calId, task.reminderEventId, ev); return; }
      catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    const made = await B.insertEvent(calId, ev);
    task.reminderEventId = made.id;
    app.data.putTask(task);
  } catch (e) {
    showError(e, 'Could not set the task notification');
  }
}

// ---------- time blocks ----------
// A time block is a calendar event linked to a task. Rules, shown to you in the app:
//   - when you finish a task, blocks that already started stay on your calendar (a record of the time you put in)
//     and are marked done; blocks still in the future are removed so your calendar frees up.
//   - for a repeating task, only upcoming blocks before its next due date are removed.
//   - deleting a task works the same way.
export async function createBlock(app, task, start, end, { quiet = false } = {}) {
  const calId = app.writableCalendars().some((c) => c.id === task.calendarId) ? task.calendarId : app.lastCalendarId();
  try {
    await app.backend.insertEvent(calId, {
      summary: task.title,
      start: { dateTime: isoLocal(start), timeZone: TZ },
      end: { dateTime: isoLocal(end), timeZone: TZ },
      reminders: { useDefault: true },
      extendedProperties: { private: { plannerTaskId: task.id } },
    });
    app.refetch();
    if (!quiet) toast(`Scheduled for ${relDay(ymd(start))}, ${fmtTime(start)}`);
    return true;
  } catch (e) { showError(e, 'Could not schedule the task'); return false; }
}

async function findBlocks(app, taskId, from) {
  const lists = await Promise.all(app.writableCalendars().map((c) =>
    app.backend.findTaskBlocks(c.id, taskId, from).then((evs) => evs.map((ev) => ({ calId: c.id, ev }))).catch(() => [])));
  return lists.flat();
}
export async function clearUpcomingBlocks(app, task, { before } = {}) {
  const now = new Date();
  try {
    const blocks = (await findBlocks(app, task.id, now))
      .filter((b) => evStart(b.ev) > now && !b.ev.recurringEventId && (!before || evStart(b.ev) < before));
    for (const b of blocks) await app.backend.deleteEvent(b.calId, b.ev.id);
    if (blocks.length) app.refetch();
    return blocks;
  } catch (e) { console.warn('Could not tidy time blocks', e); return []; }
}
async function restoreBlocks(app, blocks) {
  for (const b of blocks) await app.backend.insertEvent(b.calId, cleanCopy(b.ev));
  if (blocks.length) app.refetch();
}
const blocksNote = (n) => (n ? ` · removed ${n} upcoming time block${n > 1 ? 's' : ''}` : '');

// ---------- completing ----------
export async function toggleDone(app, task) {
  const prev = structuredClone(task);
  let removed = [];
  const undo = async () => {
    app.data.putTask(prev);
    syncTaskReminder(app, prev);
    try { await restoreBlocks(app, removed); } catch (e) { showError(e, 'Could not restore time blocks'); }
  };
  if (!task.done && task.repeat && task.due) {
    const yesterday = ymd(addDays(new Date(), -1));
    const after = task.due > yesterday ? task.due : yesterday;
    const next = nextDate(task.repeat, task.repeatAnchor || task.due, after);
    logDone(app, task);
    if (next) {
      task.due = next;
      task.subtasks = (task.subtasks || []).map((s) => ({ ...s, done: false }));
      app.data.putTask(task);
      syncTaskReminder(app, task);
      removed = await clearUpcomingBlocks(app, prev, { before: parseYmd(next) });
      toast(`Done. Next: ${relDay(next)}${blocksNote(removed.length)}`, { action: 'Undo', onAction: undo, timeout: 6000 });
      return;
    }
  }
  task.done = !task.done;
  task.doneAt = task.done ? Date.now() : null;
  if (task.done) logDone(app, task);
  app.data.putTask(task);
  syncTaskReminder(app, task);
  if (task.done) {
    removed = await clearUpcomingBlocks(app, task);
    toast(`Task completed${blocksNote(removed.length)}`, { action: 'Undo', onAction: undo, timeout: 6000 });
  } else app.refetch();
}
// A history of completions; the rewards system will read this later.
function logDone(app, task) {
  app.data.put('logs', { kind: 'task-done', taskId: task.id, title: task.title, calendarId: task.calendarId, at: Date.now(), due: task.due });
}

// ---------- task editor ----------
export function openTaskEditor(app, taskOrId, extra = {}) {
  const orig = typeof taskOrId === 'string' ? app.data.task(taskOrId) : taskOrId;
  if (!orig) return;
  const isNew = !orig.id;
  const t = structuredClone(orig);

  const title = h('input.input.title-input#tk-title', { type: 'text', placeholder: 'Task name', value: t.title, autofocus: isNew, 'aria-label': 'Task name' });
  const notes = h('textarea.input#tk-notes', { rows: '2', placeholder: 'Add notes', 'aria-label': 'Notes' });
  notes.value = t.notes || '';
  const due = h('input.input#tk-due', { type: 'date', value: t.due || '', 'aria-label': 'Due date' });
  const time = h('input.input#tk-time', { type: 'time', value: t.dueTime || '', step: '300', 'aria-label': 'Due time' });
  const repeat = repeatPicker(() => (due.value ? parseYmd(due.value) : new Date()), t.repeat || '', { allDay: () => true });
  repeat.el.id = 'tk-repeat';
  const rem = h('select.input#tk-rem', { 'aria-label': 'Notification' },
    REMINDER_OPTS.map(([v, l]) => h('option', { value: v == null ? '' : String(v), selected: (t.reminder ?? null) === v }, l)));
  const remHint = h('p.hint', 'Add a due time to get a notification.');
  const cats = app.writableCalendars();
  const cat = h('select.input#tk-cat', { 'aria-label': 'Category' }, cats.map((c) => h('option', { value: c.id, selected: c.id === t.calendarId }, c.name)));
  const catDot = h('span.cat-dot');
  const paintDot = () => { const c = app.calendar(cat.value); catDot.style.background = c ? c.color : '#999'; };
  cat.addEventListener('change', paintDot);
  paintDot();

  let priority = t.priority || 0;
  const prio = h('div.segmented', { role: 'radiogroup', 'aria-label': 'Priority' });
  const paintPrio = () => prio.replaceChildren(...PRIORITIES.map((p) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(priority === p.v), class: 'prio-' + p.v, onclick: () => { priority = p.v; paintPrio(); } }, p.label)));
  paintPrio();

  const est = h('select.input#tk-est', { 'aria-label': 'Time needed' },
    ESTIMATES.map((m) => h('option', { value: m == null ? '' : String(m), selected: (t.estimate ?? null) === m }, m == null ? 'Not set' : durationLabel(m))));

  // subtasks
  const subs = (t.subtasks || []).map((s) => ({ ...s }));
  const subList = h('div.subtasks');
  const renderSubs = () => {
    subList.replaceChildren(...subs.map((s, i) => {
      const box = h('input', { type: 'checkbox', checked: s.done, 'aria-label': 'Done', onchange: (e) => { s.done = e.target.checked; } });
      const inp = h('input.input.bare', { type: 'text', value: s.title, 'aria-label': 'Subtask', oninput: (e) => { s.title = e.target.value; } });
      return h('div.sub-row', box, inp, h('button.icon-btn', { type: 'button', 'aria-label': 'Remove subtask', onclick: () => { subs.splice(i, 1); renderSubs(); } }, icon('x', 16)));
    }));
  };
  renderSubs();
  const subAdd = h('input.input.bare#tk-subadd', { type: 'text', placeholder: '+ Add a subtask', 'aria-label': 'Add a subtask' });
  subAdd.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && subAdd.value.trim()) {
      e.preventDefault();
      subs.push({ id: uid(), title: subAdd.value.trim(), done: false });
      subAdd.value = '';
      renderSubs();
    }
  });

  // time blocks already on the calendar for this task
  const blocks = isNew ? [] : app.blocksForTask(t.id);
  const nowD = new Date();
  const blockList = h('div.stack-sm', blocks.length
    ? blocks.map((b) => {
      const past = b.start < nowD;
      return h('button.block-chip' + (past ? '.past' : ''), { type: 'button', style: { '--c': b.backgroundColor }, onclick: () => { s.close(); app.openEventById(b.id); } },
        h('span.block-dot'), `${relDay(ymd(b.start))}, ${fmtTime(b.start)} – ${fmtTime(b.end || addMinutes(b.start, 60))}`,
        past ? h('span.block-tag', 'done') : '');
    })
    : h('p.hint', 'Nothing scheduled yet.'));
  const blockRule = h('p.hint', 'When you check this task off, past blocks stay on your calendar as a record and upcoming ones are removed.');

  const sync = () => {
    const hasDate = !!due.value, hasTime = !!time.value;
    time.disabled = !hasDate;
    repeat.el.disabled = !hasDate;
    rem.disabled = !hasTime;
    remHint.hidden = hasTime;
    repeat.refresh();
  };
  due.addEventListener('change', () => { if (!due.value) time.value = ''; sync(); });
  time.addEventListener('change', () => { if (time.value && rem.value === '' && t.reminder == null) rem.value = '15'; sync(); });
  sync();

  const read = () => {
    t.title = title.value.trim();
    t.notes = notes.value;
    t.due = due.value || null;
    t.dueTime = t.due && time.value ? time.value : null;
    const newRule = t.due ? repeat.value : '';
    if (newRule !== (orig.repeat || '') || (newRule && !t.repeatAnchor)) t.repeatAnchor = newRule ? t.due : null;
    t.repeat = newRule;
    t.reminder = t.dueTime && rem.value !== '' ? Number(rem.value) : null;
    t.calendarId = cat.value;
    t.priority = priority;
    t.estimate = est.value ? Number(est.value) : null;
    t.subtasks = subs.filter((x) => x.title.trim());
    if (subAdd.value.trim()) t.subtasks.push({ id: uid(), title: subAdd.value.trim(), done: false });
    return t;
  };

  async function save() {
    read();
    if (!t.title) { title.focus(); return toast('Give the task a name.', { error: true }); }
    app.rememberCalendar(t.calendarId);
    const reminderChanged = isNew || t.due !== orig.due || t.dueTime !== orig.dueTime || t.reminder !== orig.reminder || t.title !== orig.title;
    app.data.putTask(t);
    s.close();
    toast(isNew ? 'Task added' : 'Task saved');
    if (reminderChanged) syncTaskReminder(app, t);
  }

  async function remove() {
    const ok = await confirmDialog('Delete task?', `“${t.title || 'Untitled'}” will be deleted, along with any upcoming time blocks for it.`);
    if (!ok) return;
    const snapshot = structuredClone(orig);
    app.data.deleteTask(t.id);
    syncTaskReminder(app, { ...orig, deleted: true });
    s.close();
    const removed = await clearUpcomingBlocks(app, orig);
    toast('Task deleted' + blocksNote(removed.length), {
      action: 'Undo', timeout: 6000,
      onAction: async () => { app.data.putTask(snapshot); syncTaskReminder(app, snapshot); await restoreBlocks(app, removed); },
    });
  }

  function scheduleIt() {
    read();
    if (!t.title) { title.focus(); return toast('Give the task a name first.', { error: true }); }
    app.data.putTask(t);
    s.close();
    openScheduler(app, t.id);
  }

  const body = h('div.stack.editor',
    title,
    h('div.field', h('label.label', { for: 'tk-due' }, icon('cal', 16), 'Due'), h('div.row.wrap.datetime', due, time)),
    h('div.field', h('label.label', { for: 'tk-repeat' }, icon('repeat', 16), 'Repeat'), repeat.el),
    h('div.field', h('label.label', { for: 'tk-rem' }, icon('bell', 16), 'Notification'), rem, remHint),
    h('div.field', h('label.label', { for: 'tk-cat' }, catDot, 'Category'), cat),
    h('div.grid-2',
      h('div.field', h('span.label', icon('flag', 16), 'Priority'), prio),
      h('div.field', h('label.label', { for: 'tk-est' }, icon('clock', 16), 'Time needed'), est)),
    h('div.field', h('span.label', icon('list', 16), 'Subtasks'), subList, subAdd),
    h('div.field', h('label.label', { for: 'tk-notes' }, icon('note', 16), 'Notes'), notes),
    h('div.field', h('span.label', icon('block', 16), 'Time blocks'), blockList,
      h('button.btn.ghost.small', { type: 'button', onclick: scheduleIt }, icon('plus', 16), 'Schedule on calendar'), blockRule));

  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  const s = openSheet({
    title: isNew ? 'New task' : 'Edit task',
    body,
    footer: [
      !isNew ? h('button.btn.ghost.danger-text', { type: 'button', onclick: remove }, icon('trash', 18), 'Delete') : '',
      h('span.grow'),
      h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Cancel'),
      h('button.btn.primary', { type: 'button', onclick: save }, isNew ? 'Add task' : 'Save'),
    ],
  });
  return s;
}

// Next round half hour, on the due date if it's in the future.
function nextSlot(dueStr) {
  const now = new Date();
  if (dueStr && dueStr > todayStr()) { const d = parseYmd(dueStr); d.setHours(9, 0, 0, 0); return d; }
  const d = new Date(now);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  return d;
}

// ---------- the task list ----------
export function renderTaskList(app, root) {
  const st = app.ui;
  const tasks = app.data.tasks;
  const today = todayStr();
  const tomorrow = ymd(addDays(new Date(), 1));
  const weekEnd = ymd(addDays(new Date(), 7));

  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  const groups = [
    ['Overdue', (t) => t.due && t.due < today, 'overdue'],
    ['Today', (t) => t.due === today],
    ['Tomorrow', (t) => t.due === tomorrow],
    ['Next 7 days', (t) => t.due && t.due > tomorrow && t.due <= weekEnd],
    ['Later', (t) => t.due && t.due > weekEnd],
    ['No date', (t) => !t.due],
  ];
  const sortFn = (a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (a.dueTime || '99').localeCompare(b.dueTime || '99') || (b.priority || 0) - (a.priority || 0) || a.title.localeCompare(b.title);

  const prevQuick = document.getElementById('task-quick');
  const hadFocus = prevQuick && document.activeElement === prevQuick;
  const quick = h('input.input.quick-add#task-quick', { type: 'text', placeholder: 'Add a task, press Enter', 'aria-label': 'Add a task', value: prevQuick ? prevQuick.value : '' });
  if (hadFocus) requestAnimationFrame(() => quick.focus({ preventScroll: true }));
  quick.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && quick.value.trim()) {
      e.preventDefault();
      const t = newTask(app, { title: quick.value.trim(), due: st.taskFilter === 'today' ? today : null });
      app.data.putTask(t);
      quick.value = '';
      requestAnimationFrame(() => document.getElementById('task-quick') && document.getElementById('task-quick').focus());
    }
  });

  const filters = h('div.segmented.task-filter', { role: 'tablist', 'aria-label': 'Which tasks' },
    [['all', 'To do'], ['today', 'Today'], ['done', 'Done']].map(([v, l]) =>
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(st.taskFilter === v), onclick: () => { st.taskFilter = v; app.renderTasks(); } }, l)));

  const list = h('div.task-groups');
  if (st.taskFilter === 'done') {
    if (!done.length) list.append(empty('Nothing completed yet. Check off a task and it shows up here.'));
    else list.append(group('Completed', done.slice(0, 100)));
  } else {
    let shown = 0;
    for (const [name, test, cls] of groups) {
      if (st.taskFilter === 'today' && !['Overdue', 'Today'].includes(name)) continue;
      const items = open.filter(test).sort(sortFn);
      if (!items.length) continue;
      shown += items.length;
      list.append(group(name, items, cls));
    }
    if (!shown) list.append(empty(st.taskFilter === 'today' ? 'Nothing due today. Add a task above.' : 'No tasks yet. Type one above and press Enter.'));
  }

  root.replaceChildren(
    h('div.task-head', h('h2', 'Tasks'), h('span.count', String(open.length)),
      h('span.grow'),
      h('button.icon-btn', { type: 'button', 'aria-label': 'New task with details', title: 'New task with details', onclick: () => openTaskEditor(app, newTask(app)) }, icon('plus'))),
    filters, quick, list);

  function group(name, items, cls = '') {
    return h('section.task-group' + (cls ? '.' + cls : ''),
      h('h3', name, h('span.count', String(items.length))),
      h('ul.task-ul', items.map((t) => row(t))));
  }
  function row(t) {
    const c = app.calendar(t.calendarId);
    const color = c ? c.color : '#8a8f9c';
    const subDone = (t.subtasks || []).filter((s) => s.done).length;
    const meta = [];
    if (t.due) meta.push(h('span.meta-item' + (t.due < today && !t.done ? '.late' : ''), relDay(t.due) + (t.dueTime ? ', ' + fmtTime(atTime(t.due, t.dueTime)) : '')));
    if (t.repeat) meta.push(h('span.meta-item', { title: describe(t.repeat) }, icon('repeat', 14)));
    if (t.reminder != null && t.dueTime) meta.push(h('span.meta-item', { title: 'Notification on' }, icon('bell', 14)));
    if ((t.subtasks || []).length) meta.push(h('span.meta-item', `${subDone}/${t.subtasks.length}`));
    if (t.estimate) meta.push(h('span.meta-item', durationLabel(t.estimate)));
    const nextBlock = !t.done && app.blocksForTask(t.id).find((bl) => (bl.end || bl.start) > new Date());
    if (nextBlock) meta.push(h('span.meta-item.sched', { title: 'Scheduled' }, icon('block', 14), `${relDay(ymd(nextBlock.start))} ${fmtTime(nextBlock.start)}`));
    if (c) meta.push(h('span.meta-item.cat', { style: { '--c': color } }, c.name));
    const check = h('button.task-check', {
      type: 'button', role: 'checkbox', 'aria-checked': String(!!t.done), 'aria-label': (t.done ? 'Mark not done: ' : 'Complete: ') + t.title,
      style: { '--c': color, '--fg': readableText(color) },
      onclick: (e) => { e.stopPropagation(); check.classList.add('pop'); setTimeout(() => toggleDone(app, app.data.task(t.id) || t), 180); },
    }, icon('check', 14));
    const li = h('li.task-row' + (t.done ? '.done' : '') + (t.priority ? '.p' + t.priority : ''), {
      dataset: { taskId: t.id, title: t.title, duration: String(t.estimate || app.settings.defaultDuration), color },
      tabindex: '0',
      onclick: () => openTaskEditor(app, t.id),
      onkeydown: (e) => { if (e.key === 'Enter') openTaskEditor(app, t.id); },
    },
      check,
      h('div.task-main', h('span.task-title', t.title), meta.length ? h('div.task-meta', meta) : ''),
      t.priority ? h('span.prio-flag', { title: PRIORITIES[t.priority].label + ' priority' }, icon('flag', 16)) : '',
      !t.done ? h('button.icon-btn.sched-btn', { type: 'button', 'aria-label': 'Schedule on calendar: ' + t.title, title: 'Schedule on calendar',
        onclick: (e) => { e.stopPropagation(); openScheduler(app, t.id); } }, icon('block', 18)) : '');
    return li;
  }
  function empty(text) { return h('p.empty', text); }
}

// Tasks as calendar items (due date / time).
export function tasksForRange(app, start, end) {
  if (!app.settings.showTasksOnCalendar) return [];
  const s = ymd(start), e = ymd(end);
  return app.data.tasks
    .filter((t) => t.due && t.due >= s && t.due < e && (!t.done || app.settings.showCompleted))
    .map((t) => {
      const c = app.calendar(t.calendarId);
      const color = c ? c.color : '#8a8f9c';
      const st = t.dueTime ? atTime(t.due, t.dueTime) : t.due;
      return {
        id: 'task::' + t.id,
        title: t.title,
        start: st,
        end: t.dueTime ? clampToDay(st, addMinutes(st, 30)) : undefined,
        allDay: !t.dueTime,
        backgroundColor: 'transparent',
        borderColor: color,
        textColor: 'inherit',
        durationEditable: false,
        classNames: ['is-task', t.done ? 'is-done' : ''].filter(Boolean),
        extendedProps: { kind: 'task', taskId: t.id, color },
      };
    });
}

function clampToDay(start, end) {
  const last = new Date(start); last.setHours(23, 59, 59, 0);
  return end > last ? last : end;
}

// ---------- scheduling an existing task (built for phones: no dragging needed) ----------
const roundUp15 = (d) => { const x = new Date(d); x.setSeconds(0, 0); x.setMinutes(Math.ceil(x.getMinutes() / 15) * 15); return x; };

// Busy times from your visible calendars (all-day and "free" events don't count).
async function busyTimes(app, from, to) {
  const cals = app.calendars.filter((c) => app.visible(c) && !app.isReminderCal(c.id));
  const lists = await Promise.all(cals.map((c) => app.backend.listEvents(c.id, from, to).catch(() => [])));
  return lists.flat()
    .filter((e) => e.start.dateTime && e.transparency !== 'transparent' && !(e.attendees || []).some((a) => a.self && a.responseStatus === 'declined'))
    .map((e) => ({ s: new Date(e.start.dateTime), e: new Date(e.end.dateTime) }));
}

// Up to 3 open slots a day for the next 5 days, inside your planning hours.
export function freeSlots(busy, durMin, settings, days = 5) {
  const now = new Date();
  const out = [];
  const need = durMin * 60000;
  for (let i = 0; i < days; i++) {
    const day = addDays(startOfDay(now), i);
    let ws = new Date(day); ws.setHours(settings.dayStartHour ?? 8, 0, 0, 0);
    const we = new Date(day); we.setHours(settings.dayEndHour ?? 22, 0, 0, 0);
    if (i === 0 && roundUp15(now) > ws) ws = roundUp15(now);
    if (ws >= we) continue;
    const dayBusy = busy.filter((b) => b.e > ws && b.s < we).sort((a, b) => a.s - b.s);
    let cur = ws, perDay = 0;
    for (const b of [...dayBusy, { s: we, e: we }]) {
      if (b.s - cur >= need) { out.push(new Date(cur)); perDay++; }
      if (perDay >= 3) break;
      if (b.e > cur) cur = roundUp15(b.e);
    }
  }
  return out;
}

export function openScheduler(app, taskId, { durationMin } = {}) {
  const task = app.data.task(taskId);
  if (!task) return;
  let dur = durationMin || task.estimate || app.settings.defaultDuration || 60;
  const durs = [15, 30, 45, 60, 90, 120, 180];
  if (!durs.includes(dur)) { durs.push(dur); durs.sort((a, b) => a - b); }
  const c = app.calendar(task.calendarId);
  const durRow = h('div.chips', { role: 'radiogroup', 'aria-label': 'How long' });
  const paintDur = () => durRow.replaceChildren(...durs.map((m) =>
    h('button.chip', { type: 'button', role: 'radio', 'aria-checked': String(m === dur), onclick: () => { dur = m; paintDur(); renderSlots(); } }, durationLabel(m))));
  const slotsBox = h('div.slot-list', h('p.hint', 'Looking for open time…'));
  const today = todayStr();
  // default to the next round time inside your planning hours
  let dflt = nextSlot(null);
  const dayStart = app.settings.dayStartHour ?? 8, dayEnd = app.settings.dayEndHour ?? 22;
  if (dflt.getHours() < dayStart) dflt.setHours(dayStart, 0, 0, 0);
  else if (dflt.getHours() >= dayEnd) { dflt = addDays(startOfDay(dflt), 1); dflt.setHours(dayStart, 0, 0, 0); }
  const dateIn = h('input.input#sch-date', { type: 'date', value: ymd(dflt), 'aria-label': 'Date' });
  const timeIn = h('input.input#sch-time', { type: 'time', value: hm(dflt), step: '300', 'aria-label': 'Start time' });
  let busy = null;

  async function place(start) {
    if (isNaN(start)) return toast('Pick a date and time.', { error: true });
    const ok = await createBlock(app, task, start, addMinutes(start, dur));
    if (ok) s.close();
  }
  function renderSlots() {
    if (!busy) return;
    const slots = freeSlots(busy, dur, app.settings);
    if (!slots.length) return slotsBox.replaceChildren(h('p.hint', 'No open time in the next few days. Pick a time below.'));
    const byDay = {};
    for (const st of slots) (byDay[ymd(st)] ||= []).push(st);
    slotsBox.replaceChildren(...Object.entries(byDay).map(([day, list]) =>
      h('div.slot-day',
        h('span.slot-day-label', relDay(day), task.due && day > task.due ? h('span.late', ' · after due date') : ''),
        h('div.chips', list.map((st) => h('button.chip.slot', { type: 'button', onclick: () => place(st) }, `${fmtTime(st)} – ${fmtTime(addMinutes(st, dur))}`))))));
  }
  busyTimes(app, startOfDay(new Date()), addDays(startOfDay(new Date()), 5))
    .then((b) => { busy = b; renderSlots(); })
    .catch(() => slotsBox.replaceChildren(h('p.hint', 'Couldn’t check your calendar. Pick a time below.')));
  paintDur();

  const body = h('div.stack',
    h('div.sched-task', h('span.cat-dot', { style: { background: c ? c.color : '#999' } }), h('strong', task.title),
      task.due ? h('span.muted', `due ${relDay(task.due)}`) : ''),
    h('div.field', h('span.label', icon('clock', 16), 'How long'), durRow),
    h('div.field', h('span.label', icon('cal', 16), 'Open times'), slotsBox),
    h('div.field', h('span.label', 'Or pick a time'),
      h('div.row.wrap.datetime', dateIn, timeIn, h('button.btn.primary', { type: 'button', onclick: () => place(atTime(dateIn.value, timeIn.value)) }, 'Schedule'))),
    h('button.btn.ghost', { type: 'button', onclick: () => { s.close(); app.placeTask(task, dur); } }, icon('cal', 18), 'Tap a spot on the calendar'));
  const s = openSheet({ title: 'Schedule task', body, className: 'small' });
}

// Pick one of your open tasks (used when tapping an empty spot on the calendar).
export function pickTask(app, { title = 'Schedule a task' } = {}) {
  return new Promise((resolve) => {
    const today = todayStr();
    const tasks = app.data.tasks.filter((t) => !t.done)
      .sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || (b.priority || 0) - (a.priority || 0));
    const search = h('input.input#pick-search', { type: 'search', placeholder: 'Search tasks', 'aria-label': 'Search tasks' });
    const list = h('ul.pick-list');
    const paint = () => {
      const q = search.value.trim().toLowerCase();
      const shown = tasks.filter((t) => !q || t.title.toLowerCase().includes(q));
      list.replaceChildren(...(shown.length ? shown.map((t) => {
        const c = app.calendar(t.calendarId);
        return h('li', h('button.pick-row', { type: 'button', onclick: () => s.close(t) },
          h('span.cat-dot', { style: { background: c ? c.color : '#999' } }),
          h('span.pick-title', t.title),
          h('span.pick-meta' + (t.due && t.due < today ? '.late' : ''), [t.due ? relDay(t.due) : '', t.estimate ? durationLabel(t.estimate) : ''].filter(Boolean).join(' · '))));
      }) : [h('li.empty', q ? 'No tasks match.' : 'No open tasks.')]));
    };
    search.addEventListener('input', paint);
    paint();
    const s = openSheet({ title, body: h('div.stack-sm', search, list), className: 'small', onClose: (r) => resolve(r && r.id ? r : null) });
  });
}
