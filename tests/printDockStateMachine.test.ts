import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canTransitionPrintJob,
  canTransitionPrintQueue,
  canTransitionPrintTarget,
  isPrintQueueBusy,
  nextPrintTarget,
  PrintQueue,
  printJobsOutcome,
  printUnsureMessage,
  printUnsureSkipLabel,
  PRINT_JOB_EXITS,
  PRINT_JOB_STATES,
  PRINT_JOB_TRANSITIONS,
  PRINT_QUEUE_PHASES,
  PRINT_QUEUE_TRANSITIONS,
  PRINT_TARGET_STATES,
  PRINT_TARGET_TRANSITIONS,
  PRINT_TIMEOUT_MS,
  HANDOFF_VISIBLE_MS,
  unsurePrinters,
  type PrintAttemptContext,
  type PrintJob,
} from '@/lib/pos/printQueue';
import { PrintDockEngine, type DesktopPrintExecutor } from '@/lib/pos/printDock';
import { createDesktopExecutor, NoPrintersConfiguredError } from '@/lib/desktop/printExecutor';
import type { HiocDesktopBridge, PrinterConfig, PrintResult } from '@/lib/desktop/bridge';
import type { TicketDoc } from '@/lib/print/ticketDoc';

// The staff print pipeline as explicit machines (lib/pos/printQueue.ts tables,
// lib/pos/printDock.ts engine) and the bugs they were made explicit for:
//   - the dock was page-scoped, so leaving a screen dropped queued tickets, the
//     frame and the chip (now one engine for the shell, with a real dispose);
//   - a late "printed" from a torn-down frame could settle the next job;
//   - a desktop job to kitchen + bar failed whole when one printer threw, and
//     Retry reprinted the kitchen's copy; a timed-out print kept printing while
//     its retry printed it again.

