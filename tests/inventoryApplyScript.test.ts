import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// `npm run inventory:apply` (scripts/inventory/apply.mjs) run for real, as a
// child process, against a local mock of PostgREST. The child's environment
// points NEXT_PUBLIC_SUPABASE_URL at the mock and SUPABASE_SERVICE_ROLE_KEY at
// a made-up key, and the script lets the real environment win over .env.local,
// so nothing here can reach a real Supabase project. The book is a synthetic
// one written to a temp folder (the menu ids come from the public, committed
// snapshot; every quantity and stock name is invented).

vi.setConfig({ testTimeout: 60_000 });

const ROOT = process.cwd();
const SCRIPT = path.join(ROOT, 'scripts/inventory/apply.mjs');
const KEY = 'test-service-role-key-not-real';

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Reply {
  status: number;
  body: unknown;
}

// ── The mock server ─────────────────────────────────────────────────────────
let server: http.Server;
let base: string;
let received: Received[];
let reply: (req: Received) => Reply;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const seen: Received = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      received.push(seen);
      const { status, body } = reply(seen);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const APPLIED = { saved: true, stock_items: 2, recipes: 1, addon_recipes: 1, save_only: false };
beforeEach(() => {
  received = [];
  reply = () => ({ status: 200, body: APPLIED });
});

// ── A synthetic book ────────────────────────────────────────────────────────
interface SnapshotItem {
  id: string;
  name: string;
  category: string;
}
interface Snapshot {
  items: SnapshotItem[];
  addon_options: { id: string; group: string; option: string }[];
}
const snapshot: Snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/inventory/menu-snapshot.json'), 'utf8'));

let tmp: string;
let goodBook: string;
let badBook: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Two menu items (the first confirmed, the second a draft) and one add-on
 * option, over two invented stock items. `wrongIngredient` makes the book
 * invalid: a recipe line names a stock item that does not exist. */
function writeBook(dir: string, { wrongIngredient = false } = {}): void {
  const [a, b] = snapshot.items;
  const option = snapshot.addon_options[0];
  writeJson(path.join(dir, 'stock-items.json'), {
    items: [
      { name: 'Test beans', unit: 'g', category: 'Coffee', tracks_expiry: false, par_level: 0, reorder_qty: 0 },
      { name: 'Test milk', unit: 'ml', category: 'Dairy & Alternatives', tracks_expiry: true, par_level: 0, reorder_qty: 0 },
    ],
  });
  const entry = (item: SnapshotItem, status: string, ingredient: string) => ({
    menu_item_id: item.id,
    menu_item: item.name,
    status,
    source: 'owner',
    notes: `a note about ${item.name}`,
    base: [{ ingredient, qty: 7 }],
    sizes: {},
  });
  const categories = [...new Set([a.category, b.category])];
  writeJson(path.join(dir, 'recipes/test.json'), {
    categories,
    items: [entry(a, 'confirmed', wrongIngredient ? 'Nothing at all' : 'Test beans'), entry(b, 'draft', 'Test milk')],
  });
  writeJson(path.join(dir, 'addon-recipes.json'), {
    options: [{ addon_option_id: option.id, group: option.group, option: option.option, status: 'confirmed', source: 'owner', notes: '', lines: [{ ingredient: 'Test milk', qty: 11 }] }],
  });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-apply-'));
  goodBook = path.join(tmp, 'good');
  badBook = path.join(tmp, 'bad');
  writeBook(goodBook);
  writeBook(badBook, { wrongIngredient: true });
});
afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Running the script ──────────────────────────────────────────────────────
interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Async on purpose: the mock server lives in this process, so a synchronous
 * spawn would freeze it and the child would never get an answer. */
function apply(args: string[], env: Record<string, string> = {}): Promise<Run> {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    NEXT_PUBLIC_SUPABASE_URL: base,
    SUPABASE_SERVICE_ROLE_KEY: KEY,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ...env,
  };
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'NODE_USE_ENV_PROXY', 'INVENTORY_BOOK_DIR']) delete childEnv[name];
  // Whatever the environment says, the call may only go to this machine (the mock),
  // or nowhere (a value that is not a URL at all).
  let host: string | null = null;
  try {
    host = new URL(childEnv.NEXT_PUBLIC_SUPABASE_URL as string).hostname;
  } catch {
    // not a URL: the script refuses it
  }
  expect(host === null || host === '127.0.0.1').toBe(true);

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: childEnv as NodeJS.ProcessEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const sent = () => JSON.parse(received[0].body) as { p_payload: null | { stock_items: { name: string }[]; recipes: { id: string }[]; addon_recipes: { id: string }[] }; p_doc: Record<string, unknown>; p_dry_run: boolean };

