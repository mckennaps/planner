// Small shared helpers: DOM building, dates, colors, storage.

export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// ---------- storage (never throws) ----------
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
  del(key) {
    try { localStorage.removeItem(key); } catch {}
  },
};

// ---------- DOM ----------
// h('div.class#id', {attrs}, ...children)
export function h(sel, attrs, ...children) {
  if (attrs == null || typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs)) {
    children.unshift(attrs);
    attrs = {};
  }
  const m = sel.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement((m && m[1]) || 'div');
  if (m && m[2]) {
    for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1));
      else el.id = part.slice(1);
    }
  }
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv);
        else el.style[sk] = sv;
      }
    }
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && k !== 'list' && k !== 'form' && typeof v !== 'string') el[k] = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  appendKids(el, children);
  return el;
}
function appendKids(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendKids(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- dates (all local time) ----------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function atTime(dateStr, timeStr) {
  const d = parseYmd(dateStr);
  if (timeStr) {
    const [H, M] = timeStr.split(':').map(Number);
    d.setHours(H, M, 0, 0);
  }
  return d;
}
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
export const sameDay = (a, b) => ymd(a) === ymd(b);
export const todayStr = () => ymd(new Date());

// "2026-10-13T09:00:00-04:00"
export function isoLocal(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${ymd(d)}T${hm(d)}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

let use24 = false;
export function setClock24(v) { use24 = !!v; }
export function fmtTime(d) {
  if (use24) return hm(d);
  let H = d.getHours();
  const M = d.getMinutes();
  const ap = H >= 12 ? 'pm' : 'am';
  H = H % 12 || 12;
  return M ? `${H}:${pad(M)}${ap}` : `${H}${ap}`;
}
export function fmtDate(d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return d.toLocaleDateString(undefined, opts);
}
// "Today", "Tomorrow", "Yesterday", "Thu, Oct 15"
export function relDay(dateStr) {
  const d = parseYmd(dateStr);
  const diff = Math.round((d - startOfDay(new Date())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function durationLabel(min) {
  if (!min) return '';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

// ---------- color ----------
export function readableText(hex) {
  const c = (hex || '#888888').replace('#', '');
  const full = c.length === 3 ? c.split('').map((x) => x + x).join('') : c;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return L > 0.45 ? '#16181d' : '#ffffff';
}

// Google Calendar's 11 per-event colors (as shown in the current gcal UI).
export const EVENT_COLORS = {
  1: ['Lavender', '#7986cb'], 2: ['Sage', '#33b679'], 3: ['Grape', '#8e24aa'],
  4: ['Flamingo', '#e67c73'], 5: ['Banana', '#f6bf26'], 6: ['Tangerine', '#f4511e'],
  7: ['Peacock', '#039be5'], 8: ['Graphite', '#616161'], 9: ['Blueberry', '#3f51b5'],
  10: ['Basil', '#0b8043'], 11: ['Tomato', '#d50000'],
};

// Palette offered when making a category (any hex also allowed).
export const CATEGORY_SWATCHES = [
  '#d50000', '#e67c73', '#f4511e', '#ef6c00', '#f6bf26', '#c0ca33',
  '#7cb342', '#33b679', '#0b8043', '#009688', '#039be5', '#4285f4',
  '#3f51b5', '#7986cb', '#b39ddb', '#9e69af', '#8e24aa', '#ad1457',
  '#d81b60', '#795548', '#a79b8e', '#616161', '#455a64', '#1c2333',
];

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const isTouch = () => matchMedia('(pointer: coarse)').matches;
export const isNarrow = () => matchMedia('(max-width: 899px)').matches;
