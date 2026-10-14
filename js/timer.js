// Focus timer with breaks (Pomodoro-style). The timer keeps running from timestamps, so it stays
// right if you close the app; ntfy (if set up) sends "break time" / "back to focus" to your phone.
import { h, store, ymd, todayStr, durationLabel } from './util.js';
import { openSheet, toast, icon } from './ui.js';
import { publish, cancel, ntfyOn, notifySettings } from './notify.js';

const KEY = 'planner.timer';
export const DEFAULT_TIMER = { focus: 25, short: 5, long: 15, rounds: 4, autoBreak: true, autoFocus: false, sound: true };
const PHASE_LABEL = { focus: 'Focus', short: 'Short break', long: 'Long break' };

let app = null;
let st = null;
let audioCtx = null;
const listeners = new Set();

export const timerSettings = (a = app) => ({ ...DEFAULT_TIMER, ...((a && a.settings.timer) || {}) });
const lengthOf = (phase) => timerSettings()[phase] * 60000;

function fresh() {
  return { phase: 'focus', running: false, endsAt: null, remaining: lengthOf('focus'), round: 1, taskId: null, phaseStart: null };
}
function save() { store.set(KEY, st); emit(); }
function emit() { for (const fn of listeners) fn(st); }
export const onTimer = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const timerState = () => st;

export function remainingMs() {
  if (!st) return 0;
  return st.running ? Math.max(0, st.endsAt - Date.now()) : st.remaining;
}
export const isActive = () => !!st && (st.running || st.remaining < lengthOf(st.phase));

export function initTimer(a) {
  app = a;
  st = store.get(KEY) || fresh();
  catchUp();
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') catchUp(); });
  emit();
}

function tick() {
  if (!st || !st.running) return;
  if (Date.now() >= st.endsAt) finishPhase(true);
  else emit();
}

// If phases ended while the app was closed, play them forward.
function catchUp() {
  let guard = 0;
  while (st.running && Date.now() >= st.endsAt && guard++ < 8) finishPhase(false);
  save();
}

function nextPhase() {
  if (st.phase !== 'focus') return 'focus';
  return st.round % timerSettings().rounds === 0 ? 'long' : 'short';
}

function finishPhase(live) {
  const ended = st.phase;
  const endedAt = st.running ? st.endsAt : Date.now();
  if (ended === 'focus') logFocus(lengthOf('focus'), endedAt);
  const next = nextPhase();
  if (ended !== 'focus') st.round += 1;
  st.phase = next;
  const auto = next === 'focus' ? timerSettings().autoFocus : timerSettings().autoBreak;
  if (auto && st.running) {
    st.endsAt = endedAt + lengthOf(next);
    st.phaseStart = endedAt;
  } else {
    st.running = false;
    st.endsAt = null;
    st.remaining = lengthOf(next);
  }
  save();
  if (live) {
    chime();
    const msg = ended === 'focus' ? `Focus done! ${next === 'long' ? 'Long' : 'Short'} break: ${timerSettings()[next]} min` : 'Break’s over. Back to focus ✦';
    toast(msg, { timeout: 6000 });
    localNotify(msg);
  }
  if (st.running) schedulePush();
}

function logFocus(ms, endedAt) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return;
  const t = st.taskId ? app.data.task(st.taskId) : null;
  app.data.put('logs', { kind: 'focus', minutes, taskId: t ? t.id : null, title: t ? t.title : null, at: endedAt, date: ymd(new Date(endedAt)) });
}

// ---- controls ----
export function start() {
  unlockAudio();
  if (st.running) return;
  st.running = true;
  st.endsAt = Date.now() + st.remaining;
  st.phaseStart = Date.now() - (lengthOf(st.phase) - st.remaining);
  save();
  schedulePush();
}
export function pause() {
  if (!st.running) return;
  st.remaining = Math.max(0, st.endsAt - Date.now());
  st.running = false;
  st.endsAt = null;
  save();
  cancelPush();
}
export function toggle() { st.running ? pause() : start(); }
export function reset() {
  const task = st.taskId;
  st = fresh();
  st.taskId = task;
  save();
  cancelPush();
}
export function skip() {
  if (st.phase === 'focus') {
    const done = lengthOf('focus') - remainingMs();
    if (done >= 60000) logFocus(done, Date.now());
  }
  const next = nextPhase();
  if (st.phase !== 'focus') st.round += 1;
  st.phase = next;
  st.running = false;
  st.endsAt = null;
  st.remaining = lengthOf(next);
  save();
  cancelPush();
}
export function setTask(taskId) { st.taskId = taskId || null; save(); }
export function applyNewLengths() { if (!st.running) { st.remaining = lengthOf(st.phase); save(); } }

