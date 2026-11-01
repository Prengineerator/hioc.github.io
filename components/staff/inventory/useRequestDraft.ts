'use client';

// The current person's request draft (lib/inventory/requestDraft.ts), kept in
// this device's storage under their own user id, so it survives closing the
// sheet or a reload, and on a shared POS each PIN operator sees only their own.
// Storage can be unavailable (a private window, blocked site data): every read
// and write is guarded, and the draft then simply lives for the visit.

import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPTY_DRAFT, draftStorageKey, parseDraft, serializeDraft, type RequestDraft } from '@/lib/inventory/requestDraft';

function read(key: string): RequestDraft {
  try {
    return parseDraft(window.localStorage.getItem(key));
  } catch {
    return { ...EMPTY_DRAFT, lines: {} };
  }
}

function write(key: string, draft: RequestDraft): void {
  try {
    if (Object.keys(draft.lines).length === 0 && !draft.note) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, serializeDraft(draft));
  } catch {
    // Not saved: the draft still works for this visit.
  }
}

export interface RequestDraftApi {
  draft: RequestDraft;
  /** False until this person's saved draft has been read (avoids seeding over it). */
  loaded: boolean;
  update: (fn: (prev: RequestDraft) => RequestDraft) => void;
  clear: () => void;
}

export function useRequestDraft(actorId: string | null | undefined): RequestDraftApi {
  const [draft, setDraft] = useState<RequestDraft>({ ...EMPTY_DRAFT, lines: {} });
  const [loaded, setLoaded] = useState(false);
  const keyRef = useRef<string | null>(null);

  // A different person (a PIN switch on the POS) gets their own draft.
  useEffect(() => {
    if (!actorId) return;
    const key = draftStorageKey(actorId);
    keyRef.current = key;
    setDraft(read(key));
    setLoaded(true);
  }, [actorId]);

  const update = useCallback((fn: (prev: RequestDraft) => RequestDraft) => {
    setDraft((prev) => {
      const next = fn(prev);
      if (next !== prev && keyRef.current) write(keyRef.current, next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    const empty = { ...EMPTY_DRAFT, lines: {} };
    if (keyRef.current) write(keyRef.current, empty);
    setDraft(empty);
  }, []);

  return { draft, loaded, update, clear };
}
