'use client';

// Owner Team screen (docs/PHASE-5-STAFF-ACCOUNTS.md, "Owner portal"). Talks
// only to the /api/owner/staff contract in lib/staff/accounts.ts — this file
// owns display + interaction, not the account rules (those live server-side).
//
// No optimistic UI: every mutation just refetches the list, per the ticket.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/staff/ConfirmDialog';
import type { EmailOutcome, TeamMember } from '@/lib/staff/accounts';
import { AddStaffModal } from './team/AddStaffModal';
import { EditStaffModal } from './team/EditStaffModal';
import { PasswordModal } from './team/PasswordModal';
import { PinModal } from './team/PinModal';
import { MemberRow } from './team/MemberRow';
import { passwordToast, type ToastState } from './team/shared';

type ConfirmAction = { type: 'deactivate' | 'delete'; member: TeamMember };

export function TeamManager() {
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);

  const [showAdd, setShowAdd] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [passwordMember, setPasswordMember] = useState<TeamMember | null>(null);
  const [pinMember, setPinMember] = useState<TeamMember | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deactivatedOpen, setDeactivatedOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch('/api/owner/staff', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load team');
      setMembers((data.members ?? []) as TeamMember[]);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const active = useMemo(() => members.filter((m) => m.status === 'active'), [members]);
  const deactivated = useMemo(() => members.filter((m) => m.status === 'deactivated'), [members]);

  function handleCreated(member: TeamMember, mode: 'link' | 'set', email?: EmailOutcome) {
    setShowAdd(false);
    setToast(passwordToast(member.personalEmail || 'their personal email', mode, email));
    void load();
  }

  function handleUpdated(member: TeamMember, loginIdChanged: boolean) {
    setEditingMember(null);
    setToast({
      tone: 'success',
      text: loginIdChanged
        ? `${member.name || 'Member'} updated — they sign in with the new login ID next time.`
        : `${member.name || 'Member'} updated.`,
    });
    void load();
  }

  function handlePasswordDone(member: TeamMember, mode: 'link' | 'set', email?: EmailOutcome) {
    setPasswordMember(null);
    setToast(passwordToast(member.personalEmail || 'their personal email', mode, email));
    void load();
  }

  function handlePinDone(member: TeamMember) {
    setPinMember(null);
    setToast({ tone: 'success', text: `PIN set for ${member.name || 'this member'}.` });
  }

  async function handleDeactivate(member: TeamMember) {
    setConfirmAction(null);
    setBusyId(member.id);
    try {
      const res = await fetch(`/api/owner/staff/${member.id}/deactivate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not deactivate.');
      setToast({ tone: 'success', text: `${member.name || 'Member'} deactivated — their login is blocked.` });
      await load();
    } catch (err) {
      setToast({ tone: 'warning', text: err instanceof Error ? err.message : 'Could not deactivate.' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleReactivate(member: TeamMember) {
    setBusyId(member.id);
    try {
      const res = await fetch(`/api/owner/staff/${member.id}/reactivate`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not reactivate.');
      setToast({ tone: 'success', text: `${member.name || 'Member'} reactivated.` });
      await load();
    } catch (err) {
      setToast({ tone: 'warning', text: err instanceof Error ? err.message : 'Could not reactivate.' });
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(member: TeamMember) {
    setConfirmAction(null);
    setBusyId(member.id);
    try {
      const res = await fetch(`/api/owner/staff/${member.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not delete.');
      setToast({ tone: 'success', text: `${member.name || 'Member'} deleted.` });
      await load();
    } catch (err) {
      setToast({ tone: 'warning', text: err instanceof Error ? err.message : 'Could not delete.' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-cream p-5 shadow-card">
        <div>
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Team</h2>
          <p className="mt-1 text-sm text-muted">
            Staff sign in with an @hioc.in login ID — a personal email is where reset links and payslips go.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>Add staff</Button>
      </div>

      {loadError ? <p className="text-sm font-bold text-red-700">{loadError}</p> : null}

      <div className="rounded-md border border-line bg-cream p-5 shadow-card">
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : active.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No active team members yet.</p>
        ) : (
          <ul>
            {active.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                busy={busyId === m.id}
                onEdit={setEditingMember}
                onPassword={setPasswordMember}
                onPin={setPinMember}
                onDeactivate={(mem) => setConfirmAction({ type: 'deactivate', member: mem })}
                onReactivate={handleReactivate}
                onDelete={(mem) => setConfirmAction({ type: 'delete', member: mem })}
              />
            ))}
          </ul>
        )}
      </div>

      {!loading && deactivated.length > 0 ? (
        <div className="rounded-md border border-line bg-cream p-5 shadow-card">
          <button
            type="button"
            onClick={() => setDeactivatedOpen((v) => !v)}
            aria-expanded={deactivatedOpen}
            className="flex min-h-[40px] w-full items-center justify-between text-left text-sm font-bold uppercase tracking-wide text-muted"
          >
            <span>Deactivated ({deactivated.length})</span>
            <span aria-hidden="true">{deactivatedOpen ? '▲' : '▼'}</span>
          </button>
          {deactivatedOpen ? (
            <ul className="mt-3">
              {deactivated.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  busy={busyId === m.id}
                  onEdit={setEditingMember}
                  onPassword={setPasswordMember}
                  onPin={setPinMember}
                  onDeactivate={(mem) => setConfirmAction({ type: 'deactivate', member: mem })}
                  onReactivate={handleReactivate}
                  onDelete={(mem) => setConfirmAction({ type: 'delete', member: mem })}
                />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <AddStaffModal open={showAdd} onClose={() => setShowAdd(false)} onCreated={handleCreated} />
      <EditStaffModal member={editingMember} onClose={() => setEditingMember(null)} onUpdated={handleUpdated} />
      <PasswordModal member={passwordMember} onClose={() => setPasswordMember(null)} onDone={handlePasswordDone} />
      <PinModal member={pinMember} onClose={() => setPinMember(null)} onDone={handlePinDone} />

      {confirmAction?.type === 'deactivate' ? (
        <ConfirmDialog
          heading={`Deactivate ${confirmAction.member.name || 'this member'}?`}
          body="Their login is blocked immediately. Attendance, payroll and order history is kept, and you can reactivate them anytime."
          confirmLabel="Deactivate"
          onConfirm={() => handleDeactivate(confirmAction.member)}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}
      {confirmAction?.type === 'delete' ? (
        <ConfirmDialog
          heading={`Delete ${confirmAction.member.name || 'this member'}?`}
          body="This permanently removes their account. Only offered because they have no attendance, payroll or order history."
          confirmLabel="Delete"
          onConfirm={() => handleDelete(confirmAction.member)}
          onCancel={() => setConfirmAction(null)}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          className={
            'fixed inset-x-4 bottom-[calc(1rem+env(safe-area-inset-bottom))] z-[60] mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-md px-4 py-2 text-center text-sm shadow-lg sm:inset-x-auto sm:left-1/2 sm:-translate-x-1/2 ' +
            (toast.tone === 'success'
              ? 'bg-charcoal text-cream'
              : 'border border-amber-300 bg-amber-50 text-amber-900')
          }
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