// ---- notifications ----
async function schedulePush() {
  if (!ntfyOn(app) || !notifySettings(app).timer || !st.running) return;
  const ended = st.phase, next = nextPhase();
  const title = ended === 'focus' ? 'Break time ✦' : 'Back to focus';
  const message = ended === 'focus' ? `${PHASE_LABEL[next]}: ${timerSettings()[next]} min` : `Focus for ${timerSettings().focus} min`;
  try {
    await publish(app, { seq: 'timer', at: new Date(st.endsAt), title, message, tags: [ended === 'focus' ? 'tea' : 'sparkles'], priority: 4 });
    // if the break starts on its own, also queue the "break's over" ping
    if (ended === 'focus' && timerSettings().autoBreak) {
      await publish(app, { seq: 'timer2', at: new Date(st.endsAt + lengthOf(next)), title: 'Back to focus', message: 'Break’s over ✦', tags: ['sparkles'], priority: 4 });
    } else await cancel(app, 'timer2').catch(() => {});
  } catch (e) { console.warn('Timer notification failed', e); }
}
async function cancelPush() {
  if (!ntfyOn(app) || !notifySettings(app).timer) return;
  await cancel(app, 'timer').catch(() => {});
  await cancel(app, 'timer2').catch(() => {});
}

function localNotify(text) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((r) => r.showNotification('Planner', { body: text, icon: 'icons/icon-192.png' }));
    } else new Notification('Planner', { body: text });
  } catch {}
}

// ---- sound: a little three-note chime ----
function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === 'suspended') audioCtx.resume(); } catch {}
}
function chime() {
  if (!timerSettings().sound || !audioCtx) return;
  const now = audioCtx.currentTime;
  [880, 1174.66, 1567.98].forEach((f, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0, now + i * 0.18);
    g.gain.linearRampToValueAtTime(0.25, now + i * 0.18 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.18 + 0.9);
    o.connect(g).connect(audioCtx.destination);
    o.start(now + i * 0.18); o.stop(now + i * 0.18 + 1);
  });
}

// ---- stats ----
export function focusToday(a = app) {
  const today = todayStr();
  const logs = a.data.list('logs').filter((l) => l.kind === 'focus' && l.date === today);
  return { minutes: logs.reduce((s, l) => s + (l.minutes || 0), 0), sessions: logs.length, logs };
}
export function focusForTask(a, taskId) {
  return a.data.list('logs').filter((l) => l.kind === 'focus' && l.taskId === taskId).reduce((s, l) => s + (l.minutes || 0), 0);
}

export const fmtClock = (ms) => {
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60), s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
export const phaseLabel = (p) => PHASE_LABEL[p];

