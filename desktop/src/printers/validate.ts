// PRN-1/D7-6 — pure printer-config validation/normalization, split out of
// store.ts so it never pulls in `electron` (store.ts's only Electron
// dependency is `app.getPath('userData')` for the on-disk path). Keeping this
// module electron-free lets it be imported from code the web app's
// (electron-free) TypeScript project type-checks — tests/desktop/store.ts
// used to drag `electron` into that project's type-check via this exact
// import chain, which is what this split fixes. No Node-only APIs here
// either: just object/string/number validation.

import type { CutMode, PrinterConfig, PrinterConnection, PrinterRole } from '@/lib/desktop/bridge';

export const VALID_ROLES: readonly PrinterRole[] = ['kot', 'receipt', 'token'];
export const VALID_CUT_MODES: readonly CutMode[] = ['standard', 'partial', 'full', 'legacy'];
export const DEFAULT_CUT_MODE: CutMode = 'standard';
const MIN_COPIES = 1;
const MAX_COPIES = 5;

export class PrinterConfigError extends Error {}

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

/** Unknown or missing cut style silently falls back to `'standard'` rather
 * than rejecting the whole printer — a config saved by an older build (before
 * `cutMode` existed) or a future one (a cut style this build doesn't know
 * yet) must still load. */
export function validateCutMode(value: unknown): CutMode {
  return typeof value === 'string' && (VALID_CUT_MODES as readonly string[]).includes(value)
    ? (value as CutMode)
    : DEFAULT_CUT_MODE;
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
    cutMode: validateCutMode(v.cutMode),
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
