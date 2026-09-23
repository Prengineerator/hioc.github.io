'use client';

// One team member, rendered as a table-ish row at sm+ and a stacked card
// below it (two markup blocks toggled by Tailwind breakpoints, rather than
// one grid trying to reflow itself — simpler to get right at 360px).

import { useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { loginEmailFor, type TeamMember } from '@/lib/staff/accounts';
import { formatLastSignIn, roleBadgeVariant, roleLabel } from './shared';

export interface MemberRowProps {
  member: TeamMember;
  busy?: boolean;
  onEdit: (member: TeamMember) => void;
  onPassword: (member: TeamMember) => void;
  onDeactivate: (member: TeamMember) => void;
  onReactivate: (member: TeamMember) => void;
  onDelete: (member: TeamMember) => void;
}

function PersonalEmailCell({ email }: { email: string | null }) {
  if (email) return <p className="truncate text-sm text-charcoal">{email}</p>;
  return (
    <p className="flex items-start gap-1 text-xs font-medium text-amber-900">
      <span aria-hidden="true">⚠</span>
      <span>No personal email — reset links and payslips can&apos;t reach them</span>
    </p>
  );
}

export function MemberRow({ member, busy, onEdit, onPassword, onDeactivate, onReactivate, onDelete }: MemberRowProps) {
  const isOwner = member.role === 'owner';
  const loginEmail = member.loginId ? loginEmailFor(member.loginId) : member.email;
  const label = roleLabel(member.role);
  const lastSignIn = formatLastSignIn(member.lastSignInAt);

  const actions = isOwner ? (
    <span className="text-xs text-muted">—</span>
  ) : (
    <RowActionsMenu
      member={member}
      busy={busy}
      onEdit={onEdit}
      onPassword={onPassword}
      onDeactivate={onDeactivate}
      onReactivate={onReactivate}
      onDelete={onDelete}
    />
  );

  return (
    <li className="border-b border-line py-3 last:border-b-0">
      {/* sm+: single row */}
      <div className="hidden sm:grid sm:grid-cols-[1.4fr_1.4fr_0.9fr_1fr_auto] sm:items-center sm:gap-3">
        <div className="min-w-0">
          <p className="truncate font-bold text-charcoal">{member.name || '(no name)'}</p>
          <p className="truncate text-xs text-muted">{loginEmail}</p>
        </div>
        <PersonalEmailCell email={member.personalEmail} />
        <div>
          <Badge variant={roleBadgeVariant(member.role)}>{label}</Badge>
        </div>
        <p className="text-sm text-muted">{lastSignIn}</p>
        <div className="flex justify-end">{actions}</div>
      </div>

      {/* below sm: card */}
      <div className="flex flex-col gap-2 sm:hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-bold text-charcoal">{member.name || '(no name)'}</p>
            <p className="truncate text-xs text-muted">{loginEmail}</p>
          </div>
          {actions}
        </div>
        <PersonalEmailCell email={member.personalEmail} />
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={roleBadgeVariant(member.role)}>{label}</Badge>
          <span className="text-xs text-muted">Last sign-in: {lastSignIn}</span>
        </div>
      </div>
    </li>
  );
}

interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function RowActionsMenu({ member, busy, onEdit, onPassword, onDeactivate, onReactivate, onDelete }: MemberRowProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const items: MenuItem[] = [
    { label: 'Edit', onClick: () => onEdit(member) },
    { label: 'Password', onClick: () => onPassword(member) },
  ];
  if (member.status === 'active') {
    items.push({ label: 'Deactivate', onClick: () => onDeactivate(member) });
  } else {
    items.push({ label: 'Reactivate', onClick: () => onReactivate(member) });
  }
  if (member.deletable) {
    items.push({ label: 'Delete', danger: true, onClick: () => onDelete(member) });
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Actions for ${member.name || 'this member'}`}
        disabled={busy}
        onClick={() => setOpen((v) => !v)}
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md text-charcoal transition-colors hover:bg-surface disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
      >
        <span aria-hidden="true" className="text-lg leading-none">
          {busy ? '…' : '⋯'}
        </span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-full z-20 mt-1 min-w-[170px] overflow-hidden rounded-md border border-line bg-cream py-1 shadow-elevated"
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                item.onClick();
              }}
              className={
                'block min-h-[40px] w-full px-4 py-2 text-left text-sm font-medium transition-colors hover:bg-surface ' +
                (item.danger ? 'text-red-700' : 'text-charcoal')
              }
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
