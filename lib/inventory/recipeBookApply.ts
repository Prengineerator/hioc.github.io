// The pure half of `npm run inventory:apply` (scripts/inventory/apply.mjs,
// docs/INVENTORY-RECIPE-BOOK.md): where the call goes, what the answer means,
// how it is worded. No I/O, no clock, no network: the script does the reading,
// the fetch and the printing, and every decision is made here so that it is
// unit-tested (tests/inventoryRecipeBookApply.test.ts).

export const APPLY_FUNCTION = 'inventory_apply_book';
export const APPLY_MIGRATION = 'supabase/2026-10-inventory-apply-book.sql';

/**
 * KEY=value lines of an .env file. Same parsing as scripts/inventory/pull.mjs:
 * comments and lines that are not an assignment are skipped, and one matched
 * pair of quotes is stripped (the Supabase values in this repo are quoted).
 */
export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/** A setting: the real environment first, then .env.local, else ''. The real
 * environment wins, so `NEXT_PUBLIC_SUPABASE_URL=… npm run inventory:apply`
 * (and the script's own end-to-end test) can point the call somewhere else
 * whatever .env.local holds. */
export function pickEnv(name: string, processEnv: Record<string, string | undefined>, fileEnv: Record<string, string>): string {
  return processEnv[name] || fileEnv[name] || '';
}

function baseOf(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL is not a URL: ${JSON.stringify(baseUrl.slice(0, 80))}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL, not ${url.protocol}`);
  }
  return url;
}

/** The PostgREST URL of the function: `<project url>/rest/v1/rpc/inventory_apply_book`. */
export function applyEndpoint(baseUrl: string): string {
  const url = baseOf(baseUrl);
  return `${url.origin}/rest/v1/rpc/${APPLY_FUNCTION}`;
}

/** The host (and port) the call goes to, for the person to check before it is sent. */
export function targetHost(baseUrl: string): string {
  return baseOf(baseUrl).host;
}

/** "412.3 KB" — for the size of what is about to be sent. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── The answer ──────────────────────────────────────────────────────────────

/** What the database function answered, in the terms the script acts on. */
export type ApplyOutcome =
  /** 2xx: applied. `result` is the function's JSON ({ saved, stock_items, … }). */
  | { kind: 'applied'; result: unknown }
  /** A dry run: the function did every step and then raised 'DRY RUN OK …' on purpose. */
  | { kind: 'dry-run-ok'; message: string }
  /** The function is not there (migration not applied, or PostgREST's schema cache is stale). */
  | { kind: 'missing-function'; status: number; code?: string; message: string; details?: string; hint?: string }
  /** Anything else: a guard of the function, PostgREST, the gateway, a bad key. */
  | { kind: 'error'; status: number; code?: string; message: string; details?: string; hint?: string };

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the HTTP answer of `POST /rest/v1/rpc/inventory_apply_book`.
 *
 *  - 2xx → `applied`, with the function's result. (After a DRY RUN that would be
 *    wrong — a dry run always ends in an error — so it is an `error` that says
 *    the database function may not be the current version.)
 *  - an error whose message starts "DRY RUN OK" → `dry-run-ok`, when a dry run
 *    was asked for.
 *  - PGRST202 / 42883 / 404 → `missing-function`.
 *  - anything else → `error`, with PostgREST's message, details and hint as they
 *    came ({ code, message, details, hint }), or the start of the body when it
 *    is not JSON.
 */
export function interpretApplyResponse(res: { status: number; text: string }, { dryRun }: { dryRun: boolean }): ApplyOutcome {
  const { status, text } = res;
  const body = parseJson(text);

  if (status >= 200 && status < 300) {
    if (dryRun) {
      return {
        kind: 'error',
        status,
        message:
          'a dry run must end with an error from the database (DRY RUN OK), but it answered success — the function may be an older version that SAVED. ' +
          `Re-apply ${APPLY_MIGRATION} and check what was saved`,
      };
    }
    if (body === undefined) return { kind: 'error', status, message: `the answer was not JSON: ${JSON.stringify(text.slice(0, 200))}` };
    return { kind: 'applied', result: body };
  }

  const fields = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const code = asString(fields.code);
  const details = asString(fields.details);
  let hint = asString(fields.hint);
  const message = asString(fields.message) ?? (text.trim().slice(0, 300) || `HTTP ${status}`);

  if (dryRun && message.startsWith('DRY RUN OK')) return { kind: 'dry-run-ok', message };

  if (code === 'PGRST202' || code === '42883' || status === 404) {
    return { kind: 'missing-function', status, code, message, details, hint };
  }
  if (!hint) {
    if (status === 401 || status === 403) hint = 'check SUPABASE_SERVICE_ROLE_KEY: it must be this project\'s service-role key';
    else if (code === '57014') hint = 'the database cancelled it (statement timeout). Nothing was saved; it is safe to run again';
  }
  return { kind: 'error', status, code, message, details, hint };
}

/** The lines the script prints for a refusal (`error` or `missing-function`). */
export function formatApplyFailure(outcome: Extract<ApplyOutcome, { kind: 'error' | 'missing-function' }>): string[] {
  const lines = [`the database refused it (HTTP ${outcome.status}${outcome.code ? `, ${outcome.code}` : ''}): ${outcome.message}`];
  if (outcome.details) lines.push(`  details: ${outcome.details}`);
  if (outcome.hint) lines.push(`  hint: ${outcome.hint}`);
  if (outcome.kind === 'missing-function') {
    lines.push(
      `  apply ${APPLY_MIGRATION} first (Supabase SQL editor).`,
      "  If it is already applied, PostgREST has not reloaded its schema yet: run  notify pgrst, 'reload schema';  and try again.",
    );
  }
  return lines;
}
