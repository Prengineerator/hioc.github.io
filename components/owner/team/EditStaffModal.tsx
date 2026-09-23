'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import {
  LOGIN_DOMAIN,
  loginEmailFor,
  normalizeLoginId,
  normalizePersonalEmail,
  type ManageableRole,
  type TeamMember,
  type UpdateStaffBody,
} from '@/lib/staff/accounts';

interface EditStaffModalProps {
  member: TeamMember | null;
  onClose: () => void;
  onUpdated: (member: TeamMember, loginIdChanged: boolean) => void;
}

export function EditStaffModal({ member, onClose, onUpdated }: EditStaffModalProps) {
  const [name, setName] = useState('');
  const [loginIdRaw, setLoginIdRaw] = useState('');
  const [personalEmailRaw, setPersonalEmailRaw] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<ManageableRole>('staff');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [touched, setTouched] = useState(false);

  // Re-seed the form whenever a different member is opened for editing (the
  // parent hands us a fresh `member` object each time; it doesn't change
  // while this modal is open).
  useEffect(() => {
    if (!member) return;
    setName(member.name ?? '');
    setLoginIdRaw(member.loginId ?? '');
    setPersonalEmailRaw(member.personalEmail ?? '');
    setPhone(member.phone ?? '');
    setRole(member.role === 'manager' ? 'manager' : 'staff');
    setFormError('');
    setTouched(false);
  }, [member]);

  if (!member) return null;

  const normalizedLoginId = normalizeLoginId(loginIdRaw);
  const loginIdError =
    touched && loginIdRaw.trim() && !normalizedLoginId
      ? 'Lowercase letters, digits, dot, underscore or hyphen — must start with a letter.'
      : '';
  const loginIdChanged = Boolean(normalizedLoginId) && normalizedLoginId !== (member.loginId ?? '');

  const normalizedPersonalEmail = personalEmailRaw.trim() ? normalizePersonalEmail(personalEmailRaw) : null;
  const personalEmailError =
    touched && personalEmailRaw.trim() && !normalizedPersonalEmail
      ? `Enter a real email address (not an @${LOGIN_DOMAIN} login ID).`
      : '';

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setTouched(true);
    setFormError('');
    if (!member) return;

    if (!name.trim()) return setFormError('Enter a name.');
    if (loginIdRaw.trim() && !normalizedLoginId) return setFormError('Enter a valid login ID.');
    if (personalEmailRaw.trim() && !normalizedPersonalEmail) return setFormError('Enter a valid personal email.');

    setSubmitting(true);
    try {
      const body: UpdateStaffBody = { name: name.trim(), role, phone: phone.trim() };
      if (normalizedLoginId) body.loginId = normalizedLoginId;
      if (normalizedPersonalEmail) body.personalEmail = normalizedPersonalEmail;

      const res = await fetch(`/api/owner/staff/${member.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not update staff member.');
      onUpdated(data.member as TeamMember, loginIdChanged);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not update staff member.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${member.name || 'staff member'}`}
      footer={
        <div className="flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="edit-staff-form" loading={submitting}>
            Save changes
          </Button>
        </div>
      }
    >
      <form id="edit-staff-form" onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} autoFocus required />
        <Input
          label="Login ID"
          value={loginIdRaw}
          onChange={(e) => setLoginIdRaw(e.target.value)}
          onBlur={() => setTouched(true)}
          error={loginIdError}
          hint={!loginIdError && normalizedLoginId ? `Signs in as ${loginEmailFor(normalizedLoginId)}` : undefined}
        />
        {loginIdChanged ? (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            {member.name || 'This staffer'} must sign in with the new login ID next time — the old one stops working
            as soon as you save.
          </p>
        ) : null}
        <Input
          label="Personal email"
          type="email"
          value={personalEmailRaw}
          onChange={(e) => setPersonalEmailRaw(e.target.value)}
          onBlur={() => setTouched(true)}
          error={personalEmailError}
          hint={!personalEmailError ? `Where reset links and payslips go — not the @${LOGIN_DOMAIN} login.` : undefined}
        />
        <Input label="Phone (optional)" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <Select
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value as ManageableRole)}
          options={[
            { value: 'staff', label: 'Staff' },
            { value: 'manager', label: 'Manager' },
          ]}
        />
        {formError ? (
          <p role="alert" className="text-sm font-bold text-red-700">
            {formError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}
