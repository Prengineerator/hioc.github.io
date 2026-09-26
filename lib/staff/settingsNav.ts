// SET-1 — the single nav definition for /staff/settings/**, shared by the
// settings layout's own sidebar/pill nav (components/staff/settings/SettingsNav.tsx)
// and the "Settings" tab in the main staff header (StaffHeader.tsx), so the
// two never list different sections or disagree about what counts as active.
//
// Kept pure and framework-free (no hooks, no next/navigation) so it's
// unit-testable without a component harness — see tests/settingsNav.test.ts.

export interface SettingsNavItem {
  /** Canonical (surface-unaware) path, as written everywhere else in the app. */
  href: string;
  label: string;
}

export const SETTINGS_ROOT = '/staff/settings';

export const SETTINGS_SECTIONS: SettingsNavItem[] = [
  { href: SETTINGS_ROOT, label: 'Overview' },
  { href: '/staff/settings/printers', label: 'Printers & cash drawer' },
  { href: '/staff/settings/kot-counters', label: 'KOT counters' },
  { href: '/staff/settings/store', label: 'Store' },
  { href: '/staff/settings/counter', label: 'This counter' },
];

/**
 * Whether `pathname` (already resolved for the current surface — pass it
 * `toHref(href)`, not the bare canonical `href`, on a subdomain) falls under
 * the given settings section.
 *
 * The Overview row (`href === SETTINGS_ROOT`) matches only the settings root
 * itself, exactly — otherwise every sub-section would also highlight
 * Overview, since they all start with the same prefix. Every other row
 * matches its own path and anything nested under it, so a future
 * sub-route (e.g. a wizard step) still lights up its parent tab.
 */
export function isActiveSettingsSection(pathname: string, href: string): boolean {
  if (href === SETTINGS_ROOT) {
    return pathname === SETTINGS_ROOT || pathname === `${SETTINGS_ROOT}/`;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Whether `pathname` is anywhere under /staff/settings — what the header's
 * single "Settings" tab (which links to the overview) highlights for. */
export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_ROOT || pathname.startsWith(`${SETTINGS_ROOT}/`);
}
