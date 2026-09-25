'use client';

// PIN-5 — owner sets/resets a staff member's counter PIN. Mirrors
// PasswordModal's shape (this file, EditStaffModal, PasswordModal are all the
// same pattern): a form while nothing has happened yet, then a one-time
// result screen. The PIN is shown here ONCE — this component's own state is
// the only place it will ever exist outside the (bcrypt-hashed) database row.

import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import type { TeamMember } from '@/lib/staff/accounts';

interface PinModalProps {
  member: TeamMember | null;
  onClose: () => void;
  onDone: (member: TeamMember) => void;
}

export function PinModal({ member, onClose, onDone }: PinModalProps) {
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [result, setResult] = useState<{ pin: string; action: 'set' | 'reset' } | null>(null);

  useEffect(() => {
    if (!member) return;
    setPin('');
    setFormError('');
    setResult(null);
  }, [member]);

  if (!member) return null;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!member) return;
    setFormError('');

    if (pin && !/^\d{4}$/.test(pin)) {
      setFormError('PIN must be exactly 4 digits, or leave it blank to generate one.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`/api/owner/staff/${member.id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pin ? { pin } : {}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not set the PIN.');
      setResult({ pin: data.pin as string, action: data.action as 'set' | 'reset' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not set the PIN.');
    } finally {
      setSubmitting(false);
    }
  }

  function handleFinish() {
    if (member) onDone(member);
  }

  return (
    <Modal
      open
      onClose={result ? handleFinish : onClose}
      title={`PIN — ${member.name || 'staff member'}`}
      size="sm"
      footer={
        result ? (
          <div className="flex justify-end">
            <Button onClick={handleFinish}>Done</Button>
          </div>
        ) : (
          <div className="flex justify-end gap-3">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" form="pin-form" loading={submitting}>
              Save
            </Button>
          </div>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-charcoal">
            {result.action === 'set' ? 'PIN set' : 'PIN reset'} for {member.name || 'this member'}. Tell them
            now — this is the only time it will be shown.
          </p>
          <p className="text-center text-4xl font-bold tracking-[0.3em] font-mono tabular-nums text-charcoal">
            {result.pin}
          </p>
          <p className="text-xs text-muted">
            They&apos;ll use this to unlock the till on an enrolled counter. It is never stored in a way anyone
            — including you — can look up again; reset it here if they forget it.
          </p>
        </div>
      ) : (
        <form id="pin-form" onSubmit={handleSubmit} className="flex flex-col gap-3">
          {formError ? (
            <p role="alert" className="text-sm font-semibold text-red-700">
              {formError}
            </p>
          ) : null}
          <Input
            label="PIN (optional)"
            inputMode="numeric"
            maxLength={4}
            placeholder="Leave blank to generate one"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            hint="4 digits. Leave blank and one will be generated for you. Obvious PINs (0000, 1234, a birth year) are refused."
          />
        </form>
      )}
    </Modal>
  );
}
