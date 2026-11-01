import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/owner/reports/sales — the Items & custom report as a CSV. Owner
// only; reads the same query string the page does.

const state: { owner: { id: string } | null; loads: [string, string][] } = { owner: null, loads: [] };

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));
vi.mock('@/lib/api/date', async (orig) => ({ ...(await orig<typeof import('@/lib/api/date')>()), istDateIso: () => '2026-11-01' }));

const line = (name: string, category: string, qty: number, total: number) => ({
  id: name,
  menuItemId: name,
  name,
  variant: '',
  category,
  quantity: qty,
  weightGrams: null,
  lineTotalInr: total,
  passCoveredInr: 0,
  passDrinks: 0,
  gstExempt: false,
  gstCode: { code: '996331', description: '', uqc: 'NA', kind: 'service' },
  taxableInr: total,
  exemptValueInr: 0,
  cgstInr: 0,
  sgstInr: 0,
});

vi.mock('@/lib/reports/exports/orderDataServer', () => ({
  loadOrderDataset: (_admin: unknown, from: string, to: string) => {
    state.loads.push([from, to]);
    return Promise.resolve({
      from,
      to,
      gstRatePercent: 5,
      gstInclusive: false,
      refunds: [],
      orders: [
        {
          id: 'o1',
          valid: true,
          date: '2026-10-30',
          hour: 10,
          totalInr: 300,
          settleDiscountInr: 0,
          paymentMethods: ['cash'],
          channel: 'staff_pos',
          orderType: 'takeaway',
          tableLabel: null,
          createdByName: 'Asha',
          lines: [line('Latte', 'Coffee', 1, 180), line('Cookie', 'Bakery', 2, 120)],
        },
      ],
    });
  },
}));

const { GET } = await import('@/app/api/owner/reports/sales/route');
const get = (qs: string) => GET(new Request(`https://owner.hioc.in/api/owner/reports/sales?${qs}`));

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.loads = [];
});

describe('GET /api/owner/reports/sales', () => {
  it('is owner only', async () => {
    state.owner = null;
    expect((await get('from=2026-10-26&to=2026-11-01')).status).toBe(401);
    expect(state.loads).toHaveLength(0);
  });

  it('refuses a bad range', async () => {
    expect((await get('from=2026-11-05&to=2026-11-06')).status).toBe(400);
  });

  it('writes the item-wise report as a CSV download', async () => {
    const res = await get('from=2026-10-26&to=2026-11-01');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('hioc-sales-by-item-2026-10-26_to_2026-11-01.csv');
    const body = await res.text();
    expect(body).toContain('Item,Quantity,Bills,Sales (INR),Net sales (INR)');
    expect(body).toContain('Latte,1,1,180,180');
    expect(body).toContain('TOTAL,3,1,300,300');
  });

  it('honours the filters (repeated keys) and loads the period before only when comparing', async () => {
    const res = await get('from=2026-10-26&to=2026-11-01&rows=category&category=Bakery&category=Food');
    const body = await res.text();
    expect(body).toContain('Bakery');
    expect(body).not.toContain('Coffee');
    expect(state.loads).toEqual([['2026-10-26', '2026-11-01']]);

    state.loads = [];
    await get('from=2026-10-26&to=2026-11-01&compare=1');
    expect(state.loads).toEqual([
      ['2026-10-26', '2026-11-01'],
      ['2026-10-19', '2026-10-25'],
    ]);
  });
});
