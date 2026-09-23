'use client';

// One modal for all three shortage decisions (docs/PHASE-5-CASH-COUNTS.md
// CC-D4) — approve, waive, reassign — parameterized by `action` rather than
// three near-identical modals, since the only real difference is which
// fields show and whether the note is required.

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import type { ActiveStaffOption, OwnerShortageRow } from './types';
import { rupees } from './types';

export type ShortageAction = 'approve' | 'waive' | 'reassign';

const TITLES: Record<ShortageAction, string> = {
  approve: 'Approve shortage',
  waive: 'Waive shortage',
  reassign: 'Reassign shortage',
};

interface ShortageDecisionModalProps {
  shortage: OwnerShortageRow | null;
  action: ShortageAction | null;
  staffOptions: ActiveStaffOption[];
  onClose: () => void;
  onDone: (updated: OwnerShortageRow) => void;
}

export function ShortageDecisionModal({ shortage, action, staffOptions, onClose, onDone }: ShortageDecisionModalProps) {
  const [note, setNote] = useState('');
  const [reassignTo, setReassignTo] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Re-seed on every open — the same object/action pair never opens twice in
  // a row without a close in between.
  useEffect(() => {
    setNote('');
    setReassignTo('');
    setError('');
  }, [shortage, action]);

  if (!shortage || !action) return null;

  const noteRequired = action !== 'approve';
  const reassignChoices = staffOptions.filter((s) => s.id !== shortage.userId);

  async function submit() {
    if (!shortage || !action) return;
    if (noteRequired && !note.trim()) {
      setError('A note is required.');
      return;
    }
    if (action === 'reassign' && !reassignTo) {
      setError('Pick who to reassign this to.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const body =
        action === 'approve'
          ? { action: 'approve', ...(note.trim() ? { note: note.trim() } : {}) }
          : action === 'waive'
            ? { action: 'waive', note: note.trim() }
            : { action: 'reassign', userId: reassignTo, note: note.trim() };
      const res = await fetch(`/api/owner/cash-shortages/${shortage.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not update this shortage.');
      onDone(data.shortage as OwnerShortageRow);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this shortage.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={TITLES[action]}
      footer={
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" loading={submitting} onClick={submit} variant={action === 'waive' ? 'danger' : 'primary'}>
            {TITLES[action]}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-charcoal">
          {shortage.originalUserName}&apos;s count on {shortage.businessDate} was short{' '}
          <strong>{rupees(shortage.amountInr)}</strong>.
        </p>

        {action === 'reassign' ? (
          <Select
            label="Reassign to"
            value={reassignTo}
            onChange={(e) => setReassignTo(e.target.value)}
            placeholder="Choose a team member"
            options={reassignChoices.map((s) => ({ value: s.id, label: s.name }))}
          />
        ) : null}

        <Textarea
          label={noteRequired ? 'Note (required)' : 'Note (optional)'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder={
            action === 'waive'
              ? 'Why this shortage is being waived'
              : action === 'reassign'
                ? 'Why this belongs to someone else'
                : undefined
          }
        />

        {error ? (
          <p role="alert" className="text-sm font-bold text-red-700">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
