'use client';

// A manager changes a HIOC Ritual (CP-D16): extend it by whole days, or give cups
// back (a spilt coffee on a fully covered order). Every change needs a reason and
// is audited by the API; nobody can take cups away except by spending them. The
// bounds are the ones POST /api/passes/[id]/adjust checks, so the form and the
// route cannot disagree — and the route (403 without `pass_manage`) is the real
// guard: its message is shown as it is.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { PASS_PROGRAM_NAME, cupsLabel } from '@/lib/passes/brand';
import { passTitle } from '@/lib/passes/ritualDrinks';
import type { PassSummary } from '@/lib/passes/types';
import {
  CREDIT_REASON_CHIPS,
  EXTEND_REASON_CHIPS,
  MAX_EXTEND_DAYS,
  MAX_REASON_LENGTH,
  extendedTillLabel,
  parseCreditCups,
  parseExtendDays,
  passValidityLabel,
  validateCredit,
  validateExtend,
  type HolderPass,
} from '@/lib/pos/ritual';

export type AdjustKind = 'extend' | 'credit';

export function AdjustPassDialog({
  pass,
  kind,
  onClose,
  onDone,
}: {
  pass: HolderPass;
  kind: AdjustKind;
  onClose: () => void;
  /** The change is saved: the pass as it is now, and a line to tell the staffer. */
  onDone: (pass: PassSummary, message: string) => void;
}) {
  const extend = kind === 'extend';
  const [amount, setAmount] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const maxCups = Math.max(1, pass.drinks_total);
  const parsed = extend ? validateExtend(amount, reason) : validateCredit(amount, reason, maxCups);
  const days = extend ? parseExtendDays(amount) : null;
  const cups = extend ? null : parseCreditCups(amount, maxCups);
  const chips = extend ? EXTEND_REASON_CHIPS : CREDIT_REASON_CHIPS;

  async function submit() {
    if (!parsed.ok || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/passes/${pass.id}/adjust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.value),
      });
      const data = (await res.json().catch(() => null)) as { pass?: PassSummary; error?: string } | null;
      if (!res.ok || !data?.pass) {
        setError(data?.error ?? 'Could not save the change. Try again.');
        return;
      }
      onDone(
        data.pass,
        parsed.value.kind === 'extend'
          ? `${passTitle(pass)} extended by ${parsed.value.days} ${parsed.value.days === 1 ? 'day' : 'days'}.`
          : `Gave back ${cupsLabel(parsed.value.drinks)} on ${passTitle(pass)}.`,
      );
    } catch {
      setError('Could not reach the server. Check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onClose}
      title={extend ? `Extend ${passTitle(pass)}` : `Give back a cup · ${passTitle(pass)}`}
      subtitle={`${PASS_PROGRAM_NAME} · ${passValidityLabel(pass)}`}
      size="sm"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!parsed.ok} loading={busy}>
            {extend
              ? days
                ? `Extend by ${days} ${days === 1 ? 'day' : 'days'}`
                : 'Extend'
              : cups
                ? `Give back ${cupsLabel(cups)}`
                : 'Give back'}
          </Button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input
          label={extend ? `Days to add (1 to ${MAX_EXTEND_DAYS})` : `Cups to give back (1 to ${maxCups})`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
          disabled={busy}
          hint={
            extend
              ? days
                ? `New last day: ${extendedTillLabel(pass.expires_at, days)}`
                : 'It keeps ending at midnight, IST.'
              : 'The cups are added back to this Ritual.'
          }
        />

        <div className="flex flex-col gap-2">
          <Input
            label="Reason (kept in the audit trail)"
            type="text"
            autoComplete="off"
            maxLength={MAX_REASON_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={busy}
            placeholder="Why is this being changed?"
          />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick reasons">
            {chips.map((chip) => (
              <button
                key={chip}
                type="button"
                disabled={busy}
                onClick={() => setReason(chip)}
                className="min-h-[44px] rounded-full border border-line px-4 text-sm font-bold text-charcoal hover:border-tan"
              >
                {chip}
              </button>
            ))}
          </div>
        </div>

        {error ? (
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800">
            {error}
          </p>
        ) : null}
        {/* Enter submits from the text fields. */}
        <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
      </form>
    </Modal>
  );
}
