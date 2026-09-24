// Fire a best-effort side effect (notification sends, analytics writes) AFTER
// a response has already been built, instead of making the caller wait on it.
//
// The order-creation route uses this for work that is documented as
// best-effort and never-throwing (writeOrderAttribution, markProfileStale,
// sendBillNotification) — awaiting those before replying 201 was pure latency
// with no bearing on whether the order succeeded.
//
// `waitUntil` (Vercel's Fluid Compute / Edge API) keeps the serverless
// function's execution environment alive until `promise` settles, so the work
// still completes reliably in production even though the HTTP response has
// already been sent. Outside a Vercel request context (local dev, tests, or
// another host) `getContext().waitUntil` is undefined and the call is a
// no-op — the promise we already started keeps running on Node's own event
// loop regardless, which is exactly what we want there too.
import 'server-only';
import { waitUntil } from '@vercel/functions';

export function runAfterResponse(promise: Promise<unknown>): void {
  // Attach the log-on-failure handler to the SAME promise `waitUntil` tracks,
  // so a rejection is always logged whether or not we're inside a request
  // context — never left as an unhandled rejection either way.
  const tracked = promise.catch((err) => {
    console.error('runAfterResponse: background task failed', err);
  });
  try {
    waitUntil(tracked);
  } catch (err) {
    // Defensive only — the current waitUntil() no-ops rather than throwing
    // when there's no request context, but this keeps a future stricter
    // implementation from ever turning a best-effort send into a 500.
    console.error('runAfterResponse: waitUntil unavailable', err);
  }
}
