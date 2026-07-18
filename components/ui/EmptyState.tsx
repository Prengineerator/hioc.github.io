import type { ReactNode } from 'react';

export function EmptyState({
  heading,
  body,
  icon = '☕',
  action,
}: {
  heading: string;
  body: string;
  /** Any single emoji/glyph shown above the heading; defaults to the brand's coffee cup. */
  icon?: string;
  /** Optional call-to-action rendered below the body copy (e.g. a <Button> or <Link>). */
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-line bg-cream px-6 py-16 text-center">
      <span aria-hidden="true" className="text-3xl">
        {icon}
      </span>
      <h3 className="text-lg font-bold text-charcoal">{heading}</h3>
      <p className="text-sm text-muted">{body}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
