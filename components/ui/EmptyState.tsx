export function EmptyState({
  heading,
  body,
}: {
  heading: string;
  body: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-[#e5e5e5] bg-cream px-6 py-16 text-center">
      <span aria-hidden="true" className="text-3xl">
        ☕
      </span>
      <h3 className="text-lg font-bold text-charcoal">{heading}</h3>
      <p className="text-sm text-muted">{body}</p>
    </div>
  );
}
