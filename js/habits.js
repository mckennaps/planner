// Habits: daily / certain days / N times a week, with streaks and a heatmap.
import { h, ymd, todayStr, parseYmd, addDays, startOfDay, CATEGORY_SWATCHES, readableText } from './util.js';
import { openSheet, confirmDialog, toast, icon } from './ui.js';
import { habitDueOn, ntfyOn } from './notify.js';

const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HABIT_COLORS = ['#ff6fb8', '#b48cff', '#8fb6ff', '#5ccfa8', '#ffc24d', '#ff8a65', '#f8a5c2', '#d7b8f3', '#a8dfd4', '#33b679', '#039be5', '#8e24aa'];

export const habits = (app) => app.data.list('habits').filter((x) => !x.archived).sort((a, b) => (a.order ?? a.createdAt) - (b.order ?? b.createdAt));
const count = (hb, d) => (hb.log && hb.log[d]) || 0;
export const isDone = (hb, d) => count(hb, d) >= (hb.goal || 1);
const weekly = (hb) => hb.schedule && hb.schedule.type === 'weekly';

// tap: +1 until the goal, then back to 0
export function checkIn(app, hb, d) {
  const goal = hb.goal || 1;
  const c = count(hb, d);
  const next = c >= goal ? 0 : c + 1;
  const log = { ...(hb.log || {}) };
  if (next) log[d] = next; else delete log[d];
  app.data.put('habits', { ...hb, log });
  if (next >= goal && c < goal) {
    const s = streak({ ...hb, log });
    toast(s > 1 ? `${hb.name} ✦ ${s} ${weekly(hb) ? 'week' : 'day'} streak` : `${hb.name} ✦ done`);
  }
}

function weekStart(d, ws = 0) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() - ws + 7) % 7)); return x; }
function doneInWeek(hb, start) {
  let n = 0;
  for (let i = 0; i < 7; i++) if (isDone(hb, ymd(addDays(start, i)))) n++;
  return n;
}

export function streak(hb, ws = 0) {
  if (weekly(hb)) {
    const target = hb.schedule.times || 3;
    let w = weekStart(new Date(), ws), n = 0;
    if (doneInWeek(hb, w) >= target) n++;
    w = addDays(w, -7);
    while (doneInWeek(hb, w) >= target && n < 520) { n++; w = addDays(w, -7); }
    return n;
  }
  let d = startOfDay(new Date());
  const today = ymd(d);
  if (habitDueOn(hb, today) && !isDone(hb, today)) d = addDays(d, -1);
  let n = 0;
  const created = hb.createdAt ? startOfDay(new Date(hb.createdAt)) : addDays(d, -3650);
  for (let i = 0; i < 3650 && d >= created; i++, d = addDays(d, -1)) {
    const s = ymd(d);
    if (!habitDueOn(hb, s)) continue;
    if (isDone(hb, s)) n++; else break;
  }
  return n;
}

function bestStreak(hb) {
  if (weekly(hb)) return null;
  const dates = Object.keys(hb.log || {}).sort();
  if (!dates.length) return 0;
  let best = 0, cur = 0;
  for (let d = parseYmd(dates[0]); d <= startOfDay(new Date()); d = addDays(d, 1)) {
    const s = ymd(d);
    if (!habitDueOn(hb, s)) continue;
    if (isDone(hb, s)) { cur++; best = Math.max(best, cur); } else if (s !== todayStr()) cur = 0;
  }
  return best;
}
function rate30(hb) {
  let due = 0, done = 0;
  for (let i = 0; i < 30; i++) {
    const s = ymd(addDays(new Date(), -i));
    if (hb.createdAt && parseYmd(s) < startOfDay(new Date(hb.createdAt))) break;
    if (!weekly(hb) && !habitDueOn(hb, s)) continue;
    due++; if (isDone(hb, s)) done++;
  }
  if (weekly(hb)) return Math.min(100, Math.round((done / Math.max(1, (due / 7) * (hb.schedule.times || 3))) * 100));
  return due ? Math.round((done / due) * 100) : 0;
}
export function scheduleText(hb) {
  const s = hb.schedule || { type: 'daily' };
  if (s.type === 'days') return (s.days || []).length === 7 ? 'Every day' : (s.days || []).map((d) => DAY_NAMES[d]).join(', ');
  if (s.type === 'weekly') return `${s.times || 3}× a week`;
  return 'Every day';
}

