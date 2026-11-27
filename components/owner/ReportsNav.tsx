// The tabs across Owner → Reports: Overview · Items & custom · Insights · GST ·
// Downloads. Each page used to carry its own row of buttons to some of the
// others, different on every page; now every report page has the same tabs,
// and the dates the owner is looking at travel with them (GST is filed by the
// month, so it opens on the month the range covers, else its own default).

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { wholeMonthOf } from '@/lib/reports/exports/period';

export type ReportsTab = 'overview' | 'sales' | 'insights' | 'gst' | 'downloads';

export function reportsTabs(from: string, to: string): { key: ReportsTab; label: string; href: string }[] {
  const range = `from=${from}&to=${to}`;
  const month = wholeMonthOf(from, to);
  return [
    { key: 'overview', label: 'Overview', href: `/owner/reports?${range}` },
    { key: 'sales', label: 'Items & custom', href: `/owner/reports/sales?${range}` },
    { key: 'insights', label: 'Insights', href: `/owner/reports/insights?${range}` },
    { key: 'gst', label: 'GST', href: month ? `/owner/reports/gst?month=${month}` : '/owner/reports/gst' },
    { key: 'downloads', label: 'Downloads', href: `/owner/reports/downloads?${range}` },
  ];
}

export function ReportsNav({ active, from, to }: { active: ReportsTab; from: string; to: string }) {
  return (
    <nav aria-label="Reports" className="-mx-4 overflow-x-auto px-4">
      <ul className="flex min-w-max gap-1 border-b border-line">
        {reportsTabs(from, to).map((t) => {
          const on = t.key === active;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={on ? 'page' : undefined}
                className={
                  '-mb-px flex min-h-[44px] items-center whitespace-nowrap border-b-2 px-4 text-sm font-bold transition-colors ' +
                  (on ? 'border-charcoal text-charcoal' : 'border-transparent text-muted hover:text-charcoal')
                }
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
