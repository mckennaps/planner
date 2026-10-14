// Repeat rules (RFC 5545 RRULE, the same format Google Calendar uses).
import { h, ymd, parseYmd, addDays } from './util.js';
import { openSheet } from './ui.js';

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ORD = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', '-1': 'last' };
const UNIT = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };

export function parseRule(rule) {
  const o = {};
  if (!rule) return o;
  for (const part of rule.replace(/^RRULE:/, '').split(';')) {
    const [k, v] = part.split('=');
    if (k) o[k.toUpperCase()] = v;
  }
  return o;
}
export function buildRule(o) {
  const order = ['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'COUNT', 'UNTIL', 'WKST', 'BYSETPOS'];
  const keys = Object.keys(o).filter((k) => o[k] != null && o[k] !== '' && !(k === 'INTERVAL' && String(o[k]) === '1'));
  keys.sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
  return keys.map((k) => `${k}=${o[k]}`).join(';');
}

function untilToDate(u) {
  const m = u && u.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!m) return null;
  if (m[7]) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return new Date(+m[1], +m[2] - 1, +m[3]);
}
// End-of-day local, as UTC basic format (required by Google for timed events).
export function untilFor(dateStr, allDay) {
  if (allDay) return dateStr.replace(/-/g, '');
  const d = parseYmd(dateStr);
  d.setHours(23, 59, 59, 0);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const nthOf = (d) => Math.ceil(d.getDate() / 7);

export function presets(start) {
  const dow = start.getDay();
  return [
    { value: '', label: 'Does not repeat' },
    { value: 'FREQ=DAILY', label: 'Daily' },
    { value: `FREQ=WEEKLY;BYDAY=${DAY_CODES[dow]}`, label: `Weekly on ${DAY_LONG[dow]}` },
    { value: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday (Mon–Fri)' },
    { value: `FREQ=MONTHLY;BYDAY=${nthOf(start)}${DAY_CODES[dow]}`, label: `Monthly on the ${ORD[nthOf(start)]} ${DAY_LONG[dow]}` },
    { value: `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`, label: `Monthly on day ${start.getDate()}` },
    { value: 'FREQ=YEARLY', label: `Annually on ${start.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })}` },
  ];
}

export function describe(rule) {
  if (!rule) return 'Does not repeat';
  const o = parseRule(rule);
  const n = Number(o.INTERVAL || 1);
  let s;
  const days = (o.BYDAY || '').split(',').filter(Boolean);
  if (o.FREQ === 'WEEKLY' && days.length) {
    const plain = days.map((d) => d.slice(-2));
    const isWeekdays = plain.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => plain.includes(d));
    const names = plain.sort((a, b) => ((DAY_CODES.indexOf(a) + 6) % 7) - ((DAY_CODES.indexOf(b) + 6) % 7))
      .map((d) => DAY_SHORT[DAY_CODES.indexOf(d)]);
    if (isWeekdays && n === 1) s = 'Every weekday';
    else s = (n > 1 ? `Every ${n} weeks on ` : 'Weekly on ') + names.join(', ');
  } else if (o.FREQ === 'MONTHLY' && days.length === 1 && /^-?\d/.test(days[0])) {
    const m = days[0].match(/^(-?\d)(\w\w)$/);
    s = (n > 1 ? `Every ${n} months` : 'Monthly') + ` on the ${ORD[m[1]] || m[1]} ${DAY_LONG[DAY_CODES.indexOf(m[2])]}`;
  } else if (o.FREQ === 'MONTHLY' && o.BYMONTHDAY) {
    s = (n > 1 ? `Every ${n} months` : 'Monthly') + ` on day ${o.BYMONTHDAY}`;
  } else {
    const base = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Annually' }[o.FREQ] || 'Repeats';
    s = n > 1 ? `Every ${n} ${UNIT[o.FREQ] || 'time'}s` : base;
  }
  if (o.COUNT) s += `, ${o.COUNT} times`;
  if (o.UNTIL) {
    const u = untilToDate(o.UNTIL);
    if (u) s += `, until ${u.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return s;
}

// Rules for "this and following": end the old series just before `beforeDate`.
export function endRuleBefore(rule, beforeDate, allDay) {
  const o = parseRule(rule);
  delete o.COUNT;
  if (allDay) o.UNTIL = ymd(addDays(beforeDate, -1)).replace(/-/g, '');
  else o.UNTIL = new Date(beforeDate.getTime() - 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return buildRule(o);
}
export function withoutCount(rule) {
  const o = parseRule(rule);
  delete o.COUNT;
  return buildRule(o);
}

// ---- expansion via rrule.js, using "floating" times (local wall-clock as UTC) ----
const toFloat = (d) => new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()));
const fromFloat = (d) => new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());

function makeRRule(rule, dtstart) {
  const opts = window.rrule.RRule.parseString(rule.replace(/^RRULE:/, ''));
  opts.dtstart = toFloat(dtstart);
  if (opts.until) {
    const raw = parseRule(rule).UNTIL || '';
    // date-only UNTIL is inclusive of that whole local day; Z UNTIL is a real instant
    const u = untilToDate(raw);
    if (u) opts.until = raw.includes('Z') ? toFloat(u) : toFloat(new Date(u.getFullYear(), u.getMonth(), u.getDate(), 23, 59, 59));
  }
  return new window.rrule.RRule(opts);
}

// All occurrence starts of a series between [from, to).
export function occurrences(rule, dtstart, from, to) {
  return makeRRule(rule, dtstart).between(toFloat(from), toFloat(to), true).map(fromFloat).filter((d) => d < to);
}

// Next date (YYYY-MM-DD) strictly after `afterStr` for a task that started on `anchorStr`.
export function nextDate(rule, anchorStr, afterStr) {
  const r = makeRRule(rule, atNoon(anchorStr));
  const n = r.after(toFloat(atNoon(afterStr)), false);
  return n ? ymd(fromFloat(n)) : null;
}
const atNoon = (s) => { const d = parseYmd(s); d.setHours(12); return d; };

// ---- UI: <select> of presets, plus a custom builder sheet ----
// getStart() -> Date ; returns { el, get value(), set value(v) }
export function repeatPicker(getStart, initial, { allDay = () => false, onChange } = {}) {
  let value = initial || '';
  const sel = h('select.input', { 'aria-label': 'Repeat' });
  const render = () => {
    const opts = presets(getStart());
    sel.replaceChildren();
    let found = false;
    for (const o of opts) {
      const opt = h('option', { value: o.value }, o.label);
      if (o.value === value) { opt.selected = true; found = true; }
      sel.append(opt);
    }
    if (!found && value) sel.append(h('option', { value, selected: true }, describe(value)));
    sel.append(h('option', { value: '__custom' }, 'Custom…'));
  };
  sel.addEventListener('change', async () => {
    if (sel.value === '__custom') {
      const r = await customRepeat(getStart(), value, allDay());
      if (r != null) value = r;
    } else value = sel.value;
    render();
    onChange && onChange(value);
  });
  render();
  return {
    el: sel,
    get value() { return value; },
    set value(v) { value = v || ''; render(); },
    refresh: render,
  };
}

export function customRepeat(start, current, allDay) {
  return new Promise((resolve) => {
    const o = parseRule(current || `FREQ=WEEKLY;BYDAY=${DAY_CODES[start.getDay()]}`);
    const interval = h('input.input.num', { type: 'number', min: '1', max: '99', value: o.INTERVAL || '1', id: 'rr-interval', 'aria-label': 'Interval' });
    const freq = h('select.input', { id: 'rr-freq', 'aria-label': 'Frequency' },
      ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].map((f) => h('option', { value: f, selected: o.FREQ === f }, UNIT[f] + '(s)')));
    const picked = new Set((o.BYDAY && o.FREQ === 'WEEKLY' ? o.BYDAY.split(',') : [DAY_CODES[start.getDay()]]).map((d) => d.slice(-2)));
    const dayChips = h('div.day-chips', DAY_CODES.map((c, i) => {
      const b = h('button.day-chip', { type: 'button', 'aria-pressed': String(picked.has(c)), title: DAY_LONG[i] }, DAY_SHORT[i][0]);
      b.onclick = () => {
        if (picked.has(c) && picked.size > 1) picked.delete(c); else picked.add(c);
        b.setAttribute('aria-pressed', String(picked.has(c)));
      };
      return b;
    }));
    const dow = start.getDay();
    const monthMode = o.FREQ === 'MONTHLY' && o.BYDAY ? 'nth' : 'day';
    const mDay = h('label.radio-row', h('input', { type: 'radio', name: 'rr-mm', value: 'day', checked: monthMode === 'day' }), `On day ${start.getDate()}`);
    const mNth = h('label.radio-row', h('input', { type: 'radio', name: 'rr-mm', value: 'nth', checked: monthMode === 'nth' }), `On the ${ORD[nthOf(start)]} ${DAY_LONG[dow]}`);
    const monthBox = h('div.stack-sm', mDay, mNth);

    const endMode = o.UNTIL ? 'on' : o.COUNT ? 'after' : 'never';
    const untilDefault = o.UNTIL ? ymd(untilToDate(o.UNTIL)) : ymd(addDays(start, 90));
    const untilIn = h('input.input', { type: 'date', value: untilDefault, id: 'rr-until', 'aria-label': 'End date' });
    const countIn = h('input.input.num', { type: 'number', min: '1', max: '999', value: o.COUNT || '10', id: 'rr-count', 'aria-label': 'Occurrences' });
    const endRow = (val, label, extra) => h('label.radio-row',
      h('input', { type: 'radio', name: 'rr-end', value: val, checked: endMode === val }), h('span', label), extra || '');
    const ends = h('div.stack-sm', endRow('never', 'Never'), endRow('on', 'On', untilIn), endRow('after', 'After', countIn, h('span.muted', ' times')));

    const weekBox = h('div.field', h('span.label', 'Repeat on'), dayChips);
    const sync = () => {
      weekBox.hidden = freq.value !== 'WEEKLY';
      monthBox.hidden = freq.value !== 'MONTHLY';
    };
    freq.addEventListener('change', sync);
    sync();

    const body = h('div.stack',
      h('div.field', h('span.label', 'Repeat every'), h('div.row', interval, freq)),
      weekBox, monthBox,
      h('div.field', h('span.label', 'Ends'), ends));

    const done = () => {
      const r = { FREQ: freq.value, INTERVAL: Math.max(1, Number(interval.value) || 1) };
      if (freq.value === 'WEEKLY') r.BYDAY = DAY_CODES.filter((c) => picked.has(c)).join(',');
      if (freq.value === 'MONTHLY') {
        const mm = body.querySelector('input[name="rr-mm"]:checked').value;
        if (mm === 'nth') r.BYDAY = `${nthOf(start)}${DAY_CODES[dow]}`;
        else r.BYMONTHDAY = start.getDate();
      }
      const em = body.querySelector('input[name="rr-end"]:checked').value;
      if (em === 'on' && untilIn.value) r.UNTIL = untilFor(untilIn.value, allDay);
      if (em === 'after') r.COUNT = Math.max(1, Number(countIn.value) || 1);
      s.close(buildRule(r));
    };
    const s = openSheet({
      title: 'Custom repeat', body, className: 'small',
      footer: [
        h('button.btn.ghost', { type: 'button', onclick: () => s.close(null) }, 'Cancel'),
        h('button.btn.primary', { type: 'button', onclick: done }, 'Done'),
      ],
      onClose: (r) => resolve(r ?? null),
    });
  });
}
