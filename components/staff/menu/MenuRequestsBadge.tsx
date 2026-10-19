'use client';

// The pending-approval count on the staff header's Menu tab, as a button that
// opens the list of waiting requests (MenuRequestsPanel) instead of navigating.

export function MenuRequestsBadge({
  count,
  open,
  onClick,
  role,
  className = '',
}: {
  count: number;
  open: boolean;
  onClick: () => void;
  role?: 'menuitem';
  /** Sizes the tap area around the pill. */
  className?: string;
}) {
  const label = `${count} menu ${count === 1 ? 'change' : 'changes'} waiting for the owner`;
  return (
    <button
      type="button"
      role={role}
      onClick={onClick}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      className={`flex shrink-0 items-center justify-center ${className}`}
    >
      <span className="rounded-full bg-tan px-1.5 py-0.5 font-mono text-[11px] font-bold tabular-nums text-charcoal">
        {count}
      </span>
    </button>
  );
}
