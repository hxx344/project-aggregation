// On-demand CPU sampling of the data-plane thread, to name the code behind long
// event-loop stalls in the service journal. A stall of at least triggerMs arms
// the V8 sampling profiler for armedMs; the next such stall stops it and logs
// where the thread spent the stall. Nothing is profiled until a long stall is
// seen, and after a capture the profiler rests for cooldownMs. Only function
// names, source paths and line numbers are logged; never arguments or values.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Session } from 'node:inspector/promises';

export const STALL_PROFILE_TRIGGER_MS = 1_000;
const ARMED_MS = 3 * 60_000;
const COOLDOWN_MS = 10 * 60_000;
const SAMPLING_US = 4_000;
// The stop request runs after the stalled task and whatever was queued behind it.
const WINDOW_SLACK_MS = 1_000;
const TOP_FUNCTIONS = 8;
const TOP_STACKS = 3;
const STACK_DEPTH = 10;
const APP_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function location(callFrame, root) {
  let url = callFrame.url || '';
  if (url.startsWith('file://')) {
    try { url = path.relative(root, fileURLToPath(url)) || url; } catch { /* keep the URL */ }
  }
  url = url.split(/[?#]/)[0];
  return url ? `${url}:${callFrame.lineNumber + 1}` : '';
}

function label(callFrame, root) {
  const name = callFrame.functionName || '(anonymous)', where = location(callFrame, root);
  return where ? `${name} ${where}` : name;
}

/**
 * Self time per function over the last windowMs of a V8 CPU profile, plus the
 * call stacks of the heaviest sampled nodes. '(idle)' is time the thread was free.
 */
export function summarizeProfile(profile, { windowMs, root = APP_ROOT, topFunctions = TOP_FUNCTIONS, topStacks = TOP_STACKS } = {}) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node])), parents = new Map();
  for (const node of profile.nodes) for (const child of node.children || []) parents.set(child, node.id);
  const from = profile.endTime - windowMs * 1000, selfUs = new Map();
  let time = profile.startTime, previous = null;
  // The interval after each sample belongs to that sample (forward attribution, like DevTools).
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = Math.max(0, profile.timeDeltas[index]);
    time += delta;
    if (previous !== null && time > from) selfUs.set(previous.id, (selfUs.get(previous.id) || 0) + Math.min(delta, time - from));
    previous = nodes.get(profile.samples[index]) || null;
  }
  const functions = new Map();
  let busyUs = 0;
  for (const [id, us] of selfUs) {
    const frame = nodes.get(id).callFrame;
    if (frame.functionName === '(idle)') continue;
    busyUs += us;
    const key = label(frame, root);
    functions.set(key, (functions.get(key) || 0) + us);
  }
  const ms = us => Math.round(us / 1000);
  const top = [...functions].sort((a, b) => b[1] - a[1]).slice(0, topFunctions).map(([name, us]) => ({ name, ms: ms(us) }));
  const stacks = [...selfUs].filter(([id]) => nodes.get(id).callFrame.functionName !== '(idle)')
    .sort((a, b) => b[1] - a[1]).slice(0, topStacks).map(([id, us]) => {
      const frames = [];
      for (let current = id; current !== undefined && frames.length < STACK_DEPTH; current = parents.get(current)) {
        const frame = nodes.get(current).callFrame;
        if (frame.functionName !== '(root)') frames.push(label(frame, root));
      }
      return { ms: ms(us), frames };
    });
  return { busyMs: ms(busyUs), top, stacks };
}

export function createStallProfiler({ log, triggerMs = STALL_PROFILE_TRIGGER_MS, armedMs = ARMED_MS, cooldownMs = COOLDOWN_MS,
  samplingUs = SAMPLING_US, mono = () => performance.now(), openSession = () => new Session(), root = APP_ROOT,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let session = null, expiry = null, restUntil = -Infinity, busy = false, stopped = false;

  async function begin() {
    const opened = openSession();
    opened.connect();
    try {
      await opened.post('Profiler.enable');
      await opened.post('Profiler.setSamplingInterval', { interval: samplingUs });
      await opened.post('Profiler.start');
    } catch (error) { opened.disconnect(); throw error; }
    if (stopped) { opened.disconnect(); return; }
    session = opened;
    // handle() clears this timer whenever it ends a session, so a busy skip cannot leave sampling running.
    expiry = setTimer(() => { if (!busy) { busy = true; void end().catch(() => {}).finally(() => { busy = false; }); } }, armedMs);
    expiry.unref?.();
  }
  async function end() {
    const closing = session;
    session = null; clearTimer(expiry); expiry = null;
    if (!closing) return null;
    try { return (await closing.post('Profiler.stop')).profile; } finally { closing.disconnect(); }
  }
  async function handle(lagMs) {
    if (!session) {
      if (mono() < restUntil) return;
      log.warn({ type: 'event-loop', durationMs: Math.round(lagMs) }, `数据面卡顿 ${Math.round(lagMs)} ms，开始 CPU 采样以定位下一次卡顿`);
      await begin();
      return;
    }
    const profile = await end();
    restUntil = mono() + cooldownMs;
    const summary = summarizeProfile(profile, { windowMs: lagMs + WINDOW_SLACK_MS, root });
    const top = summary.top.map(item => `${item.name} ${item.ms}ms`).join('；');
    log.warn({ type: 'event-loop', durationMs: Math.round(lagMs), ...summary },
      `数据面卡顿 ${Math.round(lagMs)} ms 期间的 CPU 热点（采样 ${summary.busyMs} ms）：${top || '无样本'}`);
  }
  return {
    stall(lagMs) {
      if (stopped || busy || lagMs < triggerMs) return;
      busy = true;
      void handle(lagMs).catch(error => {
        // A profiler that cannot start rests too, instead of logging on every stall.
        restUntil = mono() + cooldownMs;
        log.warn({ err: error, type: 'event-loop' }, '卡顿采样失败');
      })
        .finally(() => { busy = false; });
    },
    stop() { stopped = true; void end().catch(() => {}); },
  };
}
