// The one way the marketing dashboard talks to /api/owner/marketing/**.
//
// Every call resolves to {ok:true,data} | {ok:false,error} and NEVER throws, so a
// component can't forget a try/catch and leave a spinner up forever. The error is
// already classified into what the owner has to DO about it (spec §6/§7):
//   migration_missing  409 {error:'migration_missing'} → apply the SQL, reload
//   signed_out         401/403                          → sign in again
//   network            fetch itself failed              → check the connection
//   invalid            400/422 with a message           → the message is for the owner (a bound, a typo)
//   server             anything else
// The classification is pure (classifyFailure) so it is unit-tested without a browser.

export type FailureKind = 'migration_missing' | 'signed_out' | 'network' | 'invalid' | 'server';

export interface ApiFailure {
  kind: FailureKind;
  status: number;
  /** A sentence the owner can read. Never a stack trace or a bare status code. */
  message: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

export const MIGRATION_MISSING_MESSAGE =
  'Apply supabase/2026-10-marketing-agent.sql in Supabase → SQL editor, then reload.';

const FALLBACKS: Record<FailureKind, string> = {
  migration_missing: MIGRATION_MISSING_MESSAGE,
  signed_out: 'You have been signed out. Reload the page to sign in again.',
  network: 'Could not reach the server. Check your internet connection and try again.',
  invalid: 'That was not accepted. Check the values and try again.',
  server: 'Something went wrong on our side. Please try again in a moment.',
};

/** Pulls the `error` string out of a JSON error body, whatever shape it arrived in. */
export function errorTextFrom(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    const e = (body as { error?: unknown }).error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
      return (e as { message: string }).message;
    }
    const m = (body as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/** Turns an HTTP status + parsed body into the failure the UI shows. */
export function classifyFailure(status: number, body: unknown): ApiFailure {
  const text = errorTextFrom(body).trim();
  if (status === 409 && (text === 'migration_missing' || text === '' || /migration/i.test(text))) {
    return { kind: 'migration_missing', status, message: FALLBACKS.migration_missing };
  }
  if (status === 401 || status === 403) return { kind: 'signed_out', status, message: FALLBACKS.signed_out };
  if (status === 400 || status === 409 || status === 422 || status === 429) {
    // The server's own sentence is written for the owner ("Monthly budget must be a whole number between 0 and 1000000.").
    return { kind: 'invalid', status, message: text || FALLBACKS.invalid };
  }
  return { kind: 'server', status, message: text && text.length < 200 ? text : FALLBACKS.server };
}

export function networkFailure(): ApiFailure {
  return { kind: 'network', status: 0, message: FALLBACKS.network };
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  /** Serialised as JSON. */
  body?: unknown;
  signal?: AbortSignal;
}

/** fetch → ApiResult. Owner data is per-request, so it is never cached. */
export async function requestJson<T>(path: string, opts: RequestOptions = {}): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? 'GET',
      cache: 'no-store',
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    // An aborted request is the caller moving on (a newer preview started), not a failure to report.
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, error: { kind: 'network', status: 0, message: 'aborted' } };
    }
    return { ok: false, error: networkFailure() };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) return { ok: false, error: classifyFailure(res.status, body) };
  if (body === null || body === undefined) {
    return { ok: false, error: { kind: 'server', status: res.status, message: FALLBACKS.server } };
  }
  return { ok: true, data: body as T };
}

/** True for the "caller cancelled" result requestJson returns for an aborted fetch. */
export function isAborted(failure: ApiFailure): boolean {
  return failure.kind === 'network' && failure.message === 'aborted';
}

// ---------------------------------------------------------------------------
// The endpoints (spec §6) — one place, so a path typo can't hide in a component
// ---------------------------------------------------------------------------

export const API = {
  overview: '/api/owner/marketing/overview',
  audience: '/api/owner/marketing/audience',
  settings: '/api/owner/marketing/settings',
  playbooks: '/api/owner/marketing/playbooks',
  playbook: (key: string) => `/api/owner/marketing/playbooks/${encodeURIComponent(key)}`,
  campaigns: (status?: string) => `/api/owner/marketing/campaigns${status ? `?status=${encodeURIComponent(status)}` : ''}`,
  campaignPreview: '/api/owner/marketing/campaigns/preview',
  campaign: (id: string, page = 1) => `/api/owner/marketing/campaigns/${encodeURIComponent(id)}?page=${page}`,
  approve: (id: string) => `/api/owner/marketing/campaigns/${encodeURIComponent(id)}/approve`,
  cancel: (id: string) => `/api/owner/marketing/campaigns/${encodeURIComponent(id)}/cancel`,
  testSend: '/api/owner/marketing/test-send',
  costs: '/api/owner/marketing/costs',
  optOut: '/api/owner/marketing/consent/opt-out',
} as const;
