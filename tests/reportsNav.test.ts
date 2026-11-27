import { describe, expect, it } from 'vitest';
import { reportsTabs } from '@/components/owner/ReportsNav';

// One set of tabs across Owner → Reports; the dates travel with them.
describe('reportsTabs', () => {
  it('carries the dates to every tab, and GST opens on the month the range covers', () => {
    const tabs = reportsTabs('2026-10-01', '2026-10-31');
    expect(tabs.map((t) => t.label)).toEqual(['Overview', 'Items & custom', 'Insights', 'GST', 'Downloads']);
    expect(tabs.find((t) => t.key === 'sales')!.href).toBe('/owner/reports/sales?from=2026-10-01&to=2026-10-31');
    expect(tabs.find((t) => t.key === 'gst')!.href).toBe('/owner/reports/gst?month=2026-10');
  });

  it('GST falls back to its own default for a range that is not a whole month', () => {
    expect(reportsTabs('2026-10-26', '2026-11-01').find((t) => t.key === 'gst')!.href).toBe('/owner/reports/gst');
  });
});