describe('inventory:apply — a real apply (--yes)', () => {
  it('sends ONE request to the function, with the key, and prints the result and "Applied."', async () => {
    const run = await apply(['--book', goodBook, '--yes']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);

    expect(received).toHaveLength(1);
    const [req] = received;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/rest/v1/rpc/inventory_apply_book');
    expect(req.headers.apikey).toBe(KEY);
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.prefer).toBe('return=representation');

    const body = sent();
    expect(Object.keys(body).sort()).toEqual(['p_doc', 'p_dry_run', 'p_payload']);
    expect(body.p_dry_run).toBe(false);
    // Confirmed recipes only: the draft item is not in the payload, but it is in the saved book.
    expect(body.p_payload!.recipes.map((r) => r.id)).toEqual([snapshot.items[0].id]);
    expect(body.p_payload!.addon_recipes.map((r) => r.id)).toEqual([snapshot.addon_options[0].id]);
    expect(body.p_payload!.stock_items.map((s) => s.name)).toEqual(['Test beans', 'Test milk']);
    expect(body.p_doc.version).toBe(1);
    expect(JSON.stringify(body.p_doc)).toContain(`a note about ${snapshot.items[1].name}`);

    expect(JSON.parse(run.stdout.slice(run.stdout.indexOf('{'), run.stdout.lastIndexOf('}') + 1))).toEqual(APPLIED);
    expect(run.stdout.trimEnd().endsWith('Applied.')).toBe(true);
  });

  it('prints the target host, the counts and the payload size before sending, and never the key', async () => {
    const run = await apply(['--book', goodBook, '--yes']);
    expect(run.stdout).toContain(`Target:   ${new URL(base).host}`);
    expect(run.stdout).toContain('confirmed recipes only');
    expect(run.stdout).toContain('Applies:  2 stock items · 1 menu-item recipes (1 lines) · 1 add-on recipes (1 lines, 0 scoped)');
    expect(run.stdout).toMatch(/Payload:  \d+(\.\d)? (B|KB)/);
    expect(run.stdout).toContain('Saves the book: 2 stock items · 1 recipe files (2 items) · 1 add-on options');
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });

  it('with --include-drafts also sends the draft recipe', async () => {
    const run = await apply(['--book', goodBook, '--yes', '--include-drafts']);
    expect(run.code).toBe(0);
    expect(sent().p_payload!.recipes.map((r) => r.id)).toEqual([snapshot.items[0].id, snapshot.items[1].id]);
    expect(run.stdout).toContain('confirmed + DRAFT recipes');
  });

  it('with --save-only sends a null payload, and applies while the book has errors (as warnings)', async () => {
    const run = await apply(['--book', badBook, '--save-only', '--yes']);
    expect(run.code).toBe(0);
    const body = sent();
    expect(body.p_payload).toBeNull();
    expect(body.p_dry_run).toBe(false);
    expect(JSON.stringify(body.p_doc)).toContain('Nothing at all');
    expect(run.stdout).toContain('SAVE ONLY');
    expect(run.stdout).toMatch(/warn .*Nothing at all/);
    expect(run.stdout).toContain('Applied.');
  });

  it('refuses a project URL that is not a URL, before any request', async () => {
    const run = await apply(['--book', goodBook, '--yes'], { NEXT_PUBLIC_SUPABASE_URL: 'not a url' });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not a URL');
    expect(received).toHaveLength(0);
  });
});

describe('inventory:apply — without --yes', () => {
  it('prints what WOULD be applied and where, sends nothing and exits 2', async () => {
    const run = await apply(['--book', goodBook]);
    expect(run.code).toBe(2);
    expect(received).toHaveLength(0);
    expect(run.stdout).toContain(`Target:   ${new URL(base).host}`);
    expect(run.stdout).toContain('Applies:  2 stock items');
    expect(run.stdout).toContain('Nothing was sent.');
    expect(run.stdout).toContain('--yes');
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });
});

