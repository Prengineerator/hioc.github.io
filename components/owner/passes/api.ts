// The one way the HIOC Ritual owner screens talk to /api/owner/passes/**.
// Every route answers { error: string } on failure, so the screens can show the
// server's own wording ("A plan with that name already exists.") instead of a
// raw status code. A dropped connection or a non-JSON answer gets a plain
// sentence too, never an exception in the render.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

const OFFLINE = 'Could not reach the server. Check your connection and try again.';

export async function callOwnerApi<T>(
  url: string,
  init: { method?: 'GET' | 'POST' | 'PATCH' | 'PUT'; json?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.json === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
      signal: init.signal,
      cache: 'no-store',
    });
  } catch (err) {
    // An aborted request is the screen moving on (a new date range, a closed page): not an error to show.
    if (err instanceof DOMException && err.name === 'AbortError') return { ok: false, error: '', status: 0 };
    return { ok: false, error: OFFLINE, status: 0 };
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : `Something went wrong (${res.status}). Please try again.`;
    return { ok: false, error: message, status: res.status };
  }
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'The server sent an answer this page could not read. Please try again.', status: res.status };
  }
  return { ok: true, data: body as T };
}
