// Demo backend: same interface as GoogleBackend, everything stored in this browser.
// Mirrors Google's recurring-event semantics (instances, exceptions, cancellations).
import { store, uid, ymd, parseYmd, addDays, isoLocal, startOfDay } from './util.js';
import { occurrences } from './recurrence.js';

const KEY = 'planner.demo';

export class LocalBackend {
  constructor() {
    this.kind = 'demo';
    this.db = store.get(KEY) || seed();
    this.save();
  }
  save() { store.set(KEY, this.db); }
  reset() { this.db = seed(); this.save(); }

  get signedIn() { return true; }
  get email() { return 'Demo'; }
  handleRedirect() { return null; }
  ensureFresh() {}
  signOut() {}
  async replayPending() { return 0; }

  // ---------- calendars ----------
  async listCalendars() { return structuredClone(this.db.calendars); }
  async createCalendar(name, color) {
    const c = { id: 'cal-' + uid(), name, color, role: 'owner', writable: true, primary: false, selected: true, defaultReminders: [{ method: 'popup', minutes: 10 }] };
    this.db.calendars.push(c);
    this.db.events[c.id] = [];
    this.save();
    return structuredClone(c);
  }
  async updateCalendar(cal, { name, color }) {
    const c = this.db.calendars.find((x) => x.id === cal.id);
    if (!c) return;
    if (name != null) c.name = name;
    if (color) c.color = color;
    this.save();
  }
  async deleteCalendar(cal) {
    this.db.calendars = this.db.calendars.filter((x) => x.id !== cal.id);
    delete this.db.events[cal.id];
    this.save();
  }

  // ---------- events ----------
  list(calId) { return (this.db.events[calId] ||= []); }

  async listEvents(calId, from, to) {
    const evs = this.list(calId);
    const exceptions = new Map(evs.filter((e) => e.recurringEventId).map((e) => [e.id, e]));
    const out = [];
    const overlaps = (e) => startOf(e) < to && endOf(e) > from;
    for (const m of evs) {
      if (m.recurringEventId || m.status === 'cancelled') continue;
      const rule = (m.recurrence || []).find((r) => r.startsWith('RRULE:'));
      if (!rule) { if (overlaps(m)) out.push(m); continue; }
      const s = startOf(m), allDay = !!m.start.date;
      const durMs = endOf(m) - s;
      const durDays = allDay ? Math.round(durMs / 86400000) : 0;
      for (const st of occurrences(rule, s, new Date(from.getTime() - durMs), to)) {
        const iid = instanceId(m, st);
        const ex = exceptions.get(iid);
        if (ex) { if (ex.status !== 'cancelled' && overlaps(ex)) out.push(ex); continue; }
        const inst = { ...m, id: iid, recurringEventId: m.id, originalStartTime: timeObj(st, allDay) };
        delete inst.recurrence;
        inst.start = timeObj(st, allDay);
        inst.end = timeObj(allDay ? addDays(st, durDays) : new Date(st.getTime() + durMs), allDay);
        if (overlaps(inst)) out.push(inst);
      }
    }
    return structuredClone(out);
  }

  find(calId, id) { return this.list(calId).find((e) => e.id === id); }

