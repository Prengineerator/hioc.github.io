// The optional client concurrency token for the routes that change a bill or
// its money after the fact — POST /api/orders/[id]/amend (add items, edit,
// void a line) and POST /api/orders/[id]/balance (collect / give back / let go).
//
// A tap on a laggy tablet that times out gets retried. Without a token the
// retry is judged against the order as it is NOW: an add that already landed
// adds its items again, a collect that already landed collects again once a
// later change has put a balance back. With one, the retry says which version
// of the order the staffer was looking at, and an order that has moved on since
// (including by the first attempt itself — every one of these writes bumps
// `version`) refuses it with a 409 instead of applying it twice.
//
// Contract: body field `expected_version` — the `version` of the order the
// screen showed. Optional: absent (or null) behaves exactly as before. Present,
// it must be a whole number ≥ 0 (else 400), and must equal the order's current
// version (else 409, code 'stale_version'). Pure, so the routes and their tests
// share it.

export const STALE_VERSION_CODE = 'stale_version';

export const STALE_VERSION_MESSAGE =
  'This order has changed since you opened it (the change may already have gone through) — re-check it before trying again.';

export type ExpectedVersionCheck =
  | { ok: true; expected: number | null }
  | { ok: false; status: 400 | 409; error: string; code?: typeof STALE_VERSION_CODE };

export function checkExpectedVersion(raw: unknown, currentVersion: number): ExpectedVersionCheck {
  if (raw === undefined || raw === null) return { ok: true, expected: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    return { ok: false, status: 400, error: 'expected_version must be a whole number (the order version you saw)' };
  }
  if (raw !== currentVersion) {
    return { ok: false, status: 409, error: STALE_VERSION_MESSAGE, code: STALE_VERSION_CODE };
  }
  return { ok: true, expected: raw };
}
