// What a POS screen last saw, kept on this machine so the screen can draw at
// once and refresh behind it (stale-while-revalidate).
//
// The counter switches between New order, Tables and Live orders all day. Each
// of those used to mount empty and wait on the network before it drew anything,
// so a slow answer looked like a frozen screen. Now each screen draws the last
// answer it had, then asks the server; the server stays the authority and every
// order is still priced and checked there.
//
// Three places a snapshot can live:
//   memory   this page load only. Survives switching screens (the case that
//            matters), gone on a reload. For anything with customer details.
//   session  sessionStorage: also survives a reload or a crash of the tab, gone
//            when the window closes.
//   local    localStorage: survives restarts. Only for data with no customer
//            details in it (the tables registry, the menu).
//
// Storage keys carry the build, so a deploy that changes a shape never feeds new
// code an old one. Storage that throws (private mode, quota) just means no
// snapshot, the same failure posture as menuCache.ts and recents.ts.

export type SnapshotStore = 'memory' | 'session' | 'local';

export interface Snapshot<T> {
  savedAt: number;
  data: T;
}

export interface SnapshotOptions<T> {
  store: SnapshotStore;
  /** Older than this, a snapshot is not drawn. */
  maxAgeMs: number;
  /** Shape check for what comes back out of storage. */
  validate: (data: unknown) => data is T;
}

const BUILD = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 12) || 'dev';
const KEY_PREFIX = 'hioc.pos.snap.';

/** The storage key for a snapshot name in this build. */
export function snapshotStorageKey(name: string, build: string = BUILD): string {
  return `${KEY_PREFIX}${build}.${name}`;
}

/** Pure: a stored value back into a snapshot, or null if missing, malformed, too old or from the future. */
export function parseSnapshot<T>(
  raw: string | null,
  now: number,
  maxAgeMs: number,
  validate: (data: unknown) => data is T,
): Snapshot<T> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot<unknown>> | null;
    if (!parsed || typeof parsed.savedAt !== 'number') return null;
    if (!isFresh(parsed.savedAt, now, maxAgeMs)) return null;
    if (!validate(parsed.data)) return null;
    return { savedAt: parsed.savedAt, data: parsed.data };
  } catch {
    return null;
  }
}

function isFresh(savedAt: number, now: number, maxAgeMs: number): boolean {
  return savedAt <= now && now - savedAt <= maxAgeMs;
}

const memory = new Map<string, Snapshot<unknown>>();

function storageFor(store: SnapshotStore): Storage | null {
  if (store === 'memory' || typeof window === 'undefined') return null;
  try {
    return store === 'local' ? window.localStorage : window.sessionStorage;
  } catch {
    return null;
  }
}

/** The last snapshot under `name`, or null. Memory first, then storage. */
export function readSnapshot<T>(name: string, opts: SnapshotOptions<T>, now: number = Date.now()): Snapshot<T> | null {
  const held = memory.get(name);
  if (held && isFresh(held.savedAt, now, opts.maxAgeMs) && opts.validate(held.data)) {
    return held as Snapshot<T>;
  }
  const storage = storageFor(opts.store);
  if (!storage) return null;
  try {
    const parsed = parseSnapshot(storage.getItem(snapshotStorageKey(name)), now, opts.maxAgeMs, opts.validate);
    if (parsed) memory.set(name, parsed);
    return parsed;
  } catch {
    return null;
  }
}

/** Keep `data` as the latest snapshot under `name`. */
export function writeSnapshot<T>(
  name: string,
  data: T,
  opts: Pick<SnapshotOptions<T>, 'store'>,
  now: number = Date.now(),
): void {
  const snapshot: Snapshot<T> = { savedAt: now, data };
  memory.set(name, snapshot);
  const storage = storageFor(opts.store);
  if (!storage) return;
  try {
    // Snapshots kept by earlier builds are dead weight; clear them as we go.
    const current = snapshotStorageKey(name);
    const suffix = `.${name}`;
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key && key.startsWith(KEY_PREFIX) && key.endsWith(suffix) && key !== current) storage.removeItem(key);
    }
    storage.setItem(current, JSON.stringify(snapshot));
  } catch {
    // Quota or private mode: the screen still works, it just waits for the network.
  }
}

/** Forget every snapshot (sign-out): the next person starts from the server. */
export function clearSnapshots(): void {
  memory.clear();
  for (const store of ['session', 'local'] as const) {
    const storage = storageFor(store);
    if (!storage) continue;
    try {
      for (let i = storage.length - 1; i >= 0; i--) {
        const key = storage.key(i);
        if (key && key.startsWith(KEY_PREFIX)) storage.removeItem(key);
      }
    } catch {
      /* nothing kept, nothing to clear */
    }
  }
}

/** "just now" / "2 min ago" / "1 h ago" — for a "showing saved data" note. */
export function snapshotAgeLabel(savedAt: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - savedAt) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
