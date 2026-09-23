'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { MIN_PASSWORD_LENGTH, passwordProblem, type EmailOutcome, type PasswordBody, type TeamMember } from '@/lib/staff/accounts';

interface PasswordModalProps {
  member: TeamMember | null;
  onClose: () => void;
  onDone: (member: TeamMember, mode: 'link' | 'set', email?: EmailOutcome) => void;
}

export function PasswordModal({ member, onClose, onDone }: PasswordModalProps) {
  const [mode, setMode] = useState<'link' | 'set'>('link');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!member) return;
    setMode(member.personalEmail ? 'link' : 'set');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setFormError('');
    setTouched(false);
  }, [member]);

  if (!member) return null;

  const canEmailLink = Boolean(member.personalEmail);
  const pwProblem = mode === 'set' ? passwordProblem(password) : null;
  const confirmMismatch = mode === 'set' && confirmPassword.length > 0 && confirmPassword !== password;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    setFormError('');
    if (!member) return;

    if (mode === 'link' && !canEmailLink) return setFormError('Add a personal email before emailing a reset link.');
    if (mode === 'set') {
      const problem = passwordProblem(password);
      if (problem) return setFormError(problem);
      if (password !== confirmPassword) return setFormError('Passwords do not match.');
    }

    setSubmitting(true);
    try {
      const body: PasswordBody = mode === 'link' ? { mode: 'link' } : { mode: 'set', password };
      const res = await fetch(`/api/owner/staff/${member.id}/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not update the password.');
      onDone(data.member as TeamMember, mode, data.email as EmailOutcome | undefined);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not update the password.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Password — ${member.name || 'staff member'}`}
      size="sm"
      footer={
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="password-form" loading={submitting}>
            Save
          </Button>
        </div>
      }
    >
      <form id="password-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">Password action</legend>
          <label
            className={
              'flex min-h-[40px] items-center gap-2 text-sm ' +
              (canEmailLink ? 'text-charcoal' : 'text-muted')
            }
          >
            <input
              type="radio"
              name="password-mode"
              checked={mode === 'link'}
              disabled={!canEmailLink}
              onChange={() => setMode('link')}
              className="h-4 w-4"
            />
            Email reset link
          </label>
          {!canEmailLink ? (
            <p className="pl-6 text-xs font-medium text-amber-900">
              Add a personal email first — there&apos;s nowhere to send it.
            </p>
          ) : null}
          <label className="flex min-h-[40px] items-center gap-2 text-sm text-charcoal">
            <input
              type="radio"
              name="password-mode"
              checked={mode === 'set'}
              onChange={() => setMode('set')}
              className="h-4 w-4"
            />
            Set new password
          </label>
          {mode === 'set' ? (
            <div className="flex flex-col gap-3 pl-6">
              <div className="relative">
                <Input
                  label="New password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onBlur={() => setTouched(true)}
                  error={touched && pwProblem ? pwProblem : undefined}
                  hint={!(touched && pwProblem) ? `At least ${MIN_PASSWORD_LENGTH} characters.` : undefined}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3 top-[34px] text-xs font-bold text-tan"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <Input
                label="Confirm password"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onBlur={() => setTouched(true)}
                error={confirmMismatch ? 'Passwords do not match.' : undefined}
              />
            </div>
          ) : null}
        </fieldset>
        {formError ? (
          <p role="alert" className="text-sm font-bold text-red-700">
            {formError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
