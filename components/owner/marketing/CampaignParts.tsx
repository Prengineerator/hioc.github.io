'use client';

// The three pieces every campaign view shares — Approvals cards, the wizard's
// live preview and the campaign drawer: the money grid, the guardrail warnings
// and the sample messages. The numbers are the API's (lib/marketing/economics.ts);
// this file only decides how to say them in plain English.

import {
  GUARDRAIL_EXPLANATIONS,
  type GuardrailFlag,
  type Projection,
  type RecipientPreview,
} from '@/lib/marketing/types';
import {
  GUARDRAIL_LABELS,
  describeRoi,
  formatBreakEven,
  formatCount,
  formatExpectedOrders,
  formatPercent,
  formatRate,
  formatRoi,
  inr,
  inrExact,
  signedInr,
} from './format';

function Tile({
  label,
  value,
  hint,
  emphasis,
  bad,
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  bad?: boolean;
}) {
  return (
    <div className={`min-w-0 rounded-md p-3 ${emphasis ? 'border border-tan bg-surface' : 'bg-[#f2efe9]'}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 break-words font-mono text-lg font-bold tabular-nums ${bad ? 'text-red-700' : 'text-charcoal'}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * The forecast of one campaign: what the messages cost, what should come back and
 * whether it pays for itself (spec §7.2). Break-even is a %: "0.65%" reads as
 * "only about 1 in 150 people has to come back", which is the number that lets an
 * owner say yes to a campaign with confidence.
 */
export function ProjectionGrid({ projection: p }: { projection: Projection }) {
  const losing = p.expected_profit_inr <= 0;
  const breaksEven = p.break_even_rate !== null && p.conversion_rate >= p.break_even_rate;
  const expectedShare = p.treated > 0 ? p.conversions / p.treated : 0;

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile
          label="Message cost"
          value={inr(p.message_spend_inr)}
          hint={`${formatCount(p.treated)} messages at ${inrExact(p.message_cost_inr)} each`}
        />
        <Tile
          label="Returning orders"
          value={formatExpectedOrders(p.conversions)}
          hint={p.treated > 0 ? `${formatRate(expectedShare)} of the ${formatCount(p.treated)} messaged` : undefined}
        />
        <Tile label="Revenue" value={inr(p.revenue_inr)} hint="from those orders, after any discount" />
        <Tile
          label="Offer cost"
          value={inr(p.offer_spend_inr)}
          hint={p.offer_cost_inr > 0 ? `${inrExact(p.offer_cost_inr)} per returning order` : 'no offer to pay for'}
        />
        <Tile
          label="Expected profit"
          value={signedInr(p.expected_profit_inr)}
          hint={losing ? 'a loss: see the warnings' : 'after message and offer costs'}
          emphasis
          bad={losing}
        />
        <Tile label="ROI" value={formatRoi(p.roi)} hint={describeRoi(p.roi) || undefined} />
        <Tile
          label="Break-even"
          value={formatBreakEven(p.break_even_rate)}
          hint={
            p.break_even_rate === null
              ? 'each returning order loses money, so it cannot pay for itself'
              : `share of people who must return to cover the cost. We expect ${formatRate(p.conversion_rate)} ${breaksEven ? '(above it)' : '(below it)'}`
          }
          emphasis
          bad={p.break_even_rate === null || !breaksEven}
        />
        <Tile
          label="Profit per order"
          value={signedInr(p.profit_per_conv_inr)}
          hint={`${formatPercent(p.margin_after_pct)} of the basket`}
          bad={p.profit_per_conv_inr <= 0}
        />
      </div>
      <p className="mt-2 text-xs text-muted">
        Assumes an average basket of {inr(p.basket_inr)}, {formatPercent(p.food_cost_ratio * 100)} food cost, {formatPercent(p.deliverability * 100)} of
        messages delivered and {formatRate(p.conversion_rate)} of them returning.
      </p>
    </div>
  );
}

/** Red warning chips with the plain-English reason under each. Nothing renders when there are none. */
export function GuardrailList({ flags }: { flags: readonly GuardrailFlag[] }) {
  if (flags.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Warnings">
      {flags.map((f) => (
        <li key={f} className="flex flex-col gap-1 rounded-md border border-red-200 bg-red-50 p-3 sm:flex-row sm:items-start sm:gap-3">
          <span className="inline-flex w-fit shrink-0 items-center gap-1 rounded-full bg-red-700 px-2.5 py-0.5 text-xs font-bold text-cream">
            <span aria-hidden="true">⚠</span>
            {GUARDRAIL_LABELS[f]}
          </span>
          <span className="text-sm text-red-900">{GUARDRAIL_EXPLANATIONS[f]}</span>
        </li>
      ))}
    </ul>
  );
}

/** Up to three rendered messages, as a customer will see them (with sample values where a value only exists at send time). */
export function SamplePreviews({ samples, hasCoupon }: { samples: readonly RecipientPreview[]; hasCoupon: boolean }) {
  if (samples.length === 0) {
    return <p className="text-sm text-muted">No sample messages yet: they appear once the message template is filled in.</p>;
  }
  return (
    <ul className="grid gap-3 md:grid-cols-3">
      {samples.slice(0, 3).map((s, i) => (
        <li key={`${s.first_name}-${i}`} className="flex flex-col gap-1">
          <div className="rounded-lg rounded-tl-none border border-green-200 bg-[#e7f3e3] p-3 text-sm text-charcoal">
            <p className="whitespace-pre-line break-words">{s.text || '(no message text)'}</p>
          </div>
          <p className="text-xs text-muted">
            Sample for {s.first_name}.{' '}
            {hasCoupon && !s.coupon_code ? 'Each person gets their own code when the message is sent.' : s.coupon_code ? `Code: ${s.coupon_code}` : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}
