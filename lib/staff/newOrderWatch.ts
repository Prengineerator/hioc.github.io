// The staff shell's new-order watch (components/staff/StaffShell.tsx) — the
// pure half. The alarm used to live on the Orders page only, so it went quiet
// the moment a staffer switched to New order or Tables; the shell now watches
// on every /staff page, and these rules decide what counts as "new".

/**
 * Which 'received' (waiting to be accepted) orders are NEW since the watch
 * started. Mirrors the Orders page's own rule so the two agree:
 * - the first load only sets the baseline: orders already waiting when the
 *   screen opened are not "new" (the Orders page shows them anyway);
 * - an id that shows up later is new;
 * - an id that is no longer 'received' (accepted, rejected…) stops being new.
 */
export function nextNewOrderIds(
  previousReceived: ReadonlySet<string> | null,
  currentReceived: ReadonlySet<string>,
  currentNew: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  if (previousReceived === null) return next;
  for (const id of currentNew) if (currentReceived.has(id)) next.add(id);
  for (const id of currentReceived) if (!previousReceived.has(id)) next.add(id);
  return next;
}

export const SOUND_PREF_KEY = 'hioc:staff-sound';

/**
 * The order-alert sound is ON unless this device was explicitly turned off.
 * Stored per device (localStorage), so it survives switching tabs, reloads
 * and shift changes — it used to reset to off on every page change.
 */
export function readSoundPref(stored: string | null | undefined): boolean {
  return stored !== 'off';
}

export const COUNTER_MODE_KEY = 'hioc:counter-mode';

/** The pages counter mode keeps within reach — what the counter works from. */
export const COUNTER_MODE_HREFS: readonly string[] = ['/staff', '/staff/orders/new', '/staff/tables'];
