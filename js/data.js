// Tasks, settings and future collections. Cached in this browser, synced to the backend
// (a hidden file in your Google Drive) with per-item "newest wins" merging.
import { store, uid, debounce } from './util.js';

const COLLECTIONS = ['tasks', 'projects', 'habits', 'rewards', 'journal', 'logs', 'pushq'];
const TOMBSTONE_TTL = 60 * 86400000;

export const DEFAULT_SETTINGS = {
  weekStart: 0,          // 0 = Sunday, 1 = Monday
  clock24: false,
  defaultDuration: 60,   // minutes
  showTasksOnCalendar: true,
  showCompleted: true,
  theme: 'system',       // system | light | dark
  reminderCalendarId: null,
  calVisibility: {},
  taskReminders: 'google', // 'google' | 'ntfy'
  notify: null,          // ntfy settings, see notify.js
  timer: null,           // timer lengths, see timer.js     // calendar id -> shown? (falls back to Google's setting)
};

function empty() {
  const d = { version: 1, settings: { ...DEFAULT_SETTINGS, updatedAt: 0 } };
  for (const c of COLLECTIONS) d[c] = {};
  return d;
}
function normalize(d) {
  const base = empty();
  if (!d || typeof d !== 'object') return base;
  for (const c of COLLECTIONS) base[c] = d[c] && typeof d[c] === 'object' ? d[c] : {};
  base.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
  return base;
}

export function mergeData(a, b) {
  a = normalize(a); b = normalize(b);
  const out = empty();
  const now = Date.now();
  for (const c of COLLECTIONS) {
    const ids = new Set([...Object.keys(a[c]), ...Object.keys(b[c])]);
    for (const id of ids) {
      const x = a[c][id], y = b[c][id];
      const win = !x ? y : !y ? x : (y.updatedAt || 0) > (x.updatedAt || 0) ? y : x;
      if (win.deleted && now - (win.updatedAt || 0) > TOMBSTONE_TTL) continue;
      out[c][id] = win;
    }
  }
  out.settings = (b.settings.updatedAt || 0) > (a.settings.updatedAt || 0) ? b.settings : a.settings;
  return out;
}

export class DataStore extends EventTarget {
  constructor(backend) {
    super();
    this.backend = backend;
    this.key = 'planner.data.' + backend.kind;
    this.data = normalize(store.get(this.key));
    this.status = 'idle';
    this.pushSoon = debounce(() => this.push(), 1200);
    this.pending = store.get(this.key + '.dirty', false);
  }

  setStatus(s) {
    this.status = s;
    this.dispatchEvent(new CustomEvent('status', { detail: s }));
  }
  emit() { this.dispatchEvent(new Event('change')); }
  saveLocal() { store.set(this.key, this.data); }

  // ----- tasks -----
  get tasks() { return Object.values(this.data.tasks).filter((t) => !t.deleted); }
  task(id) { const t = this.data.tasks[id]; return t && !t.deleted ? t : null; }
  putTask(t) {
    if (!t.id) { t.id = uid(); t.createdAt = Date.now(); }
    t.updatedAt = Date.now();
    this.data.tasks[t.id] = t;
    this.changed();
    return t;
  }
  deleteTask(id) {
    this.data.tasks[id] = { id, deleted: true, updatedAt: Date.now() };
    this.changed();
  }

  // ----- generic collections (logs, and later habits, rewards, journal) -----
  list(coll) { return Object.values(this.data[coll] || {}).filter((x) => !x.deleted); }
  put(coll, obj) {
    if (!obj.id) { obj.id = uid(); obj.createdAt = Date.now(); }
    obj.updatedAt = Date.now();
    this.data[coll][obj.id] = obj;
    this.changed();
    return obj;
  }
  remove(coll, id) {
    this.data[coll][id] = { id, deleted: true, updatedAt: Date.now() };
    this.changed();
  }

  // ----- settings -----
  get settings() { return this.data.settings; }
  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch, updatedAt: Date.now() };
    this.changed();
  }

  changed() {
    this.saveLocal();
    this.pending = true;
    store.set(this.key + '.dirty', true);
    this.emit();
    this.pushSoon();
  }

  async pull() {
    try {
      this.setStatus('syncing');
      const remote = await this.backend.loadData();
      const merged = mergeData(this.data, remote);
      const changedLocally = JSON.stringify(merged) !== JSON.stringify(normalize(this.data));
      const needsPush = !remote || this.pending || JSON.stringify(merged) !== JSON.stringify(normalize(remote));
      this.data = merged;
      this.saveLocal();
      if (changedLocally) this.emit();
      if (needsPush) await this.push();
      else this.setStatus('synced');
    } catch (e) {
      console.warn('Sync (pull) failed', e);
      this.setStatus(navigator.onLine ? 'error' : 'offline');
    }
  }

  async push() {
    if (this.pushing) { this.again = true; return; }
    this.pushing = true;
    try {
      this.setStatus('syncing');
      const remote = await this.backend.loadData();
      const merged = mergeData(this.data, remote);
      await this.backend.saveData(merged);
      const changed = JSON.stringify(merged) !== JSON.stringify(normalize(this.data));
      this.data = merged;
      this.saveLocal();
      this.pending = false;
      store.set(this.key + '.dirty', false);
      if (changed) this.emit();
      this.setStatus('synced');
    } catch (e) {
      console.warn('Sync (push) failed', e);
      this.setStatus(navigator.onLine ? 'error' : 'offline');
    } finally {
      this.pushing = false;
      if (this.again) { this.again = false; this.push(); }
    }
  }
}
