'use client';

// "Top picks" table of the Suggestions Overview tab. A client module (split out
// of OverviewWidgets.tsx, which stays server-renderable) because its columns are
// functions for the sortable/filterable DataTable; OverviewWidgets re-exports it
// so the page's import is unchanged.

import { Card } from '@/components/owner/dashboard';
import { DataTable } from '@/components/ui/DataTable';
import type { SuggestionStats } from '@/lib/suggest/types';

type TopItem = SuggestionStats['topItems'][number];

/** Hit rate as a whole percent, or null when nothing was suggested. */
function hitRate(i: TopItem): number | null {
  return i.suggested > 0 ? Math.round((i.added / i.suggested) * 100) : null;
}

export function TopPicksTable({ stats }: { stats: SuggestionStats }) {
  if (stats.topItems.length === 0) {
    return (
      <Card title="Top picks">
        <p className="py-6 text-center text-sm text-muted">No suggestions shown yet.</p>
      </Card>
    );
  }
  const count = (key: string, header: string, value: (i: TopItem) => number) => ({
    key,
    header,
    filter: 'number' as const,
    align: 'right' as const,
    value,
    cellClassName: 'text-muted',
  });
  return (
    <Card title="Top picks">
      <DataTable
        rows={stats.topItems}
        rowKey={(i) => i.menuItemId}
        minWidth={640}
        headerTextClassName="text-xs font-bold uppercase text-muted"
        columns={[
          {
            key: 'item',
            header: 'Item',
            filter: 'text',
            value: (i) => i.name,
            cellClassName: 'text-charcoal',
            render: (i) => (
              <>
                {i.name}
                {i.suggested > 0 && i.added === 0 && (
                  <span className="ml-2 rounded-full bg-[#f6d9d9] px-2 py-0.5 text-[10px] font-bold text-red-800">
                    never added
                  </span>
                )}
              </>
            ),
          },
          count('suggested', 'Suggested', (i) => i.suggested),
          count('added', 'Added', (i) => i.added),
          count('ordered', 'Ordered', (i) => i.ordered),
          {
            key: 'hit_rate',
            header: 'Hit rate (%)',
            filter: 'number',
            align: 'right',
            value: hitRate,
            cellClassName: 'text-muted',
            render: (i) => {
              const r = hitRate(i);
              return r === null ? '—' : `${r}%`;
            },
          },
          count('up', '👍', (i) => i.up),
          count('down', '👎', (i) => i.down),
        ]}
      />
    </Card>
  );
}
