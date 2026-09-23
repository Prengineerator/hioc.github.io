'use client';

import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import {
  LOGIN_DOMAIN,
  MIN_PASSWORD_LENGTH,
  loginEmailFor,
  normalizeLoginId,
  normalizePersonalEmail,
  passwordProblem,
  type CreateStaffBody,
  type EmailOutcome,
  type ManageableRole,
  type TeamMember,
} from '@/lib/staff/accounts';

interface AddStaffModalProps {
  open: boolean;
  onClose: () => void;
  onCreated: (member: TeamMember, mode: 'link' | 'set', email?: EmailOutcome) => void;
}

const initialState = {
  name: '',
  loginIdRaw: '',
  personalEmailRaw: '',
  phone: '',
  role: 'staff' as ManageableRole,
  mode: 'link' as 'link' | 'set',
  password: '',
  confirmPassword: '',
};

export function AddStaffModal({ open, onClose, onCreated }: AddStaffModalProps) {
  const [state, setState] = useState(initialState);
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [touched, setTouched] = useState(false);

  function set<K extends keyof typeof initialState>(key: K, value: (typeof initialState)[K]) {
    setState((s) => ({ ...s, [key]: value }));
  }

  function reset() {
    setState(initialState);
    setShowPassword(false);
    setFormError('');
    setTouched(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  const normalizedLoginId = normalizeLoginId(state.loginIdRaw);
  const loginIdError =
    touched && state.loginIdRaw.trim() && !normalizedLoginId
      ? 'Lowercase letters, digits, dot, underscore or hyphen — must start with a letter.'
      : '';
  const previewId = normalizedLoginId || state.loginIdRaw.trim().toLowerCase() || '…';

  const normalizedPersonalEmail = normalizePersonalEmail(state.personalEmailRaw);
  const personalEmailError =
    touched && state.personalEmailRaw.trim() && !normalizedPersonalEmail
      ? `Enter a real email address (not an @${LOGIN_DOMAIN} login ID).`
      : '';

  const pwProblem = state.mode === 'set' ? passwordProblem(state.password) : null;
  const confirmMismatch =
    state.mode === 'set' && state.confirmPassword.length > 0 && state.confirmPassword !== state.password;

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    setFormError('');

    if (!state.name.trim()) return setFormError('Enter a name.');
    if (!normalizedLoginId) return setFormError('Enter a valid login ID.');
    if (!normalizedPersonalEmail) return setFormError('Enter a valid personal email.');
    if (state.mode === 'set') {
      const problem = passwordProblem(state.password);
      if (problem) return setFormError(problem);
      if (state.password !== state.confirmPassword) return setFormError('Passwords do not match.');
    }

    setSubmitting(true);
    try {
      const body: CreateStaffBody = {
        name: state.name.trim(),
        loginId: normalizedLoginId,
        personalEmail: normalizedPersonalEmail,
        phone: state.phone.trim() || undefined,
        role: state.role,
        passwordMode: state.mode,
        password: state.mode === 'set' ? state.password : undefined,
      };
      const res = await fetch('/api/owner/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not add staff member.');
      onCreated(data.member as TeamMember, state.mode, data.email as EmailOutcome | undefined);
      reset();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not add staff member.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Add staff"
      footer={
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" form="add-staff-form" loading={submitting}>
            Add staff
          </Button>
        </div>
      }
    >
      <form id="add-staff-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Name"
          value={state.name}
          onChange={(e) => set('name', e.target.value)}
          onBlur={() => setTouched(true)}
          autoFocus
          required
        />
        <Input
          label="Login ID"
          value={state.loginIdRaw}
          onChange={(e) => set('loginIdRaw', e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="ayush"
          error={loginIdError}
          hint={!loginIdError ? `Signs in as ${loginEmailFor(previewId)}` : undefined}
          required
        />
        <Input
          label="Personal email"
          type="email"
          value={state.personalEmailRaw}
          onChange={(e) => set('personalEmailRaw', e.target.value)}
          onBlur={() => setTouched(true)}
          placeholder="name@gmail.com"
          error={personalEmailError}
          hint={!personalEmailError ? `Where reset links and payslips go — not the @${LOGIN_DOMAIN} login.` : undefined}
          required
        />
        <Input
          label="Phone (optional)"
          type="tel"
          value={state.phone}
          onChange={(e) => set('phone', e.target.value)}
        />
        <Select
          label="Role"
          value={state.role}
          onChange={(e) => set('role', e.target.value as ManageableRole)}
          options={[
            { value: 'staff', label: 'Staff' },
            { value: 'manager', label: 'Manager' },
          ]}
        />

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-bold text-charcoal">First password</legend>
          <label className="flex min-h-[40px] items-center gap-2 text-sm text-charcoal">
            <input
              type="radio"
              name="add-staff-password-mode"
              checked={state.mode === 'link'}
              onChange={() => set('mode', 'link')}
              className="h-4 w-4"
            />
            Email a set-password link
          </label>
          <label className="flex min-h-[40px] items-center gap-2 text-sm text-charcoal">
            <input
              type="radio"
              name="add-staff-password-mode"
              checked={state.mode === 'set'}
              onChange={() => set('mode', 'set')}
              className="h-4 w-4"
            />
            Set a password now
          </label>
          {state.mode === 'set' ? (
            <div className="flex flex-col gap-3 pl-6">
              <div className="relative">
                <Input
                  label="Password"
                  type={showPassword ? 'text' : 'password'}
                  value={state.password}
                  onChange={(e) => set('password', e.target.value)}
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
                value={state.confirmPassword}
                onChange={(e) => set('confirmPassword', e.target.value)}
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
