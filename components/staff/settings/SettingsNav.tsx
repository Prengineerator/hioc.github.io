'use client';

// SET-1 — the settings section nav shown by app/staff/settings/layout.tsx on
// every /staff/settings/** route: a vertical sidebar on md+ screens, and a
// horizontally scrollable pill row on a phone-width counter tablet, where a
// sidebar would eat the little width there is. Active-section logic is the
// shared, unit-tested isActiveSettingsSection() (lib/staff/settingsNav.ts) —
// the same function the "Settings" tab in StaffHeader uses, so the two can
// never disagree about what's active.

import { SurfaceLink as Link, useSurfaceHref } from '@/components/SurfaceLink';
import { usePathname } from 'next/navigation';
import { SETTINGS_SECTIONS, isActiveSettingsSection } from '@/lib/staff/settingsNav';

export function SettingsNav() {
  // usePathname() reports the BROWSER's path, which on staff.hioc.in is
  // '/settings/printers' while every href here is written canonically as
  // '/staff/settings/printers' — resolve each through toHref() before
  // comparing, same pattern as StaffHeader's tab highlighting.
  const pathname = usePathname();
  const toHref = useSurfaceHref();

  return (
    <nav aria-label="Settings sections" className="md:w-56 md:shrink-0">
      <h1 className="mb-3 text-2xl font-bold text-charcoal">Settings</h1>

      {/* Phone/small screens: horizontally scrollable pill nav. */}
      <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-2 md:hidden">
        {SETTINGS_SECTIONS.map((section) => {
          const active = isActiveSettingsSection(pathname, toHref(section.href));
          return (
            <li key={section.href} className="shrink-0">
              <Link
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'inline-flex min-h-[44px] items-center whitespace-nowrap rounded-full border px-4 text-sm font-bold transition-colors ' +
                  (active
                    ? 'border-charcoal bg-charcoal text-cream'
                    : 'border-[#e5e5e5] text-charcoal hover:border-tan')
                }
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>

      {/* md+: vertical sidebar. */}
      <ul className="hidden flex-col gap-1 md:flex">
        {SETTINGS_SECTIONS.map((section) => {
          const active = isActiveSettingsSection(pathname, toHref(section.href));
          return (
            <li key={section.href}>
              <Link
                href={section.href}
                aria-current={active ? 'page' : undefined}
                className={
                  'block min-h-[44px] rounded-md px-3 py-2.5 text-sm font-bold leading-[19px] transition-colors ' +
                  (active ? 'bg-charcoal text-cream' : 'text-charcoal hover:bg-surface')
                }
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
