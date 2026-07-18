const SIZE_CLASSES = { sm: 'h-5 w-5', md: 'h-8 w-8' } as const;

export function Spinner({
  label = 'Loading…',
  size = 'md',
}: {
  label?: string;
  size?: keyof typeof SIZE_CLASSES;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16" role="status">
      <span
        aria-hidden="true"
        className={`animate-spin rounded-full border-2 border-line border-t-tan ${SIZE_CLASSES[size]}`}
      />
      <span aria-label={label} className="text-sm text-muted">
        {label}
      </span>
    </div>
  );
}
