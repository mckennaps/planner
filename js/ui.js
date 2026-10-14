// Sheets (modal panels), choice dialogs and toasts.
import { h } from './util.js';

const stack = [];

// openSheet({ title, body, footer, onClose, wide }) -> { close, el }
export function openSheet({ title, body, footer, onClose, wide = false, className = '' }) {
  const prevFocus = document.activeElement;
  const panel = h('div.sheet' + (wide ? '.wide' : '') + (className ? '.' + className : ''), { role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' });
  const overlay = h('div.sheet-overlay', panel);
  let closed = false;
  const close = (result) => {
    if (closed) return;
    closed = true;
    overlay.classList.add('closing');
    const i = stack.indexOf(api);
    if (i >= 0) stack.splice(i, 1);
    setTimeout(() => overlay.remove(), 160);
    document.body.classList.toggle('sheet-open', stack.length > 0);
    if (prevFocus && prevFocus.focus) try { prevFocus.focus({ preventScroll: true }); } catch {}
    onClose && onClose(result);
  };
  const api = { close, el: panel, overlay };
  if (title != null) {
    panel.append(h('header.sheet-head',
      h('h2', title),
      h('button.icon-btn.sheet-x', { type: 'button', 'aria-label': 'Close', onclick: () => close() }, icon('x'))));
  }
  panel.append(h('div.sheet-body', body));
  if (footer) panel.append(h('footer.sheet-foot', footer));
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.dataset.down = '1'; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && overlay.dataset.down === '1') close();
    overlay.dataset.down = '';
  });
  document.getElementById('sheet-root').append(overlay);
  document.body.classList.add('sheet-open');
  stack.push(api);
  requestAnimationFrame(() => {
    const f = panel.querySelector('[autofocus]') || panel.querySelector('.sheet-body input, .sheet-body select, .sheet-body textarea, .sheet-body button');
    if (f && !matchMedia('(pointer: coarse)').matches) f.focus({ preventScroll: true });
  });
  return api;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length) {
    e.preventDefault();
    stack[stack.length - 1].close();
  }
});

export const anySheetOpen = () => stack.length > 0;

// choose('Edit recurring event', [{value:'this', label:'This event'}, ...]) -> value | null
export function choose(title, options, { confirmLabel = 'OK', initial } = {}) {
  return new Promise((resolve) => {
    let picked = initial ?? options[0].value;
    const name = 'choice' + Math.random().toString(36).slice(2);
    const list = h('div.choice-list', options.map((o) =>
      h('label.choice',
        h('input', { type: 'radio', name, value: o.value, checked: o.value === picked, onchange: () => { picked = o.value; } }),
        h('span', o.label))));
    const s = openSheet({
      title, body: list, className: 'small',
      footer: [
        h('button.btn.ghost', { type: 'button', onclick: () => s.close(null) }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: () => s.close(picked) }, confirmLabel),
      ],
      onClose: (r) => resolve(r ?? null),
    });
  });
}

export function confirmDialog(title, message, { confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    const s = openSheet({
      title, body: h('p.muted', message), className: 'small',
      footer: [
        h('button.btn.ghost', { type: 'button', onclick: () => s.close(false) }, 'Cancel'),
        h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'button', onclick: () => s.close(true) }, confirmLabel),
      ],
      onClose: (r) => resolve(!!r),
    });
  });
}

// toast('Event deleted', { action: 'Undo', onAction })
export function toast(message, { action, onAction, timeout = 4500, error = false } = {}) {
  const root = document.getElementById('toast-root');
  const t = h('div.toast' + (error ? '.error' : ''), { role: 'status' }, h('span', message));
  if (action) t.append(h('button.toast-action', { type: 'button', onclick: () => { onAction && onAction(); dismiss(); } }, action));
  root.append(t);
  const dismiss = () => { t.classList.add('closing'); setTimeout(() => t.remove(), 200); };
  setTimeout(dismiss, timeout);
  return dismiss;
}

export function showError(e, prefix = 'Something went wrong') {
  console.error(e);
  const msg = e && e.message ? e.message : String(e);
  toast(`${prefix}: ${msg}`, { error: true, timeout: 7000 });
}

// Minimal inline icon set (stroke icons, 24px grid).
const PATHS = {
  x: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  menu: 'M4 7h16M4 12h16M4 17h16',
  cal: 'M4 6h16v14H4zM4 10h16M9 3v4M15 3v4',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  list: 'M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01',
  repeat: 'M17 2l3 3-3 3M20 5H8a4 4 0 0 0-4 4v1M7 22l-3-3 3-3M4 19h12a4 4 0 0 0 4-4v-1',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 21h4',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  dots: 'M5 12h.01M12 12h.01M19 12h.01',
  pin: 'M12 21s-7-6.2-7-11a7 7 0 1 1 14 0c0 4.8-7 11-7 11zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  note: 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5',
  sync: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
  block: 'M4 5h16v15H4zM4 10h16M8 14h5',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.9-.7-1.2-.7-2 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8zM7.5 11.5h.01M10 7.5h.01M15 7.5h.01',
  chevdown: 'M6 9l6 6 6-6',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
};
export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ico');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', PATHS[name] || '');
  svg.append(p);
  return svg;
}
