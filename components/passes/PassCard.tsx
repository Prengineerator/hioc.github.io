import { SurfaceLink } from '@/components/SurfaceLink';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { PassDots } from '@/components/passes/PassDots';
import { passCoverLine, passTitle } from '@/lib/passes/ritualDrinks';
import {
  passDailyLimitLabel,
  passHistoryRow,
  passHistorySummary,
  passStateBadge,
  passValidityLine,
  type PassWithHistory,
} from '@/lib/passes/ui';

/**
 * One pass in "Your Ritual": its title (plan and drink, "Weekly Ritual · Cappuccino ·
 * Large"; just the plan for a pass from before per-drink pricing), state, what a cup
 * covers, the cups as dots, the date it is good till, and its history folded away. A pass that is no longer usable (used
 * up, expired, refunded) stays in the list but is quieter, so the active one is
 * what the eye lands on.
 */
export function PassCard({ pass }: { pass: PassWithHistory }) {
  const badge = passStateBadge(pass.state);
  const active = pass.state === 'active';
  const validity = passValidityLine(pass);
  const dailyLimit = active ? passDailyLimitLabel(pass.max_per_day) : null;
  const rows = pass.history.map(passHistoryRow);
  const cover = passCoverLine(pass);

  return (
    <Card padding="md" className={active ? '' : 'bg-surface/50'}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-bold text-charcoal">{passTitle(pass)}</h3>
        <Badge variant={badge.tone}>{badge.label}</Badge>
      </div>

      {cover ? (
        <p className="mt-1 text-sm text-charcoal">
          Each cup covers up to <span className="font-mono font-bold tabular-nums">₹{pass.drink_value_inr}</span>
        </p>
      ) : null}

      {pass.state === 'refunded' || pass.state === 'void' ? null : (
        <div className="mt-3">
          <PassDots pass={pass} />
        </div>
      )}

      {validity || dailyLimit ? (
        <p className="mt-2 text-sm text-muted">{[validity, dailyLimit].filter(Boolean).join(' · ')}</p>
      ) : null}

      {rows.length === 0 ? (
        <p className="mt-3 border-t border-line pt-3 text-sm text-muted">No cups used yet.</p>
      ) : (
        <details className="group mt-3 border-t border-line">
          <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between text-sm font-semibold text-tan-dark [&::-webkit-details-marker]:hidden">
            <span>{passHistorySummary(rows.length)}</span>
            <span aria-hidden="true" className="transition-transform group-open:rotate-180">
              ▾
            </span>
          </summary>
          <ul className="flex flex-col divide-y divide-line text-sm">
            {rows.map((row, i) => (
              <li key={`${row.orderId}-${i}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2">
                <SurfaceLink
                  href={`/order/${row.orderId}`}
                  className="inline-flex min-h-[44px] items-center font-mono font-bold tabular-nums text-tan-dark hover:underline"
                >
                  {row.orderLabel}
                </SurfaceLink>
                <span className="text-charcoal">
                  {row.cups}
                  <span className="text-muted"> · {row.when}</span>
                  {row.returned ? <span className="ml-2 font-semibold text-muted">returned</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
