'use client';

// Edit or create a HIOC Ritual plan (docs/COFFEE-PASS-SPEC.md CP-D1, CP-D2, CP-D17).
// The price defaults to cups paid for × cup value and the form shows, live, what
// one cup then costs and how much cheaper that is; a price above what the cups are
// worth is warned about, not blocked (the owner may have a reason). The same checks
// the server makes run here first (lib/passes/ownerUi.ts buildPlanPayload), and the
// server's own message is shown if it still refuses.
//
// Switching a plan on, off, or changing a live plan's terms asks for confirmation
// first. The confirmation is a second STEP of this same dialog, not a second dialog:
// the dialog's Escape and focus handling are per-dialog, so two stacked ones would
// close together.
//
// The modal is mounted only while open (the parent controls it), so every opening
// starts from the plan's stored values.

import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { CoffeePassPlan } from '@/lib/passes/types';
import {
  buildPlanPayload,
  canUseSuggestedPrice,
  emptyPlanForm,
  formatRupees,
  formPriceText,
  nextSortOrder,
  planPreview,
  planSaveConfirmation,
  planToForm,
  withSuggestedPrice,
  withTypedPrice,
  type PlanConfirmation,
  type PlanForm,
  type PlanPayload,
} from '@/lib/passes/ownerUi';
import { callOwnerApi } from './api';

const FORM_ID = 'ritual-plan-form';