// ---------- the habits screen ----------
export function renderHabitsView(app, root, { onMenu }) {
  const ws = app.settings.weekStart || 0;
  const start = weekStart(new Date(), ws);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const today = todayStr();
  const list = habits(app);

  const card = (hb) => {
    const s = streak(hb, ws);
    const goal = hb.goal || 1;
    return h('li.habit-card', { style: { '--c': hb.color || '#b48cff', '--fg': readableText(hb.color || '#b48cff') } },
      h('button.habit-name', { type: 'button', onclick: () => openHabitDetail(app, hb.id) },
        h('span.habit-dot'),
        h('span.habit-title', hb.name),
        h('span.habit-sub', scheduleText(hb) + (goal > 1 ? ` · ${goal}× a day` : '') + (weekly(hb) ? ` · ${doneInWeek(hb, start)}/${hb.schedule.times || 3} this week` : ''))),
      s ? h('span.habit-streak', { title: 'Current streak' }, icon('flame', 15), String(s)) : '',
      h('div.habit-week', days.map((d) => {
        const ds = ymd(d);
        const future = ds > today;
        const due = weekly(hb) || habitDueOn(hb, ds);
        const c = count(hb, ds);
        const label = `${hb.name}, ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
        return h('button.habit-day' + (isDone(hb, ds) ? '.done' : c ? '.partial' : '') + (ds === today ? '.today' : '') + (!due ? '.off' : ''), {
          type: 'button', disabled: future, 'aria-label': label, 'aria-pressed': String(isDone(hb, ds)),
          onclick: () => checkIn(app, app.data.list('habits').find((x) => x.id === hb.id), ds),
        }, goal > 1 && c && !isDone(hb, ds) ? String(c) : isDone(hb, ds) ? icon('check', 14) : '');
      })));
  };

  root.replaceChildren(
    h('header.view-head',
      h('button.icon-btn.only-narrow', { type: 'button', 'aria-label': 'Open menu', onclick: onMenu }, icon('menu')),
      h('h1.view-title', 'Habits'),
      h('span.grow'),
      h('button.btn.primary.small', { type: 'button', onclick: () => openHabitEditor(app, null) }, icon('plus', 16), 'New habit')),
    h('div.view-scroll',
      list.length
        ? [
          h('div.habit-week-head', h('span'), h('div.habit-week', days.map((d) =>
            h('span.wk' + (ymd(d) === today ? '.today' : ''), h('small', DAY_LETTERS[d.getDay()]), String(d.getDate()))))),
          h('ul.habit-list', list.map(card)),
        ]
        : h('div.empty-big', h('p.empty', 'No habits yet. Add one, like drinking water, going to the gym, or reading 20 pages.'),
          h('button.btn.primary', { type: 'button', onclick: () => openHabitEditor(app, null) }, icon('plus', 16), 'New habit'))));
}

// Today's habits as tappable chips (used on the Today screen).
export function habitChips(app) {
  const today = todayStr();
  const due = habits(app).filter((hb) => weekly(hb) || habitDueOn(hb, today));
  return due.map((hb) => {
    const goal = hb.goal || 1, c = count(hb, today), done = c >= goal;
    return h('button.habit-chip' + (done ? '.done' : ''), {
      type: 'button', style: { '--c': hb.color || '#b48cff', '--fg': readableText(hb.color || '#b48cff') }, 'aria-pressed': String(done),
      onclick: () => checkIn(app, app.data.list('habits').find((x) => x.id === hb.id), today),
    }, h('span.hc-box', done ? icon('check', 13) : ''), h('span', hb.name), goal > 1 ? h('span.hc-count', `${c}/${goal}`) : '');
  });
}

// ---------- detail: heatmap + stats ----------
function openHabitDetail(app, id) {
  const hb = app.data.list('habits').find((x) => x.id === id);
  if (!hb) return;
  const weeks = 18, ws = app.settings.weekStart || 0;
  const first = addDays(weekStart(new Date(), ws), -7 * (weeks - 1));
  const today = todayStr();
  const grid = h('div.heatmap', { style: { '--c': hb.color || '#b48cff' } });
  for (let w = 0; w < weeks; w++) {
    const col = h('div.hm-col');
    for (let i = 0; i < 7; i++) {
      const d = addDays(first, w * 7 + i), s = ymd(d);
      const c = count(hb, s), goal = hb.goal || 1;
      const lvl = s > today ? 'future' : c >= goal ? 'l3' : c ? 'l1' : (weekly(hb) || habitDueOn(hb, s)) ? 'l0' : 'off';
      col.append(h('span.hm-cell.' + lvl, { title: `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}: ${c ? c + '×' : '—'}` }));
    }
    grid.append(col);
  }
  const best = bestStreak(hb);
  const body = h('div.stack',
    h('div.habit-stats',
      h('div.stat', h('strong', String(streak(hb, ws))), h('span', weekly(hb) ? 'week streak' : 'day streak')),
      best != null ? h('div.stat', h('strong', String(best)), h('span', 'best streak')) : '',
      h('div.stat', h('strong', rate30(hb) + '%'), h('span', 'last 30 days'))),
    h('div.field', h('span.label', 'Last 18 weeks'), h('div.heatmap-wrap', grid)),
    h('p.hint', scheduleText(hb) + ((hb.goal || 1) > 1 ? ` · goal ${hb.goal}× a day` : '') + (hb.reminder ? ` · reminder at ${hb.reminder}` : '')));
  const s = openSheet({
    title: hb.name, body, className: 'small',
    footer: [
      h('button.btn.ghost.danger-text', { type: 'button', onclick: async () => {
        if (!(await confirmDialog(`Delete ${hb.name}?`, 'Its history will be deleted too.'))) return;
        app.data.remove('habits', hb.id); s.close(); toast('Habit deleted');
      } }, icon('trash', 18), 'Delete'),
      h('span.grow'),
      h('button.btn.primary', { type: 'button', onclick: () => { s.close(); openHabitEditor(app, hb.id); } }, 'Edit'),
    ],
  });
}

// ---------- editor ----------
export function openHabitEditor(app, id) {
  const orig = id ? app.data.list('habits').find((x) => x.id === id) : null;
  const hb = orig ? structuredClone(orig) : { name: '', color: HABIT_COLORS[habits(app).length % HABIT_COLORS.length], schedule: { type: 'daily' }, goal: 1, reminder: null, log: {} };
  const name = h('input.input.title-input#hb-name', { type: 'text', placeholder: 'e.g. Drink water', value: hb.name, autofocus: !orig, 'aria-label': 'Habit name' });
  let color = hb.color;
  const sw = h('div.swatches', { role: 'radiogroup', 'aria-label': 'Color' });
  const paintSw = () => sw.replaceChildren(...HABIT_COLORS.map((c) => h('button.swatch', { type: 'button', role: 'radio', 'aria-checked': String(c === color), title: c, style: { background: c }, onclick: () => { color = c; paintSw(); } })));
  paintSw();
  let type = (hb.schedule && hb.schedule.type) || 'daily';
  const picked = new Set((hb.schedule && hb.schedule.days) || [1, 2, 3, 4, 5]);
  const typeSeg = h('div.segmented', { role: 'radiogroup', 'aria-label': 'How often' });
  const dayChips = h('div.day-chips');
  const times = h('input.input.num#hb-times', { type: 'number', min: '1', max: '7', value: String((hb.schedule && hb.schedule.times) || 3), 'aria-label': 'Times a week' });
  const timesRow = h('label.row', times, h('span.muted', 'times a week (any days)'));
  const paintType = () => {
    typeSeg.replaceChildren(...[['daily', 'Every day'], ['days', 'Certain days'], ['weekly', 'Times a week']].map(([v, l]) =>
      h('button', { type: 'button', role: 'radio', 'aria-checked': String(type === v), onclick: () => { type = v; paintType(); } }, l)));
    dayChips.hidden = type !== 'days';
    timesRow.hidden = type !== 'weekly';
    dayChips.replaceChildren(...DAY_NAMES.map((n, i) => {
      const b = h('button.day-chip', { type: 'button', 'aria-pressed': String(picked.has(i)), title: n }, n[0]);
      b.onclick = () => { if (picked.has(i) && picked.size > 1) picked.delete(i); else picked.add(i); b.setAttribute('aria-pressed', String(picked.has(i))); };
      return b;
    }));
  };
  paintType();
  const goal = h('input.input.num#hb-goal', { type: 'number', min: '1', max: '30', value: String(hb.goal || 1), 'aria-label': 'Times per day' });
  const rem = h('input.input#hb-rem', { type: 'time', value: hb.reminder || '', 'aria-label': 'Reminder time' });

  const body = h('div.stack',
    name,
    h('div.field', h('span.label', 'Color'), sw),
    h('div.field', h('span.label', 'How often'), typeSeg, dayChips, timesRow),
    h('div.field', h('label.label', { for: 'hb-goal' }, 'Goal each day'), h('label.row', goal, h('span.muted', 'time(s), e.g. 8 for 8 glasses of water'))),
    h('div.field', h('label.label', { for: 'hb-rem' }, icon('bell', 16), 'Reminder'), rem,
      h('p.hint', ntfyOn(app) ? 'Sent to your phone through ntfy on days you haven’t checked it off yet.' : 'Reminders need phone notifications set up (Settings → Phone notifications).')));
  const save = () => {
    const n = name.value.trim();
    if (!n) { name.focus(); return toast('Give the habit a name.', { error: true }); }
    const schedule = type === 'days' ? { type, days: [...picked].sort() } : type === 'weekly' ? { type, times: Math.min(7, Math.max(1, Number(times.value) || 3)) } : { type: 'daily' };
    app.data.put('habits', { ...hb, name: n, color, schedule, goal: Math.min(30, Math.max(1, Number(goal.value) || 1)), reminder: rem.value || null, ...(orig ? {} : { order: Date.now() }) });
    s.close();
    toast(orig ? 'Habit saved' : 'Habit added ✦');
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
  const s = openSheet({
    title: orig ? 'Edit habit' : 'New habit', body, className: 'small',
    footer: [h('span.grow'), h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: save }, orig ? 'Save' : 'Add habit')],
  });
}
