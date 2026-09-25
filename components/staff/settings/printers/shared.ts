// PRN-1 — shared types/constants/pure helpers for the Printers & cash drawer
// settings section (components/staff/settings/PrinterSettings.tsx and its
// subcomponents in this directory). Split out of what used to be one ~900-
// line component so each sub-section (Printers, Ticket routing, Paper &
// cutting, Cash drawer) can import just what it needs.
//
// Unchanged from the original components/staff/PrinterSettings.tsx: the
// stored config shape, the IPC calls (bridge.printers.list/save/detect/status,
// printRaw, openDrawer) and this draft-validation logic are all byte-for-byte
// the same — only the JSX that reads/writes them has been reorganised.

import type {
  CutMode,
  PrinterConnection,
  PrinterConfig,
  PrinterHealth,
  PrinterRole,
} from '@/lib/desktop/bridge';

export const ROLES: PrinterRole[] = ['kot', 'receipt', 'token'];
export const ROLE_LABELS: Record<PrinterRole, string> = { kot: 'KOT', receipt: 'Receipt', token: 'Token' };

export const HEALTH_LABELS: Record<PrinterHealth, string> = {
  ok: 'Online',
  paper_near_end: 'Paper low',
  paper_out: 'Out of paper',
  cover_open: 'Cover open',
  offline: 'Offline',
  error: 'Error',
  unknown: 'Status unknown',
};

export const HEALTH_DOT: Record<PrinterHealth, string> = {
  ok: 'bg-green-500',
  paper_near_end: 'bg-yellow-500',
  paper_out: 'bg-red-500',
  cover_open: 'bg-red-500',
  offline: 'bg-red-500',
  error: 'bg-red-500',
  unknown: 'bg-[#c9c2b4]',
};

export const STATUS_POLL_MS = 5000;

/** network and usb are always raw ESC/POS; system is raw only in 'raw' mode —
 * mirrors `isRawCapable` in lib/desktop/printExecutor.ts, for a saved config
 * rather than a draft. */
export function printerIsRawCapable(p: PrinterConfig): boolean {
  return p.connection.kind !== 'system' || p.connection.mode === 'raw';
}

/**
 * Everything the Add/Edit panel needs, in input-friendly (string) form. Roles,
 * copies, cut/cutMode and drawer are carried through here too even though
 * the Add/Edit form (PrinterForm.tsx) no longer exposes controls for them —
 * they've moved to their own page sections (Ticket routing, Paper & cutting,
 * Cash drawer), which write straight to the saved PrinterConfig. Keeping
 * them on the draft means editing a printer's name/connection/paper width
 * can never silently reset settings owned by those other sections.
 */
export interface Draft {
  id: string;
  name: string;
  connKind: PrinterConnection['kind'];
  networkHost: string;
  networkPort: string;
  usb: Extract<PrinterConnection, { kind: 'usb' }> | null;
  systemDeviceName: string;
  systemMode: 'raw' | 'driver';
  paperWidthMm: 58 | 80;
  roles: PrinterRole[];
  copies: Partial<Record<PrinterRole, number>>;
  cut: boolean;
  cutMode: CutMode;
  drawer: boolean;
}

export function newId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `printer-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function blankDraft(): Draft {
  return {
    id: newId(),
    name: '',
    connKind: 'network',
    networkHost: '',
    networkPort: '9100',
    usb: null,
    systemDeviceName: '',
    systemMode: 'raw',
    paperWidthMm: 80,
    roles: [],
    copies: {},
    cut: true,
    cutMode: 'standard',
    drawer: false,
  };
}

export function draftFromPrinter(p: PrinterConfig): Draft {
  return {
    id: p.id,
    name: p.name,
    connKind: p.connection.kind,
    networkHost: p.connection.kind === 'network' ? p.connection.host : '',
    networkPort: p.connection.kind === 'network' ? String(p.connection.port) : '9100',
    usb: p.connection.kind === 'usb' ? p.connection : null,
    systemDeviceName: p.connection.kind === 'system' ? p.connection.deviceName : '',
    systemMode: p.connection.kind === 'system' ? p.connection.mode : 'raw',
    paperWidthMm: p.paperWidthMm,
    roles: [...p.roles],
    copies: { ...p.copies },
    cut: p.cut,
    cutMode: p.cutMode ?? 'standard',
    drawer: p.drawer,
  };
}

/** Whether this draft's connection can take raw ESC/POS bytes (PRN-4). */
export function isRawCapable(draft: Pick<Draft, 'connKind' | 'systemMode'>): boolean {
  return draft.connKind !== 'system' || draft.systemMode === 'raw';
}

export function draftError(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give this printer a name.';
  if (draft.connKind === 'network') {
    if (!draft.networkHost.trim()) return 'Enter the printer’s IP address.';
    const port = Number(draft.networkPort);
    if (!Number.isFinite(port) || port < 1 || port > 65535) return 'Port must be between 1 and 65535.';
  } else if (draft.connKind === 'usb') {
    if (!draft.usb) return 'Pick a USB device — scan for printers first.';
  } else if (draft.connKind === 'system') {
    if (!draft.systemDeviceName.trim()) return 'Pick an installed printer — scan for printers first.';
  }
  return null;
}

export function draftToConnection(draft: Draft): PrinterConnection {
  if (draft.connKind === 'network') {
    return { kind: 'network', host: draft.networkHost.trim(), port: Number(draft.networkPort) || 9100 };
  }
  if (draft.connKind === 'usb' && draft.usb) return draft.usb;
  return { kind: 'system', deviceName: draft.systemDeviceName, mode: draft.systemMode };
}

export function draftToConfig(draft: Draft): PrinterConfig {
  const roles = draft.roles;
  const copies: Partial<Record<PrinterRole, number>> = {};
  for (const role of roles) {
    const n = draft.copies[role];
    if (n !== undefined) copies[role] = n;
  }
  return {
    id: draft.id,
    name: draft.name.trim(),
    connection: draftToConnection(draft),
    paperWidthMm: draft.paperWidthMm,
    roles,
    copies,
    cut: isRawCapable(draft) ? draft.cut : false,
    cutMode: draft.cutMode,
    drawer: draft.drawer,
  };
}

export function connectionSummary(c: PrinterConnection): string {
  if (c.kind === 'network') return `Network — ${c.host}:${c.port}`;
  if (c.kind === 'usb') return `USB — ${c.serialNumber ?? `${c.vendorId}:${c.productId}`}`;
  return `Installed — ${c.deviceName} (${c.mode === 'raw' ? 'raw' : 'driver'})`;
}
