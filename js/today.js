// Today: what's next on the calendar, what's due, habits, and the focus timer, all on one screen.
import { h, ymd, todayStr, addDays, startOfDay, fmtTime, relDay, atTime, durationLabel, readableText, EVENT_COLORS } from './util.js';
import { icon } from './ui.js';
import { toggleDone, openTaskEditor, openScheduler, newTask } from './tasks.js';
import { habitChips, openHabitEditor } from './habits.js';
import { timerState, remainingMs, fmtClock, phaseLabel, focusToday, start as startTimer, onTimer, isActive } from './timer.js';

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Up late';
  if (hr < 12) return 'Good morning';
  if (hr < 17) return 'Good afternoon';
  return 'Good evening';
}

async function todaysEvents(app) {
  const from = startOfDay(new Date()), to = addDays(from, 1);
  const cals = app.calendars.filter((c) => app.visible(c) && !app.isReminderCal(c.id));
  const lists = await Promise.all(cals.map((c) => app.backend.listEvents(c.id, from, to).then((evs) => evs.map((e) => ({ e, c }))).catch(() => [])));
  return lists.flat()
    .map(({ e, c }) => {
      const color = e.colorId && EVENT_COLORS[e.colorId] ? EVENT_COLORS[e.colorId][1] : c.color;
      const allDay = !!e.start.date;
      return { title: e.summary || '(No title)', allDay, start: allDay ? from : new Date(e.start.dateTime), end: allDay ? to : new Date(e.end.dateTime), color, calId: c.id, ev: e,
        taskId: e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private.plannerTaskId };
    })
    .sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
}

