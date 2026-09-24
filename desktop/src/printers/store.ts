// PRN-1/D7-6 — printer configuration is a physical fact of THIS machine (a USB
// path or an IP address), so it lives in a plain JSON file under this
// machine's userData directory, never on the server. `save()` replaces the
// whole list and validates every entry strictly: a bad write here would
// silently stop routing tickets to the kitchen, which is the one failure this
// module exists to prevent.

import { app } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PrinterConfig, PrinterConnection, PrinterRole } from '@/lib/desktop/bridge';

const FILE_NAME = 'printers.json';
const VALID_ROLES: readonly PrinterRole[] = ['kot', 'receipt', 'token'];
const MIN_COPIES = 1;
const MAX_COPIES = 5;

export class PrinterConfigError extends Error {}

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 65535;
}

function isValidUsbId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff;
}

function validateConnection(conn: unknown, printerLabel: string): PrinterConnection {
  if (!conn || typeof conn !== 'object') {
    throw new PrinterConfigError(`"${printerLabel}" is missing a connection`);
  }
  const c = conn as Record<string, unknown>;

  if (c.kind === 'network') {
    if (!isNonEmptyString(c.host)) throw new PrinterConfigError(`"${printerLabel}" needs a network host`);
    if (!isValidPort(c.port)) throw new PrinterConfigError(`"${printerLabel}" needs a port between 1 and 65535`);
    return { kind: 'network', host: (c.host as string).trim(), port: c.port as number };
  }

  if (c.kind === 'usb') {
    if (!isValidUsbId(c.vendorId)) throw new PrinterConfigError(`"${printerLabel}" needs a valid USB vendorId`);
    if (!isValidUsbId(c.productId)) throw new PrinterConfigError(`"${printerLabel}" needs a valid USB productId`);
    if (c.serialNumber !== undefined && !isNonEmptyString(c.serialNumber)) {
      throw new PrinterConfigError(`"${printerLabel}" has an invalid USB serial number`);
    }
    return {
      kind: 'usb',
      vendorId: c.vendorId as number,
      productId: c.productId as number,
      ...(c.serialNumber ? { serialNumber: (c.serialNumber as string).trim() } : {}),
    };
  }

  if (c.kind === 'system') {
    if (!isNonEmptyString(c.deviceName)) {
      throw new PrinterConfigError(`"${printerLabel}" needs an OS printer device name`);
    }
    if (c.mode !== 'raw' && c.mode !== 'driver') {
      throw new PrinterConfigError(`"${printerLabel}" system printer mode must be "raw" or "driver"`);
    }
    return { kind: 'system', deviceName: (c.deviceName as string).trim(), mode: c.mode };
  }

  throw new PrinterConfigError(`"${printerLabel}" has an unknown connection kind: ${String((c as { kind?: unknown }).kind)}`);
}

function validateCopies(copies: unknown, printerLabel: string): Partial<Record<PrinterRole, number>> {
  if (copies === undefined || copies === null) return {};
  if (typeof copies !== 'object' || Array.isArray(copies)) {
    throw new PrinterConfigError(`"${printerLabel}" has an invalid copies map`);
  }
  const out: Partial<Record<PrinterRole, number>> = {};
  for (const [role, count] of Object.entries(copies as Record<string, unknown>)) {
    if (!VALID_ROLES.includes(role as PrinterRole)) {
      throw new PrinterConfigError(`"${printerLabel}" has copies for an unknown role: ${role}`);
    }
    if (typeof count !== 'number' || !Number.isInteger(count) || count < MIN_COPIES || count > MAX_COPIES) {
      throw new PrinterConfigError(`"${printerLabel}" copies for "${role}" must be an integer between 1 and 5`);
    }
    out[role as PrinterRole] = count;
  }
  return out;
}

export function validatePrinterConfig(value: unknown): PrinterConfig {
  if (!value || typeof value !== 'object') {
    throw new PrinterConfigError('Printer entry must be an object');
  }
  const v = value as Record<string, unknown>;

  if (!isNonEmptyString(v.id)) throw new PrinterConfigError('Printer is missing an id');
  const label = isNonEmptyString(v.name) ? v.name.trim() : v.id;
  if (!isNonEmptyString(v.name)) throw new PrinterConfigError(`Printer "${v.id}" needs a non-empty name`);

  if (v.paperWidthMm !== 58 && v.paperWidthMm !== 80) {
    throw new PrinterConfigError(`"${label}" paper width must be 58 or 80 (mm)`);
  }

  if (!Array.isArray(v.roles) || v.roles.length === 0) {
    throw new PrinterConfigError(`"${label}" needs at least one role (kot, receipt, token)`);
  }
  for (const role of v.roles) {
    if (!VALID_ROLES.includes(role as PrinterRole)) {
      throw new PrinterConfigError(`"${label}" has an unknown role: ${String(role)}`);
    }
  }

  if (typeof v.cut !== 'boolean') throw new PrinterConfigError(`"${label}" "cut" must be true or false`);
  if (typeof v.drawer !== 'boolean') throw new PrinterConfigError(`"${label}" "drawer" must be true or false`);

  const connection = validateConnection(v.connection, label);
  const copies = validateCopies(v.copies, label);

  return {
    id: v.id as string,
    name: (v.name as string).trim(),
    connection,
    paperWidthMm: v.paperWidthMm,
    roles: [...new Set(v.roles as PrinterRole[])],
    copies,
    cut: v.cut,
    drawer: v.drawer,
  };
}

export function validatePrinterConfigs(value: unknown): PrinterConfig[] {
  if (!Array.isArray(value)) throw new PrinterConfigError('Printer list must be an array');
  const configs = value.map(validatePrinterConfig);
  const seen = new Set<string>();
  for (const c of configs) {
    if (seen.has(c.id)) throw new PrinterConfigError(`Duplicate printer id: ${c.id}`);
    seen.add(c.id);
  }
  return configs;
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
