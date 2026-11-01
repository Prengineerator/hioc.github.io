// Client-side shapes for the owner's Warehouse page (components/owner/warehouse/*):
// what /api/owner/warehouse and /api/owner/warehouse/alerts return. The fetch
// wrapper and input styles are the Stock screen's (components/staff/inventory/client.ts),
// so both screens look and behave the same.

import type { WarehousePayload, WarehouseSheetRow, WarehouseBatchView } from '@/lib/inventory/warehouseServer';
import type { AlertLogRow, AlertSettings } from '@/lib/inventory/ownerAlerts';

export type { WarehousePayload, WarehouseSheetRow, WarehouseBatchView, AlertLogRow, AlertSettings };
export {
  api,
  inputBase,
  inputClass,
  primaryButton,
  secondaryButton,
  shortDate,
  type StockRequestView,
  type PersonRef,
} from '@/components/staff/inventory/client';

export interface AlertsPayload {
  settings: AlertSettings;
  migrated: boolean;
  ownerEmails: string[];
  recipients: { emails: string[]; phones: string[] };
  health: { email: { ready: boolean; missing: string[] }; whatsapp: { ready: boolean; missing: string[] } };
  log: AlertLogRow[];
}

/** "2026-10-05T09:30:00Z" → "5 Oct, 3:00 pm" (IST). */
export function when(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  });
}

/** "3h" / "2d" since `iso` — how long something has been on the road. */
export function age(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}
