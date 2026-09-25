import type { ReactNode } from 'react';
import { SettingsNav } from '@/components/staff/settings/SettingsNav';

// SET-1 — shared chrome for every /staff/settings/** route: a left sidebar
// on md+ screens, a horizontally scrollable pill nav below it (SettingsNav
// itself decides which to show via Tailwind breakpoints, so there's no
// layout shift/flash between them). /staff/** is already gated by
// middleware.ts + app/staff/layout.tsx; this layout adds no auth of its own,
// matching every other nested layout under /staff.
export default function StaffSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-6 md:flex-row md:items-start md:gap-10 md:py-10">
      <SettingsNav />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
