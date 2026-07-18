'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';

interface Member {
  id: string;
  role: string;
  name: string;
  email: string;
  isSelf: boolean;
}

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  manager: 'Manager',
  staff: 'Staff',
};

export function TeamManager() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'staff' | 'manager'>('staff');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/owner/staff', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load team');
      setMembers(data.members ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load team');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setNotice('');
    setSubmitting(true);
    try {
      const res = await fetch('/api/owner/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to add team member');
      setNotice(`${email.trim()} is now ${ROLE_LABEL[role] ?? role}. They can sign in with this email.`);
      setEmail('');
      setRole('staff');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add team member');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRemove(m: Member) {
    if (!confirm(`Remove ${m.email || m.name || 'this member'}'s ${ROLE_LABEL[m.role] ?? m.role} access?`)) {
      return;
    }
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/staff', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: m.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to remove member');
      setNotice(`${m.email || m.name || 'Member'} removed from the team.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Add form */}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-muted">Add a team member</h2>
        <p className="mb-4 text-sm text-muted">
          Enter their email. If they don&apos;t have an account yet, one is created — they sign in with
          the normal email code (OTP). Owners are still managed via SQL.
        </p>
        <form onSubmit={handleAdd} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="name@example.com"
              className="rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as 'staff' | 'manager')}
              className="rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-charcoal outline-none focus:border-tan"
            >
              <option value="staff">Staff</option>
              <option value="manager">Manager</option>
            </select>
          </label>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-charcoal px-5 py-2 text-sm font-bold text-cream transition-colors hover:opacity-90 disabled:opacity-50"
          >
            {submitting ? 'Adding…' : 'Add member'}
          </button>
        </form>
        {error ? <p className="mt-3 text-sm font-medium text-red-700">{error}</p> : null}
        {notice ? <p className="mt-3 text-sm font-medium text-[#2f6b38]">{notice}</p> : null}
      </div>

      {/* Members table */}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-muted">Team members</h2>
        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Loading…</p>
        ) : members.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No team members yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase text-muted">
                  <th className="py-1 font-bold">Member</th>
                  <th className="py-1 font-bold">Role</th>
                  <th className="py-1 text-right font-bold">Access</th>
                </tr>
              </thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id} className="border-b border-[#f2efe9]">
                    <td className="py-2 text-charcoal">
                      {m.email || '—'}
                      {m.name ? <span className="block text-xs text-muted">{m.name}</span> : null}
                    </td>
                    <td className="py-2">
                      <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-xs font-bold text-charcoal">
                        {ROLE_LABEL[m.role] ?? m.role}
                      </span>
                      {m.isSelf ? <span className="ml-2 text-xs text-muted">you</span> : null}
                    </td>
                    <td className="py-2 text-right">
                      {m.isSelf || m.role === 'owner' ? (
                        <span className="text-xs text-muted">—</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleRemove(m)}
                          className="text-sm font-medium text-red-700 hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
