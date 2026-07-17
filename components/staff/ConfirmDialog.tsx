export function ConfirmDialog({
  heading,
  body,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: {
  heading: string;
  body: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 bg-charcoal/50"
      />
      <div className="relative w-full max-w-sm rounded-md bg-cream p-6 shadow-sm">
        <h3 className="text-lg font-bold text-charcoal">{heading}</h3>
        <p className="mt-2 text-sm text-muted">{body}</p>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal hover:border-tan"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-md border border-charcoal px-4 py-2 text-sm font-bold text-charcoal hover:bg-charcoal hover:text-cream"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
