// Lightweight error monitoring (F5t / NFR-010). Dependency-free: always logs to
// the console, and — when MONITORING_WEBHOOK_URL is set — forwards the error to
// an HTTP collector (Sentry tunnel, Slack webhook, Logtail, etc.). Swapping in a
// full SDK later means changing only this file. Never throws.
//
// Works on both server and client: NEXT_PUBLIC_MONITORING_WEBHOOK_URL is used in
// the browser, MONITORING_WEBHOOK_URL on the server.

export interface ErrorContext {
  where?: string; // e.g. 'order-status-route', 'client-error-boundary'
  [key: string]: unknown;
}

function webhookUrl(): string | undefined {
  return process.env.MONITORING_WEBHOOK_URL ?? process.env.NEXT_PUBLIC_MONITORING_WEBHOOK_URL;
}

export function captureError(error: unknown, context: ErrorContext = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));
  // Always record locally so it shows in server logs / the browser console.
  console.error(`[monitor]${context.where ? ` ${context.where}` : ''}`, err, context);

  const url = webhookUrl();
  if (!url) return;

  const payload = {
    message: err.message,
    stack: err.stack,
    context,
    at: new Date().toISOString(),
    env: process.env.NODE_ENV,
  };

  // Fire-and-forget; a monitoring failure must never affect the request.
  try {
    void fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}
