'use client';

// The plans the cafe sells (docs/COFFEE-PASS-SPEC.md CP-D1): one row per plan with
// what the customer gets and pays, the per-cup price and the real discount, and a
// switch to put it on sale or take it off. Edit and New open PlanModal. There is no
// delete: a plan that has been sold is switched off, never removed (passes hold
// snapshots of the plan, so an edit or a switch-off never touches one already sold).
//
// The table scrolls sideways on a phone with the name column pinned. Money is
// mono, right-aligned.

import { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { formatRupees, planRow, planSaveConfirmation, type PlanConfirmation } from '@/lib/passes/ownerUi';
import { callOwnerApi } from './api';
import { PlanModal } from './PlanModal';
import { Section } from './shared';

/** The plan being edited: a stored plan, or 'new'. */
type Editing = CoffeePassPlan | 'new' | null;

export function PlansSection({
  plans,
  onPlanSaved,
}: {
  plans: CoffeePassPlan[];
  onPlanSaved: (plan: CoffeePassPlan) => void;
}) {
  const [editing, setEditing] = useState<Editing>(null);
  // The on/off switch waiting for the owner's yes.
  const [toggle, setToggle] = useState<{ plan: CoffeePassPlan; next: boolean; confirmation: PlanConfirmation } | null>(null);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState('');

  const askToggle = (plan: CoffeePassPlan, next: boolean) => {
    if (toggling) return;
    const confirmation = planSaveConfirmation(plan, { is_active: next });
    if (!confirmation) return; // unreachable: every on/off change has a confirmation
    setToggleError('');
    setToggle({ plan, next, confirmation });
  };

  const confirmToggle = async () => {
    if (!toggle) return;
    setToggling(true);
    setToggleError('');
    const res = await callOwnerApi<{ plan: CoffeePassPlan }>(`/api/owner/passes/plans/${toggle.plan.id}`, {
      method: 'PATCH',
      json: { is_active: toggle.next },
    });
    setToggling(false);
    if (!res.ok) {
      setToggleError(res.error);
      return;
    }
    onPlanSaved(res.data.plan);
    setToggle(null);
  };

  const columns: DataTableColumn<CoffeePassPlan>[] = [
    {
      key: 'name',
      header: 'Plan',
      filter: 'none',
      sortable: false,
      sticky: true,
      value: (p) => p.name,
      render: (p) => (
        <span className="flex flex-col">
          <span className="font-semibold text-charcoal">{p.name}</span>
          {p.description ? <span className="max-w-[16rem] truncate text-xs text-muted">{p.description}</span> : null}
        </span>
      ),
      padding: 'py-2 pr-4',
    },
    { key: 'given', header: 'Cups given', filter: 'none', sortable: false, align: 'right', value: (p) => p.drinks_total, cellClassName: 'font-mono tabular-nums text-charcoal' },
    { key: 'paid', header: 'Paid for', filter: 'none', sortable: false, align: 'right', value: (p) => p.drinks_paid, cellClassName: 'font-mono tabular-nums text-charcoal' },
    {
      key: 'validity',
      header: 'Valid for',
      filter: 'none',
      sortable: false,
      value: (p) => p.validity_days,
      render: (p) => planRow(p).validity,
      cellClassName: 'whitespace-nowrap text-charcoal',
    },
    {
      key: 'cup',
      header: 'Cup value',
      filter: 'none',
      sortable: false,
      align: 'right',
      value: (p) => p.drink_value_inr,
      render: (p) => formatRupees(p.drink_value_inr),
      cellClassName: 'font-mono tabular-nums text-charcoal',
    },
    {
      key: 'price',
      header: 'Price',
      filter: 'none',
      sortable: false,
      align: 'right',
      value: (p) => p.price_inr,
      render: (p) => formatRupees(p.price_inr),
      cellClassName: 'font-mono tabular-nums font-bold text-charcoal',
    },
    {
      key: 'percup',
      header: 'Per cup',
      filter: 'none',
      sortable: false,
      align: 'right',
      value: (p) => planRow(p).perCup,
      render: (p) => formatRupees(planRow(p).perCup),
      cellClassName: 'font-mono tabular-nums text-charcoal',
    },
    {
      key: 'discount',
      header: 'Discount',
      filter: 'none',
      sortable: false,
      align: 'right',
      value: (p) => planRow(p).discountPercent,
      render: (p) => {
        const row = planRow(p);
        if (row.discountPercent === null) return '—';
        if (row.overpriced) {
          // Above the cups' value: say so in words, not only in a colour.
          return (
            <span className="font-semibold text-red-700">
              {row.discountPercent < 0 ? `${Math.abs(row.discountPercent)}% over value` : 'Over value'}
            </span>
          );
        }
        return `${row.discountPercent}%`;
      },
      cellClassName: 'whitespace-nowrap font-mono tabular-nums text-charcoal',
    },
    {
      key: 'cap',
      header: 'Daily limit',
      filter: 'none',
      sortable: false,
      value: (p) => p.max_per_day,
      render: (p) => planRow(p).cap,
      cellClassName: 'whitespace-nowrap text-charcoal',
    },
    {
      key: 'gst',
      header: 'GST exempt',
      filter: 'none',
      sortable: false,
      value: (p) => (p.gst_exempt ? 'Yes' : 'No'),
      render: (p) => (p.gst_exempt ? <Badge variant="outline">Exempt</Badge> : <span className="text-muted">No</span>),
    },
    {
      key: 'active',
      header: 'On sale',
      filter: 'none',
      sortable: false,
      value: (p) => (p.is_active ? 'On' : 'Off'),
      render: (p) => (
        <span className="flex items-center gap-2">
          <ToggleSwitch checked={p.is_active} onChange={(next) => askToggle(p, next)} label={`${p.name}: on sale`} />
          <span className="w-8 text-xs font-semibold text-charcoal">{p.is_active ? 'On' : 'Off'}</span>
        </span>
      ),
    },
    {
      key: 'edit',
      header: 'Edit',
      filter: 'none',
      sortable: false,
      value: () => '',
      render: (p) => (
        <Button variant="secondary" size="sm" onClick={() => setEditing(p)} aria-label={`Edit ${p.name}`}>
          Edit
        </Button>
      ),
      padding: 'py-1.5 pr-0',
    },
  ];

  return (
    <Section
      id="ritual-plans"
      title="Plans"
      description="What customers can buy. Edits and switching a plan off never change a Ritual already sold."
      actions={<Button onClick={() => setEditing('new')}>New plan</Button>}
    >
      {plans.length === 0 ? (
        <EmptyState
          heading="No plans yet"
          body="Create the first plan, for example 7 cups for the price of 5."
          action={<Button onClick={() => setEditing('new')}>New plan</Button>}
        />
      ) : (
        <DataTable
          rows={plans}
          columns={columns}
          rowKey={(p) => p.id}
          minWidth={1080}
          cellPadding="py-2 pr-4"
          headerTextClassName="text-[10px] font-semibold uppercase tracking-wide text-muted"
        />
      )}

      {editing ? (
        <PlanModal
          plan={editing === 'new' ? null : editing}
          plans={plans}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            onPlanSaved(saved);
            setEditing(null);
          }}
        />
      ) : null}

      {toggle ? (
        <Modal
          open
          onClose={toggling ? () => {} : () => setToggle(null)}
          title={toggle.confirmation.title}
          size="sm"
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={() => setToggle(null)} disabled={toggling}>
                Cancel
              </Button>
              <Button variant={toggle.confirmation.danger ? 'danger' : 'primary'} loading={toggling} onClick={() => void confirmToggle()}>
                {toggle.confirmation.confirmLabel}
              </Button>
            </div>
          }
        >
          <p className="text-charcoal">{toggle.confirmation.message}</p>
          <p className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-muted">
            <span className="font-semibold text-charcoal">{toggle.plan.name}</span> · {formatRupees(toggle.plan.price_inr)}
          </p>
          {toggleError ? (
            <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
              {toggleError}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </Section>
  );
}
