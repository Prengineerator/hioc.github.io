'use client';

// Product costs (spec §7.6): what each item (each SIZE — Regular and Large cost
// different amounts) costs you to make. This is what turns "10% off" and "a free
// Cold Coffee" into rupees you can compare: a free item is worth its full price to
// the customer but costs you only its cost.
//
// Costs are private. They come from an owner-only API and are never on the public
// menu. Edits are drafts; one Save sends only the rows that changed.

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { parseCostsPut } from '@/lib/marketing/parse';
import { MIN_COST_COVERAGE_PCT, type CostRow, type CostsResponse, type MarketingTab } from '@/lib/marketing/types';
import { API, requestJson } from './api';
import {
  HIGH_FOOD_COST_PCT,
  boxValue,
  chunkCosts,
  coverageLevel,
  diffCosts,
  foodCostPct,
  isHighFoodCost,
  isRowDirty,
  liveCost,
  marginInr,
  missingCostRows,
  sortCostRows,
  topFreeItems,
  variantDisplay,
  type CostDrafts,
} from './costsForm';
import { candidateName } from './drafts';
import { formatPercent, inr, inrExact, signedInr } from './format';
import { useApi } from './hooks';
import { CheckRow, Kpi, Notice, Panel, ProgressBar, ResourceGate, TabIntro } from './ui';

export function CostsTab({ onNavigate }: { onNavigate: (tab: MarketingTab) => void }) {
  const costs = useApi<CostsResponse>(API.costs);
  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Product costs">
        Enter what each item costs you to make (ingredients and packaging). The agent uses it to work out real profit, and to pick a free item that delights customers without costing you much. Only you can see this.
      </TabIntro>
      <ResourceGate resource={costs} label="Loading your menu…">
        {(data) => <CostsBody data={data} setData={costs.setData} onNavigate={onNavigate} />}
      </ResourceGate>
    </div>
  );
}

