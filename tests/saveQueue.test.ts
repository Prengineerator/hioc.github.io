import { describe, expect, it, vi } from 'vitest';
import { SaveQueue } from '@/lib/staff/saveQueue';

// SET-1 bugfix — components/staff/settings/PrinterSettings.tsx's
// Ticket routing / Paper & cutting / Cash drawer sections used to derive
// each change from the `printers` React prop, which only updates once
// bridge.printers.save() resolves. Two quick toggles fired before that
// promise settled both computed `next` from the same stale list, so the
// second save silently overwrote the first. SaveQueue is the fix, extracted
// so the ordering/staleness logic is testable without mocking React or the
// desktop bridge.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('SaveQueue', () => {
  it('applies the updater synchronously and returns the new value', () => {
    const queue = new SaveQueue<string[]>([], async () => {});
    const next = queue.enqueue((prev) => [...prev, 'a'], () => {});
    expect(next).toEqual(['a']);
    expect(queue.current).toEqual(['a']);
  });

  it('a second enqueue right after the first builds on the first result, not a stale snapshot — the bug this fixes', () => {
    // The save() itself never resolves in this test — the point is that
    // `current`/the return value must already reflect BOTH changes before
    // either save call has settled, which is exactly what the old
    // `onChange(printers.map(...))` code (deriving from a React prop) could
    // not guarantee.
    const queue = new SaveQueue<string[]>([], () => new Promise<void>(() => {}));
    const afterA = queue.enqueue((prev) => [...prev, 'a'], () => {});
    const afterB = queue.enqueue((prev) => [...prev, 'b'], () => {});
    expect(afterA).toEqual(['a']);
    expect(afterB).toEqual(['a', 'b']);
    expect(queue.current).toEqual(['a', 'b']);
  });

  it('serializes save() calls strictly in the order enqueue() was called', async () => {
    const started: string[] = [];
    const settled: string[] = [];
    const first = deferred<void>();
    let calls = 0;
    const queue = new SaveQueue<string[]>([], (v) => {
      calls += 1;
      started.push(v.join(','));
      return calls === 1 ? first.promise : Promise.resolve();
    });

    queue.enqueue((prev) => [...prev, 'a'], (r) => settled.push(`${r.status}:${r.value.join(',')}`));
    queue.enqueue((prev) => [...prev, 'b'], (r) => settled.push(`${r.status}:${r.value.join(',')}`));

    // The second save must not start yet — it's chained behind the first,
    // which is still pending.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(['a']);
    expect(settled).toEqual([]);

    first.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(started).toEqual(['a', 'a,b']);
    expect(settled).toEqual(['saved:a', 'saved:a,b']);
  });

  it('reports a failed save via onSettled without breaking the chain for what comes after', async () => {
    const settled: string[] = [];
    let calls = 0;
    const queue = new SaveQueue<string[]>([], () => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve();
    });

    queue.enqueue((prev) => [...prev, 'a'], (r) => settled.push(r.status));
    // Built on top of the FIRST update's optimistic result even though that
    // save hasn't failed yet — so if this one succeeds, it persists 'a' too
    // (the self-healing property described in saveQueue.ts).
    queue.enqueue((prev) => [...prev, 'b'], (r) => settled.push(`${r.status}:${r.value.join(',')}`));

    await new Promise((r) => setTimeout(r, 0));

    expect(settled).toEqual(['error', 'saved:a,b']);
  });

  it('reset() replaces the known value without calling save()', () => {
    const save = vi.fn(async () => {});
    const queue = new SaveQueue<string[]>(['x'], save);
    queue.reset(['y']);
    expect(queue.current).toEqual(['y']);
    expect(save).not.toHaveBeenCalled();
    const next = queue.enqueue((prev) => [...prev, 'z'], () => {});
    expect(next).toEqual(['y', 'z']);
  });
});

// §11 — PrinterSettings' explicit "Save printer" and Delete used to call
// bridge.printers.save() directly with the whole list, beside this queue: an
// older autosave still queued behind them then wrote ITS whole list last,
// undoing the add or bringing the deleted printer back. Every write now goes
// through the queue, and reloads use resync() so they can't race a write.
describe('SaveQueue — explicit saves and reloads share the one queue', () => {
  /** A fake bridge store: save() resolves only when the test says so. */
  function store(initial: string[]) {
    let saved = initial;
    const pending: { value: string[]; done: ReturnType<typeof deferred<void>> }[] = [];
    return {
      get saved() {
        return saved;
      },
      pending,
      save: (value: string[]) => {
        const done = deferred<void>();
        pending.push({ value, done });
        return done.promise.then(() => {
          saved = value;
        });
      },
      list: async () => saved,
    };
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));

  it('an add queued behind an in-flight autosave lands last, carrying both changes', async () => {
    const s = store(['kitchen']);
    const queue = new SaveQueue<string[]>(['kitchen'], s.save);
    queue.enqueue((prev) => prev.map((p) => `${p}+cut`), () => {}); // the autosave, in flight
    const added = new Promise((resolve) => queue.enqueue((prev) => [...prev, 'bar'], resolve)); // Save printer

    await tick();
    expect(s.pending).toHaveLength(1); // the add waits its turn
    s.pending[0].done.resolve();
    await tick();
    s.pending[1].done.resolve();
    await added;
    expect(s.saved).toEqual(['kitchen+cut', 'bar']);
  });

  it('resync() reads only after the saves already queued have landed', async () => {
    const s = store(['kitchen']);
    const queue = new SaveQueue<string[]>(['kitchen'], s.save);
    queue.enqueue((prev) => prev.filter((p) => p !== 'kitchen'), () => {}); // Delete, in flight
    const reloaded = queue.resync(s.list);

    await tick();
    s.pending[0].done.resolve();
    expect(await reloaded).toEqual([]); // not the pre-delete ['kitchen']
    expect(queue.current).toEqual([]);
  });

  it('resync() gives way to a change queued while it waited', async () => {
    const s = store(['kitchen']);
    const queue = new SaveQueue<string[]>(['kitchen'], s.save);
    const reloaded = queue.resync(s.list);
    queue.enqueue((prev) => [...prev, 'bar'], () => {});
    expect(await reloaded).toBeNull();
    expect(queue.current).toEqual(['kitchen', 'bar']);
    // ...and that change's save still runs after the reload.
    await tick();
    expect(s.pending.map((p) => p.value)).toEqual([['kitchen', 'bar']]);
  });

  it('a failed load rejects resync() without stalling the queue', async () => {
    const save = vi.fn(async () => {});
    const queue = new SaveQueue<string[]>([], save);
    await expect(queue.resync(() => Promise.reject(new Error('ipc down')))).rejects.toThrow('ipc down');
    queue.enqueue((prev) => [...prev, 'a'], () => {});
    await tick();
    expect(save).toHaveBeenCalledWith(['a']);
  });
});
