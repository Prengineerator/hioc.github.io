import { indianE164HonouringPlus } from '@/lib/phone';

/**
 * Turn raw `staff_accounts` rows into user_id -> '+91XXXXXXXXXX'.
 * `staff_accounts.phone` is free text typed on the owner portal Staff screen,
 * so anything that is not a valid Indian mobile (empty, text, too short,
 * foreign '+' numbers) is left out. Only the normalised value is carried.
 */
export function reminderPhoneMap(
  rows: ReadonlyArray<{ user_id?: unknown; phone?: unknown }> | null | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows ?? []) {
    if (typeof row.user_id !== 'string') continue;
    const phone = indianE164HonouringPlus(row.phone);
    if (phone) map.set(row.user_id, phone);
  }
  return map;
}
