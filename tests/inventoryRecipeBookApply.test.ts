import { describe, expect, it } from 'vitest';
import {
  APPLY_MIGRATION,
  applyEndpoint,
  formatApplyFailure,
  formatBytes,
  interpretApplyResponse,
  parseEnvText,
  pickEnv,
  targetHost,
} from '@/lib/inventory/recipeBookApply';

// The pure half of `npm run inventory:apply` (lib/inventory/recipeBookApply.ts):
// the URL, the settings, and what the database's answer means. The script
// itself is run end to end, against a local mock server, by
// inventoryApplyScript.test.ts.

const json = (value: unknown) => JSON.stringify(value);

describe('parseEnvText', () => {
  it('reads KEY=value lines, strips one matched pair of quotes, skips comments and junk', () => {
    const env = parseEnvText(
      [
        '# a comment',
        'NEXT_PUBLIC_SUPABASE_URL="https://abc.supabase.co"',
        "SUPABASE_SERVICE_ROLE_KEY='secret-key'",
        '  PLAIN = plain value  ',
        'lower_case=ignored',
        'not an assignment',
        'EMPTY=',
        'MISMATCHED="oops',
        '',
      ].join('\r\n'),
    );
    expect(env).toEqual({
      NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'secret-key',
      PLAIN: 'plain value',
      EMPTY: '',
      MISMATCHED: '"oops',
    });
  });
});

describe('pickEnv', () => {
  it('takes the real environment first, then .env.local, else an empty string', () => {
    expect(pickEnv('A', { A: 'from-env' }, { A: 'from-file' })).toBe('from-env');
    expect(pickEnv('A', {}, { A: 'from-file' })).toBe('from-file');
    expect(pickEnv('A', { A: '' }, { A: 'from-file' })).toBe('from-file');
    expect(pickEnv('A', { A: undefined }, {})).toBe('');
  });
});

describe('applyEndpoint / targetHost', () => {
  it('is <project url>/rest/v1/rpc/inventory_apply_book, whatever trails the base', () => {
    expect(applyEndpoint('https://abc.supabase.co')).toBe('https://abc.supabase.co/rest/v1/rpc/inventory_apply_book');
    expect(applyEndpoint('https://abc.supabase.co/')).toBe('https://abc.supabase.co/rest/v1/rpc/inventory_apply_book');
    expect(applyEndpoint('  https://abc.supabase.co///  ')).toBe('https://abc.supabase.co/rest/v1/rpc/inventory_apply_book');
    expect(applyEndpoint('http://127.0.0.1:54321')).toBe('http://127.0.0.1:54321/rest/v1/rpc/inventory_apply_book');
  });

  it('names the host, with a port when there is one, and never anything after it', () => {
    expect(targetHost('https://abc.supabase.co/')).toBe('abc.supabase.co');
    expect(targetHost('http://127.0.0.1:54321')).toBe('127.0.0.1:54321');
    expect(targetHost('https://user:pass@abc.supabase.co/path?x=1')).toBe('abc.supabase.co');
  });

  it('refuses a base that is not an http(s) URL', () => {
    expect(() => applyEndpoint('abc.supabase.co')).toThrow(/not a URL/);
    expect(() => targetHost('')).toThrow(/not a URL/);
    expect(() => applyEndpoint('ftp://abc.supabase.co')).toThrow(/http\(s\) URL/);
  });

  it('does not put credentials from the base into the endpoint', () => {
    expect(applyEndpoint('https://user:pass@abc.supabase.co')).toBe('https://abc.supabase.co/rest/v1/rpc/inventory_apply_book');
  });
});

