// PRN-1/D7-6 — printer configuration is a physical fact of THIS machine (a USB
// path or an IP address), so it lives in a plain JSON file under this
// machine's userData directory, never on the server. `save()` replaces the
// whole list and validates every entry strictly: a bad write here would
// silently stop routing tickets to the kitchen, which is the one failure this
// module exists to prevent.
//
// The actual validation/normalization logic lives in ./validate — a module
// that imports nothing from `electron` (or any Node-only API), so it can be
// followed by the web app's TypeScript project (which has no `electron`
// package installed) when tests import it. This file re-exports it so
// existing callers are unaffected; see tests/desktop/validate.test.ts.

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PrinterConfig } from '@/lib/desktop/bridge';
import { validatePrinterConfigs } from './validate';

export { PrinterConfigError, validatePrinterConfig, validatePrinterConfigs } from './validate';

const FILE_NAME = 'printers.json';

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

/** Never throws: a missing file means no printers configured yet, and a
 * corrupt file must not crash the till — it starts empty and logs, so the
 * owner can reconfigure from the settings screen. */
export async function loadPrinters(): Promise<PrinterConfig[]> {
  try {
    const raw = await fs.readFile(filePath(), 'utf8');
    return validatePrinterConfigs(JSON.parse(raw));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return [];
    console.error('[hioc-pos] printers.json is invalid, starting with no printers configured:', err);
    return [];
  }
}

/** Validates strictly, then writes atomically (temp file + rename) so a crash
 * mid-write can never leave a half-written config that offline order-taking
 * depends on to reach the kitchen printer. */
export async function savePrinters(printers: PrinterConfig[]): Promise<void> {
  const validated = validatePrinterConfigs(printers);
  const target = filePath();
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(tmp, JSON.stringify(validated, null, 2), 'utf8');
  await fs.rename(tmp, target);
}
