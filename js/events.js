// Calendar events: mapping to the calendar view, scoped edits of repeating events, and the event editor.
import { h, ymd, hm, parseYmd, atTime, addDays, addMinutes, isoLocal, TZ, EVENT_COLORS, readableText, fmtTime, relDay } from './util.js';
import { openSheet, choose, confirmDialog, toast, showError, icon } from './ui.js';
import { repeatPicker, endRuleBefore, withoutCount, parseRule, buildRule } from './recurrence.js';

// ---------- time helpers ----------
export const evStart = (e) => (e.start.date ? parseYmd(e.start.date) : new Date(e.start.dateTime));
export const evEnd = (e) => (e.end.date ? parseYmd(e.end.date) : new Date(e.end.dateTime));
const origStart = (e) => (e.originalStartTime ? (e.originalStartTime.date ? parseYmd(e.originalStartTime.date) : new Date(e.originalStartTime.dateTime)) : evStart(e));

// For insert (no nulls) and patch (null clears the other form).
function times(start, end, allDay, forPatch) {
  if (allDay) {
    const s = { date: ymd(start) }, e = { date: ymd(end) };
    if (forPatch) { s.dateTime = null; s.timeZone = null; e.dateTime = null; e.timeZone = null; }
    return { start: s, end: e };
  }
  const s = { dateTime: isoLocal(start), timeZone: TZ }, e = { dateTime: isoLocal(end), timeZone: TZ };
  if (forPatch) { s.date = null; e.date = null; }
  return { start: s, end: e };
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
// Shift BYDAY codes when a weekly series is moved to a different day.
function shiftRuleDays(rule, dayDelta) {
  if (!dayDelta || !rule) return rule;
  const o = parseRule(rule);
  if (o.FREQ !== 'WEEKLY' || !o.BYDAY) return rule;
  o.BYDAY = o.BYDAY.split(',').map((c) => DAY_CODES[(DAY_CODES.indexOf(c.slice(-2)) + ((dayDelta % 7) + 7)) % 7]).join(',');
  return buildRule(o);
}
const dayDiff = (a, b) => Math.round((parseYmd(ymd(b)) - parseYmd(ymd(a))) / 86400000);

// Strip server fields so an event can be inserted as a new one.
function cleanCopy(e) {
  const c = structuredClone(e);
  for (const k of ['id', 'etag', 'iCalUID', 'htmlLink', 'created', 'updated', 'recurringEventId', 'originalStartTime', 'sequence', 'creator', 'organizer', 'kind', 'status', 'hangoutLink', 'conferenceData']) delete c[k];
  return c;
}

const ruleOf = (master) => ((master.recurrence || []).find((r) => r.startsWith('RRULE:')) || '').slice(6);

// ---------- scoped save / delete ----------
// changes: { fields, start, end, allDay, calId }
export async function saveEvent(app, calId, gev, changes, scope) {
  const B = app.backend;
  const fields = { ...(changes.fields || {}) };
  const hasTime = !!changes.start;
  const dest = changes.calId && changes.calId !== calId ? changes.calId : null;

  if (!gev.recurringEventId || scope === 'this') {
    const patch = { ...fields, ...(hasTime ? times(changes.start, changes.end, changes.allDay, true) : {}) };
    if (gev.recurringEventId) {
      delete patch.recurrence;
      if (dest) {
        const full = await B.getEvent(calId, gev.id);
        const copy = cleanCopy(full);
        Object.assign(copy, fields, hasTime ? times(changes.start, changes.end, changes.allDay) : {});
        delete copy.recurrence;
        await B.insertEvent(dest, copy);
        await B.deleteEvent(calId, gev.id);
        return;
      }
    } else if (patch.recurrence && !patch.recurrence.length) {
      patch.recurrence = null;
    }
    if (Object.keys(patch).length) await B.patchEvent(calId, gev.id, patch);
    if (dest) await B.moveEvent(calId, gev.id, dest);
    return;
  }

  const master = await B.getEvent(calId, gev.recurringEventId);
  const instStart = origStart(gev);
  const isFirst = Math.abs(instStart - evStart(master)) < 1000;
  const curStart = evStart(gev);
  const dDays = hasTime ? dayDiff(curStart, changes.start) : 0;

  if (scope === 'all' || isFirst) {
    const patch = { ...fields };
    if (hasTime) {
      const mStart0 = evStart(master);
      let mStart;
      if (changes.allDay) mStart = addDays(parseYmd(ymd(mStart0)), dDays);
      else {
        mStart = addDays(new Date(mStart0), dDays);
        mStart.setHours(changes.start.getHours(), changes.start.getMinutes(), 0, 0);
      }
      const len = changes.allDay ? Math.max(1, dayDiff(changes.start, changes.end)) : changes.end - changes.start;
      const mEnd = changes.allDay ? addDays(mStart, len) : new Date(mStart.getTime() + len);
      Object.assign(patch, times(mStart, mEnd, changes.allDay, true));
      if (!('recurrence' in fields) && dDays) {
        const r = shiftRuleDays(ruleOf(master), dDays);
        patch.recurrence = (master.recurrence || []).map((x) => (x.startsWith('RRULE:') ? 'RRULE:' + r : x));
      }
    }
    if (patch.recurrence && !patch.recurrence.length) patch.recurrence = null;
    await B.patchEvent(calId, master.id, patch);
    if (dest) await B.moveEvent(calId, master.id, dest);
    return;
  }

  // scope === 'following': end the old series, start a new one at this instance
  const rule = ruleOf(master);
  const allDayOld = !!master.start.date;
  const oldRecurrence = (master.recurrence || []).map((x) => (x.startsWith('RRULE:') ? 'RRULE:' + endRuleBefore(rule, instStart, allDayOld) : x));
  const fresh = cleanCopy(master);
  Object.assign(fresh, fields);
  const allDay = hasTime ? changes.allDay : !!gev.start.date;
  Object.assign(fresh, hasTime ? times(changes.start, changes.end, allDay) : times(evStart(gev), evEnd(gev), allDay));
  if (!('recurrence' in fields)) fresh.recurrence = ['RRULE:' + shiftRuleDays(withoutCount(rule), dDays)];
  if (!fresh.recurrence || !fresh.recurrence.length) delete fresh.recurrence;
  await B.patchEvent(calId, master.id, { recurrence: oldRecurrence });
  await B.insertEvent(dest || calId, fresh);
}

export async function deleteEvent(app, calId, gev, scope) {
  const B = app.backend;
  if (!gev.recurringEventId || scope === 'this') return B.deleteEvent(calId, gev.id);
  const master = await B.getEvent(calId, gev.recurringEventId);
  const instStart = origStart(gev);
  if (scope === 'all' || Math.abs(instStart - evStart(master)) < 1000) return B.deleteEvent(calId, master.id);
  const rule = ruleOf(master);
  const rec = (master.recurrence || []).map((x) => (x.startsWith('RRULE:') ? 'RRULE:' + endRuleBefore(rule, instStart, !!master.start.date) : x));
  return B.patchEvent(calId, master.id, { recurrence: rec });
}

export function askScope(verb, { allowThis = true } = {}) {
  const opts = [];
  if (allowThis) opts.push({ value: 'this', label: 'This event' });
  opts.push({ value: 'following', label: 'This and following events' });
  opts.push({ value: 'all', label: 'All events' });
  return choose(`${verb} repeating event`, opts, { confirmLabel: verb === 'Delete' ? 'Delete' : 'Save' });
}

// ---------- mapping for FullCalendar ----------
export function toFC(gev, cal) {
  const color = gev.colorId && EVENT_COLORS[gev.colorId] ? EVENT_COLORS[gev.colorId][1] : cal.color;
  const declined = (gev.attendees || []).some((a) => a.self && a.responseStatus === 'declined');
  const taskId = gev.extendedProperties && gev.extendedProperties.private && gev.extendedProperties.private.plannerTaskId;
  return {
    id: `${cal.id}::${gev.id}`,
    title: gev.summary || '(No title)',
    start: gev.start.dateTime || gev.start.date,
    end: gev.end.dateTime || gev.end.date,
    allDay: !!gev.start.date,
    backgroundColor: color,
    borderColor: color,
    textColor: readableText(color),
    editable: cal.writable,
    classNames: [declined ? 'is-declined' : '', taskId ? 'is-block' : ''].filter(Boolean),
    extendedProps: { kind: 'event', calId: cal.id, gev, taskId, location: gev.location || '' },
  };
}

// ---------- editor ----------
const REMINDER_UNITS = [['minutes', 1], ['hours', 60], ['days', 1440], ['weeks', 10080]];
function splitMinutes(min) {
  for (let i = REMINDER_UNITS.length - 1; i >= 0; i--) {
    const [u, f] = REMINDER_UNITS[i];
    if (min >= f && min % f === 0) return [min / f, u];
  }
  return [min, 'minutes'];
}

// opts: { calId, gev } for existing; { start, end, allDay, calId, title, taskId } for new
export function openEventEditor(app, opts) {
  const existing = opts.gev || null;
  const writableCals = app.writableCalendars();
  let calId = opts.calId || (existing ? null : app.lastCalendarId()) || (writableCals[0] && writableCals[0].id);
  const cal = app.calendar(calId);
  const readOnly = existing && cal && !cal.writable;

  let start = existing ? evStart(existing) : opts.start;
  let end = existing ? evEnd(existing) : opts.end;
  let allDay = existing ? !!existing.start.date : !!opts.allDay;
  if (allDay) end = addDays(end, -1); // show inclusive end date in the form

  const title = h('input.input.title-input#ev-title', { type: 'text', placeholder: 'Add title', value: existing ? existing.summary || '' : opts.title || '', autofocus: !existing, 'aria-label': 'Title' });
  const sDate = h('input.input#ev-sdate', { type: 'date', value: ymd(start), 'aria-label': 'Start date' });
  const sTime = h('input.input#ev-stime', { type: 'time', value: hm(start), step: '300', 'aria-label': 'Start time' });
  const eDate = h('input.input#ev-edate', { type: 'date', value: ymd(end), 'aria-label': 'End date' });
  const eTime = h('input.input#ev-etime', { type: 'time', value: hm(end), step: '300', 'aria-label': 'End time' });
  const allDayBox = h('input#ev-allday', { type: 'checkbox', checked: allDay });

  const readStart = () => (allDayBox.checked ? parseYmd(sDate.value) : atTime(sDate.value, sTime.value));
  const readEnd = () => (allDayBox.checked ? addDays(parseYmd(eDate.value), 1) : atTime(eDate.value, eTime.value));
  let lastStart = readStart();
  const keepDuration = () => {
    const ns = readStart();
    const delta = ns - lastStart;
    if (!isNaN(delta) && delta) {
      const ne = new Date(readEnd().getTime() + delta);
      eDate.value = ymd(allDayBox.checked ? addDays(ne, -1) : ne);
      if (!allDayBox.checked) eTime.value = hm(ne);
    }
    lastStart = ns;
    repeat.refresh();
  };
  sDate.addEventListener('change', keepDuration);
  sTime.addEventListener('change', keepDuration);
  const syncAllDay = () => {
    sTime.hidden = eTime.hidden = allDayBox.checked;
    lastStart = readStart();
  };
  allDayBox.addEventListener('change', syncAllDay);

  // repeat
  let initialRule = '';
  if (existing) {
    const src = existing.recurrence || (existing._masterRecurrence || null);
    initialRule = src ? (src.find((r) => r.startsWith('RRULE:')) || '').slice(6) : '';
  }
  const repeat = repeatPicker(() => readStart(), initialRule, { allDay: () => allDayBox.checked });

  // category
  const catSel = h('select.input#ev-cal', { 'aria-label': 'Category' },
    (readOnly ? [cal] : writableCals).map((c) => h('option', { value: c.id, selected: c.id === calId }, c.name)));
  const catDot = h('span.cat-dot');
  const paintDot = () => { const c = app.calendar(catSel.value); catDot.style.background = c ? c.color : '#999'; };
  catSel.addEventListener('change', () => { paintDot(); paintSwatches(); renderReminders(true); });
  paintDot();

  // per-event color
  let colorId = existing && existing.colorId ? String(existing.colorId) : '';
  const swatches = h('div.swatches', { role: 'radiogroup', 'aria-label': 'Event color' });
  function paintSwatches() {
    const c = app.calendar(catSel.value);
    swatches.replaceChildren(
      h('button.swatch', { type: 'button', role: 'radio', 'aria-checked': String(!colorId), title: 'Category color', style: { background: c ? c.color : '#999' }, onclick: () => { colorId = ''; paintSwatches(); } }),
      ...Object.entries(EVENT_COLORS).map(([id, [name, hex]]) =>
        h('button.swatch', { type: 'button', role: 'radio', 'aria-checked': String(colorId === id), title: name, style: { background: hex }, onclick: () => { colorId = id; paintSwatches(); } })));
  }
  paintSwatches();

  // reminders
  let useDefault = existing ? !(existing.reminders && existing.reminders.useDefault === false) : true;
  let rems = existing && existing.reminders && existing.reminders.useDefault === false ? (existing.reminders.overrides || []).map((r) => r.minutes) : null;
  const remBox = h('div.stack-sm');
  function renderReminders(calChanged) {
    const c = app.calendar(catSel.value);
    if (useDefault || rems == null) rems = ((c && c.defaultReminders) || []).filter((r) => r.method === 'popup').map((r) => r.minutes);
    if (calChanged && useDefault) rems = ((c && c.defaultReminders) || []).map((r) => r.minutes);
    remBox.replaceChildren(...rems.map((min, i) => {
      const [n, u] = splitMinutes(min);
      const num = h('input.input.num', { type: 'number', min: '0', max: '40320', value: String(n), 'aria-label': 'Reminder amount' });
      const unit = h('select.input', { 'aria-label': 'Reminder unit' }, REMINDER_UNITS.map(([name]) => h('option', { value: name, selected: name === u }, name)));
      const upd = () => { useDefault = false; rems[i] = Math.min(40320, (Number(num.value) || 0) * REMINDER_UNITS.find((x) => x[0] === unit.value)[1]); };
      num.addEventListener('input', upd); unit.addEventListener('change', upd);
      return h('div.row.rem-row', icon('bell', 18), num, unit, h('span.muted', 'before'),
        h('button.icon-btn', { type: 'button', 'aria-label': 'Remove reminder', onclick: () => { useDefault = false; rems.splice(i, 1); renderReminders(); } }, icon('x', 18)));
    }), rems.length < 5 ? h('button.link-btn', { type: 'button', onclick: () => { useDefault = false; rems.push(rems.length ? 60 : 10); renderReminders(); } }, '+ Add notification') : '');
  }
  renderReminders();

  const location = h('input.input#ev-loc', { type: 'text', placeholder: 'Add location', value: existing ? existing.location || '' : '', 'aria-label': 'Location' });
  const desc = h('textarea.input#ev-desc', { rows: '3', placeholder: 'Add description', 'aria-label': 'Description' });
  desc.value = existing ? stripHtml(existing.description || '') : '';

  const taskId = existing ? existing.extendedProperties && existing.extendedProperties.private && existing.extendedProperties.private.plannerTaskId : opts.taskId;
  const linked = taskId && app.data.task(taskId);

  const body = h('div.stack.editor',
    title,
    linked ? h('button.linked-task', { type: 'button', onclick: () => { s.close(); app.openTask(linked.id); } }, icon('check', 16), h('span', 'Time block for '), h('strong', linked.title)) : '',
    h('div.field',
      h('div.row.wrap', h('label.toggle', allDayBox, h('span', 'All day'))),
      h('div.row.wrap.datetime', h('span.dt-label', 'Starts'), sDate, sTime),
      h('div.row.wrap.datetime', h('span.dt-label', 'Ends'), eDate, eTime)),
    h('div.field', h('label.label', { for: 'ev-repeat' }, icon('repeat', 16), 'Repeat'), repeat.el),
    h('div.field', h('label.label', { for: 'ev-cal' }, catDot, 'Category'), catSel),
    h('div.field', h('span.label', icon('palette', 16), 'Color'), swatches),
    h('div.field', h('span.label', icon('bell', 16), 'Notifications'), remBox),
    h('div.field', h('label.label', { for: 'ev-loc' }, icon('pin', 16), 'Location'), location),
    h('div.field', h('label.label', { for: 'ev-desc' }, icon('note', 16), 'Description'), desc));
  repeat.el.id = 'ev-repeat';
  syncAllDay();
  if (readOnly) body.querySelectorAll('input,select,textarea,button.swatch').forEach((x) => { x.disabled = true; });

  async function save() {
    const st = readStart(), en = readEnd();
    if (isNaN(st) || isNaN(en)) return toast('Pick a valid start and end.', { error: true });
    if (en <= st) return toast('The end has to be after the start.', { error: true });
    const fields = {
      summary: title.value.trim(),
      location: location.value.trim() || null,
      description: desc.value.trim() || null,
      colorId: colorId || null,
      reminders: useDefault ? { useDefault: true } : { useDefault: false, overrides: rems.map((m) => ({ method: 'popup', minutes: m })) },
    };
    const newRule = repeat.value;
    const targetCal = catSel.value;
    app.rememberCalendar(targetCal);
    saveBtn.disabled = true;
    try {
      if (!existing) {
        const ev = { ...fields, ...times(st, en, allDayBox.checked) };
        for (const k of Object.keys(ev)) if (ev[k] == null) delete ev[k];
        if (newRule) ev.recurrence = ['RRULE:' + newRule];
        if (opts.taskId) ev.extendedProperties = { private: { plannerTaskId: opts.taskId } };
        await app.backend.insertEvent(targetCal, ev);
        toast('Event saved');
      } else {
        const ruleChanged = newRule !== initialRule;
        if (ruleChanged) fields.recurrence = newRule ? ['RRULE:' + newRule] : [];
        let scope = 'this';
        if (existing.recurringEventId) {
          scope = await askScope('Save', { allowThis: !ruleChanged });
          if (!scope) { saveBtn.disabled = false; return; }
        }
        const timeChanged = +st !== +evStart(existing) || +en !== +evEnd(existing) || allDayBox.checked !== !!existing.start.date;
        await saveEvent(app, calId, existing, { fields, calId: targetCal, ...(timeChanged ? { start: st, end: en, allDay: allDayBox.checked } : {}) }, scope);
        toast('Event saved');
      }
      s.close();
      app.refetch();
    } catch (e) {
      saveBtn.disabled = false;
      showError(e, 'Could not save');
    }
  }

  async function remove() {
    let scope = 'this';
    if (existing.recurringEventId) {
      scope = await askScope('Delete');
      if (!scope) return;
    }
    try {
      await deleteEvent(app, calId, existing, scope);
      s.close();
      app.refetch();
      if (!existing.recurringEventId) {
        toast('Event deleted', {
          action: 'Undo',
          onAction: async () => {
            try { await app.backend.insertEvent(calId, cleanCopy(existing)); app.refetch(); } catch (e) { showError(e, 'Could not restore'); }
          },
        });
      } else toast('Event deleted');
    } catch (e) { showError(e, 'Could not delete'); }
  }

  const saveBtn = h('button.btn.primary', { type: 'button', onclick: save }, 'Save');
  const footer = readOnly
    ? [h('span.muted.grow', 'This calendar is read-only.'), h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Close')]
    : [
      existing ? h('button.btn.ghost.danger-text', { type: 'button', onclick: remove }, icon('trash', 18), 'Delete') : '',
      h('span.grow'),
      h('button.btn.ghost', { type: 'button', onclick: () => s.close() }, 'Cancel'),
      saveBtn,
    ];
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  const s = openSheet({ title: existing ? 'Edit event' : 'New event', body, footer });
  return s;
}

// For a repeating instance, fetch the series rule so the editor can show it.
export async function loadForEdit(app, calId, gev) {
  if (!gev.recurringEventId) return gev;
  try {
    const master = await app.backend.getEvent(calId, gev.recurringEventId);
    return { ...gev, _masterRecurrence: master.recurrence || null };
  } catch { return gev; }
}

function stripHtml(s) {
  if (!/<[a-z][\s\S]*>/i.test(s)) return s;
  const d = document.createElement('div');
  d.innerHTML = s.replace(/<br\s*\/?>/gi, '\n');
  return d.textContent;
}

// Short preview popover content (used on tap before editing).
export function eventSummary(app, calId, gev) {
  const cal = app.calendar(calId);
  const s = evStart(gev), e = evEnd(gev);
  const when = gev.start.date
    ? (dayDiff(s, e) > 1 ? `${relDay(ymd(s))} – ${relDay(ymd(addDays(e, -1)))}` : relDay(ymd(s)))
    : `${relDay(ymd(s))}, ${fmtTime(s)} – ${fmtTime(e)}`;
  return { cal, when };
}
export { addMinutes };
