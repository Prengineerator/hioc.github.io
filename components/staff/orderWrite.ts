// The staff screens' side of the retry contract on the routes that change a
// bill or its money after the fact — POST /api/orders/[id]/amend (add items,
// edit, void a line) and POST /api/orders/[id]/balance (collect, give back,
// let go). See lib/orders/concurrency.ts for the server half.
//
// Every such request carries `expected_version`: the order `version` the
// screen showed when the staffer decided. A tap on a laggy tablet whose answer
// was lost (the change DID land, the version moved on) is then refused with a
// 409 `stale_version` instead of adding the items, or handing back the money,
// a second time. The screen never retries a money call by itself: a stale
// answer means "look at the order again", so the caller refetches it and shows
// ORDER_CHANGED_MESSAGE, and the staffer decides.
//
// Pure apart from the injected fetch, so the classification is unit-tested.

import { STALE_VERSION_CODE } from '@/lib/orders/concurrency';

/** What the staffer is told when the order moved on under the request. */
export const ORDER_CHANGED_MESSAGE = 'This order changed — check it and try again';

/** The network failed: the change may or may not have landed. */
export const NETWORK_MESSAGE = 'Could not reach the server. Check the connection and try again.';

/**
 * `body` with the version the screen showed, when it has one. A screen that
 * doesn't know the version sends nothing extra, and the route behaves exactly
 * as before (the field is optional on the server).
 */
export function withExpectedVersion<T extends Record<string, unknown>>(
  body: T,
  version: number | null | undefined,
): T & { expected_version?: number } {
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) return body;
  return { ...body, expected_version: version };
}

/** A 409 the version guard sent (as opposed to any other conflict). */
export function isStaleVersion(status: number, data: unknown): boolean {
  return (
    status === 409 &&
    typeof data === 'object' &&
    data !== null &&
    (data as { code?: unknown }).code === STALE_VERSION_CODE
  );
}

export type OrderWriteResult<T> =
  /** The server took the change; `data` is its answer. */
  | { kind: 'ok'; data: T }
  /** The order moved on since the screen loaded it — refetch, don't retry. */
  | { kind: 'stale'; message: string; version: number | null }
  /** The server refused (validation, permission, any other conflict). */
  | { kind: 'error'; status: number; message: string }
  /** No answer: the change may have landed. A retry is safe — it carries the old version. */
  | { kind: 'network'; message: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/**
 * POST a bill/money change and classify the answer. Never throws, never
 * retries. `fallback` is the message for a refusal that carries none.
 */
export async function sendOrderWrite<T>(
  url: string,
  body: Record<string, unknown>,
  fallback: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<OrderWriteResult<T>> {
  let res: Pick<Response, 'ok' | 'status' | 'json'>;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: 'network', message: NETWORK_MESSAGE };
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: unknown; version?: unknown }) | null;
  if (res.ok) return { kind: 'ok', data: (data ?? {}) as T };
  if (isStaleVersion(res.status, data)) {
    return {
      kind: 'stale',
      message: ORDER_CHANGED_MESSAGE,
      version: typeof data?.version === 'number' ? data.version : null,
    };
  }
  const error = typeof data?.error === 'string' && data.error ? data.error : fallback;
  return { kind: 'error', status: res.status, message: error };
}
