import { describe, expect, it, vi } from 'vitest';
import {
  describePrintJob,
  ESCALATE_AFTER_FAILURES,
  HANDOFF_VISIBLE_MS,
  printFailureMessage,
  printFrameSrc,
  PrintQueue,
  PRINT_DIALOG_TIMEOUT_MS,
  PRINT_TIMEOUT_MS,
  type PrintJob,
  type PrintQueueSnapshot,
} from '@/lib/pos/printQueue';

// PRT-3 — the watchdog behind silent printing. Pure: the queue is driven by an
// injected executor and an injected clock, so "what happens when the printer
// never answers" is a test rather than a ten-second wait at the counter.

/** A hand-cranked clock, so a 10s timeout is asserted in microseconds. */
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

/** An executor whose promises the test settles by hand. */
function manualExecutor() {
  const started: PrintJob[] = [];
  const settlers: { resolve: () => void; reject: () => void }[] = [];
  return {
    started,
    settlers,
    execute: (job: PrintJob) => {
      started.push(job);
      return new Promise<void>((resolve, reject) => settlers.push({ resolve, reject }));
    },
  };
}

/** Lets the executor's promise callbacks run. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function build(
  overrides: {
    abort?: (job: PrintJob) => void;
    onChange?: (snapshot: PrintQueueSnapshot) => void;
  } = {},
) {
  const clock = fakeClock();
  const exec = manualExecutor();
  let ids = 0;
  const queue = new PrintQueue({
    execute: exec.execute,
    abort: overrides.abort,
    onChange: overrides.onChange,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    newId: () => `job-${++ids}`,
  });
  return { queue, clock, exec };
}

describe('printFrameSrc', () => {
  it('asks the print page to print itself and report back', () => {
    expect(printFrameSrc('abc-123', 'kot')).toBe('/staff-print/abc-123/kot?auto=1');
  });
});

describe('PrintQueue ordering', () => {
  it('runs one job at a time — a second print never starts while one is live', async () => {
    // Two window.print() calls in flight race and one silently does nothing;
    // on a KOT+receipt order that is the kitchen's ticket.
    const { queue, exec } = build();
    queue.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    await flush();
    expect(exec.started.map((j) => j.type)).toEqual(['kot']);

    exec.settlers[0].resolve();
    await flush();
    expect(exec.started.map((j) => j.type)).toEqual(['kot', 'receipt']);
  });

  it('keeps the order it was given', async () => {
    const { queue, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    queue.enqueue([{ orderId: 'o1', type: 'receipt' }]);
    await flush();
    exec.settlers[0].resolve();
    await flush();
    expect(exec.started.map((j) => j.type)).toEqual(['kot', 'receipt']);
  });

  it('does nothing for an empty plan', () => {
    const { queue, exec } = build();
    expect(queue.enqueue([])).toEqual([]);
    expect(exec.started).toHaveLength(0);
    expect(queue.snapshot().jobs).toHaveLength(0);
  });
});

describe('PrintQueue success is silent', () => {
  it('leaves nothing behind when a job prints', async () => {
    // The whole point of the pipeline: a staffer never learns that printing
    // worked, because there is nothing to learn. Every snapshot along the way is
    // failure-free, so no UI built on them can announce a success.
    const seen: PrintQueueSnapshot[] = [];
    const { queue, exec } = build({ onChange: (s) => seen.push(s) });
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    exec.settlers[0].resolve();
    await flush();

    const snap = queue.snapshot();
    expect(snap.jobs).toHaveLength(0);
    expect(snap.failed).toHaveLength(0);
    expect(snap.failureCount).toBe(0);
    expect(snap.escalate).toBe(false);
    expect(seen.every((s) => s.failed.length === 0 && s.failureCount === 0)).toBe(true);
    expect(seen[seen.length - 1].jobs).toHaveLength(0);
  });

  it('clears the watchdog when a job finishes in time', async () => {
    const { queue, clock, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    expect(clock.pending()).toBe(1);
    exec.settlers[0].resolve();
    await flush();

    // The watchdog is gone: its deadline passes without failing the job. (One
    // timer remains — the hand-off window below, which is not a watchdog.)
    clock.advance(PRINT_TIMEOUT_MS * 2);
    expect(queue.snapshot().failed).toHaveLength(0);
    expect(queue.snapshot().failureCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PRT-3's honest limit: `afterprint` is not evidence that paper came out.
// ---------------------------------------------------------------------------

describe('PrintQueue hand-off — the browser accepting a job is not proof of paper', () => {
  it('holds a completed job briefly instead of deleting it silently', async () => {
    const { queue, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    exec.settlers[0].resolve();
    await flush();

    const snap = queue.snapshot();
    // Off the work queue and not a failure...
    expect(snap.jobs).toHaveLength(0);
    expect(snap.failed).toHaveLength(0);
    // ...but still challengeable, because a dead printer looks exactly like
    // this and no browser API can tell the difference.
    expect(snap.handedOff.map((j) => j.type)).toEqual(['kot']);
  });

  it('forgets it on its own, so a normal night needs no dismissing', async () => {
    const { queue, clock, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    exec.settlers[0].resolve();
    await flush();
    expect(queue.snapshot().handedOff).toHaveLength(1);

    clock.advance(HANDOFF_VISIBLE_MS);

    expect(queue.snapshot().handedOff).toHaveLength(0);
    expect(queue.snapshot().failureCount).toBe(0);
  });

  it('turns "didn’t print" into a real failure the staffer can retry', async () => {
    const { queue, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    exec.settlers[0].resolve();
    await flush();

    // The printer was off. The staffer is the only sensor that can see that.
    queue.reportNotPrinted(queue.snapshot().handedOff[0].id);

    const snap = queue.snapshot();
    expect(snap.handedOff).toHaveLength(0);
    expect(snap.failed.map((j) => j.type)).toEqual(['kot']);
    // It counts toward the shift tally, so three dead prints still escalate.
    expect(snap.failureCount).toBe(1);

    queue.retry(snap.failed[0].id);
    await flush();
    expect(exec.started).toHaveLength(2);
  });

  it('acknowledging drops it without counting a failure', async () => {
    const { queue, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    exec.settlers[0].resolve();
    await flush();

    queue.acknowledge(queue.snapshot().handedOff[0].id);

    expect(queue.snapshot().handedOff).toHaveLength(0);
    expect(queue.snapshot().failureCount).toBe(0);
  });

  it('does not block the next job while a hand-off is on screen', async () => {
    const { queue, exec } = build();
    queue.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    await flush();
    exec.settlers[0].resolve();
    await flush();

    expect(exec.started.map((j) => j.type)).toEqual(['kot', 'receipt']);
    expect(queue.snapshot().handedOff.map((j) => j.type)).toEqual(['kot']);
  });
});

describe('PrintQueue watchdog vs. the print dialog', () => {
  // window.print() halts script execution on the renderer thread the POS shares
  // with the print frame, so the 10s timer cannot fire while the dialog is up —
  // and when it closes, the overdue timer and afterprint race with no defined
  // ordering. A timer win marks a job failed for a ticket that printed, and its
  // Retry puts a second one on the kitchen rail.
  it('does not fail a job at 10s while a human is at the print dialog', async () => {
    const { queue, clock, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();

    queue.noteDialogOpen();
    clock.advance(PRINT_TIMEOUT_MS * 3); // staffer is picking a printer

    expect(queue.snapshot().failed).toHaveLength(0);
    expect(queue.snapshot().jobs[0].state).toBe('printing');

    exec.settlers[0].resolve();
    await flush();
    expect(queue.snapshot().handedOff).toHaveLength(1);
  });

  it('still gives up eventually if the dialog is never answered', async () => {
    const { queue, clock } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();

    queue.noteDialogOpen();
    clock.advance(PRINT_DIALOG_TIMEOUT_MS);

    expect(queue.snapshot().failed).toHaveLength(1);
  });

  it('ignores a dialog message when nothing is running', () => {
    const { queue, clock } = build();
    expect(() => queue.noteDialogOpen()).not.toThrow();
    expect(clock.pending()).toBe(0);
  });
});

describe('PrintQueue failure is loud', () => {
  it('fails a job that never reports back, after the timeout', async () => {
    const { queue, clock } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();

    clock.advance(PRINT_TIMEOUT_MS - 1);
    expect(queue.snapshot().failed).toHaveLength(0); // still waiting, still silent

    clock.advance(1);
    const failed = queue.snapshot().failed;
    expect(failed).toHaveLength(1);
    expect(failed[0].type).toBe('kot');
    expect(queue.snapshot().failureCount).toBe(1);
  });

  it('tears the timed-out job down so it cannot race the next one', async () => {
    const aborted: string[] = [];
    const { queue, clock } = build({ abort: (job) => aborted.push(job.type) });
    queue.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    await flush();
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();
    expect(aborted).toEqual(['kot']);
  });

  it('carries on with the queue after a failure', async () => {
    const { queue, clock, exec } = build();
    queue.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    await flush();
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();
    expect(exec.started.map((j) => j.type)).toEqual(['kot', 'receipt']);
  });

  it('fails a job whose execution rejects', async () => {
    const { queue, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'receipt' }]);
    await flush();
    exec.settlers[0].reject();
    await flush();
    expect(queue.snapshot().failed.map((j) => j.type)).toEqual(['receipt']);
  });

  it('ignores a print that reports back after it already timed out', async () => {
    // The slow-driver case (spec E9): the frame finally answers, but the job has
    // been reported failed and the NEXT job now owns the printer. Letting the
    // straggler settle would clear the next job's watchdog.
    const { queue, clock, exec } = build();
    queue.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    await flush();
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();

    exec.settlers[0].resolve(); // the ghost
    await flush();

    expect(queue.snapshot().failed.map((j) => j.type)).toEqual(['kot']);
    expect(clock.pending()).toBe(1); // the receipt's watchdog is still armed
  });

  it('escalates once failures stop being bad luck', async () => {
    const { queue, clock } = build();
    for (let i = 0; i < ESCALATE_AFTER_FAILURES; i += 1) {
      queue.enqueue([{ orderId: `o${i}`, type: 'kot' }]);
      await flush();
      clock.advance(PRINT_TIMEOUT_MS);
      await flush();
      // Not before the third.
      if (i < ESCALATE_AFTER_FAILURES - 1) expect(queue.snapshot().escalate).toBe(false);
    }
    expect(queue.snapshot().failureCount).toBe(ESCALATE_AFTER_FAILURES);
    expect(queue.snapshot().escalate).toBe(true);
  });
});

describe('PrintQueue retry', () => {
  it('re-runs ONE job, never the whole plan', async () => {
    // Reprinting the KOT because the receipt failed puts a second ticket on the
    // kitchen rail, which reads as a second order.
    const { queue, clock, exec } = build();
    queue.enqueue([
      { orderId: 'o1', type: 'kot' },
      { orderId: 'o1', type: 'receipt' },
    ]);
    await flush();
    exec.settlers[0].resolve(); // KOT prints fine
    await flush();
    clock.advance(PRINT_TIMEOUT_MS); // receipt never answers
    await flush();

    const failed = queue.snapshot().failed;
    expect(failed).toHaveLength(1);
    queue.retry(failed[0].id);
    await flush();

    expect(exec.started.map((j) => j.type)).toEqual(['kot', 'receipt', 'receipt']);
    expect(exec.started[2].attempts).toBe(2);
    expect(queue.snapshot().failed).toHaveLength(0);
  });

  it('drops the chip when the retry prints', async () => {
    const { queue, clock, exec } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();

    queue.retry(queue.snapshot().failed[0].id);
    await flush();
    exec.settlers[1].resolve();
    await flush();

    expect(queue.snapshot().jobs).toHaveLength(0);
    // The count is a shift-long tally for escalation, so it does NOT unwind.
    expect(queue.snapshot().failureCount).toBe(1);
  });

  it('ignores a retry for a job that is not failed', async () => {
    const { queue, exec } = build();
    const [job] = queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    queue.retry(job.id); // still printing
    queue.retry('nope'); // never existed
    await flush();
    expect(exec.started).toHaveLength(1);
  });

  it('lets the staffer dismiss what they have dealt with', async () => {
    const { queue, clock } = build();
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();

    queue.dismiss(queue.snapshot().failed[0].id);
    expect(queue.snapshot().failed).toHaveLength(0);
    expect(queue.snapshot().jobs).toHaveLength(0);
  });
});

describe('PrintQueue notifications', () => {
  it('reports every state change to one subscriber', async () => {
    const onChange = vi.fn();
    const clock = fakeClock();
    const exec = manualExecutor();
    const queue = new PrintQueue({
      execute: exec.execute,
      onChange,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    queue.enqueue([{ orderId: 'o1', type: 'kot' }]);
    await flush();
    clock.advance(PRINT_TIMEOUT_MS);
    await flush();

    const last = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(last.failed).toHaveLength(1);
  });
});

describe('print wording', () => {
  it('names what did not print, so nobody has to guess', () => {
    expect(describePrintJob({ type: 'kot' })).toBe('KOT');
    expect(printFailureMessage([{ type: 'kot' }])).toBe('KOT didn’t print');
    expect(printFailureMessage([{ type: 'kot' }, { type: 'receipt' }])).toBe(
      'KOT and Receipt didn’t print',
    );
    expect(printFailureMessage([])).toBe('');
  });
});
