// Local response shapes for the owner Cash screen (docs/PHASE-5-CASH-COUNTS.md).
// Mirrors what app/api/owner/cash-shortages/** and app/api/owner/cash-counts/**
// return, kept local to the UI the same way components/owner/PayrollScreen.tsx
// defines its own response types rather than importing server-side ones.

import type { CashCountKind, ShortageStatus } from '@/lib/cash/counts';

export interface OwnerShortageRow {
  id: string;
  status: ShortageStatus;
  amountInr: number;
  businessDate: string;
  createdAt: string;
  userId: string;
  userName: string;
  originalUserId: string;
  originalUserName: string;
  decidedBy: string | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string;
  locked: boolean;
  count: {
    id: string;
    kind: CashCountKind;
    countedTotalInr: number | null;
    expectedTotalInr: number | null;
    varianceInr: number | null;
    createdAt: string;
  } | null;
  previousCount: {
    id: string;
    countedTotalInr: number | null;
    userId: string;
    userName: string;
    createdAt: string;
  } | null;
}

export interface OwnerCashCountRow {
  id: string;
  kind: CashCountKind;
  userId: string;
  userName: string;
  businessDate: string;
  countedTotalInr: number | null;
  expectedTotalInr: number | null;
  varianceInr: number | null;
  overrideByName: string | null;
  overrideReason: string | null;
  createdAt: string;
}

export interface OwnerCashMovementRow {
  id: string;
  direction: 'out' | 'in';
  amountInr: number;
  reason: string;
  recordedByName: string;
  createdAt: string;
}

export interface ActiveStaffOption {
  id: string;
  name: string;
}

export const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export const KIND_LABEL: Record<string, string> = {
  clock_in: 'Clock-in count',
  clock_out: 'Clock-out count',
  day_open: 'Day-open count',
  day_close: 'Day-close count',
  manual: 'Manual count',
  override: 'Excused count',
};

export function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