/** Exported for the render smoke test (tests/marketingDashboardRender.test.ts). */
export function CostsBody({ data, setData, onNavigate }: { data: CostsResponse; setData: (d: CostsResponse) => void; onNavigate: (tab: MarketingTab) => void }) {
  const [drafts, setDrafts] = useState<CostDrafts>({});
  const [onlyMissing, setOnlyMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState<number | null>(null);

  const items = useMemo(() => data.items ?? [], [data.items]);
  const rows = useMemo(() => (onlyMissing ? missingCostRows(items) : sortCostRows(items)), [items, onlyMissing]);
  const { changes, invalid } = useMemo(() => diffCosts(items, drafts), [items, drafts]);
  const invalidCount = Object.keys(invalid).length;
  const level = coverageLevel(data.coverage_pct);

  const setBox = (row: CostRow, value: string) => {
    setSavedCount(null);
    setError(null);
    setDrafts((d) => ({ ...d, [row.variant_id]: value }));
  };

  const save = async () => {
    const check = parseCostsPut({ costs: changes });
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setSaving(true);
    setError(null);
    let saved = 0;
    let latest: CostsResponse | null = null;
    for (const chunk of chunkCosts(check.value.costs)) {
      const r = await requestJson<CostsResponse>(API.costs, { method: 'PUT', body: { costs: chunk } });
      if (!r.ok) {
        setError(`${saved > 0 ? `${saved} saved, then it stopped: ` : ''}${r.error.message}`);
        break;
      }
      saved += chunk.length;
      latest = r.data;
      // A saved row leaves the draft set immediately, so a failure later never re-sends it.
      setDrafts((d) => {
        const next = { ...d };
        for (const c of chunk) delete next[c.variant_id];
        return next;
      });
    }
    setSaving(false);
    if (latest) setData(latest);
    if (saved > 0) setSavedCount(saved);
  };

  const columns: DataTableColumn<CostRow>[] = [
    {
      key: 'item',
      header: 'Item',
      filter: 'text',
      value: (r) => r.item_name,
      render: (r) => (
        <span className="text-charcoal">
          <span className="font-semibold">{r.item_name}</span>
          {!r.is_available ? <span className="ml-1 text-xs text-muted">(not on the menu right now)</span> : null}
        </span>
      ),
    },
    { key: 'variant', header: 'Size', filter: 'none', sortable: true, value: (r) => variantDisplay(r.variant_label), cellClassName: 'text-charcoal' },
    { key: 'price', header: 'Price', filter: 'none', sortable: true, align: 'right', value: (r) => r.price_inr, render: (r) => inr(r.price_inr), cellClassName: 'font-mono tabular-nums' },
    {
      key: 'cost',
      header: 'Your cost (₹)',
      filter: 'none',
      sortable: false,
      value: (r) => r.cost_inr,
      render: (r) => {
        const err = invalid[r.variant_id];
        const dirty = isRowDirty(r, drafts);
        return (
          <div className="min-w-[110px]">
            <input
              type="text"
              inputMode="decimal"
              aria-label={`Cost of ${r.item_name}, ${variantDisplay(r.variant_label)}, in rupees`}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? `cost-err-${r.variant_id}` : undefined}
              value={boxValue(r, drafts)}
              placeholder="not set"
              onChange={(e) => setBox(r, e.target.value)}
              className={`h-10 w-24 rounded-md border bg-cream px-2 text-right font-mono text-sm outline-none focus:border-tan ${err ? 'border-red-600' : dirty ? 'border-tan' : 'border-line'}`}
            />
            {err ? (
              <p id={`cost-err-${r.variant_id}`} role="alert" className="mt-0.5 text-xs font-semibold text-red-700">
                {err}
              </p>
            ) : dirty ? (
              <p className="mt-0.5 text-xs text-tan-dark">edited</p>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'food',
      header: 'Food cost',
      filter: 'none',
      sortable: true,
      align: 'right',
      // Sort by the SAVED cost so rows don't jump around under the owner's fingers while typing.
      value: (r) => foodCostPct(r.price_inr, r.cost_inr),
      render: (r) => {
        const pct = foodCostPct(r.price_inr, liveCost(r, drafts));
        if (pct === null) return <span className="text-muted">—</span>;
        return isHighFoodCost(pct) ? (
          <span className="font-bold text-amber-900" title={`Above ${HIGH_FOOD_COST_PCT}% of the price`}>
            <span aria-hidden="true">⚠ </span>
            {formatPercent(pct)}
            <span className="sr-only"> (high)</span>
          </span>
        ) : (
          <span>{formatPercent(pct)}</span>
        );
      },
      cellClassName: 'font-mono tabular-nums',
    },
    {
      key: 'margin',
      header: 'You keep',
      filter: 'none',
      sortable: true,
      align: 'right',
      value: (r) => marginInr(r.price_inr, r.cost_inr),
      render: (r) => {
        const m = marginInr(r.price_inr, liveCost(r, drafts));
        return m === null ? <span className="text-muted">—</span> : signedInr(m);
      },
      cellClassName: 'font-mono tabular-nums',
    },
  ];

  const top = topFreeItems(data.free_item_ranking ?? []);

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Kpi label="Costs entered for" value={formatPercent(data.coverage_pct)} hint="of what you sold in the last 90 days">
          <ProgressBar value={data.coverage_pct} max={100} label="Share of recent sales with a cost entered" tone="plain" />
        </Kpi>
        <Kpi label="Assumed food cost where none is entered" value={formatPercent(data.default_food_cost_pct)} hint="of the price">
          <button type="button" onClick={() => onNavigate('settings')} className="mt-1 min-h-[40px] text-left text-xs font-bold text-tan-dark hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan">
            Change it in Settings
          </button>
        </Kpi>
      </div>

      {level === 'none' ? (
        <Notice tone="warn" title="No product costs yet">
          Until you enter some, every forecast assumes {formatPercent(data.default_food_cost_pct)} food cost and campaigns are flagged “Product costs missing”. Start with your best sellers: the list below can show them first.
        </Notice>
      ) : level === 'low' ? (
        <Notice tone="warn" title={`Costs are entered for only ${formatPercent(data.coverage_pct)} of your sales`}>
          Campaigns are flagged “Product costs missing” until this reaches {MIN_COST_COVERAGE_PCT}%, because the forecast is leaning on the {formatPercent(data.default_food_cost_pct)} guess.
        </Notice>
      ) : null}

      <Panel title="Best free-item offers" subtitle="Ranked by price ÷ cost: how much a customer feels they are getting for each rupee it costs you.">
        {top.length === 0 ? (
          <p className="text-sm text-muted">Enter costs for a few items to see which free item is the best value.</p>
        ) : (
          <ol className="flex flex-col divide-y divide-[#f2efe9]">
            {top.map((c, i) => (
              <li key={c.variant_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2 text-sm">
                <span className="w-5 font-mono text-muted">{i + 1}.</span>
                <span className="min-w-0 flex-1 text-charcoal">
                  <span className="font-semibold">{candidateName(c)}</span>
                </span>
                <span className="text-muted">
                  worth {inr(c.price_inr)}, costs you {inrExact(c.cost_inr)}
                </span>
                <span className="font-mono font-bold tabular-nums text-charcoal">{c.value_per_rupee.toFixed(1)}×</span>
              </li>
            ))}
          </ol>
        )}
      </Panel>

      <Panel
        title="Your menu"
        action={
          <div className="max-w-sm">
            <CheckRow checked={onlyMissing} onChange={setOnlyMissing}>
              Only items with no cost yet (best sellers first)
            </CheckRow>
          </div>
        }
      >
        <p className="mb-3 text-xs text-muted">
          A ⚠ marks an item whose cost is above {HIGH_FOOD_COST_PCT}% of its price. Leave a box empty to use the assumed {formatPercent(data.default_food_cost_pct)}. Nothing is saved until you press Save.
        </p>
        <DataTable
          rows={rows}
          columns={columns}
          rowKey={(r) => r.variant_id}
          emptyMessage={onlyMissing ? 'Every item has a cost. Nice work.' : 'No menu items found.'}
          minWidth={640}
          cellPadding="py-1.5 pr-3"
          rowClassName={(r) => (isHighFoodCost(foodCostPct(r.price_inr, liveCost(r, drafts))) ? 'bg-amber-50' : '')}
          groupHeader={
            onlyMissing
              ? undefined
              : (r, prev) =>
                  !prev || prev.category !== r.category ? (
                    <tr>
                      <td colSpan={columns.length} className="bg-surface px-2 py-1.5 text-xs font-bold uppercase tracking-wide text-charcoal">
                        {r.category}
                      </td>
                    </tr>
                  ) : null
          }
        />

        {/* Sticky so Save is always in reach on a long menu, on a phone too. */}
        <div className="sticky bottom-0 z-20 -mx-5 -mb-5 mt-4 flex flex-wrap items-center gap-3 border-t border-line bg-cream px-5 py-3">
          <Button onClick={save} loading={saving} disabled={changes.length === 0 || invalidCount > 0 || saving}>
            {changes.length === 0 ? 'Save costs' : `Save ${changes.length} change${changes.length === 1 ? '' : 's'}`}
          </Button>
          {changes.length > 0 || invalidCount > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDrafts({});
                setError(null);
              }}
            >
              Discard edits
            </Button>
          ) : null}
          {invalidCount > 0 ? (
            <span role="alert" className="text-sm font-semibold text-red-700">
              Fix the {invalidCount} box{invalidCount === 1 ? '' : 'es'} marked in red first.
            </span>
          ) : savedCount !== null ? (
            <span role="status" className="text-sm font-semibold text-green-800">
              ✓ Saved {savedCount} cost{savedCount === 1 ? '' : 's'}
            </span>
          ) : changes.length === 0 ? (
            <span className="text-sm text-muted">No changes yet</span>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
            {error}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}