  // Build an un-stored instance from its id, e.g. "abc_20261014T130000Z"
  synth(calId, id) {
    const i = id.lastIndexOf('_');
    if (i < 0) return null;
    const master = this.find(calId, id.slice(0, i));
    if (!master) return null;
    const stamp = id.slice(i + 1);
    const allDay = !!master.start.date;
    let st;
    if (allDay) st = parseYmd(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`);
    else st = new Date(Date.UTC(+stamp.slice(0, 4), +stamp.slice(4, 6) - 1, +stamp.slice(6, 8), +stamp.slice(9, 11), +stamp.slice(11, 13), +stamp.slice(13, 15)));
    const durMs = endOf(master) - startOf(master);
    const inst = { ...structuredClone(master), id, recurringEventId: master.id, originalStartTime: timeObj(st, allDay) };
    delete inst.recurrence;
    inst.start = timeObj(st, allDay);
    inst.end = timeObj(allDay ? addDays(st, Math.round(durMs / 86400000)) : new Date(st.getTime() + durMs), allDay);
    return inst;
  }

  async getEvent(calId, id) {
    const e = this.find(calId, id) || this.synth(calId, id);
    if (!e) throw Object.assign(new Error('Event not found'), { status: 404 });
    return structuredClone(e);
  }
  async insertEvent(calId, ev) {
    const e = { ...structuredClone(ev), id: uid(), status: 'confirmed' };
    this.list(calId).push(e);
    this.save();
    return structuredClone(e);
  }
  async patchEvent(calId, id, patch) {
    let e = this.find(calId, id);
    if (!e) {
      e = this.synth(calId, id);
      if (!e) throw Object.assign(new Error('Event not found'), { status: 404 });
      this.list(calId).push(e);
    }
    merge(e, structuredClone(patch));
    this.save();
    return structuredClone(e);
  }
  async deleteEvent(calId, id) {
    const list = this.list(calId);
    const e = list.find((x) => x.id === id);
    if (e && !e.recurringEventId) {
      this.db.events[calId] = list.filter((x) => x.id !== id && x.recurringEventId !== id);
    } else if (e) {
      e.status = 'cancelled';
    } else {
      const inst = this.synth(calId, id);
      if (inst) { inst.status = 'cancelled'; list.push(inst); }
    }
    this.save();
  }
  async moveEvent(calId, id, destId) {
    const list = this.list(calId);
    const moving = list.filter((x) => x.id === id || x.recurringEventId === id);
    this.db.events[calId] = list.filter((x) => !moving.includes(x));
    this.list(destId).push(...moving);
    this.save();
    return structuredClone(moving.find((x) => x.id === id));
  }

  // ---------- app data ----------
  async loadData() { return structuredClone(this.db.data || null); }
  async saveData(data) { this.db.data = structuredClone(data); this.save(); }
}

// ---------- helpers ----------
const startOf = (e) => (e.start.date ? parseYmd(e.start.date) : new Date(e.start.dateTime));
const endOf = (e) => (e.end.date ? parseYmd(e.end.date) : new Date(e.end.dateTime));
const timeObj = (d, allDay) => (allDay ? { date: ymd(d) } : { dateTime: isoLocal(d), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
function instanceId(m, st) {
  if (m.start.date) return `${m.id}_${ymd(st).replace(/-/g, '')}`;
  return `${m.id}_${st.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;
}
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete target[k];
    else if (typeof v === 'object' && !Array.isArray(v) && typeof target[k] === 'object' && target[k] && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
}

// ---------- sample data for the demo ----------
function seed() {
  const today = startOfDay(new Date());
  const monday = addDays(today, -((today.getDay() + 6) % 7));
  const at = (dayOffset, h, m = 0) => { const d = addDays(monday, dayOffset); d.setHours(h, m, 0, 0); return d; };
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const T = (d) => ({ dateTime: isoLocal(d), timeZone: tz });
  const cal = (id, name, color, primary = false) => ({ id, name, color, role: 'owner', writable: true, primary, selected: true, defaultReminders: [{ method: 'popup', minutes: 10 }] });
  const calendars = [
    cal('personal', 'Personal', '#039be5', true),
    cal('bio', 'BIO 201', '#33b679'),
    cal('chem', 'CHEM 110', '#f4511e'),
    cal('eng', 'ENG 105', '#8e24aa'),
    cal('work', 'Work', '#616161'),
    cal('gym', 'Gym', '#e67c73'),
  ];
  const ev = (summary, s, e, extra = {}) => ({ id: uid(), status: 'confirmed', summary, start: T(s), end: T(e), reminders: { useDefault: true }, ...extra });
  const allDay = (summary, d0, d1, extra = {}) => ({ id: uid(), status: 'confirmed', summary, start: { date: ymd(addDays(monday, d0)) }, end: { date: ymd(addDays(monday, d1)) }, reminders: { useDefault: false, overrides: [] }, ...extra });
  const events = {
    personal: [
      ev('Lunch with Maya', at(1, 12), at(1, 13), { location: 'Bluebird Cafe' }),
      ev('Dentist', at(3, 15, 30), at(3, 16, 30), { reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] } }),
      allDay('Mom’s birthday', 5, 6),
      allDay('Fall break', 11, 13),
    ],
    bio: [
      ev('BIO 201 lecture', at(0, 9), at(0, 9, 50), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'], location: 'Sci Hall 104' }),
      ev('BIO study group', at(2, 13, 30), at(2, 15), {}),
    ],
    chem: [
      ev('CHEM 110 lecture', at(1, 11), at(1, 12, 15), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'] }),
      ev('CHEM lab', at(3, 14), at(3, 17), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'] }),
      ev('CHEM midterm', at(8, 11), at(8, 12, 15), { colorId: '11' }),
    ],
    eng: [
      ev('ENG 105 seminar', at(0, 13), at(0, 14, 15), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'] }),
      ev('Office hours', at(2, 14), at(2, 15), {}),
    ],
    work: [
      ev('Library shift', at(5, 10), at(5, 15), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SA'] }),
    ],
    gym: [
      ev('Gym', at(0, 7), at(0, 8), { recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR'] }),
    ],
  };
  const now = Date.now();
  const d = (n) => ymd(addDays(today, n));
  const task = (title, extra) => ({ id: uid(), title, notes: '', calendarId: 'personal', due: null, dueTime: null, priority: 0, subtasks: [], repeat: '', reminder: null, estimate: null, done: false, doneAt: null, createdAt: now, updatedAt: now, ...extra });
  const tasks = [
    task('Read chapter 7', { calendarId: 'bio', due: d(0), estimate: 60, priority: 2 }),
    task('Problem set 5', { calendarId: 'chem', due: d(1), dueTime: '23:59', reminder: 120, estimate: 90, priority: 3,
      subtasks: [{ id: uid(), title: 'Questions 1–6', done: true }, { id: uid(), title: 'Questions 7–12', done: false }, { id: uid(), title: 'Check answers', done: false }] }),
    task('Lab report draft', { calendarId: 'chem', due: d(3), estimate: 120, priority: 2 }),
    task('Essay outline', { calendarId: 'eng', due: d(5), estimate: 45 }),
    task('Pay phone bill', { due: d(4), repeat: 'FREQ=MONTHLY;BYMONTHDAY=' + addDays(today, 4).getDate(), repeatAnchor: d(4) }),
    task('Email advisor about spring classes', {}),
    task('Laundry', { due: d(-1), repeat: 'FREQ=WEEKLY;BYDAY=' + ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][addDays(today, -1).getDay()], repeatAnchor: d(-1) }),
  ];
  return {
    calendars, events,
    data: { version: 1, tasks: Object.fromEntries(tasks.map((t) => [t.id, t])), settings: { updatedAt: 0 } },
  };
}