// ---- the timer screen ----
export function renderTimerView(a, root, { onPickTask, onMenu }) {
  const R = 118, C = 2 * Math.PI * R;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 280 280');
  svg.setAttribute('class', 'timer-ring');
  svg.innerHTML = `<defs><linearGradient id="tg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="tg1"/><stop offset="1" class="tg2"/></linearGradient></defs>
    <circle cx="140" cy="140" r="${R}" class="ring-track"/>
    <circle cx="140" cy="140" r="${R}" class="ring-fill" stroke-dasharray="${C}" stroke-dashoffset="0" transform="rotate(-90 140 140)"/>`;
  const fill = svg.querySelector('.ring-fill');
  const clock = h('div.timer-clock', '25:00');
  const phase = h('div.timer-phase');
  const dots = h('div.round-dots');
  const playBtn = h('button.btn.primary.timer-play', { type: 'button', onclick: () => toggle() });
  const taskBtn = h('button.timer-task', { type: 'button', onclick: onPickTask });
  const stats = h('div.timer-stats');

  const paint = () => {
    const ms = remainingMs();
    const total = lengthOf(st.phase);
    fill.setAttribute('stroke-dashoffset', String(C * (1 - ms / total)));
    clock.textContent = fmtClock(ms);
    phase.textContent = PHASE_LABEL[st.phase];
    root.dataset.phase = st.phase;
    root.dataset.running = String(st.running);
    playBtn.replaceChildren(icon(st.running ? 'pause' : 'play', 22), st.running ? 'Pause' : (ms < total ? 'Resume' : 'Start'));
    const n = timerSettings().rounds;
    const inRound = ((st.round - 1) % n) + 1;
    dots.replaceChildren(...Array.from({ length: n }, (_, i) =>
      h('span.round-dot' + (i < inRound - 1 || (i === inRound - 1 && st.phase !== 'focus') ? '.done' : i === inRound - 1 ? '.now' : ''))));
    const t = st.taskId ? a.data.task(st.taskId) : null;
    taskBtn.replaceChildren(icon(t ? 'check' : 'plus', 16), h('span', t ? t.title : 'Pick a task to focus on'));
    const f = focusToday(a);
    stats.replaceChildren(
      h('div.stat', h('strong', durationLabel(f.minutes) || '0 min'), h('span', 'focused today')),
      h('div.stat', h('strong', String(f.sessions)), h('span', f.sessions === 1 ? 'session' : 'sessions')),
      t ? h('div.stat', h('strong', durationLabel(focusForTask(a, t.id)) || '0 min'), h('span', 'on this task')) : '');
    document.title = st.running ? `${fmtClock(ms)} · ${PHASE_LABEL[st.phase]}` : 'Planner';
  };

  root.replaceChildren(
    h('header.view-head',
      h('button.icon-btn.only-narrow', { type: 'button', 'aria-label': 'Open menu', onclick: onMenu }, icon('menu')),
      h('h1.view-title', 'Focus'),
      h('span.grow'),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Timer settings', title: 'Timer settings', onclick: () => openTimerSettings(a) }, icon('gear'))),
    h('div.timer-body',
      h('div.timer-dial', svg, h('div.timer-center', phase, clock, dots)),
      taskBtn,
      h('div.timer-controls',
        h('button.icon-btn.big', { type: 'button', 'aria-label': 'Reset', title: 'Reset', onclick: () => reset() }, icon('reset', 22)),
        playBtn,
        h('button.icon-btn.big', { type: 'button', 'aria-label': 'Skip to next', title: 'Skip to next', onclick: () => skip() }, icon('skip', 22))),
      stats,
      !ntfyOn(a) ? h('p.hint.center', 'Want a ping on your phone when a break starts? Set up phone notifications in Settings.') : ''));
  paint();
  const off = onTimer(paint);
  return () => { off(); };
}

export function openTimerSettings(a) {
  const T = timerSettings(a);
  const num = (id, val, min, max) => h('input.input.num', { id, type: 'number', min: String(min), max: String(max), value: String(val) });
  const focus = num('tm-focus', T.focus, 1, 180), short = num('tm-short', T.short, 1, 60), long = num('tm-long', T.long, 1, 90), rounds = num('tm-rounds', T.rounds, 1, 12);
  const autoBreak = h('input#tm-ab', { type: 'checkbox', checked: T.autoBreak });
  const autoFocus = h('input#tm-af', { type: 'checkbox', checked: T.autoFocus });
  const sound = h('input#tm-sound', { type: 'checkbox', checked: T.sound });
  const row = (label, input, unit) => h('label.row.timer-set', h('span.grow', label), input, h('span.muted', unit));
  const body = h('div.stack',
    h('div.stack-sm', row('Focus', focus, 'min'), row('Short break', short, 'min'), row('Long break', long, 'min'), row('Long break after', rounds, 'focus rounds')),
    h('div.field',
      h('label.toggle', autoBreak, h('span', 'Start breaks automatically')),
      h('label.toggle', autoFocus, h('span', 'Start the next focus automatically')),
      h('label.toggle', sound, h('span', 'Play a chime'))),
    'Notification' in window && Notification.permission !== 'granted'
      ? h('button.btn.ghost', { type: 'button', onclick: async () => { const p = await Notification.requestPermission(); toast(p === 'granted' ? 'This device will show timer alerts.' : 'Notifications weren’t allowed.'); } }, icon('bell', 18), 'Show alerts on this device too')
      : '');
  const s = openSheet({
    title: 'Timer settings', body, className: 'small',
    footer: [h('span.grow'), h('button.btn.primary', { type: 'button', onclick: () => {
      const clamp = (el, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(el.value) || lo)));
      a.data.setSettings({ timer: { focus: clamp(focus, 1, 180), short: clamp(short, 1, 60), long: clamp(long, 1, 90), rounds: clamp(rounds, 1, 12), autoBreak: autoBreak.checked, autoFocus: autoFocus.checked, sound: sound.checked } });
      applyNewLengths();
      s.close();
    } }, 'Save')],
  });
}