function fakeClock() {
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 0;
  let now = 0;
  return {
    setTimer: (fn: () => void, ms: number) => {
      nextId += 1;
      timers.set(nextId, { fn, at: now + ms });
      return nextId;
    },
    clearTimer: (handle: unknown) => {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('print machines — the tables', () => {
  it('every job state has a row, and every move named in it is a known state or exit', () => {
    const known = new Set<string>([...PRINT_JOB_STATES, ...PRINT_JOB_EXITS]);
    for (const state of PRINT_JOB_STATES) {
      expect(PRINT_JOB_TRANSITIONS[state]).toBeDefined();
      for (const to of PRINT_JOB_TRANSITIONS[state]) expect(known.has(to)).toBe(true);
    }
  });

  it('job matrix: only the pump starts a job, only a failed job is retried or dismissed', () => {
    expect(canTransitionPrintJob('queued', 'printing').ok).toBe(true);
    expect(canTransitionPrintJob('queued', 'failed').ok).toBe(false);
    expect(canTransitionPrintJob('printing', 'handed-off').ok).toBe(true);
    expect(canTransitionPrintJob('printing', 'done').ok).toBe(true);
    expect(canTransitionPrintJob('printing', 'queued').ok).toBe(false);
    expect(canTransitionPrintJob('printing', 'dismissed').ok).toBe(false);
    expect(canTransitionPrintJob('handed-off', 'failed').ok).toBe(true);
    expect(canTransitionPrintJob('handed-off', 'queued').ok).toBe(false);
    expect(canTransitionPrintJob('failed', 'queued').ok).toBe(true);
    expect(canTransitionPrintJob('failed', 'dismissed').ok).toBe(true);
    const refused = canTransitionPrintJob('queued', 'dismissed');
    expect(refused).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(refused.message).toContain('queued → dismissed');
  });

  it('queue phases: disposed is terminal', () => {
    for (const phase of PRINT_QUEUE_PHASES) expect(PRINT_QUEUE_TRANSITIONS[phase]).toBeDefined();
    expect(canTransitionPrintQueue('idle', 'running').ok).toBe(true);
    expect(canTransitionPrintQueue('running', 'running').ok).toBe(false);
    expect(canTransitionPrintQueue('running', 'disposed').ok).toBe(true);
    for (const to of PRINT_QUEUE_PHASES) expect(canTransitionPrintQueue('disposed', to).ok).toBe(false);
  });

  it('target matrix: an in-flight copy can only become unknown by being abandoned, and unknown needs an answer', () => {
    for (const state of PRINT_TARGET_STATES) expect(PRINT_TARGET_TRANSITIONS[state]).toBeDefined();
    expect(canTransitionPrintTarget('printing', 'unknown').ok).toBe(true);
    expect(canTransitionPrintTarget('pending', 'unknown').ok).toBe(false);
    expect(canTransitionPrintTarget('unknown', 'printing').ok).toBe(false); // never resent without a decision
    expect(canTransitionPrintTarget('unknown', 'pending').ok).toBe(true);
    expect(canTransitionPrintTarget('unknown', 'skipped').ok).toBe(true);
    expect(canTransitionPrintTarget('printed', 'printing').ok).toBe(false);
    expect(canTransitionPrintTarget('skipped', 'pending').ok).toBe(false);
  });

  it('nextPrintTarget ignores a late answer from an attempt that no longer owns the copy', () => {
    const unknown = { printer: 'Kitchen', state: 'unknown' as const, attempt: 1 };
    expect(nextPrintTarget(unknown, { printer: 'Kitchen', state: 'printed', confirmed: true }, 1)).toEqual({
      printer: 'Kitchen',
      state: 'printed',
      attempt: 1,
      confirmed: true,
    });
    // The staffer chose to reprint and attempt 2 now owns it.
    const resent = { printer: 'Kitchen', state: 'printing' as const, attempt: 2 };
    expect(nextPrintTarget(resent, { printer: 'Kitchen', state: 'failed' }, 1)).toBeNull();
    // A plan announcement never overwrites what is known.
    expect(nextPrintTarget(unknown, { printer: 'Kitchen', state: 'pending' }, 2)).toBeNull();
  });

  it('busy / outcome helpers read only the work queue', () => {
    const job = (id: string, state: PrintJob['state']): PrintJob => ({ id, orderId: 'o', type: 'kot', state, attempts: 1 });
    expect(isPrintQueueBusy({ jobs: [job('a', 'failed')] })).toBe(false);
    expect(isPrintQueueBusy({ jobs: [job('a', 'queued')] })).toBe(true);
    const snapshot = { jobs: [job('a', 'printing'), job('b', 'failed')] };
    expect(printJobsOutcome(snapshot, ['a'])).toBe('pending');
    expect(printJobsOutcome(snapshot, ['b'])).toBe('failed');
    expect(printJobsOutcome(snapshot, ['gone'])).toBe('done');
    expect(printJobsOutcome(snapshot, [])).toBe('done');
  });
});

/** A queue with a hand-cranked clock and an executor the test drives. */
function buildQueue() {
  const clock = fakeClock();
  const started: { job: PrintJob; ctx: PrintAttemptContext; settle: ReturnType<typeof deferred<void | { confirmed: boolean }>> }[] = [];
  let ids = 0;
  const queue = new PrintQueue({
    execute: (job, ctx) => {
      const settle = deferred<void | { confirmed: boolean }>();
      started.push({ job, ctx, settle });
      return settle.promise;
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: () => `job-${++ids}`,
  });
  return { queue, clock, started };
}

describe('PrintQueue — lifecycle', () => {
  it('reports its phase', async () => {
    const { queue, started } = buildQueue();
    expect(queue.snapshot().phase).toBe('idle');
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    expect(queue.snapshot().phase).toBe('running');
    started[0].settle.resolve({ confirmed: true });
    await flush();
    expect(queue.snapshot().phase).toBe('idle');
  });

  it('aborts the attempt signal when the watchdog gives up', async () => {
    const { queue, clock, started } = buildQueue();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    expect(started[0].ctx.signal.aborted).toBe(false);
    clock.advance(PRINT_TIMEOUT_MS);
    expect(started[0].ctx.signal.aborted).toBe(true);
  });

  it('dispose clears the watchdog and every hand-off timer, aborts the attempt, and then does nothing', async () => {
    const { queue, clock, started } = buildQueue();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }, { orderId: 'o1', type: 'receipt' }]);
    started[0].settle.resolve(); // handed off: a 15s timer
    await flush();
    expect(clock.pending()).toBe(2); // hand-off + the receipt's watchdog

    queue.dispose();
    expect(clock.pending()).toBe(0);
    expect(started[1].ctx.signal.aborted).toBe(true);
    expect(queue.snapshot().phase).toBe('disposed');

    // Nothing it hears afterwards does anything.
    started[1].settle.resolve();
    await flush();
    expect(queue.enqueue([{ orderId: 'o2', type: 'kot' }])).toEqual([]);
    expect(started).toHaveLength(2);
    expect(queue.snapshot().jobs.map((j) => j.state)).toEqual(['printing']);
  });
});

describe('PrintQueue — per-target retry', () => {
  function failWithTargets(targets: Record<string, 'printed' | 'failed' | 'printing' | 'pending'>, confirmed = true) {
    const built = buildQueue();
    const [job] = built.queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    const { ctx } = built.started[0];
    for (const [key, state] of Object.entries(targets)) {
      ctx.report(key, { printer: key.split('#')[0], state: 'pending' });
      if (state === 'pending') continue;
      ctx.report(key, { printer: key.split('#')[0], state: 'printing' });
      if (state === 'printing') continue;
      ctx.report(key, { printer: key.split('#')[0], state, confirmed });
    }
    return { ...built, job };
  }

  it('a timeout leaves the in-flight copy unknown, and Retry asks before resending it', async () => {
    const { queue, clock, started, job } = failWithTargets({ 'Kitchen#1': 'printing', 'Kitchen#2': 'pending' });
    clock.advance(PRINT_TIMEOUT_MS);
    const failed = queue.snapshot().failed[0];
    expect(failed.targets?.['Kitchen#1'].state).toBe('unknown');
    expect(unsurePrinters(failed)).toEqual(['Kitchen']);
    expect(printUnsureMessage(failed)).toBe('Kitchen may already have printed this KOT — check before reprinting.');
    expect(printUnsureSkipLabel(failed)).toBe('Kitchen printed it');

    expect(queue.retry(job.id)).toBe('needs-decision');
    await flush();
    expect(started).toHaveLength(1);
  });

  it('"it printed" sends only the copies nobody has', async () => {
    const { queue, clock, started, job } = failWithTargets({ 'Kitchen#1': 'printing', 'Kitchen#2': 'pending' });
    clock.advance(PRINT_TIMEOUT_MS);
    expect(queue.retry(job.id, { unknown: 'skip' })).toBe('queued');
    const targets = started[1].job.targets!;
    expect(targets['Kitchen#1'].state).toBe('skipped');
    expect(targets['Kitchen#2'].state).toBe('pending');
  });

  it('"it printed" with nothing else owed clears the job without printing', async () => {
    const { queue, clock, started, job } = failWithTargets({ 'Kitchen#1': 'printing' });
    clock.advance(PRINT_TIMEOUT_MS);
    expect(queue.retry(job.id, { unknown: 'skip' })).toBe('done');
    expect(started).toHaveLength(1);
    expect(queue.snapshot().jobs).toHaveLength(0);
  });

  it('reprint resends the unsure copy', async () => {
    const { queue, clock, started, job } = failWithTargets({ 'Kitchen#1': 'printing' });
    clock.advance(PRINT_TIMEOUT_MS);
    expect(queue.retry(job.id, { unknown: 'reprint' })).toBe('queued');
    expect(started[1].job.targets!['Kitchen#1'].state).toBe('pending');
  });

  it('a late answer settles the unsure copy: confirmed paper clears the chip with nothing to tap', async () => {
    const { queue, clock, started } = failWithTargets({ 'Kitchen#1': 'printing', 'Bar#1': 'printed' });
    clock.advance(PRINT_TIMEOUT_MS);
    expect(queue.snapshot().failed).toHaveLength(1);
    started[0].ctx.report('Kitchen#1', { printer: 'Kitchen', state: 'printed', confirmed: true });
    expect(queue.snapshot().failed).toHaveLength(0);
    expect(queue.snapshot().handedOff).toHaveLength(0);
    expect(queue.snapshot().failureCount).toBe(1); // the shift tally does not unwind
  });

  it('a late spooler-only answer goes to the hand-off chip, where "Didn’t print" still works', async () => {
    const { queue, clock, started } = failWithTargets({ 'Kitchen#1': 'printing' });
    clock.advance(PRINT_TIMEOUT_MS);
    started[0].ctx.report('Kitchen#1', { printer: 'Kitchen', state: 'printed', confirmed: false });
    expect(queue.snapshot().failed).toHaveLength(0);
    expect(queue.snapshot().handedOff).toHaveLength(1);
    clock.advance(HANDOFF_VISIBLE_MS);
    expect(queue.snapshot().handedOff).toHaveLength(0);
  });

  it('a late failure turns "may have printed" into a plain retry of that copy', async () => {
    const { queue, clock, started, job } = failWithTargets({ 'Kitchen#1': 'printing', 'Bar#1': 'printed' });
    clock.advance(PRINT_TIMEOUT_MS);
    started[0].ctx.report('Kitchen#1', { printer: 'Kitchen', state: 'failed' });
    expect(unsurePrinters(queue.snapshot().failed[0])).toEqual([]);
    expect(queue.retry(job.id)).toBe('queued');
    const targets = started[1].job.targets!;
    expect(targets['Kitchen#1'].state).toBe('failed'); // owed again
    expect(targets['Bar#1'].state).toBe('printed'); // not resent
  });

  it('"Didn’t print" makes the unvouched copies owed again and keeps the vouched ones', async () => {
    const { queue, started, job } = failWithTargets({ 'Kitchen#1': 'printed', 'Bar#1': 'pending' });
    // Bar answered without being able to see paper (a spooler).
    started[0].ctx.report('Bar#1', { printer: 'Bar', state: 'printing' });
    started[0].ctx.report('Bar#1', { printer: 'Bar', state: 'printed', confirmed: false });
    started[0].settle.resolve({ confirmed: false });
    await flush();
    expect(queue.snapshot().handedOff).toHaveLength(1);

    queue.reportNotPrinted(job.id);
    const failed = queue.snapshot().failed[0];
    expect(failed.targets?.['Kitchen#1'].state).toBe('printed');
    expect(failed.targets?.['Bar#1'].state).toBe('pending');
  });
});

describe('PrintDockEngine — one dock, frames that can only speak for themselves', () => {
  function buildEngine(desktopExecutor?: DesktopPrintExecutor) {
    const clock = fakeClock();
    let ids = 0;
    const engine = new PrintDockEngine({
      desktopExecutor,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      newId: () => `job-${++ids}`,
    });
    return { engine, clock };
  }

  it('mounts a frame for the running attempt and settles on that frame’s answer', async () => {
    const { engine } = buildEngine();
    const [job] = engine.enqueue([{ orderId: 'o1', type: 'kot' }]);
    const frame = engine.getSnapshot().frame!;
    expect(frame).toMatchObject({ key: `${job.id}#1`, orderId: 'o1', type: 'kot', src: '/staff-print/o1/kot?auto=1' });

    engine.frameEvent(frame.key, 'printed');
    await flush();
    expect(engine.getSnapshot().frame).toBeNull();
    expect(engine.getSnapshot().jobs).toHaveLength(0);
    expect(engine.getSnapshot().handedOff.map((j) => j.id)).toEqual([job.id]);
  });

  it('a late "printed" from a torn-down frame cannot settle the next job', async () => {
    const { engine, clock } = buildEngine();
    engine.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    const kotFrame = engine.getSnapshot().frame!;
    clock.advance(PRINT_TIMEOUT_MS); // the KOT frame never answered
    await flush();
    const receiptFrame = engine.getSnapshot().frame!;
    expect(receiptFrame.type).toBe('receipt');

    // The torn-down KOT frame finally speaks — by key, and by message.
    engine.frameEvent(kotFrame.key, 'printed');
    engine.frameMessage({ channel: 'hioc-print', event: 'printed', orderId: 'o1', type: 'kot' }, true);
    // A message that is not from the frame mounted now, even naming the right job.
    engine.frameMessage({ channel: 'hioc-print', event: 'printed', orderId: 'o1', type: 'receipt' }, false);
    await flush();
    expect(engine.getSnapshot().jobs.map((j) => [j.type, j.state])).toEqual([
      ['kot', 'failed'],
      ['receipt', 'printing'],
    ]);

    engine.frameMessage({ channel: 'hioc-print', event: 'printed', orderId: 'o1', type: 'receipt' }, true);
    await flush();
    expect(engine.getSnapshot().jobs.map((j) => j.type)).toEqual(['kot']);
  });

  it('a stale frame’s "dialog" does not pause the next job’s watchdog', async () => {
    const { engine, clock } = buildEngine();
    engine.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    const kotFrame = engine.getSnapshot().frame!;
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();
    engine.frameEvent(kotFrame.key, 'dialog');
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();
    expect(engine.getSnapshot().failed.map((j) => j.type)).toEqual(['kot', 'receipt']);
  });

  it('a retry gets a frame of its own, so the first attempt’s frame cannot answer for it', async () => {
    const { engine, clock } = buildEngine();
    const [job] = engine.enqueue([{ orderId: 'o1', type: 'kot' }]);
    const first = engine.getSnapshot().frame!;
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();
    engine.retry(job.id);
    const second = engine.getSnapshot().frame!;
    expect(second.key).not.toBe(first.key);
    engine.frameEvent(first.key, 'printed');
    await flush();
    expect(engine.getSnapshot().jobs[0].state).toBe('printing');
  });

  it('dispose clears every timer and frame, and ignores anything after', async () => {
    const { engine, clock } = buildEngine();
    const listener = vi.fn();
    engine.subscribe(listener);
    engine.enqueue([{ orderId: 'o1', type: 'kot' }]);
    const frame = engine.getSnapshot().frame!;
    expect(clock.pending()).toBe(1);
    listener.mockClear();

    engine.dispose();
    expect(engine.disposed).toBe(true);
    expect(clock.pending()).toBe(0);
    expect(engine.getSnapshot().frame).toBeNull();
    expect(engine.getSnapshot().phase).toBe('disposed');

    engine.frameEvent(frame.key, 'printed');
    expect(engine.enqueue([{ orderId: 'o2', type: 'kot' }])).toEqual([]);
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });

  it('uses the desktop executor when there is one, and the frame when no printer is configured at all', async () => {
    const seen: PrintAttemptContext[] = [];
    const desktop = vi.fn(async (_job: PrintJob, ctx: PrintAttemptContext) => {
      seen.push(ctx);
      return { confirmed: true };
    });
    const { engine } = buildEngine(desktop);
    engine.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    expect(desktop).toHaveBeenCalledTimes(1);
    expect(seen[0].signal).toBeInstanceOf(AbortSignal);
    expect(engine.getSnapshot().jobs).toHaveLength(0);

    const unconfigured = buildEngine(async () => {
      throw new NoPrintersConfiguredError();
    });
    unconfigured.engine.enqueue([{ orderId: 'o2', type: 'receipt' }]);
    await flush();
    expect(unconfigured.engine.getSnapshot().frame).toMatchObject({ orderId: 'o2', type: 'receipt' });
  });
});

// The real desktop executor driven by the real queue: the §7 bugs end to end.
describe('desktop executor + queue — retry only what did not print', () => {
  const TICKET_DOC: TicketDoc = { type: 'kot', orderId: 'order-1', blocks: [{ kind: 'text', text: 'Test' }] };

  function printer(id: string, copies = 1): PrinterConfig {
    return {
      id,
      name: id[0].toUpperCase() + id.slice(1),
      connection: { kind: 'network', host: '10.0.0.5', port: 9100 },
      paperWidthMm: 80,
      roles: ['kot'],
      copies: { kot: copies },
      cut: true,
      drawer: false,
    };
  }

  function rig(printers: PrinterConfig[], printRaw: (id: string) => Promise<PrintResult>) {
    const calls: string[] = [];
    const bridge = {
      version: '0.1.0',
      platform: 'darwin',
      printers: { list: vi.fn().mockResolvedValue(printers), save: vi.fn(), detect: vi.fn(), status: vi.fn() },
      printRaw: vi.fn((id: string) => {
        calls.push(id);
        return printRaw(id);
      }),
      printUrl: vi.fn(),
      openDrawer: vi.fn(),
    } as unknown as HiocDesktopBridge;
    const clock = fakeClock();
    const queue = new PrintQueue({
      execute: createDesktopExecutor(bridge),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    return { queue, clock, calls };
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ doc: TICKET_DOC }) })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('kitchen + bar: the bar failing does not reprint the kitchen’s KOT on Retry', async () => {
    let barUp = false;
    const { queue, calls } = rig([printer('kitchen'), printer('bar')], async (id) => {
      if (id === 'bar' && !barUp) throw new Error('paper out');
      return { confirmed: true };
    });
    const [job] = queue.enqueue([{ orderId: 'order-1', type: 'kot' }]);
    await flush();
    const failed = queue.snapshot().failed[0];
    expect(failed.targets?.['kitchen#1'].state).toBe('printed');
    expect(failed.targets?.['bar#1'].state).toBe('failed');

    barUp = true;
    queue.retry(job.id);
    await flush();
    expect(calls).toEqual(['kitchen', 'bar', 'bar']);
    expect(queue.snapshot().jobs).toHaveLength(0); // every copy vouched for
  });

  it('a copy failing mid-way does not reprint the copies before it', async () => {
    let n = 0;
    const { queue, calls } = rig([printer('kitchen', 3)], async () => {
      n += 1;
      if (n === 2) throw new Error('cover open');
      return { confirmed: true };
    });
    const [job] = queue.enqueue([{ orderId: 'order-1', type: 'kot' }]);
    await flush();
    expect(calls).toHaveLength(2); // copy 3 never started
    queue.retry(job.id);
    await flush();
    expect(calls).toHaveLength(4); // copies 2 and 3 only — not 1 again
    expect(queue.snapshot().jobs).toHaveLength(0);
  });

  it('a timed-out print is not also printed by its retry, and no new copy starts after the timeout', async () => {
    const inFlight = deferred<PrintResult>();
    let first = true;
    const { queue, clock, calls } = rig([printer('kitchen', 2)], () => {
      if (first) {
        first = false;
        return inFlight.promise;
      }
      return Promise.resolve({ confirmed: true });
    });
    const [job] = queue.enqueue([{ orderId: 'order-1', type: 'kot' }]);
    await flush();
    expect(calls).toEqual(['kitchen']);

    clock.advance(PRINT_TIMEOUT_MS);
    expect(queue.retry(job.id)).toBe('needs-decision'); // copy 1 may be on the rail
    await flush();
    expect(calls).toEqual(['kitchen']);

    // The bridge answers late: copy 1 did print. Copy 2 was never started.
    inFlight.resolve({ confirmed: true });
    await flush();
    expect(calls).toEqual(['kitchen']);
    const failed = queue.snapshot().failed[0];
    expect(failed.targets?.['kitchen#1'].state).toBe('printed');
    expect(failed.targets?.['kitchen#2'].state).toBe('pending');

    expect(queue.retry(job.id)).toBe('queued');
    await flush();
    expect(calls).toEqual(['kitchen', 'kitchen']); // copy 2, once
    expect(queue.snapshot().jobs).toHaveLength(0);
  });
});
