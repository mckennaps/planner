// Planner-sent notifications through ntfy (free app on your phone; no server of our own).
// Each notification has a fixed id ("sequence id"): re-sending replaces it, DELETE cancels it.
// ntfy holds notifications for up to 3 days, so we keep the next ~3 days queued every time the app runs.
import { uid, atTime, addDays, ymd, todayStr, debounce, relDay, fmtTime } from './util.js';
import { toast } from './ui.js';

const MAX_AHEAD = 71 * 3600 * 1000; // a little under ntfy's 3-day limit
const MIN_AHEAD = 15 * 1000;        // ntfy needs at least 10 seconds

export function notifySettings(app) {
  return { enabled: false, server: 'https://ntfy.sh', topic: null, timer: true, habits: true, ...(app.settings.notify || {}) };
}
export const ntfyOn = (app) => { const n = notifySettings(app); return !!(n.enabled && n.topic); };
export const tasksViaNtfy = (app) => ntfyOn(app) && app.settings.taskReminders === 'ntfy';

export function newTopic() {
  return 'planner-' + uid() + uid().slice(-6);
}

function appUrl() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export async function publish(app, { seq, title, message, at, tags, priority }) {
  const n = notifySettings(app);
  const body = { topic: n.topic, title, message, tags: tags || [], click: appUrl(), sequence_id: seq };
  if (priority) body.priority = priority;
  if (at) body.delay = String(Math.round(at.getTime() / 1000));
  const res = await fetch(n.server.replace(/\/$/, '') + '/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ntfy said ${res.status}`);
}

export async function cancel(app, seq) {
  const n = notifySettings(app);
  const res = await fetch(`${n.server.replace(/\/$/, '')}/${encodeURIComponent(n.topic)}/${encodeURIComponent(seq)}`, { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error(`ntfy said ${res.status}`);
}

// ---- the queue of upcoming task / habit notifications ----
function desired(app) {
  const now = Date.now();
  const out = new Map();
  const inWindow = (d) => d.getTime() - now > MIN_AHEAD && d.getTime() - now < MAX_AHEAD;
  if (tasksViaNtfy(app)) {
    for (const t of app.data.tasks) {
      if (t.done || !t.due || !t.dueTime || t.reminder == null) continue;
      const due = atTime(t.due, t.dueTime);
      const at = new Date(due.getTime() - t.reminder * 60000);
      if (!inWindow(at)) continue;
      const when = t.reminder === 0 ? 'Due now' : `Due ${relDay(t.due).toLowerCase()} at ${fmtTime(due)}`;
      out.set(`task-${t.id}`, { at, title: t.title, message: when, tags: ['white_check_mark'] });
    }
  }
  if (notifySettings(app).habits) {
    for (const hb of app.data.list('habits')) {
      if (hb.archived || !hb.reminder) continue;
      for (let i = 0; i < 4; i++) {
        const day = ymd(addDays(new Date(), i));
        if (!habitDueOn(hb, day) || (hb.log && (hb.log[day] || 0) >= (hb.goal || 1))) continue;
        const at = atTime(day, hb.reminder);
        if (!inWindow(at)) continue;
        out.set(`habit-${hb.id}-${day.replace(/-/g, '')}`, { at, title: hb.name, message: 'Habit check-in', tags: ['sparkles'] });
      }
    }
  }
  return out;
}

export function habitDueOn(hb, dateStr) {
  const s = hb.schedule || { type: 'daily' };
  if (s.type === 'days') return (s.days || []).includes(new Date(dateStr + 'T12:00').getDay());
  return true; // daily, or "N times a week" (any day counts)
}

const hashOf = (m) => `${m.at.getTime()}|${m.title}|${m.message}`;
let syncing = false;

export async function syncQueue(app) {
  if (!ntfyOn(app) || syncing) return;
  syncing = true;
  try {
    const want = desired(app);
    const have = new Map(app.data.list('pushq').map((q) => [q.id, q]));
    const now = Date.now();
    for (const [seq, m] of want) {
      const cur = have.get(seq);
      if (cur && cur.hash === hashOf(m)) continue;
      await publish(app, { seq, ...m });
      app.data.put('pushq', { id: seq, at: m.at.getTime(), hash: hashOf(m) });
    }
    for (const [seq, q] of have) {
      if (want.has(seq)) continue;
      if (q.at > now) { try { await cancel(app, seq); } catch (e) { console.warn(e); } }
      app.data.remove('pushq', seq);
    }
  } catch (e) {
    console.warn('Could not update ntfy notifications', e);
  } finally {
    syncing = false;
  }
}
export const syncQueueSoon = debounce((app) => syncQueue(app), 2500);

export async function sendTest(app) {
  try {
    await publish(app, { seq: 'test-' + uid(), title: 'Planner ✦', message: 'Notifications are working!', tags: ['butterfly'] });
    toast('Test sent. Check your phone.');
  } catch (e) {
    toast('Couldn’t reach ntfy: ' + e.message, { error: true });
  }
}