export function PlanModal({
  plan,
  plans,
  onClose,
  onSaved,
}: {
  /** The plan being edited, or null for a new one. */
  plan: CoffeePassPlan | null;
  /** Every plan, so a new one sorts after them. */
  plans: CoffeePassPlan[];
  onClose: () => void;
  onSaved: (plan: CoffeePassPlan) => void;
}) {
  const [form, setForm] = useState<PlanForm>(() => (plan ? planToForm(plan) : emptyPlanForm()));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Set while the owner is asked to confirm: what to ask, and the exact request to send once they agree.
  const [pending, setPending] = useState<{ confirmation: PlanConfirmation; body: Record<string, unknown> } | null>(null);

  const set = (patch: Partial<PlanForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setError('');
  };
  const preview = planPreview(form);

  async function send(body: Record<string, unknown>) {
    setSaving(true);
    setError('');
    const res = plan
      ? await callOwnerApi<{ plan: CoffeePassPlan }>(`/api/owner/passes/plans/${plan.id}`, { method: 'PATCH', json: body })
      : await callOwnerApi<{ plan: CoffeePassPlan }>('/api/owner/passes/plans', { method: 'POST', json: body });
    setSaving(false);
    if (!res.ok) {
      // Back to the form, where the message sits next to what can be fixed.
      setPending(null);
      setError(res.error);
      return;
    }
    onSaved(res.data.plan);
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const payload: PlanPayload = buildPlanPayload(form, plan, nextSortOrder(plans));
    if (!payload.ok) {
      setError(payload.error);
      return;
    }
    if (plan && !payload.changed) {
      onClose(); // nothing differs: nothing to send
      return;
    }
    const confirmation = planSaveConfirmation(plan, payload.body);
    if (confirmation) {
      setPending({ confirmation, body: payload.body });
      return;
    }
    void send(payload.body);
  }

  // Step 2: the confirmation.
  // A different key makes it a fresh dialog, so focus moves into it.
  if (pending) {
    const { confirmation } = pending;
    return (
      <Modal
        key="confirm"
        open
        onClose={saving ? () => {} : () => setPending(null)}
        title={confirmation.title}
        size="sm"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => setPending(null)} disabled={saving}>
              Back
            </Button>
            <Button variant={confirmation.danger ? 'danger' : 'primary'} loading={saving} onClick={() => void send(pending.body)}>
              {confirmation.confirmLabel}
            </Button>
          </div>
        }
      >
        <p className="text-charcoal">{confirmation.message}</p>
        <p className="mt-3 rounded-md bg-surface px-3 py-2 text-sm text-muted">
          <span className="font-semibold text-charcoal">{form.name.trim() || 'This plan'}</span>
          {preview.price !== null ? <> · {formatRupees(preview.price)}</> : null}
        </p>
      </Modal>
    );
  }

  return (
    <Modal
      key="form"
      open
      onClose={saving ? () => {} : onClose}
      title={plan ? `Edit ${plan.name}` : 'New plan'}
      size="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" form={FORM_ID} loading={saving}>
            {plan ? 'Save changes' : 'Create plan'}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Input
          label="Name"
          value={form.name}
          maxLength={60}
          autoComplete="off"
          onChange={(e) => set({ name: e.target.value })}
          placeholder="Weekly Ritual"
        />
        <Textarea
          label="Description"
          hint="Shown to customers under the name."
          rows={2}
          maxLength={500}
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Cups given"
            hint="What the customer gets."
            inputMode="numeric"
            autoComplete="off"
            value={form.drinks_total}
            onChange={(e) => set({ drinks_total: e.target.value })}
          />
          <Input
            label="Cups paid for"
            hint="What they pay for. Sets the suggested price."
            inputMode="numeric"
            autoComplete="off"
            value={form.drinks_paid}
            onChange={(e) => set({ drinks_paid: e.target.value })}
          />
          <Input
            label="Valid for (days)"
            hint="Counted in calendar days, today included."
            inputMode="numeric"
            autoComplete="off"
            value={form.validity_days}
            onChange={(e) => set({ validity_days: e.target.value })}
          />
          <Input
            label="Cup value (₹)"
            hint="One cup covers up to this much of one drink. Above it, the customer tops up."
            inputMode="numeric"
            autoComplete="off"
            value={form.drink_value_inr}
            onChange={(e) => set({ drink_value_inr: e.target.value })}
          />
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-[10rem] flex-1">
              <Input
                label="Price (₹)"
                hint={
                  preview.suggested !== null
                    ? `Suggested ${formatRupees(preview.suggested)}: cups paid for × cup value.`
                    : 'Fill in the cups and the cup value to see a suggestion.'
                }
                inputMode="numeric"
                autoComplete="off"
                value={formPriceText(form)}
                onChange={(e) => setForm((f) => withTypedPrice(f, e.target.value))}
              />
            </div>
            {canUseSuggestedPrice(form) ? (
              <Button variant="secondary" onClick={() => setForm((f) => withSuggestedPrice(f))}>
                Use suggested price
              </Button>
            ) : null}
          </div>

          {/* Live: what one cup costs and how much cheaper that is. */}
          <div aria-live="polite" className="rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
            {preview.perCup !== null && preview.price !== null ? (
              <p>
                <span className="font-mono font-bold tabular-nums">{formatRupees(preview.perCup)}</span> per cup
                {preview.discountPercent !== null && preview.discountPercent > 0 ? (
                  <>
                    {' · '}
                    <span className="font-mono font-bold tabular-nums">{preview.discountPercent}%</span> cheaper than the cups&apos; value
                    {preview.worth !== null ? <> ({formatRupees(preview.worth)})</> : null}
                  </>
                ) : preview.discountPercent === 0 ? (
                  ' · no discount'
                ) : null}
              </p>
            ) : (
              <p className="text-muted">The price per cup shows here once the boxes above are filled in.</p>
            )}
            {preview.warning ? (
              <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-amber-900">
                {preview.warning}
              </p>
            ) : null}
          </div>
        </div>

        <Input
          label="Daily limit (optional)"
          hint="Most cups usable in one day. Leave empty for no limit; 1 makes it a coffee a day."
          inputMode="numeric"
          autoComplete="off"
          value={form.max_per_day}
          onChange={(e) => set({ max_per_day: e.target.value })}
        />

        <div className="flex flex-col gap-3 rounded-md border border-line px-4 py-3">
          <div className="flex min-h-[44px] items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-charcoal">GST exempt</p>
              <p className="text-sm text-muted">Only if your CA says this plan is not taxed when sold.</p>
            </div>
            <ToggleSwitch checked={form.gst_exempt} onChange={(v) => set({ gst_exempt: v })} label="GST exempt" />
          </div>
          <div className="flex min-h-[44px] items-center justify-between gap-4 border-t border-line pt-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-charcoal">On sale</p>
              <p className="text-sm text-muted">
                {form.is_active ? 'Customers can buy this.' : 'Switched off: customers cannot buy this yet.'}
              </p>
            </div>
            <ToggleSwitch checked={form.is_active} onChange={(v) => set({ is_active: v })} label="On sale" />
          </div>
        </div>

        {plan ? (
          <p className="text-sm text-muted">
            Changes apply to new sales only. Rituals already sold keep the terms they were sold with.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
