export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16" role="status">
      <span
        aria-hidden="true"
        className="h-8 w-8 animate-spin rounded-full border-2 border-[#e5e5e5] border-t-tan"
      />
      <span aria-label={label} className="text-sm text-muted">
        {label}
      </span>
    </div>
  );
}
