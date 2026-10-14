// App shell: sign-in, layout, calendar view, sidebar, categories, settings.
import { h, $, store, ymd, hm, parseYmd, addDays, addMinutes, startOfDay, setClock24, isNarrow, isTouch, CATEGORY_SWATCHES, readableText, fmtDate, debounce } from './util.js';
import { openSheet, choose, confirmDialog, toast, showError, icon, anySheetOpen } from './ui.js';
import { GoogleBackend, redirectUri } from './google.js';
import { LocalBackend } from './local.js';
import { DataStore } from './data.js';
import { toFC, saveEvent, askScope, openEventEditor, loadForEdit, evStart } from './events.js';
import { renderTaskList, openTaskEditor, newTask, tasksForRange, syncTaskReminder, toggleDone, createBlock, pickTask, openScheduler } from './tasks.js';
import { renderTodayView } from './today.js';
import { renderHabitsView, openHabitEditor } from './habits.js';
import { initTimer, renderTimerView, onTimer, timerState, remainingMs, fmtClock, phaseLabel, isActive, setTask as setTimerTask, toggle as toggleTimer } from './timer.js';
import { notifySettings, ntfyOn, newTopic, sendTest, syncQueue, syncQueueSoon } from './notify.js';

const CONFIG = window.PLANNER_CONFIG || {};
const VIEWS = [
  ['timeGridDay', 'Day'], ['timeGridThreeDay', '3 days'], ['timeGridWeek', 'Week'],
  ['dayGridMonth', 'Month'], ['listWeek', 'Schedule'],
];
const REMINDER_CAL_NAME = 'Task reminders';
let lastPointer = 'mouse';
addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);

// ------------------------------------------------------------------ boot

async function boot() {
  const hasToken = location.hash.includes('access_token') || location.hash.includes('error=');
  if (CONFIG.demoOnly) return start(new LocalBackend());
  let mode = store.get('planner.mode');
  if (hasToken) mode = 'google';

  if (mode === 'google' && CONFIG.googleClientId) {
    const backend = new GoogleBackend(CONFIG.googleClientId);
    const r = backend.handleRedirect();
    if (r && r.startsWith('error:')) {
      const code = r.slice(6);
      if (['interaction_required', 'login_required', 'consent_required'].includes(code)) return welcome('Sign in again to keep going.');
      if (code === 'access_denied') return welcome('Sign-in was canceled.');
      return welcome(`Google sign-in failed (${code}).`);
    }
    if (!backend.signedIn) return welcome();
    if (!backend.tokenFresh) return backend.signIn({ silent: true });
    store.set('planner.mode', 'google');
    return start(backend);
  }
  if (mode === 'demo') return start(new LocalBackend());
  return welcome();
}

function welcome(notice) {
  applyTheme(store.get('planner.theme', 'system'));
  document.documentElement.dataset.skin = store.get('planner.skin', CONFIG.defaultSkin || 'blush');
  const configured = !!CONFIG.googleClientId;
  const root = $('#app');
  root.className = 'welcome';
  root.replaceChildren(
    h('main.welcome-card',
      h('div.brand.big', h('span.brand-mark', 'Planner')),
      h('p.lead', 'Your calendar, tasks and time blocks in one place, synced through your Google account.'),
      notice ? h('p.notice', notice) : '',
      configured
        ? h('button.btn.primary.large', { type: 'button', onclick: () => { store.set('planner.mode', 'google'); new GoogleBackend(CONFIG.googleClientId).signIn(); } }, 'Sign in with Google')
        : h('div.setup-note',
          h('p', h('strong', 'Google sign-in isn’t set up yet.'), ' Add your client ID to ', h('code', 'js/config.js'), ' (the README walks through it). This page’s address to register with Google is:'),
          h('code.copyable', redirectUri())),
      h('button.btn.ghost.large', { type: 'button', onclick: () => { store.set('planner.mode', 'demo'); location.reload(); } }, 'Try the demo'),
      h('p.hint', 'The demo uses sample data saved only in this browser.')));
}

