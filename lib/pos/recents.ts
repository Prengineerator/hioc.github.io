// POS "Quick picks" recents — the last few DISTINCT menu items punched on THIS
// tablet, most-recent first. Zero backend: a small localStorage ring buffer so a
// repeat order is pure taps. SSR-guarded (the POS is a client component but the
// module may be imported in a server bundle). The pure `mergeRecent` transform is
// exported separately so the ring-buffer logic is unit-testable without a DOM.

const STORAGE_KEY = 'hioc.pos.recents.v1';
const CAP = 8;

// Pure ring-buffer step: move `id` to the front, de-duplicate, cap the length.
export function mergeRecent(prev: string[], id: string, cap = CAP): string[] {
  if (!id) return prev.slice(0, cap);
  return [id, ...prev.filter((x) => x !== id)].slice(0, cap);
}

export function readRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string').slice(0, CAP);
    }
    return [];
  } catch {
    return [];
  }
}

export function pushRecent(id: string): string[] {
  const next = mergeRecent(readRecents(), id);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // localStorage unavailable (private mode / quota) — recents just won't
      // persist across reloads, an acceptable degradation.
    }
  }
  return next;
}