describe('inventory:apply — --dry-run', () => {
  it('sends p_dry_run = true; the server’s "DRY RUN OK" error is a pass: printed, exit 0, nothing saved', async () => {
    const message = 'DRY RUN OK (nothing was saved): {"saved": true, "recipes": 1, "save_only": false, "stock_items": 2, "addon_recipes": 1}';
    reply = () => ({ status: 400, body: { code: 'P0001', details: null, hint: null, message } });
    const run = await apply(['--book', goodBook, '--dry-run']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(received).toHaveLength(1);
    expect(sent().p_dry_run).toBe(true);
    expect(sent().p_payload!.recipes).toHaveLength(1);
    expect(run.stdout).toContain(message);
    expect(run.stdout.trimEnd().endsWith('Dry run passed; nothing was saved.')).toBe(true);
    expect(run.stdout).not.toContain('Applied.');
  });

  it('needs no --yes, and --yes does not turn it into a real apply', async () => {
    reply = () => ({ status: 400, body: { code: 'P0001', message: 'DRY RUN OK (nothing was saved): {}' } });
    const run = await apply(['--book', goodBook, '--dry-run', '--yes']);
    expect(run.code).toBe(0);
    expect(sent().p_dry_run).toBe(true);
  });

  it('works with --save-only too', async () => {
    reply = () => ({ status: 400, body: { code: 'P0001', message: 'DRY RUN OK (nothing was saved): {"save_only": true}' } });
    const run = await apply(['--book', badBook, '--save-only', '--dry-run']);
    expect(run.code).toBe(0);
    expect(sent().p_payload).toBeNull();
    expect(sent().p_dry_run).toBe(true);
  });

  it('fails, loudly, if the server answers a dry run with success (an older function would have saved)', async () => {
    const run = await apply(['--book', goodBook, '--dry-run']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('answered success');
    expect(run.stdout).not.toContain('Dry run passed');
  });

  it('reports a guard of the function found by the dry run as a failure', async () => {
    reply = () => ({ status: 400, body: { code: 'P0001', message: 'inventory seed: menu items not found live — refresh data/inventory/menu-snapshot.json: Latte (abc)', details: null, hint: null } });
    const run = await apply(['--book', goodBook, '--dry-run']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('inventory seed: menu items not found live');
    expect(run.stdout).not.toContain('Dry run passed');
  });
});

describe('inventory:apply — the database says no', () => {
  it('prints PostgREST’s message, details and hint and exits 1', async () => {
    reply = () => ({
      status: 400,
      body: { code: 'P0001', message: 'inventory seed: unit differs from the live stock item: Test milk (live g, book ml)', details: 'the details', hint: 'the hint' },
    });
    const run = await apply(['--book', goodBook, '--yes']);
    expect(run.code).toBe(1);
    expect(received).toHaveLength(1);
    expect(run.stderr).toContain('the database refused it (HTTP 400, P0001): inventory seed: unit differs from the live stock item: Test milk (live g, book ml)');
    expect(run.stderr).toContain('details: the details');
    expect(run.stderr).toContain('hint: the hint');
    expect(run.stderr).toContain('Nothing was saved');
    expect(run.stdout).not.toContain('Applied.');
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });

  it('says to apply the migration first when the function is not there', async () => {
    reply = () => ({
      status: 404,
      body: {
        code: 'PGRST202',
        details: 'Searched for the function public.inventory_apply_book …',
        hint: null,
        message: 'Could not find the function public.inventory_apply_book(p_doc, p_dry_run, p_payload) in the schema cache',
      },
    });
    const run = await apply(['--book', goodBook, '--yes']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('Could not find the function public.inventory_apply_book');
    expect(run.stderr).toContain('apply supabase/2026-10-inventory-apply-book.sql first');
    expect(run.stdout).not.toContain('Applied.');
  });

  it('exits 1 with the start of the body when the answer is not PostgREST’s', async () => {
    reply = () => ({ status: 502, body: '<html>Bad gateway</html>' });
    const run = await apply(['--book', goodBook, '--yes']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('HTTP 502');
    expect(run.stderr).toContain('<html>Bad gateway</html>');
  });

  it('exits 1 when nothing answers at all', async () => {
    const run = await apply(['--book', goodBook, '--yes'], { NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1' });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('no answer from 127.0.0.1:1');
    expect(run.stderr).toContain('safe to run it again');
  });
});

describe('inventory:apply — refuses before sending anything', () => {
  it('a book with validation errors is refused (exit 1) and the errors are listed', async () => {
    const run = await apply(['--book', badBook, '--yes']);
    expect(run.code).toBe(1);
    expect(received).toHaveLength(0);
    expect(run.stderr).toContain('not applying anything');
    expect(run.stderr).toMatch(/ERROR .*Nothing at all/);
  });

  it('bad arguments: exit 2 and the usage', async () => {
    const unknown = await apply(['--bogus']);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('unknown argument --bogus');
    expect(unknown.stderr).toContain('usage: npm run inventory:apply');

    const both = await apply(['--book', goodBook, '--save-only', '--include-drafts', '--yes']);
    expect(both.code).toBe(2);
    expect(both.stderr).toContain('--include-drafts has no effect with --save-only');

    const noValue = await apply(['--book']);
    expect(noValue.code).toBe(2);
    expect(received).toHaveLength(0);
  });

  it('--help prints the usage and exits 0', async () => {
    const run = await apply(['--help']);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('usage: npm run inventory:apply');
    expect(run.stdout).toContain('--yes');
    expect(received).toHaveLength(0);
  });
});

afterEach(() => {
  // No test may have reached anything but the mock: it is the only server it knows about.
  for (const req of received) expect(req.url).toBe('/rest/v1/rpc/inventory_apply_book');
});