describe('formatBytes', () => {
  it('says bytes, KB or MB', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(422_400)).toBe('412.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('interpretApplyResponse', () => {
  const result = { saved: true, stock_items: 3, recipes: 2, addon_recipes: 1, save_only: false };

  describe('success', () => {
    it('is applied, with the function’s result as it came', () => {
      expect(interpretApplyResponse({ status: 200, text: json(result) }, { dryRun: false })).toEqual({ kind: 'applied', result });
      expect(interpretApplyResponse({ status: 201, text: json(result) }, { dryRun: false })).toEqual({ kind: 'applied', result });
    });

    it('is an error when the answer to a success is not JSON', () => {
      const outcome = interpretApplyResponse({ status: 200, text: '<html>hello</html>' }, { dryRun: false });
      expect(outcome).toMatchObject({ kind: 'error', status: 200 });
      expect((outcome as { message: string }).message).toMatch(/not JSON.*<html>/);
    });

    it('is an ERROR after a dry run: a dry run always ends in an error, so this function may have saved', () => {
      const outcome = interpretApplyResponse({ status: 200, text: json(result) }, { dryRun: true });
      expect(outcome).toMatchObject({ kind: 'error', status: 200 });
      expect((outcome as { message: string }).message).toContain('DRY RUN OK');
      expect((outcome as { message: string }).message).toContain(APPLY_MIGRATION);
    });
  });

  describe('a dry run', () => {
    const message = 'DRY RUN OK (nothing was saved): {"saved": true, "recipes": 2, "save_only": false, "stock_items": 3, "addon_recipes": 1}';

    it('passes when the server answers with the DRY RUN OK error', () => {
      const body = { code: 'P0001', details: null, hint: null, message };
      expect(interpretApplyResponse({ status: 400, text: json(body) }, { dryRun: true })).toEqual({ kind: 'dry-run-ok', message });
    });

    it('is only recognised when a dry run was asked for', () => {
      const outcome = interpretApplyResponse({ status: 400, text: json({ code: 'P0001', message }) }, { dryRun: false });
      expect(outcome.kind).toBe('error');
    });

    it('is not fooled by another error that mentions a dry run later on', () => {
      const outcome = interpretApplyResponse({ status: 400, text: json({ code: 'P0001', message: 'inventory seed: not a DRY RUN OK' }) }, { dryRun: true });
      expect(outcome.kind).toBe('error');
    });

    it('still reports a guard of the function as an error (the dry run found a real problem)', () => {
      const body = { code: 'P0001', message: 'inventory seed: menu items not found live — refresh data/inventory/menu-snapshot.json: Latte (abc)', details: null, hint: null };
      expect(interpretApplyResponse({ status: 400, text: json(body) }, { dryRun: true })).toMatchObject({
        kind: 'error',
        status: 400,
        code: 'P0001',
        message: body.message,
      });
    });
  });

  describe('the function is missing', () => {
    it('is recognised from PostgREST’s PGRST202 (404)', () => {
      const body = {
        code: 'PGRST202',
        details: 'Searched for the function public.inventory_apply_book with parameters p_doc, p_dry_run, p_payload in the schema cache',
        hint: null,
        message: 'Could not find the function public.inventory_apply_book(p_doc, p_dry_run, p_payload) in the schema cache',
      };
      const outcome = interpretApplyResponse({ status: 404, text: json(body) }, { dryRun: false });
      expect(outcome).toMatchObject({ kind: 'missing-function', status: 404, code: 'PGRST202', message: body.message, details: body.details });
      expect(interpretApplyResponse({ status: 404, text: json(body) }, { dryRun: true }).kind).toBe('missing-function');
    });

    it('is recognised from the code alone, from undefined_function (42883), and from a bare 404', () => {
      expect(interpretApplyResponse({ status: 400, text: json({ code: 'PGRST202', message: 'x' }) }, { dryRun: false }).kind).toBe('missing-function');
      expect(interpretApplyResponse({ status: 400, text: json({ code: '42883', message: 'function inventory_apply_book(jsonb, jsonb, boolean) does not exist' }) }, { dryRun: false }).kind).toBe('missing-function');
      expect(interpretApplyResponse({ status: 404, text: 'Not Found' }, { dryRun: false })).toMatchObject({ kind: 'missing-function', message: 'Not Found' });
    });

    it('tells the person to apply the migration first', () => {
      const outcome = interpretApplyResponse({ status: 404, text: json({ code: 'PGRST202', message: 'Could not find the function' }) }, { dryRun: false });
      if (outcome.kind !== 'missing-function') throw new Error('expected missing-function');
      const text = formatApplyFailure(outcome).join('\n');
      expect(text).toContain('apply supabase/2026-10-inventory-apply-book.sql first');
      expect(text).toContain("notify pgrst, 'reload schema'");
      expect(text).toContain('HTTP 404, PGRST202');
    });
  });

  describe('any other error', () => {
    it('passes PostgREST’s code, message, details and hint on as they are', () => {
      const body = {
        code: 'P0001',
        message: 'inventory seed: unit differs from the live stock item: Milk (live g, book ml)',
        details: 'some details',
        hint: 'some hint',
      };
      const outcome = interpretApplyResponse({ status: 400, text: json(body) }, { dryRun: false });
      expect(outcome).toEqual({ kind: 'error', status: 400, ...body });
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(formatApplyFailure(outcome)).toEqual([
        'the database refused it (HTTP 400, P0001): inventory seed: unit differs from the live stock item: Milk (live g, book ml)',
        '  details: some details',
        '  hint: some hint',
      ]);
    });

    it('leaves out the details and hint that are null or absent', () => {
      const outcome = interpretApplyResponse({ status: 400, text: json({ code: '23503', message: 'insert or update violates foreign key', details: null, hint: null }) }, { dryRun: false });
      expect(outcome).toEqual({ kind: 'error', status: 400, code: '23503', message: 'insert or update violates foreign key', details: undefined, hint: undefined });
      if (outcome.kind !== 'error') throw new Error('expected error');
      expect(formatApplyFailure(outcome)).toEqual(['the database refused it (HTTP 400, 23503): insert or update violates foreign key']);
    });

    it('shows the start of a body that is not JSON, and a bare status when there is no body', () => {
      const html = `<html>${'x'.repeat(1000)}</html>`;
      const bad = interpretApplyResponse({ status: 502, text: html }, { dryRun: false });
      expect(bad).toMatchObject({ kind: 'error', status: 502 });
      expect((bad as { message: string }).message).toHaveLength(300);
      expect((bad as { message: string }).message.startsWith('<html>')).toBe(true);
      expect(interpretApplyResponse({ status: 503, text: '' }, { dryRun: false })).toMatchObject({ kind: 'error', status: 503, message: 'HTTP 503' });
      expect(interpretApplyResponse({ status: 500, text: '[]' }, { dryRun: false })).toMatchObject({ kind: 'error', status: 500, message: '[]' });
    });

    it('suggests the key on 401 / 403 and says a timeout is safe to run again, without hiding PostgREST’s own hint', () => {
      const unauthorized = interpretApplyResponse({ status: 401, text: json({ message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }) }, { dryRun: false });
      expect(unauthorized).toMatchObject({ kind: 'error', status: 401, hint: 'Double check your Supabase `anon` or `service_role` API key.' });
      const forbidden = interpretApplyResponse({ status: 403, text: json({ code: '42501', message: 'permission denied for function inventory_apply_book' }) }, { dryRun: false });
      expect((forbidden as { hint: string }).hint).toContain('SUPABASE_SERVICE_ROLE_KEY');
      const timeout = interpretApplyResponse({ status: 500, text: json({ code: '57014', message: 'canceling statement due to statement timeout' }) }, { dryRun: false });
      expect((timeout as { hint: string }).hint).toContain('safe to run again');
    });
  });
});