export function renderTodayView(app, root, { onMenu, go, openEvent }) {
  const today = todayStr();
  const evBox = h('ul.today-events', h('li.hint', 'Loading your day…'));
  const focusBox = h('div.focus-card-body');

  // tasks due today or overdue
  const due = app.data.tasks.filter((t) => !t.done && t.due && t.due <= today)
    .sort((a, b) => a.due.localeCompare(b.due) || (a.dueTime || '99').localeCompare(b.dueTime || '99') || (b.priority || 0) - (a.priority || 0));
  const doneToday = app.data.tasks.filter((t) => t.done && t.doneAt && ymd(new Date(t.doneAt)) === today).length
    + app.data.list('logs').filter((l) => l.kind === 'task-done' && ymd(new Date(l.at)) === today && app.data.task(l.taskId) && app.data.task(l.taskId).repeat).length;

  const taskRow = (t) => {
    const c = app.calendar(t.calendarId);
    const color = c ? c.color : '#8a8f9c';
    return h('li.today-task',
      h('button.task-check', { type: 'button', role: 'checkbox', 'aria-checked': 'false', 'aria-label': 'Complete: ' + t.title, style: { '--c': color, '--fg': readableText(color) },
        onclick: (e) => { e.currentTarget.classList.add('pop'); setTimeout(() => toggleDone(app, app.data.task(t.id) || t), 180); } }, icon('check', 14)),
      h('button.today-task-main', { type: 'button', onclick: () => openTaskEditor(app, t.id) },
        h('span.task-title', t.title),
        h('span.task-meta', h('span.meta-item' + (t.due < today ? '.late' : ''), t.due < today ? relDay(t.due) : t.dueTime ? fmtTime(atTime(t.due, t.dueTime)) : 'Today'),
          c ? h('span.meta-item.cat', { style: { '--c': color } }, c.name) : '')),
      h('button.icon-btn.sched-btn', { type: 'button', 'aria-label': 'Schedule on calendar: ' + t.title, title: 'Schedule on calendar', onclick: () => openScheduler(app, t.id) }, icon('block', 18)));
  };

  const chips = habitChips(app);
  const hasHabits = app.data.list('habits').some((x) => !x.archived);

  root.replaceChildren(
    h('header.view-head.today-head',
      h('button.icon-btn.only-narrow', { type: 'button', 'aria-label': 'Open menu', onclick: onMenu }, icon('menu')),
      h('div.today-hello',
        h('h1.view-title', greeting()),
        h('p.today-date', new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })))),
    h('div.view-scroll',
      h('div.today-grid',
        h('section.today-card.card-events',
          h('h2', icon('cal', 18), 'Up next', h('button.link-btn.card-link', { type: 'button', onclick: () => go('calendar') }, 'Calendar')),
          evBox),
        h('section.today-card.card-tasks',
          h('h2', icon('check', 18), 'Due today', h('span.count', String(due.length)),
            h('button.link-btn.card-link', { type: 'button', onclick: () => openTaskEditor(app, newTask(app, { due: today })) }, '+ Add')),
          due.length ? h('ul.today-tasks', due.slice(0, 12).map(taskRow))
            : h('p.empty', doneToday ? `All caught up. ${doneToday} done today ✦` : 'Nothing due today.')),
        h('section.today-card.card-habits',
          h('h2', icon('sparkle', 18), 'Habits', h('button.link-btn.card-link', { type: 'button', onclick: () => go('habits') }, hasHabits ? 'All habits' : '')),
          chips.length ? h('div.habit-chips', chips)
            : h('div.stack-sm', h('p.hint', hasHabits ? 'No habits due today.' : 'Track things like water, the gym, or reading.'),
              !hasHabits ? h('button.btn.ghost.small', { type: 'button', onclick: () => openHabitEditor(app, null) }, icon('plus', 16), 'Add a habit') : '')),
        h('section.today-card.card-focus',
          h('h2', icon('timer', 18), 'Focus', h('button.link-btn.card-link', { type: 'button', onclick: () => go('timer') }, 'Open timer')),
          focusBox))));

  // focus card stays live while the timer runs
  const paintFocus = () => {
    const st = timerState();
    const f = focusToday(app);
    const active = st && isActive();
    focusBox.replaceChildren(
      h('div.focus-line',
        h('span.focus-clock' + (st && st.running ? '.running' : ''), fmtClock(remainingMs())),
        h('span.focus-phase', st ? phaseLabel(st.phase) + (st.running ? '' : active ? ' · paused' : '') : '')),
      h('p.hint', f.minutes ? `${durationLabel(f.minutes)} focused today across ${f.sessions} session${f.sessions === 1 ? '' : 's'}` : 'No focus sessions yet today.'),
      h('button.btn.primary.small', { type: 'button', onclick: () => { if (!st.running) startTimer(); go('timer'); } }, icon(st && st.running ? 'timer' : 'play', 16), st && st.running ? 'Go to timer' : active ? 'Resume focus' : 'Start focus'));
  };
  paintFocus();
  const off = onTimer(paintFocus);

  todaysEvents(app).then((list) => {
    const now = new Date();
    const allDay = list.filter((x) => x.allDay);
    const upcoming = list.filter((x) => !x.allDay && x.end > now);
    const rows = [
      ...allDay.map((x) => h('li.today-ev.allday', { style: { '--c': x.color } }, h('span.ev-when', 'All day'), h('span.ev-what', x.title))),
      ...upcoming.slice(0, 8).map((x) => {
        const live = x.start <= now;
        const task = x.taskId && app.data.task(x.taskId);
        return h('li', h('button.today-ev' + (live ? '.now' : ''), { type: 'button', style: { '--c': x.color, '--fg': readableText(x.color) }, onclick: () => openEvent(x.calId, x.ev) },
          h('span.ev-when', live ? 'Now' : fmtTime(x.start)),
          h('span.ev-what', x.title, task ? h('small', ' · time block') : ''),
          h('span.ev-until', live ? `until ${fmtTime(x.end)}` : `${Math.round((x.end - x.start) / 60000)} min`)));
      }),
    ];
    evBox.replaceChildren(...(rows.length ? rows : [h('li.empty', 'Nothing else on your calendar today.')]));
  });

  return () => off();
}
