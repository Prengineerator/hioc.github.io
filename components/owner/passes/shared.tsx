// Small presentational pieces shared by the HIOC Ritual owner sections: the
// card shell, a stat tile, and the inline error with a retry. No state, no
// fetching. Tokens only (docs: .claude/skills/code-revamp/SKILL.md).

import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';

/**
 * A section card, the same look as the owner dashboard's Card
 * (rounded-md border border-line bg-cream p-5) plus an actions slot beside the
 * title and an anchor id for the setup checklist's links. `scroll-mt-24` keeps
 * the heading clear of the sticky owner nav when an anchor scrolls to it.
 */
export function Section({
  id,
  title,
  description,
  actions,
  children,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 rounded-md border border-line bg-cream p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold uppercase tracking-wide text-charcoal">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** One number with its label: the same tile the Reports page uses. Money and counts are mono, right-aligned digits. */
export function StatTile({
  label,
  value,
  sub,
  emphasis,
}: {
  label: string;
  value: string;
  sub?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={`rounded-md border p-4 shadow-sm ${emphasis ? 'border-tan bg-surface' : 'border-line bg-cream'}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

/** A failed load or save, in words, with a retry when there is one. */
export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
    >
      <span>{message}</span>
      {onRetry ? (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
