import type { ReactNode } from 'react';

export function EmptyState({
  heading,
  body,
  icon = '☕',
  action,
}: {
  heading: string;
  body: string;
  /**
   * Shown above the heading; defaults to the brand's coffee cup. Pass an inline
   * SVG, or an empty string / null for no icon at all (the customer pages drop
   * it: an emoji used as an icon reads as filler, not as design).
   */
  icon?: ReactNode;
  /** Optional call-to-action rendered below the body copy (e.g. a <Button> or <Link>). */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-line bg-cream px-6 py-16 text-center">
      {icon ? (
        <span aria-hidden="true" className="text-3xl">
          {icon}
        </span>
      ) : null}
      <h3 className="text-lg font-semibold text-charcoal">{heading}</h3>
      <p className="text-sm text-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
