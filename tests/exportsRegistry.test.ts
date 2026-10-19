import { describe, expect, it } from 'vitest';

// The report registry (lib/reports/exports/registry.ts): every downloadable
// report in one list. A duplicate key would make one report unreachable (the
// export route returns the first match), so it fails here. The flags are set
// before the import so the flag-gated reports (HIOC Ritual, campaigns) are
// checked too.

process.env.NEXT_PUBLIC_FLAG_COFFEE_PASS = 'true';
process.env.NEXT_PUBLIC_FLAG_MARKETING = 'true';

const { ALL_REPORTS, REPORT_GROUPS, findReport, reportsInGroup } = await import('@/lib/reports/exports/registry');

describe('report registry', () => {
  it('has a unique, URL-safe key for every report', () => {
    const keys = ALL_REPORTS.map((r) => r.key);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(dupes).toEqual([]);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('puts every report in a known group, with words for the owner', () => {
    const groups = new Set(REPORT_GROUPS.map((g) => g.group));
    expect(groups.size).toBe(REPORT_GROUPS.length);
    for (const r of ALL_REPORTS) {
      expect(groups.has(r.group), r.key).toBe(true);
      expect(r.title.trim(), r.key).not.toBe('');
      expect(r.description.trim(), r.key).not.toBe('');
      expect(typeof r.load).toBe('function');
    }
  });

  it('lists the groups in filing order and gives each some reports', () => {
    expect(REPORT_GROUPS.map((g) => g.group)).toEqual(['gst', 'sales', 'cash', 'staff', 'loyalty']);
    for (const g of REPORT_GROUPS) expect(reportsInGroup(g.group).length, g.group).toBeGreaterThan(0);
    expect(REPORT_GROUPS[0].title).toBe('GST filing (GSTR-1 / GSTR-3B)');
  });

  it('finds a report by key', () => {
    expect(findReport('gstr1-b2cs')?.group).toBe('gst');
    expect(findReport('retention-summary')?.group).toBe('loyalty');
    expect(findReport('campaign-performance')?.key).toBe('campaign-performance');
    expect(findReport('nope')).toBeUndefined();
    expect(findReport('')).toBeUndefined();
    expect(findReport(null)).toBeUndefined();
  });

  it('is the sum of its groups', () => {
    const total = REPORT_GROUPS.reduce((n, g) => n + reportsInGroup(g.group).length, 0);
    expect(total).toBe(ALL_REPORTS.length);
  });
});
