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
