// Google backend: sign-in (OAuth redirect, no server), Calendar API, Drive app-data file.
import { store, uid } from './util.js';

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive.appdata',
].join(' ');
const CAL = 'https://www.googleapis.com/calendar/v3';
const DRIVE = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DATA_FILE = 'planner-data.json';

const TOKEN_KEY = 'planner.token';
const PENDING_KEY = 'planner.pendingOps';

export function redirectUri() {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export class GoogleBackend {
  constructor(clientId) {
    this.clientId = clientId;
    this.kind = 'google';
    this.token = store.get(TOKEN_KEY);
    this.dataFileId = store.get('planner.dataFileId');
  }

  // ---------- auth ----------
  // Returns 'ok' | 'error:<code>' | null (no redirect happening)
  handleRedirect() {
    if (!location.hash.includes('access_token') && !location.hash.includes('error=')) return null;
    const p = new URLSearchParams(location.hash.slice(1));
    history.replaceState(null, '', location.pathname + location.search);
    const expected = store.get('planner.oauthState');
    store.del('planner.oauthState');
    if (p.get('error')) return 'error:' + p.get('error');
    if (!expected || p.get('state') !== expected) return 'error:state_mismatch';
    this.token = {
      access: p.get('access_token'),
      expires: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000,
    };
    store.set(TOKEN_KEY, this.token);
    return 'ok';
  }

  get signedIn() { return !!this.token; }
  get tokenFresh() { return this.token && this.token.expires - Date.now() > 90 * 1000; }
  get email() { return store.get('planner.email'); }

  signIn({ silent = false } = {}) {
    const state = uid();
    store.set('planner.oauthState', state);
    const q = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri(),
      response_type: 'token',
      scope: SCOPES,
      include_granted_scopes: 'true',
      state,
    });
    if (silent) q.set('prompt', 'none');
    if (this.email) q.set('login_hint', this.email);
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q);
    return new Promise(() => {}); // page is navigating away
  }

  signOut() {
    if (this.token) {
      fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(this.token.access), { method: 'POST' }).catch(() => {});
    }
    this.token = null;
    store.del(TOKEN_KEY);
    store.del('planner.email');
    store.del('planner.dataFileId');
  }

  // Refresh the token by bouncing through Google (fast, no prompt) when it is about to expire.
  ensureFresh() {
    if (!this.tokenFresh) return this.signIn({ silent: true });
  }

  async api(method, url, body, { raw = false, headers = {} } = {}) {
    if (!this.token) throw new Error('Not signed in');
    if (!this.tokenFresh) {
      if (method !== 'GET' && !raw) this.queuePending(method, url, body, headers);
      return this.signIn({ silent: true });
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + this.token.access,
        ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    if (res.status === 401) {
      this.token.expires = 0;
      if (method !== 'GET' && !raw) this.queuePending(method, url, body, headers);
      return this.signIn({ silent: true });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
    if (!res.ok) {
      const msg = (json && json.error && json.error.message) || res.statusText;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  queuePending(method, url, body, headers) {
    const list = store.get(PENDING_KEY, []);
    list.push({ method, url, body, headers });
    store.set(PENDING_KEY, list);
  }

  // Replay writes that were interrupted by a token refresh.
  async replayPending() {
    const list = store.get(PENDING_KEY, []);
    store.del(PENDING_KEY);
    for (const op of list) {
      try { await this.api(op.method, op.url, op.body, { headers: op.headers }); }
      catch (e) { console.warn('Could not replay change', e); }
    }
    return list.length;
  }

  // ---------- calendars ----------
  async listCalendars() {
    let items = [], pageToken;
    do {
      const q = new URLSearchParams({ colorRgbFormat: 'true', maxResults: '250' });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.api('GET', `${CAL}/users/me/calendarList?${q}`);
      items = items.concat(r.items || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
    const primary = items.find((c) => c.primary);
    if (primary) store.set('planner.email', primary.id);
    return items.map(normCal);
  }

  async createCalendar(name, color) {
    const cal = await this.api('POST', `${CAL}/calendars`, { summary: name, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const entry = await this.api('PATCH', `${CAL}/users/me/calendarList/${enc(cal.id)}?colorRgbFormat=true`, {
      backgroundColor: color, foregroundColor: '#ffffff', selected: true,
    });
    return normCal(entry);
  }

  async updateCalendar(cal, { name, color }) {
    if (name != null && cal.role === 'owner' && name !== cal.name) {
      await this.api('PATCH', `${CAL}/calendars/${enc(cal.id)}`, { summary: name });
    }
    const patch = {};
    if (color) Object.assign(patch, { backgroundColor: color, foregroundColor: '#ffffff' });
    if (name != null && cal.role !== 'owner') patch.summaryOverride = name;
    if (Object.keys(patch).length) {
      await this.api('PATCH', `${CAL}/users/me/calendarList/${enc(cal.id)}?colorRgbFormat=true`, patch);
    }
  }

  async deleteCalendar(cal) {
    if (cal.role === 'owner' && !cal.primary) await this.api('DELETE', `${CAL}/calendars/${enc(cal.id)}`);
    else await this.api('DELETE', `${CAL}/users/me/calendarList/${enc(cal.id)}`);
  }

  // ---------- events ----------
  async listEvents(calId, start, end) {
    let items = [], pageToken;
    do {
      const q = new URLSearchParams({
        timeMin: start.toISOString(), timeMax: end.toISOString(),
        singleEvents: 'true', maxResults: '2500', showDeleted: 'false',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await this.api('GET', `${CAL}/calendars/${enc(calId)}/events?${q}`);
      items = items.concat(r.items || []);
      pageToken = r.nextPageToken;
    } while (pageToken);
    return items.filter((e) => e.status !== 'cancelled');
  }

  // Events linked to a task (time blocks), starting from `from`.
  async findTaskBlocks(calId, taskId, from) {
    const q = new URLSearchParams({ privateExtendedProperty: `plannerTaskId=${taskId}`, timeMin: from.toISOString(), singleEvents: 'true', maxResults: '100' });
    const r = await this.api('GET', `${CAL}/calendars/${enc(calId)}/events?${q}`);
    return (r.items || []).filter((e) => e.status !== 'cancelled');
  }

  getEvent(calId, id) { return this.api('GET', `${CAL}/calendars/${enc(calId)}/events/${enc(id)}`); }
  insertEvent(calId, ev) { return this.api('POST', `${CAL}/calendars/${enc(calId)}/events`, ev); }
  patchEvent(calId, id, patch) { return this.api('PATCH', `${CAL}/calendars/${enc(calId)}/events/${enc(id)}`, patch); }
  deleteEvent(calId, id) {
    return this.api('DELETE', `${CAL}/calendars/${enc(calId)}/events/${enc(id)}`).catch((e) => {
      if (e.status === 410 || e.status === 404) return null; // already gone
      throw e;
    });
  }
  moveEvent(calId, id, destId) {
    return this.api('POST', `${CAL}/calendars/${enc(calId)}/events/${enc(id)}/move?destination=${enc(destId)}`);
  }

  // ---------- app data (tasks, settings, ...) in a hidden Drive file ----------
  async findDataFile() {
    if (this.dataFileId) return this.dataFileId;
    const q = new URLSearchParams({ spaces: 'appDataFolder', q: `name='${DATA_FILE}'`, fields: 'files(id,modifiedTime)' });
    const r = await this.api('GET', `${DRIVE}/files?${q}`);
    const f = (r.files || [])[0];
    if (f) { this.dataFileId = f.id; store.set('planner.dataFileId', f.id); }
    return this.dataFileId || null;
  }

  async loadData() {
    const id = await this.findDataFile();
    if (!id) return null;
    try {
      return await this.api('GET', `${DRIVE}/files/${id}?alt=media`);
    } catch (e) {
      if (e.status === 404) { this.dataFileId = null; store.del('planner.dataFileId'); return null; }
      throw e;
    }
  }

  async saveData(data) {
    const id = await this.findDataFile();
    const body = JSON.stringify(data);
    if (id) {
      await this.api('PATCH', `${UPLOAD}/files/${id}?uploadType=media`, body, { raw: true, headers: { 'Content-Type': 'application/json' } });
      return;
    }
    const boundary = 'planner' + uid();
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: DATA_FILE, parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
    const r = await this.api('POST', `${UPLOAD}/files?uploadType=multipart&fields=id`, multipart, {
      raw: true, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
    this.dataFileId = r.id;
    store.set('planner.dataFileId', r.id);
  }
}

const enc = encodeURIComponent;

function normCal(c) {
  return {
    id: c.id,
    name: c.summaryOverride || (c.primary && /@/.test(c.summary || '') ? 'Main calendar' : c.summary) || c.id,
    color: c.backgroundColor || '#7986cb',
    role: c.accessRole,
    writable: c.accessRole === 'owner' || c.accessRole === 'writer',
    primary: !!c.primary,
    selected: c.selected !== false,
    defaultReminders: c.defaultReminders || [],
  };
}