// ------------------------------------------------------------------ app
async function start(backend) {
  const data = new DataStore(backend);
  let cal = null;
  let miniMonth = startOfDay(new Date());
  let fetchErrShown = false;
  let placing = null;
  let viewCleanup = null;
  const rerenderView = debounce(() => { if (['today', 'habits'].includes(app.ui.tab) && !anySheetOpen()) renderView(); }, 120);
  let tasksRerender = null;
  const app = {
    backend, data,
    calendars: [],
    ui: { taskFilter: 'all', tab: store.get('planner.tab') || (isNarrow() ? 'today' : 'calendar'), taskPanel: store.get('planner.taskPanel', true) },
    get settings() { return data.settings; },
    calendar: (id) => app.calendars.find((c) => c.id === id) || null,
    isReminderCal: (id) => id && id === data.settings.reminderCalendarId,
    writableCalendars: () => app.calendars.filter((c) => c.writable && !app.isReminderCal(c.id)),
    visible: (c) => (data.settings.calVisibility || {})[c.id] ?? c.selected,
    lastCalendarId() {
      const id = store.get('planner.lastCal');
      const w = app.writableCalendars();
      return (w.find((c) => c.id === id) || w.find((c) => c.primary) || w[0] || {}).id || null;
    },
    rememberCalendar: (id) => store.set('planner.lastCal', id),
    refetch: () => cal && cal.refetchEvents(),
    renderTasks: () => renderTaskList(app, $('#taskpanel')),
    openTask: (id) => openTaskEditor(app, id),
    completeTask: (id) => { const t = data.task(id); if (t && !t.done) toggleDone(app, t); },
    async scheduleTaskAt(start, end) {
      const t = await pickTask(app, { title: 'Pick a task for this time' });
      if (!t) return;
      const minutes = t.estimate || Math.max(15, Math.round((end - start) / 60000)) || data.settings.defaultDuration;
      createBlock(app, t, start, addMinutes(start, minutes));
    },
    placeTask(task, minutes) {
      placing = { task, minutes };
      setTab('calendar');
      toggleDrawer(false);
      const bar = $('#placing');
      bar.replaceChildren(
        h('span.placing-text', 'Tap a time for ', h('strong', task.title), ` (${minutes} min)`),
        h('button.btn.ghost.small', { type: 'button', onclick: () => stopPlacing() }, 'Cancel'));
      bar.hidden = false;
      setTimeout(() => cal.updateSize(), 0);
    },
    openNewEvent: (o) => openEventEditor(app, o),
    async openEventById(fcId) {
      const ev = cal.getEventById(fcId);
      if (ev) openFcEvent(ev);
    },
    blocksForTask: (taskId) => (cal ? cal.getEvents().filter((e) => e.extendedProps.kind === 'event' && e.extendedProps.taskId === taskId).sort((a, b) => a.start - b.start) : []),
    async reminderCalendar(create) {
      let id = data.settings.reminderCalendarId;
      if (id && app.calendar(id)) return id;
      const found = app.calendars.find((c) => c.writable && c.name === REMINDER_CAL_NAME);
      if (found) { data.setSettings({ reminderCalendarId: found.id }); return found.id; }
      if (!create) return null;
      const made = await backend.createCalendar(REMINDER_CAL_NAME, '#8a8f9c');
      app.calendars.push(made);
      data.setSettings({ reminderCalendarId: made.id });
      renderSidebar();
      return made.id;
    },
  };
  window.__planner = app; // handy for debugging in the browser console

  applySettings(app);
  buildShell();

  try {
    app.calendars = await backend.listCalendars();
  } catch (e) {
    showError(e, 'Could not load your calendars');
  }
  renderSidebar();
  initCalendar();
  app.cal = cal;
  app.renderTasks();
  initDraggable(app);
  initTimer(app);
  onTimer(paintTimerChip);
  setTab(app.ui.tab);
  setInterval(() => syncQueue(app), 30 * 60000);

  data.addEventListener('change', () => {
    app.renderTasks();
    refreshBlockStates();
    rerenderView();
    syncQueueSoon(app);
    applySettings(app);
    const src = cal.getEventSourceById('tasks');
    if (src) src.refetch();
  });
  data.addEventListener('status', (e) => paintSync(e.detail));

  const replayed = await backend.replayPending();
  if (replayed) app.refetch();
  data.pull().then(() => syncQueue(app));

  // Pick up changes made on other devices when you come back to the app.
  let lastSync = Date.now();
  const resync = () => {
    if (document.visibilityState !== 'visible') return;
    if (backend.kind === 'google' && backend.token && backend.token.expires - Date.now() < 10 * 60000 && !anySheetOpen()) {
      return backend.ensureFresh();
    }
    if (Date.now() - lastSync < 20000) return;
    lastSync = Date.now();
    data.pull();
    app.refetch();
    backend.listCalendars().then((c) => { app.calendars = c; renderSidebar(); }).catch(() => {});
  };
  document.addEventListener('visibilitychange', resync);
  addEventListener('focus', resync);
  addEventListener('online', () => data.push());

  // ---------------------------------------------------------------- shell
  function buildShell() {
    const root = $('#app');
    root.className = 'shell';
    root.dataset.tab = app.ui.tab;
    root.dataset.taskPanel = app.ui.taskPanel ? 'open' : 'closed';
    const viewSel = h('div.segmented.view-switch', { role: 'tablist', 'aria-label': 'Calendar view' });
    const viewSelect = h('select.input.view-select', { 'aria-label': 'Calendar view' });
    root.replaceChildren(
      h('aside#sidebar', { 'aria-label': 'Calendars and navigation' }),
      h('div.scrim', { onclick: () => toggleDrawer(false) }),
      h('main#main',
        h('section.view#view-today'),
        h('section.view#view-habits'),
        h('section.view#view-timer'),
        h('section.view#view-calendar',
        h('header#topbar',
          h('button.icon-btn.only-narrow', { type: 'button', 'aria-label': 'Open menu', onclick: () => toggleDrawer(true) }, icon('menu')),
          h('button.btn.ghost.today-btn', { type: 'button', onclick: () => cal.today() }, 'Today'),
          h('div.nav-arrows',
            h('button.icon-btn', { type: 'button', 'aria-label': 'Previous', onclick: () => cal.prev() }, icon('left')),
            h('button.icon-btn', { type: 'button', 'aria-label': 'Next', onclick: () => cal.next() }, icon('right'))),
          h('h1#range-title'),
          h('span.grow'),
          h('div.loading-dot', { 'aria-hidden': 'true' }),
          viewSel, viewSelect,
          h('button.icon-btn.only-wide#task-toggle', { type: 'button', 'aria-label': 'Show or hide tasks', title: 'Tasks', onclick: () => {
            app.ui.taskPanel = !app.ui.taskPanel;
            store.set('planner.taskPanel', app.ui.taskPanel);
            root.dataset.taskPanel = app.ui.taskPanel ? 'open' : 'closed';
            setTimeout(() => cal.updateSize(), 220);
          } }, icon('list'))),
        h('div#placing', { hidden: true, role: 'status' }),
        h('div#calendar-wrap', h('div#calendar')))),
      h('aside#taskpanel', { 'aria-label': 'Tasks' }),
      h('nav#tabbar', { 'aria-label': 'Sections' },
        tabBtn('today', 'home', 'Today'), tabBtn('calendar', 'cal', 'Calendar'), tabBtn('tasks', 'check', 'Tasks'),
        tabBtn('habits', 'sparkle', 'Habits'), tabBtn('timer', 'timer', 'Focus')),
      h('button#fab', { type: 'button', 'aria-label': 'Create', onclick: fabCreate }, icon('plus', 26)),
      h('button#timer-chip', { type: 'button', hidden: true, onclick: () => setTab('timer') }));
    paintViewSwitch();
  }
  function tabBtn(id, ic, label) {
    return h('button.tab', { type: 'button', 'aria-current': String(app.ui.tab === id), dataset: { tab: id }, onclick: () => setTab(id) }, icon(ic), h('span', label));
  }
  function setTab(id) {
    if (id === 'tasks' && !isNarrow()) id = 'calendar';
    app.ui.tab = id;
    store.set('planner.tab', id);
    $('#app').dataset.tab = id;
    document.querySelectorAll('#tabbar .tab[data-tab]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === id)));
    document.querySelectorAll('.nav-item[data-tab]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === id)));
    toggleDrawer(false);
    renderView();
    paintTimerChip();
    if (id === 'calendar' && cal) setTimeout(() => cal.updateSize(), 0);
  }
  app.go = setTab;

  // ---------------------------------------------------------------- non-calendar views
  function renderView() {
    if (viewCleanup) { viewCleanup(); viewCleanup = null; }
    const id = app.ui.tab;
    const onMenu = () => toggleDrawer(true);
    if (id === 'today') viewCleanup = renderTodayView(app, $('#view-today'), { onMenu, go: setTab, openEvent: async (calId, gev) => openEventEditor(app, { calId, gev: await loadForEdit(app, calId, gev) }) });
    else if (id === 'habits') renderHabitsView(app, $('#view-habits'), { onMenu });
    else if (id === 'timer') viewCleanup = renderTimerView(app, $('#view-timer'), {
      onMenu,
      onPickTask: async () => { const t = await pickTask(app, { title: 'Focus on…' }); if (t) setTimerTask(t.id); },
    });
  }

  function paintTimerChip() {
    const chip = $('#timer-chip');
    if (!chip) return;
    const st = timerState();
    const show = st && isActive() && app.ui.tab !== 'timer';
    chip.hidden = !show;
    if (!show) return;
    chip.dataset.phase = st.phase;
    chip.replaceChildren(icon(st.running ? 'timer' : 'pause', 16), h('span', `${phaseLabel(st.phase)} ${fmtClock(remainingMs())}`));
  }
  function toggleDrawer(open) { $('#app').classList.toggle('drawer-open', open); }
  async function fabCreate() {
    if (app.ui.tab === 'tasks') return openTaskEditor(app, newTask(app));
    if (app.ui.tab === 'habits') return openHabitEditor(app, null);
    const which = await choose('Create', [{ value: 'event', label: 'Event' }, { value: 'task', label: 'Task' }], { confirmLabel: 'Next' });
    if (which === 'event') newEventAt(roundedNow());
    if (which === 'task') openTaskEditor(app, newTask(app));
  }

  function paintViewSwitch() {
    const cur = cal ? cal.view.type : store.get('planner.view');
    const seg = $('.view-switch');
    seg.replaceChildren(...VIEWS.map(([v, l]) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(v === cur), onclick: () => changeView(v) }, l)));
    const sel = $('.view-select');
    sel.replaceChildren(...VIEWS.map(([v, l]) => h('option', { value: v, selected: v === cur }, l)));
    sel.onchange = () => changeView(sel.value);
  }
  function changeView(v) {
    cal.changeView(v);
    store.set('planner.view', v);
    paintViewSwitch();
  }

  // ---------------------------------------------------------------- sidebar
  function renderSidebar() {
    const sb = $('#sidebar');
    if (!sb) return;
    const mine = app.calendars.filter((c) => c.writable && !app.isReminderCal(c.id));
    const others = app.calendars.filter((c) => !c.writable);
    const remCal = app.calendars.find((c) => app.isReminderCal(c.id));
    sb.replaceChildren(
      h('div.sb-top',
        h('div.brand', h('span.brand-mark', 'Planner')),
        h('button.icon-btn.only-narrow', { type: 'button', 'aria-label': 'Close menu', onclick: () => toggleDrawer(false) }, icon('x'))),
      h('div.sb-create',
        h('button.btn.primary', { type: 'button', onclick: () => { toggleDrawer(false); newEventAt(roundedNow()); } }, icon('plus', 18), 'Event'),
        h('button.btn.ghost', { type: 'button', onclick: () => { toggleDrawer(false); openTaskEditor(app, newTask(app)); } }, icon('plus', 18), 'Task')),
      h('nav.side-nav', { 'aria-label': 'Sections' },
        [['today', 'home', 'Today'], ['calendar', 'cal', 'Calendar'], ['habits', 'sparkle', 'Habits'], ['timer', 'timer', 'Focus timer']].map(([id, ic, label]) =>
          h('button.nav-item', { type: 'button', dataset: { tab: id }, 'aria-current': String(app.ui.tab === id), onclick: () => setTab(id) }, icon(ic, 18), h('span', label)))),
      h('div#minical'),
      h('section.cats',
        h('div.cats-head', h('h2', 'Categories'),
          h('button.icon-btn', { type: 'button', 'aria-label': 'Add category', title: 'Add category', onclick: () => editCategory(null) }, icon('plus', 18))),
        h('ul.cat-list', mine.map(catRow)),
        others.length ? h('h3.cats-sub', 'Other calendars') : '',
        others.length ? h('ul.cat-list', others.map(catRow)) : '',
        remCal ? h('p.hint.rem-note', `“${REMINDER_CAL_NAME}” holds task notifications for your phone. It's hidden here.`) : ''),
      h('div.sb-foot',
        h('div#sync-status.sync', { role: 'status' }),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Settings', title: 'Settings', onclick: () => { toggleDrawer(false); openSettings(); } }, icon('gear'))));
    paintSync(data.status);
    renderMiniCal();
  }
  function catRow(c) {
    const box = h('input', {
      type: 'checkbox', checked: app.visible(c), 'aria-label': `Show ${c.name}`,
      style: { '--c': c.color, '--fg': readableText(c.color) },
      onchange: (e) => {
        data.setSettings({ calVisibility: { ...(data.settings.calVisibility || {}), [c.id]: e.target.checked } });
        app.refetch();
      },
    });
    return h('li.cat-row', h('label.cat-label', box, h('span.cat-name', c.name)),
      h('button.icon-btn.cat-edit', { type: 'button', 'aria-label': `Edit ${c.name}`, onclick: () => editCategory(c) }, icon('dots', 18)));
  }

  function paintSync(s) {
    const el = $('#sync-status');
    if (!el) return;
    const label = {
      idle: 'Ready', syncing: 'Syncing…', synced: backend.kind === 'demo' ? 'Demo data in this browser' : 'Synced',
      offline: 'Offline. Changes are saved here and sync later.', error: 'Sync paused. Retrying when you come back.',
    }[s] || '';
    el.dataset.state = s;
    el.replaceChildren(h('span.sync-dot'), h('span', label));
  }

  // mini month calendar in the sidebar
  function renderMiniCal() {
    const box = $('#minical');
    if (!box) return;
    const first = new Date(miniMonth.getFullYear(), miniMonth.getMonth(), 1);
    const ws = data.settings.weekStart || 0;
    const gridStart = addDays(first, -((first.getDay() - ws + 7) % 7));
    const today = ymd(new Date());
    const range = cal ? [ymd(cal.view.activeStart), ymd(cal.view.activeEnd)] : null;
    const curMonth = cal && cal.view.type === 'dayGridMonth';
    const days = [];
    for (let i = 0; i < 42; i++) {
      const d = addDays(gridStart, i);
      const s = ymd(d);
      const inRange = range && !curMonth && s >= range[0] && s < range[1];
      days.push(h('button.mc-day' + (d.getMonth() !== first.getMonth() ? '.out' : '') + (s === today ? '.today' : '') + (inRange ? '.inrange' : ''),
        { type: 'button', 'aria-label': fmtDate(d, { weekday: 'long', month: 'long', day: 'numeric' }), onclick: () => { cal.gotoDate(d); setTab('calendar'); } },
        String(d.getDate())));
    }
    const dow = [];
    for (let i = 0; i < 7; i++) dow.push(h('span.mc-dow', addDays(gridStart, i).toLocaleDateString(undefined, { weekday: 'narrow' })));
    box.replaceChildren(
      h('div.mc-head',
        h('span.mc-title', first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Previous month', onclick: () => { miniMonth = new Date(first.getFullYear(), first.getMonth() - 1, 1); renderMiniCal(); } }, icon('left', 16)),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Next month', onclick: () => { miniMonth = new Date(first.getFullYear(), first.getMonth() + 1, 1); renderMiniCal(); } }, icon('right', 16))),
      h('div.mc-grid', dow, days));
  }

  // ---------------------------------------------------------------- categories
  function editCategory(c) {
    const isNew = !c;
    let color = c ? c.color : CATEGORY_SWATCHES[(app.calendars.length * 5) % CATEGORY_SWATCHES.length];
    const name = h('input.input#cat-name', { type: 'text', value: c ? c.name : '', placeholder: 'e.g. BIO 201', autofocus: true, 'aria-label': 'Category name', disabled: c && !c.writable && c.role !== 'reader' ? false : false });
    const grid = h('div.swatch-grid', { role: 'radiogroup', 'aria-label': 'Color' });
    const custom = h('input#cat-custom', { type: 'color', value: color, 'aria-label': 'Custom color' });
    const paint = () => {
      grid.replaceChildren(...CATEGORY_SWATCHES.map((hex) =>
        h('button.swatch.lg', { type: 'button', role: 'radio', 'aria-checked': String(hex.toLowerCase() === color.toLowerCase()), title: hex, style: { background: hex }, onclick: () => { color = hex; custom.value = hex; paint(); } })));
      preview.style.background = color;
      preview.style.color = readableText(color);
      preview.textContent = name.value || 'Preview';
    };
    const preview = h('div.cat-preview');
    custom.addEventListener('input', () => { color = custom.value; paint(); });
    name.addEventListener('input', paint);
    const body = h('div.stack',
      h('div.field', h('label.label', { for: 'cat-name' }, 'Name'), name),
      h('div.field', h('span.label', 'Color'), grid, h('label.row.custom-color', custom, h('span', 'Custom color'))),
      preview,
      isNew ? h('p.hint', 'A category is a calendar in your Google account, so it shows up in Google Calendar with the same color.') : '');
    paint();
    const save = async () => {
      const n = name.value.trim();
      if (!n) return toast('Give the category a name.', { error: true });
      try {
        if (isNew) {
          const made = await backend.createCalendar(n, color);
          app.calendars.push(made);
          toast(`Added ${n}`);
        } else {
          await backend.updateCalendar(c, { name: n, color });
          Object.assign(c, { name: n, color });
          toast('Category saved');
        }
        s.close();
        renderSidebar();
        app.refetch();
        app.renderTasks();
      } catch (e) { showError(e, 'Could not save the category'); }
    };
    const remove = async () => {
      const owned = c.role === 'owner' && !c.primary;
      const ok = await confirmDialog(owned ? `Delete ${c.name}?` : `Remove ${c.name}?`,
        owned ? 'This deletes the calendar and every event in it from your Google account. This can’t be undone.' : 'This removes the calendar from your list. You can add it back in Google Calendar.',
        { confirmLabel: owned ? 'Delete' : 'Remove' });
      if (!ok) return;
      try {
        await backend.deleteCalendar(c);
        app.calendars = app.calendars.filter((x) => x.id !== c.id);
        s.close(); renderSidebar(); app.refetch();
        toast(`${c.name} ${owned ? 'deleted' : 'removed'}`);
      } catch (e) { showError(e, 'Could not delete'); }
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    const s = openSheet({
      title: isNew ? 'New category' : 'Edit category', body, className: 'small',
      footer: [
        !isNew && !c.primary ? h('button.btn.ghost.danger-text', { type: 'button', onclick: remove }, icon('trash', 18), c.role === 'owner' ? 'Delete' : 'Remove') : '',
        h('span.grow'),
        h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: save }, isNew ? 'Add category' : 'Save'),
      ],
    });
  }

  // ---------------------------------------------------------------- settings
  function openSettings() {
    const S = data.settings;
    const sel = (id, value, opts, onchange) => {
      const el = h('select.input', { id, onchange: (e) => onchange(e.target.value) }, opts.map(([v, l]) => h('option', { value: String(v), selected: String(v) === String(value) }, l)));
      return el;
    };
    const toggle = (id, checked, label, onchange) => h('label.toggle', h('input', { id, type: 'checkbox', checked, onchange: (e) => onchange(e.target.checked) }), h('span', label));
    const body = h('div.stack',
      h('div.grid-2',
        h('div.field', h('label.label', { for: 'set-week' }, 'Week starts on'),
          sel('set-week', S.weekStart, [[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']], (v) => data.setSettings({ weekStart: Number(v) }))),
        h('div.field', h('label.label', { for: 'set-clock' }, 'Time format'),
          sel('set-clock', S.clock24 ? 1 : 0, [[0, '1:00pm'], [1, '13:00']], (v) => data.setSettings({ clock24: v === '1' })))),
      h('div.grid-2',
        h('div.field', h('label.label', { for: 'set-dur' }, 'New event length'),
          sel('set-dur', S.defaultDuration, [[15, '15 min'], [30, '30 min'], [45, '45 min'], [60, '1 hour'], [90, '1.5 hours'], [120, '2 hours']], (v) => data.setSettings({ defaultDuration: Number(v) }))),
        h('div.field', h('label.label', { for: 'set-theme' }, 'Appearance'),
          sel('set-theme', S.theme, [['system', 'Match device'], ['light', 'Light'], ['dark', 'Dark']], (v) => { store.set('planner.theme', v); data.setSettings({ theme: v }); }))),
      h('div.grid-2',
        h('div.field', h('label.label', { for: 'set-skin' }, 'Style'),
          sel('set-skin', S.skin || CONFIG.defaultSkin || 'blush', [['blush', 'Blush'], ['fairy', 'Fairy princess (2000s)']], (v) => data.setSettings({ skin: v }))),
        h('div.field', h('label.label', { for: 'set-hours' }, 'Open times between'),
          sel('set-hours', `${S.dayStartHour ?? 8}-${S.dayEndHour ?? 22}`,
            [['7-21', '7am – 9pm'], ['8-22', '8am – 10pm'], ['9-23', '9am – 11pm'], ['10-24', '10am – midnight']],
            (v) => { const [a, b] = v.split('-').map(Number); data.setSettings({ dayStartHour: a, dayEndHour: b }); }))),
      h('div.field',
        toggle('set-showtasks', S.showTasksOnCalendar, 'Show tasks on the calendar', (v) => data.setSettings({ showTasksOnCalendar: v })),
        toggle('set-showdone', S.showCompleted, 'Show completed tasks on the calendar', (v) => data.setSettings({ showCompleted: v }))),
      h('section.help',
        h('h3', 'Phone notifications'),
        ntfyOn(app)
          ? h('p', 'Planner notifications are on (through the ntfy app): ',
            [notifySettings(app).timer ? 'timer' : '', notifySettings(app).habits ? 'habit reminders' : '', data.settings.taskReminders === 'ntfy' ? 'task reminders' : ''].filter(Boolean).join(', ') || 'nothing selected', '.')
          : h('p', 'Get timer, habit and task alerts from the Planner itself through the free ntfy app.'),
        h('button.btn.ghost', { type: 'button', onclick: () => { s.close(); openNotifySetup(); } }, icon('bell', 18), ntfyOn(app) ? 'Notification settings' : 'Set up phone notifications'),
        h('p', `Event notifications come from Google Calendar: install the Google Calendar app and allow notifications. ${data.settings.taskReminders === 'ntfy' ? '' : `Task notifications also go through Google, using a calendar called “${REMINDER_CAL_NAME}”.`}`)),
      h('section.help',
        h('h3', 'Account'),
        backend.kind === 'google'
          ? h('p', 'Signed in as ', h('strong', backend.email || 'your Google account'), '. Your events live in Google Calendar; tasks and settings live in a hidden file in your Google Drive that only this app can see.')
          : h('p', 'You’re using the demo. Everything is stored only in this browser.'),
        h('div.row.wrap',
          backend.kind === 'google'
            ? h('button.btn.ghost', { type: 'button', onclick: async () => {
              if (!(await confirmDialog('Sign out?', 'Your data stays in your Google account.', { confirmLabel: 'Sign out', danger: false }))) return;
              backend.signOut(); store.del('planner.mode'); location.reload();
            } }, icon('logout', 18), 'Sign out')
            : [
              h('button.btn.ghost', { type: 'button', onclick: async () => {
                if (!(await confirmDialog('Reset demo?', 'This puts the sample data back and removes anything you added.', { confirmLabel: 'Reset' }))) return;
                backend.reset(); store.del('planner.data.demo'); store.del('planner.data.demo.dirty'); location.reload();
              } }, 'Reset demo data'),
              CONFIG.demoOnly ? '' : h('button.btn.ghost', { type: 'button', onclick: () => { store.del('planner.mode'); location.reload(); } }, 'Leave demo'),
            ])));
    const s = openSheet({ title: 'Settings', body, footer: [h('span.grow'), h('button.btn.primary', { type: 'button', onclick: () => s.close() }, 'Done')] });
  }

  // ---------------------------------------------------------------- phone notifications (ntfy)
  function openNotifySetup() {
    const n = notifySettings(app);
    if (!n.topic) { n.topic = newTopic(); data.setSettings({ notify: { ...n } }); }
    const topic = n.topic;
    const copyBtn = h('button.btn.ghost.small', { type: 'button', onclick: async () => {
      try { await navigator.clipboard.writeText(topic); toast('Copied'); } catch { codeEl.focus(); toast('Select the code and copy it'); }
    } }, 'Copy');
    const codeEl = h('code.copyable.topic-code', { tabindex: '0' }, topic);
    const tog = (id, checked, label) => h('label.toggle', h('input', { id, type: 'checkbox', checked }), h('span', label));
    const tTimer = tog('nt-timer', n.timer, 'Timer: break time and back-to-focus');
    const tHabits = tog('nt-habits', n.habits, 'Habit reminders');
    const tTasks = tog('nt-tasks', data.settings.taskReminders === 'ntfy', 'Task reminders (instead of Google Calendar)');
    const enabled = h('input#nt-on', { type: 'checkbox', checked: n.enabled });
    const body = h('div.stack',
      h('ol.setup-steps',
        h('li', h('strong', 'Get the ntfy app'), h('span', ' (free) from the App Store on your iPhone and iPad. Allow notifications when it asks.')),
        h('li', h('strong', 'Subscribe to your private channel.'), h('span', ' In ntfy, tap +, paste this code as the topic, and keep the server as ntfy.sh:'),
          h('div.row.topic-row', codeEl, copyBtn),
          h('span.hint', 'The code works like a password, so don’t share it.')),
        h('li', h('strong', 'Turn it on and send a test.'))),
      h('label.toggle.big-toggle', enabled, h('span', 'Send notifications from the Planner')),
      h('div.field', tTimer, tHabits, tTasks),
      h('p.hint', 'ntfy can hold notifications up to 3 days ahead, so open the Planner at least every couple of days to keep reminders queued. Event reminders stay with Google Calendar.'));
    const save = (close = true) => {
      const notify = { ...notifySettings(app), enabled: enabled.checked, topic, timer: tTimer.querySelector('input').checked, habits: tHabits.querySelector('input').checked };
      const before = data.settings.taskReminders;
      const taskReminders = tTasks.querySelector('input').checked && enabled.checked ? 'ntfy' : 'google';
      data.setSettings({ notify, taskReminders });
      if (before !== taskReminders) for (const t of data.tasks) if (t.reminder != null && t.dueTime && !t.done) syncTaskReminder(app, t);
      syncQueue(app);
      if (close) s.close();
    };
    const s = openSheet({
      title: 'Phone notifications', body, className: 'small',
      footer: [
        h('button.btn.ghost', { type: 'button', onclick: async () => { enabled.checked = true; save(false); await sendTest(app); } }, 'Send test'),
        h('span.grow'),
        h('button.btn.primary', { type: 'button', onclick: () => save() }, 'Save'),
      ],
    });
  }
  app.openNotifySetup = openNotifySetup;

  // ---------------------------------------------------------------- calendar
  function stopPlacing() {
    placing = null;
    const bar = $('#placing');
    if (bar) bar.hidden = true;
    setTimeout(() => cal.updateSize(), 0);
  }
  async function placeAt(date, allDay) {
    const { task, minutes } = placing;
    const start = new Date(date);
    if (allDay) start.setHours(9, 0, 0, 0);
    stopPlacing();
    createBlock(app, task, start, addMinutes(start, minutes));
  }
  // Re-style time blocks when their task is checked off (no need to reload from Google).
  function refreshBlockStates() {
    if (!cal) return;
    for (const ev of cal.getEvents()) {
      const p = ev.extendedProps;
      if (p.kind !== 'event' || !p.taskId) continue;
      const t = data.task(p.taskId);
      const done = !!(t && (t.done || (t.repeat && t.due && ymd(ev.start) < t.due)));
      const cls = ev.classNames.filter((x) => x !== 'is-done-block');
      if (done) cls.push('is-done-block');
      if (cls.join() !== ev.classNames.join()) ev.setProp('classNames', cls);
    }
  }

  function roundedNow() {
    const d = new Date();
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
    return d;
  }
  function newEventAt(start, end, allDay = false) {
    const dur = data.settings.defaultDuration || 60;
    openEventEditor(app, {
      start, end: end || (allDay ? addDays(start, 1) : addMinutes(start, dur)), allDay,
    });
  }

  async function openFcEvent(ev) {
    const p = ev.extendedProps;
    if (p.kind === 'task') return openTaskEditor(app, p.taskId);
    const gev = await loadForEdit(app, p.calId, p.gev);
    openEventEditor(app, { calId: p.calId, gev });
  }

  function initCalendar() {
    const narrow = isNarrow();
    const S = data.settings;
    const now = new Date();
    const c = new FullCalendar.Calendar($('#calendar'), {
      initialView: store.get('planner.view') || (innerWidth < 600 ? 'timeGridDay' : narrow ? 'timeGridThreeDay' : 'timeGridWeek'),
      views: {
        timeGridThreeDay: { type: 'timeGrid', duration: { days: 3 } },
        dayGridMonth: innerWidth < 600 ? { displayEventTime: false, eventDisplay: 'block' } : {},
        listWeek: { noEventsContent: 'Nothing scheduled this week.' },
      },
      headerToolbar: false,
      height: '100%',
      firstDay: S.weekStart || 0,
      nowIndicator: true,
      editable: true,
      selectable: true,
      selectMirror: true,
      unselectAuto: true,
      droppable: true,
      dayMaxEvents: true,
      navLinks: true,
      navLinkDayClick: (d) => { c.changeView('timeGridDay', d); store.set('planner.view', 'timeGridDay'); paintViewSwitch(); },
      slotDuration: '00:30:00',
      snapDuration: '00:15:00',
      slotLabelInterval: '01:00',
      scrollTime: `${String(Math.max(0, now.getHours() - 1)).padStart(2, '0')}:00:00`,
      scrollTimeReset: false,
      longPressDelay: 350,
      eventLongPressDelay: 350,
      selectLongPressDelay: 350,
      fixedWeekCount: false,
      allDayText: 'all day',
      eventTimeFormat: { hour: 'numeric', minute: '2-digit', meridiem: 'short', hour12: !S.clock24 },
      slotLabelFormat: { hour: 'numeric', meridiem: 'short', hour12: !S.clock24 },
      dayHeaderContent: (arg) => {
        if (!arg.view.type.startsWith('timeGrid')) return arg.text;
        return { domNodes: [h('span.dh-dow', arg.date.toLocaleDateString(undefined, { weekday: 'short' })), h('span.dh-num' + (arg.isToday ? '.is-today' : ''), String(arg.date.getDate()))] };
      },
      eventSources: [
        { id: 'google', events: fetchGoogle },
        { id: 'tasks', events: (info, ok) => ok(tasksForRange(app, info.start, info.end)) },
      ],
      loading: (on) => $('#app').classList.toggle('is-loading', on),
      eventsSet: () => { clearTimeout(tasksRerender); tasksRerender = setTimeout(() => app.renderTasks(), 50); },
      datesSet: () => {
        paintTitle();
        miniMonth = startOfDay(c.getDate());
        renderMiniCal();
      },
      eventContent: (arg) => {
        const p = arg.event.extendedProps;
        if (p.kind === 'task') {
          return {
            domNodes: [h('span.cal-task', { style: { '--c': p.color, '--fg': readableText(p.color) } },
              h('span.cal-check', { role: 'checkbox', 'aria-checked': String(arg.event.classNames.includes('is-done')), 'aria-label': 'Complete task' }, icon('check', 11)),
              arg.timeText && !arg.event.allDay && arg.view.type === 'dayGridMonth' ? h('span.cal-time', arg.timeText) : '',
              h('span.cal-task-title', arg.event.title))],
          };
        }
        if (arg.view.type.startsWith('timeGrid') && !arg.event.allDay) {
          const short = arg.event.end && arg.event.end - arg.event.start <= 45 * 60000;
          return {
            domNodes: [h('div.ev-inner' + (short ? '.short' : ''),
              h('div.ev-title', arg.event.title),
              h('div.ev-time', arg.timeText + (p.location ? ', ' + p.location : '')))],
          };
        }
        return true;
      },
      eventDidMount: (arg) => {
        const p = arg.event.extendedProps;
        arg.el.title = arg.event.title + (p.location ? `\n${p.location}` : '');
      },
      eventClick: (info) => {
        info.jsEvent.preventDefault();
        const p = info.event.extendedProps;
        if (p.kind === 'task' && info.jsEvent.target.closest('.cal-check')) {
          const t = data.task(p.taskId);
          if (t) toggleDone(app, t);
          return;
        }
        openFcEvent(info.event);
      },
      select: (info) => {
        c.unselect();
        if (placing) return placeAt(info.start, info.allDay);
        if (!app.writableCalendars().length) return toast('Add a category first.', { error: true });
        if (info.allDay && info.view.type === 'dayGridMonth' && (info.end - info.start) <= 86400000) {
          const d = new Date(info.start); d.setHours(9, 0, 0, 0);
          return newEventAt(d);
        }
        newEventAt(info.start, info.end, info.allDay);
      },
      dateClick: (info) => {
        if (lastPointer === 'mouse') return; // mouse clicks are handled by `select`
        if (placing) return placeAt(info.date, info.allDay);
        if (info.view.type === 'dayGridMonth') {
          const d = new Date(info.date); d.setHours(9, 0, 0, 0);
          return newEventAt(d);
        }
        newEventAt(info.date, null, info.allDay);
      },
      eventDrop: (info) => moved(info),
      eventResize: (info) => moved(info),
      eventReceive: async (info) => {
        const ev = info.event;
        const taskId = ev.extendedProps.taskId;
        const t = data.task(taskId);
        ev.remove();
        if (!t) return;
        const calId = app.writableCalendars().some((x) => x.id === t.calendarId) ? t.calendarId : app.lastCalendarId();
        const start = ev.start;
        const allDay = ev.allDay;
        const end = ev.end || (allDay ? addDays(start, 1) : addMinutes(start, t.estimate || data.settings.defaultDuration));
        try {
          await backend.insertEvent(calId, {
            summary: t.title,
            start: allDay ? { date: ymd(start) } : { dateTime: isoLocalStr(start), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            end: allDay ? { date: ymd(end) } : { dateTime: isoLocalStr(end), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
            reminders: { useDefault: true },
            extendedProperties: { private: { plannerTaskId: t.id } },
          });
          toast(`Blocked time for “${t.title}”`);
          app.refetch();
        } catch (e) { showError(e, 'Could not block time'); }
      },
    });
    cal = c;
    c.render();
    return c;
  }

  function paintTitle() {
    const v = cal.view;
    const el = $('#range-title');
    if (!el) return;
    let text;
    if (isNarrow()) {
      const a = v.type === 'dayGridMonth' ? addDays(v.currentStart, 10) : v.currentStart;
      const b = v.type === 'dayGridMonth' ? a : addDays(v.currentEnd, -1);
      const thisYear = a.getFullYear() === new Date().getFullYear();
      const m = (d, len) => d.toLocaleDateString(undefined, { month: len });
      text = a.getMonth() === b.getMonth() ? m(a, 'long') : `${m(a, 'short')} – ${m(b, 'short')}`;
      if (!thisYear) text += ' ' + a.getFullYear();
    } else if (v.type === 'timeGridDay') text = v.currentStart.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    else {
      const a = v.currentStart, b = addDays(v.currentEnd, -1);
      const fmt = { month: isNarrow() ? 'short' : 'long', year: 'numeric' };
      text = a.getMonth() === b.getMonth() || v.type === 'dayGridMonth'
        ? (v.type === 'dayGridMonth' ? addDays(a, 10) : a).toLocaleDateString(undefined, fmt)
        : `${a.toLocaleDateString(undefined, { month: 'short' })} – ${b.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}`;
    }
    el.textContent = text;
  }

  async function fetchGoogle(info, ok, fail) {
    const cals = app.calendars.filter((x) => app.visible(x) && !app.isReminderCal(x.id));
    try {
      const lists = await Promise.all(cals.map((x) => backend.listEvents(x.id, info.start, info.end)
        .then((evs) => evs.map((e) => toFC(e, x, app)))
        .catch((e) => { if (!fetchErrShown) { fetchErrShown = true; showError(e, `Couldn’t load ${x.name}`); } return []; })));
      ok(lists.flat());
    } catch (e) { fail(e); }
  }

  async function moved(info) {
    const ev = info.event;
    const p = ev.extendedProps;
    if (p.kind === 'task') {
      const t = data.task(p.taskId);
      if (!t) return info.revert();
      t.due = ymd(ev.start);
      t.dueTime = ev.allDay ? null : hm(ev.start);
      data.putTask(t);
      syncTaskReminder(app, t);
      return;
    }
    const gev = p.gev;
    let scope = 'this';
    if (gev.recurringEventId) {
      scope = await askScope('Save');
      if (!scope) return info.revert();
    }
    const start = ev.start;
    const end = ev.end || (ev.allDay ? addDays(start, 1) : addMinutes(start, 60));
    try {
      await saveEvent(app, p.calId, gev, { start, end, allDay: ev.allDay }, scope);
      app.refetch();
    } catch (e) {
      info.revert();
      showError(e, 'Could not move the event');
    }
  }
}

// Make task rows draggable onto the calendar to block time.
function initDraggable(app) {
  const panel = $('#taskpanel');
  new FullCalendar.Draggable(panel, {
    itemSelector: '.task-row:not(.done)',
    longPressDelay: 350,
    eventData: (el) => ({
      title: el.dataset.title,
      duration: { minutes: Number(el.dataset.duration) || 60 },
      create: true,
      backgroundColor: el.dataset.color,
      borderColor: el.dataset.color,
      extendedProps: { kind: 'drop', taskId: el.dataset.taskId },
    }),
  });
}

function isoLocalStr(d) {
  const off = -d.getTimezoneOffset(), a = Math.abs(off), p = (n) => String(n).padStart(2, '0');
  return `${ymd(d)}T${hm(d)}:00${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}

let themeSetByApp = false;
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
    themeSetByApp = true;
  } else if (themeSetByApp) {
    delete document.documentElement.dataset.theme;
    themeSetByApp = false;
  }
}

let lastApplied = '';
function applySettings(app) {
  const S = app.data.settings;
  setClock24(S.clock24);
  document.documentElement.dataset.skin = S.skin || CONFIG.defaultSkin || 'blush';
  store.set('planner.skin', document.documentElement.dataset.skin);
  applyTheme(S.theme);
  store.set('planner.theme', S.theme);
  const key = `${S.weekStart}|${S.clock24}`;
  if (app.cal && key !== lastApplied) {
    app.cal.setOption('firstDay', S.weekStart || 0);
    app.cal.setOption('eventTimeFormat', { hour: 'numeric', minute: '2-digit', meridiem: 'short', hour12: !S.clock24 });
    app.cal.setOption('slotLabelFormat', { hour: 'numeric', meridiem: 'short', hour12: !S.clock24 });
  }
  lastApplied = key;
}

// Offline support + installable app (skipped where service workers aren't allowed).
if ('serviceWorker' in navigator && location.protocol === 'https:' && !/claude|anthropic/.test(location.hostname)) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
