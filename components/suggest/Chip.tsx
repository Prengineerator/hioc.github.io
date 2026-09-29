'use client';

// A toggle-button chip (COFFEY-SPEC §1, step 2). Used for both single-select
// groups (hot or iced, coffee, texture, budget — the caller enforces "only one
// pressed" by swapping the whole group's value) and multi-select groups (what
// you'd like, flavours — the caller toggles membership in an array). Either way
// each chip is its own real toggle button with aria-pressed, never a hidden
// radio/checkbox, per the ticket's accessibility note.

export function Chip({
  label,
  icon,
  pressed,
  onClick,
}: {
  label: string;
  icon?: string;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={
        'inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-4 py-2 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
        (pressed
          ? 'border-tan bg-tan-dark text-cream'
          : 'border-line text-charcoal hover:border-tan hover:text-tan-dark')
      }
    >
      {icon ? (
        <span aria-hidden="true">{icon}</span>
      ) : null}
      {label}
    </button>
  );
}
